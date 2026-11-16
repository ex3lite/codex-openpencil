import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, rm, chmod } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function privateDirectory(path) {
  if (!isAbsolute(path)) throw Error('Library storage requires an absolute path.');
  const root = parse(path).root;
  let cursor = root;
  for (const part of path.slice(root.length).split('/').filter(Boolean)) {
    cursor = join(cursor, part);
    try { await mkdir(cursor, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const info = await lstat(cursor);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(cursor) !== cursor) throw Error('Library directories cannot be symlinks.');
  }
  await chmod(path, 0o700);
}
export async function safeBytes(path, limit) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit || !info.size) throw Error('Use a nonempty regular file within the size limit; symlinks are not accepted.');
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const current = await file.stat();
    if (current.ino !== info.ino || current.dev !== info.dev || !current.isFile() || current.size > limit) throw Error('Library file changed while opening.');
    const bytes = await file.readFile();
    if (!bytes.length || bytes.length > limit) throw Error('Library object exceeds its size limit.');
    return bytes;
  } finally { await file.close(); }
}
export async function atomicBytes(path, bytes) {
  const temp = join(dirname(path), `.${randomUUID()}.tmp`);
  try {
    const file = await open(temp, 'wx', 0o600);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    await rename(temp, path);
    const directory = await open(dirname(path), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await rm(temp, { force: true }); }
}
export async function withLibraryLock(directory, action, name = '.write-lock') {
  const path = join(directory, name);
  let file;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { file = await open(path, 'wx', 0o600); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner;
      try { owner = JSON.parse(await safeBytes(path, 4096)); } catch { throw Error('Another dataset writer is active or its lock is incomplete. Inspect its result before retrying.'); }
      if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw Error('Invalid dataset writer lock.');
      let alive = true;
      try { process.kill(owner.pid, 0); } catch (cause) { if (cause.code === 'ESRCH') alive = false; }
      if (alive || attempt) throw Error('Another dataset writer is active. Inspect its result before retrying.');
      // Only reclaim a dead process lock whose exact inode and token are unchanged.
      const before = await lstat(path);
      const check = JSON.parse(await safeBytes(path, 4096));
      const after = await lstat(path);
      if (before.ino !== after.ino || check.token !== owner.token) throw Error('Dataset writer lock changed.');
      await rm(path);
    }
  }
  const token = randomUUID();
  await file.writeFile(JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() }));
  await file.sync();
  try { return await action(); }
  finally {
    await file.close();
    const owner = JSON.parse(await safeBytes(path, 4096));
    if (owner.token === token) await rm(path);
  }
}
