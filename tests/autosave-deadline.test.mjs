import test from 'node:test';
import assert from 'node:assert/strict';
import {CanvasPersistence} from '../plugins/openpencil/scripts/canvas-persistence.mjs';

test('continuous edit notifications keep a fixed autosave deadline', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  let saved=0;
  const persistence=new CanvasPersistence({session:{},documentId:'00000000-0000-4000-8000-000000000001',project:{directory:'/private/tmp/openbrush-deadline-test'}},{debounceMs:10000,maxWaitMs:25});
  persistence.controller.enqueue=work=>Promise.resolve().then(work);
  persistence.persist=async()=>{saved++;};
  t.after(()=>persistence.dispose());
  persistence.changed();
  const deadline=persistence.deadline;
  for(let i=0;i<4;i++){
    t.mock.timers.tick(3);
    persistence.changed();
    assert.equal(persistence.deadline,deadline,'new edits cannot reset the deadline');
  }
  t.mock.timers.tick(40);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(saved,1);
  assert.equal(persistence.deadline,null);
});
