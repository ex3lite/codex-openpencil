import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const source=await readFile(new URL('../plugins/openpencil/ui/native-workspace.js',import.meta.url),'utf8');
const helper=await readFile(new URL('../plugins/openpencil/ui/native-context-state.js',import.meta.url),'utf8');
function fixture() {
  const elements=new Map();
  const make=tag=>({tag,textContent:'',children:[],dataset:{},attributes:{},hidden:false,
    set id(id){this._id=id;elements.set(id,this);},get id(){return this._id;},
    append(...children){this.children.push(...children);},replaceChildren(...children){this.children=children;},
    setAttribute(name,value){this.attributes[name]=value;},focus(){}});
  const el=id=>{if(!elements.has(id)){const node=make('div');node.id=id;}return elements.get(id);};
  let current={project:{projectId:'p1',name:'Project'},documentId:'d1',canvasId:'c1',filePath:'/project/a.op',version:1,
    selection:{pageId:'page',count:1,nodeIds:['n1'],nodes:[{id:'n1',name:'Button',type:'FRAME'}]}};
  const calls=[],payloads=[];
  const sandbox=vm.createContext({document:{getElementById:el,createElement:make,body:{dataset:{}},querySelectorAll:()=>[],addEventListener(){}},
    window:{dispatchEvent(){}},Event:class{},nativeBridge:{context:{},capabilities:{updateModelContext:{}},onContext(){}},
    nativeEditor:{ready:false,onEvent(){},status(message){throw Error(message);},async call(name){calls.push(name);return current;}}});
  vm.runInContext(helper+'\n'+source+';globalThis.workspace=nativeWorkspace;',sandbox);
  const workspace=sandbox.workspace;
  workspace.onContextChange(()=>payloads.push(JSON.stringify(workspace.contextData())),()=>{});
  workspace.update(current);
  const buttons=()=>{const result=[];function walk(node){if(node.tag==='button')result.push(node);for(const child of node.children||[])walk(child);}walk(el('workspace-drawer'));return result;};
  return {el,calls,payloads,workspace,buttons,setCurrent(value){current=value;},get current(){return current;}};
}
test('context drawer adds/removes explicit targets, previews the exact payload and leaves selection reads side-effect free',async()=>{
  const f=fixture();f.el('workspace-context').onclick();
  assert.equal(f.el('context-add').disabled,false);
  assert.equal(JSON.parse(f.el('context-details').textContent).attachments.length,0);
  await f.el('context-add').onclick();
  assert.deepEqual(f.calls,['canvas_status']);
  assert.equal(f.payloads.length,1);
  assert.deepEqual(JSON.parse(f.el('context-details').textContent),JSON.parse(f.payloads[0]));
  assert.equal(f.el('workspace-context').textContent,'Контекст · 1');
  const changed={...f.current,version:99,selection:{pageId:'page',count:0,nodeIds:[],nodes:[]}};
  f.setCurrent(changed);f.workspace.update(changed);
  assert.equal(f.el('context-add').disabled,true);
  assert.equal(f.payloads.length,1);
  assert.equal(JSON.parse(f.el('context-details').textContent).attachments[0].capturedVersion,1);
  await f.buttons().find(button=>button.textContent==='Удалить из контекста').onclick();
  assert.equal(f.payloads.length,2);
  assert.equal(JSON.parse(f.payloads[1]).attachments.length,0);
  assert.equal(f.el('workspace-context').textContent,'Контекст · 0');
  assert.deepEqual(f.calls,['canvas_status']);
});
