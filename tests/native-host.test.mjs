import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source=await readFile(new URL('../plugins/openpencil/ui/native-host.js',import.meta.url),'utf8');
const reference={projectRoot:'/workspace/current-chat',sessionId:'42acf3dd-49a6-428d-837b-3093a1c122b4'};
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(nativeLaunch) {
  const calls=[];let listener;
  const parent={postMessage(message){calls.push(message);}};
  const context=vm.createContext({window:{parent,addEventListener(_name,fn){listener=fn;}},setTimeout,clearTimeout,nativeLaunch});
  vm.runInContext(source+'\nglobalThis.bridge=nativeBridge;',context);
  const deliver=message=>listener({source:parent,data:{jsonrpc:'2.0',...message}});
  const notifyResult=()=>deliver({method:'ui/notifications/tool-result',params:{structuredContent:{project:{projectRoot:reference.projectRoot}},_meta:{canvasSession:reference}}});
  const reply=(message,result)=>deliver({id:message.id,result});
  return {bridge:context.bridge,calls,deliver,notifyResult,reply};
}

test('app waits for the chat tool result and never opens a context-free second canvas',async()=>{
  const f=fixture();const opening=f.bridge.openSession();await settle();
  assert.equal(f.calls.length,0);
  f.notifyResult();await settle();
  const call=f.calls[0];
  assert.equal(call.method,'tools/call');assert.equal(call.params.name,'canvas_session_call');
  assert.deepEqual(JSON.parse(JSON.stringify(call.params.arguments)),{...reference,name:'open_canvas',arguments:{}});
  f.reply(call,{structuredContent:{documentId:'same-document'},_meta:{canvas:{token:'private'}}});
  assert.equal((await opening).structuredContent.documentId,'same-document');
});

test('early tool result is retained and every later request keeps the same owner',async()=>{
  const f=fixture();f.notifyResult();const opening=f.bridge.openSession();await settle();
  f.reply(f.calls[0],{structuredContent:{}});await opening;
  const status=f.bridge.call('canvas_status');await settle();
  const request=f.calls[1];
  assert.equal(request.params.arguments.sessionId,reference.sessionId);
  assert.equal(request.params.arguments.projectRoot,reference.projectRoot);
  assert.equal(request.params.arguments.name,'canvas_status');
  f.reply(request,{structuredContent:{version:7}});assert.equal((await status).structuredContent.version,7);
});

test('two app instances cannot replace one another session identity',async()=>{
  const first=fixture(),second=fixture();first.notifyResult();
  second.deliver({method:'ui/notifications/tool-result',params:{_meta:{canvasSession:{...reference,projectRoot:'/workspace/another-chat',sessionId:'another-session'}}}});
  const a=first.bridge.openSession(),b=second.bridge.openSession();await settle();
  assert.notEqual(first.calls[0].params.arguments.projectRoot,second.calls[0].params.arguments.projectRoot);
  first.reply(first.calls[0],{structuredContent:{}});second.reply(second.calls[0],{structuredContent:{}});await Promise.all([a,b]);
});

test('cancelled opening does not discover another project or send a mutation',async()=>{
  const f=fixture();const opening=f.bridge.openSession();
  f.deliver({method:'ui/notifications/tool-cancelled',params:{}});
  await assert.rejects(opening,/отменено/);assert.equal(f.calls.length,0);
});

test('an unbound standalone panel connects through its current-chat launch request',async()=>{
  let connects=0;
  const f=fixture({async connect(){connects++;return reference;}});
  f.deliver({method:'ui/notifications/tool-result',params:{isError:true,
    structuredContent:{code:'PROJECT_ROOT_REQUIRED'},content:[{type:'text',text:'Missing chat root'}]}});
  const opening=f.bridge.openSession();await settle();
  assert.equal(connects,1);
  assert.equal(f.calls.length,1);
  assert.equal(f.calls[0].params.name,'canvas_session_call');
  assert.equal(f.calls[0].params.arguments.projectRoot,reference.projectRoot);
  assert.equal(f.calls[0].params.arguments.sessionId,reference.sessionId);
  f.reply(f.calls[0],{structuredContent:{documentId:'current-chat-document'}});
  assert.equal((await opening).structuredContent.documentId,'current-chat-document');
  assert.equal((await f.bridge.openSession()).structuredContent.documentId,'current-chat-document');
  assert.equal(connects,1);
});
