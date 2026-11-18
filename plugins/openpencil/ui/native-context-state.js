// Explicit attachments are snapshots, independent of the editor's live selection.
const nativeContextState = (() => {
  const clone = value => JSON.parse(JSON.stringify(value));
  function create() {
    let current = null, attachments = [], identity, available = false;
    function observe(value) {
      const next = JSON.stringify([value.project?.projectId ?? value.project?.id, value.documentId, value.canvasId]);
      const switched = identity !== undefined && identity !== next;
      if (switched) attachments = [];
      identity = next; current = value; available = true;
      return switched;
    }
    function selectionKey() {
      const selection = current?.selection;
      return selection?.count && JSON.stringify([current.documentId, selection.pageId, [...selection.nodeIds].sort()]);
    }
    return {
      observe,
      get selectionAttached() { return attachments.some(item => item.id === selectionKey()); },
      unavailable() { available = false; },
      reset() { attachments = []; current = null; identity = undefined; available = false; },
      add() {
        if (!available || !current?.selection?.count) throw Error('Сначала выделите слои на холсте.');
        const selection = current.selection;
        if (selection.count > 100) throw Error('Добавьте не больше 100 слоёв за один раз.');
        const nodeIds = [...selection.nodeIds];
        const key = selectionKey();
        if (attachments.some(item => item.id === key)) return key;
        if (attachments.length >= 20) throw Error('Можно закрепить до 20 выделений. Удалите ненужное вложение.');
        attachments.push({ id:key, pageId:selection.pageId, nodeIds,
          nodes:(selection.nodes || []).map(node => ({id:node.id, name:node.name, type:node.type})),
          capturedVersion:current.version });
        return key;
      },
      remove(id) { attachments = attachments.filter(item => item.id !== id); },
      clear() { attachments = []; },
      get attachments() { return clone(attachments); },
      get available() { return available; },
      payload() {
        return { schemaVersion:1,
          project:current?.project ? {id:current.project.projectId ?? current.project.id, name:current.project.name} : null,
          document:current ? {id:current.documentId, canvasId:current.canvasId, filePath:current.filePath} : null,
          attachments:available ? clone(attachments) : [],
          ...(!available ? {unavailable:true} : {}) };
      },
    };
  }
  // Serialize replacements so removal cannot be overtaken by an earlier send.
  function delivery(send, changed) {
    let desired, attempted, accepted, busy = false, error = null;
    const status = () => ({state:error ? 'error' : busy || desired !== accepted ? 'pending' : 'accepted', error});
    async function pump() {
      if (busy || desired === undefined || desired === attempted) return;
      const text = desired; attempted = text; busy = true; error = null; changed(status());
      try {
        const result = await send({content:[{type:'text', text}]});
        if (result?.isError) throw Error('Codex отклонил контекст.');
        accepted = text;
      } catch (failure) { error = failure.message || 'Codex не подтвердил контекст.'; }
      finally {
        busy = false; changed(status());
        if (desired !== attempted) void pump();
      }
    }
    return {
      update(payload) { desired = JSON.stringify(payload); void pump(); },
      retry() { if (!busy) { attempted = undefined; void pump(); } },
      get status() { return status(); },
    };
  }
  return {create, delivery};
})();
