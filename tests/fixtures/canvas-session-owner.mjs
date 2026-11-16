import { startCanvasSessionBroker, callCanvasSession } from '../../plugins/openpencil/scripts/canvas-session-broker.mjs';
import { setTimeout as delay } from 'node:timers/promises';

const options = JSON.parse(process.argv[2]);
if (options.client) {
  try {
    const result = await callCanvasSession(options.identity, options.name, options.args);
    process.send({ result, pid: process.pid });
  } catch (error) { process.send({ error: { code: error.code, message: error.message, uncertain: error.uncertain }, pid: process.pid }); }
  process.disconnect();
} else {
  let documentId = 'document-a', version = 0, queue = Promise.resolve(), active = 0, maxActive = 0;
  const events = [];
  const toolResult = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
  const enqueue = work => { const result = queue.then(work); queue = result.catch(() => {}); return result; };
  const dispatch = (name, args) => enqueue(async () => {
    active++; maxActive = Math.max(maxActive, active); events.push({ name, documentId });
    try {
      if (name === 'canvas_document_open') { await delay(25); documentId = args.documentId; version++; }
      if (name === 'canvas_comment_create') {
        version++;
        if (args.text === 'delay-ack') await delay(250);
        if (args.text === 'throw-after-write') throw new Error('Uncertain internal failure');
        if (args.text === 'throw-coded-after-write') throw Object.assign(new Error('Uncertain filesystem failure'), { code: 'EIO' });
      }
      if (name === 'canvas_comment_update') return { content: [{ type: 'text', text: 'Comment was not found.' }],
        isError: true, structuredContent: { code: 'COMMENT_NOT_FOUND' } };
      const result = toolResult({ documentId, version, ownerPid: process.pid, events: events.length });
      if (name === 'open_canvas') result._meta = {
        canvas: { token: 'fixture-private-native-grant', editorOrigin: 'http://127.0.0.1:1' },
        canvasSession: { projectRoot: options.projectRoot, sessionId: options.sessionId },
      };
      if (name === 'canvas_native_request') result._meta = {
        nativeHttp: { status: 200, type: 'application/json', body: Buffer.from(JSON.stringify({ documentId, version })).toString('base64') },
      };
      return result;
    } finally { active--; }
  });
  const broker = await startCanvasSessionBroker({ ...options, dispatch });
  process.send({ ready: true, identity: broker.identity, pid: process.pid });
  process.on('message', async message => {
    if (message === 'inspect') process.send({ events, maxActive, documentId, version });
    if (message === 'close') { await queue; await broker.close(); process.send({ closed: true }); process.disconnect(); }
  });
}
