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
  t.after(() => rm(path, { recursive: true, force: true }));
  const file = join(root, 'design.op');
  if (source) await writeFile(file, JSON.stringify(doc('original')));
  const controller = new CanvasController({ projectRoot: root });
  const binding = await bindProject(controller, source ? { filePath: file } : {});
  t.after(() => controller.releaseProjectLease());
  const state = { document: doc('original'), version: 0, activePageIndex: 0, preserveAuthoredGeometry: true };
  const session = controller.session = Object.assign(new EditorSession(), { dir: root, draft: join(root, 'runtime.op'),
    source: binding.sourcePath, baseline: binding.baseline, document: async () => structuredClone(state), closed: false });
  attachProjectSession(controller);
  const persistence = controller.persistence = new CanvasPersistence(controller, { debounceMs: 10, historyMs: 20 });
  t.after(() => persistence.dispose());
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

test('history restore preserves current work, replaces once with CAS and records restore', async t => {
  const f = await fixture(t); await f.persistence.boundary();
  const original = (await f.persistence.list()).entries.find(entry => entry.source === 'initial');
  f.state.document = doc('edited'); f.state.version++;
  await f.persistence.flush();
  let writes = 0;
  t.mock.method(globalThis, 'fetch', async (_url, args) => {
    writes++;
    const body = JSON.parse(args.body);
    assert.equal(body.baseVersion, f.state.version);
    f.state.document = body.document; f.state.version++;
    return new Response(JSON.stringify({ ok: true, version: f.state.version }), { status: 200 });
  });
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
  t.mock.method(globalThis, 'fetch', async () => { writes++; throw Error('connection lost after apply'); });
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
