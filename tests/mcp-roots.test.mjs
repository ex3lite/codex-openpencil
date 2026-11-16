import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { serve } from '../plugins/openpencil/scripts/mcp-bridge.mjs';
import { resolveProjectRoot } from '../plugins/openpencil/scripts/project-catalog.mjs';

async function fixture(t, capabilities = { roots: { listChanged: true } }, rootsTimeout = 2000) {
  const temporary = await mkdtemp(join(tmpdir(), 'openpencil-mcp-roots-'));
  const base = await realpath(temporary), project = join(base, 'chat'), plugin = join(base, 'plugin');
  await mkdir(project); await mkdir(plugin);
  const input = new PassThrough(), output = new PassThrough(), events = new EventEmitter();
  const messages = [], dispatched = [], lines = createInterface({ input: output });
  lines.on('line', line => { messages.push(JSON.parse(line)); events.emit('message'); });
  let queue = Promise.resolve();
  const running = serve({ cwd: plugin }, { input, output, rootsTimeout, createController: options => ({
    enqueue(work) { const result = queue.then(work); queue = result.catch(() => {}); return result; },
    async dispatch(message) {
      dispatched.push(message);
      if (message.id === undefined) return null;
      try {
        const result = message.method === 'open'
          ? await resolveProjectRoot({ ...options, ...message.params }) : { ok: true };
        return { jsonrpc: '2.0', id: message.id, result };
      } catch (error) { return { jsonrpc: '2.0', id: message.id, error: { code: error.code, message: error.message } }; }
    },
    async close() { await queue; },
  }) });
  t.after(async () => { input.end(); await running; lines.close(); await rm(temporary, { recursive: true, force: true }); });
  const send = message => input.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  const wait = async predicate => {
    for (;;) {
      const found = messages.find(predicate);
      if (found) return found;
      await once(events, 'message', { signal: AbortSignal.timeout(3000) });
    }
  };
  send({ id: 1, method: 'initialize', params: { capabilities } });
  await wait(message => message.id === 1);
  send({ method: 'notifications/initialized' });
  return { project, plugin, messages, dispatched, send, wait, input, running,
    roots: path => [{ uri: pathToFileURL(path).href }] };
}

test('roots replies bypass a waiting request while normal requests remain serialized', async t => {
  const f = await fixture(t);
  f.send({ id: 2, method: 'open' });
  const request = await f.wait(message => message.method === 'roots/list');
  f.send({ id: 3, method: 'ping' });
  f.send({ id: 'unrelated-server-request', result: { roots: f.roots(f.plugin) } });
  assert.equal(f.dispatched.some(message => message.id === 3), false);
  f.send({ id: request.id, result: { roots: f.roots(f.project) } });
  assert.equal((await f.wait(message => message.id === 2)).result.projectRoot, f.project);
  await f.wait(message => message.id === 3);
  assert.deepEqual(f.messages.filter(message => [2, 3].includes(message.id)).map(message => message.id), [2, 3]);
  assert.equal(f.dispatched.some(message => message.id === request.id), false);
  assert.equal(f.dispatched.some(message => message.id === 'unrelated-server-request'), false);
});

test('without host root capability the plugin cwd never becomes a project', async t => {
  const f = await fixture(t, {});
  f.send({ id: 2, method: 'open' });
  assert.equal((await f.wait(message => message.id === 2)).error.code, 'PROJECT_ROOT_REQUIRED');
  assert.equal(f.messages.some(message => message.method === 'roots/list'), false);
});

test('an explicit chat project bypasses roots even when the host advertises them', async t => {
  const f = await fixture(t);
  f.send({ id: 2, method: 'open', params: { projectRoot: f.project } });
  assert.equal((await f.wait(message => message.id === 2)).result.projectRoot, f.project);
  assert.equal(f.messages.some(message => message.method === 'roots/list'), false);
});

test('root errors, malformed roots and timeout fail closed without automatic retries', async t => {
  for (const reply of [{ error: { code: -32601, message: 'unsupported' } }, { result: { roots: 'bad' } }, null]) {
    await t.test(JSON.stringify(reply), async t => {
      const f = await fixture(t, { roots: {} }, 40);
      f.send({ id: 2, method: 'open' });
      const request = await f.wait(message => message.method === 'roots/list');
      if (reply) f.send({ id: request.id, ...reply });
      const result = await f.wait(message => message.id === 2);
      assert.equal(result.error.code, reply?.result ? 'INVALID_PROJECT_ROOTS' : 'PROJECT_ROOT_UNAVAILABLE');
      assert.equal(f.messages.filter(message => message.method === 'roots/list').length, 1);
    });
  }
});

test('fresh roots are requested for each unbound project and empty roots do not fall back', async t => {
  const f = await fixture(t);
  for (const id of [2, 3]) {
    f.send({ id, method: 'open' });
    const request = await f.wait(message => message.method === 'roots/list' && message.id === `openpencil:roots:${id - 1}`);
    f.send({ id: request.id, result: { roots: id === 2 ? f.roots(f.project) : [] } });
    const result = await f.wait(message => message.id === id);
    if (id === 2) assert.equal(result.result.projectRoot, f.project);
    else assert.equal(result.error.code, 'PROJECT_ROOT_REQUIRED');
  }
});

test('closing stdin releases a request waiting for roots immediately', async t => {
  const f = await fixture(t);
  f.send({ id: 2, method: 'open' });
  await f.wait(message => message.method === 'roots/list');
  f.input.end();
  await f.running;
  assert.equal((await f.wait(message => message.id === 2)).error.code, 'PROJECT_ROOT_UNAVAILABLE');
});
