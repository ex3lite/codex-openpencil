import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip, createGunzip } from 'node:zlib';
import { DOCUMENT_ENVELOPE_BYTES, TRANSFER_CHUNK_BYTES } from './document-limits.mjs';

const stores = new WeakMap(), TTL = 5 * 60_000, MAX_ENTRIES = 3;
const fail = message => Object.assign(new Error(message), { code: 'DOCUMENT_TRANSFER_INVALID' });
const tokenPattern = /^[a-f0-9-]{36}$/;
const hashPattern = /^[a-f0-9]{64}$/;
function bind(controller) { return { session: controller.session, documentId: controller.documentId }; }
function same(controller, entry) { return entry.session === controller.session && entry.documentId === controller.documentId; }
async function store(controller) {
  let state = stores.get(controller);
  if (!state) {
    state = { dir: await mkdtemp(join(tmpdir(), 'openbrush-transfer-')), entries: new Map() };
    stores.set(controller, state);
  }
  for (const [id, entry] of state.entries) if (Date.now() - entry.at > TTL || !same(controller, entry)) {
    state.entries.delete(id); await rm(entry.path, { force: true });
  }
  return state;
}
async function entryFor(controller, id) {
  const state = await store(controller), entry = state.entries.get(id);
  if (!tokenPattern.test(id || '') || !entry || !same(controller, entry)) throw fail('Document transfer expired or belongs to another canvas.');
  entry.at = Date.now();
  return { state, entry };
}
function descriptor(id, entry) {
  return { id, encoding: 'gzip', bytes: entry.bytes, rawBytes: entry.rawBytes,
    sha256: entry.sha256, chunkBytes: TRANSFER_CHUNK_BYTES };
}
function meter(limit, update) {
  let total = 0;
  return new Transform({ transform(chunk, encoding, next) {
    total += chunk.length;
    if (total > limit) return next(fail('Document exceeds the 256 MiB transfer budget.'));
    update?.(chunk, total); next(null, chunk);
  }});
}
async function reserve(controller, extra) {
  const state = await store(controller);
  if (state.entries.size >= MAX_ENTRIES) throw fail('Finish or cancel the existing document transfer first.');
  const id = randomUUID(), path = join(state.dir, id);
  const entry = { ...bind(controller), path, at: Date.now(), ...extra };
  state.entries.set(id, entry);
  return { state, id, entry };
}
export async function downloadTransfer(controller, bytes) {
  const { state, id, entry } = await reserve(controller, { kind: 'download', rawBytes: 0, bytes: 0 });
  const hash = createHash('sha256');
  try {
    await pipeline(Buffer.isBuffer(bytes) ? Readable.from([bytes]) : typeof bytes.pipe === 'function' ? bytes : Readable.fromWeb(bytes),
      meter(DOCUMENT_ENVELOPE_BYTES, (_, total) => { entry.rawBytes = total; }), createGzip(),
      meter(DOCUMENT_ENVELOPE_BYTES, (chunk, total) => { hash.update(chunk); entry.bytes = total; }),
      createWriteStream(entry.path, { flags: 'wx', mode: 0o600 }));
    entry.sha256 = hash.digest('hex'); return descriptor(id, entry);
  } catch (error) { state.entries.delete(id); await rm(entry.path, { force: true }); throw error; }
}
export async function consumeTransfer(controller, id, kind) {
  const { state, entry } = await entryFor(controller, id);
  if (entry.kind !== kind || !entry.complete) throw fail('Document transfer is not ready for this operation.');
  // Consume before dispatch. A failed mutation must never become a token retry.
  state.entries.delete(id);
  try { return await readFile(entry.path, 'utf8'); }
  finally { await rm(entry.path, { force: true }); }
}
export async function dispatchTransfer(controller, args) {
  if (!controller.session) throw fail('Open the canvas before transferring a document.');
  controller.session.assertLive();
  if (args.action === 'start') {
    if (!['snapshot', 'body'].includes(args.kind) || !Number.isSafeInteger(args.bytes) || args.bytes < 1 ||
        args.bytes > DOCUMENT_ENVELOPE_BYTES || !Number.isSafeInteger(args.rawBytes) || args.rawBytes < 1 ||
        args.rawBytes > DOCUMENT_ENVELOPE_BYTES || !hashPattern.test(args.sha256 || '')) throw fail('Invalid document transfer size or checksum.');
    const { id, entry } = await reserve(controller, { kind: args.kind, bytes: args.bytes,
      rawBytes: args.rawBytes, sha256: args.sha256, received: 0, index: 0, hash: createHash('sha256') });
    await mkdir(join(entry.path, '..'), { recursive: true, mode: 0o700 });
    const file = await open(entry.path, 'wx', 0o600); await file.close();
    return { id, chunkBytes: TRANSFER_CHUNK_BYTES };
  }
  const { state, entry } = await entryFor(controller, args.id);
  if (args.action === 'dispose') {
    state.entries.delete(args.id); await rm(entry.path, { force: true }); return { disposed: true };
  }
  if (args.action === 'read') {
    if (entry.kind !== 'download' || !Number.isSafeInteger(args.index) || args.index < 0) throw fail('Invalid download chunk.');
    const offset = args.index * TRANSFER_CHUNK_BYTES;
    if (offset >= entry.bytes) throw fail('Download chunk is outside this document.');
    const file = await open(entry.path, 'r');
    try {
      const bytes = Buffer.alloc(Math.min(TRANSFER_CHUNK_BYTES, entry.bytes - offset));
      const result = await file.read(bytes, 0, bytes.length, offset);
      if (result.bytesRead !== bytes.length) throw fail('Document transfer file changed.');
      return { index: args.index, data: bytes.toString('base64') };
    } finally { await file.close(); }
  }
  if (entry.kind === 'download' || entry.complete) throw fail('This document transfer cannot accept more bytes.');
  if (args.action === 'append') {
    if (args.index !== entry.index || typeof args.data !== 'string' || args.data.length > Math.ceil(TRANSFER_CHUNK_BYTES / 3) * 4 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(args.data)) throw fail('Document chunks must arrive once in order.');
    const bytes = Buffer.from(args.data, 'base64');
    if (!bytes.length || entry.received + bytes.length > entry.bytes) throw fail('Document chunk exceeds its declared size.');
    const file = await open(entry.path, 'a');
    try { await file.writeFile(bytes); } finally { await file.close(); }
    entry.hash.update(bytes); entry.received += bytes.length; entry.index++;
    return { index: entry.index, received: entry.received };
  }
  if (args.action === 'finish') {
    if (entry.received !== entry.bytes || entry.hash.digest('hex') !== entry.sha256) {
      state.entries.delete(args.id); await rm(entry.path, { force: true }); throw fail('Document checksum or length does not match.');
    }
    const rawPath = entry.path + '.json'; let size = 0;
    try {
      await pipeline(createReadStream(entry.path), createGunzip(), meter(entry.rawBytes, (_, total) => { size = total; }),
        createWriteStream(rawPath, { flags: 'wx', mode: 0o600 }));
      if (size !== entry.rawBytes) throw fail('Decompressed document length does not match.');
      await rm(entry.path, { force: true }); entry.path = rawPath; entry.complete = true; delete entry.hash;
      return { id: args.id, ready: true };
    } catch (error) {
      state.entries.delete(args.id); await Promise.all([rm(entry.path, { force: true }), rm(rawPath, { force: true })]); throw error;
    }
  }
  throw fail('Unknown document transfer action.');
}
export async function closeTransfers(controller) {
  const state = stores.get(controller); stores.delete(controller);
  if (state) await rm(state.dir, { recursive: true, force: true });
}
export const transferTool = { name: 'canvas_transfer', description: 'App-only bounded document byte transfer for this exact canvas. Gzip chunks and integrity checks; no model document payloads.',
  inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['start', 'append', 'finish', 'read', 'dispose'] },
    id: { type: 'string' }, kind: { type: 'string', enum: ['snapshot', 'body'] }, bytes: { type: 'integer' }, rawBytes: { type: 'integer' },
    sha256: { type: 'string' }, index: { type: 'integer' }, data: { type: 'string', maxLength: 262144 } }, required: ['action'], additionalProperties: false },
  annotations: { destructiveHint: false, openWorldHint: false }, _meta: { ui: { visibility: ['app'] } } };
