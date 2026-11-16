import { constants } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, open, realpath, rm } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const fail = (code, message) => Object.assign(new Error(message), { code });
const privateEntry = stat => process.platform === 'win32' ||
  ((stat.mode & 0o077) === 0 && stat.uid === process.getuid());

async function leaseDirectory(catalog) {
  await catalog.ensureDirectories();
  const path = join(catalog.directory, 'writers');
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !privateEntry(stat) || await realpath(path) !== path) {
    throw fail('UNSAFE_PROJECT_WRITER', 'Каталог активных документов должен быть личной папкой внутри проекта без символических ссылок.');
  }
  return path;
}

async function readClaim(path, catalog, documentId) {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || !privateEntry(before) || before.size > 4096) {
    throw fail('UNSAFE_PROJECT_WRITER', 'Запись владельца документа повреждена или имеет небезопасные права.');
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || !privateEntry(stat) || stat.size > 4096 || stat.ino !== before.ino || stat.dev !== before.dev) {
      throw fail('UNSAFE_PROJECT_WRITER', 'Запись владельца документа изменилась во время проверки.');
    }
    const bytes = await handle.readFile();
    if (bytes.length > 4096) throw fail('UNSAFE_PROJECT_WRITER', 'Запись владельца документа превышает допустимый размер.');
    let claim;
    try { claim = JSON.parse(bytes.toString('utf8')); } catch { throw fail('UNSAFE_PROJECT_WRITER', 'Запись владельца документа повреждена.'); }
    if (claim.schemaVersion !== 1 || claim.projectRoot !== catalog.projectRoot || claim.projectId !== catalog.projectId ||
        claim.documentId !== documentId || !Number.isSafeInteger(claim.pid) || claim.pid <= 0 ||
        typeof claim.hostname !== 'string' || !/^[a-zA-Z0-9_-]{43}$/.test(claim.token)) {
      throw fail('UNSAFE_PROJECT_WRITER', 'Запись владельца принадлежит другому документу или проекту.');
    }
    return claim;
  } finally { await handle.close(); }
}

function processDefinitelyStopped(claim) {
  if (claim.hostname !== hostname()) return false;
  try { process.kill(claim.pid, 0); return false; }
  catch (error) { return error.code === 'ESRCH'; }
}

/** One managed writer per document; agent children share their owner's lease. */
export async function acquireProjectWriter(catalog, documentId) {
  if (!UUID.test(documentId)) throw fail('DOCUMENT_NOT_FOUND', 'Выберите документ из списка проекта.');
  await catalog.getDocument(documentId);
  const path = join(await leaseDirectory(catalog), `${documentId}.json`);
  const token = randomBytes(32).toString('base64url');
  const claim = { schemaVersion: 1, projectRoot: catalog.projectRoot, projectId: catalog.projectId,
    documentId, pid: process.pid, hostname: hostname(), token, createdAt: new Date().toISOString() };
  let handle;
  try { handle = await open(path, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const current = await readClaim(path, catalog, documentId);
    if (processDefinitelyStopped(current)) {
      throw fail('PROJECT_WRITER_STALE', 'Предыдущий редактор завершился, но оставил блокировку документа. Черновик сохранён. Проверьте .openpencil/writers и удалите только блокировку остановленного сеанса перед повторным открытием.');
    }
    throw fail('PROJECT_DOCUMENT_IN_USE', 'Этот документ уже открыт для редактирования в другом сеансе. Закройте его там или импортируйте отдельную копию.');
  }
  try { await handle.writeFile(JSON.stringify(claim) + '\n'); await handle.sync(); }
  catch (error) { await handle.close(); await rm(path, { force: true }); throw error; }
  await handle.close();
  let released = false;
  const assertOwned = async () => {
    if (released) throw fail('PROJECT_WRITER_RELEASED', 'Сеанс уже освободил этот документ. Откройте его заново.');
    await leaseDirectory(catalog);
    const current = await readClaim(path, catalog, documentId);
    if (current.token !== token) throw fail('PROJECT_WRITER_CHANGED', 'Документ закреплён за другим сеансом. Запись остановлена.');
  };
  return { documentId, assertOwned, async release() {
    if (released) return;
    try { await assertOwned(); }
    catch (error) { if (error.code !== 'ENOENT') throw error; released = true; return; }
    // No participant may replace a live owner's claim. Reclamation is explicit.
    await rm(path); released = true;
  } };
}
