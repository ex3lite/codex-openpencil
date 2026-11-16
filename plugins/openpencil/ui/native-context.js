// Poll editor chrome, but publish only stable identity and explicit attachments.
let nativeContextPolling = false;
const nativeContextDelivery = nativeContextState.delivery(
  params => nativeBridge.request('ui/update-model-context', params),
  status => nativeWorkspace.contextDelivery(status));
function publishNativeContext() {
  if (!nativeBridge.capabilities.updateModelContext) {
    nativeWorkspace.contextDelivery({state:'unsupported'}); return;
  }
  nativeContextDelivery.update(nativeWorkspace.contextData());
}
nativeWorkspace.onContextChange(publishNativeContext, () => nativeContextDelivery.retry());
setInterval(async () => {
  if (!nativeEditor.ready || nativeContextPolling || document.hidden) return;
  nativeContextPolling = true;
  try {
    const state = await nativeEditor.call('canvas_status');
    nativeWorkspace.update(state);
  } catch { nativeWorkspace.contextUnavailable(); }
  finally { nativeContextPolling = false; publishNativeContext(); }
}, 1000);
