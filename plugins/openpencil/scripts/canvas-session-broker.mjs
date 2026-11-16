import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, writeFile, realpath, lstat, open, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { stateRoot, sha256 } from './editor-runtime.mjs';
import { nativeRoute } from './native-canvas.mjs';

const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
// Native HTTP bodies can already be 32 MiB before base64 encoding in _meta.
const MAX_RESPONSE_BYTES = 48 * 1024 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const READ_TOOLS = new Set(['open_canvas', 'canvas_status', 'canvas_selection', 'canvas_documents',
  'canvas_comments', 'canvas_agents', 'canvas_codegen_poll', 'canvas_history', 'canvas_history_status', 'canvas_history', 'canvas_history_status', 'canvas_community_search', 'canvas_community_file', 'canvas_fonts_status', 'canvas_fonts_library','canvas_icon_pack_list','canvas_icon_pack_search','canvas_icon_pack_check']);
const APP_TOOLS = new Set([...READ_TOOLS, 'canvas_transfer', 'canvas_native_request', 'canvas_document_open', 'canvas_document_import',
  'canvas_comment_create', 'canvas_comment_update', 'canvas_detach_source', 'canvas_checkpoint', 'canvas_save',
  'canvas_codegen_prepare', 'canvas_codegen_cancel', 'canvas_autosave', 'canvas_history_restore', 'canvas_autosave', 'canvas_history_restore', 'canvas_community_import', 'canvas_community_settings', 'canvas_fonts_prepare','canvas_icon_pack_acquire','canvas_icon_pack_select','canvas_icon_pack_update']);
const fail = (code, message, uncertain = false) => Object.assign(new Error(message), { code, ...(uncertain && { uncertain: true }) });
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const uncertain = () => fail('UNCERTAIN_WRITE', 'The canvas operation may have applied. Inspect the current document before deciding what to do next; it was not retried.', true);

/** Shared by local owner routing and HTTP forwarding; it never dispatches. */
export function validateCanvasSessionOperation(name, args = {}) {
  if (!APP_TOOLS.has(name) || !record(args)) throw fail('SESSION_TOOL_DENIED', 'This operation is not available through the canvas App session.');
  if (name === 'open_canvas' && Object.keys(args).length) {
    throw fail('SESSION_TOOL_DENIED', 'The App may only attach to the existing owner canvas. Use the project controls to switch documents.');
  }
  if (name === 'canvas_native_request') {
    if (Object.keys(args).some(key => !['path', 'method', 'body', 'bodyToken'].includes(key)) ||
        (args.method !== undefined && !['GET', 'POST'].includes(args.method)) ||
        (args.body !== undefined && typeof args.body !== 'string') ||
        (args.bodyToken !== undefined && typeof args.bodyToken !== 'string')) throw fail('SESSION_TOOL_DENIED', 'Invalid native canvas request.');
    try { nativeRoute(args.path, args.method || 'GET'); }
    catch { throw fail('SESSION_TOOL_DENIED', 'This native route is not available through the canvas App session.'); }
    return { mutation: args.method === 'POST' };
  }
  if(name==='canvas_transfer')return {mutation:false};
  return { mutation: !READ_TOOLS.has(name) };
}

async function location(value = {}) {
  if (!record(value)) throw fail('PROJECT_ROOT_REQUIRED', 'Attach with the explicit project and session supplied by the canvas owner.');
  const { projectRoot, sessionId, registryDir = join(stateRoot(), 'canvas-sessions') } = value;
  if (typeof projectRoot !== 'string' || !isAbsolute(projectRoot)) throw fail('PROJECT_ROOT_REQUIRED', 'Attach with the explicit absolute project root supplied by the canvas owner.');
  if (typeof sessionId !== 'string' || !UUID.test(sessionId)) throw fail('INVALID_SESSION_ID', 'Attach with the explicit session ID supplied by the canvas owner.');
  let project;
  try {
    project = await realpath(projectRoot);
    if (!(await lstat(project)).isDirectory()) throw new Error();
  } catch { throw fail('PROJECT_NOT_FOUND', 'The specified canvas project directory is unavailable.'); }
  return { project, dir: join(registryDir, sha256(project).slice(0, 32)), file: `${sessionId}.json` };
}

function privateMode(stat) {
  return process.platform === 'win32' || ((stat.mode & 0o077) === 0 && stat.uid === process.getuid());
}

async function secureDirectory(dir, create = false) {
  if (create) await mkdir(dir, { recursive: true, mode: 0o700 });
  const stat = await lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !privateMode(stat)) {
    throw fail('UNSAFE_SESSION_REGISTRY', 'Canvas session registry must be a private directory owned by this user.');
  }
}

async function readDescriptor(path) {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size > 4096 || !privateMode(before)) {
    throw fail('UNSAFE_SESSION_REGISTRY', 'Canvas session descriptor must be a private file owned by this user.');
  }
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const current = await file.stat();
    if (!current.isFile() || current.size > 4096 || !privateMode(current) || current.ino !== before.ino || current.dev !== before.dev) {
      throw fail('UNSAFE_SESSION_REGISTRY', 'Canvas session descriptor changed while opening it.');
    }
    const bytes = await file.readFile();
    if (bytes.length > 4096) throw fail('UNSAFE_SESSION_REGISTRY', 'Canvas session descriptor exceeds its size limit.');
    return JSON.parse(bytes.toString('utf8'));
  } finally { await file.close(); }
}

async function readBody(stream, limit) {
  let size = 0; const chunks = [];
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > limit) throw fail('SESSION_MESSAGE_TOO_LARGE', 'Canvas session message exceeds its size limit.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Owner lifetime, not document lifetime. dispatch(name,args) must serialize owner access. */
export async function startCanvasSessionBroker({ projectRoot, sessionId, dispatch, registryDir } = {}) {
  if (typeof dispatch !== 'function') throw new TypeError('Canvas session broker requires an owner dispatch function.');
  const { project, dir, file } = await location({ projectRoot, sessionId, registryDir });
  await secureDirectory(dir, true);
  const identity = Object.freeze({ projectRoot: project, sessionId });
  const token = randomBytes(32).toString('base64url'), expected = Buffer.from(`Bearer ${token}`);
  let host, closing;
  const server = http.createServer(async (req, res) => {
    const reply = (status, value) => {
      if (res.destroyed || res.headersSent) return;
      let body;
      try { body = JSON.stringify(value); } catch { body = ''; }
      if (!body || Buffer.byteLength(body) > MAX_RESPONSE_BYTES) {
        status = 500; body = JSON.stringify({ error: { code: 'INVALID_SESSION_RESPONSE', message: 'Canvas owner acknowledgement could not be delivered.' } });
      }
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(body);
    };
    const offered = Buffer.from(typeof req.headers.authorization === 'string' ? req.headers.authorization : '');
    if (req.headers.host !== host || Object.hasOwn(req.headers, 'origin') || offered.length !== expected.length || !timingSafeEqual(offered, expected)) {
      req.resume(); reply(403, { error: { code: 'SESSION_UNAUTHORIZED', message: 'Canvas session connection is not authorized.' } }); return;
    }
    if (req.method !== 'POST' || req.url !== '/canvas-session') {
      req.resume(); reply(404, { error: { code: 'SESSION_ROUTE', message: 'Unknown canvas session route.' } }); return;
    }
    let started = false, mutation = false;
    try {
      let message;
      try { message = JSON.parse(await readBody(req, MAX_REQUEST_BYTES)); }
      catch (error) { if (error.code === 'SESSION_MESSAGE_TOO_LARGE') throw error; throw fail('INVALID_SESSION_REQUEST', 'Expected a JSON canvas session request.'); }
      if (!record(message) || message.sessionId !== sessionId || !record(message.arguments) ||
          Object.keys(message).some(key => !['sessionId', 'name', 'arguments'].includes(key))) {
        throw fail('INVALID_SESSION_REQUEST', 'Expected this session ID and an App tool operation.');
      }
      ({ mutation } = validateCanvasSessionOperation(message.name, message.arguments));
      started = true;
      const result = await dispatch(message.name, message.arguments);
      if (!record(result) || !Array.isArray(result.content)) throw mutation ? uncertain() : fail('INVALID_SESSION_RESPONSE', 'Canvas owner did not return an MCP tool result.');
      reply(200, { result });
    } catch (error) {
      // Unstructured/system exceptions after dispatch do not prove that the write failed.
      if (started && mutation && (typeof error.code !== 'string' || !/^[A-Z]+_[A-Z0-9_]+$/.test(error.code))) error = uncertain();
      const code = typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : 'SESSION_DISPATCH_FAILED';
      const message = error.code && typeof error.message === 'string' ? error.message.replaceAll(token, '[redacted]') : 'Canvas owner could not complete the operation.';
      const status = code === 'SESSION_TOOL_DENIED' ? 403 : code === 'SESSION_MESSAGE_TOO_LARGE' ? 413 : 400;
      reply(status, { error: { code, message, ...((error.uncertain || code.includes('UNCERTAIN')) && { uncertain: true }) } });
    }
  });
  server.requestTimeout = 30_000; server.headersTimeout = 10_000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  host = `127.0.0.1:${server.address().port}`;
  const path = join(dir, file);
  try {
    await writeFile(path, JSON.stringify({ schemaVersion: 1, ...identity, port: server.address().port, token }), { mode: 0o600, flag: 'wx' });
  } catch (error) {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    throw fail(error.code === 'EEXIST' ? 'SESSION_ALREADY_EXISTS' : 'SESSION_PUBLISH_FAILED', 'This canvas session could not be published. Existing owner records were preserved.');
  }
  return { identity, close: () => {
    if (!closing) closing = (async () => {
      // A stale owner must not remove a newer descriptor with the same ID.
      try { if ((await readDescriptor(path)).token === token) await rm(path, { force: true }); }
      catch (error) { if (error.code !== 'ENOENT' && error.code !== 'UNSAFE_SESSION_REGISTRY') throw error; }
      finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    })();
    return closing;
  } };
}

/** Return the complete MCP tool result. Identity belongs only in tool-result _meta. */
export async function callCanvasSession(identity, name, args = {}) {
  const { mutation } = validateCanvasSessionOperation(name, args);
  const { project, dir, file } = await location(identity);
  let descriptor;
  try { await secureDirectory(dir); descriptor = await readDescriptor(join(dir, file)); }
  catch (error) {
    if (error.code === 'UNSAFE_SESSION_REGISTRY') throw error;
    throw fail('SESSION_NOT_FOUND', 'The specified canvas session is unavailable in this project. Keep its owner chat open.');
  }
  if (descriptor.schemaVersion !== 1 || descriptor.projectRoot !== project || descriptor.sessionId !== identity.sessionId ||
      !Number.isInteger(descriptor.port) || descriptor.port < 1 || descriptor.port > 65535 ||
      typeof descriptor.token !== 'string' || !/^[a-zA-Z0-9_-]{43}$/.test(descriptor.token)) throw fail('INVALID_SESSION', 'Canvas session descriptor is invalid.');
  const longOperation = ['open_canvas', 'canvas_document_open', 'canvas_document_import', 'canvas_community_import', 'canvas_autosave', 'canvas_save', 'canvas_history_restore', 'canvas_icon_pack_acquire', 'canvas_icon_pack_update', 'canvas_fonts_prepare'].includes(name) || name === 'canvas_native_request' && args.path === '/api/mcp/document';
  const timeoutMs = identity.timeoutMs ?? (longOperation ? 120_000 : 30_000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw fail('INVALID_SESSION_TIMEOUT', 'Canvas session timeout must be between 1 and 120000 milliseconds.');
  const body = JSON.stringify({ sessionId: identity.sessionId, name, arguments: args });
  if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) throw fail('SESSION_MESSAGE_TOO_LARGE', 'Canvas session request exceeds its size limit.');
  let response, value;
  try {
    response = await fetch(`http://127.0.0.1:${descriptor.port}/canvas-session`, { method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${descriptor.token}` }, body, signal: AbortSignal.timeout(timeoutMs) });
    value = JSON.parse(await readBody(response.body, MAX_RESPONSE_BYTES));
  } catch { throw mutation ? uncertain() : fail('SESSION_UNAVAILABLE', 'The specified canvas owner connection is unavailable.'); }
  if (record(value?.error)) {
    if (mutation && ['INVALID_SESSION_RESPONSE', 'SESSION_DISPATCH_FAILED'].includes(value.error.code)) throw uncertain();
    throw fail(value.error.code || 'SESSION_OPERATION_FAILED', value.error.message || 'Canvas session operation failed.', value.error.uncertain === true || value.error.code === 'UNCERTAIN_WRITE');
  }
  if (!response.ok || !record(value?.result) || !Array.isArray(value.result.content)) throw mutation ? uncertain() : fail('INVALID_SESSION_RESPONSE', 'Canvas owner acknowledgement is invalid.');
  return value.result;
}
