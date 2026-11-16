import { open, rename, link, rm } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function syncDirectory(path) {
  // Windows cannot open directories for fsync; each file itself was flushed.
  if (process.platform === 'win32') return;
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

// Publish complete bytes only. Exclusive publication also protects a new destination.
export async function durableWrite(path, bytes, { exclusive = false, beforePublish } = {}) {
  const temporary = join(dirname(path), `.${basename(path)}-${randomUUID()}.tmp`);
  let published = false;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await beforePublish?.();
    if (exclusive) await link(temporary, path);
    else await rename(temporary, path);
    published = true;
    await syncDirectory(dirname(path));
  } catch (error) {
    if (published) { error.code = 'PERSISTENCE_UNCERTAIN'; error.uncertain = true; }
    throw error;
  } finally { await rm(temporary, { force: true }); }
}
