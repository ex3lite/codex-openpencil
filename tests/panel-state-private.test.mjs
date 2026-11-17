import test from 'node:test';
import assert from 'node:assert/strict';
import {CanvasController,canvasTools} from '../plugins/openpencil/scripts/canvas-controller.mjs';
import {validateCanvasSessionOperation} from '../plugins/openpencil/scripts/canvas-session-broker.mjs';
test('background panel state is app-only and selection is private metadata',async()=>{
  const controller=new CanvasController();
  const state={live:{version:5},selection:{count:1,nodeIds:['private-node'],nodes:[{id:'private-node',name:'Private layer'}]}};
  controller.session={source:'/project/design.op',dir:'/project',document:async()=>({document:{children:[]},version:5}),selectionSnapshot:{version:5,selection:state.selection}};
  controller.project={projectId:'project',projectRoot:'/project'};controller.documentId='document';
  const tool=canvasTools.find(t=>t.name==='canvas_panel_state');
  assert.deepEqual(tool._meta.ui.visibility,['app']);
  validateCanvasSessionOperation('canvas_panel_state',{});
  // The actual read path uses the same native selection reader as canvas_status.
  controller.session.document=async()=>({document:{children:[{id:'private-node',type:'frame',name:'Private layer'}]},version:5,activePageIndex:0,selectedNodeIds:['private-node']});
  controller.session.forward=async()=>({result:{structuredContent:{active_page_index:'0',active_page_id:'page',selection_ids:'private-node'}}});
  controller.recoveryPath=()=>'/project/recovery.op';
  const result=await controller.call('canvas_panel_state',{});
  assert.equal(result._meta.panelState.selection.nodes[0].name,'Private layer');
  assert.equal(result.structuredContent,undefined);
  assert.equal(result._meta.panelState.pluginVersion,'0.14.0');
  assert.equal(JSON.stringify(result.content).includes('private-node'),false);
  assert.equal(JSON.stringify(result.content).includes('Private layer'),false);
});
