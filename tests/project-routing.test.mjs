import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CanvasController } from '../plugins/openpencil/scripts/canvas-controller.mjs';
import { nativeRequest } from '../plugins/openpencil/scripts/native-canvas.mjs';
import { completeCodegen } from '../plugins/openpencil/scripts/canvas-codegen.mjs';

function controllerFixture() {
  const controller = new CanvasController(), forwarded = [], saved = [];
  controller.session = { source: '/project/design.op', draft: '/runtime/recovery.op', port: 1234, token: 'fixture-token',
    assertLive() {}, async checkpoint() { assert.fail('A refused request must not checkpoint.'); },
    async forward(message) { forwarded.push(message); return { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'active canvas' }] } }; },
    async save(args) { saved.push(args); return { filePath: args.filePath }; },
  };
  const call = (name, args = {}) => controller.dispatch({ jsonrpc: '2.0', id: 41, method: 'tools/call', params: { name, arguments: args } });
  return { controller, forwarded, saved, call };
}

test('uncertain document switching refuses every native POST before fetch, startup or checkpoint', async t => {
  let requests = 0, opens = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests++; assert.fail('No network request is allowed.'); });
  const unopened = { projectSwitchUncertain: true, async open() { opens++; assert.fail('No startup is allowed.'); } };
  for (const path of ['/api/mcp/document', '/api/mcp/selection', '/api/mcp/sync-reset']) {
    await assert.rejects(nativeRequest(unopened, { method: 'POST', path, body: '{}' }), /Переключение документа не подтверждено/);
  }
  const f = controllerFixture(); f.controller.projectSwitchUncertain = true;
  const response = await f.call('canvas_native_request', { method: 'POST', path: '/api/mcp/document', body: '{"document":{"version":"1","children":[]},"baseVersion":7}' });
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /Переключение документа не подтверждено/);
  assert.equal(requests, 0); assert.equal(opens, 0); assert.equal(f.forwarded.length, 0);
});

test('uncertain switching still permits native inspection without checkpointing', async t => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, options });
    return new Response('{"version":8}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  const f = controllerFixture(); f.controller.projectSwitchUncertain = true;
  const response = await f.call('canvas_native_request', { method: 'GET', path: '/api/mcp/version' });
  assert.equal(response.result.isError, undefined);
  assert.equal(requests.length, 1); assert.equal(requests[0].options.method, 'GET');
  assert.equal(requests[0].url, 'http://127.0.0.1:1234/api/mcp/version');
  assert.deepEqual(JSON.parse(Buffer.from(response.result._meta.nativeHttp.body, 'base64').toString()), { version: 8 });
});

test('managed forwarding refuses both foreign projects and another file in the same project', async () => {
  const f = controllerFixture();
  for (const filePath of ['/other-project/design.op', '/project-other/design.op', '/project/other.op', 'relative.op']) {
    const reply = await f.call('update_node', { filePath, nodeId: 'button', data: { name: 'must not apply' } });
    assert.equal(reply.result.isError, true, filePath);
    assert.match(reply.result.content[0].text, /active project document/);
  }
  for (const name of ['update_node', 'save_document']) {
    const reply = await f.call(name, { filePath: f.controller.session.source, sourceFilePath: '/other-project/source.op' });
    assert.equal(reply.result.isError, true, name);
  }
  assert.equal(f.forwarded.length, 0); assert.equal(f.saved.length, 0);
});

test('current file and live aliases are stripped before upstream dispatch without changing node data', async () => {
  const f = controllerFixture();
  for (const filePath of [f.controller.session.source, f.controller.session.draft, 'live://canvas', 'live://canvas/current']) {
    const argumentsValue = { filePath, nodeId: 'button', data: { path: 'M 0 0 L 12 12', name: 'Preserve SVG path' } };
    const original = structuredClone(argumentsValue);
    const response = await f.call('update_node', argumentsValue);
    assert.equal(response.result.isError, undefined);
    const forwarded = f.forwarded.at(-1);
    assert.equal(forwarded.id, 41); assert.equal(forwarded.params.name, 'update_node');
    assert.equal(Object.hasOwn(forwarded.params.arguments, 'filePath'), false);
    assert.deepEqual(forwarded.params.arguments, { nodeId: 'button', data: original.data });
    assert.deepEqual(argumentsValue, original, 'Caller arguments must not be rewritten in place.');
  }
  assert.equal(f.forwarded.length, 4);
});

test('raw document replacement and spawning tools cannot bypass managed project controls', async () => {
  const f = controllerFixture();
  for (const name of ['open_document', 'new_document', 'spawn_agents']) {
    for (const args of [{}, { filePath: f.controller.session.source }]) {
      const response = await f.call(name, args);
      assert.equal(response.result.isError, true, name);
      assert.match(response.result.content[0].text, /project document controls|canvas_agent_assign/);
    }
  }
  f.controller.projectSwitchUncertain = true;
  const uncertain = await f.call('update_node', { nodeId: 'button', data: { name: 'blocked' } });
  assert.equal(uncertain.result.isError, true);
  assert.equal(f.forwarded.length, 0);
});

test('code completion is bound to its captured project and document across sibling paths and symlinks', async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'codegen-project-routing-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const base = await realpath(temporary), projectRoot = join(base, 'project'), sibling = join(base, 'project-other');
  await mkdir(projectRoot); await mkdir(sibling);
  const own = join(projectRoot, 'index.html'), foreign = join(sibling, 'index.html');
  await writeFile(own, '<main>Own project</main>'); await writeFile(foreign, '<main>Another project</main>');
  const job = { requestId: 'request-one', framework: 'html', projectId: 'project-one', documentId: 'document-one',
    projectRoot, expectedVersion: 7, status: 'prepared', revision: 1, code: '<main>Baseline</main>' };
  const controller = { project: { projectId: job.projectId, projectRoot }, documentId: job.documentId,
    codegenJob: job, session: { document: async () => ({ version: 7 }) } };
  const complete = codePath => completeCodegen(controller, { requestId: job.requestId, codePath });
  await assert.rejects(complete(foreign), /captured project/);
  if (process.platform !== 'win32') {
    const alias = join(projectRoot, 'foreign-directory'); await symlink(sibling, alias, 'dir');
    await assert.rejects(complete(join(alias, 'index.html')), /captured project/);
  }
  controller.documentId = 'document-two';
  await assert.rejects(complete(own), /project changed/);
  controller.documentId = job.documentId; controller.project.projectId = 'project-two';
  await assert.rejects(complete(own), /project changed/);
  assert.equal(job.status, 'prepared'); assert.equal(job.revision, 1); assert.equal(job.code, '<main>Baseline</main>');
  controller.project.projectId = job.projectId;
  await complete(own);
  assert.equal(job.status, 'complete'); assert.equal(job.codePath, own); assert.equal(job.code, '<main>Own project</main>');
});
