import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../plugins/openpencil/ui/native-editor.js',import.meta.url),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(fail=false){
  let listener,timerId=0,generation=1,revision=0;const timers=new Map(),calls=[],elements=new Map();
  const element=id=>{if(!elements.has(id))elements.set(id,{addEventListener(){},close(){},dataset:{},value:'',hidden:true});return elements.get(id);};
  const context=vm.createContext({document:{getElementById:element},window:{addEventListener(){}},queueMicrotask,crypto:{randomUUID:()=>String(++timerId)},setTimeout(fn){const id=++timerId;timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id),
    nativeBridge:{onContext(){},onTeardown(){},async call(name,args){calls.push({name,args});if(name==='canvas_autosave'&&fail){if(typeof fail==='function')await fail();else throw Error('external source changed');}return name==='canvas_native_request'?{_meta:{nativeHttp:{status:200}}}:{structuredContent:{filePath:'/project/Test.op'}};}},
    OpenPencilEngine:{documentName(){},selection:()=>'{"nodeIds":[]}',onEvent(fn){listener=fn;},receive(raw){const m=JSON.parse(raw);if(m.type==='op-bridge/snapshot')listener(JSON.stringify({type:'op-bridge/snapshot-result',requestId:m.requestId,docJson:'{}',generation,revision}));}}});
  vm.runInContext(source+'\nglobalThis.editor=nativeEditor;',context);
  context.editor.configure({structuredContent:{filePath:'/project/Test.op'},_meta:{canvas:{token:'fixture'}}});
  const emit=async e=>{generation=e.generation??generation;revision=e.revision??revision;listener(JSON.stringify(e));await tick();};
  const runTimers=async()=>{const entries=[...timers.values()];timers.clear();for(const fn of entries)fn();await tick();await tick();};
  return{emit,runTimers,calls,elements,timers};
}
test('dirty bursts auto-save once without a save dialog',async()=>{
  const f=fixture();await f.emit({type:'op-bridge/ready',generation:1,revision:0});
  for(let revision=1;revision<=2;revision++)await f.emit({type:'op-bridge/dirty-changed',dirty:true,generation:1,revision});
  await f.runTimers();
  assert.equal(f.calls.filter(c=>c.name==='canvas_autosave').length,1);
  assert.equal(f.calls.some(c=>c.name==='canvas_save'),false);
  assert.equal(f.timers.size,0);
});
test('an uncertain autosave error is surfaced and never automatically retried',async()=>{
  const f=fixture(true);await f.emit({type:'op-bridge/ready',generation:1,revision:2});await f.runTimers();
  await f.emit({type:'op-bridge/dirty-changed',dirty:true,generation:1,revision:3});await f.runTimers();
  assert.equal(f.calls.filter(c=>c.name==='canvas_autosave').length,1);
  assert.match(f.elements.get('status-message').textContent,/external source changed/);
});

test('a rejected snapshot waits for a distinct edit before another autosave',async()=>{
  let attempts=0;
  const f=fixture(()=>{if(++attempts===1)throw Object.assign(Error('stale snapshot'),{code:'DOCUMENT_SNAPSHOT_STALE'});});
  await f.emit({type:'op-bridge/ready',generation:1,revision:2});await f.runTimers();
  assert.match(f.elements.get('status-message').textContent,/Файл не изменён/);
  assert.equal(f.timers.size,0);
  await f.emit({type:'op-bridge/dirty-changed',dirty:true,generation:1,revision:2});await f.runTimers();
  assert.equal(attempts,1);
  await f.emit({type:'op-bridge/dirty-changed',dirty:true,generation:1,revision:3});await f.runTimers();
  assert.equal(attempts,2);
  assert.equal(f.timers.size,0);
  assert.equal(f.timers.size,0);
});

test('an explicit Save can present a fresh snapshot after rejection',async()=>{
  let attempts=0;
  const f=fixture(()=>{if(++attempts===1)throw Object.assign(Error('stale snapshot'),{code:'DOCUMENT_SNAPSHOT_STALE'});});
  await f.emit({type:'op-bridge/ready',generation:1,revision:2});await f.runTimers();
  await f.emit({type:'op-shell/save'});
  await tick();
  assert.equal(attempts,2);
  assert.equal(f.elements.get('status-message').textContent,'');
});
