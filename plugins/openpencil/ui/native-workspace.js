// Visible project, feedback and context controls around the original Rust editor.
const nativeWorkspace = (() => {
  const $ = id => document.getElementById(id);
  let state, mode, target, sending = false, displayedMode, commentDraft = null, commentsKey;
  let contextChanged = () => {}, retryContext = () => {}, delivery = {state:'pending'}, contextNotice = '';
  const context = nativeContextState.create();
  const pinnedDrafts = new Map();
  let activeAttachment, agentsKey, feedbackDialog, permissionFailure, retargetDraft;
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
  function closeIcon(control, label) {
    const trigger = control.querySelector('button') || control;
    const icon = make('i');
    icon.dataset.obIcon = 'close'; icon.setAttribute('aria-hidden','true');
    trigger.replaceChildren(icon); trigger.setAttribute('aria-label',label);
  }
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
    const active = {context:'context','context-summary':'context',comment:'comment',comments:'comments',agents:'agents',library:'library',documents:'documents'}[next];
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
  function contextEdit(action, pinned = mode === 'context') {
    action(); contextNotice = ''; contextChanged(); renderContext(pinned);
    $('workspace-context-label').textContent = `Контекст · ${context.attachments.length}`;
  }
  async function addContext(pinned = true) {
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
    }, pinned);
  }
  function updateContextDelivery() {
    const output = $('context-delivery'); if (!output) return;
    output.textContent = delivery.state === 'accepted' ? 'Этот набор контекста принят Codex.' :
      delivery.state === 'unsupported' ? 'В этой панели Codex не поддерживает передачу контекста.' :
      delivery.state === 'error' ? `Передача не подтверждена: ${delivery.error} Повторите отправку.` : 'Передаём этот набор в Codex…';
    output.dataset.error = String(delivery.state === 'error');
    const retry = $('context-retry'); if (retry) retry.hidden = delivery.state !== 'error';
  }
  function badge(label, tone) {
    const element = make('span', label, 'feedback-badge');
    element.dataset.tone = tone;
    return element;
  }
  function refreshContextSelection() {
    const selection = $('context-selection'), add = $('context-add');
    const footer = $('context-selection-tools');
    if (footer) footer.hidden = context.available && context.selectionAttached;
    if (selection) selection.textContent = !context.available ? 'Холст временно недоступен.' :
      !state?.selection?.count ? 'Сначала выберите слой' : describe(state.selection);
    if (add) add.disabled = !context.available || !state?.selection?.count || !nativeBridge.capabilities.updateModelContext;
  }
  function attachmentCard(attachment, active, pinned) {
    const name = attachment.nodes.map(node => node.name || node.type || node.id).join(', ');
    const draft = pinnedDrafts.get(attachment.id);
    const item = make('article', null, 'item context-attachment');
    const select = button(name, () => {activeAttachment = attachment.id;renderContext(true);});
    const trigger = select.querySelector('button') || select;
    trigger.setAttribute('aria-pressed',String(pinned && attachment.id === active.id));
    const remove = button('Удалить из контекста', () => contextEdit(() => {
      pinnedDrafts.delete(attachment.id);context.remove(attachment.id);
    }), 'context-remove');
    if (!pinned) closeIcon(remove, 'Удалить из контекста');
    item.append(select,remove,make('small',draft?.path || `Слоёв: ${attachment.nodeIds.length} · версия ${attachment.capturedVersion}`));
    return item;
  }
  function renderContextSummary(attachments) {
    show('context-summary', attachments.length ? `Контекст чата · ${attachments.length}` : 'Контекст чата');
    const body = make('section', null, 'feedback-state');
    body.dataset.state = !attachments.length ? 'empty' : delivery.state;
    if (!attachments.length) {
      body.append(make('h2','Здесь пока ничего нет'),make('p','Выберите слой на холсте и нажмите\n«В контекст». Обычный клик его не добавляет.'));
      const footer = make('div',null,'feedback-footer');
      const add = button('В контекст', () => addContext(false)); add.id='context-add';
      const hint = make('small'); hint.id='context-selection';
      footer.append(add,hint); body.append(footer);
    } else if (delivery.state === 'error') {
      const heading = make('h2');
      const inspect = button(attachments.length === 1 ? 'Слой остался во вложениях' : 'Слои остались во вложениях', () => renderContext(true), 'feedback-error-link');
      (inspect.querySelector('button') || inspect).title = 'Открыть вложения';
      heading.append(inspect);
      body.append(badge('Передача не подтверждена','danger'),heading,
        make('p','Codex не подтвердил получение контекста.\nПроверьте чат и повторите передачу.'));
      const retry = button('Повторить передачу',retryContext,'feedback-retry');
      body.append(retry);
    } else {
      for (const attachment of attachments) body.append(attachmentCard(attachment, attachment, false));
      const label = delivery.state === 'accepted' ? 'Передан в Codex' : delivery.state === 'unsupported' ? 'Передача недоступна' : 'Передаём в Codex…';
      body.append(badge(label, delivery.state === 'accepted' ? 'success' : 'accent'),
        make('p','Вложение закреплено. Выбор другого слоя\nне меняет контекст этого сообщения.'));
    }
    body.setAttribute('aria-live','polite'); drawer.append(body); refreshContextSelection();
  }
  function renderContext(pinned = true) {
    const attachments = context.attachments;
    const active = attachments.find(item => item.id === activeAttachment) || attachments.at(-1);
    if (!pinned || !active) return renderContextSummary(attachments);
    activeAttachment = active.id;
    show('context', 'Контекст чата');
    const selection = make('p'); selection.id = 'context-selection';
    const add = button('Добавить в контекст', addContext, 'primary'); add.id = 'context-add';
    const flow = make('div',null,'context-panel-flow');
    drawer.append(flow);
    flow.append(make('p','Только то, что вы прикрепили','context-subtitle'),
      make('h3',`Прикреплено · ${attachments.length}`,'context-count'));
    for (const attachment of attachments) flow.append(attachmentCard(attachment, active, true));
    flow.append(make('p','Закреплено. Следующее выделение не изменит эту цель.','context-target-note'));
    const draft = pinnedDrafts.get(active.id);
    if(draft && nativeBridge.capabilities.message?.text) {
      const label = make('label','Комментарий к слою «'+active.nodes.map(node=>node.name).join(', ')+'»');
      label.htmlFor='pinned-comment-text';
      const text=make('textarea');text.id=label.htmlFor;text.maxLength=8000;text.value=draft.text;
      text.placeholder='Что изменить?';text.readOnly=sending;
      const send=button('Отправить в Codex',()=>submitComment(draft.text,send,{
        ...draft,version:active.capturedVersion, selection:{pageId:active.pageId,nodeIds:active.nodeIds,nodes:active.nodes,count:active.nodeIds.length},attachmentId:active.id
      }),'primary');
      send.disabled=sending || !draft.text.trim();
      text.oninput=()=>{draft.text=text.value;send.disabled=sending || !draft.text.trim();};
      const editor=make('div',null,'pinned-comment');
      editor.append(label,text,send);flow.append(editor);
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
  async function captureComment() {
    if(!nativeBridge.capabilities.message?.text) throw Error('Codex не предоставил отправку комментариев из этой панели. Комментарий можно написать в текущем чате.');
    rememberDraft();
    if (commentDraft) { target=commentDraft.target; return renderComment(commentDraft.text); }
    const current=await nativeEditor.captureSelection();
    if (!current.selection?.count) { nativeEditor.status('Сначала выделите элемент на холсте или в списке слоёв.'); return; }
    target = { ...current, requestId: crypto.randomUUID() };
    renderComment('');
  }
  function differentTarget(current, captured) {
    const selection = current?.selection, previous = captured.selection;
    return current?.documentId === captured.documentId && current.canvasId === captured.canvasId &&
      selection?.count > 0 && (selection.pageId !== previous.pageId || selection.nodeIds.length !== previous.nodeIds.length ||
        selection.nodeIds.some(id => !previous.nodeIds.includes(id)));
  }
  function chooseTarget(captured, text) {
    close();
    target = captured; commentDraft = {target, text}; retargetDraft = commentDraft;
    show('retarget', 'Другая цель комментария');
    const body = make('div',null,'feedback-state');
    const confirm = button('Закрепить выделение', async () => {
      const current = await nativeEditor.captureSelection();
      if (!differentTarget(current,captured)) throw Error('Выберите другой слой на холсте.');
      target = {...current, requestId:crypto.randomUUID()}; retargetDraft = null;
      if (captured.attachmentId) {
        const draft = pinnedDrafts.get(captured.attachmentId);
        if (draft?.requestId === captured.requestId) draft.text = '';
      }
      renderComment(text);
    }, 'primary');
    confirm.id='retarget-confirm'; confirm.disabled = !differentTarget(state,captured);
    body.append(make('p','Выберите другой слой на холсте или в списке слоёв.'),confirm); drawer.append(body);
  }
  function renderComment(previousText) {
    show('comment', 'Комментарий к слою');
    const body = make('section',null,'feedback-state'); body.dataset.state='draft';
    const label = make('label',[describe(target.selection), target.layerPath?.at(-1)].filter(Boolean).join(' / '),'feedback-target');
    label.htmlFor = 'comment-text'; label.title = `Слои: ${target.selection.nodeIds.join(', ')} · версия ${target.version}`;
    const text = make('textarea'); text.id = label.htmlFor; text.maxLength = 8000; text.readOnly=sending;
    text.placeholder = 'Что изменить?';text.value=previousText;
    const send = button('Отправить в Codex', () => submitComment(text.value, send), 'primary');
    send.disabled = sending || !previousText.trim();
    text.oninput = () => { send.disabled = !text.value.trim() || sending; };
    const footer = make('div',null,'feedback-footer');
    footer.append(send,button('Цель закреплена',()=>chooseTarget(target,text.value),'feedback-target-action'));
    const action = footer.lastElementChild?.querySelector('button');
    if (action) { action.title = 'Выбрать другую цель'; action.setAttribute('aria-label',action.title); }
    body.append(label,text,footer); drawer.append(body); text.focus();
  }
  function modal({kind,title,description,status,actionLabel,action}) {
    feedbackDialog?.close();
    const dialog = make('dialog',null,'feedback-dialog'); dialog.dataset.kind = kind;
    dialog.setAttribute('data-openbrush-ui',''); dialog.setAttribute('aria-labelledby','feedback-dialog-title');
    dialog.setAttribute('aria-describedby','feedback-dialog-description');
    const heading = make('header'), caption = make('h2',title); caption.id='feedback-dialog-title';
    const cross = button('×',()=>dialog.close(),'feedback-cross');
    closeIcon(cross, 'Закрыть');
    heading.append(caption,cross); dialog.append(heading);
    const body = make('div',null,'feedback-dialog-body');
    if (status) body.append(badge(status,'danger'));
    const message = make('p',description); message.id='feedback-dialog-description';
    const error = make('small',null,'feedback-error'); error.setAttribute('role','alert'); error.hidden = true;
    const actions = make('div',null,'feedback-dialog-actions');
    const confirm = button(actionLabel,async () => {
      if (confirm.disabled) return;
      confirm.disabled = true;
      try { await action(dialog); }
      catch (failure) { error.hidden = false; error.textContent = failure.message; }
      finally { confirm.disabled = false; }
    },'primary');
    actions.append(button('Закрыть',()=>dialog.close()),confirm);
    body.append(message,error);
    dialog.append(body,actions);
    dialog.addEventListener('close',()=>{ if (feedbackDialog === dialog) feedbackDialog = null; dialog.remove(); },{once:true});
    document.body.append(dialog); feedbackDialog = dialog; dialog.showModal(); return dialog;
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
            `Комментарий OpenBrush ${comment.id}\n${JSON.stringify(comment)}\nПрочитай canvas_comments. Когда начнёшь работу, отметь комментарий in_progress. Измени только закреплённые слои; при изменившейся версии проверь их перед правкой. После проверки отметь комментарий resolved и укажи результат в resolution.`}]});
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
      close(); target=captured; commentDraft={target,text};
      modal({kind:'missing-target', title:'Слой больше недоступен',
        description:'Цель комментария удалена из макета.\nТекст черновика сохранён. Выберите другой\nслой, прежде чем отправлять комментарий.',
        actionLabel:'Выбрать другую цель',action:dialog=>{dialog.close(); chooseTarget(captured,text);}});
    } finally {
      sending=false;control.disabled=false;
      if(mode==='context')renderContext();
    }
  }
  async function renderComments() { paintComments(await nativeEditor.call('canvas_comments')); }
  function participants(activity) {
    return [...(activity?.parent ? [activity.parent] : []), ...(activity?.agents || [])];
  }
  function paintComments(comments) {
    commentsKey = JSON.stringify([comments,state?.agents]);
    show('comments', `Комментарии · ${comments.length}`);
    if (!comments.length) {
      const empty = make('section',null,'feedback-state');
      empty.append(make('p','Выделите элемент и оставьте первый комментарий.'), button('К выделенному элементу', captureComment));
      drawer.append(empty);
    }
    for (const c of comments.slice().reverse()) {
      const item = make('article',null,'feedback-state feedback-comment'); item.dataset.state = c.status;
      const statuses = {draft:['Сохранён','muted'],sent:['Передан в чат','success'],uncertain:['Отправка не подтверждена','danger'],
        in_progress:['В работе','accent'],resolved:['Выполнено','success']};
      item.append(badge(...(statuses[c.status] || ['Статус неизвестен','muted'])));
      const name = c.nodes.map(node => node.name || node.id).join(', ');
      const detail = make('details',null,'feedback-comment-detail');
      detail.append(make('summary',name),make('small',`Слои: ${c.nodeIds.join(', ')} · версия ${c.version}`));
      if (c.status !== 'resolved') detail.append(button('Отметить выполненным', async () => {
        await nativeEditor.call('canvas_comment_update',{commentId:c.id,status:'resolved'}); await renderComments();
      }));
      if (c.status === 'uncertain') {
        item.append(make('h2','Комментарий сохранён в проекте'),make('p','Проверьте, появился ли он в чате.\nПовторная отправка может создать дубль.'));
        detail.querySelector('summary').textContent = 'Новая отправка — только явным действием.';
        detail.append(make('small',name),make('p',c.text)); item.append(detail);
      } else {
        item.append(detail,make('p',c.resolution || c.text));
        if (c.status === 'resolved') item.append(button('Показать слой', () => {
          nativeEditor.send({type:'op-bridge/reveal-layers',pageId:c.pageId,nodeIds:c.nodeIds});
        },'feedback-reveal'));
        if (c.status === 'in_progress' && c.agentId) {
          const agent = participants(state?.agents).find(actor => actor.agentId === c.agentId);
          if (agent) {
            const foot = make('div',null,'feedback-agent');
            const actor = make('strong',agent.name); actor.style.color=agent.color;
            foot.append(actor,make('small',agent.activity)); item.append(foot);
          }
        }
      }
      drawer.append(item);
    }
  }
  function paintAgents(activity) {
    agentsKey = JSON.stringify(activity);
    const actors = participants(activity);
    const children = activity?.agents?.length || 0;
    const limit = activity?.maxAgents || 10;
    // The coordinator has presence, but does not consume an assignment slot.
    show('agents', `Локальные агенты · ${children} / ${limit}`);
    const body = make('section',null,'feedback-state feedback-agents');
    if (actors.length) body.append(badge(actors.length > 1 ? 'Работают на одном холсте' : 'На холсте','accent'));
    else body.append(make('p','Сейчас никто не редактирует макет.'));
    for (const agent of actors) {
      const item = make('div',null,'feedback-agent');
      const name = make('strong',agent === activity.parent ? `${agent.name} · Координатор` : agent.name);
      name.style.color = agent.color;
      const scope = (agent.rootIds || []).join(', ');
      item.append(name,make('small',[agent.activity,scope].filter(Boolean).join(' / ')));
      body.append(item);
    }
    drawer.append(body);
  }
  async function renderAgents() { paintAgents(await nativeEditor.call('canvas_agents')); }
  function permissionDenied(saving) {
    return saving?.state === 'error' && (['EACCES','EPERM'].includes(saving.code) || (!saving.code && /EACCES|EPERM|permission denied|operation not permitted|нет доступа/i.test(saving.error || '')));
  }
  function showSaveError() {
    const saving = state?.autosave;
    if (permissionDenied(saving)) {
      const documentId = state.documentId;
      modal({kind:'permission',title:'Нет доступа к папке проекта',status:'Автосохранение приостановлено',
        description:'Изменения остаются на открытом холсте.\nПроверьте доступ к папке проекта\nи не закрывайте редактор до восстановления.',
        actionLabel:'Проверить снова',action:async dialog=>{await nativeEditor.retryAutosave(documentId); dialog.close();}});
    } else {
      show('save-error','Автосохранение приостановлено');
      drawer.append(make('h2','Изменения остаются на открытом холсте.'));
      if(saving?.error)drawer.append(make('p',saving.error));
      drawer.append(button('Закрыть',close));
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
  function previewLabel(active) {
    const back = nativeBridge.context.displayMode === 'fullscreen' ? 'В редактор' : 'К редактору';
    $('workspace-preview-label').textContent = active ? back : 'Проверить';
    $('workspace-preview').setAttribute('aria-label', active ? back : 'Проверить прототип');
  }
  function updateExpand() {
    const value=nativeBridge.context.displayMode;
    document.documentElement.dataset.displayMode = value || 'inline';
    previewLabel($('workspace-preview').getAttribute('aria-pressed') === 'true');
    $('toolbar-chat').hidden=value!=='fullscreen';
    $('workspace-expand').textContent = value === 'fullscreen' ? 'Свернуть редактор' : 'Развернуть редактор';
    if(nativeEditor.ready && ['inline','fullscreen'].includes(value) && displayedMode!==value) {
      nativeEditor.send({type:'op-bridge/display-mode',mode:value});displayedMode=value;
    }
  }
  const openLibrary=()=>nativeLibrary.open({show,drawer,make,button}).catch(e=>nativeEditor.status(e.message,true));
  $('workspace-library').onclick=openLibrary;
  $('workspace-save-state').onclick=showSaveError;
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
  $('workspace-context').onclick = () => renderContext(false);
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
    if(event.type==='op-shell/reveal-result') {
      if (event.ok) { if(mode==='comments') close(); }
      else nativeEditor.status('Закреплённый слой больше недоступен.',true);
    }
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
      previewLabel(event.active);
      document.documentElement.dataset.preview = String(event.active);
    }
    if (event.type === 'op-shell/library') void openLibrary();
    if (event.type === 'op-shell/display-mode') void expand().catch(e => nativeEditor.status(e.message,true));
    if (event.type === 'op-shell/document-replaced') {
      if (layerQuery.value) { layerQuery.value = ''; layerQuery.oninput(); }
      feedbackDialog?.close(); retargetDraft=null; target = null; commentDraft=null; pinnedDrafts.clear();activeAttachment=null;context.reset(); contextChanged();
      $('workspace-context-label').textContent = 'Контекст · 0'; close(); documentsDialog.open = false;
    }
  });
  return {
    contextData,
    onContextChange(changed, retry) { contextChanged = changed; retryContext = retry; },
    contextDelivery(status) {
      const changed = delivery.state !== status.state; delivery = status;
      if (mode === 'context') updateContextDelivery();
      if (mode === 'context-summary' && changed && context.attachments.length) renderContext(false);
    },
    contextUnavailable() {
      context.unavailable();
      if(mode === 'context-summary') refreshContextSelection();
      if (mode === 'context') {
        refreshContextSelection(); $('context-details').textContent = JSON.stringify(contextData(),null,2);
      }
    },
    update(current) {
      state = current;
      const switched = context.observe(current);
      if (switched) {feedbackDialog?.close(); retargetDraft=null; if(mode && !['context','context-summary','library'].includes(mode))close(); pinnedDrafts.clear();activeAttachment=null;commentDraft=null; target=null; contextChanged(); if(layerQuery.value){layerQuery.value=''; layerQuery.oninput();}}
      if (switched) contextNotice = 'Открыт другой макет. Вложения предыдущего макета удалены.';
      const saving=current.autosave;
      const permissionKey = permissionDenied(saving) ? current.documentId : null;
      if (permissionKey && permissionFailure !== permissionKey) showSaveError();
      permissionFailure = permissionKey;
      if (!permissionKey && feedbackDialog?.dataset.kind === 'permission' && saving?.state === 'saved') feedbackDialog.close();
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
      if(mode==='retarget' && retargetDraft) $('retarget-confirm').disabled=!differentTarget(current,retargetDraft.target);
      if(mode==='agents' && JSON.stringify(current.agents)!==agentsKey) paintAgents(current.agents);
      if(mode==='context-summary') { if(switched) renderContext(false); else refreshContextSelection(); }
      if(mode==='comments' && JSON.stringify([current.comments||[],current.agents])!==commentsKey)paintComments(current.comments||[]);
      if (mode === 'context') {
        if (switched) renderContext();
        else {
          refreshContextSelection();
          $('context-details').textContent=JSON.stringify(contextData(),null,2);
        }
      }
      updateExpand();
    },
  };
})();
