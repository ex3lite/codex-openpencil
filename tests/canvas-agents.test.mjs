import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile, chmod, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { CanvasAgents, writeAgentDocument } from '../plugins/openpencil/scripts/canvas-agents.mjs';
import { startCanvasAgentBroker, callCanvasAgent } from '../plugins/openpencil/scripts/canvas-agent-broker.mjs';

function fixture({ now = Date.now, write } = {}) {
  const roots = Array.from({ length: 12 }, (_, i) => ({ id: `root-${i}`, type: 'frame', name: `Frame ${i}`, width: 400, height: 300,
    children: [{ id: `text-${i}`, type: 'text', content: `Original ${i}` }] }));
  let live = { document: { version: '0.8.5', pages: [{ id: 'page-a', name: 'A', children: roots }, { id: 'page-b', name: 'B', children: [] }],
    variables: { brand: { type: 'color', value: '#FFFFFF' } } }, version: 0, activePageIndex: 0, preserveAuthoredGeometry: true, scenario: 'web' };
  const writes = [];
  const session = { document: async () => structuredClone(live) };
  const agents = new CanvasAgents({ session, now, writeDocument: async (document, version) => {
    writes.push({ document, version });
    if (write) return write(document, version);
    if (version !== live.version) throw Object.assign(new Error('Version conflict'), { code: 'VERSION_CONFLICT' });
    live = { ...live, document: structuredClone(document), version: live.version + 1 };
    return { version: live.version };
  } });
  const acquire = (i, options = {}) => agents.acquire({ agentId: `agent-${i}`, name: `Codex ${i}`, pageId: 'page-a', rootIds: [`root-${i}`], ...options });
  return { agents, acquire, writes, live: () => live, external: fn => { fn(live); live.version++; } };
}

test('ten independent leases have unique visible identities, IDs and exact original relay anchors', async () => {
  const f = fixture();
  const leases = await Promise.all(Array.from({ length: 10 }, (_, i) => f.acquire(i)));
  for (const key of ['agentId', 'leaseId', 'name', 'color']) assert.equal(new Set(leases.map(lease => lease[key])).size, 10, key);
  await assert.rejects(f.acquire(10), { code: 'AGENT_LIMIT' });
  const relay = f.agents.relay();
  assert.equal(relay.active, true);
  assert.equal(relay.frames.length, 10);
  assert.equal(relay.nodes.length, 10);
  assert.equal(relay.reveals.length, 10);
  assert.deepEqual(relay.reveals.map(item => item.id).sort(), leases.flatMap(lease => lease.rootIds).sort());
  assert.ok(relay.reveals.every(item => Number.isSafeInteger(item.ms) && item.ms === 0));
  assert.equal(f.writes.length, 0, 'Enrollment and indicator snapshots do not change the document');
  assert.equal(JSON.stringify(f.agents.status()).includes(leases[0].leaseId), false, 'Status does not disclose lease capabilities');
});

test('parent and descendant scopes conflict, while siblings can be leased independently', async () => {
  const f = fixture();
  const lease = await f.acquire(0);
  await assert.rejects(f.acquire(1, { rootIds: ['text-0'] }), { code: 'SCOPE_CONFLICT' });
  await assert.rejects(f.acquire(1, { rootIds: ['root-1', 'text-1'] }), { code: 'SCOPE_CONFLICT' });
  await assert.rejects(f.acquire(1, { pageId: 'page-b' }), { code: 'SCOPE_STALE' });
  await assert.rejects(f.acquire(1, { name: lease.name }), { code: 'IDENTITY_CONFLICT' });
  assert.equal((await f.acquire(1)).rootIds[0], 'root-1');
});

test('flat documents use the native page ID zero and reads resolve embedded image table references', async () => {
  const image = 'data:image/png;base64,fixture';
  const session = { document: async () => ({ version: 0, activePageIndex: 0, document: { version: '0.8.5', images: { sample: image }, children: [
    { id: 'root', type: 'frame', children: [{ id: 'image', type: 'image', src: 'op-image:sample' }] },
  ] } }) };
  const agents = new CanvasAgents({ session });
  const lease = await agents.acquire({ agentId: 'flat-agent', name: 'Flat agent', pageId: '0', rootIds: ['root'] });
  assert.equal((await agents.read(lease)).subtrees[0].children[0].src, image);
});

test('scoped subtree CAS preserves other agents, page metadata and variables', async () => {
  const f = fixture();
  const a = await f.acquire(0), b = await f.acquire(1);
  const before = structuredClone(f.live());
  const read = await f.agents.read(a);
  read.subtrees[0].children[0].content = 'Changed by A';
  read.subtrees[0].children.push({ id: 'a-new', type: 'rectangle', width: 20, height: 20 });
  const result = await f.agents.apply({ ...a, expectedVersion: read.version, subtrees: read.subtrees });
  assert.equal(result.version, 1);
  assert.equal(f.writes.length, 1);
  assert.deepEqual(f.live().document.pages[0].children[1], before.document.pages[0].children[1]);
  assert.deepEqual(f.live().document.variables, before.document.variables);
  assert.deepEqual(f.live().document.editorMeta, { activePageIndex: 0, preserveAuthoredGeometry: true, scenario: 'web' });
  assert.equal((await f.agents.read(b)).subtrees[0].children[0].content, 'Original 1');
  assert.equal(f.agents.relay().nodes.find(node => node.id === 'a-new').name, a.name);
  await assert.rejects(f.agents.apply({ ...b, expectedVersion: 0, subtrees: [(await f.agents.read(b)).subtrees[0]] }), { code: 'VERSION_CONFLICT' });
  assert.equal(f.writes.length, 1, 'Conflict is never replayed');
});

test('replacements cannot change a foreign root or steal foreign node IDs', async () => {
  const f = fixture(), a = await f.acquire(0), read = await f.agents.read(a);
  await assert.rejects(f.agents.apply({ ...a, expectedVersion: 0, subtrees: [{ id: 'root-1', type: 'frame' }] }), { code: 'INVALID_PATCH' });
  read.subtrees[0].children.push({ id: 'text-1', type: 'text', content: 'stolen' });
  await assert.rejects(f.agents.apply({ ...a, expectedVersion: 0, subtrees: read.subtrees }), { code: 'INVALID_DOCUMENT' });
  assert.equal(f.writes.length, 0);
});

test('a timeout dispatches exactly once and requires an explicit read before another write', async () => {
  const f = fixture({ write: async () => { throw Object.assign(new Error('Ambiguous timeout'), { code: 'UNCERTAIN_WRITE' }); } });
  const lease = await f.acquire(0), read = await f.agents.read(lease);
  read.subtrees[0].name = 'Modified';
  const request = { ...lease, expectedVersion: 0, subtrees: read.subtrees };
  await assert.rejects(f.agents.apply(request), { code: 'UNCERTAIN_WRITE' });
  await assert.rejects(f.agents.apply(request), { code: 'UNCERTAIN_WRITE' });
  assert.equal(f.writes.length, 1);
  assert.equal((await f.agents.inspect(lease)).state, 'uncertain');
  assert.equal((await f.agents.read(lease)).state, 'ready');
});

test('checkpoint failure reports the acknowledged mutation as applied and never replays it', async () => {
  const f = fixture();
  let checkpoints = 0;
  f.agents.session.checkpoint = async () => { checkpoints++; throw new Error('Disk failure'); };
  const lease = await f.acquire(0), read = await f.agents.read(lease);
  read.subtrees[0].name = 'Applied despite checkpoint failure';
  const result = await f.agents.apply({ ...lease, expectedVersion: read.version, subtrees: read.subtrees });
  assert.equal(result.applied, true); assert.equal(result.version, 1);
  assert.equal(result.recoverySaved, false); assert.match(result.recoveryError, /edit was applied/);
  assert.equal(f.writes.length, 1); assert.equal(checkpoints, 1);
  assert.equal(f.live().document.pages[0].children[0].name, 'Applied despite checkpoint failure');
});

test('expiration and release free only the owner scope and drain the last native cursor epoch', async () => {
  let now = 10_000;
  const f = fixture({ now: () => now });
  const a = await f.acquire(0, { ttlMs: 10_000 }), b = await f.acquire(1, { ttlMs: 20_000 });
  const active = f.agents.relay();
  now += 10_001;
  const remaining = f.agents.relay();
  assert.equal(remaining.frames.length, 1);
  assert.equal(remaining.frames[0].id, 'root-1');
  assert.notEqual(remaining.epoch, active.epoch);
  await assert.rejects(f.agents.read(a), { code: 'LEASE_EXPIRED' });
  await f.agents.release(b);
  const inactive = f.agents.relay();
  assert.equal(inactive.active, false);
  assert.equal(inactive.epoch, remaining.epoch, 'Rust requires the same remote epoch for graceful removal');
  await assert.rejects(f.agents.release(b), { code: 'LEASE_EXPIRED' });
  assert.equal((await f.acquire(0)).rootIds[0], 'root-0');
});

test('upstream original indicators survive when unused and are merged during collaboration', async () => {
  const f = fixture();
  const original = { epoch: 17, active: true, cursorAgent: { name: 'Original', color: '#123456' },
    frames: [{ id: 'native-root', name: 'Original', color: '#123456' }], nodes: [], previews: ['native-node'], reveals: [{ id: 'native-root', ms: 10 }] };
  assert.equal(f.agents.relay(original), original);
  const lease = await f.acquire(0);
  const combined = f.agents.relay(original);
  assert.equal(combined.frames.length, 2);
  assert.deepEqual(combined.cursorAgent, original.cursorAgent);
  assert.deepEqual(combined.previews, original.previews);
  await f.agents.release(lease);
  assert.equal(f.agents.relay(original), original);
});

test('ending unseen membership changes still clears the last actually relayed native epoch', async () => {
  const f = fixture(), a = await f.acquire(0);
  const seen = f.agents.relay();
  const b = await f.acquire(1);
  await f.agents.release(a); await f.agents.release(b);
  const ended = f.agents.relay();
  assert.equal(ended.active, false);
  assert.equal(ended.epoch, seen.epoch);
});

test('external scope moves are detected and concurrent stale writes are rejected without retries', async () => {
  const f = fixture(), a = await f.acquire(0), b = await f.acquire(1);
  const [ra, rb] = await Promise.all([f.agents.read(a), f.agents.read(b)]);
  ra.subtrees[0].name = 'A'; rb.subtrees[0].name = 'B';
  const results = await Promise.allSettled([
    f.agents.apply({ ...a, expectedVersion: 0, subtrees: ra.subtrees }),
    f.agents.apply({ ...b, expectedVersion: 0, subtrees: rb.subtrees }),
  ]);
  assert.deepEqual(results.map(result => result.status), ['fulfilled', 'rejected']);
  assert.equal(results[1].reason.code, 'VERSION_CONFLICT');
  assert.equal(f.writes.length, 1);
  f.external(live => live.document.pages[0].children[0].children.push(live.document.pages[0].children.splice(1, 1)[0]));
  await assert.rejects(f.agents.read(a), { code: 'SCOPE_CONFLICT' });
});

async function brokerFixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'canvas-agents-'));
  const options = { projectRoot: dir, registryDir: join(dir, 'registry') };
  const f = fixture();
  const broker = await startCanvasAgentBroker(f.agents, options);
  t.after(async () => { await broker.close(); await rm(dir, { recursive: true, force: true }); });
  const projectDir = join(options.registryDir, (await readdir(options.registryDir))[0]);
  const descriptorPath = join(projectDir, (await readdir(projectDir))[0]);
  return { ...f, broker, options, descriptorPath };
}

function childCall(canvasId, action, args, options) {
  const moduleUrl = new URL('../plugins/openpencil/scripts/canvas-agent-broker.mjs', import.meta.url).href;
  const code = `import {callCanvasAgent} from ${JSON.stringify(moduleUrl)};
    const [canvasId, action, args, options] = JSON.parse(process.argv[1]);
    try { console.log(JSON.stringify(await callCanvasAgent(canvasId, action, args, options))); }
    catch (error) { console.log(JSON.stringify({error: error.code})); process.exitCode = 1; }`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, JSON.stringify([canvasId, action, args, options])], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = ''; child.stdout.on('data', chunk => { out += chunk; }); child.stderr.on('data', chunk => { err += chunk; });
    child.once('error', reject); child.once('exit', code => { try { resolve({ code, value: JSON.parse(out), err }); } catch (error) { reject(error); } });
  });
}

test('ten separate Node MCP-equivalent processes join the exact parent canvas and keep distinct scopes', async t => {
  const f = await brokerFixture(t);
  const leases = await Promise.all(Array.from({ length: 10 }, (_, i) => f.acquire(i)));
  const children = await Promise.all(leases.map(lease => childCall(f.agents.canvasId, 'read', { leaseId: lease.leaseId }, f.options)));
  children.forEach((child, i) => {
    assert.equal(child.code, 0, child.err); assert.equal(child.value.canvasId, f.agents.canvasId);
    assert.equal(child.value.agentId, leases[i].agentId); assert.equal(child.value.subtrees[0].id, `root-${i}`);
  });
  const read = children[3].value;
  read.subtrees[0].name = 'Written by independent child';
  const written = await childCall(f.agents.canvasId, 'apply', { leaseId: leases[3].leaseId, expectedVersion: 0, subtrees: read.subtrees }, f.options);
  assert.equal(written.code, 0); assert.equal(written.value.version, 1);
  assert.equal(f.live().document.pages[0].children[3].name, 'Written by independent child');
  assert.equal(f.writes.length, 1);
  const serialized = JSON.stringify({ leases, children, written, broker: f.broker, status: f.agents.status() });
  const descriptor = JSON.parse(await readFile(f.descriptorPath, 'utf8'));
  assert.equal(serialized.includes(descriptor.token), false);
  if (process.platform !== 'win32') assert.equal((await stat(f.descriptorPath)).mode & 0o777, 0o600);
});

test('shared broker refuses cross-project discovery, browser origins, wrong leases and child enrollment', async t => {
  const f = await brokerFixture(t), lease = await f.acquire(0);
  await assert.rejects(callCanvasAgent(f.agents.canvasId, 'read', { leaseId: lease.leaseId }, { ...f.options, projectRoot: tmpdir() }), { code: 'SESSION_NOT_FOUND' });
  await assert.rejects(callCanvasAgent(f.agents.canvasId, 'read', { leaseId: 'foreign-lease' }, f.options), { code: 'LEASE_EXPIRED' });
  await assert.rejects(callCanvasAgent(f.agents.canvasId, 'acquire', { agentId: 'nested-agent' }, f.options), { code: 'UNSUPPORTED_ACTION' });
  const descriptor = JSON.parse(await readFile(f.descriptorPath, 'utf8'));
  const response = await fetch(`http://127.0.0.1:${descriptor.port}/agents`, { method: 'POST', headers: {
    Authorization: `Bearer ${descriptor.token}`, Origin: 'https://external.example', 'Content-Type': 'application/json',
  }, body: JSON.stringify({ canvasId: f.agents.canvasId, action: 'read', arguments: lease }) });
  assert.equal(response.status, 403);
  if (process.platform !== 'win32') {
    await chmod(f.descriptorPath, 0o644);
    await assert.rejects(callCanvasAgent(f.agents.canvasId, 'read', lease, f.options), { code: 'UNSAFE_SESSION_REGISTRY' });
  }
});

test('native CAS sends one request with baseVersion and never retries rejected mutations', async t => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, body: JSON.parse(body), token: req.headers['x-openpencil-token'] });
    res.writeHead(409, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'version-conflict', version: 9 }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const session = { assertLive() {}, port: server.address().port, token: 'never-returned-host-token' };
  const image = 'data:image/png;base64,fixture';
  await assert.rejects(writeAgentDocument(session, { version: '0.8.5', images: { sample: image },
    children: [{ id: 'image', type: 'image', src: 'op-image:sample' }],
    editorMeta: { activePageIndex: 1, preserveAuthoredGeometry: true, scenario: 'web' } }, 8), { code: 'VERSION_CONFLICT' });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.baseVersion, 8);
  assert.equal(requests[0].url, '/api/mcp/document');
  assert.equal(requests[0].token, session.token);
  assert.equal(requests[0].body.document.children[0].src, image);
  assert.equal(requests[0].body.document.images, undefined);
  assert.equal(requests[0].body.document.editorMeta.scenario, 'web');
  assert.equal(requests[0].body.activePageIndex, 1);
  assert.equal(requests[0].body.preserveAuthoredGeometry, true);
});
