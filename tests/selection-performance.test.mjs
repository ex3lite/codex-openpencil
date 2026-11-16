import test from 'node:test';
import assert from 'node:assert/strict';
import {readCanvasSelection} from '../plugins/openpencil/scripts/canvas-selection.mjs';

function fixture() {
 let visits=0, version=1, selected='';
 const node={id:'target',type:'frame',name:'Target',get children(){visits++;return [];}};
 const document={children:[node]};
 const session={selectionDocument:async()=>({version,activePageIndex:0,document}),forward:async()=>({result:{structuredContent:{active_page_id:'0',active_page_index:'0',selection_ids:selected}}})};
 return {session,get visits(){return visits;},select(id){selected=id;},change(){version++;node.name='Renamed';}};
}
test('empty selection does not traverse large page trees',async()=>{
 const f=fixture();await readCanvasSelection(f.session);assert.equal(f.visits,0);
});
test('unchanged selection reuses its index but document revisions invalidate metadata',async()=>{
 const f=fixture();f.select('target');await readCanvasSelection(f.session);const initial=f.visits;
 await readCanvasSelection(f.session);assert.equal(f.visits,initial);
 f.change();const result=await readCanvasSelection(f.session);assert.ok(f.visits>initial);assert.equal(result.selection.nodes[0].name,'Renamed');
 f.select('missing');await assert.rejects(readCanvasSelection(f.session),e=>e.code==='SELECTION_STALE');
});

test('empty status polling reads only the version, while fresh operations retain a full snapshot',async()=>{
 let reads=0;const session={selectionVersion:async()=>12,selectionDocument:async()=>{throw Error('large document transfer');},document:async()=>{reads++;return {version:12,activePageIndex:0,document:{children:[]}};},forward:async()=>({result:{structuredContent:{active_page_id:'0',active_page_index:'0',selection_ids:''}}})};
 const status=await readCanvasSelection(session);assert.equal(status.live.version,12);assert.equal(reads,0);
 const fresh=await readCanvasSelection(session,{fresh:true});assert.equal(reads,1);assert.ok(fresh.live.document);
});
