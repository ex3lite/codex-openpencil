// Adapter for the original editor's snapshot/save protocol.
const nativeEditor = (() => {
  let ready = false, saving = false, dirty = false, source = null, token;
  let generation = 0, revision = 0, closed = false, identity = 0;
  let replacementBarrier = Promise.resolve(), autosaveTimer, autosaveDeadline, autosaveFailed = false, rejectedSnapshot = null, restoring = false;
  const snapshots = new Map(), listeners = new Set();
  let switching = false;
  const element = id => document.getElementById(id);
  const value = result => result._meta?.panelState ?? result.structuredContent ?? JSON.parse(result.content.find(item => item.type === 'text').text);
  const call = async (name, args = {}) => value(await nativeBridge.call(name, args));
  function status(text, error = false) {
    const box = element('operation-status');
    element('status-message').textContent = text; box.hidden = !text; box.dataset.error = String(error);
  }
  function send(message) { OpenPencilEngine.receive(JSON.stringify(message)); }
  function updateName() {
    OpenPencilEngine.documentName(source ? source.split(/[\\/]/).pop() : 'Без названия');
  }
  async function captureSelection() {
    if(!ready||closed)throw Error('Редактор ещё не готов.');
    const result=await nativeBridge.call('canvas_native_request',{
      path:'/api/mcp/selection',method:'POST',body:OpenPencilEngine.selection()});
    if(result._meta?.nativeHttp?.status!==200)throw Error('Выделение ещё синхронизируется.');
    return call('canvas_panel_state');
  }
  function flush() {
    if (restoring) return Promise.reject(Error('Дождитесь восстановления версии на холсте.'));
    if (!ready || closed) return Promise.reject(Error('Редактор ещё не готов. Дождитесь загрузки холста.'));
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { snapshots.delete(requestId); reject(Error('Редактор не подтвердил последние изменения. Файл не сохранён.')); }, 120000);
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
  function clearAutosave() {
    clearTimeout(autosaveTimer); clearTimeout(autosaveDeadline);
    autosaveTimer=autosaveDeadline=undefined;
  }
  function scheduleAutosave() {
    clearTimeout(autosaveTimer);
    if (!restoring && !autosaveFailed && !rejectedSnapshot && ready && !closed) {
      autosaveTimer=setTimeout(() => { autosaveTimer=undefined; void save(); }, 700);
      // Continuous pointer edits must not postpone persistence indefinitely.
      autosaveDeadline ??= setTimeout(() => { autosaveDeadline=undefined; void save(); }, 2000);
    }
  }
  async function save() {
    if (switching || restoring || saving || closed || autosaveFailed || rejectedSnapshot) return;
    clearAutosave();
    const savingIdentity = identity;
    let savingPair = { generation, revision };
    saving = true;
    try {
      const snapshot = await flush();
      savingPair = { generation: snapshot.generation, revision: snapshot.revision };
      const result = await call('canvas_autosave', {docJson:snapshot.docJson});
      if (identity !== savingIdentity) return;
      if (rejectedSnapshot) status('');
      rejectedSnapshot = null;
      source = result.filePath;
      if (generation === snapshot.generation && revision === snapshot.revision) dirty = false;
      send({ type: 'op-bridge/save-committed', generation: snapshot.generation, revision: snapshot.revision });
      updateName();
    } catch (error) {
      if (identity !== savingIdentity) return;
      if (error.code === 'DOCUMENT_SNAPSHOT_STALE') {
        rejectedSnapshot = savingPair;
        status('Снимок холста устарел. Файл не изменён. Нужна синхронизация холста; агент может проверить состояние и восстановить сохранение.', true);
      } else {
        autosaveFailed = true;
        status(`Автосохранение остановлено: ${error.message}. Проверьте историю и файл перед продолжением.`, true);
      }
    } finally { saving = false; if (dirty && !autosaveFailed && !rejectedSnapshot) scheduleAutosave(); }
  }
  async function retryAutosave(documentId) {
    if (saving || switching || restoring || closed) throw Error('Дождитесь завершения операции с макетом.');
    const savingIdentity = identity;
    saving = true;
    clearAutosave();
    try {
      const snapshot = await flush();
      if (savingIdentity !== identity) throw Error('Открыт другой макет.');
      const result = await call('canvas_autosave', {docJson:snapshot.docJson, retryAccessForDocument:documentId});
      if (savingIdentity !== identity) throw Error('Открыт другой макет.');
      source = result.filePath;
      autosaveFailed = false;
      rejectedSnapshot = null;
      if (generation === snapshot.generation && revision === snapshot.revision) dirty = false;
      send({type:'op-bridge/save-committed', generation:snapshot.generation, revision:snapshot.revision});
      updateName();
      status('');
      return result;
    } catch (error) {
      if (savingIdentity === identity) autosaveFailed = true;
      throw error;
    } finally {
      saving = false;
      if (dirty && !autosaveFailed && !rejectedSnapshot) scheduleAutosave();
    }
  }
  async function switchDocument(documentId) {
    if (switching || restoring) throw Error('Дождитесь открытия макета.');
    if (saving) throw Error('Текущие изменения ещё сохраняются. Попробуйте открыть макет через секунду.');
    if (autosaveFailed || rejectedSnapshot) throw Error('Сначала восстановите синхронизацию текущего макета. Его изменения сохранены в редакторе.');
    switching = true; clearAutosave();
    const viewport = element('editor-viewport'), toolbar = element('workspace-bar');
    viewport.inert = toolbar.inert = true;
    let applied = false, attempted = false, saveAttempted = false;
    try {
      await replacementBarrier;
      const snapshot = await flush();
      saveAttempted = true;
      await call('canvas_autosave', {docJson:snapshot.docJson});
      send({type:'op-bridge/save-committed',generation:snapshot.generation,revision:snapshot.revision});
      restoring = true;
      attempted = true;
      const result = await call('canvas_document_open', {documentId,docJson:snapshot.docJson});
      applied = true; identity++; source = result.filePath || null;
      dirty = false; autosaveFailed = false; rejectedSnapshot = null; updateName();
      // Remote application is acknowledged by the Rust sync gate, not a timer.
      await new Promise((resolve,reject) => {
        const timer = setTimeout(() => { listeners.delete(opened); reject(Error('Макет переключён, но холст ещё не подтвердил загрузку. Переоткройте панель перед редактированием.')); }, 120000);
        function opened(event) {
          if (event.type !== 'op-bridge/opened' && !(event.type === 'op-bridge/dirty-changed' && event.generation !== snapshot.generation)) return;
          clearTimeout(timer); listeners.delete(opened); restoring = false; dirty = false; resolve();
        }
        listeners.add(opened);
        if (generation !== snapshot.generation) opened({type:'op-bridge/dirty-changed',generation});
        else send({type:'op-bridge/resolve-conflict',mode:'accept-remote',requestId:crypto.randomUUID()});
      });
      status('Макет открыт. Все изменения сохраняются автоматически.');
    } catch (error) {
      // An uncertain replacement must not let the previous browser snapshot
      // overwrite the newly bound document. Reopen the panel to recover.
      if (applied || attempted && !['VERSION_CONFLICT','DOCUMENT_SNAPSHOT_STALE','PROJECT_AGENTS_ACTIVE','DOCUMENT_NOT_FOUND','PROJECT_WRITER_BUSY','DOCUMENT_SWITCH_REJECTED'].includes(error.code)) {
        restoring = true; autosaveFailed = true; status(error.message, true); throw error;
      }
      if (saveAttempted && !attempted) { autosaveFailed = true; clearAutosave(); status(`Автосохранение остановлено: ${error.message}`, true); }
      restoring = false; throw error;
    } finally {
      switching = false;
      if (!restoring) { viewport.inert = toolbar.inert = false; if(dirty && !autosaveFailed) scheduleAutosave(); }
    }
  }
  function receive(raw, replacement) {
    let event; try { event = JSON.parse(raw); } catch { return; }
    if (event.type === 'op-bridge/opened' && restoring) { restoring=false; dirty=false; status('Версия восстановлена'); }
    if (event.type === 'op-bridge/listening') send({ type: 'op-bridge/init', token });
    if (event.type === 'op-bridge/ready') {
      // Bridge readiness precedes the first daemon pull. Its temporary starter
      // document must never be treated as a user edit or offered for autosave.
      ready = true; generation = event.generation; revision = event.revision; updateName();
    }
    if (event.type === 'op-bridge/dirty-changed') {
      if (rejectedSnapshot && (event.generation !== rejectedSnapshot.generation || event.revision !== rejectedSnapshot.revision)) {
        rejectedSnapshot = null; status('');
      }
      generation = event.generation; revision = event.revision; dirty = Boolean(event.dirty) || dirty; if(dirty) scheduleAutosave();
    }
    if (event.type === 'op-bridge/sync-conflict') { clearAutosave(); autosaveFailed=true; status('Есть конфликт изменений. Изменения удерживаются в редакторе до проверки агентом.', true); }
    if (['op-bridge/snapshot-result', 'op-bridge/snapshot-conflict'].includes(event.type)) {
      const pending = snapshots.get(event.requestId);
      if (pending) {
        clearTimeout(pending.timer); snapshots.delete(event.requestId);
        if (event.type.endsWith('conflict')) pending.reject(Error('Макет изменился во время сохранения. Проверьте холст; автоматического повтора не будет.'));
        else pending.resolve(event);
      }
    }
    if (event.type === 'op-shell/document-replaced') {
      identity++; source = null; dirty = true; autosaveFailed = false; rejectedSnapshot = null; clearAutosave(); status('');
      void replacement.previous.then(() => call('canvas_detach_source')).then(() => { replacement.resolve(); scheduleAutosave(); }).catch(error => {
        replacement.reject(error); status('Не удалось переключить документ: ' + error.message, true);
      });
    }
    if (['op-shell/save','op-shell/save-as','op-shell/autosave'].includes(event.type) && dirty) void save();
    for (const listener of listeners) listener(event);
  }
  element('status-dismiss').onclick = () => status('');
  document.addEventListener('visibilitychange', () => { if (document.hidden && dirty) void save(); });
  window.addEventListener('pagehide', () => { if(dirty) void save(); });
  window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
  nativeBridge.onContext(context => {
    if (ready && ['dark', 'light'].includes(context.theme)) send({ type: 'op-bridge/theme', colorScheme: context.theme });
  });
  nativeBridge.onTeardown(async () => {
    clearAutosave();
    if (dirty && ready && !autosaveFailed && !rejectedSnapshot) { const snapshot=await flush(); await call('canvas_autosave',{docJson:snapshot.docJson}); }
    closed = true;
    for (const pending of snapshots.values()) { clearTimeout(pending.timer); pending.reject(Error('Редактор закрыт')); }
    snapshots.clear();
  });
  return {
    configure(result) {
      source = result.structuredContent?.filePath || null; token = result._meta?.canvas?.token;
      if (!token) throw Error('Локальный редактор не выдал сеанс. Обновите плагин в Codex.');
      OpenPencilEngine.onEvent(raw => {
        // Block native snapshot transport synchronously, before the next Rust
        // sync task can checkpoint the new document under the previous identity.
        let replacement;
        if (JSON.parse(raw).type === 'op-shell/document-replaced') {
          replacement={previous:replacementBarrier};
          const next=new Promise((resolve,reject)=>{replacement.resolve=resolve;replacement.reject=reject;});
          next.catch(()=>{});
          replacementBarrier=replacement.previous.then(()=>next);
          replacementBarrier.catch(() => {});
        }
        queueMicrotask(() => receive(raw,replacement));
      });
    },
    get ready() { return ready && !closed; }, get saving() { return saving; }, get source() { return source; },
    rebind(result) { identity++; source = result.filePath || null; dirty = false; autosaveFailed = false; rejectedSnapshot = null; clearAutosave(); updateName(); status('Макет открыт в этом проекте.'); },
    beginRestore() { restoring=true; clearAutosave(); },
    cancelRestore() { restoring=false; },
    acceptRestored(result) {
      source=result.filePath; dirty=false; autosaveFailed=false; rejectedSnapshot=null; updateName();
      send({type:'op-bridge/resolve-conflict',mode:'accept-remote',requestId:crypto.randomUUID()});
    },
    syncBarrier() { return replacementBarrier; },
    send, flush, captureSelection, call, status, switchDocument, retryAutosave,
    onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
})();
