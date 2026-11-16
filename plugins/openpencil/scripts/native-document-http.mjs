import http from 'node:http';
import { DOCUMENT_ENVELOPE_BYTES } from './document-limits.mjs';

// Node's fetch parser can assert on a large closing response under backpressure.
// Keep document IO on Node streams all the way to the bounded gzip/file sink.
export function nativeDocumentHttp(port, { method = 'GET', token, body, timeout = 60_000 } = {}) {
  return nativeEditorHttp(port,{method,token,body,timeout,path:'/api/mcp/document',limit:DOCUMENT_ENVELOPE_BYTES});
}

export function nativeFontHttp(port,{method='GET',token,body,timeout=30_000,path='/api/mcp/fonts'}={}) {
  if(!/^\/api\/mcp\/fonts(?:\/(?:[a-f0-9]{64}|readiness))?$/.test(path))throw Error('Invalid native font endpoint.');
  return nativeEditorHttp(port,{method,token,body,timeout,path,limit:48*1024*1024});
}

function nativeEditorHttp(port, { method, token, body, timeout, path, limit }) {
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !['GET', 'POST'].includes(method)) throw Error('Invalid native document endpoint.');
  if (body !== undefined && Buffer.byteLength(body) > limit) throw Error('Native document exceeds its size budget.');
  return new Promise((resolve, reject) => {
    let response;
    const request = http.request({ host: '127.0.0.1', port, path, method,
      headers: { 'Content-Type': 'application/json', ...(token && { 'X-OpenPencil-Token': token }),
        ...(body !== undefined && { 'Content-Length': Buffer.byteLength(body) }) } }, incoming => {
      response = incoming;
      incoming.once('close', () => clearTimeout(timer));
      if (incoming.statusCode >= 300 && incoming.statusCode < 400) {
        incoming.resume(); reject(Error('Native document redirects are not supported.')); return;
      }
      resolve({ status: incoming.statusCode, ok: incoming.statusCode >= 200 && incoming.statusCode < 300,
        body: incoming, headers: { get(name) { const value = incoming.headers[name.toLowerCase()]; return Array.isArray(value) ? value.join(', ') : value || null; } },
        async json() {
          const chunks = []; let size = 0;
          for await (const chunk of incoming) {
            size += chunk.length;
            if (size > limit) { incoming.destroy(); throw Error('Native document response exceeds its size budget.'); }
            chunks.push(chunk);
          }
          return JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } });
    });
    const timer = setTimeout(() => {
      const error = Error('Native document request timed out; it was not retried.');
      response?.destroy(error); request.destroy(error);
    }, timeout);
    request.once('error', error => { clearTimeout(timer); reject(error); });
    request.end(body);
  });
}
