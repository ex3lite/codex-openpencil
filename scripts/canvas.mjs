import { createInterface } from 'node:readline';
import { isAbsolute, join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { CanvasController } from '../plugins/openpencil/scripts/canvas-controller.mjs';

const args = process.argv.slice(2);
const usage = 'Usage: npm run canvas -- --project-root /absolute/project [--file /absolute/design.op]';
if (args.length === 1 && args[0] === '--help') { console.log(usage); process.exit(0); }
const options = {};
for (let i = 0; i < args.length; i += 2) {
  const key = { '--project-root': 'projectRoot', '--file': 'filePath' }[args[i]];
  const value = args[i + 1];
  if (!key || options[key] !== undefined || typeof value !== 'string' || !isAbsolute(value)) throw new Error(usage);
  options[key] = value;
}
if (!options.projectRoot) throw new Error(usage);
const controller = new CanvasController();
// Canonical PTY input truncates JSON design batches at the OS line-buffer limit.
// Raw input lets readline frame complete JSON lines without terminal echo.
const tty = process.stdin.isTTY && typeof process.stdin.setRawMode === 'function';
const previousRawMode = process.stdin.isRaw;
if (tty) process.stdin.setRawMode(true);
const input = createInterface({ input: process.stdin, terminal: false });
let stopping = false;
const shutdown = () => { stopping = true; input.close(); };
const interrupt = chunk => { if (chunk.includes(3) || chunk.includes(4)) shutdown(); };
if (tty) process.stdin.on('data', interrupt);
process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
try {
  const opened = await controller.open(options);
  console.log(JSON.stringify({ ready: true, ...opened.structuredContent,
    input: 'One JSON object per line: {"name":"get_editor_state","arguments":{}}. Send {"quit":true} to close. Never retry a failed write automatically.' }));
  let id = 0;
  for await (const line of input) {
    if (stopping) break;
    if (!line.trim()) continue;
    try {
      const request = JSON.parse(line);
      if (request.quit === true) break;
      const message = request.method ? { ...request, jsonrpc: '2.0', id: ++id }
        : { jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name: request.name, arguments: request.arguments || {} } };
      const reply = await controller.enqueue(() => controller.dispatch(message));
      const imagePaths = new Map();
      for (const [index, item] of (reply?.result?.content || []).entries()) {
        const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[item.mimeType];
        if (item.type !== 'image' || !extension || typeof item.data !== 'string') continue;
        const path = join(controller.session.dir, `preview-${id}-${index}.${extension}`);
        await writeFile(path, Buffer.from(item.data, 'base64'), { flag: 'wx', mode: 0o600 });
        imagePaths.set(item.data, path);
        // Terminal callers can inspect the native image file instead of receiving
        // megabytes of base64 that would be truncated by their shell tool.
        reply.result.content[index] = { type: 'text', text: JSON.stringify({ imagePath: path, mimeType: item.mimeType }) };
      }
      for (const item of reply?.result?.content || []) {
        if (item.type !== 'text') continue;
        try {
          const value = JSON.parse(item.text);
          if (imagePaths.has(value.image_base64)) {
            value.imagePath = imagePaths.get(value.image_base64); delete value.image_base64;
            item.text = JSON.stringify(value);
          }
        } catch { /* Preserve native non-JSON text. */ }
      }
      console.log(JSON.stringify(reply));
    } catch (error) { console.log(JSON.stringify({ error: error.message })); }
  }
} finally {
  input.close();
  process.stdin.off('data', interrupt);
  if (tty) { process.stdin.setRawMode(Boolean(previousRawMode)); process.stdin.pause(); }
  await controller.close();
}
