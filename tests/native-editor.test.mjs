import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const script=await readFile(new URL('../plugins/openpencil/ui/native-editor.js',import.meta.url),'utf8');
function fixture(saveHandler,conflict=false){
 const elements=new Map(),calls=[]; let receive;
 const el=id=>{if(!elements.has(id))elements.set(id,{textContent:'',dataset:{},hidden:true,value:'',events:{},addEventListener(type,fn){this.events[type]=fn;},focus(){},showModal(){this.hidden=false;},close(){this.hidden=true;}});return elements.get(id);};
 const emit=event=>receive(JSON.stringify(event));
 const context=vm.createContext({document:{getElementById:el},window:{addEventListener(){}},crypto:{randomUUID:()=>`snapshot-${calls.length}`},setTimeout,clearTimeout,queueMicrotask,
 nativeBridge:{onContext(){},onTeardown(){},async call(name,args){calls.push({name,args});if(name==='canvas_native_request')return {_meta:{nativeHttp:{status:200}}};return {structuredContent:await saveHandler(name,args,emit)};}},
 OpenPencilEngine:{onEvent(fn){receive=fn;},documentName(){},selection(){return '{"selectedIds":["n1"],"activePageId":null}';},receive(raw){const e=JSON.parse(raw);calls.push(e);if(e.type==='op-bridge/snapshot')queueMicrotask(()=>emit({type:conflict?'op-bridge/snapshot-conflict':'op-bridge/snapshot-result',requestId:e.requestId,docJson:'{"latest":"typed immediately before Save"}',generation:7,revision:4}));}}});
 vm.runInContext(script+';globalThis.editor=nativeEditor;',context);
 context.editor.configure({structuredContent:{filePath:'/tmp/design.op'},_meta:{canvas:{token:'test-only'}}});
 emit({type:'op-bridge/ready',generation:7,revision:4});
 return {emit,calls,el,editor:context.editor};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));
test('Save sends the acknowledged latest snapshot before committing the editor revision',async()=>{
 const f=fixture(async()=>({filePath:'/tmp/design.op',version:8}));
 f.emit({type:'op-shell/save'});await settle();
 const save=f.calls.find(c=>c.name==='canvas_save');
 assert.equal(save.args.docJson,'{"latest":"typed immediately before Save"}');
 assert.ok(f.calls.findIndex(c=>c.type==='op-bridge/snapshot')<f.calls.indexOf(save));
 assert.deepEqual(f.calls.find(c=>c.type==='op-bridge/save-committed'),{type:'op-bridge/save-committed',generation:7,revision:4});
 assert.equal(f.el('status-message').textContent,'Сохранено');
});
test('a new edit during Save stays dirty after the older write succeeds',async()=>{
 let finish;
 const f=fixture(()=>new Promise(resolve=>{finish=resolve;}));
 f.emit({type:'op-shell/save'});await settle();
 f.emit({type:'op-bridge/dirty-changed',generation:7,revision:5,dirty:true});await settle();
 finish({filePath:'/tmp/design.op',version:8});await settle();
 assert.equal(f.el('status-message').textContent,'Сохранено · есть новые изменения');
 assert.equal(f.calls.find(c=>c.type==='op-bridge/save-committed').revision,4);
});
test('snapshot conflict prevents a filesystem save and is never retried',async()=>{
 const f=fixture(async()=>assert.fail('No write allowed'),true);
 f.emit({type:'op-shell/save'});await settle();
 assert.equal(f.calls.filter(c=>c.name==='canvas_save').length,0);
 assert.equal(f.calls.filter(c=>c.type==='op-bridge/snapshot').length,1);
 assert.match(f.el('status-message').textContent,/Не удалось сохранить/);
});
test('Save As only writes after the user submits a destination',async()=>{
 const f=fixture(async(name,args)=>({filePath:args.filePath,version:8}));
 f.emit({type:'op-shell/save-as'});await settle();
 assert.equal(f.el('save-dialog').hidden,false);
 assert.equal(f.calls.length,0);
 f.el('save-path').value='/tmp/new-design.op';
 f.el('save-form').events.submit({preventDefault(){}});await settle();
 assert.equal(f.calls.find(c=>c.name==='canvas_save').args.filePath,'/tmp/new-design.op');
});

test('snapshot flush restores selection before Save reads the daemon document',async()=>{
 const f=fixture(async()=>({filePath:'/tmp/design.op'}));
 f.emit({type:'op-shell/save'});await settle();
 const selection=f.calls.find(c=>c.name==='canvas_native_request');
 assert.equal(JSON.parse(selection.args.body).selectedIds[0],'n1');
 assert.ok(f.calls.indexOf(selection)<f.calls.findIndex(c=>c.name==='canvas_save'));
});
test('a replacement detaches the prior path and Save opens a new destination dialog',async()=>{
 const f=fixture(async()=>({filePath:null}));
 f.emit({type:'op-shell/document-replaced'});await settle();
 f.emit({type:'op-shell/save'});await settle();
 assert.equal(f.editor.source,null);
 assert.equal(f.calls.filter(c=>c.name==='canvas_save').length,0);
 assert.equal(f.calls.filter(c=>c.name==='canvas_detach_source').length,1);
 assert.equal(f.el('save-dialog').hidden,false);
});
test('a save completing after replacement cannot reattach the previous path',async()=>{
 let finish;
 const f=fixture(name=>name==='canvas_save'?new Promise(resolve=>{finish=resolve;}):{filePath:null});
 f.emit({type:'op-shell/save'});await settle();
 f.emit({type:'op-shell/document-replaced'});await settle();
 finish({filePath:'/tmp/design.op'});await settle();
 assert.equal(f.editor.source,null);
 assert.equal(f.calls.filter(c=>c.type==='op-bridge/save-committed').length,0);
});
test('rapid document replacements await their own detach acknowledgements in order',async()=>{
 const detaches=[];
 const f=fixture(name=>name==='canvas_detach_source'?new Promise((resolve,reject)=>detaches.push({resolve,reject})):{});
 f.emit({type:'op-shell/document-replaced'});const first=f.editor.syncBarrier();
 f.emit({type:'op-shell/document-replaced'});const second=f.editor.syncBarrier();
 let one=false,two=false;first.then(()=>one=true);second.then(()=>two=true,()=>{});
 await settle();assert.equal(detaches.length,1);
 detaches[0].resolve({});await settle();
 assert.equal(one,true);assert.equal(two,false);assert.equal(detaches.length,2);
 detaches[1].reject(Error('second failed'));
 await assert.rejects(second,/second failed/);assert.equal(two,false);
});
