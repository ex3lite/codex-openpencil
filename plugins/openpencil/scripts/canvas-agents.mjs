import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { diskDocument, liveDocument } from './document-format.mjs';

export const MAX_CANVAS_AGENTS = 10;
const COLORS = ['#E25B63', '#218F89', '#527DE0', '#8461CE', '#36965C', '#C76C36', '#B34D91', '#458AA8', '#858231', '#A76554'];
const DEFAULT_TTL = 30 * 60_000;
const MAX_BYTES = 32 * 1024 * 1024;
const fail = (code, message, details) => Object.assign(new Error(message), { code, ...(details && { details }) });
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f]/.test(value);
const emptyRelay = () => ({ epoch: 0, active: false, cursorAgent: null, nodes: [], frames: [], previews: [], reveals: [] });

function treeIndex(document) {
  const nodes = new Map();
  const pages = document.pages?.length ? document.pages : [{ id: '0', children: document.children }];
  if (!Array.isArray(pages)) throw fail('INVALID_DOCUMENT', 'Canvas pages are invalid.');
  for (const page of pages) {
    if (!identifier(page.id) || !Array.isArray(page.children)) throw fail('INVALID_DOCUMENT', 'Canvas page structure is invalid.');
    const stack = page.children.map(node => ({ node, pageId: page.id, parentId: null, depth: 0 }));
    while (stack.length) {
      const entry = stack.pop(), { node, depth } = entry;
      if (!node || !identifier(node.id) || nodes.has(node.id) || depth > 100 || nodes.size >= 50_000 ||
          (node.children !== undefined && !Array.isArray(node.children))) throw fail('INVALID_DOCUMENT', 'Canvas node IDs or tree structure are invalid.');
      nodes.set(node.id, entry);
      for (const child of node.children || []) stack.push({ node: child, pageId: page.id, parentId: node.id, depth: depth + 1 });
    }
  }
  return nodes;
}

function contained(index, id, roots) {
  for (let cursor = index.get(id); cursor; cursor = index.get(cursor.parentId)) if (roots.includes(cursor.node.id)) return true;
  return false;
}

function replaceRoots(document, replacements) {
  const copy = structuredClone(document);
  const stack = copy.pages?.length ? copy.pages.map(page => page.children) : [copy.children];
  while (stack.length) {
    const children = stack.pop();
    for (let i = 0; i < children.length; i++) {
      if (replacements.has(children[i].id)) children[i] = structuredClone(replacements.get(children[i].id));
      else if (children[i].children) stack.push(children[i].children);
    }
  }
  return copy;
}

/** Atomic native document CAS; a network error must never replay this request. */
export async function writeAgentDocument(session, document, expectedVersion) {
  session.assertLive();
  const metadata = document.editorMeta || {};
  // Scenario has no wrapper override in Rust, so keep it inside editorMeta.
  const body = JSON.stringify({ document: { ...liveDocument(document), editorMeta: metadata }, baseVersion: expectedVersion,
    ...(metadata.activePageIndex !== undefined && { activePageIndex: metadata.activePageIndex }),
    ...(metadata.preserveAuthoredGeometry !== undefined && { preserveAuthoredGeometry: metadata.preserveAuthoredGeometry }),
  });
  if (Buffer.byteLength(body) > MAX_BYTES) throw fail('DOCUMENT_TOO_LARGE', 'Canvas document exceeds 32 MiB.');
  let response;
  try {
    response = await fetch(`http://127.0.0.1:${session.port}/api/mcp/document`, {
      method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', 'X-OpenPencil-Token': session.token },
      body, signal: AbortSignal.timeout(15_000),
    });
  } catch { throw fail('UNCERTAIN_WRITE', 'Canvas write outcome is unknown. Read the leased roots before deciding what to do next.'); }
  let value;
  try { value = await response.json(); }
  catch { throw fail('UNCERTAIN_WRITE', 'Canvas write returned an unreadable acknowledgement. Read the leased roots before another write.'); }
  if (response.status === 409 && value.error === 'version-conflict') {
    throw fail('VERSION_CONFLICT', 'Canvas changed. Read the leased roots and explicitly rebase the edit.', { version: value.version });
  }
  if (!response.ok || value.ok !== true) {
    throw fail(response.status >= 500 ? 'UNCERTAIN_WRITE' : 'WRITE_REJECTED', 'Native editor did not acknowledge the scoped canvas write.');
  }
  if (!Number.isSafeInteger(value.version) || value.version < expectedVersion) throw fail('UNCERTAIN_WRITE', 'Canvas write acknowledgement has an invalid version.');
  return { version: value.version };
}

/** One owner process, one document, at most ten disjoint subtree leases. */
export class CanvasAgents {
  constructor({ session, canvasId = randomUUID(), now = Date.now, writeDocument } = {}) {
    if (!session || typeof session.document !== 'function') throw new TypeError('CanvasAgents requires an editor session.');
    this.session = session;
    this.canvasId = canvasId;
    this.now = now;
    this.writeDocument = writeDocument || ((document, version) => writeAgentDocument(session, document, version));
    this.leases = new Map();
    this.queue = Promise.resolve();
    this.epoch = now() * 1000;
    this.hadAgents = false;
  }

  enqueue(work) { const result = this.queue.then(work); this.queue = result.catch(() => {}); return result; }
  advanceEpoch() {
    this.epoch++;
    // Old anchors must not replay when membership changes or a node is edited again.
    for (const lease of this.leases.values()) for (const id of lease.reveals.keys()) lease.reveals.set(id, 0);
  }
  prune() {
    let changed = false;
    for (const [id, lease] of this.leases) if (lease.expiresAt <= this.now() && !lease.inFlight) { this.leases.delete(id); changed = true; }
    if (changed && this.leases.size) this.advanceEpoch();
  }
  requireLease(leaseId) {
    this.prune();
    const lease = this.leases.get(leaseId);
    if (!lease) throw fail('LEASE_EXPIRED', 'Agent lease is missing, expired or released. Ask the canvas owner for a new assignment.');
    return lease;
  }
  publicLease(lease, includeId = true) {
    return { canvasId: this.canvasId, ...(includeId && { leaseId: lease.leaseId }), agentId: lease.agentId,
      name: lease.name, color: lease.color, pageId: lease.pageId, rootIds: [...lease.rootIds],
      expiresAt: lease.expiresAt, state: lease.uncertain ? 'uncertain' : lease.inFlight ? 'writing' : 'ready' };
  }
  assertRoots(lease, index) {
    if (lease.rootIds.some(id => index.get(id)?.pageId !== lease.pageId)) throw fail('SCOPE_STALE', 'An assigned root was deleted or moved to another page. Ask the owner to assign new roots.');
    for (const other of this.leases.values()) {
      if (other === lease) continue;
      if (lease.rootIds.some(id => contained(index, id, other.rootIds)) || other.rootIds.some(id => contained(index, id, lease.rootIds))) {
        throw fail('SCOPE_CONFLICT', 'Assigned subtrees now overlap. The canvas owner must resolve the assignments.');
      }
    }
  }

  acquire({ agentId, name, pageId, rootIds, ttlMs = DEFAULT_TTL } = {}) {
    return this.enqueue(async () => {
      this.prune();
      if (!identifier(agentId) || !identifier(name) || name.length > 60 || !identifier(pageId) ||
          !Array.isArray(rootIds) || !rootIds.length || rootIds.length > 100 || rootIds.some(id => !identifier(id)) || new Set(rootIds).size !== rootIds.length ||
          !Number.isSafeInteger(ttlMs) || ttlMs < 10_000 || ttlMs > 60 * 60_000) throw fail('INVALID_ASSIGNMENT', 'Use an agent ID, a unique short name, a page, disjoint root IDs and a 10-second to 60-minute lease.');
      if (this.leases.size >= MAX_CANVAS_AGENTS) throw fail('AGENT_LIMIT', 'This canvas already has ten active agents.');
      if ([...this.leases.values()].some(lease => lease.agentId === agentId || lease.name === name)) throw fail('IDENTITY_CONFLICT', 'Each active agent needs a distinct ID and display name.');
      const live = await this.session.document(), index = treeIndex(live.document);
      if (rootIds.some(id => index.get(id)?.pageId !== pageId)) throw fail('SCOPE_STALE', 'Every assigned root must exist on the specified page.');
      if (rootIds.some(id => rootIds.some(other => other !== id && contained(index, id, [other])))) throw fail('SCOPE_CONFLICT', 'One assignment cannot contain both an ancestor and its descendant.');
      const lease = { leaseId: randomUUID(), agentId, name, pageId, rootIds: [...rootIds], ttlMs,
        color: COLORS.find(color => ![...this.leases.values()].some(other => other.color === color)),
        expiresAt: this.now() + ttlMs, reveals: new Map(rootIds.map(id => [id, 0])), uncertain: false, inFlight: false };
      this.assertRoots(lease, index);
      this.leases.set(lease.leaseId, lease);
      this.advanceEpoch(); this.hadAgents = true;
      return { ...this.publicLease(lease), version: live.version };
    });
  }

  read({ leaseId } = {}) {
    return this.enqueue(async () => {
      const lease = this.requireLease(leaseId), live = await this.session.document(), index = treeIndex(liveDocument(live.document));
      this.assertRoots(lease, index);
      lease.uncertain = false;
      return { ...this.publicLease(lease), version: live.version, subtrees: lease.rootIds.map(id => structuredClone(index.get(id).node)) };
    });
  }

  apply({ leaseId, expectedVersion, subtrees } = {}) {
    return this.enqueue(async () => {
      const lease = this.requireLease(leaseId);
      if (lease.uncertain) throw fail('UNCERTAIN_WRITE', 'Read the leased roots to reconcile the previous write before another mutation.');
      if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || !Array.isArray(subtrees) || !subtrees.length ||
          subtrees.some(node => !node || !lease.rootIds.includes(node.id)) || new Set(subtrees.map(node => node.id)).size !== subtrees.length) {
        throw fail('INVALID_PATCH', 'Provide the observed version and canonical replacement subtrees with unchanged assigned root IDs.');
      }
      const live = await this.session.document();
      if (live.version !== expectedVersion) throw fail('VERSION_CONFLICT', 'Canvas changed. Read the assigned roots and explicitly rebase the edit.', { version: live.version });
      live.document = liveDocument(live.document);
      const before = treeIndex(live.document);
      this.assertRoots(lease, before);
      const replacements = new Map(subtrees.map(node => [node.id, node]));
      const document = replaceRoots(diskDocument(live), replacements), after = treeIndex(document);
      for (const [id] of after) if (before.has(id) && !contained(before, id, [...replacements.keys()]) && contained(after, id, [...replacements.keys()])) {
        throw fail('SCOPE_CONFLICT', 'A replacement cannot take a node ID from outside its replaced roots.');
      }
      // Duplicate IDs anywhere in the document are already rejected by treeIndex.
      const changed = [...after].filter(([id, entry]) => contained(after, id, [...replacements.keys()]) &&
        !isDeepStrictEqual(entry.node, before.get(id)?.node)).map(([id]) => id);
      if (!changed.length && isDeepStrictEqual(document, diskDocument(live))) return { applied: false, version: live.version, ...this.publicLease(lease) };
      this.requireLease(leaseId);
      lease.inFlight = true;
      let result;
      try { result = await this.writeDocument(document, expectedVersion); }
      catch (error) {
        if (!['VERSION_CONFLICT', 'WRITE_REJECTED', 'DOCUMENT_TOO_LARGE'].includes(error.code)) {
          lease.uncertain = true; this.session.persistence?.fail(error);
        }
        throw error;
      } finally { lease.inFlight = false; }
      this.advanceEpoch();
      for (const id of lease.reveals.keys()) if (!after.has(id)) lease.reveals.delete(id);
      changed.forEach((id, i) => lease.reveals.set(id, this.now() + i * 160));
      lease.expiresAt = this.now() + lease.ttlMs;
      let recoveryError;
      if (typeof this.session.checkpoint === 'function') {
        try { await this.session.checkpoint(); }
        catch { recoveryError = 'The edit was applied, but its recovery checkpoint failed. Save or checkpoint the canvas explicitly.'; }
      }
      return { applied: true, version: result.version, changedNodeIds: changed, ...this.publicLease(lease),
        recoverySaved: typeof this.session.checkpoint === 'function' && !recoveryError, ...(recoveryError && { recoveryError }) };
    });
  }

  renew({ leaseId } = {}) { return this.enqueue(() => { const lease = this.requireLease(leaseId); lease.expiresAt = this.now() + lease.ttlMs; return this.publicLease(lease); }); }
  release({ leaseId } = {}) {
    return this.enqueue(() => {
      this.requireLease(leaseId); this.leases.delete(leaseId); if (this.leases.size) this.advanceEpoch();
      return { canvasId: this.canvasId, released: true };
    });
  }
  inspect({ leaseId } = {}) { return this.enqueue(() => this.publicLease(this.requireLease(leaseId))); }
  status() { this.prune(); return { canvasId: this.canvasId, maxAgents: MAX_CANVAS_AGENTS, agents: [...this.leases.values()].map(lease => this.publicLease(lease, false)) }; }

  /** Pass the daemon's original relay. The existing Rust/WASM painter owns all visuals. */
  relay(upstream = emptyRelay()) {
    this.prune();
    if (!this.leases.size) {
      // An inactive message must carry the last observed epoch to drain the Rust mirror.
      return this.hadAgents && !upstream.active ? { ...upstream, epoch: this.lastRelayEpoch ?? this.epoch } : upstream;
    }
    const nodes = new Map((upstream.nodes || []).map(node => [node.id, node]));
    const frames = new Map((upstream.frames || []).map(node => [node.id, node]));
    const reveals = new Map((upstream.reveals || []).map(node => [node.id, node]));
    for (const lease of this.leases.values()) {
      const tag = { color: lease.color, name: lease.name };
      for (const id of lease.rootIds) frames.set(id, { id, ...tag });
      for (const [id, ms] of lease.reveals) { nodes.set(id, { id, ...tag }); reveals.set(id, { id, ms }); }
    }
    this.lastRelayEpoch = this.epoch;
    return { ...upstream, epoch: this.epoch, active: true, cursorAgent: upstream.cursorAgent || null,
      nodes: [...nodes.values()], frames: [...frames.values()], previews: upstream.previews || [], reveals: [...reveals.values()] };
  }

  dispatch(action, args) {
    if (!['read', 'apply', 'renew', 'release', 'inspect'].includes(action)) throw fail('UNSUPPORTED_ACTION', 'The shared agent connection only accepts assigned-scope operations.');
    return this[action](args);
  }
}

export { CanvasAgents as CanvasAgentCoordinator };
