import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareCanvasLaunch, publishCanvasLaunch, pollCanvasLaunch } from '../plugins/openpencil/scripts/canvas-launch.mjs';

const execute = promisify(execFile);
const code = expected => error => error.code === expected;
const TTL = 10 * 60 * 1000;
async function fixture(t) {
  const temporary = await mkdtemp(join(tmpdir(), 'openpencil-launch-'));
  const base = await realpath(temporary), registryRoot = join(base, 'pending-launches');
  const projectRoot = join(base, 'project'), otherProject = join(base, 'project-other');
  await mkdir(projectRoot); await mkdir(otherProject);
  t.after(() => rm(temporary, { recursive: true, force: true }));
  return { base, registryRoot, options: { registryRoot }, projectRoot, otherProject,
    identity: { projectRoot, sessionId: randomUUID() } };
}
const requestPath = (f, id) => join(f.registryRoot, `${id}.request.json`);
const readyPath = (f, id) => join(f.registryRoot, `${id}.ready.json`);
async function makeExpired(f, id) {
  const path = requestPath(f, id), request = JSON.parse(await readFile(path, 'utf8'));
  request.createdAt = Date.now() - TTL - 1000; request.expiresAt = request.createdAt + TTL;
  await writeFile(path, JSON.stringify(request));
}

test('prepare creates an isolated private ten-minute request with no implicit project', async t => {
  const f = await fixture(t), start = Date.now();
  const first = await prepareCanvasLaunch(f.options), second = await prepareCanvasLaunch(f.options);
  assert.deepEqual(Object.keys(first).sort(), ['expiresAt', 'launchId']);
  assert.notEqual(first.launchId, second.launchId);
  assert.ok(Date.parse(first.expiresAt) >= start + TTL && Date.parse(first.expiresAt) <= Date.now() + TTL);
  assert.deepEqual(await pollCanvasLaunch(first.launchId, f.options), { state: 'pending' });
  assert.deepEqual(await pollCanvasLaunch(second.launchId, f.options), { state: 'pending' });
  const record = JSON.parse(await readFile(requestPath(f, first.launchId), 'utf8'));
  assert.deepEqual(Object.keys(record).sort(), ['createdAt', 'expiresAt', 'launchId', 'schemaVersion']);
  assert.equal(record.expiresAt - record.createdAt, TTL);
  if (process.platform !== 'win32') {
    assert.equal((await lstat(f.registryRoot)).mode & 0o777, 0o700);
    assert.equal((await lstat(requestPath(f, first.launchId))).mode & 0o777, 0o600);
  }
});

test('publish binds exactly once, canonicalizes the project and preserves the request bytes', async t => {
  const f = await fixture(t), { launchId } = await prepareCanvasLaunch(f.options);
  const before = await readFile(requestPath(f, launchId));
  const alias = join(f.base, 'project-alias'); await symlink(f.projectRoot, alias, 'dir');
  const ready = { state: 'ready', canvasSession: f.identity };
  assert.deepEqual(await publishCanvasLaunch(launchId, { ...f.identity, projectRoot: alias }, f.options), ready);
  assert.deepEqual(await publishCanvasLaunch(launchId, f.identity, f.options), ready);
  assert.deepEqual(await pollCanvasLaunch(launchId, f.options), ready);
  assert.deepEqual(await readFile(requestPath(f, launchId)), before);
  const persisted = JSON.parse(await readFile(readyPath(f, launchId), 'utf8'));
  assert.deepEqual(persisted, { schemaVersion: 1, launchId, canvasSession: f.identity });
  if (process.platform !== 'win32') assert.equal((await lstat(readyPath(f, launchId))).mode & 0o777, 0o600);
});

test('another project or session cannot replace a ready request or attach an unrelated request', async t => {
  const f = await fixture(t), first = await prepareCanvasLaunch(f.options), second = await prepareCanvasLaunch(f.options);
  await publishCanvasLaunch(first.launchId, f.identity, f.options);
  for (const identity of [{ ...f.identity, projectRoot: f.otherProject }, { ...f.identity, sessionId: randomUUID() }]) {
    await assert.rejects(publishCanvasLaunch(first.launchId, identity, f.options), code('CANVAS_LAUNCH_ALREADY_BOUND'));
  }
  assert.deepEqual(await pollCanvasLaunch(first.launchId, f.options), { state: 'ready', canvasSession: f.identity });
  assert.deepEqual(await pollCanvasLaunch(second.launchId, f.options), { state: 'pending' });
  await assert.rejects(pollCanvasLaunch(first.launchId, { registryRoot: join(f.base, 'other-registry') }), code('CANVAS_LAUNCH_NOT_FOUND'));
});

test('expired pending and ready requests reveal no identity and cannot be published', async t => {
  const f = await fixture(t);
  for (const ready of [false, true]) {
    const { launchId } = await prepareCanvasLaunch(f.options);
    if (ready) await publishCanvasLaunch(launchId, f.identity, f.options);
    await makeExpired(f, launchId);
    assert.deepEqual(await pollCanvasLaunch(launchId, f.options), { state: 'expired' });
    await assert.rejects(publishCanvasLaunch(launchId, f.identity, f.options), code('CANVAS_LAUNCH_EXPIRED'));
    if (!ready) await assert.rejects(lstat(readyPath(f, launchId)), code('ENOENT'));
  }
});

test('invalid IDs and absent requests fail with typed errors without creating a registry', async t => {
  const f = await fixture(t);
  for (const launchId of ['../foreign', 'not-a-uuid', randomUUID().toUpperCase(), {}, null, undefined]) {
    await assert.rejects(pollCanvasLaunch(launchId, f.options), code('INVALID_CANVAS_LAUNCH_ID'));
    await assert.rejects(publishCanvasLaunch(launchId, f.identity, f.options), code('INVALID_CANVAS_LAUNCH_ID'));
  }
  await assert.rejects(pollCanvasLaunch(randomUUID(), f.options), code('CANVAS_LAUNCH_NOT_FOUND'));
  await assert.rejects(publishCanvasLaunch(randomUUID(), f.identity, f.options), code('CANVAS_LAUNCH_NOT_FOUND'));
  await assert.rejects(lstat(f.registryRoot), code('ENOENT'));
});

test('session validation accepts only the explicit project and UUID, never transport credentials', async t => {
  const f = await fixture(t), { launchId } = await prepareCanvasLaunch(f.options);
  for (const value of [{ ...f.identity, token: 'must-not-persist' }, { ...f.identity, port: 1234 },
    { ...f.identity, projectRoot: '.' }, { ...f.identity, sessionId: '../other' }, null]) {
    await assert.rejects(publishCanvasLaunch(launchId, value, f.options), code('INVALID_CANVAS_LAUNCH_SESSION'));
  }
  await assert.rejects(publishCanvasLaunch(launchId, { ...f.identity, projectRoot: join(f.base, 'absent') }, f.options), code('CANVAS_LAUNCH_PROJECT_UNAVAILABLE'));
  assert.deepEqual(await readdir(f.registryRoot), [`${launchId}.request.json`]);
});

test('registry, request and ready symlinks are rejected without touching their targets', async t => {
  const f = await fixture(t), outside = join(f.base, 'outside');
  await mkdir(outside, { mode: 0o700 });
  await symlink(outside, f.registryRoot, 'dir');
  await assert.rejects(prepareCanvasLaunch(f.options), code('UNSAFE_CANVAS_LAUNCH'));
  assert.deepEqual(await readdir(outside), []);
  await rm(f.registryRoot);
  const { launchId } = await prepareCanvasLaunch(f.options), target = join(outside, 'record.json');
  const original = await readFile(requestPath(f, launchId)); await writeFile(target, original, { mode: 0o600 });
  await rm(requestPath(f, launchId)); await symlink(target, requestPath(f, launchId));
  await assert.rejects(pollCanvasLaunch(launchId, f.options), code('UNSAFE_CANVAS_LAUNCH'));
  await assert.rejects(publishCanvasLaunch(launchId, f.identity, f.options), code('UNSAFE_CANVAS_LAUNCH'));
  await rm(requestPath(f, launchId)); await writeFile(requestPath(f, launchId), original, { mode: 0o600 });
  await symlink(target, readyPath(f, launchId));
  await assert.rejects(pollCanvasLaunch(launchId, f.options), code('UNSAFE_CANVAS_LAUNCH'));
  await assert.rejects(publishCanvasLaunch(launchId, f.identity, f.options), code('UNSAFE_CANVAS_LAUNCH'));
  assert.deepEqual(await readFile(target), original);
});

test('public permissions and malformed, oversized or mismatched records fail closed', async t => {
  const f = await fixture(t), { launchId } = await prepareCanvasLaunch(f.options), path = requestPath(f, launchId);
  const original = await readFile(path), request = JSON.parse(original);
  if (process.platform !== 'win32') {
    await chmod(f.registryRoot, 0o755);
    await assert.rejects(pollCanvasLaunch(launchId, f.options), code('UNSAFE_CANVAS_LAUNCH'));
    await chmod(f.registryRoot, 0o700); await chmod(path, 0o644);
    await assert.rejects(pollCanvasLaunch(launchId, f.options), code('UNSAFE_CANVAS_LAUNCH'));
    await chmod(path, 0o600);
  }
  for (const bytes of ['{', 'x'.repeat(8193), JSON.stringify({ ...request, launchId: randomUUID() }),
    JSON.stringify({ ...request, expiresAt: request.expiresAt + 1 }), JSON.stringify({ ...request, token: 'unexpected' })]) {
    await writeFile(path, bytes);
    await assert.rejects(pollCanvasLaunch(launchId, f.options), code('UNSAFE_CANVAS_LAUNCH'));
  }
  await writeFile(path, original);
  await writeFile(readyPath(f, launchId), '{', { mode: 0o600 });
  await assert.rejects(publishCanvasLaunch(launchId, f.identity, f.options), code('UNSAFE_CANVAS_LAUNCH'));
  assert.equal(await readFile(readyPath(f, launchId), 'utf8'), '{');
});

test('independent concurrent publishers have exactly one winner and idempotent repeats', async t => {
  const f = await fixture(t), { launchId } = await prepareCanvasLaunch(f.options);
  const identities = [f.identity, { projectRoot: f.otherProject, sessionId: randomUUID() }];
  const script = `const [modulePath,id,identity,registryRoot]=process.argv.slice(1);
    const {publishCanvasLaunch}=await import(modulePath);
    try { console.log(JSON.stringify({ok:true,value:await publishCanvasLaunch(id,JSON.parse(identity),{registryRoot})})); }
    catch(error) { console.log(JSON.stringify({ok:false,code:error.code})); }`;
  const modulePath = new URL('../plugins/openpencil/scripts/canvas-launch.mjs', import.meta.url).href;
  const replies = await Promise.all(Array.from({ length: 8 }, async (_, index) => {
    const identity = identities[index % identities.length];
    const { stdout } = await execute(process.execPath, ['--input-type=module', '-e', script, modulePath, launchId, JSON.stringify(identity), f.registryRoot]);
    return { identity, ...JSON.parse(stdout) };
  }));
  const winner = await pollCanvasLaunch(launchId, f.options);
  assert.equal(winner.state, 'ready');
  for (const reply of replies) {
    if (reply.identity.sessionId === winner.canvasSession.sessionId) assert.deepEqual(reply.value, winner);
    else { assert.equal(reply.ok, false); assert.equal(reply.code, 'CANVAS_LAUNCH_ALREADY_BOUND'); }
  }
  assert.equal(replies.filter(reply => reply.ok).length, 4);
  assert.deepEqual((await readdir(f.registryRoot)).sort(), [`${launchId}.ready.json`, `${launchId}.request.json`]);
});

test('unpublished temporary data never appears as a ready launch', async t => {
  const f = await fixture(t), { launchId } = await prepareCanvasLaunch(f.options);
  await writeFile(join(f.registryRoot, `.${launchId}.ready.json-incomplete.tmp`), '{', { mode: 0o600 });
  assert.deepEqual(await pollCanvasLaunch(launchId, f.options), { state: 'pending' });
  assert.deepEqual(await publishCanvasLaunch(launchId, f.identity, f.options), { state: 'ready', canvasSession: f.identity });
});
