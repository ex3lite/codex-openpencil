// Adapter for the original editor's snapshot/save protocol.
const nativeEditor = (() => {
  let ready = false, saving = false, dirty = false, source = null, token;
  let generation = 0, revision = 0, closed = false, identity = 0;
  const snapshots = new Map(), listeners = new Set();
  const element = id => document.getElementById(id);
  const value = result => result.structuredContent ?? JSON.parse(result.content.find(item => item.type === 'text').text);
  const call = async (name, args = {}) => value(await nativeBridge.call(name, args));
  function status(text, error = false) {
    const box = element('operation-status');
    element('status-message').textContent = text; box.hidden = !text; box.dataset.error = String(error);
  }
  function send(message) { OpenPencilEngine.receive(JSON.stringify(message)); }
  function updateName() {
    OpenPencilEngine.documentName(source ? source.split(/[\\/]/).pop() : 'Без названия');
  }
  function flush() {
    if (!ready || closed) return Promise.reject(Error('Редактор ещё не готов. Дождитесь загрузки холста.'));
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { snapshots.delete(requestId); reject(Error('Редактор не подтвердил последние изменения. Файл не сохранён.')); }, 15000);
      snapshots.set(requestId, { resolve, reject, timer });
      try { send({ type: 'op-bridge/snapshot', purpose: 'save', requestId }); }
      catch (error) { clearTimeout(timer); snapshots.delete(requestId); reject(error); }
    }).then(async snapshot => {
      // Flushing the document can reset daemon selection. Publish the current
      // editor selection before a save or Code panel request consumes it.
      const result = await nativeBridge.call('canvas_native_request', {
        path: '/api/mcp/selection', method: 'POST', body: OpenPencilEngine.selection() });
      if (result._meta?.nativeHttp?.status !== 200) throw Error('Не удалось синхронизировать выделение. Повторите действие.');
      return snapshot;
    });
  }
  function saveDialog() {
    element('save-path').value = source || '';
    element('save-dialog').showModal(); element('save-path').focus();
  }
  async function save(path = source) {
    if (saving || closed) return;
    if (!path) { saveDialog(); return; }
    const savingIdentity = identity;
    saving = true; status('Сохранение…');
    try {
      const snapshot = await flush();
      const result = await call('canvas_save', { filePath: path, docJson: snapshot.docJson });
      if (identity !== savingIdentity) {
        status('Предыдущий файл сохранён. Новый макет нужно сохранить отдельно.');
        return;
      }
      source = result.filePath;
      if (generation === snapshot.generation && revision === snapshot.revision) dirty = false;
      send({ type: 'op-bridge/save-committed', generation: snapshot.generation, revision: snapshot.revision });
      updateName(); status(dirty ? 'Сохранено · есть новые изменения' : 'Сохранено');
    } catch (error) { status(`Не удалось сохранить: ${error.message}`, true); }
    finally { saving = false; }
  }
  function receive(raw) {
    let event; try { event = JSON.parse(raw); } catch { return; }
    if (event.type === 'op-bridge/listening') send({ type: 'op-bridge/init', token });
    if (event.type === 'op-bridge/ready') {
      ready = true; generation = event.generation; revision = event.revision; updateName();
    }
    if (event.type === 'op-bridge/dirty-changed') {
      generation = event.generation; revision = event.revision; dirty = Boolean(event.dirty) || dirty;
    }
    if (event.type === 'op-bridge/sync-conflict') status('Есть конфликт изменений. Сохранение остановлено до его разрешения.', true);
    if (['op-bridge/snapshot-result', 'op-bridge/snapshot-conflict'].includes(event.type)) {
      const pending = snapshots.get(event.requestId);
      if (pending) {
        clearTimeout(pending.timer); snapshots.delete(event.requestId);
        if (event.type.endsWith('conflict')) pending.reject(Error('Макет изменился во время сохранения. Проверьте холст; автоматического повтора не будет.'));
        else pending.resolve(event);
      }
    }
    if (event.type === 'op-shell/document-replaced') {
      identity++; source = null; dirty = true; status('');
      element('save-dialog').close();
      void call('canvas_detach_source').catch(error => status(error.message, true));
    }
    if (event.type === 'op-shell/save') void save();
    if (event.type === 'op-shell/save-as') saveDialog();
    for (const listener of listeners) listener(event);
  }
  element('save-form').addEventListener('submit', event => {
    event.preventDefault(); const path = element('save-path').value.trim();
    if (path) { element('save-dialog').close(); void save(path); }
  });
  element('save-cancel').onclick = () => element('save-dialog').close();
  element('status-dismiss').onclick = () => status('');
  window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
  nativeBridge.onContext(context => {
    if (ready && ['dark', 'light'].includes(context.theme)) send({ type: 'op-bridge/theme', colorScheme: context.theme });
  });
  nativeBridge.onTeardown(async () => {
    if (ready) { await flush(); await call('canvas_checkpoint'); }
    closed = true;
    for (const pending of snapshots.values()) { clearTimeout(pending.timer); pending.reject(Error('Редактор закрыт')); }
    snapshots.clear();
  });
  return {
    configure(result) {
      source = result.structuredContent?.filePath || null; token = result._meta?.canvas?.token;
      if (!token) throw Error('Локальный редактор не выдал сеанс. Обновите плагин в Codex.');
      OpenPencilEngine.onEvent(raw => queueMicrotask(() => receive(raw)));
    },
    get ready() { return ready && !closed; }, get saving() { return saving; }, get source() { return source; },
    send, flush, call, status,
    onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
})();
