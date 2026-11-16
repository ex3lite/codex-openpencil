// Visible project, feedback and context controls around the original Rust editor.
const nativeWorkspace = (() => {
  const $ = id => document.getElementById(id);
  let state, mode, target, sending = false, displayedMode, commentDraft = null, commentsKey;
  let contextChanged = () => {}, retryContext = () => {}, delivery = {state:'pending'}, contextNotice = '';
  const context = nativeContextState.create();
  const drawer = $('workspace-drawer');
  function make(tag, text, className) {
    const element = document.createElement(tag); if (text) element.textContent = text;
    if (className) element.className = className; return element;
  }
  function button(text, action, className) { return nativeUI.button(text, action, className); }
  function rememberDraft() {
    const text = $('comment-text');
    if (mode === 'comment' && target && text) commentDraft = {target, text:text.value};
  }
  function closed() {
    rememberDraft(); mode = null;
    for (const b of document.querySelectorAll('#workspace-bar [aria-expanded]')) b.setAttribute('aria-expanded', 'false');
  }
  function close() { nativeUI.closePanel(); closed(); }
  nativeUI.onClose(closed);
  function show(next, title) {
    rememberDraft(); mode = next; drawer.replaceChildren();
    const active = {context:'context',comment:'comment',comments:'comments',agents:'agents',library:'library'}[next];
    for (const b of document.querySelectorAll('#workspace-bar [aria-expanded]')) b.setAttribute('aria-expanded', String(b.id === `workspace-${active}`));
    nativeUI.openPanel(title, next === 'library', next === 'comment' ? '#comment-text' : 'content');
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
    const current = await nativeEditor.captureSelection();
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
    drawer.append(make('p', 'Выберите слой и нажмите «В контекст». Вложение закрепится до удаления; обычные клики ничего не прикрепляют.'));
    const selection = make('p'); selection.id = 'context-selection';
    const add = button('Добавить в контекст', addContext, 'primary'); add.id = 'context-add';
    drawer.append(selection, add, make('h3', `Вложения · ${context.attachments.length}`));
    if (!context.attachments.length) drawer.append(make('p', 'Прикреплённых элементов пока нет.'));
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
    rememberDraft();
    if (commentDraft) { target=commentDraft.target; return renderComment(commentDraft.text); }
    const current=await nativeEditor.captureSelection();
    if (!current.selection?.count) { nativeEditor.status('Сначала выделите элемент на холсте или в списке слоёв.'); return; }
    target = { ...current, requestId: crypto.randomUUID() };
    renderComment('');
  }
  function renderComment(previousText) {
    show('comment', 'Комментарий к выделению'); drawer.append(targetBlock(target.selection));
    const label = make('label', 'Что изменить?'); label.htmlFor = 'comment-text';
    const text = document.createElement('textarea'); text.id = 'comment-text'; text.maxLength = 8000;
    text.placeholder = 'Например: увеличь отступы у этой кнопки';text.value=previousText;
    const send = button('Отправить в Codex', () => submitComment(text.value, send), 'primary'); send.disabled = !previousText.trim();
    text.oninput = () => { send.disabled = !text.value.trim() || sending; };
    drawer.append(label, text, make('p', 'Комментарий сохранится в проекте вместе с точной целью. Следующее выделение его не изменит.'));
    const actions = make('div', null, 'actions'); actions.append(button('Выбрать другую цель', () => { commentDraft=null; target=null; mode=null; return captureComment(); }), send); drawer.append(actions); text.focus();
  }
  async function submitComment(text, control) {
    if (sending || !text.trim()) return;
    sending = true; control.disabled = true;
    try {
      const snapshot=await nativeEditor.flush();
      const current=await nativeEditor.call('canvas_panel_state');
      if(current.documentId!==target.documentId)throw Error('Открыт другой макет. Выберите цель заново.');
      const comment = await nativeEditor.call('canvas_comment_create', { requestId: target.requestId, text,
        pageId:target.selection.pageId, nodeIds:target.selection.nodeIds, expectedVersion:current.version, docJson:snapshot.docJson });
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
      commentDraft=null; target=null; mode=null; await renderComments();
    } finally { sending = false; control.disabled = false; }
  }
  async function renderComments() { paintComments(await nativeEditor.call('canvas_comments')); }
  function paintComments(comments) {
    commentsKey=JSON.stringify(comments);
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
  async function renderAgents() {
    const activity = await nativeEditor.call('canvas_agents'); show('agents', 'Агенты на холсте');
    drawer.append(make('p', 'До 10 агентов Codex. У каждого — своё имя, цвет и область работы. Назначить задачи можно в этом чате.'));
    const participants=[...(activity.parent?[activity.parent]:[]),...(activity.agents||[])];
    if (!participants.length) drawer.append(make('p', 'Сейчас никто не редактирует макет.'));
    for (const agent of participants) {
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
  const openLibrary=()=>nativeLibrary.open({show,drawer,make,button}).catch(e=>nativeEditor.status(e.message,true));
  $('workspace-library').onclick=openLibrary;
  $('workspace-attach').onclick=()=>addContext().catch(e=>nativeEditor.status(e.message,true));
  $('workspace-inspector').onclick=()=>nativeEditor.send({type:'op-bridge/toggle-inspector'});
  $('workspace-inspector-close').onclick=$('workspace-inspector').onclick;
  $('workspace-sidebar').onclick=()=>nativeEditor.send({type:'op-bridge/toggle-sidebar'});
  $('workspace-preview').onclick=()=>nativeEditor.send({type:'op-bridge/toggle-preview'});
  $('workspace-fit').onclick=()=>nativeEditor.send({type:'op-bridge/fit-content'});
  $('workspace-context').onclick = renderContext;
  $('workspace-comment').onclick = () => captureComment().catch(e => nativeEditor.status(e.message,true));
  $('workspace-comments').onclick = () => renderComments().catch(e => nativeEditor.status(e.message,true));
  $('workspace-agents').onclick = () => renderAgents().catch(e => nativeEditor.status(e.message,true));
  $('workspace-expand').onclick = () => expand().catch(e => nativeEditor.status(e.message,true));
  // Escape exits a prototype when a host toolbar control owns focus. The SDK
  // continues to own Escape in an open drawer; the canvas owns its own keys.
  document.addEventListener('keydown', event => {
    if(event.key==='Escape' && !mode && $('workspace-preview').getAttribute('aria-pressed')==='true' &&
      event.composedPath().some(element=>element.hasAttribute?.('data-openbrush-ui'))) {
      event.preventDefault(); nativeEditor.send({type:'op-bridge/toggle-preview'});
    }
  }, true);
  nativeBridge.onContext(updateExpand);
  nativeEditor.onEvent(event => {
    if(event.type==='op-bridge/ready') updateExpand();
    if(event.type==='op-shell/panels-state') {
      $('workspace-sidebar').textContent=event.layers?'Скрыть слои':'Показать слои';
      $('workspace-sidebar').setAttribute('aria-pressed',String(event.layers));
      $('workspace-inspector').textContent=event.inspector?'Скрыть свойства':'Показать свойства';
      $('workspace-inspector').setAttribute('aria-pressed',String(event.inspector));
      $('workspace-inspector-close').hidden=!event.inspectorVisible;
    }
    if(event.type==='op-shell/preview-state') {
      $('workspace-preview').setAttribute('aria-pressed',String(event.active));
      $('workspace-preview').textContent=event.active?'В редактор':'Прототип';
    }
    if (event.type === 'op-shell/library') void openLibrary();
    if (event.type === 'op-shell/display-mode') void expand().catch(e => nativeEditor.status(e.message,true));
    if (event.type === 'op-shell/document-replaced') {
      target = null; commentDraft=null; context.reset(); contextChanged();
      $('workspace-context').textContent = 'Контекст · 0'; close();
    }
  });
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
      if (switched) {commentDraft=null; target=null; contextChanged();}
      if (switched) contextNotice = 'Открыт другой макет. Вложения предыдущего макета удалены.';
      const saving=current.autosave;
      const failed=['error','snapshot-rejected'].includes(saving?.state);
      $('workspace-save-state').hidden=!failed && saving?.state!=='pending';
      $('workspace-save-state').textContent=failed?'Не сохранено':saving?.state==='pending'?'Сохраняется…':'';
      $('workspace-save-state').dataset.error=String(failed);
      $('workspace-save-state').title=failed?saving.error||'Проверьте синхронизацию':'';
      $('workspace-project').textContent=current.project?.name||'Проект';
      $('workspace-context').textContent = `Контекст · ${context.attachments.length}`;
      $('workspace-context').title = 'Только явно добавленные вложения';
      $('workspace-attach').disabled=!current.selection?.count || !nativeBridge.capabilities.updateModelContext;
      $('workspace-comment').disabled = !current.selection?.count;
      const agentCount=(current.agents?.agents?.length||0)+(current.agents?.parent?1:0);
      $('toolbar-agents').hidden=!agentCount; $('workspace-agents').hidden=!agentCount;
      $('workspace-agents').textContent=`Агенты · ${agentCount}`;
      if(mode==='comments' && JSON.stringify(current.comments||[])!==commentsKey)paintComments(current.comments||[]);
      if (mode === 'context') {
        if (switched) renderContext();
        refreshContextSelection();
        $('context-details').textContent=JSON.stringify(contextData(),null,2);
      }
      updateExpand();
    },
  };
})();
