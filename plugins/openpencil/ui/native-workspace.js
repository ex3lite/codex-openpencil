// Visible project, feedback and context controls around the original Rust editor.
const nativeWorkspace = (() => {
  const $ = id => document.getElementById(id);
  let state, mode, target, sending = false, displayedMode, commentDraft = null, commentsKey;
  let contextChanged = () => {}, retryContext = () => {}, delivery = {state:'pending'}, contextNotice = '';
  const context = nativeContextState.create();
  const pinnedDrafts = new Map();
  let activeAttachment;
  const drawer = $('workspace-drawer');
  const documentsDialog = $('workspace-documents-dialog');
  const more = $('workspace-more');
  const dock = $('workspace-dock');
  const documentTitle = $('workspace-document-title');
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
    $('workspace-layer-view').setAttribute('aria-pressed', 'true');
    for (const b of document.querySelectorAll('button[aria-controls=workspace-sheet-content]')) b.setAttribute('aria-expanded', 'false');
  }
  function close() { nativeUI.closePanel(); closed(); }
  nativeUI.onClose(closed);
  function show(next, title) {
    rememberDraft(); mode = next; drawer.replaceChildren();
    const active = {context:'context',comment:'comment',comments:'comments',agents:'agents',library:'library',documents:'documents'}[next];
    for (const b of document.querySelectorAll('button[aria-controls=workspace-sheet-content]')) b.setAttribute('aria-expanded', String(b.id === `workspace-${active}`));
    $('workspace-sheet-content').dataset.panel = next;
    $('workspace-layer-resources').setAttribute('aria-expanded', String(next === 'library'));
    $('workspace-layer-view').setAttribute('aria-pressed', String(next !== 'library'));
    nativeUI.openPanel(title, next === 'library', next === 'comment' ? '#comment-text' : 'content');
  }
  function describe(selection) {
    if (!selection?.count) return 'Выберите слой на холсте или в списке слоёв';
    return selection.nodes.map(n => n.name || n.type).join(', ');
  }
  function contextData() { return context.payload(); }
  function contextEdit(action) {
    action(); contextNotice = ''; contextChanged(); renderContext();
    $('workspace-context-label').textContent = `Контекст · ${context.attachments.length}`;
  }
  async function addContext() {
    const current = await nativeEditor.captureSelection();
    if (context.observe(current)) contextNotice = 'Открыт другой макет. Вложения предыдущего макета удалены.';
    if (state?.documentId !== current.documentId || state?.canvasId !== current.canvasId) pinnedDrafts.clear();
    state = current;
    contextEdit(() => {
      activeAttachment = context.add();
      if (!pinnedDrafts.has(activeAttachment)) pinnedDrafts.set(activeAttachment,{
        requestId:crypto.randomUUID(), documentId:current.documentId, canvasId:current.canvasId,
        path:current.layerPath?.join(' / ') || '', text:''
      });
    });
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
    const footer = $('context-selection-tools');
    if (footer) footer.hidden = context.available && context.selectionAttached;
    if (selection) selection.textContent = context.available ? describe(state?.selection) : 'Холст временно недоступен. Вложения сохранены в панели.';
    if (add) add.disabled = !context.available || !state?.selection?.count || !nativeBridge.capabilities.updateModelContext;
  }
  function renderContext() {
    const attachments = context.attachments;
    const active = attachments.find(item => item.id === activeAttachment) || attachments.at(-1);
    activeAttachment = active?.id;
    show('context', 'Контекст чата');
    const selection = make('p'); selection.id = 'context-selection';
    const add = button('Добавить в контекст', addContext, 'primary'); add.id = 'context-add';
    const flow=make('div',null,'context-panel-flow');
    drawer.append(flow);
    if (!active) flow.append(make('h2','Здесь пока ничего нет'), make('p','Выберите слой на холсте и нажмите «В контекст».'));
    else {
      flow.append(make('p','Только то, что вы прикрепили','context-subtitle'),
        make('h3',`Прикреплено · ${attachments.length}`,'context-count'));
      for (const attachment of attachments) {
        const name = attachment.nodes.map(node => node.name || node.type || node.id).join(', ');
        const draft = pinnedDrafts.get(attachment.id);
        const item = make('article', null, 'item context-attachment');
        const select = button(name, () => {activeAttachment = attachment.id;renderContext();});
        const trigger = select.querySelector('button') || select;
        trigger.setAttribute('aria-pressed',String(attachment.id === active.id));
        const remove = button('Удалить из контекста', () => contextEdit(() => {
          pinnedDrafts.delete(attachment.id);context.remove(attachment.id);
        }), 'context-remove');
        item.append(select,remove,make('small',draft?.path || `Слоёв: ${attachment.nodeIds.length} · версия ${attachment.capturedVersion}`));
        flow.append(item);
      }
      flow.append(make('p','Закреплено. Следующее выделение не изменит эту цель.','context-target-note'));
      const draft = pinnedDrafts.get(active.id);
      if(draft && nativeBridge.capabilities.message?.text) {
        const label = make('label','Комментарий к слою «'+active.nodes.map(node=>node.name).join(', ')+'»');
        label.htmlFor='pinned-comment-text';
        const text=make('textarea');text.id=label.htmlFor;text.maxLength=8000;text.value=draft.text;
        text.placeholder='Что изменить?';text.readOnly=sending;
        const send=button('Отправить в Codex',()=>submitComment(draft.text,send,{
          ...draft,selection:{pageId:active.pageId,nodeIds:active.nodeIds},attachmentId:active.id
        }),'primary');
        send.disabled=sending || !draft.text.trim();
        text.oninput=()=>{draft.text=text.value;send.disabled=sending || !draft.text.trim();};
        const editor=make('div',null,'pinned-comment');
        editor.append(label,text,send);flow.append(editor);
      }
    }
    const footer = make('div',null,'context-selection-tools');
    footer.id = 'context-selection-tools';
    footer.append(selection,add);flow.append(footer);
    if (attachments.length>1) flow.append(button('Удалить все вложения', () => contextEdit(() => {
      pinnedDrafts.clear();context.clear();
    })));
    if (contextNotice) flow.append(make('p', contextNotice));
    const deliveryText = make('p', null, 'delivery'); deliveryText.id = 'context-delivery'; deliveryText.setAttribute('role','status');
    const retry = button('Повторить передачу', () => retryContext()); retry.id = 'context-retry';
    flow.append(deliveryText, retry);
    const details = make('details'), summary = make('summary', 'Что именно получает Codex');
    const data = make('pre', JSON.stringify(contextData(), null, 2)); data.id = 'context-details';
    details.append(summary, data); flow.append(details);

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
  async function retargetComment(text) {
    const current=await nativeEditor.captureSelection();
    if (!current.selection?.count) {nativeEditor.status('Сначала выберите другой слой на холсте.');return;}
    target={...current,requestId:crypto.randomUUID()};commentDraft=null;
    renderComment(text);
  }
  function renderComment(previousText) {
    show('comment', 'Комментарий к выделению'); drawer.append(targetBlock(target.selection));
    const label = make('label', 'Что изменить?'); label.htmlFor = 'comment-text';
    const text = document.createElement('textarea'); text.id = 'comment-text'; text.maxLength = 8000;
    text.placeholder = 'Например: увеличь отступы у этой кнопки';text.value=previousText;
    const send = button('Отправить в Codex', () => submitComment(text.value, send), 'primary'); send.disabled = !previousText.trim();
    text.oninput = () => { send.disabled = !text.value.trim() || sending; };
    drawer.append(label, text, make('p', 'Комментарий сохранится в проекте вместе с точной целью. Следующее выделение его не изменит.'));
    const actions = make('div', null, 'actions'); actions.append(button('Выбрать другую цель', () => retargetComment(text.value)), send); drawer.append(actions); text.focus();
  }
  async function submitComment(text, control, captured = target) {
    if (sending || !captured || !text.trim()) return;
    const sourceMode=mode;
    const ownsView=()=>mode===sourceMode && state?.documentId===captured.documentId &&
      (captured.attachmentId ? activeAttachment===captured.attachmentId : target?.requestId===captured.requestId);
    sending=true;control.disabled=true;
    try {
      const snapshot=await nativeEditor.flush();
      const current=await nativeEditor.call('canvas_panel_state');
      if(current.documentId!==captured.documentId || current.canvasId!==captured.canvasId) throw Error('Открыт другой макет. Выберите цель заново.');
      const {shouldSend,...comment}=await nativeEditor.call('canvas_comment_create',{requestId:captured.requestId,text,prepareDelivery:true,
        pageId:captured.selection.pageId,nodeIds:captured.selection.nodeIds,expectedVersion:current.version,docJson:snapshot.docJson});
      if(shouldSend){
        let status='sent';
        try {
          const result=await nativeBridge.request('ui/message',{role:'user',content:[{type:'text',text:
            `Комментарий OpenBrush ${comment.id}\n${JSON.stringify(comment)}\nПрочитай canvas_comments. Измени только закреплённые слои; при изменившейся версии проверь их перед правкой. После проверки отметь комментарий выполненным.`}]});
          if(result?.isError)throw Error('Codex не принял сообщение');
        } catch {status='uncertain';}
        await nativeEditor.call('canvas_comment_update',{commentId:comment.id,status});
      }
      // A repeated intent is already journaled, including when the host receipt was lost.
      if(captured.attachmentId) {
        const draft=pinnedDrafts.get(captured.attachmentId);
        if(draft?.requestId===captured.requestId){draft.requestId=crypto.randomUUID();if(draft.text===text)draft.text='';}
      } else if(target?.requestId===captured.requestId) {commentDraft=null;}
      if(ownsView()){
        if(!captured.attachmentId){commentDraft=null;target=null;}
        mode=null;
        await renderComments();
      }
    } catch(error) {
      if(error.code!=='COMMENT_TARGET_MISSING' || !ownsView())throw error;
      target=captured;
      show('missing-target','Слой больше недоступен');
      drawer.append(make('p','Цель комментария удалена из макета.'),make('blockquote',text),
        button('Выбрать другую цель',()=>retargetComment(text),'primary'),button('Закрыть',close));
      commentDraft={target,text};
    } finally {
      sending=false;control.disabled=false;
      if(mode==='context')renderContext();
    }
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
    const activity = await nativeEditor.call('canvas_agents'); show('agents', 'Локальные агенты');
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
  async function backToChat() {
    if (!nativeBridge.context.availableDisplayModes?.includes('inline')) throw Error('Codex не предоставил возврат к чату.');
    const result = await nativeBridge.request('ui/request-display-mode', {mode:'inline'});
    if (result?.mode !== 'inline') throw Error('Codex не подтвердил возврат к чату.');
    nativeBridge.setDisplayMode(result.mode); updateExpand();
  }
  function updateExpand() {
    const value=nativeBridge.context.displayMode;
    $('toolbar-chat').hidden=value!=='fullscreen';
    $('workspace-expand').textContent = value === 'fullscreen' ? 'Свернуть редактор' : 'Развернуть редактор';
    if(nativeEditor.ready && ['inline','fullscreen'].includes(value) && displayedMode!==value) {
      nativeEditor.send({type:'op-bridge/display-mode',mode:value});displayedMode=value;
    }
  }
  const openLibrary=()=>nativeLibrary.open({show,drawer,make,button}).catch(e=>nativeEditor.status(e.message,true));
  $('workspace-library').onclick=openLibrary;
  $('workspace-save-state').onclick=()=>{
    const reason=state?.autosave?.error || '';
    show('save-error',/EACCES|EPERM|permission denied|нет доступа/i.test(reason)?'Нет доступа к папке проекта':'Автосохранение приостановлено');
    drawer.append(make('h2','Изменения остаются на открытом холсте.'));
    if(reason)drawer.append(make('p',reason));
    drawer.append(button('Закрыть',close));
  };
  documentsDialog.addEventListener('openchange', event => {
    if (!event.detail.value) {
      nativeDocuments.invalidate();
      return;
    }
    close();
    nativeDocuments.open({
      make, button, drawer: $('workspace-documents-body'),
      describe: text => { $('workspace-documents-description').textContent = text; },
      close: () => { documentsDialog.open = false; },
    }).catch(error => nativeEditor.status(error.message, true));
  });
  const send = (type, payload) => nativeEditor.send({ type: 'op-bridge/' + type, ...payload });
  for (const button of dock.querySelectorAll('button[data-tool]')) {
    button.onclick = () => send('tool', {tool:button.dataset.tool});
  }
  const otherTool = $('workspace-other-tool');
  otherTool.onchange = () => {
    if (otherTool.value) send('tool', {tool:otherTool.value});
    more.open = false;
  };
  for (const button of more.querySelectorAll('[data-editor-action]')) {
    button.onclick = () => send('editor-action', {action:button.dataset.editorAction});
  }
  $('workspace-zoom-out').onclick = () => send('zoom', {in:false});
  $('workspace-zoom-in').onclick = () => send('zoom', {in:true});
  $('workspace-zoom-value').onclick = () => send('fit-content');
  $('workspace-dock-comment').onclick = () => captureComment().catch(error => nativeEditor.status(error.message, true));
  more.addEventListener('click', event => {
    if (event.target.closest('#workspace-more-content button')) more.open = false;
  });
  $('workspace-chat').onclick=()=>backToChat().catch(e=>nativeEditor.status(e.message,true));
  $('workspace-attach').onclick=()=>addContext().catch(e=>nativeEditor.status(e.message,true));
  $('workspace-inspector').onclick=()=>nativeEditor.send({type:'op-bridge/toggle-inspector'});
  $('workspace-inspector-close').onclick=$('workspace-inspector').onclick;
  $('workspace-inspector-advanced-close').onclick=$('workspace-inspector').onclick;
  $('workspace-inspector-attach').onclick=$('workspace-attach').onclick;
  $('workspace-inspector-comment').onclick=$('workspace-dock-comment').onclick;
  $('workspace-layer-resources').onclick=openLibrary;
  $('workspace-layer-collapse').onclick=()=>send('toggle-sidebar');
  $('workspace-layer-view').onclick=()=>{ if (mode === 'library') close(); send('layers-view', {tab:'layers'}); };
  $('workspace-slides').onclick=()=>send('layers-view', {tab:'slides'});
  $('workspace-code-view').onclick=()=>send('inspector-view', {tab:$('workspace-inspector-advanced-close').hidden ? 'code' : 'design'});
  const layerQuery = $('workspace-layer-query');
  layerQuery.oninput = () => send('layer-search', {query:layerQuery.value});
  $('workspace-inspector-restore').querySelector('button').onclick=$('workspace-inspector').onclick;
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
      const hasHeader = Boolean(event.inspectorHeader);
      const layers = event.layers && !event.slides;
      $('workspace-layer-tabs').hidden = !layers;
      const search = $('workspace-layer-search');
      search.hidden = !layers;
      search.dataset.pages = String(event.layerPages || 1);
      $('workspace-inspector-header').hidden = !hasHeader;
      $('workspace-inspector-close').hidden = !event.inspectorVisible;
      $('workspace-inspector-advanced-close').hidden = !event.inspectorVisible || hasHeader;
      document.documentElement.dataset.inspectorHeader = String(hasHeader);
      $('workspace-code-view').textContent = event.inspectorVisible && !hasHeader ? 'Свойства слоя' : 'Код';
      $('workspace-inspector-restore').hidden=event.inspector;
      document.documentElement.dataset.layers = String(event.layers);
      document.documentElement.dataset.inspector = String(event.inspectorVisible);
    }
    if (event.type === 'op-shell/dock-state') {
      for (const button of dock.querySelectorAll('button[data-tool]')) {
        button.setAttribute('aria-pressed', String(button.dataset.tool === event.tool));
      }
      $('workspace-zoom-value').textContent = event.zoom + '%';
      otherTool.value = [...otherTool.options].some(option => option.value === event.tool) ? event.tool : '';
    }
    if(event.type==='op-shell/preview-state') {
      $('workspace-preview').setAttribute('aria-pressed',String(event.active));
      $('workspace-preview-label').textContent=event.active?'К редактору':'Проверить';
      $('workspace-preview').setAttribute('aria-label', event.active ? 'К редактору' : 'Проверить прототип');
      document.documentElement.dataset.preview = String(event.active);
    }
    if (event.type === 'op-shell/library') void openLibrary();
    if (event.type === 'op-shell/display-mode') void expand().catch(e => nativeEditor.status(e.message,true));
    if (event.type === 'op-shell/document-replaced') {
      if (layerQuery.value) { layerQuery.value = ''; layerQuery.oninput(); }
      target = null; commentDraft=null; pinnedDrafts.clear();activeAttachment=null;context.reset(); contextChanged();
      $('workspace-context-label').textContent = 'Контекст · 0'; close(); documentsDialog.open = false;
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
      if (switched) {pinnedDrafts.clear();activeAttachment=null;commentDraft=null; target=null; contextChanged(); if(layerQuery.value){layerQuery.value=''; layerQuery.oninput();}}
      if (switched) contextNotice = 'Открыт другой макет. Вложения предыдущего макета удалены.';
      const saving=current.autosave;
      const failed=['error','snapshot-rejected'].includes(saving?.state);
      $('workspace-save-state').hidden=!failed && saving?.state!=='pending';
      $('workspace-save-state').textContent=failed?'Не сохранено':saving?.state==='pending'?'Сохраняется…':'';
      $('workspace-save-state').disabled=!failed;
      $('workspace-save-state').dataset.error=String(failed);
      $('workspace-save-state').title=failed?saving.error||'Проверьте синхронизацию':'';
      $('workspace-project').textContent=current.project?.name||'Проект';
      const documentName = current.filePath?.split(/[/\\]/).pop()?.replace(/\.op$/i,'') || 'Без названия';
      documentTitle.textContent = documentName;
      documentTitle.title = documentName;
      $('workspace-context-label').textContent = `Контекст · ${context.attachments.length}`;
      $('workspace-context').title = 'Только явно добавленные вложения';
      $('workspace-attach').disabled=!current.selection?.count || !nativeBridge.capabilities.updateModelContext;
      $('workspace-comment').disabled = $('workspace-dock-comment').disabled = !current.selection?.count;
      $('workspace-inspector-attach').disabled = $('workspace-attach').disabled;
      $('workspace-inspector-comment').disabled = $('workspace-comment').disabled;
      const selected = current.selection?.nodes || [];
      const layer = $('workspace-inspector-layer');
      layer.textContent = selected.length > 1 ? `Выбрано слоёв · ${selected.length}` : selected[0]?.name || '';
      layer.title = layer.textContent;
      const types = {text:'Текст',frame:'Фрейм',group:'Группа',rectangle:'Прямоугольник',image:'Изображение',ref:'Экземпляр',path:'Контур'};
      $('workspace-inspector-layer-meta').textContent = selected.length === 1 ? [types[selected[0].type] || 'Слой',current.layerPath?.[0]].filter(Boolean).join(' · ') : '';
      $('workspace-inspector-layer-icon').dataset.obIcon = selected.length === 1 && ['text','frame'].includes(selected[0].type) ? selected[0].type : 'layers';
      const agentCount=(current.agents?.agents?.length||0)+(current.agents?.parent?1:0);
      $('workspace-agents').hidden=false;
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
