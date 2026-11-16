import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, realpath } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { CanvasController } from '../plugins/openpencil/scripts/canvas-controller.mjs';
import { CommunityDataset } from '../plugins/openpencil/scripts/community-assets.mjs';
const args={}; for(let i=2;i<process.argv.length;i+=2) args[process.argv[i].replace(/^--/,'')]=process.argv[i+1];
if(![args.runtime,args.dataset,args.output].every(isAbsolute)) throw Error('Pass --runtime, --dataset and --output absolute directories.');
await mkdir(args.output,{recursive:true});
const output=await realpath(await mkdtemp(join(args.output,'run-')));
process.env.OPENPENCIL_CODEX_STATE_DIR=join(output,'state');
const source=new CommunityDataset(await realpath(args.dataset));
const found=await source.search({query:'поиск'}); assert.ok(found.total>0);
const icon=found.assets[0]; const upstreamLicense=join(source.directory,icon.license.textPath);
const dataset=new CommunityDataset(output);
const asset=await dataset.ingest({sourcePath:icon.path,name:icon.name,kind:icon.kind,sourceUrl:icon.sourceUrl,communityUrl:icon.communityUrl,author:icon.author,licenseSpdx:icon.license.spdx,licensePath:upstreamLicense,licenseUrl:icon.license.url,tags:icon.tags});
const filePath=join(output,'community.op');
await writeFile(filePath,JSON.stringify({version:'0.8.5',children:[{id:'board',type:'frame',name:'Community icon test',width:240,height:140,fill:[{type:'solid',color:'#FFFFFF'}],children:[]}]}));
let controller=new CanvasController({runtimeRoot:args.runtime}); let sequence=0;
const tool=async(name,arguments_={})=>{
 const reply=await controller.dispatch({jsonrpc:'2.0',id:++sequence,method:'tools/call',params:{name,arguments:arguments_}});
 if(reply.error||reply.result?.isError) throw Error(reply.error?.message||reply.result.content?.[0]?.text);return reply.result;
};
const report={status:'FAIL',output,filePath,assetId:asset.id,sha256:asset.sha256};
try {
 await controller.open({projectRoot:output,filePath});
 const before=await controller.session.document();
 report.import=(await tool('canvas_community_import',{assetId:asset.id,pageId:'0',parentId:'board',x:40,y:40,expectedVersion:before.version})).structuredContent;
 const after=await controller.session.document();
 assert.equal(after.document.children[0].id,'board'); assert.ok(after.document.children[0].children.length>0);
 const svg=after.document.children[0].children; report.nodeTypes=[...new Set(svg.map(n=>n.type))];
 assert.ok(!JSON.stringify(svg).includes('data:image/'));
 await tool('canvas_save',{filePath});
 const screenshot=await tool('get_screenshot',{nodeId:'board'});const image=screenshot.content.find(c=>c.type==='image');assert.ok(image);
 await writeFile(join(output,'preview.png'),Buffer.from(image.data,'base64'));
 const expected=after.document.children[0].children;
 await controller.close(); controller=new CanvasController({runtimeRoot:args.runtime});
 await controller.open({projectRoot:output,filePath});
 const reopened=await controller.session.document();assert.deepEqual(reopened.document.children[0].children,expected);
 report.savedReopened=true;report.status='PASS';
} catch(error){report.error=error.stack;process.exitCode=1;}
finally{await controller.close();await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
