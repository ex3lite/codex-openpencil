import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const source=await readFile(new URL('../plugins/openpencil/ui/native-workspace.js',import.meta.url),'utf8');
const helper=await readFile(new URL('../plugins/openpencil/ui/native-context-state.js',import.meta.url),'utf8');
function fixture({call, retryAutosave} = {}) {
  const elements=new Map(),handlers=new Map(),sent=[];let editorEvent,closed;
  const make=tag=>({tag,textContent:'',children:[],dataset:{},attributes:{},style:{},hidden:false,events:{},
    get firstElementChild(){return this.children[0];}, get lastElementChild(){return this.children.at(-1);},
    close(){this.open=false;this.events.close?.();},showModal(){this.open=true;},remove(){},
    set id(id){this._id=id;elements.set(id,this);},get id(){return this._id;},
    append(...children){this.children.push(...children);},replaceChildren(...children){this.children=children;},
    setAttribute(name,value){this.attributes[name]=value;},getAttribute(name){return this.attributes[name];},
    querySelectorAll(){return [];},querySelector(tag){return this.children.find(c=>c.tag===tag) || (this.control ??= make('button'));},addEventListener(name,fn){this.events[name]=fn;},focus(){}});
  const el=id=>{if(!elements.has(id)){const node=make('div');node.id=id;}return elements.get(id);};
  let current={project:{projectId:'p1',name:'Project'},documentId:'d1',canvasId:'c1',filePath:'/project/a.op',version:1,
    selection:{pageId:'page',count:1,nodeIds:['n1'],nodes:[{id:'n1',name:'Button',type:'FRAME'}]}};
  const calls=[],payloads=[],body=make('body'); let sequence=0;
  const sandbox=vm.createContext({document:{getElementById:el,createElement:make,documentElement:{dataset:{}},body,querySelectorAll:()=>[],addEventListener(name,fn){handlers.set(name,fn);}},
    nativeUI:{openPanel(){},closePanel(){closed?.();},onClose(fn){closed=fn;},button(text,action,cls){const c=make('button');c.textContent=text;c.className=cls;c.onclick=action;return c;}},
    window:{dispatchEvent(){}},Event:class{},nativeBridge:{context:{},capabilities:{updateModelContext:{},message:{text:{}}},onContext(){}},
    crypto:{randomUUID:()=> 'request-'+ ++sequence},nativeEditor:{retryAutosave,ready:false,onEvent(fn){editorEvent=fn;},send(message){sent.push(message);},async flush(){calls.push('snapshot_flush');return {docJson:'{}'};},async captureSelection(){calls.push('capture_selection');return current;},status(message){throw Error(message);},async call(name,args){calls.push(name);if(call)return call(name,args,current);return name==='canvas_comments'?current.comments||[]:name==='canvas_agents'?current.agents:current;}}});
  vm.runInContext(helper+'\n'+source+';globalThis.workspace=nativeWorkspace;',sandbox);
  const workspace=sandbox.workspace;
  workspace.onContextChange(()=>payloads.push(JSON.stringify(workspace.contextData())),()=>{});
  workspace.update(current);
  const buttons=()=>{const result=[];function walk(node){if(node.tag==='button')result.push(node);for(const child of node.children||[])walk(child);}walk(el('workspace-drawer'));return result;};
  return {el,body,calls,payloads,workspace,buttons,sent,handlers,event:event=>editorEvent(event),close:()=>closed(),setCurrent(value){current=value;},get current(){return current;}};
}
test('context drawer adds/removes explicit targets, previews the exact payload and leaves selection reads side-effect free',async()=>{
  const f=fixture();f.el('workspace-context').onclick();
  assert.equal(f.el('context-add').disabled,false);
  assert.equal(f.workspace.contextData().attachments.length,0);
  await f.el('context-add').onclick();
  assert.deepEqual(f.calls,['capture_selection']);
  assert.equal(f.payloads.length,1);
  await f.buttons().find(button=>button.textContent==='Button').onclick();
  assert.deepEqual(JSON.parse(f.el('context-details').textContent),JSON.parse(f.payloads[0]));
  assert.equal(f.el('workspace-context-label').textContent,'Контекст · 1');
  const changed={...f.current,version:99,selection:{pageId:'page',count:0,nodeIds:[],nodes:[]}};
  f.setCurrent(changed);f.workspace.update(changed);
  assert.equal(f.el('context-add').disabled,true);
  assert.equal(f.payloads.length,1);
  assert.equal(JSON.parse(f.el('context-details').textContent).attachments[0].capturedVersion,1);
  await f.buttons().find(button=>button.textContent==='Удалить из контекста').onclick();
  assert.equal(f.payloads.length,2);
  assert.equal(JSON.parse(f.payloads[1]).attachments.length,0);
  assert.equal(f.el('workspace-context-label').textContent,'Контекст · 0');
  assert.deepEqual(f.calls,['capture_selection']);
});

test('a comment draft keeps its captured target after Escape and another selection',async()=>{
  const f=fixture();await f.el('workspace-comment').onclick();
  f.el('comment-text').value='Сделай крупнее';f.close();
  const next={...f.current,version:2,selection:{pageId:'page',count:1,nodeIds:['n2'],nodes:[{id:'n2',name:'Other',type:'FRAME'}]}};
  f.setCurrent(next);f.workspace.update(next);
  await f.el('workspace-comment').onclick();
  assert.equal(f.el('comment-text').value,'Сделай крупнее');
  const text=[];function walk(n){text.push(n.textContent,n.title);for(const c of n.children||[])walk(c);}walk(f.el('workspace-drawer'));
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

function findText(node, text) {
  if (node.textContent === text) return node;
  for (const child of node.children) {
    const found = findText(child,text);
    if (found) return found;
  }
}
test('context summary follows confirmed delivery, retry and removal without changing the pinned draft',async()=>{
  const f=fixture(); await f.el('workspace-attach').onclick();
  const draft=f.el('pinned-comment-text'); draft.value='Keep this'; draft.oninput();
  f.el('workspace-context').onclick();
  const drawer=f.el('workspace-drawer'); let retries=0;
  f.workspace.onContextChange(()=>{},()=>retries++);
  f.workspace.contextDelivery({state:'error',error:'offline'});
  assert.ok(findText(drawer,'Слой остался во вложениях'));
  await findText(drawer,'Повторить передачу').onclick();
  assert.equal(retries,1);
  f.workspace.contextDelivery({state:'accepted'});
  assert.ok(findText(drawer,'Передан в Codex'));
  await findText(drawer,'Button').onclick();
  assert.equal(f.el('pinned-comment-text').value,'Keep this');
});
test('a missing target opens a modal; retargeting requires a different live selection and keeps the text',async()=>{
  const submit=[];
  const f=fixture({call:(name,args,current)=>{
    if(name==='canvas_comment_create'){
      submit.push(args);
      if(submit.length===1)throw Object.assign(Error('missing'),{code:'COMMENT_TARGET_MISSING'});
      return {shouldSend:false};
    }
    return name==='canvas_comments'?[]:current;
  }});
  await f.el('workspace-comment').onclick(); const input=f.el('comment-text'); input.value='Keep my draft';input.oninput();
  await findText(f.el('workspace-drawer'),'Отправить в Codex').onclick();
  const dialog=f.body.lastElementChild; assert.equal(dialog.open,true);
  await findText(dialog,'Выбрать другую цель').onclick(); assert.equal(dialog.open,false);
  assert.equal(f.el('retarget-confirm').disabled,true);
  const next={...f.current,selection:{...f.current.selection,nodeIds:['n2'],nodes:[{id:'n2',name:'Other'}]}};
  f.setCurrent(next); f.workspace.update(next); assert.equal(f.el('retarget-confirm').disabled,false);
  await f.el('retarget-confirm').onclick();
  assert.equal(f.el('comment-text').value,'Keep my draft');
  await findText(f.el('workspace-drawer'),'Отправить в Codex').onclick();
  assert.deepEqual(submit.map(s=>Array.from(s.nodeIds)),[['n1'],['n2']]);
  assert.notEqual(submit[0].requestId,submit[1].requestId);
});
test('a permission failure opens once, permits explicit retries, and keeps the dialog until success',async()=>{
  const attempts=[];
  const f=fixture({retryAutosave:async id=>{attempts.push(id);if(attempts.length===1)throw Error('Still denied');}});
  const blocked={...f.current,autosave:{state:'error',code:'EACCES',error:'Access denied'}};
  f.workspace.update(blocked);f.workspace.update(blocked);
  assert.equal(f.body.children.length,1);const dialog=f.body.lastElementChild;
  const retry=findText(dialog,'Проверить снова'); await retry.onclick();
  assert.equal(dialog.open,true);assert.equal(findText(dialog,'Still denied').hidden,false);
  await retry.onclick();assert.equal(dialog.open,false);assert.deepEqual(attempts,['d1','d1']);
});
test('sent and actively assigned comments have distinct states and reveal uses captured IDs',async()=>{
  const f=fixture(),drawer=f.el('workspace-drawer');
  const c={id:'c',nodeIds:['n1'],pageId:'p',nodes:[{name:'Target'}],version:1,text:'Change',status:'sent'};
  const update=(comment,agents)=>f.workspace.update({...f.current,comments:[comment],agents});
  await f.el('workspace-comments').onclick();
  update(c);assert.ok(findText(drawer,'Передан в чат'));assert.equal(findText(drawer,'В работе'),undefined);
  update({...c,status:'in_progress',agentId:'a1'},{agents:[{agentId:'a1',name:'Typography',color:'#456',activity:'Изучает макет'}]});
  assert.ok(findText(drawer,'В работе'));assert.ok(findText(drawer,'Typography'));
  update({...c,status:'resolved',resolution:'42 px'});assert.ok(findText(drawer,'42 px'));
  await findText(drawer,'Показать слой').onclick();
  assert.deepEqual(JSON.parse(JSON.stringify(f.sent.at(-1))),{type:'op-bridge/reveal-layers',pageId:'p',nodeIds:['n1']});
});
test('the agents panel updates actual participants as scopes expire and distinguishes the coordinator',async()=>{
  const f=fixture(), drawer=f.el('workspace-drawer');
  const parent={agentId:'codex-parent',name:'Codex',activity:'Изучает макет',rootIds:['n1']};
  const agent={agentId:'local',name:'Типографика',activity:'Область назначена',rootIds:['n2']};
  const current={...f.current,agents:{maxAgents:10,parent,agents:[agent]}};
  f.setCurrent(current);f.workspace.update(current);
  await f.el('workspace-agents').onclick();
  assert.ok(findText(drawer,'Codex · Координатор'));assert.ok(findText(drawer,'Типографика'));
  f.workspace.update({...current,agents:{maxAgents:10,parent:null,agents:[]}});
  assert.ok(findText(drawer,'Сейчас никто не редактирует макет.'));assert.equal(findText(drawer,'Типографика'),undefined);
});
