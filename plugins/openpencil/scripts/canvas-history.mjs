import { MAX_DOCUMENT_BYTES, DOCUMENT_ENVELOPE_BYTES } from './document-limits.mjs';
import { lstat, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { durableWrite } from './atomic-files.mjs';
import { sha256 } from './editor-runtime.mjs';
import { sourceBytes, validateDocument } from './editor-session.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const fail = message => Object.assign(new Error(message), { code: 'HISTORY_INVALID' });

/** Immutable snapshots plus an atomically published, bounded index per document. */
export class CanvasHistory {
  constructor({ catalog, documentId, maxEntries = 50, maxBytes = 2 * MAX_DOCUMENT_BYTES }) {
    if (!UUID.test(documentId)) throw fail('Invalid history document.');
    Object.assign(this, { catalog, documentId, maxEntries, maxBytes });
    this.directory = join(catalog.directory, 'history', documentId);
    this.indexPath = join(this.directory, 'index.json');
  }
  async ensure() {
    await this.catalog.ensureDirectories();
    for (const path of [join(this.catalog.directory, 'history'), this.directory]) {
      await mkdir(path, { recursive: true, mode: 0o700 });
      const stat = await lstat(path);
      if (stat.isSymbolicLink() || !stat.isDirectory() || await realpath(path) !== path) throw fail('History directory is unsafe.');
    }
  }
  async list() {
    await this.ensure();
    let value;
    try {
      const stat = await lstat(this.indexPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) throw fail('History index is unsafe.');
      value = JSON.parse(await readFile(this.indexPath, 'utf8'));
    } catch (error) { if (error.code === 'ENOENT') return { revision: 0, entries: [] }; throw error; }
    if (value.documentId !== this.documentId || !Number.isSafeInteger(value.revision) ||
        !Array.isArray(value.entries) || value.entries.length > 50 || value.entries.some(entry =>
          !UUID.test(entry.id) || !/^[a-f0-9]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.bytes) ||
          entry.bytes < 1 || entry.bytes > MAX_DOCUMENT_BYTES || typeof entry.createdAt !== 'string' ||
          !['initial', 'edit', 'restore'].includes(entry.source))) throw fail('History index is invalid.');
    return value;
  }
  async record(bytes, { version, source = 'edit', restoredFrom, force = false } = {}) {
    validateDocument(bytes);
    const index = await this.list(), hash = sha256(bytes);
    if (!force && index.entries[0]?.sha256 === hash) return index;
    const entry = { id: randomUUID(), createdAt: new Date().toISOString(), version, source,
      sha256: hash, bytes: Buffer.byteLength(bytes), ...(restoredFrom && { restoredFrom }) };
    await durableWrite(join(this.directory, entry.id + '.op'), bytes, { exclusive: true });
    const candidates = [entry, ...index.entries];
    let total = 0;
    const entries = candidates.filter((item, position) => {
      total += item.bytes;
      return position < this.maxEntries && (position === 0 || total <= this.maxBytes);
    });
    const next = { documentId: this.documentId, revision: index.revision + 1, entries };
    await durableWrite(this.indexPath, JSON.stringify(next) + '\n');
    for (const item of candidates) if (!entries.includes(item)) await rm(join(this.directory, item.id + '.op'), { force: true });
    return next;
  }
  async read(id) {
    if (!UUID.test(id || '')) throw fail('Choose an existing history version.');
    const entry = (await this.list()).entries.find(item => item.id === id);
    if (!entry) throw fail('History version was not found in this document.');
    const bytes = await sourceBytes(join(this.directory, id + '.op'));
    if (sha256(bytes) !== entry.sha256) throw fail('History snapshot has changed; restore was stopped.');
    return { entry, bytes };
  }
}
