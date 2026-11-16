import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const source = await readFile(new URL('../plugins/openpencil/ui/native-context-state.js',import.meta.url),'utf8');
const pollSource = await readFile(new URL('../plugins/openpencil/ui/native-context.js',import.meta.url),'utf8');
function helper() {
  const sandbox = vm.createContext({});
  vm.runInContext(source+';globalThis.helper=nativeContextState;',sandbox);
  return sandbox.helper;
}
const state = (id='n1', version=1) => ({project:{projectId:'project',name:'Design',projectRoot:'/private/project'},
  documentId:'doc',canvasId:'canvas',filePath:'/project/main.op',version,
  selection:{pageId:'page',count:1,nodeIds:[id],nodes:[{id,name:id,type:'FRAME',text:'private text'}]},
  comments:[{text:'private comment'}],autosave:{state:'pending'},history:['private history']});
const json = value => JSON.parse(JSON.stringify(value));
const settle = () => new Promise(resolve => setImmediate(resolve));
test('default context contains only project and document identity despite selection, versions and comments',()=>{
  const context=helper().create(); context.observe(state());
  const initial=JSON.stringify(context.payload());
  assert.deepEqual(json(context.payload()),{schemaVersion:1,project:{id:'project',name:'Design'},
    document:{id:'doc',canvasId:'canvas',filePath:'/project/main.op'},attachments:[]});
  context.observe(state('n2',54));
  assert.equal(JSON.stringify(context.payload()),initial);
});
test('explicit attachments remain pinned as selection and document version change',()=>{
  const context=helper().create(), initial=state(); context.observe(initial); context.add();
  const pinned=JSON.stringify(context.payload());
  initial.selection.nodes[0].name='changed after pin';
  context.observe(state('n2',84));
  assert.equal(JSON.stringify(context.payload()),pinned);
  assert.equal(context.attachments[0].capturedVersion,1);
  assert.equal('text' in context.attachments[0].nodes[0],false);
  context.add(); assert.equal(context.attachments.length,2);
  context.add(); assert.equal(context.attachments.length,2);
  context.remove(context.attachments[0].id); assert.equal(context.attachments.length,1);
  context.clear(); assert.equal(context.payload().attachments.length,0);
});
test('document switches reset pins; temporary unavailability clears outgoing targets but preserves local pins',()=>{
  const context=helper().create(); context.observe(state()); context.add();
  context.unavailable(); assert.equal(context.payload().attachments.length,0);
  assert.equal(context.payload().unavailable,true); assert.equal(context.attachments.length,1);
  assert.throws(()=>context.add(),/выделите/);
  context.observe(state()); assert.equal(context.payload().attachments.length,1);
  assert.equal(context.observe({...state(),documentId:'different'}),true);
  assert.equal(context.attachments.length,0);
  context.add(); context.reset(); assert.equal(context.attachments.length,0);
});
test('explicit selection rejects an empty or overlarge attachment',()=>{
  const context=helper().create(); context.observe({...state(),selection:{count:0}});
  assert.throws(()=>context.add(),/выделите/);
  context.observe({...state(),selection:{count:101}});
  assert.throws(()=>context.add(),/100/);
});
test('delivery deduplicates unchanged state, serializes removals, and never creates prompts',async()=>{
  const calls=[], pending=[], statuses=[];
  const delivery=helper().delivery(args=>{calls.push(args);return new Promise(resolve=>pending.push(resolve));},s=>statuses.push(json(s)));
  delivery.update({attachments:['one']}); delivery.update({attachments:[]}); delivery.update({attachments:[]});
  assert.equal(calls.length,1); pending.shift()({}); await settle();
  assert.equal(calls.length,2); assert.deepEqual(JSON.parse(calls[1].content[0].text),{attachments:[]});
  pending.shift()({}); await settle(); delivery.update({attachments:[]});
  assert.equal(calls.length,2); assert.equal(statuses.at(-1).state,'accepted');
  assert.equal('role' in calls[0],false);
});
test('failed identical context waits for explicit retry instead of replaying every poll',async()=>{
  let attempts=0;
  const delivery=helper().delivery(async()=>{attempts++;if(attempts===1)throw Error('offline');return {};},()=>{});
  delivery.update({attachments:[]}); await settle();
  for(let i=0;i<10;i++) delivery.update({attachments:[]});
  await settle(); assert.equal(attempts,1); assert.equal(delivery.status.state,'error');
  delivery.retry(); await settle(); assert.equal(attempts,2); assert.equal(delivery.status.state,'accepted');
});
test('background polls and selection changes never publish model context',async()=>{
  const context=helper().create(),calls=[];let tick,fail=false,current=state();
  const sandbox=vm.createContext({document:{hidden:false},setInterval(fn){tick=fn;},nativeContextState:helper(),
    nativeEditor:{ready:true,async call(name){calls.push(name);if(fail)throw Error('offline');return current;}},
    nativeBridge:{capabilities:{updateModelContext:{}},async request(method,args){calls.push({method,args});return {};}},
    nativeWorkspace:{contextData:()=>context.payload(),update:s=>context.observe(s),contextUnavailable:()=>context.unavailable(),contextDelivery(){},onContextChange(){}}});
  vm.runInContext(pollSource,sandbox);
  await tick();await settle();current=state('n2',2);await tick();await settle();
  fail=true;await tick();await settle();fail=false;await tick();await settle();
  assert.equal(calls.filter(c=>typeof c==='object').length,0);
  assert.ok(calls.every(c=>c==='canvas_panel_state'));
});
