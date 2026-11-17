// MCP Apps host protocol. The editor never creates its own model connection.
const nativeBridge = (() => {
  let sequence = 0, initialized, context = {}, capabilities = {}, teardown, sessionRef, opening;
  let initialResult, initialError;
  const pending = new Map(), contextListeners = new Set(), resultWaiters = new Set();
  const post = message => window.parent.postMessage({ jsonrpc: '2.0', ...message }, '*');
  function request(method, params = {}, timeout = 30000) {
    if (typeof OP_PREVIEW !== 'undefined') return Promise.reject(Error('Действие доступно в панели Codex'));
    const id = `openpencil-${++sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(Error('Codex не подтвердил действие. Проверьте результат перед повтором.')); }, timeout);
      pending.set(id, { resolve, reject, timer });
      post({ id, method, params });
    });
  }
  window.addEventListener('message', async event => {
    if (event.source !== window.parent || event.data?.jsonrpc !== '2.0') return;
    const message = event.data;
    if (!message.method && pending.has(message.id)) {
      const entry = pending.get(message.id); pending.delete(message.id); clearTimeout(entry.timer);
      message.error ? entry.reject(Error(message.error.message)) : entry.resolve(message.result);
    }
    if (message.method === 'ui/notifications/host-context-changed') {
      context = { ...context, ...message.params };
      for (const listener of contextListeners) listener(context);
    }
    if (message.method === 'ui/notifications/tool-result') {
      initialResult = message.params;
      for (const waiter of resultWaiters) waiter();
    }
    if (message.method === 'ui/notifications/tool-cancelled') {
      initialError = Error('Открытие OpenBrush отменено.');
      for (const waiter of resultWaiters) waiter();
    }
    if (message.method === 'ping') post({ id: message.id, result: {} });
    if (message.method === 'ui/resource-teardown') {
      try { await teardown?.(); post({ id: message.id, result: {} }); }
      catch (error) { post({ id: message.id, error: { code: -32000, message: error.message } }); }
    }
  });
  function waitForCanvasResult() {
    const read = () => {
      if (initialError) throw initialError;
      if (initialResult?.isError) throw Object.assign(Error(initialResult.content?.find(c=>c.type==='text')?.text || 'Не удалось открыть OpenBrush.'),{code:initialResult.structuredContent?.code});
      const ref = initialResult?._meta?.canvasSession;
      if (!ref || typeof ref.projectRoot !== 'string' || typeof ref.sessionId !== 'string') return null;
      return {projectRoot:ref.projectRoot,sessionId:ref.sessionId};
    };
    try { const ref=read(); if(ref) return Promise.resolve(ref); } catch(error) {return Promise.reject(error);}
    return new Promise((resolve,reject)=>{
      const finish=()=>{try {const ref=read();if(ref){clearTimeout(timer);resultWaiters.delete(finish);resolve(ref);}}catch(error){clearTimeout(timer);resultWaiters.delete(finish);reject(error);}};
      const timer=setTimeout(()=>{resultWaiters.delete(finish);reject(Object.assign(Error('Ожидаем подключение OpenBrush к этому чату.'),{code:'MISSING_APP_SESSION'}));},30000);
      resultWaiters.add(finish);
    });
  }
  async function call(name, args = {}) {
    if (typeof nativeTransfer !== 'undefined') args = await nativeTransfer.prepare(call, name, args);
    const longOperation = name.startsWith('canvas_community_catalog_') || ['open_canvas', 'canvas_document_open', 'canvas_document_import', 'canvas_community_import', 'canvas_autosave', 'canvas_save', 'canvas_history_restore', 'canvas_icon_pack_acquire', 'canvas_icon_pack_update', 'canvas_fonts_prepare'].includes(name) || name === 'canvas_native_request' && args.path === '/api/mcp/document';
    const result = typeof OP_PREVIEW !== 'undefined'
      ? await (await previewFetch(OP_PREVIEW, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, arguments: args }) })).json()
      : await request('tools/call', sessionRef
        ? {name:'canvas_session_call',arguments:{...sessionRef,name,arguments:args}}
        : {name,arguments:args}, longOperation ? 120000 : 30000);
    if (result.isError) throw Object.assign(Error(result.content?.[0]?.text || 'Ошибка редактора'),
      { code: result.structuredContent?.code });
    return result;
  }
  return {
    async init() {
      if (initialized) return initialized;
      if (typeof OP_PREVIEW !== 'undefined') return { hostCapabilities: {}, hostContext: {} };
      initialized = await request('ui/initialize', { appInfo: { name: 'OpenBrush', version: '0.14.1' },
        appCapabilities: { availableDisplayModes: ['inline', 'fullscreen'] }, protocolVersion: '2026-01-26' });
      capabilities = initialized.hostCapabilities || {};
      context = { ...initialized.hostContext, ...context };
      post({ method: 'ui/notifications/initialized', params: {} });
      return { ...initialized, hostContext: context };
    },
    async openSession() {
      if (opening) return opening;
      opening = (async()=>{
        // MCP Apps may use another server process. Join the exact tool result's
        // owner instead of creating an unbound canvas in the extension host.
        if(typeof OP_PREVIEW==='undefined') {
          try { sessionRef=await waitForCanvasResult(); }
          catch(error) {
            if(!['PROJECT_ROOT_REQUIRED','PROJECT_ROOT_UNAVAILABLE','PROJECT_ROOT_AMBIGUOUS','MISSING_APP_SESSION'].includes(error.code)) throw error;
            sessionRef=await nativeLaunch.connect({call,request,capabilities});
          }
        }
        return call('open_canvas',{});
      })();
      return opening;
    },
    call,
    request,
    get capabilities() { return capabilities; },
    get context() { return context; },
    setDisplayMode(mode) { context = { ...context, displayMode: mode }; for (const listener of contextListeners) listener(context); },
    onContext(listener) { contextListeners.add(listener); return () => contextListeners.delete(listener); },
    onTeardown(listener) { teardown = listener; },
  };
})();
