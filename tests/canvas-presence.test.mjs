import test from 'node:test';
import assert from 'node:assert/strict';
import {CanvasPresence} from '../plugins/openpencil/scripts/canvas-presence.mjs';
const empty={epoch:7,active:false,cursorAgent:null,nodes:[],frames:[],previews:[],reveals:[]};
function fixture(){let now=1000;const doc={pages:[{id:'a',children:[{id:'frame',children:[{id:'button'}]}]},{id:'b',children:[{id:'other'}]}]};return {p:new CanvasPresence({session:{document:async()=>({document:doc,activePageIndex:0})},now:()=>now}),tick:n=>now+=n,doc};}
test('native reads and writes publish main cursor without changing document or selection',async()=>{
 const {p,doc}=fixture(),before=JSON.stringify(doc);
 assert(await p.nativeStart('update_node',{nodeId:'button'}));
 const r=p.relay(empty);assert(r.active);assert.deepEqual(r.nodes,[{id:'button',name:'Codex',color:'#47A8F5'}]);assert.deepEqual(r.reveals,[{id:'button',ms:0}]);assert.equal(JSON.stringify(doc),before);
 assert.equal(await p.nativeStart('get_editor_state'),false,'background status never starts presence');
});
test('presence expiry and explicit clear drain the last observed epoch',async()=>{
 const {p,tick}=fixture();await p.focus({pageId:'a',nodeIds:['button']});const r=p.relay(empty);
 tick(120001);assert.equal(p.status(),null);assert.deepEqual(p.relay(empty),{...empty,epoch:r.epoch});
 await p.focus({pageId:'b',nodeIds:['other']});const next=p.relay(empty);assert(next.epoch>r.epoch);p.clear();assert.equal(p.relay(empty).epoch,next.epoch);
});
test('main cursor and ten children retain distinct names and removal updates the epoch',async()=>{
 const {p}=fixture();await p.focus({pageId:'a',nodeIds:['button']});
 const upstream={...empty,active:true,nodes:Array.from({length:10},(_,i)=>({id:'child-'+i,name:'Child '+i,color:'#ffffff'})),reveals:Array.from({length:10},(_,i)=>({id:'child-'+i,ms:0}))};
 const r=p.relay(upstream);assert.equal(r.nodes.length,11);assert.equal(new Set(r.nodes.map(n=>n.name)).size,11);
 p.clear();const after=p.relay(upstream);assert.equal(after.nodes.length,10);assert(after.epoch>r.epoch);
});
test('invalid anchors reject and short native work expires without requiring a stop tool',async()=>{
 const {p,tick}=fixture();await assert.rejects(p.focus({pageId:'a',nodeIds:['other']}));assert.equal(p.status(),null);
 await p.nativeStart('read_nodes',{});assert.deepEqual(p.status().rootIds,[]);assert.equal(p.relay(empty).cursorAgent.name,'Codex');p.finish();tick(15001);assert.equal(p.status(),null);
});

test('controller publishes activity before forwarding native tools and expires after completion',async()=>{
 const {CanvasController}=await import('../plugins/openpencil/scripts/canvas-controller.mjs');
 const {p}=fixture();const c=new CanvasController();c.presence=p;
 c.session={source:'/fixture.op',draft:'/draft.op',forward:async()=>{
  assert.equal(p.status().rootIds[0],'button');return {result:{content:[]}};
 }};
 const result=await c.dispatch({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'update_node',arguments:{nodeId:'button',data:{name:'Updated'}}}});
 assert.equal(result.result.isError,undefined);assert.equal(p.status().expiresAt,16000);
 await c.call('canvas_activity',{action:'clear'});assert.equal(p.status(),null);
});
