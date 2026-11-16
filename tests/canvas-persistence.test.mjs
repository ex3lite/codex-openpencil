import http from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CanvasController } from '../plugins/openpencil/scripts/canvas-controller.mjs';
import { bindProject, attachProjectSession } from '../plugins/openpencil/scripts/canvas-projects.mjs';
import { CanvasPersistence } from '../plugins/openpencil/scripts/canvas-persistence.mjs';
import { CanvasHistory } from '../plugins/openpencil/scripts/canvas-history.mjs';
import { EditorSession } from '../plugins/openpencil/scripts/editor-session.mjs';
import { diskDocument } from '../plugins/openpencil/scripts/document-format.mjs';

const doc = name => ({ version: '0.8.5', children: [{ id: 'one', type: 'text', name }] });
async function fixture(t, { source = true } = {}) {
  const path = await mkdtemp(join(tmpdir(), 'autosave-'));
  const root = await realpath(path);
  const file = join(root, 'design.op');
  if (source) await writeFile(file, JSON.stringify(doc('original')));
  const controller = new CanvasController({ projectRoot: root });
  const binding = await bindProject(controller, source ? { filePath: file } : {});
  const state = { document: doc('original'), version: 0, activePageIndex: 0, preserveAuthoredGeometry: true };
  const session = controller.session = Object.assign(new EditorSession(), { dir: root, draft: join(root, 'runtime.op'),
    source: binding.sourcePath, baseline: binding.baseline, document: async () => structuredClone(state), closed: false });
  attachProjectSession(controller);
  const persistence = controller.persistence = new CanvasPersistence(controller, { debounceMs: 10, historyMs: 20 });
  t.after(async () => {
    persistence.dispose();
    await controller.queue; await persistence.queue;
    await controller.releaseProjectLease();
    await rm(path, { recursive: true, force: true });
  });
  await persistence.initialize();
  return { controller, persistence, session, state, root, file, snapshot: () => JSON.stringify(diskDocument(state)) };
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('draft automatically becomes a project .op and saves native and agent checkpoint edits', async t => {
  const f = await fixture(t, { source: false });
  assert.equal(f.persistence.status().state, 'saved');
  assert.match(f.session.source, /untitled-.*\.op$/);
  f.state.document = doc('native edit'); f.state.version++;
  await f.session.checkpoint(); await delay(80); await f.controller.queue;
  assert.equal(JSON.parse(await readFile(f.session.source)).children[0].name, 'native edit');
  f.state.document = doc('agent edit'); f.state.version++;
  await f.session.checkpoint(); await delay(80); await f.controller.queue;
  assert.equal(JSON.parse(await readFile(f.session.source)).children[0].name, 'agent edit');
});

test('rapid saves are grouped into one immutable history version with bounded retention', async t => {
  const f = await fixture(t);
  f.persistence.historyMs = 500;
  await f.persistence.boundary();
  const start = await f.persistence.list();
  const old = await f.persistence.history.read(start.entries[0].id);
  for (const name of ['one', 'two', 'three']) {
    f.state.document = doc(name); f.state.version++;
    await f.persistence.flush();
  }
  await f.persistence.boundary(); await f.controller.queue;
  const listed = await f.persistence.list();
  assert.equal(listed.entries.length, start.entries.length + 1);
  assert.equal(JSON.parse((await f.persistence.history.read(listed.entries[0].id)).bytes).children[0].name, 'three');
  assert.deepEqual((await f.persistence.history.read(old.entry.id)).bytes, old.bytes);
  const bounded = new CanvasHistory({ catalog: f.controller.project, documentId: f.controller.documentId, maxEntries: 3 });
  for (let i = 0; i < 6; i++) await bounded.record(JSON.stringify(doc(String(i))), { source: 'edit', version: i });
  assert.equal((await bounded.list()).entries.length, 3);
});

test('external file edits stop autosave and are never retried automatically', async t => {
  const f = await fixture(t);
  await writeFile(f.file, JSON.stringify(doc('external')));
  f.state.document = doc('local'); f.state.version++;
  await assert.rejects(f.persistence.flush(), error => error.code === 'SOURCE_CHANGED');
  assert.equal(f.persistence.status().state, 'error');
  const calls = f.session.save;
  f.session.save = () => { throw Error('must not retry'); };
  f.persistence.changed(); await delay(50);
  await assert.rejects(f.persistence.flush(), error => error.code === 'SOURCE_CHANGED');
  f.session.save = calls;
  assert.equal(JSON.parse(await readFile(f.file)).children[0].name, 'external');
});

test('a rejected UI snapshot writes nothing and a later distinct checkpoint can save', async t => {
  const f = await fixture(t);
  const original = await readFile(f.file, 'utf8');
  const stale = f.snapshot();
  f.state.document = doc('newer daemon edit'); f.state.version++;
  let writes = 0;
  const save = f.session.save.bind(f.session);
  f.session.save = async args => { writes++; return save(args); };
  await assert.rejects(f.persistence.flush({ docJson: stale }), { code: 'DOCUMENT_SNAPSHOT_STALE' });
  assert.equal(writes, 0);
  assert.equal(await readFile(f.file, 'utf8'), original);
  assert.equal(f.persistence.status().state, 'snapshot-rejected');
  assert.equal(f.persistence.status().recoverable, true);
  await f.session.checkpoint(); await delay(50); await f.controller.queue;
  assert.equal(writes, 0, 'a checkpoint of the same rejected version must not retry');
  f.state.document = doc('next deliberate edit'); f.state.version++;
  await f.session.checkpoint(); await delay(50); await f.controller.queue;
  assert.equal(writes, 1);
  assert.equal(JSON.parse(await readFile(f.file)).children[0].name, 'next deliberate edit');
  assert.equal(f.persistence.status().state, 'saved');
  assert.equal(f.persistence.status().code, undefined);
});

test('a fresh explicit UI snapshot can save after a rejected snapshot without another edit', async t => {
  const f = await fixture(t);
  const stale = f.snapshot();
  f.state.document = doc('latest edit'); f.state.version++;
  await assert.rejects(f.persistence.flush({ docJson: stale }), { code: 'DOCUMENT_SNAPSHOT_STALE' });
  await f.persistence.flush({ docJson: f.snapshot() });
  await f.persistence.boundary();
  assert.equal(JSON.parse(await readFile(f.file)).children[0].name, 'latest edit');
  assert.equal(f.persistence.status().state, 'saved');
});

test('an uncertain write stays stopped after later checkpoints and explicit snapshots', async t => {
  const f = await fixture(t);
  f.state.document = doc('local'); f.state.version++;
  let writes = 0;
  f.session.save = async () => { writes++; throw Object.assign(Error('write acknowledgement lost'), { code: 'UNCERTAIN_WRITE' }); };
  await assert.rejects(f.persistence.flush(), { code: 'UNCERTAIN_WRITE' });
  f.state.document = doc('later local edit'); f.state.version++;
  await f.session.checkpoint(); await delay(50); await f.controller.queue;
  await assert.rejects(f.persistence.flush({ docJson: f.snapshot() }), { code: 'UNCERTAIN_WRITE' });
  assert.equal(writes, 1);
  assert.equal(f.persistence.status().recoverable, false);
});

test('the second save guard rejects a concurrent edit before disk write without poisoning persistence', async t => {
  const f = await fixture(t);
  f.state.document = doc('first edit'); f.state.version++;
  const bytes = await readFile(f.file);
  let reads = 0;
  f.session.document = async () => {
    if (++reads === 2) { f.state.document = doc('concurrent edit'); f.state.version++; }
    return structuredClone(f.state);
  };
  await assert.rejects(f.persistence.flush({ docJson: f.snapshot() }), error =>
    error.code === 'DOCUMENT_SNAPSHOT_STALE' && error.writeAttempted === false);
  assert.deepEqual(await readFile(f.file), bytes);
  assert.equal(f.persistence.status().state, 'snapshot-rejected');
  await assert.rejects(f.persistence.flush(), { code: 'DOCUMENT_SNAPSHOT_STALE' });
  await f.persistence.flush({ docJson: f.snapshot() });
  await f.persistence.boundary();
  assert.equal(JSON.parse(await readFile(f.file)).children[0].name, 'concurrent edit');
});

test('history restore preserves current work, replaces once with CAS and records restore', async t => {
  const f = await fixture(t); await f.persistence.boundary();
  const original = (await f.persistence.list()).entries.find(entry => entry.source === 'initial');
  f.state.document = doc('edited'); f.state.version++;
  await f.persistence.flush();
  let writes = 0;
  const server = http.createServer(async (request, response) => {
    writes++;
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    assert.equal(body.baseVersion, f.state.version);
    f.state.document = body.document; f.state.version++;
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ ok: true, version: f.state.version }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  f.session.port = server.address().port;
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const result = await f.controller.restoreHistory({ id: original.id, docJson: f.snapshot() });
  assert.equal(writes, 1); assert.equal(result.version, 2);
  assert.equal(JSON.parse(await readFile(f.file)).children[0].name, 'original');
  assert.equal(result.history.entries[0].source, 'restore');
  assert.equal(result.history.entries[0].restoredFrom, original.id);
  assert.ok(result.history.entries.some(entry => entry.source === 'edit'));
});

test('uncertain restore freezes source writes and keeps the previous saved file', async t => {
  const f = await fixture(t); await f.persistence.boundary();
  const original = (await f.persistence.list()).entries[0];
  f.state.document = doc('edited'); f.state.version++;
  let writes = 0;
  const server = http.createServer(async (request, response) => {
    writes++; for await (const _chunk of request) {};
    response.destroy();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  f.session.port = server.address().port;
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  await assert.rejects(f.controller.restoreHistory({ id: original.id, docJson: f.snapshot() }), error => error.code === 'PROJECT_SWITCH_UNCERTAIN');
  await assert.rejects(f.persistence.flush(), error => error.code === 'AUTOSAVE_STOPPED');
  assert.equal(writes, 1);
  assert.equal(JSON.parse(await readFile(f.file)).children[0].name, 'edited');
});

test('history is isolated by document identity and a tampered snapshot cannot restore', async t => {
  const f = await fixture(t); await f.persistence.boundary();
  const current = (await f.persistence.list()).entries[0];
  const other = await f.controller.project.registerDocument({ name: 'Other' });
  const history = new CanvasHistory({ catalog: f.controller.project, documentId: other.id });
  await assert.rejects(history.read(current.id), error => error.code === 'HISTORY_INVALID');
  await writeFile(join(f.persistence.history.directory, current.id + '.op'), JSON.stringify(doc('tampered')));
  await assert.rejects(f.persistence.history.read(current.id), error => error.code === 'HISTORY_INVALID');
});

test('source created at the autosave destination by another process is never overwritten', async t => {
  const f = await fixture(t, { source: false });
  const other = await f.controller.project.registerDocument({ name: 'Taken' });
  const destination = join(f.root, `Taken-${other.id.slice(0, 8)}.op`);
  await writeFile(destination, JSON.stringify(doc('external owner')));
  // The filesystem primitive refuses collision even before registration can occur.
  const { atomicSave } = await import('../plugins/openpencil/scripts/editor-session.mjs');
  await assert.rejects(atomicSave(destination, JSON.stringify(doc('local')), null), error => error.code === 'EEXIST');
  assert.equal(JSON.parse(await readFile(destination)).children[0].name, 'external owner');
});
