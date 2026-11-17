import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../plugins/openpencil/ui/native-launch.js',import.meta.url),'utf8');
const identity={projectRoot:'/workspace/this-chat',sessionId:'owner-session'};
function fixture({context=true,failedMessage=false,message=true,direct=false}={}) {
  const calls=[],status={},result=value=>({structuredContent:value});let polls=0;
  const sandbox=vm.createContext({Date,document:{getElementById(){return status;}},setTimeout(fn){queueMicrotask(fn);}});
  vm.runInContext(source+'\nglobalThis.launch=nativeLaunch;',sandbox);
  const api={capabilities:{...(message?{message:{text:{}}}:{}),...(context?{updateModelContext:{}}:{})},
    async call(name,args){calls.push({name,args});if(name==='open_canvas'){if(direct)return {_meta:{canvasSession:identity}};throw Object.assign(Error('No root'),{code:'PROJECT_ROOT_REQUIRED'});}if(name==='canvas_launch_prepare')return result({launchId:'launch-for-this-panel',expiresAt:new Date(Date.now()+60000).toISOString()});return result(++polls===1?{state:'pending'}:{state:'ready',canvasSession:identity});},
    async request(name,args){calls.push({name,args});if(name==='ui/message'&&failedMessage)throw Error('Delivery unknown');return {};}};
  return {calls,run:()=>sandbox.launch.connect(api)};
}
test('standalone panel asks this chat once and waits for its exact correlated canvas',async()=>{
  const f=fixture();const [a,b]=await Promise.all([f.run(),f.run()]);
  assert.deepEqual(a,identity);assert.deepEqual(b,identity);
  assert.equal(f.calls.filter(c=>c.name==='ui/message').length,1);
  assert.deepEqual(f.calls.slice(1,4).map(c=>c.name),['canvas_launch_prepare','ui/update-model-context','ui/message']);
  assert.equal(f.calls[2].args.structuredContent.openBrushLaunch.launchId,'launch-for-this-panel');
  for(const c of f.calls.filter(c=>c.name==='canvas_launch_poll'))assert.equal(c.args.launchId,'launch-for-this-panel');
});
test('uncertain chat delivery never sends another message or guesses a project',async()=>{
  const f=fixture({failedMessage:true});await assert.rejects(f.run(),/Delivery unknown/);await assert.rejects(f.run(),/Delivery unknown/);
  assert.equal(f.calls.filter(c=>c.name==='ui/message').length,1);
  assert.equal(f.calls.filter(c=>c.name==='canvas_launch_poll').length,0);
});
test('a host without context publishing carries only the correlation ID in the opening request',async()=>{
  const f=fixture({context:false});await f.run();
  const text=f.calls.find(c=>c.name==='ui/message').args.content[0].text;
  assert.match(text,/launch-for-this-panel/);assert.doesNotMatch(text,/\/workspace/);
});
test('a host without chat messaging does not launch an unrelated editor',async()=>{
  const f=fixture({message:false});await assert.rejects(f.run(),/не позволяет/);assert.deepEqual(f.calls.map(c=>c.name),['open_canvas']);
});

test('a host-provided project root opens directly without a model message',async()=>{const f=fixture({direct:true,message:false});assert.deepEqual(await f.run(),identity);assert.deepEqual(f.calls.map(c=>c.name),['open_canvas']);});
