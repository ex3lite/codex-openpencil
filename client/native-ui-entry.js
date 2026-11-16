// Build-time dependencies only. The installed plugin runs this local bundle.
import '@ui-sdk/web/toolbar';
import '@ui-sdk/web/drawer';
import '@ui-sdk/web/button';
import { createAgent, registerTools } from '@ui-sdk/web/agent';

const sheet = document.getElementById('workspace-sheet');
const content = document.getElementById('workspace-sheet-content');
const title = document.getElementById('workspace-sheet-title');
let onClose = () => {};
sheet.addEventListener('openchange', event => {
  if (!event.detail.value) onClose();
});
const agent = createAgent();
const unregister = registerTools(agent, {allow:step => !step.confirm});
window.addEventListener('pagehide', unregister, { once: true });
globalThis.nativeUI = {
  agent,
  openPanel(label, wide = false, focus = 'content') {
    title.textContent = label; content.setAttribute('initial-focus',focus);
    content.dataset.wide = String(wide);
    sheet.open = true;
  },
  closePanel() { sheet.open = false; },
  onClose(callback) { onClose = callback; },
  button(label, action, className) {
    const root = document.createElement('ui-button');
    const control = document.createElement('button');
    control.type = 'button'; control.textContent = label;
    if (className) control.className = className;
    root.append(control);
    root.addEventListener('action', event => {
      event.detail.waitUntil(Promise.resolve().then(action).catch(error => {
        nativeEditor.status(error.message, true);
      }));
    });
    return root;
  },
};
