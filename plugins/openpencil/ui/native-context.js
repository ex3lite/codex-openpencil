let nativeContextPolling = false, nativeLastContext;
setInterval(async () => {
  if (!nativeEditor.ready || nativeContextPolling || document.hidden) return;
  nativeContextPolling = true;
  try {
    let context, state;
    try {
      state = await nativeEditor.call('canvas_status');
      context = nativeWorkspace.contextData(state);
    } catch { context = { canvasFile: nativeEditor.source, selection: null, selectionUnavailable: true }; }
    const text = JSON.stringify(context);
    if (text !== nativeLastContext && nativeBridge.capabilities.updateModelContext) {
      const result = await nativeBridge.request('ui/update-model-context', { content: [{ type: 'text', text }] });
      if (result?.isError) throw Error('Host rejected the selection context');
      nativeLastContext = text;
    }
    if (state) nativeWorkspace.update(state, text === nativeLastContext);
  } catch { /* Re-read context later; never retain a failed update as delivered. */ }
  finally { nativeContextPolling = false; }
}, 1000);
