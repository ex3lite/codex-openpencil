import test from 'node:test';
import assert from 'node:assert/strict';
import { createUiHarness } from './ui-harness.mjs';

test('Russian locale survives initial embedding, editor startup and reconnect', async () => {
  const panel = await createUiHarness('panel');
  assert.equal(new URL(panel.frame.src).searchParams.get('locale'), 'ru');
  panel.frame.emit('load');
  const localeMessages = () => panel.editorMessages.filter(value => value.type === 'op-bridge/locale');
  assert.equal(localeMessages().at(-1)?.locale, 'ru');
  const initIndex = panel.editorMessages.findIndex(value => value.type === 'op-bridge/init');
  const localeIndex = panel.editorMessages.findIndex(value => value.type === 'op-bridge/locale');
  assert.ok(initIndex >= 0 && localeIndex > initIndex, 'Locale is delivered after bridge authentication');
  panel.editor({ type: 'op-bridge/ready', generation: 1, revision: 0 });
  assert.equal(localeMessages().length, 2);
  panel.editor({ type: 'op-bridge/listening' });
  assert.equal(localeMessages().length, 3);
  assert.ok(localeMessages().every(value => value.locale === 'ru' && value.targetOrigin === 'http://127.0.0.1:5678'));
  assert.equal(panel.navigation.length, 1, 'Locale initialization must not reload the document');
  assert.equal(panel.rpcCalls.length, 0, 'Locale initialization must not mutate or save a document');
});
