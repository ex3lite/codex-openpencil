// Visible project, feedback and context controls around the original Rust editor.
const nativeWorkspace = (() => {
  const $ = id => document.getElementById(id);
  let state, mode, target, delivered, contextEnabled = true, sending = false, displayedMode, projectBusy = false;
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
    const active = { projects:'project', context:'context', comment:'comment', comments:'comments', agents:'agents' }[next];
    for (const b of document.querySelectorAll('#workspace-bar [aria-expanded]')) b.setAttribute('aria-expanded', String(b.id === `workspace-${active}`));
    const heading = make('div', null, 'drawer-heading'); heading.append(make('h2', title), button('Закрыть', close)); drawer.append(heading);
    window.dispatchEvent(new Event('resize'));
  }
  function describe(selection) {
    if (!selection?.count) return 'Выберите слой на холсте или в списке слоёв';
    return selection.nodes.map(n => n.name || n.type).join(', ');
  }
  function contextData(current = state) {
    if (!current) return null;
    return { project: current.project, documentId: current.documentId, canvasId: current.canvasId,
      canvasFile: current.filePath, version: current.version,
      selection: contextEnabled && current.selection ? {...current.selection,nodeIds:current.selection.nodeIds.slice(0,100),nodes:current.selection.nodes.slice(0,100),truncated:current.selection.count>100} : null, selectionSharing: contextEnabled,
      pendingComments: current.comments?.filter(c => c.status !== 'resolved').slice(-20).map(c => ({ id:c.id, pageId:c.pageId, nodeIds:c.nodeIds, text:c.text.slice(0,2000), version:c.version, status:c.status })) || [] };
  }
  function renderContext() {
    show('context', 'Контекст этого чата');
    const label = make('label', null, 'toggle'), toggle = document.createElement('input');
    toggle.type = 'checkbox'; toggle.checked = contextEnabled;
    toggle.onchange = () => { contextEnabled = toggle.checked; delivered = null; renderContext(); };
    label.append(toggle, make('span', 'Передавать текущее выделение')); drawer.append(label);
    drawer.append(make('p', 'В чат передаются данные ниже. Пустое выделение не означает весь макет. Комментарий закрепляется за выбранными слоями и своей версией.'));
    const data=make('pre', JSON.stringify(contextData(), null, 2));data.id='context-details';drawer.append(data);
    const delivery=make('p', delivered ? 'Контекст принят Codex.' : 'Ожидаем подтверждение Codex…', 'delivery');delivery.id='context-delivery';drawer.append(delivery);
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
          `Комментарий OpenPencil ${comment.id}\n${JSON.stringify(comment)}\nПрочитай canvas_comments. Измени только закреплённые слои; при изменившейся версии проверь их перед правкой. После проверки отметь комментарий выполненным.` }] });
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
    drawer.append(input, make('p', 'Внешний файл будет скопирован в designs этого проекта. Исходник сохранится.'));
    drawer.append(button('Добавить в проект', () => projectAction(async () => {
      await nativeEditor.call('canvas_document_import', { sourcePath:input.value.trim() }); await renderProjects();
    })));
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
    if (event.type === 'op-shell/document-replaced') { target = null; close(); }
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && mode && !sending) close(); });
  return {
    contextData,
    update(current, sent) {
      state = current; delivered = sent;
      $('workspace-project').textContent = current.project?.name || 'Проект';
      $('workspace-project').title = current.project?.projectRoot || '';
      $('workspace-context').textContent = contextEnabled ? `Контекст · ${current.selection?.count || 0}` : 'Контекст выключен';
      $('workspace-context').title = describe(current.selection);
      $('workspace-comment').disabled = !current.selection?.count;
      $('workspace-agents').textContent = `Агенты · ${current.agents?.agents?.length || 0}`;
      if (mode === 'context') {
        $('context-details').textContent=JSON.stringify(contextData(),null,2);
        $('context-delivery').textContent=delivered?'Контекст принят Codex.':'Ожидаем подтверждение Codex…';
      }
      updateExpand();
    },
  };
})();
