import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CanvasController } from '../plugins/openpencil/scripts/canvas-controller.mjs';
import { diskDocument } from '../plugins/openpencil/scripts/document-format.mjs';
import { sourceBytes } from '../plugins/openpencil/scripts/editor-session.mjs';

const output = await mkdtemp('/private/tmp/openbrush-history-smoke-');
const projectRoot = join(output, 'project'); await mkdir(projectRoot);
process.env.OPENPENCIL_CODEX_STATE_DIR = join(output, 'state');
const runtimeRoot = process.argv[2];
if (!runtimeRoot) throw Error('Provide an explicit runtime path.');
const controller = new CanvasController({ projectRoot, runtimeRoot });
const report = { output, projectRoot, runtimeRoot, ok: false };
try {
  const opened = (await controller.open({ projectRoot })).structuredContent;
  assert.ok(opened.filePath, 'A new canvas must immediately have a project .op');
  const initial = (await controller.persistence.list()).entries[0];
  const live = await controller.session.document();
  const result = await controller.call('canvas_native_request', { path: '/api/mcp/document', method: 'POST',
    body: JSON.stringify({ document: { version: '0.8.5', children: [{ id: 'smoke-frame', type: 'frame', name: 'History smoke',
      x: 0, y: 0, width: 320, height: 200, fill: [{ type: 'solid', color: '#3B82F6' }] }] }, baseVersion: live.version }) });
  assert.equal(result._meta.nativeHttp.status, 200);
  await controller.persistence.boundary();
  const edited = await controller.session.document();
  assert.equal(JSON.parse(await sourceBytes(controller.session.source)).children[0].id, 'smoke-frame');
  const restored = await controller.restoreHistory({ id: initial.id, docJson: JSON.stringify(diskDocument(edited)) });
  const after = await controller.session.document();
  assert.deepEqual(after.document.children, []);
  assert.deepEqual(JSON.parse(await readFile(controller.session.source)).children, []);
  assert.equal(restored.history.entries[0].source, 'restore');
  const versions = restored.history.entries;
  const duplicate = await controller.persistence.flush();
  assert.equal(duplicate.autosave.state, 'saved');
  report.ok = true; report.filePath = controller.session.source; report.initialVersion = live.version;
  report.editedVersion = edited.version; report.restoredVersion = after.version;
  report.history = versions.map(({ id, source, sha256, restoredFrom }) => ({ id, source, sha256, restoredFrom }));
} finally {
  await controller.close();
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report, null, 2));
