import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { resolveRuntime } from '../plugins/openpencil/scripts/editor-runtime.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
let outputRoot = join(repo, 'artifacts', 'session-smoke'), runtimeRoot;
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--output' && process.argv[i + 1]) outputRoot = resolve(process.argv[++i]);
  else if (process.argv[i] === '--runtime' && process.argv[i + 1]) runtimeRoot = resolve(process.argv[++i]);
  else throw Error('Usage: node scripts/session-smoke.mjs [--runtime DIR] [--output DIR]');
}
await mkdir(outputRoot, { recursive: true });
const output = await mkdtemp(join(outputRoot, 'run-'));
const projectRoot = join(output, 'project'), stateRoot = join(output, 'state');
await mkdir(projectRoot);
const runtime = await resolveRuntime(runtimeRoot);
const env = { ...process.env, OPENPENCIL_EDITOR_RUNTIME_DIR: runtime.root, OPENPENCIL_CODEX_STATE_DIR: stateRoot };
delete env.OPENPENCIL_MCP_PORT;
const clients = [], calls = [], report = {
  ok: false, output, projectRoot, stateRoot, runtime: { root: runtime.root, version: runtime.version },
  startedAt: new Date().toISOString(), calls,
};
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const value = result => result.structuredContent ?? JSON.parse(result.content.find(item => item.type === 'text').text);

class Bridge {
  constructor(role) {
    this.role = role; this.nextId = 0; this.pending = new Map(); this.stderrBytes = 0;
    this.child = spawn(process.execPath, [join(repo, 'plugins/openpencil/scripts/mcp-bridge.mjs')],
      { cwd: projectRoot, env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.pid = this.child.pid; clients.push(this);
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', line => {
      let message;
      try { message = JSON.parse(line); }
      catch { this.rejectPending(Error(`${role} emitted invalid JSON-RPC.`)); return; }
      if (message.method && Object.hasOwn(message, 'id')) {
        // No roots capability was advertised. An unexpected server request is explicit failure.
        this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: message.id,
          error: { code: -32601, message: 'This smoke client does not provide roots.' } }) + '\n');
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id); clearTimeout(pending.timer);
      message.error ? pending.reject(Error(message.error.message)) : pending.resolve(message.result);
    });
    // Count diagnostics without persisting possible daemon credentials or private content.
    this.child.stderr.on('data', bytes => { this.stderrBytes += bytes.length; });
    this.child.on('error', error => this.rejectPending(error));
    this.closed = new Promise(resolveClosed => this.child.once('close', (code, signal) => {
      this.exit = { code, signal }; this.rejectPending(Error(`${role} bridge closed.`)); resolveClosed();
    }));
  }
  rejectPending(error) {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }
  rpc(method, params = {}) {
    if (this.exit) throw Error(`${this.role} bridge is closed.`);
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(Error(`${this.role} ${method} timed out; request was not retried.`));
      }, 45_000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  async initialize() {
    await this.rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {},
      clientInfo: { name: `session-smoke-${this.role}`, version: '1' } });
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  }
  async tool(name, args = {}, { allowError = false } = {}) {
    const entry = { role: this.role, pid: this.pid, name, ...(name === 'canvas_session_call' && { operation: args.name }) };
    calls.push(entry);
    const started = Date.now(), result = await this.rpc('tools/call', { name, arguments: args });
    entry.ms = Date.now() - started; entry.isError = Boolean(result.isError);
    if (result.isError && !allowError) {
      entry.code = result.structuredContent?.code;
      throw Error(`${this.role} ${name}: ${result.content?.find(item => item.type === 'text')?.text || 'Tool failed.'}`);
    }
    return result;
  }
  async close() {
    if (this.exit) return;
    this.child.stdin.end();
    const timer = setTimeout(() => { this.forcedClose = true; this.child.kill('SIGTERM'); }, 10_000);
    const killTimer = setTimeout(() => this.child.kill('SIGKILL'), 15_000);
    try { await this.closed; } finally { clearTimeout(timer); clearTimeout(killTimer); }
  }
}

function node(document, id) {
  const stack = [...(document.children || []), ...(document.pages || [])];
  while (stack.length) {
    const item = stack.pop(); if (item.id === id) return item;
    stack.push(...(item.children || []));
  }
  throw Error(`Fixture node ${id} was not found.`);
}
async function native(client, identity, method = 'GET', body) {
  const result = await client.tool('canvas_session_call', { ...identity, name: 'canvas_native_request',
    arguments: { path: '/api/mcp/document', method, ...(body && { body: JSON.stringify(body) }) } });
  const response = result._meta?.nativeHttp;
  assert.ok(response, 'Private native HTTP result must reach the App.');
  const data = JSON.parse(Buffer.from(response.body, 'base64').toString('utf8'));
  return { status: response.status, data };
}
async function screenshot(client, name) {
  const result = await client.tool('get_screenshot', { nodeId: 'session-board' });
  const image = result.content.find(item => item.type === 'image' && item.mimeType === 'image/png');
  assert.ok(image, 'Native get_screenshot must return PNG.');
  const bytes = Buffer.from(image.data, 'base64');
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const file = join(output, name); await writeFile(file, bytes);
  return { file, bytes: bytes.length, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), sha256: hash(bytes) };
}

const filePath = join(projectRoot, 'fixture.op');
const fill = color => [{ type: 'solid', color }];
const fixture = { version: '0.8.5', children: [{ id: 'session-board', type: 'frame', name: 'Shared session',
  x: 40, y: 40, width: 760, height: 360, fill: fill('#F4F6FA'), children: [
    { id: 'session-mark', type: 'rectangle', x: 40, y: 38, width: 36, height: 36, cornerRadius: 9, fill: fill('#316CF4') },
    { id: 'session-brand', type: 'text', x: 92, y: 44, width: 220, height: 28, content: 'OpenBrush',
      fontFamily: 'Inter', fontSize: 21, fontWeight: 600, fill: fill('#1A2233') },
    { id: 'session-title', type: 'text', x: 40, y: 128, width: 680, height: 56, content: 'Two processes. One canvas.',
      fontFamily: 'Inter', fontSize: 30, fontWeight: 600, fill: fill('#1A2233') },
    { id: 'session-note', type: 'text', x: 42, y: 205, width: 660, height: 30, content: 'App and Codex share an editable native document.',
      fontFamily: 'Inter', fontSize: 17, fill: fill('#68758A') },
    { id: 'session-status', type: 'text', x: 42, y: 292, width: 660, height: 24, content: 'Isolated end-to-end acceptance',
      fontFamily: 'Inter', fontSize: 13, fill: fill('#316CF4') },
  ] }] };
await writeFile(filePath, JSON.stringify(fixture, null, 2) + '\n', { flag: 'wx' });
let failure;
try {
  const app = new Bridge('app'), owner = new Bridge('owner');
  await Promise.all([app.initialize(), owner.initialize()]);
  assert.notEqual(app.pid, owner.pid);
  const unbound = await app.tool('open_canvas', {}, { allowError: true });
  assert.equal(unbound.isError, true);
  assert.equal(unbound.structuredContent?.code, 'PROJECT_ROOT_REQUIRED');
  report.unboundApp = { code: unbound.structuredContent.code, message: unbound.content[0].text };
  const launch = value(await app.tool('canvas_launch_prepare'));
  assert.equal(value(await app.tool('canvas_launch_poll', { launchId: launch.launchId })).state, 'pending');
  const opened = await owner.tool('open_canvas', { projectRoot, filePath, launchId: launch.launchId });
  const ready = value(await app.tool('canvas_launch_poll', { launchId: launch.launchId }));
  assert.equal(ready.state, 'ready');
  const identity = ready.canvasSession, originalId = opened.structuredContent.documentId;
  assert.deepEqual(identity, opened._meta.canvasSession);
  const attached = await app.tool('canvas_session_call', { ...identity, name: 'open_canvas', arguments: {} });
  assert.equal(attached.structuredContent.documentId, originalId);
  assert.equal(attached._meta.canvas.token, opened._meta.canvas.token);
  assert.ok(attached._meta.canvas.token);
  assert.ok(!JSON.stringify(attached.content).includes(attached._meta.canvas.token));
  report.attach = { identity, documentId: originalId, launchId: launch.launchId, privateTokenShared: true, tokenAbsentFromContent: true };
  const before = await native(app, identity); assert.equal(before.status, 200);
  const replacement = structuredClone(before.data.document), appText = 'Edited through the App session.';
  node(replacement, 'session-title').content = appText;
  const write = await native(app, identity, 'POST', { document: replacement, baseVersion: before.data.version,
    activePageIndex: before.data.activePageIndex ?? 0, preserveAuthoredGeometry: true });
  assert.equal(write.status, 200); assert.equal(write.data.ok, true);
  const ownerStatus = value(await owner.tool('canvas_status'));
  assert.equal(ownerStatus.version, write.data.version);
  assert.ok(JSON.stringify(await owner.tool('batch_get', { nodeIds: ['session-title'], readDepth: 1 })).includes(appText));
  const appSave = value(await app.tool('canvas_session_call', { ...identity, name: 'canvas_save', arguments: {} }));
  assert.equal(node(JSON.parse(await readFile(filePath, 'utf8')), 'session-title').content, appText);
  report.appEdit = { before: before.data.version, after: write.data.version, ownerVersion: ownerStatus.version, savedVersion: appSave.version, text: appText };
  const modelText = 'Codex and App. One native canvas.';
  await owner.tool('update_node', { nodeId: 'session-title', data: { content: modelText } });
  const modelRead = await native(app, identity); assert.equal(modelRead.status, 200);
  assert.equal(node(modelRead.data.document, 'session-title').content, modelText);
  assert.ok(modelRead.data.version > write.data.version);
  report.modelEdit = { before: write.data.version, after: modelRead.data.version, appText: modelText };
  const created = value(await app.tool('canvas_session_call', { ...identity, name: 'canvas_document_open',
    arguments: { create: true, docJson: JSON.stringify(modelRead.data.document) } }));
  assert.notEqual(created.documentId, originalId);
  const newAttach = await app.tool('canvas_session_call', { ...identity, name: 'open_canvas', arguments: {} });
  assert.deepEqual(newAttach._meta.canvasSession, identity);
  assert.equal(newAttach.structuredContent.documentId, created.documentId);
  const empty = await native(app, identity);
  assert.equal(empty.data.document.children.length, 0);
  const switched = value(await app.tool('canvas_session_call', { ...identity, name: 'canvas_document_open',
    arguments: { documentId: originalId, docJson: JSON.stringify(empty.data.document) } }));
  assert.equal(switched.documentId, originalId);
  const returned = await native(app, identity);
  assert.equal(node(returned.data.document, 'session-title').content, modelText);
  const finalAttach = await app.tool('canvas_session_call', { ...identity, name: 'open_canvas', arguments: {} });
  assert.deepEqual(finalAttach._meta.canvasSession, identity);
  report.switch = { originalId, createdId: created.documentId, createdVersion: created.version,
    returnedVersion: returned.data.version, stableSession: true, unsavedModelEditRecovered: true };
  const saved = value(await app.tool('canvas_session_call', { ...identity, name: 'canvas_save', arguments: {} }));
  const source = await readFile(filePath);
  assert.equal(node(JSON.parse(source), 'session-title').content, modelText);
  report.save = { filePath, version: saved.version, sha256: hash(source) };
  report.preview = await screenshot(owner, 'preview.png');
  await writeFile(join(output, 'final-document.json'), JSON.stringify(returned.data, null, 2) + '\n');
  await app.close(); await owner.close();
  assert.equal(owner.exit.code, 0); assert.equal(app.exit.code, 0);
  // A fresh project has no catalog recovery that could conceal a broken source save.
  const reopenedProject = join(output, 'reopened-project'), reopenedFile = join(reopenedProject, 'fixture.op');
  await mkdir(reopenedProject);
  await writeFile(reopenedFile, source, { flag: 'wx' });
  const reopened = new Bridge('reopened-owner'); await reopened.initialize();
  const reopenedResult = await reopened.tool('open_canvas', { projectRoot: reopenedProject, filePath: reopenedFile });
  assert.notEqual(reopenedResult._meta.canvasSession.sessionId, identity.sessionId);
  const reopenedRead = await native(reopened, reopenedResult._meta.canvasSession);
  assert.equal(node(reopenedRead.data.document, 'session-title').content, modelText);
  assert.equal(node(reopenedRead.data.document, 'session-board').width, 760);
  assert.equal(hash(await readFile(filePath)), report.save.sha256);
  assert.equal(hash(await readFile(reopenedFile)), report.save.sha256);
  report.reopen = { pid: reopened.pid, documentId: reopenedResult.structuredContent.documentId,
    projectRoot: reopenedProject, filePath: reopenedFile, freshProjectWithoutRecovery: true,
    version: reopenedRead.data.version, text: modelText, sameSavedHash: true };
  report.reopenedPreview = await screenshot(reopened, 'reopened-preview.png');
  assert.equal(report.preview.sha256, report.reopenedPreview.sha256);
  report.ok = true;
} catch (error) {
  failure = error; report.error = { name: error.name, message: error.message };
} finally {
  await Promise.all(clients.map(client => client.close()));
  report.processes = clients.map(client => ({ role: client.role, pid: client.pid, ...client.exit,
    forcedClose: Boolean(client.forcedClose), stderrBytes: client.stderrBytes }));
  if (report.processes.some(client => client.code !== 0 || client.forcedClose)) report.ok = false;
  report.finishedAt = new Date().toISOString();
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ ok: report.ok, output, report: join(output, 'report.json'),
    ...(report.error && { error: report.error }) }));
}
if (failure || !report.ok) process.exitCode = 1;
