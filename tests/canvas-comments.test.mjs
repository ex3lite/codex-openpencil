import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CanvasComments } from '../plugins/openpencil/scripts/canvas-comments.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'op-comments-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const live = { version: 3, activePageIndex: 0, document: { version: '0.8.5', children: [{ id: 'a', type: 'frame', name: 'Кнопка', children: [] }] } };
  const state = { active_page_index: '0', active_page_id: '0', selection_ids: 'a' };
  const session = { document: async () => live, forward: async () => ({ result: { structuredContent: state } }) };
  const identity = { projectId: 'p1', documentId: 'd1', canvasId: 'c1' };
  const options = { session, identity, filePath: join(dir, 'comments.json') };
  const journal = new CanvasComments(options);
  const args = { requestId: 'request-12345', text: 'Увеличь отступ', pageId: '0', nodeIds: ['a'], expectedVersion: 3, docJson: JSON.stringify(live.document) };
  return { journal, args, live, state, options };
}
test('comments retain exact targets across selection changes and reopen', async t => {
  const f = await fixture(t); const saved = await f.journal.create(f.args);
  f.state.selection_ids = '';
  const reopened = await new CanvasComments(f.options).list();
  assert.deepEqual(reopened[0], saved); assert.deepEqual(saved.nodeIds, ['a']);
  assert.equal(saved.documentId, 'd1'); assert.equal(saved.version, 3);
});
test('deleted target or stale revision never creates a comment', async t => {
  const f = await fixture(t); f.live.version++;
  await assert.rejects(f.journal.create(f.args), /Макет изменился/);
  f.live.version--; f.live.document.children=[];
  await assert.rejects(f.journal.create(f.args), /Закреплённый слой/);
  assert.deepEqual(await f.journal.list(), []);
});
test('duplicate request has one durable comment and cannot change the target', async t => {
  const f = await fixture(t); await f.journal.create(f.args); await f.journal.create(f.args);
  await assert.rejects(f.journal.create({ ...f.args, text: 'Другой текст' }), /другому комментарию/);
  assert.equal((await f.journal.list()).length, 1);
  await f.journal.update({ commentId: f.args.requestId, status: 'uncertain' });
  assert.equal((await f.journal.list())[0].status, 'uncertain');
});

test('a later selection cannot redirect or block a pinned comment before submit',async t=>{
  const f=await fixture(t);f.state.selection_ids='';
  const saved=await f.journal.create(f.args);
  assert.deepEqual(saved.nodeIds,['a']);assert.equal(saved.nodes[0].name,'Кнопка');
});

test('only one panel can reserve delivery, including after reopening the journal', async t => {
  const { journal, options, args } = await fixture(t);
  const request = { ...args, prepareDelivery: true };
  const competing = new CanvasComments(options);
  const results = await Promise.allSettled([journal.create(request), competing.create(request)]);
  assert.equal(results.filter(result => result.value?.shouldSend).length, 1);
  const reopened = new CanvasComments(options);
  const [pending] = await reopened.list();
  assert.equal(pending.status, 'uncertain');
  assert.equal('shouldSend' in pending, false);
  assert.equal((await reopened.create(request)).shouldSend, false);
  await journal.update({ commentId: args.requestId, status: 'sent' });
  const confirmed = await reopened.create(request);
  assert.equal(confirmed.shouldSend, false);
  assert.equal(confirmed.status, 'sent');
  assert.equal((await reopened.list()).length, 1);
});
