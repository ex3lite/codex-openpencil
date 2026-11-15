// MCP Apps host protocol. The editor never creates its own model connection.
const nativeBridge = (() => {
  let sequence = 0, initialized, context = {}, capabilities = {}, teardown;
  const pending = new Map(), contextListeners = new Set();
  const post = message => window.parent.postMessage({ jsonrpc: '2.0', ...message }, '*');
  function request(method, params = {}) {
    if (typeof OP_PREVIEW !== 'undefined') return Promise.reject(Error('Действие доступно в панели Codex'));
    const id = `openpencil-${++sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(Error('Codex не подтвердил действие. Проверьте результат перед повтором.')); }, 30000);
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
    if (message.method === 'ping') post({ id: message.id, result: {} });
    if (message.method === 'ui/resource-teardown') {
      try { await teardown?.(); post({ id: message.id, result: {} }); }
      catch (error) { post({ id: message.id, error: { code: -32000, message: error.message } }); }
    }
  });
  return {
    async init() {
      if (initialized) return initialized;
      if (typeof OP_PREVIEW !== 'undefined') return { hostCapabilities: {}, hostContext: {} };
      initialized = await request('ui/initialize', { appInfo: { name: 'OpenPencil', version: '0.4.2' },
        appCapabilities: { availableDisplayModes: ['inline', 'fullscreen'] }, protocolVersion: '2026-01-26' });
      capabilities = initialized.hostCapabilities || {};
      context = { ...initialized.hostContext, ...context };
      post({ method: 'ui/notifications/initialized', params: {} });
      return { ...initialized, hostContext: context };
    },
    async call(name, args = {}) {
      const result = typeof OP_PREVIEW !== 'undefined'
        ? await (await previewFetch(OP_PREVIEW, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, arguments: args }) })).json()
        : await request('tools/call', { name, arguments: args });
      if (result.isError) throw Error(result.content?.[0]?.text || 'Ошибка редактора');
      return result;
    },
    request,
    get capabilities() { return capabilities; },
    get context() { return context; },
    onContext(listener) { contextListeners.add(listener); return () => contextListeners.delete(listener); },
    onTeardown(listener) { teardown = listener; },
  };
})();
