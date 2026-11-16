import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';

// Clone JSON containers without copying the same shared image string per node.
function copyDocument(document) {
  const root = Array.isArray(document) ? [] : {}, seen = new Map([[document, root]]), stack = [[document, root]];
  while (stack.length) {
    const [source, target] = stack.pop();
    for (const [key, value] of Object.entries(source)) {
      if (key === '__proto__') { Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true }); continue; }
      if (!value || typeof value !== 'object') target[key] = value;
      else {
        let copy = seen.get(value);
        if (!copy) { copy = Array.isArray(value) ? [] : {}; seen.set(value, copy); stack.push([value, copy]); }
        target[key] = copy;
      }
    }
  }
  return root;
}

// Match the Rust schema's structural image visitor. Never rewrite free-form
// user state, text, action parameters or variables that resemble image refs.
function visitImages(document, rewrite) {
  const fills = list => {
    if (Array.isArray(list)) for (const fill of list) if (fill?.type === 'image') fill.url = rewrite(fill.url);
  };
  const style = node => { fills(node.fill); fills(node.stroke?.fill); };
  const stack = [...(document.children || []), ...(document.pages || [])];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (node.type === 'image') node.src = rewrite(node.src);
    style(node);
    for (const override of Object.values(node.states || {})) if (override && typeof override === 'object') style(override);
    if (Array.isArray(node.children)) stack.push(...node.children);
  }
}
export function liveDocument(disk) {
  const copy = copyDocument(disk), table = copy.images || {};
  delete copy.images; delete copy.imageThumbs; delete copy.editorMeta;
  visitImages(copy, value => typeof value === 'string' && value.startsWith('op-image:') &&
    Object.hasOwn(table, value.slice(9)) ? table[value.slice(9)] : value);
  return copy;
}

// Keep shared data images in the .op table across HTTP writes and disk saves.
// Expanding one image at hundreds of nodes can turn a small file into gigabytes.
export function transportDocument(document) {
  const copy = copyDocument(document), table = { ...(copy.images || {}) };
  const known = new Map(Object.entries(table).map(([key, value]) => [value, key]));
  visitImages(copy, value => {
    if (typeof value !== 'string' || !value.startsWith('data:')) return value;
    let key = known.get(value);
    if (key === undefined) {
      key = createHash('sha256').update(value).digest('hex');
      // Existing keys are opaque and must never be overwritten by a hash clash.
      while (Object.hasOwn(table, key) && table[key] !== value) key += '-image';
      table[key] = value; known.set(value, key);
    }
    return 'op-image:' + key;
  });
  if (Object.keys(table).length) copy.images = table;
  return copy;
}

function comparableDocument(document, hashes) {
  const copy = copyDocument(document), table = copy.images || {};
  delete copy.images; delete copy.imageThumbs; delete copy.editorMeta;
  visitImages(copy, value => {
    const resolved = typeof value === 'string' && value.startsWith('op-image:') && Object.hasOwn(table, value.slice(9))
      ? table[value.slice(9)] : value;
    if (typeof resolved !== 'string' || !resolved.startsWith('data:')) return resolved;
    if (!hashes.has(resolved)) hashes.set(resolved, createHash('sha256').update(resolved).digest('hex'));
    return { imageDataSha256: hashes.get(resolved) };
  });
  return copy;
}
export function snapshotMatches(disk, live) {
  const meta = disk.editorMeta, hashes = new Map();
  return isDeepStrictEqual(comparableDocument(disk, hashes), comparableDocument(live.document, hashes)) &&
    (!meta || (meta.activePageIndex === live.activePageIndex &&
      meta.preserveAuthoredGeometry === live.preserveAuthoredGeometry &&
      (meta.scenario ?? null) === (live.scenario ?? null)));
}

export function diskDocument(live) {
  return { ...transportDocument(live.document), editorMeta: { activePageIndex: live.activePageIndex,
    preserveAuthoredGeometry: live.preserveAuthoredGeometry,
    ...(live.scenario != null ? { scenario: live.scenario } : {}) } };
}
