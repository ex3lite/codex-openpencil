import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, realpath, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { stateRoot } from './editor-runtime.mjs';

const TTL = 10 * 60 * 1000;
const MAX_BYTES = 8192;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const fail = (code, message) => Object.assign(new Error(message), { code });
const unsafe = () => fail('UNSAFE_CANVAS_LAUNCH', 'Запись открытия холста повреждена или имеет небезопасные права. Откройте панель заново.');
const missing = () => fail('CANVAS_LAUNCH_NOT_FOUND', 'Заявка на открытие холста не найдена. Откройте панель заново в текущем чате.');
const expired = () => fail('CANVAS_LAUNCH_EXPIRED', 'Срок заявки на открытие холста истёк. Откройте панель заново.');
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keysAre = (value, keys) => record(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const privateEntry = stat => process.platform === 'win32' || ((stat.mode & 0o077) === 0 && stat.uid === process.getuid());

function validateId(launchId) {
  if (typeof launchId !== 'string' || !UUID.test(launchId)) {
    throw fail('INVALID_CANVAS_LAUNCH_ID', 'Некорректный идентификатор заявки на открытие холста.');
  }
}

async function registry({ registryRoot = join(stateRoot(), 'pending-launches') } = {}, create = false) {
  if (typeof registryRoot !== 'string' || !isAbsolute(registryRoot)) throw unsafe();
  try {
    if (create) await mkdir(dirname(registryRoot), { recursive: true, mode: 0o700 });
    // Canonicalize an ancestor such as macOS /var without accepting a symlink as the registry itself.
    const path = join(await realpath(dirname(registryRoot)), basename(registryRoot));
    if (create) await mkdir(path, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !privateEntry(stat) || await realpath(path) !== path) throw unsafe();
    return path;
  } catch (error) {
    if (!create && error.code === 'ENOENT') throw missing();
    throw error;
  }
}

async function readRecord(path) {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || !privateEntry(before) || before.size > MAX_BYTES) throw unsafe();
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const stat = await file.stat();
    if (!stat.isFile() || !privateEntry(stat) || stat.size > MAX_BYTES || stat.ino !== before.ino || stat.dev !== before.dev) throw unsafe();
    const bytes = await file.readFile();
    if (bytes.length > MAX_BYTES) throw unsafe();
    try { return JSON.parse(bytes.toString('utf8')); } catch { throw unsafe(); }
  } finally { await file.close(); }
}

async function readRequest(directory, launchId) {
  let request;
  try { request = await readRecord(join(directory, `${launchId}.request.json`)); }
  catch (error) { if (error.code === 'ENOENT') throw missing(); throw error; }
  if (!keysAre(request, ['schemaVersion', 'launchId', 'createdAt', 'expiresAt']) ||
      request.schemaVersion !== 1 || request.launchId !== launchId ||
      !Number.isSafeInteger(request.createdAt) || request.createdAt <= 0 ||
      !Number.isSafeInteger(request.expiresAt) || request.expiresAt - request.createdAt !== TTL) throw unsafe();
  return request;
}

async function identity(value) {
  if (!keysAre(value, ['projectRoot', 'sessionId']) || typeof value.projectRoot !== 'string' ||
      !isAbsolute(value.projectRoot) || typeof value.sessionId !== 'string' || !UUID.test(value.sessionId)) {
    throw fail('INVALID_CANVAS_LAUNCH_SESSION', 'Для открытия холста нужен точный проект и идентификатор сеанса.');
  }
  let projectRoot;
  try {
    projectRoot = await realpath(value.projectRoot);
    if (!(await lstat(projectRoot)).isDirectory()) throw new Error();
  } catch { throw fail('CANVAS_LAUNCH_PROJECT_UNAVAILABLE', 'Папка проекта для этого холста недоступна.'); }
  return { projectRoot, sessionId: value.sessionId };
}

async function readReady(directory, launchId) {
  let ready;
  try { ready = await readRecord(join(directory, `${launchId}.ready.json`)); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!keysAre(ready, ['schemaVersion', 'launchId', 'canvasSession']) ||
      ready.schemaVersion !== 1 || ready.launchId !== launchId) throw unsafe();
  const canvasSession = await identity(ready.canvasSession);
  if (canvasSession.projectRoot !== ready.canvasSession.projectRoot) throw unsafe();
  return { state: 'ready', canvasSession };
}

async function writeExclusive(directory, name, value) {
  const temporary = join(directory, `.${name}-${randomUUID()}.tmp`);
  const bytes = Buffer.from(JSON.stringify(value) + '\n');
  if (bytes.length > MAX_BYTES) throw unsafe();
  const file = await open(temporary, 'wx', 0o600);
  try {
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    // A complete immutable inode becomes visible atomically; link never replaces another publisher.
    await link(temporary, join(directory, name));
  } finally { await rm(temporary, { force: true }); }
}

export async function prepareCanvasLaunch(options = {}) {
  const directory = await registry(options, true), launchId = randomUUID(), createdAt = Date.now();
  const expiresAt = createdAt + TTL;
  await writeExclusive(directory, `${launchId}.request.json`, { schemaVersion: 1, launchId, createdAt, expiresAt });
  return { launchId, expiresAt: new Date(expiresAt).toISOString() };
}

export async function publishCanvasLaunch(launchId, value, options = {}) {
  validateId(launchId);
  const directory = await registry(options), request = await readRequest(directory, launchId);
  if (Date.now() >= request.expiresAt) throw expired();
  const canvasSession = await identity(value);
  if (Date.now() >= request.expiresAt) throw expired();
  try {
    await writeExclusive(directory, `${launchId}.ready.json`, { schemaVersion: 1, launchId, canvasSession });
  } catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (Date.now() >= request.expiresAt) throw expired();
  const ready = await readReady(directory, launchId);
  if (!ready) throw unsafe();
  if (ready.canvasSession.projectRoot !== canvasSession.projectRoot || ready.canvasSession.sessionId !== canvasSession.sessionId) {
    throw fail('CANVAS_LAUNCH_ALREADY_BOUND', 'Эта заявка уже связана с другим холстом. Откройте новую панель для другого сеанса.');
  }
  return ready;
}

export async function pollCanvasLaunch(launchId, options = {}) {
  validateId(launchId);
  const directory = await registry(options), request = await readRequest(directory, launchId);
  if (Date.now() >= request.expiresAt) return { state: 'expired' };
  const ready = await readReady(directory, launchId);
  if (Date.now() >= request.expiresAt) return { state: 'expired' };
  return ready || { state: 'pending' };
}
