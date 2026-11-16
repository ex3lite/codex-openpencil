#!/usr/bin/env node
import { once } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discover, errorReply, MAX_BYTES, parsePort } from './transport.mjs';
import { CanvasController } from './canvas-controller.mjs';

function optionsFromArgs(args) {
  const options = { port: process.env.OPENPENCIL_MCP_PORT };
  let doctor = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--doctor') doctor = true;
    else if (args[i] === '--port' && args[i + 1]) options.port = parsePort(args[++i]);
    else throw new Error('Usage: node mcp-bridge.mjs [--doctor] [--port PORT]');
  }
  if (options.port !== undefined) options.port = parsePort(options.port);
  return { options, doctor };
}

export async function serve(options = {}, { input = process.stdin, output = process.stdout,
  createController = value => new CanvasController(value), rootsTimeout = 5000 } = {}) {
  const write = async reply => {
    if (reply && !output.write(`${JSON.stringify(reply)}\n`)) await once(output, 'drain');
  };
  let rootsSupported = false, requestId = 0, closed = false, processing = Promise.resolve(), failure;
  const pending = new Map();
  const rootError = (code, message) => Object.assign(new Error(message), { code });
  const resolveRoots = async () => {
    if (!rootsSupported) return undefined;
    if (closed) throw rootError('PROJECT_ROOT_UNAVAILABLE', 'Соединение с Codex закрыто. Откройте холст заново из текущего чата.');
    const id = `openpencil:roots:${++requestId}`;
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(rootError('PROJECT_ROOT_UNAVAILABLE', 'Codex не передал папку текущего чата вовремя. Повторите открытие холста.'));
      }, rootsTimeout);
      pending.set(id, { resolve, reject, timer });
    });
    response.catch(() => {});
    try {
      await write({ jsonrpc: '2.0', id, method: 'roots/list', params: {} });
      const result = await response;
      if (!result || !Array.isArray(result.roots)) throw rootError('INVALID_PROJECT_ROOTS', 'Codex передал неверный список папок проекта.');
      return result.roots;
    } finally {
      const request = pending.get(id);
      if (request) clearTimeout(request.timer);
      pending.delete(id);
    }
  };
  const canvas = createController({ ...options, resolveRoots,
    onToolsChanged: () => write({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }) });
  const enqueue = work => {
    processing = canvas.enqueue(work);
    processing.catch(error => { failure ||= error; input.destroy(); });
  };
  const accept = message => {
    if (message && typeof message === 'object' && !Object.hasOwn(message, 'method') && Object.hasOwn(message, 'id')) {
      // Client replies must bypass the request queue: its current request may be awaiting roots/list.
      const request = pending.get(message.id);
      if (request) {
        clearTimeout(request.timer); pending.delete(message.id);
        if (message.jsonrpc !== '2.0' || Object.hasOwn(message, 'result') === Object.hasOwn(message, 'error')) {
          request.reject(rootError('INVALID_PROJECT_ROOTS', 'Codex передал некорректный ответ о папке проекта.'));
        } else if (message.error) {
          request.reject(rootError('PROJECT_ROOT_UNAVAILABLE', 'Codex не смог передать папку текущего чата. Откройте холст из сообщения в этом чате.'));
        } else request.resolve(message.result);
      }
      return;
    }
    enqueue(async () => {
      if (message?.method === 'initialize') rootsSupported = Boolean(message.params?.capabilities?.roots &&
        typeof message.params.capabilities.roots === 'object' && !Array.isArray(message.params.capabilities.roots));
      await write(await canvas.dispatch(message));
    });
  };
  const shutdown = () => { input.destroy(); };
  process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  // Keep parsing while serialized edits wait for a reply to a server request.
  try { for await (const chunk of input) {
    buffer += decoder.write(chunk);
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (Buffer.byteLength(line) > MAX_BYTES) throw new Error('MCP input exceeds the size limit.');
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); }
      catch { enqueue(() => write(errorReply(null, -32700, 'Invalid JSON.'))); continue; }
      accept(message);
    }
    if (Buffer.byteLength(buffer) > MAX_BYTES) throw new Error('MCP input exceeds the size limit.');
  }
  buffer += decoder.end();
  if (buffer.trim()) enqueue(() => write(errorReply(null, -32700, 'MCP messages must end with a newline.')));
  } finally {
    process.off('SIGTERM', shutdown); process.off('SIGINT', shutdown);
    closed = true;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(rootError('PROJECT_ROOT_UNAVAILABLE', 'Соединение с Codex закрыто до получения папки проекта.'));
    }
    pending.clear();
    await processing.catch(() => {});
    await canvas.close();
  }
  if (failure) throw failure;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) try {
  const { options, doctor } = optionsFromArgs(process.argv.slice(2));
  if (doctor) {
    const endpoint = await discover(options);
    process.stdout.write(`${JSON.stringify({ ok: true, ...endpoint, transport: 'json-rpc' })}\n`);
  } else await serve(options);
} catch (error) {
  process.stderr.write(`OpenPencil: ${error.message}\n`);
  process.exitCode = 1;
}
