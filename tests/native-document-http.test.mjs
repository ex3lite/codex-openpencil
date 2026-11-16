import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { gunzipSync } from 'node:zlib';
import { nativeDocumentHttp } from '../plugins/openpencil/scripts/native-document-http.mjs';
import { downloadTransfer, dispatchTransfer, closeTransfers } from '../plugins/openpencil/scripts/canvas-transfer.mjs';

test('large closing native responses stream through gzip without undici or document loss', async t => {
  const raw = randomBytes(8 * 1024 * 1024), requests = [];
  const server = http.createServer(async (req, res) => {
    requests.push({ method: req.method, token: req.headers['x-openpencil-token'], path: req.url });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': raw.length, Connection: 'close' });
    await pipeline(Readable.from((function* () { for (let i = 0; i < raw.length; i += 8192) yield raw.subarray(i, i + 8192); })()), res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const controller = { session: { assertLive() {} }, documentId: 'native-stream-test' }; t.after(() => closeTransfers(controller));
  const response = await nativeDocumentHttp(server.address().port, { token: 'local-test-token' });
  assert.equal(response.ok, true);
  const transfer = await downloadTransfer(controller, response.body), chunks = [];
  for (let index = 0; index < Math.ceil(transfer.bytes / transfer.chunkBytes); index++) {
    chunks.push(Buffer.from((await dispatchTransfer(controller, { action: 'read', id: transfer.id, index })).data, 'base64'));
  }
  assert.deepEqual(gunzipSync(Buffer.concat(chunks)), raw);
  assert.deepEqual(requests, [{ method: 'GET', token: 'local-test-token', path: '/api/mcp/document' }]);
});
test('native POST failures dispatch once and redirects never reach a second endpoint', async t => {
  let calls = 0;
  const server = http.createServer(async (req, res) => {
    calls++; for await (const _chunk of req) {};
    res.writeHead(302, { Location: 'http://127.0.0.1:1/private' }); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  await assert.rejects(nativeDocumentHttp(server.address().port, { method: 'POST', body: '{}' }), /redirect/);
  assert.equal(calls, 1);
});
