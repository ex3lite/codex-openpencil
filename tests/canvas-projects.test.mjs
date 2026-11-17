import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachProjectSession, bindProject, detachProjectDocument, importProjectDocument,
  projectDocuments, projectSummary, switchProjectDocument } from '../plugins/openpencil/scripts/canvas-projects.mjs';
import { atomicSave } from '../plugins/openpencil/scripts/editor-session.mjs';
import { diskDocument } from '../plugins/openpencil/scripts/document-format.mjs';

const code = expected => error => error.code === expected;
const doc = name => ({ version: '0.8.5', children: [{ id: 'one', type: 'text', name }] });
async function fixture(t) {
  const temporary = await mkdtemp(join(tmpdir(), 'canvas-projects-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const base = await realpath(temporary), a = join(base, 'project'), b = join(base, 'project-other');
  await mkdir(a); await mkdir(b);
  const controller = { options: { projectRoot: a }, resets: [], resetDocumentServices() { this.resets.push(this.documentId); } };
  t.after(() => controller.releaseProjectLease?.());
  const source = join(a, 'original.op'); await writeFile(source, JSON.stringify(doc('original')));
  const binding = await bindProject(controller, { filePath: source });
  const state = { document: doc('original'), version: 4, activePageIndex: 0, preserveAuthoredGeometry: true };
  const requests = [];
  let mode = 'ok';
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks)); requests.push(body);
    if (mode === 'conflict' || body.baseVersion !== state.version) {
      res.writeHead(409, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, version: state.version })); return;
    }
    state.document = body.document; state.version++; state.activePageIndex = body.activePageIndex;
    state.preserveAuthoredGeometry = body.preserveAuthoredGeometry;
    res.writeHead(mode === 'uncertain' ? 500 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: mode !== 'uncertain', version: state.version }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const session = controller.session = { draft: join(base, 'runtime-recovery.op'), source: null, baseline: null,
    port: server.address().port, token: 'fixture-token', saves: 0, checkpoints: 0,
    assertLive() {}, document: async () => structuredClone(state),
    async checkpoint() { this.checkpoints++; await writeFile(this.draft, JSON.stringify(diskDocument(state))); return { recoveryPath: this.draft, version: state.version }; },
    async save({ filePath }) { this.saves++; this.baseline = await atomicSave(filePath, JSON.stringify(diskDocument(state)), filePath === this.source ? this.baseline : null); this.source = filePath; await this.checkpoint(); return { filePath, sha256: this.baseline, version: state.version }; },
  };
  attachProjectSession(controller);
  return { base, a, b, controller, session, source, binding, state, requests,
    setMode: value => { mode = value; }, snapshot: () => JSON.stringify(diskDocument(state)) };
}

async function addTarget(f, name = 'target') {
  const path = join(f.a, name + '.op'); await writeFile(path, JSON.stringify(doc(name)));
  return f.controller.project.registerDocument({ filePath: path });
}

test('binding requires an explicit or MCP-host root and refuses rebinding a live canvas', async t => {
  const f = await fixture(t);
  await assert.rejects(bindProject({ options: { cwd: f.a } }), code('PROJECT_ROOT_REQUIRED'));
  await assert.rejects(bindProject(f.controller, { projectRoot: f.b }), code('PROJECT_ALREADY_BOUND'));
  assert.equal((await bindProject(f.controller, {})).documentId, f.binding.documentId);
  assert.deepEqual(projectSummary(f.controller), { projectId: f.controller.project.projectId, projectRoot: f.a, name: 'project' });
  assert.equal(f.session.source, f.source);
  assert.equal(f.session.baseline, f.binding.baseline);
});

test('wrapped checkpoint persists project recovery and a new session restores the true source baseline', async t => {
  const f = await fixture(t);
  f.state.document = doc('unsaved');
  const saved = await f.session.checkpoint();
  assert.equal(saved.documentId, f.controller.documentId);
  assert.ok(saved.recoveryPath.startsWith(join(f.a, '.openpencil', 'recovery')));
  const next = { options: { projectRoot: f.a } };
  await f.controller.releaseProjectLease();
  const reopened = await bindProject(next, { documentId: f.controller.documentId });
  t.after(() => next.releaseProjectLease?.());
  assert.equal(reopened.sourcePath, f.source);
  assert.equal(reopened.baseline, f.binding.baseline);
  assert.equal(JSON.parse(await readFile(reopened.initialFilePath, 'utf8')).children[0].name, 'unsaved');
  assert.equal(f.session.checkpoints, 1);
});

test('save validates project ownership before touching a source and persists one recovery', async t => {
  const f = await fixture(t);
  await assert.rejects(f.session.save({ filePath: join(f.b, 'outside.op') }), code('DOCUMENT_OUTSIDE_PROJECT'));
  assert.equal(f.session.saves, 0);
  f.state.document = doc('edited');
  const result = await f.session.save({ filePath: join(f.a, 'designs', 'saved.op') });
  assert.equal(f.session.saves, 1); assert.equal(f.session.checkpoints, 1);
  assert.equal(result.filePath, join(f.a, 'designs', 'saved.op'));
  assert.equal((await f.controller.project.getDocument(f.controller.documentId)).path, result.filePath);
  assert.equal(JSON.parse(await readFile(f.source, 'utf8')).children[0].name, 'original');
  assert.equal((await f.controller.project.reopenDocument(f.controller.documentId)).baseline, f.session.baseline);
});

test('switch rejects a stale UI snapshot before checkpoint or document mutation', async t => {
  const f = await fixture(t), target = await addTarget(f);
  await assert.rejects(switchProjectDocument(f.controller, { documentId: target.id, docJson: JSON.stringify(doc('stale')) }), code('DOCUMENT_SNAPSHOT_STALE'));
  await assert.rejects(switchProjectDocument(f.controller, { documentId: target.id }), code('DOCUMENT_SNAPSHOT_REQUIRED'));
  assert.equal(f.requests.length, 0); assert.equal(f.session.checkpoints, 0);
  assert.equal(f.controller.documentId, f.binding.documentId);
});

test('switch checkpoints the old document, sends exactly one versioned replacement, then rebinds', async t => {
  const f = await fixture(t), target = await addTarget(f);
  f.state.document = doc('old unsaved edits');
  const result = await switchProjectDocument(f.controller, { documentId: target.id, docJson: f.snapshot() });
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].baseVersion, 4);
  assert.equal(f.requests[0].document.children[0].name, 'target');
  assert.equal(f.controller.documentId, target.id); assert.equal(f.session.source, target.path);
  assert.equal(result.filePath, target.path); assert.equal(result.version, 5);
  assert.deepEqual(f.controller.resets, [target.id]);
  const old = await f.controller.project.getDocument(f.binding.documentId);
  assert.equal(JSON.parse(await readFile(old.recoveryPath, 'utf8')).children[0].name, 'old unsaved edits');
  const active = await f.controller.project.getDocument(target.id);
  assert.equal(JSON.parse(await readFile(active.recoveryPath, 'utf8')).children[0].name, 'target');
});

test('a rejected replacement leaves the current binding untouched and is never retried', async t => {
  const f = await fixture(t), target = await addTarget(f); f.setMode('conflict');
  await assert.rejects(switchProjectDocument(f.controller, { documentId: target.id, docJson: f.snapshot() }), code('VERSION_CONFLICT'));
  assert.equal(f.requests.length, 1); assert.equal(f.controller.documentId, f.binding.documentId);
  assert.equal(f.session.source, f.source); assert.equal(f.controller.projectSwitchUncertain, undefined);
  assert.deepEqual([...f.controller.projectWriterLeases.keys()], [f.binding.documentId]);
});

test('an ambiguous applied replacement freezes save/checkpoint and preserves the old project draft', async t => {
  const f = await fixture(t), target = await addTarget(f); f.setMode('uncertain');
  await assert.rejects(switchProjectDocument(f.controller, { documentId: target.id, docJson: f.snapshot() }), code('PROJECT_SWITCH_UNCERTAIN'));
  assert.equal(f.requests.length, 1); assert.equal(f.state.document.children[0].name, 'target');
  await assert.rejects(f.session.checkpoint(), code('PROJECT_SWITCH_UNCERTAIN'));
  await assert.rejects(f.session.save(), code('PROJECT_SWITCH_UNCERTAIN'));
  assert.equal(f.session.saves, 0);
  const old = await f.controller.project.getDocument(f.binding.documentId);
  assert.equal(JSON.parse(await readFile(old.recoveryPath, 'utf8')).children[0].name, 'original');
  assert.equal((await projectDocuments(f.controller)).switchUncertain, true);
  assert.deepEqual([...f.controller.projectWriterLeases.keys()].sort(), [f.binding.documentId, target.id].sort());
});

test('active agents block a catalog switch before any changes', async t => {
  const f = await fixture(t), target = await addTarget(f);
  f.controller.agents = { status: () => ({ agents: [{ id: 'busy' }] }) };
  await assert.rejects(switchProjectDocument(f.controller, { documentId: target.id, docJson: f.snapshot() }), code('PROJECT_AGENTS_ACTIVE'));
  assert.equal(f.requests.length, 0); assert.equal(f.session.checkpoints, 0);
});

test('native New/Open quiesces agents and preserves the old daemon before allocating a new draft', async t => {
  const f = await fixture(t);
  f.controller.agents = { status: () => ({ agents: [{ id: 'busy' }] }) };
  f.controller.quiesceDocumentAgents = async () => { f.state.document = doc('last agent edit'); };
  const result = await detachProjectDocument(f.controller);
  assert.equal(result.filePath, null); assert.notEqual(result.documentId, f.binding.documentId);
  assert.equal(f.session.source, null); assert.equal(f.session.baseline, null);
  const old = await f.controller.project.getDocument(f.binding.documentId);
  assert.equal(JSON.parse(await readFile(old.recoveryPath, 'utf8')).children[0].name, 'last agent edit');
  f.state.document = doc('new local document');
  await f.session.checkpoint();
  const draft = await f.controller.project.getDocument(result.documentId);
  assert.equal(JSON.parse(await readFile(draft.recoveryPath, 'utf8')).children[0].name, 'new local document');
  assert.equal(JSON.parse(await readFile(old.recoveryPath, 'utf8')).children[0].name, 'last agent edit');
});

test('untitled Save creates a file directly in this project root', async t => {
  const f = await fixture(t); await detachProjectDocument(f.controller);
  f.state.document = doc('new draft');
  const saved = await f.session.save();
  assert.ok(saved.filePath.startsWith(join(f.a, 'untitled-')));
  assert.equal(JSON.parse(await readFile(saved.filePath, 'utf8')).children[0].name, 'new draft');
});

test('import copies into this project, uses a new name on collision and keeps the current document', async t => {
  const f = await fixture(t), foreign = join(f.b, 'external.op');
  await writeFile(foreign, JSON.stringify(doc('foreign')));
  const first = await importProjectDocument(f.controller, { sourcePath: foreign });
  const second = await importProjectDocument(f.controller, { sourcePath: foreign });
  assert.equal(first.imported.path, join(f.a, 'external.op'));
  assert.notEqual(first.imported.path, second.imported.path);
  assert.equal(first.documentId, f.binding.documentId); assert.equal(f.requests.length, 0);
  await writeFile(first.imported.path, JSON.stringify(doc('copy changed')));
  assert.equal(JSON.parse(await readFile(foreign, 'utf8')).children[0].name, 'foreign');
});

test('create explicitly creates and opens an empty project document', async t => {
  const f = await fixture(t);
  const result = await switchProjectDocument(f.controller, { create: true, name: 'New design', docJson: f.snapshot() });
  assert.notEqual(result.documentId, f.binding.documentId);
  assert.equal(f.session.source, null); assert.equal(f.session.baseline, null);
  assert.deepEqual(f.state.document.children, []); assert.equal(f.requests.length, 1);
  assert.equal((await f.controller.project.getDocument(result.documentId)).name, 'New design');
});

test('two independent sessions cannot overwrite one document recovery and reopen after owner close', async t => {
  const f = await fixture(t);
  f.state.document = doc('session A unsaved'); await f.session.checkpoint();
  const second = { options: { projectRoot: f.a } };
  t.after(() => second.releaseProjectLease?.());
  await assert.rejects(bindProject(second, { filePath: f.source }), code('PROJECT_DOCUMENT_IN_USE'));
  assert.equal(second.project, undefined);
  const firstRecovery = await f.controller.project.getDocument(f.controller.documentId);
  assert.equal(JSON.parse(await readFile(firstRecovery.recoveryPath, 'utf8')).children[0].name, 'session A unsaved');
  await f.controller.releaseProjectLease();
  const binding = await bindProject(second, { filePath: f.source });
  assert.equal(binding.documentId, f.binding.documentId);
  assert.equal(JSON.parse(await readFile(binding.initialFilePath, 'utf8')).children[0].name, 'session A unsaved');
  const secondState = JSON.parse(await readFile(binding.initialFilePath, 'utf8'));
  secondState.children[0].name = 'session B continued';
  second.session = { source: binding.sourcePath, baseline: binding.baseline, draft: join(f.base, 'second-session.op'),
    assertLive() {}, async checkpoint() { await writeFile(this.draft, JSON.stringify(secondState)); return {}; }, async save() {} };
  attachProjectSession(second); await second.session.checkpoint();
  await assert.rejects(f.session.checkpoint(), code('PROJECT_WRITER_REQUIRED'));
  assert.equal(JSON.parse(await readFile(firstRecovery.recoveryPath, 'utf8')).children[0].name, 'session B continued');
});

test('a successful switch releases the prior writer and keeps only the target lease', async t => {
  const f = await fixture(t), target = await addTarget(f);
  await switchProjectDocument(f.controller, { documentId: target.id, docJson: f.snapshot() });
  assert.deepEqual([...f.controller.projectWriterLeases.keys()], [target.id]);
  const second = { options: { projectRoot: f.a } }; t.after(() => second.releaseProjectLease?.());
  await bindProject(second, { documentId: f.binding.documentId });
  await assert.rejects(bindProject({ options: { projectRoot: f.a } }, { documentId: target.id }), code('PROJECT_DOCUMENT_IN_USE'));
});

test('a target already owned by another session is rejected before checkpoint or CAS', async t => {
  const f = await fixture(t), target = await addTarget(f);
  const second = { options: { projectRoot: f.a } }; t.after(() => second.releaseProjectLease?.());
  await bindProject(second, { documentId: target.id });
  await assert.rejects(switchProjectDocument(f.controller, { documentId: target.id, docJson: f.snapshot() }), code('PROJECT_DOCUMENT_IN_USE'));
  assert.equal(f.requests.length, 0); assert.equal(f.session.checkpoints, 0);
  assert.deepEqual([...f.controller.projectWriterLeases.keys()], [f.binding.documentId]);
});

test('reselecting the current document preserves the saved source in the UI response', async t => {
  const f = await fixture(t); await f.session.checkpoint();
  const result = await switchProjectDocument(f.controller, { documentId: f.controller.documentId });
  assert.equal(result.filePath, f.source); assert.equal(result.version, f.state.version);
  assert.equal(result.recoveryPath, (await f.controller.project.getDocument(f.controller.documentId)).recoveryPath);
  assert.equal(f.requests.length, 0);
});

test('default opening resumes a registered document in this project, without adding an empty draft', async t => {
 const f=await fixture(t);await f.session.checkpoint();await f.controller.releaseProjectLease();
 const next={options:{projectRoot:f.a}};t.after(()=>next.releaseProjectLease?.());
 const opened=await bindProject(next,{});
 assert.equal(opened.documentId,f.binding.documentId);
 assert.equal((await next.project.listDocuments()).documents.length,1);
});
