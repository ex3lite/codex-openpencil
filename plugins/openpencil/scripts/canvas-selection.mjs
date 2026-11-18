const selectionError = (message, code) => Object.assign(new Error(message), { code });
const selectionIndexes = new WeakMap();

function selectionIndex(document, page, version) {
  const cached = selectionIndexes.get(document);
  if (cached?.page === page && cached.version === version) return cached.nodes;
  const nodes = new Map();
  const stack = [{ children: page.children || [], parentId: null }];
  while (stack.length) {
    const { children, parentId } = stack.pop();
    for (const node of children) {
      nodes.set(node.id, { id: node.id, name: node.name || node.type, type: node.type, parentId });
      const children = node.children;
      if (children?.length) stack.push({ children, parentId: node.id });
    }
  }
  // A session snapshot is immutable at a given version. Weak ownership releases
  // the index with the old document, including on project/document switches.
  selectionIndexes.set(document, { page, version, nodes });
  return nodes;
}

function editorState(reply) {
  if (reply?.error || reply?.result?.isError) throw new Error('Cannot read the canvas selection.');
  const result = reply?.result;
  let state = result?.structuredContent;
  if (!state) {
    const text = result?.content?.find(item => item.type === 'text')?.text;
    try { state = JSON.parse(text); } catch { throw new Error('Invalid canvas selection response.'); }
  }
  const pageIndex = Number(state.active_page_index);
  if (!Number.isSafeInteger(pageIndex) || pageIndex < 0 || typeof state.active_page_id !== 'string' || typeof state.selection_ids !== 'string') {
    throw new Error('Invalid canvas selection state.');
  }
  return { pageId: state.active_page_id, pageIndex,
    nodeIds: [...new Set(state.selection_ids.split(',').filter(id => id && id !== '0'))].sort() };
}

export function sameSelection(a, b) {
  const right = Array.isArray(b?.nodeIds) ? [...b.nodeIds].sort() : [];
  return a?.pageId === b?.pageId && Array.isArray(a?.nodeIds) && Array.isArray(b?.nodeIds) &&
    a.nodeIds.length === b.nodeIds.length && [...a.nodeIds].sort().every((id, index) => id === right[index]);
}

export async function readCanvasSelection(session, { fresh = false, includePath = false } = {}) {
  const state = async () => editorState(await session.forward({ jsonrpc: '2.0', id: 'canvas-selection',
    method: 'tools/call', params: { name: 'get_editor_state', arguments: {} } }));
  const before = await state();
  // Most gesture/status polls have no selection. They need a version, not a
  // transfer/parse/validation of every page and embedded image in a large kit.
  const versionOnly = !fresh && before.nodeIds.length === 0 && typeof session.selectionVersion === 'function';
  const live = versionOnly ? {version:await session.selectionVersion(),activePageIndex:before.pageIndex} :
    !fresh && session.selectionDocument ? await session.selectionDocument(before.pageIndex) : await session.document();
  const after = await state();
  if (!sameSelection(before, after) || before.pageIndex !== after.pageIndex || after.pageIndex !== live.activePageIndex) {
    throw selectionError('Выделение или страница меняется. Проверьте выбранные элементы и повторите.', 'SELECTION_TRANSITION');
  }
  if(versionOnly) return {live,selection:{...after,count:0,nodes:[]}};
  const document = live.document;
  const page = document.pages?.length ? document.pages[after.pageIndex] : document;
  if (!page || (document.pages?.length && page.id !== after.pageId)) throw selectionError('Страница синхронизируется. Повторите позже.', 'SELECTION_TRANSITION');
  const nodes = after.nodeIds.length ? selectionIndex(document, page, live.version) : new Map();
  if (after.nodeIds.some(id => !nodes.has(id))) throw selectionError('Выбранных элементов больше нет. Выделите их снова.', 'SELECTION_STALE');
  const selection = { ...after, count: after.nodeIds.length, nodes: after.nodeIds.map(id => nodes.get(id)) };
  if (includePath && selection.count === 1) {
    const path = [], seen = new Set();
    let ancestor = nodes.get(selection.nodes[0].parentId);
    while (ancestor && !seen.has(ancestor.id)) {
      seen.add(ancestor.id);
      path.push(ancestor.name);
      ancestor = nodes.get(ancestor.parentId);
    }
    return {live,selection,layerPath:path.reverse()};
  }
  return {live,selection};
}
