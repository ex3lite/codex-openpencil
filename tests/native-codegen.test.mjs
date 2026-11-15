import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const script=await readFile(new URL('../plugins/openpencil/ui/native-codegen.js',import.meta.url),'utf8');
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(messageCapability=true){
 let listener,poll;const calls=[],replies=[],messages=[];
 const job={requestId:'job-1',uiRequestId:'host-1-1',status:'prepared',revision:1,code:'<main>Original</main>',prompt:'implement captured n1'};
 const context=vm.createContext({document:{hidden:false},setInterval(fn){poll=fn;},
 nativeEditor:{ready:true,async flush(){calls.push('snapshot');return {docJson:'{}'};},async call(name,args){calls.push({name,args});return job;},send(event){replies.push(event);},status(){},onEvent(fn){listener=fn;}},
 nativeBridge:{capabilities:messageCapability?{message:{text:{}}}:{},async request(method,args){messages.push({method,args});throw Error('Lost acknowledgement');}}});
 vm.runInContext(script,context);
 return {job,calls,replies,messages,emit:event=>listener(event),poll:()=>poll()};
}
const event={type:'op-bridge/codegen-request',requestId:'host-1-1',framework:'html',pageId:'0',nodeIds:['n1']};
test('Code request flushes first, keeps captured targets and does not replay an unacknowledged host message',async()=>{
 const f=fixture(); f.emit(event);await settle();f.emit(event);await settle();
 assert.equal(f.calls[0],'snapshot');
 assert.equal(f.calls[1].name,'canvas_codegen_prepare');
 assert.deepEqual(f.calls[1].args.nodeIds,['n1']);
 assert.equal(f.messages.length,1);
 assert.match(f.replies.at(-1).notice,/не подтверждена/);
});
test('a host without text messaging still gets a usable source preview',async()=>{
 const f=fixture(false);f.emit(event);await settle();
 assert.equal(f.messages.length,0);assert.equal(f.replies[0].code,f.job.code);
 assert.match(f.replies[0].notice,/Продолжи реализацию/);
});
test('a cancelled Code request cannot consume a later completed result',async()=>{
 const f=fixture(false);f.emit(event);await settle();
 f.emit({type:'op-bridge/codegen-cancel',requestId:event.requestId});await settle();
 f.job.code='late result';f.job.status='complete';f.job.revision=2;
 const count=f.replies.length;await f.poll();
 assert.equal(f.replies.length,count);
 assert.equal(f.calls.at(-1).name,'canvas_codegen_cancel');
});

test('opening a different document stops polling the previous code job',async()=>{
 const f=fixture(false);f.emit(event);await settle();
 f.emit({type:'op-shell/document-replaced'});await settle();
 const count=f.calls.length;await f.poll();
 assert.equal(f.calls.length,count);
});
