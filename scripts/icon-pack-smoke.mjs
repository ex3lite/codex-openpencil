import assert from 'node:assert/strict';
import {mkdir,mkdtemp,realpath,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {CanvasController} from '../plugins/openpencil/scripts/canvas-controller.mjs';
if(process.argv.length!==4)throw Error('Usage: node scripts/icon-pack-smoke.mjs /absolute/runtime /absolute/output');
const runtimeRoot=resolve(process.argv[2]),output=resolve(process.argv[3]);await mkdir(output,{recursive:true});
const project=await realpath(await mkdtemp(join(output,'project-'))),filePath=join(project,'coolicons-probe.op');
await writeFile(filePath,JSON.stringify({version:'0.8.5',children:[{type:'frame',id:'board',name:'Coolicons · editable SVG',x:0,y:0,width:600,height:260,fill:[{type:'solid',color:'#ffffff'}],children:[{type:'text',id:'title',x:32,y:28,width:536,height:44,content:'Coolicons — редактируемые иконки',fontFamily:'Inter',fontSize:24,fontWeight:600,fill:[{type:'solid',color:'#182c24'}]}]}]}));
const report={status:'FAIL',project,filePath};let controller;
const data=result=>{if(result?.isError)throw Error(result.content?.[0]?.text);return result.structuredContent??JSON.parse(result.content[0].text);};
async function call(name,args={}){const response=await controller.dispatch({jsonrpc:'2.0',id:name,method:'tools/call',params:{name,arguments:args}});if(response.error)throw Error(response.error.message);return response.result;}
try {
  controller=new CanvasController({runtimeRoot});await controller.open({projectRoot:project,filePath});
  const started=performance.now();console.error('START acquire full Coolicons');
  report.pack=data(await call('canvas_icon_pack_acquire',{pack:'coolicons'}));report.acquireMs=Math.round(performance.now()-started);
  assert.equal(report.pack.originalCommunityId,'800815864899415771');assert.ok(report.pack.iconCount>=1700);assert.equal(report.pack.count,report.pack.iconCount*15);
  console.error(`END acquire ${report.pack.iconCount} names / ${report.pack.count} SVG`);
  report.selections=[];
  for(const [i,query] of ['search','arrow left','check','settings'].entries()) {
    const found=data(await call('canvas_icon_pack_search',{packId:'coolicons',query,limit:8}));assert.ok(found.icons.length,`Search failed: ${query}`);
    const chosen=found.icons.find(icon=>icon.name.toLowerCase()===query)||found.icons[0];
    const asset=data(await call('canvas_icon_pack_select',{packId:'coolicons',key:chosen.key}));
    assert.equal(asset.sourcePack.originalCommunityId,'800815864899415771');assert.equal(asset.sourcePack.revision,report.pack.revision);
    const live=await controller.session.document();
    const imported=data(await call('canvas_community_import',{assetId:asset.id,pageId:live.document.pages?.[live.activePageIndex]?.id || '0',expectedVersion:live.version,parentId:'board',x:64+i*128,y:144}));
    assert.equal(imported.editable,true);report.selections.push({query,key:chosen.key,assetId:asset.id,sourcePack:asset.sourcePack,version:imported.version});
  }
  report.update=data(await call('canvas_icon_pack_check',{packId:'coolicons'}));assert.equal(report.update.originalCommunityId,'800815864899415771');
  const screenshot=await call('get_screenshot',{nodeId:'board'}),image=screenshot.content.find(c=>c.type==='image');assert.ok(image?.data);
  await writeFile(join(output,'coolicons-editable.png'),Buffer.from(image.data,'base64'));
  const live=await controller.session.document(),nodes=[],stack=[...live.document.children];while(stack.length){const node=stack.pop();nodes.push(node);stack.push(...node.children||[]);}
  const paths=nodes.filter(n=>n.type==='path');assert.ok(paths.length>=4,'Imported icons must have editable vector paths, not screenshots.');
  const target=paths[0];data(await call('update_node',{nodeId:target.id,data:{name:'Editable Coolicons path'}}));
  await controller.persistence.boundary();report.saved=data(await call('canvas_save',{filePath}));
  report.checks={fullPresetInstalled:true,figmaIdentityRetained:true,searchAndSelectTools:true,editableSvgPaths:paths.length,vectorEdited:true,sourceVersionChecked:true};report.status='PASS';
}catch(error){report.error={message:error.message,stack:error.stack};}
finally {if(controller)await controller.close();await writeFile(join(output,'icon-pack-smoke.json'),JSON.stringify(report,null,2)+'\n');}
console.log(JSON.stringify({status:report.status,report:join(output,'icon-pack-smoke.json'),checks:report.checks,error:report.error?.message},null,2));process.exitCode=report.status==='PASS'?0:1;
