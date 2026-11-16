import test from 'node:test';
import assert from 'node:assert/strict';
import {auditDesignSystem,addDesignSystem,newDesignDocument} from '../plugins/openpencil/scripts/design-system.mjs';
import {CanvasController,canvasTools} from '../plugins/openpencil/scripts/canvas-controller.mjs';
test('a blank or one-off design cannot pass the quality audit',()=>{
 const result=auditDesignSystem({children:[{id:'b',type:'frame',semantics:{role:'button'}}]});
 assert.equal(result.complete,false);for(const code of ['ONE_OFF_CONTROL','COLOR_TOKENS','NO_COMPONENTS','STATE_FOCUSED','STATE_DISABLED'])assert.ok(result.issues.some(i=>i.code===code),code);
});
test('new projects include native foundations and a UI Kit; product refs remain linked',()=>{
 const doc=newDesignDocument();doc.pages[0].children=[{type:'ref',id:'example',ref:'brush-button-primary',x:10,y:20}];
 const result=auditDesignSystem(doc);assert.equal(result.complete,true,JSON.stringify(result.issues));assert.equal(result.components,4);assert.equal(result.instances,6);
 assert.ok(result.verificationRequired.includes('Verify transitions with full and reduced motion'));
});
test('initialization preserves old content and refuses ID/token collisions',()=>{
 const before={children:[{id:'original',type:'frame'}],variables:{old:{type:'color',value:'#ffffff'}}};
 const next=addDesignSystem(before);assert.deepEqual(next.pages[0].children,before.children);assert.equal(before.pages,undefined);assert.equal(next.variables.old.value,'#ffffff');
 assert.throws(()=>addDesignSystem(next),e=>e.code==='DESIGN_SYSTEM_EXISTS');
 assert.throws(()=>addDesignSystem({...before,variables:{'brush-accent':{}}}),e=>e.code==='TOKEN_CONFLICT');
 assert.throws(()=>addDesignSystem({children:[{id:'brush-button-primary',type:'frame'}]}),e=>e.code==='COMPONENT_CONFLICT');
});
test('broken refs and layout transitions fail instead of silently passing',()=>{
 const doc=newDesignDocument();doc.pages[0].children=[{id:'bad',type:'ref',ref:'missing',transition:{durationMs:150,properties:['width']}}];
 const result=auditDesignSystem(doc);assert.ok(result.issues.some(i=>i.code==='BROKEN_COMPONENT'));assert.ok(result.issues.some(i=>i.code==='LAYOUT_MOTION'));
});
test('quality audit is exposed and completion is blocked before native mutation on incomplete projects',async()=>{
 assert.ok(canvasTools.some(t=>t.name==='canvas_design_system_audit'));
 const controller=new CanvasController();let forwarded=0;
 controller.session={document:async()=>({version:1,document:{children:[]}}),forward:async()=>{forwarded++;return {result:{}};}};
 const result=await controller.dispatch({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'finalize_design',arguments:{}}});
 assert.equal(result.result.isError,true);assert.equal(result.result.structuredContent.code,'DESIGN_SYSTEM_INCOMPLETE');assert.equal(forwarded,0);
});

test('button labels cannot quietly bypass auto-layout centering',()=>{
 const doc=newDesignDocument();const master=doc.pages[2].children[0].children.find(n=>n.id==='brush-button-primary');
 assert.equal(master.children[0].x,undefined);assert.equal(master.children[0].y,undefined);
 master.children[0].x=0;master.children[0].y=0;
 assert.ok(auditDesignSystem(doc).issues.some(i=>i.code==='CONTROL_LABEL_POSITION'));
});

test('shared interaction state and a constant enabled guard cannot pass as independent controls',()=>{
 const doc=newDesignDocument();const master=doc.pages[2].children[0].children.find(n=>n.id==='brush-button-primary');
 master.events=JSON.parse(JSON.stringify(master.events).replaceAll('$self.','$state.'));
 master.bindings=JSON.parse(JSON.stringify(master.bindings).replaceAll('$self.','$state.'));master.enabled='true';
 const result=auditDesignSystem(doc);assert.ok(result.issues.some(i=>i.code==='SHARED_INTERACTION_STATE'));assert.ok(result.issues.some(i=>i.code==='DISABLED_GUARD'));
});
test('label and motion overrides on linked instances are audited after expansion',()=>{
 const doc=newDesignDocument();doc.pages[0].children=[{id:'bad-instance',type:'ref',ref:'brush-button-primary',children:[],descendants:{'brush-button-primary':{transition:{durationMs:150,properties:['width']}},'brush-button-primary-label':{x:29,y:-8}}}];
 const result=auditDesignSystem(doc);assert.ok(result.issues.some(i=>i.code==='CONTROL_LABEL_POSITION'));assert.ok(result.issues.some(i=>i.code==='LAYOUT_MOTION'));
});
test('custom font configuration reaches the complete foundations and UI Kit',()=>{
 const doc=addDesignSystem({children:[]},{fontFamily:'Georgia'});const stack=[...doc.pages];while(stack.length){const n=stack.pop();if(n.type==='text')assert.equal(n.fontFamily,'Georgia');stack.push(...(n.children||[]));}
});

test('every seeded token has a native consumer instead of being decorative metadata',()=>{
 const doc=newDesignDocument(),serialized=JSON.stringify(doc.pages);
 for(const name of Object.keys(doc.variables))assert.ok(serialized.includes('$'+name),name);
});

test('initialization cannot write without the active project writer lease',async()=>{
 const controller=new CanvasController();controller.session={document:async()=>({version:1,document:{children:[]}})};
 await assert.rejects(controller.call('canvas_design_system_init',{expectedVersion:1}),e=>e.code==='PROJECT_WRITER_REQUIRED');
});
