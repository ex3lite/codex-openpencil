import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const source=await readFile(new URL('../plugins/openpencil/ui/native-workspace.js',import.meta.url),'utf8');
const helper=await readFile(new URL('../plugins/openpencil/ui/native-context-state.js',import.meta.url),'utf8');
function fixture() {
  const elements=new Map(),handlers=new Map(),sent=[];let editorEvent,closed;
  const make=tag=>({tag,textContent:'',children:[],dataset:{},attributes:{},hidden:false,
    set id(id){this._id=id;elements.set(id,this);},get id(){return this._id;},
    append(...children){this.children.push(...children);},replaceChildren(...children){this.children=children;},
    setAttribute(name,value){this.attributes[name]=value;},getAttribute(name){return this.attributes[name];},focus(){}});
  const el=id=>{if(!elements.has(id)){const node=make('div');node.id=id;}return elements.get(id);};
  let current={project:{projectId:'p1',name:'Project'},documentId:'d1',canvasId:'c1',filePath:'/project/a.op',version:1,
    selection:{pageId:'page',count:1,nodeIds:['n1'],nodes:[{id:'n1',name:'Button',type:'FRAME'}]}};
  const calls=[],payloads=[];
  const sandbox=vm.createContext({document:{getElementById:el,createElement:make,body:{dataset:{}},querySelectorAll:()=>[],addEventListener(name,fn){handlers.set(name,fn);}},
    nativeUI:{openPanel(){},closePanel(){closed?.();},onClose(fn){closed=fn;},button(text,action,cls){const c=make('button');c.textContent=text;c.className=cls;c.onclick=action;return c;}},
    window:{dispatchEvent(){}},Event:class{},nativeBridge:{context:{},capabilities:{updateModelContext:{},message:{text:{}}},onContext(){}},
    crypto:{randomUUID:()=> 'request'},nativeEditor:{ready:false,onEvent(fn){editorEvent=fn;},send(message){sent.push(message);},async flush(){calls.push('snapshot_flush');return {docJson:'{}'};},async captureSelection(){calls.push('capture_selection');return current;},status(message){throw Error(message);},async call(name){calls.push(name);return name==='canvas_comments'?current.comments||[]:current;}}});
  vm.runInContext(helper+'\n'+source+';globalThis.workspace=nativeWorkspace;',sandbox);
  const workspace=sandbox.workspace;
  workspace.onContextChange(()=>payloads.push(JSON.stringify(workspace.contextData())),()=>{});
  workspace.update(current);
  const buttons=()=>{const result=[];function walk(node){if(node.tag==='button')result.push(node);for(const child of node.children||[])walk(child);}walk(el('workspace-drawer'));return result;};
  return {el,calls,payloads,workspace,buttons,sent,handlers,event:event=>editorEvent(event),close:()=>closed(),setCurrent(value){current=value;},get current(){return current;}};
}
test('context drawer adds/removes explicit targets, previews the exact payload and leaves selection reads side-effect free',async()=>{
  const f=fixture();f.el('workspace-context').onclick();
  assert.equal(f.el('context-add').disabled,false);
  assert.equal(JSON.parse(f.el('context-details').textContent).attachments.length,0);
  await f.el('context-add').onclick();
  assert.deepEqual(f.calls,['capture_selection']);
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
  assert.deepEqual(f.calls,['capture_selection']);
});

test('a comment draft keeps its captured target after Escape and another selection',async()=>{
  const f=fixture();await f.el('workspace-comment').onclick();
  f.el('comment-text').value='Сделай крупнее';f.close();
  const next={...f.current,version:2,selection:{pageId:'page',count:1,nodeIds:['n2'],nodes:[{id:'n2',name:'Other',type:'FRAME'}]}};
  f.setCurrent(next);f.workspace.update(next);
  await f.el('workspace-comment').onclick();
  assert.equal(f.el('comment-text').value,'Сделай крупнее');
  const text=[];function walk(n){text.push(n.textContent);for(const c of n.children||[])walk(c);}walk(f.el('workspace-drawer'));
  assert.ok(text.includes('Button'));assert.ok(text.some(t=>/n1.*версия 1/.test(t)));
  assert.equal(text.includes('Other'),false);
});
test('Escape in the host toolbar exits preview but an open drawer owns Escape',()=>{
  const f=fixture();f.event({type:'op-shell/preview-state',active:true});
  const event={key:'Escape',preventDefault(){this.prevented=true;},composedPath:()=>[{hasAttribute:()=>true}]};
  f.handlers.get('keydown')(event);
  assert.deepEqual(JSON.parse(JSON.stringify(f.sent)),[{type:'op-bridge/toggle-preview'}]);
  assert.equal(event.prevented,true);
  f.el('workspace-context').onclick();f.handlers.get('keydown')(event);
  assert.equal(f.sent.length,1);
});

test('direct attach button pins selection once and does not follow later clicks',async()=>{
  const f=fixture();assert.equal(f.el('workspace-attach').disabled,false);
  await f.el('workspace-attach').onclick();assert.equal(f.payloads.length,1);
  assert.equal(JSON.parse(f.payloads[0]).attachments[0].nodeIds[0],'n1');
  f.workspace.update({...f.current,selection:{count:0,nodeIds:[],nodes:[],pageId:'page'}});
  assert.equal(f.el('workspace-attach').disabled,true);assert.equal(f.payloads.length,1);
});
test('independent panel acknowledgements expose accurate labels and inspector close',()=>{
  const f=fixture();f.event({type:'op-shell/panels-state',layers:false,inspector:true,inspectorVisible:true});
  assert.equal(f.el('workspace-sidebar').textContent,'Показать слои');
  assert.equal(f.el('workspace-inspector-close').hidden,false);
  f.el('workspace-inspector-close').onclick();assert.equal(f.sent[0].type,'op-bridge/toggle-inspector');
  f.event({type:'op-shell/panels-state',layers:false,inspector:false,inspectorVisible:false});
  assert.equal(f.el('workspace-inspector').textContent,'Показать свойства');assert.equal(f.el('workspace-inspector-close').hidden,true);
});

test('an agent resolving a comment refreshes the open comments drawer',async()=>{
  const f=fixture();await f.el('workspace-comments').onclick();
  const comment={id:'comment',nodes:[{name:'Button'}],nodeIds:['n1'],version:1,text:'Check',status:'resolved'};
  f.workspace.update({...f.current,comments:[comment]});
  const text=[];function walk(n){text.push(n.textContent);for(const c of n.children||[])walk(c);}walk(f.el('workspace-drawer'));
  assert.ok(text.some(t=>t.includes('Выполнен')));
  assert.equal(f.calls.filter(n=>n==='canvas_comments').length,1);
});

test('opening a comment captures only selection and leaves document flush for submit',async()=>{
  const f=fixture();await f.el('workspace-comment').onclick();
  assert.deepEqual(f.calls,['capture_selection']);
  assert.equal(f.el('comment-text').id,'comment-text');
});
