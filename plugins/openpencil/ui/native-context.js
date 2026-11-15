let nativeContextPolling = false, nativeLastContext;
setInterval(async () => {
  if (!nativeEditor.ready || !nativeBridge.capabilities.updateModelContext || nativeContextPolling || document.hidden) return;
  nativeContextPolling = true;
  try {
    let context;
    try {
      const state = await nativeEditor.call('canvas_status');
      const selection = state.selection;
      context = { canvasFile: state.filePath, version: state.version,
        selection: selection ? { pageId: selection.pageId, nodeIds: selection.nodeIds.slice(0,100), count: selection.count,
          nodes: selection.nodes.slice(0,100).map(node => ({ id: node.id, name: (node.name || '').slice(0,240), type: node.type })),
          truncated: selection.count > 100 } : null };
    } catch { context = { canvasFile: nativeEditor.source, selection: null, selectionUnavailable: true }; }
    const text = JSON.stringify(context);
    if (text !== nativeLastContext) {
      const result = await nativeBridge.request('ui/update-model-context', { content: [{ type: 'text', text }] });
      if (result?.isError) throw Error('Host rejected the selection context');
      nativeLastContext = text;
    }
  } catch { /* Re-read context later; never retain a failed update as delivered. */ }
  finally { nativeContextPolling = false; }
}, 1000);
