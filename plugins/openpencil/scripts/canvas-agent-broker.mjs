import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, writeFile, readFile, realpath, lstat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { stateRoot, sha256 } from './editor-runtime.mjs';

const MAX_BYTES = 32 * 1024 * 1024;
const fail = (code, message) => Object.assign(new Error(message), { code });
const validId = id => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id);

async function location(canvasId, { registryDir = join(stateRoot(), 'agent-sessions'), projectRoot = process.cwd() } = {}) {
  if (!validId(canvasId)) throw fail('INVALID_CANVAS_ID', 'Use the canvas ID supplied by the parent agent.');
  const project = await realpath(projectRoot);
  return { project, dir: join(registryDir, sha256(project).slice(0, 32)), file: `${canvasId}.json` };
}

async function secureDirectory(dir, create = false) {
  if (create) await mkdir(dir, { recursive: true, mode: 0o700 });
  const stat = await lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== 'win32' &&
      ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()))) throw fail('UNSAFE_SESSION_REGISTRY', 'Canvas agent registry must be a private directory owned by this user.');
}

/** Only the parent bridge owns enrollment. Children receive canvasId + leaseId. */
export async function startCanvasAgentBroker(agents, options = {}) {
  const { project, dir, file } = await location(agents.canvasId, options);
  await secureDirectory(dir, true);
  const token = randomBytes(32).toString('base64url');
  let host;
  const server = http.createServer(async (req, res) => {
    const reply = (status, value) => {
      if (res.destroyed || res.headersSent) return;
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value));
    };
    const offered = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
    const expected = Buffer.from(`Bearer ${token}`), offeredBytes = Buffer.from(offered);
    if (req.headers.host !== host || req.headers.origin || offeredBytes.length !== expected.length ||
        !timingSafeEqual(offeredBytes, expected)) {
      req.resume(); reply(403, { error: { code: 'SESSION_UNAUTHORIZED', message: 'Canvas agent connection is not authorized.' } }); return;
    }
    if (req.method !== 'POST' || req.url !== '/agents') { req.resume(); reply(404, { error: { code: 'SESSION_ROUTE', message: 'Unknown canvas agent route.' } }); return; }
    try {
      let size = 0; const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BYTES) { reply(413, { error: { code: 'REQUEST_TOO_LARGE', message: 'Canvas agent request exceeds 32 MiB.' } }); req.destroy(); return; }
        chunks.push(chunk);
      }
      let message;
      try { message = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw fail('INVALID_REQUEST', 'Expected a JSON agent request.'); }
      if (!message || message.canvasId !== agents.canvasId || typeof message.action !== 'string' ||
          !message.arguments || typeof message.arguments !== 'object' || Array.isArray(message.arguments)) throw fail('INVALID_REQUEST', 'Expected this canvas ID and a scoped agent operation.');
      reply(200, { result: await (options.dispatch || ((action,args)=>agents.dispatch(action,args)))(message.action, message.arguments) });
    } catch (error) { reply(400, { error: { code: error.code || 'AGENT_OPERATION_FAILED', message: error.code ? error.message : 'Canvas agent operation failed.', ...(error.details && { details: error.details }) } }); }
  });
  server.requestTimeout = 30_000; server.headersTimeout = 10_000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  host = `127.0.0.1:${server.address().port}`;
  const path = join(dir, file);
  try { await writeFile(path, JSON.stringify({ schemaVersion: 1, canvasId: agents.canvasId, project, port: server.address().port, token }), { mode: 0o600, flag: 'wx' }); }
  catch (error) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); throw error; }
  return { canvasId: agents.canvasId, close: async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(path, { force: true });
  } };
}

/** Reconnect by explicit canvas ID within this project; never discover another chat. */
export async function callCanvasAgent(canvasId, action, args, options = {}) {
  const { project, dir, file } = await location(canvasId, options);
  let descriptor;
  try {
    await secureDirectory(dir);
    const path = join(dir, file), stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096 || (process.platform !== 'win32' &&
        ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()))) throw fail('UNSAFE_SESSION_REGISTRY', 'Canvas session descriptor must be a private file owned by this user.');
    descriptor = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'UNSAFE_SESSION_REGISTRY') throw error;
    throw fail('SESSION_NOT_FOUND', 'The assigned canvas is not available in this project. Keep the parent canvas open.');
  }
  if (descriptor.schemaVersion !== 1 || descriptor.canvasId !== canvasId || descriptor.project !== project ||
      !Number.isInteger(descriptor.port) || descriptor.port < 1 || descriptor.port > 65535 ||
      typeof descriptor.token !== 'string' || !/^[a-zA-Z0-9_-]{43}$/.test(descriptor.token)) throw fail('INVALID_SESSION', 'Canvas session descriptor is invalid.');
  const body = JSON.stringify({ canvasId, action, arguments: args });
  if (Buffer.byteLength(body) > MAX_BYTES) throw fail('REQUEST_TOO_LARGE', 'Canvas agent request exceeds 32 MiB.');
  let response, value;
  try {
    response = await fetch(`http://127.0.0.1:${descriptor.port}/agents`, { method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${descriptor.token}` }, body, signal: AbortSignal.timeout(30_000) });
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length; if (size > MAX_BYTES) throw new Error('Oversized reply'); chunks.push(chunk);
    }
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch { throw fail(action === 'apply' ? 'UNCERTAIN_WRITE' : 'SESSION_UNAVAILABLE', action === 'apply'
    ? 'The agent write outcome is unknown. Read the assigned roots before deciding what to do next.'
    : 'The parent canvas connection is unavailable.'); }
  if (value.error) throw Object.assign(fail(value.error.code || 'AGENT_OPERATION_FAILED', value.error.message || 'Canvas agent operation failed.'), { details: value.error.details });
  if (!response.ok || !value.result || typeof value.result !== 'object') throw fail(action === 'apply' ? 'UNCERTAIN_WRITE' : 'INVALID_RESPONSE', 'Canvas agent acknowledgement is invalid.');
  return value.result;
}
