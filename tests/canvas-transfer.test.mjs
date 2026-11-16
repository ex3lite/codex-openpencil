import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { dispatchTransfer, consumeTransfer, downloadTransfer, closeTransfers } from '../plugins/openpencil/scripts/canvas-transfer.mjs';
import { TRANSFER_CHUNK_BYTES, DOCUMENT_ENVELOPE_BYTES } from '../plugins/openpencil/scripts/document-limits.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const owner = () => ({ session: { assertLive() {} }, documentId: 'document-one' });
async function upload(controller, raw, overrides = {}) {
  const bytes = gzipSync(raw);
  const start = await dispatchTransfer(controller, { action: 'start', kind: 'snapshot', bytes: bytes.length,
    rawBytes: raw.length, sha256: hash(bytes), ...overrides });
  for (let offset = 0, index = 0; offset < bytes.length; offset += TRANSFER_CHUNK_BYTES, index++) {
    await dispatchTransfer(controller, { action: 'append', id: start.id, index, data: bytes.subarray(offset, offset + TRANSFER_CHUNK_BYTES).toString('base64') });
  }
  return start;
}
test('multi-chunk gzip upload is exact, consumed once, and document-bound', async t => {
  const controller = owner(); t.after(() => closeTransfers(controller));
  const raw = Buffer.from(JSON.stringify({ pages: [{ id: 'first', image: randomBytes(900_000).toString('base64') }, { id: 'last', text: '日本語 Привет' }] }));
  const { id } = await upload(controller, raw);
  await dispatchTransfer(controller, { action: 'finish', id });
  assert.equal(await consumeTransfer(controller, id, 'snapshot'), raw.toString());
  await assert.rejects(consumeTransfer(controller, id, 'snapshot'), { code: 'DOCUMENT_TRANSFER_INVALID' });
  const another = await upload(controller, raw); controller.documentId = 'different-document';
  await assert.rejects(dispatchTransfer(controller, { action: 'finish', id: another.id }), { code: 'DOCUMENT_TRANSFER_INVALID' });
});
test('corruption, repeated chunks and oversized declared documents fail closed', async t => {
  const controller = owner(); t.after(() => closeTransfers(controller));
  const raw = Buffer.from('{"pages":[]}'), bytes = gzipSync(raw);
  const { id } = await upload(controller, raw, { sha256: 'a'.repeat(64) });
  await assert.rejects(dispatchTransfer(controller, { action: 'append', id, index: 0, data: bytes.toString('base64') }), { code: 'DOCUMENT_TRANSFER_INVALID' });
  await assert.rejects(dispatchTransfer(controller, { action: 'finish', id }), { code: 'DOCUMENT_TRANSFER_INVALID' });
  await assert.rejects(dispatchTransfer(controller, { action: 'start', kind: 'snapshot', bytes: bytes.length, rawBytes: DOCUMENT_ENVELOPE_BYTES + 1, sha256: hash(bytes) }), { code: 'DOCUMENT_TRANSFER_INVALID' });
  const bomb = await upload(controller, Buffer.alloc(1024 * 1024), { rawBytes: 10 });
  await assert.rejects(dispatchTransfer(controller, { action: 'finish', id: bomb.id }), { code: 'DOCUMENT_TRANSFER_INVALID' });
});
test('download chunks reconstruct all bytes with bounded chunks and verified checksum', async t => {
  const controller = owner(); t.after(() => closeTransfers(controller));
  const raw = randomBytes(1024 * 1024);
  const transfer = await downloadTransfer(controller, raw), parts = [];
  for (let index = 0; index < Math.ceil(transfer.bytes / transfer.chunkBytes); index++) {
    const chunk = await dispatchTransfer(controller, { action: 'read', id: transfer.id, index });
    assert.ok(chunk.data.length <= 262144); parts.push(Buffer.from(chunk.data, 'base64'));
  }
  const encoded = Buffer.concat(parts);
  assert.equal(hash(encoded), transfer.sha256); assert.deepEqual(gunzipSync(encoded), raw);
  await dispatchTransfer(controller, { action: 'dispose', id: transfer.id });
  await assert.rejects(dispatchTransfer(controller, { action: 'read', id: transfer.id, index: 0 }));
});
test('browser adapter transfers a large snapshot without a large App call or model payload', async t => {
  const controller = owner(); t.after(() => closeTransfers(controller));
  const context = vm.createContext({ crypto: globalThis.crypto, TextEncoder, Uint8Array, Response, Blob, CompressionStream, DecompressionStream, btoa, atob });
  vm.runInContext(await readFile(new URL('../plugins/openpencil/ui/native-transfer.js', import.meta.url), 'utf8'), context);
  const adapter = vm.runInContext('nativeTransfer', context), sizes = [];
  const call = async (name, args) => { sizes.push(Buffer.byteLength(JSON.stringify(args))); return { _meta: { transfer: await dispatchTransfer(controller, args) } }; };
  const raw = JSON.stringify({ pages: Array.from({ length: 77 }, (_, i) => ({ id: `p${i}`, image: randomBytes(4000).toString('base64') })) });
  const args = await adapter.prepare(call, 'canvas_autosave', { docJson: raw });
  assert.equal(args.docJson, ''); assert.ok(args.snapshotToken); assert.ok(Math.max(...sizes) < 270000);
  assert.equal(await consumeTransfer(controller, args.snapshotToken, 'snapshot'), raw);
  const transfer = await downloadTransfer(controller, Buffer.from(raw));
  assert.equal(await (await adapter.download(call, transfer)).text(), raw);
});
