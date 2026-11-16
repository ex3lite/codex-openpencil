// Visible project, feedback and context controls around the original Rust editor.
const nativeWorkspace = (() => {
  const $ = id => document.getElementById(id);
  let state, mode, target, sending = false, displayedMode, projectBusy = false;
  let contextChanged = () => {}, retryContext = () => {}, delivery = {state:'pending'}, contextNotice = '';
  const context = nativeContextState.create();
  const drawer = $('workspace-drawer');
  function make(tag, text, className) {
    const element = document.createElement(tag); if (text) element.textContent = text;
    if (className) element.className = className; return element;
  }
  function button(text, action, className) {
    const control = make('button', text, className); control.type = 'button';
    control.onclick = async () => {
      if (control.disabled) return;
      control.disabled = true;
      try { await action(); } catch (error) { nativeEditor.status(error.message, true); }
      finally { control.disabled = false; }
    };
    return control;
  }
  function close() {
    mode = null; drawer.hidden = true; document.body.dataset.drawer = 'false';
    for (const b of document.querySelectorAll('#workspace-bar [aria-expanded]')) b.setAttribute('aria-expanded', 'false');
    window.dispatchEvent(new Event('resize'));
  }
  function show(next, title) {
    mode = next; drawer.replaceChildren(); drawer.hidden = false; document.body.dataset.drawer = 'true';
    const active = { projects:'project', context:'context', comment:'comment', comments:'comments', agents:'agents', history:'history', library:'library' }[next];
    for (const b of document.querySelectorAll('#workspace-bar [aria-expanded]')) b.setAttribute('aria-expanded', String(b.id === `workspace-${active}`));
    const heading = make('div', null, 'drawer-heading'); heading.append(make('h2', title), button('Закрыть', close)); drawer.append(heading);
    window.dispatchEvent(new Event('resize'));
  }
  function describe(selection) {
    if (!selection?.count) return 'Выберите слой на холсте или в списке слоёв';
    return selection.nodes.map(n => n.name || n.type).join(', ');
  }
  function contextData() { return context.payload(); }
  function contextEdit(action) {
    action(); contextNotice = ''; contextChanged(); renderContext();
    $('workspace-context').textContent = `Контекст · ${context.attachments.length}`;
  }
  async function addContext() {
    const current = await nativeEditor.call('canvas_status');
    if (context.observe(current)) contextNotice = 'Открыт другой макет. Вложения предыдущего макета удалены.';
    state = current;
    contextEdit(() => context.add());
  }
  function updateContextDelivery() {
    const output = $('context-delivery'); if (!output) return;
    output.textContent = delivery.state === 'accepted' ? 'Этот набор контекста принят Codex.' :
      delivery.state === 'unsupported' ? 'В этой панели Codex не поддерживает передачу контекста.' :
      delivery.state === 'error' ? `Передача не подтверждена: ${delivery.error} Повторите отправку.` : 'Передаём этот набор в Codex…';
    output.dataset.error = String(delivery.state === 'error');
    const retry = $('context-retry'); if (retry) retry.hidden = delivery.state !== 'error';
  }
  function refreshContextSelection() {
    const selection = $('context-selection'), add = $('context-add');
    if (selection) selection.textContent = context.available ? describe(state?.selection) : 'Холст временно недоступен. Вложения сохранены в панели.';
    if (add) add.disabled = !context.available || !state?.selection?.count || !nativeBridge.capabilities.updateModelContext;
  }
  function renderContext() {
    show('context', 'Контекст этого чата');
    drawer.append(make('p', 'Добавьте нужные слои. Вложения останутся в контексте, пока вы их не удалите или не откроете другой макет.'));
    const selection = make('p'); selection.id = 'context-selection';
    const add = button('Добавить в контекст', addContext, 'primary'); add.id = 'context-add';
    drawer.append(selection, add, make('h3', `Вложения · ${context.attachments.length}`));
    if (!context.attachments.length) drawer.append(make('p', 'Слои не добавлены. Codex получает только название проекта и адрес открытого макета.'));
    for (const attachment of context.attachments) {
      const item = make('article', null, 'item context-attachment');
      item.append(make('strong', attachment.nodes.map(node => node.name || node.type || node.id).join(', ') || attachment.nodeIds.join(', ')),
        make('small', `${attachment.nodeIds.length} слоёв · закреплено на версии ${attachment.capturedVersion}`),
        button('Удалить из контекста', () => contextEdit(() => context.remove(attachment.id))));
      drawer.append(item);
    }
    if (context.attachments.length) drawer.append(button('Удалить все вложения', () => contextEdit(() => context.clear())));
    if (contextNotice) drawer.append(make('p', contextNotice));
    const deliveryText = make('p', null, 'delivery'); deliveryText.id = 'context-delivery'; deliveryText.setAttribute('role','status');
    const retry = button('Повторить передачу', () => retryContext()); retry.id = 'context-retry';
    drawer.append(deliveryText, retry);
    const details = make('details'), summary = make('summary', 'Что именно получает Codex');
    const data = make('pre', JSON.stringify(contextData(), null, 2)); data.id = 'context-details';
    details.append(summary, data); drawer.append(details);
    drawer.append(make('p', 'Выделение и правки на холсте сами не добавляют контекст. Комментарий отправляется отдельно, с закреплённой целью. Удаление вложения обновляет следующий контекст; предыдущие сообщения чата сохраняются.'));
    refreshContextSelection(); updateContextDelivery();
  }
  function targetBlock(selection) {
    const block = make('div', null, 'target'); block.append(make('strong', describe(selection)));
    block.append(make('small', `Слои: ${selection.nodeIds.join(', ')} · версия ${target.version}`)); return block;
  }
  async function captureComment() {
    if(!nativeBridge.capabilities.message?.text) throw Error('Codex не предоставил отправку комментариев из этой панели. Комментарий можно написать в текущем чате.');
    const previousText=mode==='comment'?$('comment-text')?.value||'':'';
    const snapshot = await nativeEditor.flush();
    const current = await nativeEditor.call('canvas_status');
    if (!current.selection?.count) { nativeEditor.status('Сначала выделите элемент на холсте или в списке слоёв.'); return; }
    target = { ...current, docJson: snapshot.docJson, requestId: crypto.randomUUID() };
    show('comment', 'Комментарий к выделению'); drawer.append(targetBlock(target.selection));
    const label = make('label', 'Что изменить?'); label.htmlFor = 'comment-text';
    const text = document.createElement('textarea'); text.id = 'comment-text'; text.maxLength = 8000;
    text.placeholder = 'Например: увеличь отступы у этой кнопки';text.value=previousText;
    const send = button('Отправить в Codex', () => submitComment(text.value, send), 'primary'); send.disabled = !previousText.trim();
    text.oninput = () => { send.disabled = !text.value.trim() || sending; };
    drawer.append(label, text, make('p', 'Комментарий сохранится в проекте вместе с точной целью. Следующее выделение его не изменит.'));
    const actions = make('div', null, 'actions'); actions.append(button('Обновить цель', captureComment), send); drawer.append(actions); text.focus();
  }
  async function submitComment(text, control) {
    if (sending || !text.trim()) return;
    sending = true; control.disabled = true;
    try {
      const comment = await nativeEditor.call('canvas_comment_create', { requestId: target.requestId, text,
        pageId:target.selection.pageId, nodeIds:target.selection.nodeIds, expectedVersion:target.version, docJson:target.docJson });
      // One explicit user action produces one message. An uncertain send is not replayed.
      try {
        const result = await nativeBridge.request('ui/message', { role: 'user', content: [{ type:'text', text:
          `Комментарий OpenBrush ${comment.id}\n${JSON.stringify(comment)}\nПрочитай canvas_comments. Измени только закреплённые слои; при изменившейся версии проверь их перед правкой. После проверки отметь комментарий выполненным.` }] });
        if (result?.isError) throw Error('Codex не принял сообщение');
        await nativeEditor.call('canvas_comment_update', { commentId: comment.id, status:'sent' });
        nativeEditor.status('Комментарий передан в этот чат.');
      } catch (error) {
        await nativeEditor.call('canvas_comment_update', { commentId: comment.id, status:'uncertain' });
        nativeEditor.status(`Комментарий сохранён. Отправка не подтверждена: ${error.message}`, true);
      }
      await renderComments();
    } finally { sending = false; control.disabled = false; }
  }
  async function renderComments() {
    const comments = await nativeEditor.call('canvas_comments');
    show('comments', 'Комментарии'); drawer.append(button('К выделенному элементу', captureComment, 'primary'));
    if (!comments.length) drawer.append(make('p', 'Выделите элемент и оставьте первый комментарий.'));
    for (const c of comments.slice().reverse()) {
      const item = make('article', null, 'item'); item.append(make('strong', c.nodes.map(n => n.name).join(', ')), make('p', c.text));
      const labels = {draft:'Сохранён',sent:'Передан в чат',uncertain:'Отправка не подтверждена',resolved:'Выполнен'};
      item.append(make('small', `${labels[c.status]} · ${c.nodeIds.join(', ')} · версия ${c.version}`));
      if (c.status !== 'resolved') item.append(button('Отметить выполненным', async () => {
        await nativeEditor.call('canvas_comment_update', { commentId:c.id, status:'resolved' }); await renderComments();
      }));
      drawer.append(item);
    }
  }
  async function projectAction(action) {
    if (projectBusy) return;
    projectBusy = true;
    try { await action(); } finally { projectBusy = false; }
  }
  async function renderProjects() {
    const catalog = await nativeEditor.call('canvas_documents'); show('projects', 'Макеты проекта');
    drawer.append(make('p', catalog.project.projectRoot));
    drawer.append(button('Новый макет', () => projectAction(async () => {
      const snapshot = await nativeEditor.flush();
      const result = await nativeEditor.call('canvas_document_open', { create:true, docJson:snapshot.docJson });
      nativeEditor.rebind(result); await renderProjects();
    }), 'primary'));
    for (const doc of catalog.documents) {
      const item = make('div', null, 'item'); item.append(make('strong', doc.name), make('small', doc.relativePath || 'Черновик проекта'));
      const active = doc.id === catalog.documentId;
      const open = button(active ? 'Открыт' : 'Открыть', () => projectAction(async () => {
        const snapshot = await nativeEditor.flush();
        const result = await nativeEditor.call('canvas_document_open', { documentId:doc.id, docJson:snapshot.docJson });
        nativeEditor.rebind(result); await renderProjects();
      })); open.disabled = active; item.append(open); drawer.append(item);
    }
    drawer.append(make('h3', 'Импортировать копию'));
    const input = document.createElement('input'); input.placeholder = '/…/Макет.op'; input.setAttribute('aria-label','Путь к файлу для импорта');
    drawer.append(input, make('p', 'Внешний файл будет скопирован в папку этого проекта. Исходник сохранится.'));
    drawer.append(button('Добавить в проект', () => projectAction(async () => {
      await nativeEditor.call('canvas_document_import', { sourcePath:input.value.trim() }); await renderProjects();
    })));
  }
  async function renderHistory(sync = true) {
    if(sync) {
    const snapshot = await nativeEditor.flush();
    await nativeEditor.call('canvas_autosave',{docJson:snapshot.docJson});
    }
    const history = await nativeEditor.call('canvas_history'); show('history','История изменений');
    drawer.append(make('p','Изменения сохраняются автоматически. Восстановление добавляет новую версию и сохраняет текущую в истории.'));
    if (!history.entries?.length) drawer.append(make('p','Первые изменения появятся здесь автоматически.'));
    for (const entry of history.entries || []) {
      const item=make('article',null,'item');
      item.append(make('strong',new Date(entry.createdAt).toLocaleString('ru-RU')),
        make('small',`${entry.source==='restore'?'Восстановление':entry.source==='initial'?'Исходная версия':'Изменения'} · ${(entry.bytes/1024).toFixed(1)} КБ`));
      item.append(button('Восстановить',async()=>{
        const current=await nativeEditor.flush();
        nativeEditor.beginRestore();
        try {
          const result=await nativeEditor.call('canvas_history_restore',{id:entry.id,docJson:current.docJson});
          nativeEditor.acceptRestored(result); await renderHistory(false);
        } catch(error) { nativeEditor.cancelRestore(); throw error; }
      })); drawer.append(item);
    }
  }
  async function renderAgents() {
    const activity = await nativeEditor.call('canvas_agents'); show('agents', 'Агенты на холсте');
    drawer.append(make('p', 'До 10 агентов Codex. У каждого — своё имя, цвет и область работы. Назначить задачи можно в этом чате.'));
    if (!activity.agents?.length) drawer.append(make('p', 'Сейчас никто не редактирует макет.'));
    for (const agent of activity.agents || []) {
      const item = make('article', null, 'item'); const name = make('strong', agent.name); name.style.color = agent.color;
      item.append(name, make('small', agent.rootIds.join(', ')), make('p', agent.activity || 'Работает с выделенной областью')); drawer.append(item);
    }
  }
  async function expand() {
    const available = nativeBridge.context.availableDisplayModes || [];
    const next = nativeBridge.context.displayMode === 'fullscreen' ? 'inline' : 'fullscreen';
    if (!available.includes(next)) { nativeEditor.status('Codex не предоставил режим разворота этой панели. Используйте кнопку разворота в заголовке панели.', true); return; }
    const result = await nativeBridge.request('ui/request-display-mode', { mode:next });
    if (result?.mode !== next) throw Error('Codex не подтвердил изменение размера панели.');
    nativeBridge.setDisplayMode(result.mode); updateExpand();
  }
  function updateExpand() {
    const value=nativeBridge.context.displayMode;
    $('workspace-expand').textContent = value === 'fullscreen' ? 'Свернуть' : 'Развернуть';
    if(nativeEditor.ready && ['inline','fullscreen'].includes(value) && displayedMode!==value) {
      nativeEditor.send({type:'op-bridge/display-mode',mode:value});displayedMode=value;
    }
  }
  $('workspace-history').onclick = () => renderHistory().catch(e => nativeEditor.status(e.message,true));
  $('workspace-library').onclick = () => nativeLibrary.open({show,drawer,make,button}).catch(e => nativeEditor.status(e.message,true));
  $('workspace-fit').onclick=()=>nativeEditor.send({type:'op-bridge/fit-content'});
  $('workspace-project').onclick = () => renderProjects().catch(e => nativeEditor.status(e.message,true));
  $('workspace-context').onclick = renderContext;
  $('workspace-comment').onclick = () => captureComment().catch(e => nativeEditor.status(e.message,true));
  $('workspace-comments').onclick = () => renderComments().catch(e => nativeEditor.status(e.message,true));
  $('workspace-agents').onclick = () => renderAgents().catch(e => nativeEditor.status(e.message,true));
  $('workspace-expand').onclick = () => expand().catch(e => nativeEditor.status(e.message,true));
  nativeBridge.onContext(updateExpand);
  nativeEditor.onEvent(event => {
    if(event.type==='op-bridge/ready') updateExpand();
    if (event.type === 'op-shell/display-mode') void expand().catch(e => nativeEditor.status(e.message,true));
    if (event.type === 'op-shell/document-replaced') {
      target = null; context.reset(); contextChanged();
      $('workspace-context').textContent = 'Контекст · 0'; close();
    }
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && mode && !sending) close(); });
  return {
    contextData,
    onContextChange(changed, retry) { contextChanged = changed; retryContext = retry; },
    contextDelivery(status) { delivery = status; if (mode === 'context') updateContextDelivery(); },
    contextUnavailable() {
      context.unavailable();
      if (mode === 'context') {
        refreshContextSelection(); $('context-details').textContent = JSON.stringify(contextData(),null,2);
      }
    },
    update(current) {
      state = current;
      const switched = context.observe(current);
      if (switched) contextNotice = 'Открыт другой макет. Вложения предыдущего макета удалены.';
      const saving=current.autosave;
      $('workspace-save-state').textContent = saving?.state==='error'?'Ошибка сохранения':saving?.state==='snapshot-rejected'?'Нужна синхронизация':saving?.state==='pending'?'Сохраняется…':'Сохранено';
      $('workspace-save-state').dataset.error=String(['error','snapshot-rejected'].includes(saving?.state));
      $('workspace-save-state').title=saving?.error || saving?.filePath || current.filePath || 'Автосохранение в папку проекта';
      $('workspace-project').textContent = current.project?.name || 'Проект';
      $('workspace-project').title = current.project?.projectRoot || '';
      $('workspace-context').textContent = `Контекст · ${context.attachments.length}`;
      $('workspace-context').title = 'Только явно добавленные вложения';
      $('workspace-comment').disabled = !current.selection?.count;
      $('workspace-agents').textContent = `Агенты · ${current.agents?.agents?.length || 0}`;
      if (mode === 'context') {
        if (switched) renderContext();
        refreshContextSelection();
        $('context-details').textContent=JSON.stringify(contextData(),null,2);
      }
      updateExpand();
    },
  };
})();
