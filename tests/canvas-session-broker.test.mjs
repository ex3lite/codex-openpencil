import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, readdir, readFile, writeFile, chmod, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { startCanvasSessionBroker, callCanvasSession, validateCanvasSessionOperation } from '../plugins/openpencil/scripts/canvas-session-broker.mjs';

const fixturePath = fileURLToPath(new URL('./fixtures/canvas-session-owner.mjs', import.meta.url));
const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });

async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), 'canvas-session-broker-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function spawnFixture(options) {
  const child = fork(fixturePath, [JSON.stringify(options)], { silent: true });
  let diagnostics = '';
  child.stderr.on('data', chunk => { diagnostics += chunk; });
  const ready = new Promise((resolve, reject) => {
    child.once('message', resolve);
    child.once('error', reject);
    child.once('exit', code => { if (code) reject(new Error(`Session fixture exited ${code}: ${diagnostics}`)); });
  });
  return { child, ready };
}

async function owner(t) {
  const projectRoot = await directory(t), registryDir = join(projectRoot, 'registry'), sessionId = randomUUID();
  const instance = spawnFixture({ projectRoot, registryDir, sessionId });
  t.after(async () => {
    if (instance.child.connected) { const closed = once(instance.child, 'exit'); instance.child.send('close'); await closed; }
  });
  const ready = await instance.ready;
  return { ...instance, projectRoot, registryDir, sessionId, identity: { ...ready.identity, registryDir }, ownerPid: ready.pid };
}

async function client(identity, name, args = {}) {
  const instance = spawnFixture({ client: true, identity, name, args });
  const exited = once(instance.child, 'exit');
  const response = await instance.ready; await exited;
  return response;
}

async function descriptor(f) {
  const subdir = (await readdir(f.registryDir))[0];
  const path = join(f.registryDir, subdir, `${f.sessionId}.json`);
  return { path, value: JSON.parse(await readFile(path, 'utf8')) };
}

test('independent App process attaches to the model owner and receives private MCP metadata', async t => {
  const f = await owner(t);
  const app = await client(f.identity, 'open_canvas');
  assert.ok(!app.error);
  assert.notEqual(app.pid, f.ownerPid);
  assert.equal(app.result.structuredContent.ownerPid, f.ownerPid);
  assert.equal(app.result.structuredContent.documentId, 'document-a');
  assert.equal(app.result._meta.canvas.token, 'fixture-private-native-grant');
  assert.equal(app.result._meta.canvasSession.sessionId, f.sessionId);
  assert.ok(!JSON.stringify({ content: app.result.content, structuredContent: app.result.structuredContent }).includes('fixture-private-native-grant'));
  assert.deepEqual(Object.keys(app.result._meta.canvasSession).sort(), ['projectRoot', 'sessionId']);
  const { value, path } = await descriptor(f);
  assert.ok(!JSON.stringify(f.identity).includes(value.token));
  if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test('session identity survives document switches and two clients share the owner queue', async t => {
  const f = await owner(t);
  const before = await client(f.identity, 'open_canvas');
  const switched = await client(f.identity, 'canvas_document_open', { documentId: 'document-b' });
  assert.equal(switched.result.structuredContent.documentId, 'document-b');
  const app = await client(f.identity, 'open_canvas');
  assert.equal(app.result._meta.canvasSession.sessionId, before.result._meta.canvasSession.sessionId);
  assert.equal(app.result.structuredContent.documentId, 'document-b');
  const [a, b] = await Promise.all([client(f.identity, 'canvas_document_open', { documentId: 'document-c' }),
    client(f.identity, 'canvas_document_open', { documentId: 'document-d' })]);
  assert.ok(!a.error && !b.error);
  const inspect = once(f.child, 'message'); f.child.send('inspect');
  const [state] = await inspect;
  assert.equal(state.maxActive, 1);
  assert.equal(state.events.filter(event => event.name === 'canvas_document_open').length, 3);
  assert.equal(state.version, 3);
});

test('explicit session identity never discovers another project or guesses a latest canvas', async t => {
  const f = await owner(t), other = join(f.projectRoot, 'other-project'); await mkdir(other);
  await assert.rejects(callCanvasSession({ ...f.identity, projectRoot: other }, 'open_canvas'), { code: 'SESSION_NOT_FOUND' });
  await assert.rejects(callCanvasSession({ ...f.identity, sessionId: randomUUID() }, 'open_canvas'), { code: 'SESSION_NOT_FOUND' });
  await assert.rejects(callCanvasSession({ projectRoot: f.projectRoot, registryDir: f.registryDir }, 'open_canvas'), { code: 'INVALID_SESSION_ID' });
  await assert.rejects(callCanvasSession({ sessionId: f.sessionId, registryDir: f.registryDir }, 'open_canvas'), { code: 'PROJECT_ROOT_REQUIRED' });
  await assert.rejects(callCanvasSession({ ...f.identity, projectRoot: 'relative' }, 'open_canvas'), { code: 'PROJECT_ROOT_REQUIRED' });
});

test('only attach-current and explicit app controls may cross the broker', async t => {
  const f = await owner(t);
  for (const name of ['batch_design', 'update_node', 'spawn_agents', 'canvas_agent_assign', 'canvas_codegen_complete', 'canvas_open_browser']) {
    await assert.rejects(callCanvasSession(f.identity, name, {}), { code: 'SESSION_TOOL_DENIED' });
  }
  for (const args of [{ filePath: '/another.op' }, { documentId: 'other' }, { projectRoot: f.projectRoot }]) {
    await assert.rejects(callCanvasSession(f.identity, 'open_canvas', args), { code: 'SESSION_TOOL_DENIED' });
  }
  for (const path of ['/mcp', '/api/settings/credentials', 'https://external.example/', '/api/mcp/document?scope=other']) {
    await assert.rejects(callCanvasSession(f.identity, 'canvas_native_request', { path }), { code: 'SESSION_TOOL_DENIED' });
  }
  const reply = await callCanvasSession(f.identity, 'canvas_native_request', { path: '/api/mcp/document' });
  assert.equal(reply._meta.nativeHttp.status, 200);
  assert.equal(JSON.parse(Buffer.from(reply._meta.nativeHttp.body, 'base64')).documentId, 'document-a');
  const originalError = await callCanvasSession(f.identity, 'canvas_comment_update', { commentId: 'missing', status: 'resolved' });
  assert.deepEqual(originalError, { content: [{ type: 'text', text: 'Comment was not found.' }], isError: true, structuredContent: { code: 'COMMENT_NOT_FOUND' } });
});

test('ambiguous timeout marks a mutation uncertain and dispatches it only once', async t => {
  const f = await owner(t);
  await assert.rejects(callCanvasSession({ ...f.identity, timeoutMs: 80 }, 'canvas_comment_create', { text: 'delay-ack' }),
    error => error.code === 'UNCERTAIN_WRITE' && error.uncertain === true);
  const after = await callCanvasSession(f.identity, 'canvas_status');
  assert.equal(after.structuredContent.version, 1);
  const inspect = once(f.child, 'message'); f.child.send('inspect');
  const [state] = await inspect;
  assert.equal(state.events.filter(event => event.name === 'canvas_comment_create').length, 1);
  await assert.rejects(callCanvasSession(f.identity, 'canvas_comment_create', { text: 'throw-after-write' }),
    error => error.code === 'UNCERTAIN_WRITE' && error.uncertain === true);
  assert.equal((await callCanvasSession(f.identity, 'canvas_status')).structuredContent.version, 2);
  await assert.rejects(callCanvasSession(f.identity, 'canvas_comment_create', { text: 'throw-coded-after-write' }),
    error => error.code === 'UNCERTAIN_WRITE' && error.uncertain === true);
  assert.equal((await callCanvasSession(f.identity, 'canvas_status')).structuredContent.version, 3);
});

test('same-owner validation has the same allowlist and mutation classification without HTTP', () => {
  assert.deepEqual(validateCanvasSessionOperation('open_canvas', {}), { mutation: false });
  assert.deepEqual(validateCanvasSessionOperation('canvas_native_request', { path: '/api/mcp/document' }), { mutation: false });
  assert.deepEqual(validateCanvasSessionOperation('canvas_native_request', { path: '/api/mcp/document', method: 'POST', body: '{}' }), { mutation: true });
  for (const name of ['canvas_document_import', 'canvas_comment_create', 'canvas_comment_update', 'canvas_save',
    'canvas_checkpoint', 'canvas_detach_source', 'canvas_codegen_prepare', 'canvas_codegen_cancel']) {
    assert.deepEqual(validateCanvasSessionOperation(name, {}), { mutation: true });
  }
  assert.throws(() => validateCanvasSessionOperation('batch_design', {}), { code: 'SESSION_TOOL_DENIED' });
  assert.throws(() => validateCanvasSessionOperation('open_canvas', { filePath: '/other.op' }), { code: 'SESSION_TOOL_DENIED' });
});

test('raw authenticated requests cannot bypass allowlists or attach a different identity', async t => {
  const f = await owner(t), { value } = await descriptor(f);
  const endpoint = `http://127.0.0.1:${value.port}/canvas-session`;
  const post = (body, headers = {}) => fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json',
    Authorization: `Bearer ${value.token}`, ...headers }, body: JSON.stringify(body) });
  const request = { sessionId: f.sessionId, name: 'open_canvas', arguments: {} };
  assert.equal((await post(request, { Origin: 'https://untrusted.example' })).status, 403);
  assert.equal((await post(request, { Origin: '' })).status, 403);
  // Fetch can normalize Host; send the boundary probe as a real HTTP header.
  const wrongHost = await new Promise((resolve, reject) => {
    const body = JSON.stringify(request);
    const req = http.request(endpoint, { method: 'POST', headers: { Host: 'foreign.example',
      Authorization: `Bearer ${value.token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject); req.end(body);
  });
  assert.equal(wrongHost, 403);
  assert.equal((await post(request, { Authorization: 'Bearer wrong' })).status, 403);
  assert.equal((await post({ ...request, sessionId: randomUUID() })).status, 400);
  assert.equal((await post({ ...request, name: 'batch_design' })).status, 403);
  assert.equal((await post({ ...request, arguments: { filePath: '/foreign.op' } })).status, 403);
  assert.equal((await post({ ...request, name: 'canvas_native_request', arguments: { path: '/api/settings/credentials' } })).status, 403);
});

test('private registry rejects unsafe descriptors and closes without erasing another owner', async t => {
  const projectRoot = await directory(t), registryDir = join(projectRoot, 'registry'), sessionId = randomUUID();
  const broker = await startCanvasSessionBroker({ projectRoot, registryDir, sessionId, dispatch: async () => result({ ok: true }) });
  t.after(() => broker.close());
  const identity = { ...broker.identity, registryDir }, { value, path } = await descriptor({ registryDir, sessionId });
  await assert.rejects(startCanvasSessionBroker({ projectRoot, registryDir, sessionId, dispatch: async () => result({ wrong: true }) }), { code: 'SESSION_ALREADY_EXISTS' });
  assert.deepEqual(await callCanvasSession(identity, 'canvas_status'), result({ ok: true }));
  if (process.platform !== 'win32') {
    await chmod(path, 0o644);
    await assert.rejects(callCanvasSession(identity, 'canvas_status'), { code: 'UNSAFE_SESSION_REGISTRY' });
    await chmod(path, 0o600);
    const target = join(projectRoot, 'symlink-target'); await writeFile(target, JSON.stringify(value), { mode: 0o600 });
    await rm(path); await symlink(target, path);
    await assert.rejects(callCanvasSession(identity, 'canvas_status'), { code: 'UNSAFE_SESSION_REGISTRY' });
    await rm(path); await writeFile(path, JSON.stringify(value), { mode: 0o600 });
  }
  const replacement = { ...value, token: 'X'.repeat(43) };
  await writeFile(path, JSON.stringify(replacement), { mode: 0o600 });
  await broker.close(); await broker.close();
  assert.equal(JSON.parse(await readFile(path, 'utf8')).token, replacement.token);
});

test('a closed owner leaves no attachable descriptor and a read failure is not a mutation warning', async t => {
  const projectRoot = await directory(t), registryDir = join(projectRoot, 'registry'), sessionId = randomUUID();
  const broker = await startCanvasSessionBroker({ projectRoot, registryDir, sessionId, dispatch: async () => result({ ok: true }) });
  const identity = { ...broker.identity, registryDir }, { value, path } = await descriptor({ registryDir, sessionId });
  await broker.close();
  await assert.rejects(callCanvasSession(identity, 'canvas_status'), { code: 'SESSION_NOT_FOUND' });
  await writeFile(path, JSON.stringify(value), { mode: 0o600 });
  await assert.rejects(callCanvasSession(identity, 'canvas_status'), error => error.code === 'SESSION_UNAVAILABLE' && error.uncertain !== true);
});
