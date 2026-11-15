// Reuse the existing server-side Code panel workflow and its target/version guard.
let nativeCodegenActive, nativeCodegenJob, nativeCodegenPolling = false;
const nativeCodegenSeen = new Set();
function nativeCodegenReply(requestId, fields) {
  nativeEditor.send({ type: 'op-bridge/codegen-response', requestId, ...fields });
}
async function nativeGenerateCode(event) {
  if (!nativeEditor.ready || nativeCodegenSeen.has(event.requestId)) return;
  if (!/^host-\d+-\d+$/.test(event.requestId || '') || !Array.isArray(event.nodeIds)) return;
  nativeCodegenSeen.add(event.requestId); nativeCodegenActive = event.requestId;
  if (nativeCodegenSeen.size > 64) nativeCodegenSeen.delete(nativeCodegenSeen.values().next().value);
  try {
    const snapshot = await nativeEditor.flush();
    if (nativeCodegenActive !== event.requestId) return;
    const job = await nativeEditor.call('canvas_codegen_prepare', { uiRequestId: event.requestId,
      framework: event.framework, pageId: event.pageId, nodeIds: event.nodeIds, docJson: snapshot.docJson });
    if (nativeCodegenActive !== event.requestId) { await nativeEditor.call('canvas_codegen_cancel', { uiRequestId: event.requestId }); return; }
    nativeCodegenJob = job;
    nativeCodegenReply(event.requestId, { code: job.code, notice: 'Напишите в Codex: «Продолжи реализацию»' });
    if (nativeBridge.capabilities.message?.text) {
      try {
        const result = await nativeBridge.request('ui/message', { role: 'user', content: [{ type: 'text', text: job.prompt }] });
        if (nativeCodegenActive === event.requestId && nativeCodegenJob?.status !== 'complete') {
          nativeCodegenReply(event.requestId, { notice: result?.isError ? 'Отправка не подтверждена · Проверьте чат' : 'Передано в Codex для реализации' });
        }
      } catch { if (nativeCodegenActive === event.requestId) nativeCodegenReply(event.requestId, { notice: 'Отправка не подтверждена · Проверьте чат' }); }
    }
  } catch (error) { if (nativeCodegenActive === event.requestId) nativeCodegenReply(event.requestId, { error: error.message }); }
}
nativeEditor.onEvent(event => {
  if (event.type === 'op-shell/document-replaced') {
    nativeCodegenActive = undefined; nativeCodegenJob = undefined;
    return;
  }
  if (event.type === 'op-bridge/codegen-request') void nativeGenerateCode(event);
  if (event.type === 'op-bridge/codegen-cancel' && nativeCodegenActive === event.requestId) {
    nativeCodegenActive = undefined; nativeCodegenJob = undefined;
    void nativeEditor.call('canvas_codegen_cancel', { uiRequestId: event.requestId }).catch(error => nativeEditor.status(error.message, true));
  }
});
setInterval(async () => {
  if (!nativeEditor.ready || !nativeCodegenJob || nativeCodegenPolling || document.hidden) return;
  nativeCodegenPolling = true;
  const expected = nativeCodegenJob.requestId;
  try {
    const job = await nativeEditor.call('canvas_codegen_poll', { afterRevision: nativeCodegenJob.revision });
    if (!job || job.requestId !== expected || nativeCodegenJob?.requestId !== expected) return;
    nativeCodegenJob = job;
    nativeCodegenReply(job.uiRequestId, { code: job.code, notice: job.status === 'complete' ? 'Код готов · Проект в чате Codex' : 'Предпросмотр исходного кода' });
  } catch { /* A poll failure never replays the user's code-generation request. */ }
  finally { nativeCodegenPolling = false; }
}, 1000);
