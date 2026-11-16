// End-to-end automatic acquisition through the same model tools and lifecycle.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,readdir,copyFile,realpath} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {CanvasController} from '../plugins/openpencil/scripts/canvas-controller.mjs';
import {FontLibrary} from '../plugins/openpencil/scripts/font-library.mjs';
import {fetchPublicBytes} from '../plugins/openpencil/scripts/community-network.mjs';
import {sha256} from '../plugins/openpencil/scripts/editor-runtime.mjs';
if(process.argv.length!==4)throw Error('Usage: node scripts/fonts-smoke.mjs /absolute/runtime /absolute/output');
const runtimeRoot=resolve(process.argv[2]),output=resolve(process.argv[3]);await mkdir(output,{recursive:true});
const project=await realpath(await mkdtemp(join(output,'project-'))),filePath=join(project,'font-probe.op');
const sample='Съешь ещё этих мягких французских булок, да выпей чаю. Ёжик № 42';
const doc={version:'0.8.5',children:[{type:'frame',id:'board',name:'Automatic fonts · Cyrillic',x:0,y:0,width:1400,height:430,fill:[{type:'solid',color:'#ffffff'}],children:[
  ...[[400,'normal','Golos Text'],[700,'normal','Golos Text'],[400,'italic','Noto Sans'],[700,'italic','Noto Sans'],[700,'normal','Titillium Web'],[400,'normal','Golos Text']].map(([fontWeight,fontStyle,fontFamily],index)=>({type:'text',id:index===5?'on-demand':`line-${index}`,name:`${fontFamily} ${fontWeight} ${fontStyle}`,x:24,y:24+index*64,width:1340,height:48,fontFamily,fontWeight,fontStyle,fontSize:27,content:sample,fill:[{type:'solid',color:'#152229'}]}))]}]};
await writeFile(filePath,JSON.stringify(doc));const initial=sha256(await readFile(filePath)),requests=[];
const fetchBytes=(url,options)=>{requests.push(url);return fetchPublicBytes(url,options);};
const before=await new FontLibrary().list();const report={status:'FAIL',project,filePath,initialSha256:initial,cachedOnestBefore:before.families.some(f=>f.family==='Onest'&&f.availableFaces>0),publicRequests:requests};
let controller;
const unpack=result=>{if(result?.isError)throw Error(result.content?.[0]?.text || 'Tool failed');return result.structuredContent??JSON.parse(result.content[0].text);};
async function tool(name,args={}){const reply=await controller.dispatch({jsonrpc:'2.0',id:name,method:'tools/call',params:{name,arguments:args}});if(reply.error)throw Error(reply.error.message);return reply.result;}
async function count(document){let n=0,stack=[...(document.children || [])];while(stack.length){const node=stack.pop();n++;stack.push(...node.children || []);}return n;}
async function noEmbeddedFonts(path){for(const item of await readdir(path,{withFileTypes:true})){const child=join(path,item.name);if(item.isDirectory())await noEmbeddedFonts(child);else assert.ok(!/\.(?:ttf|otf|woff2?|font)$/i.test(item.name),'Project must contain references, not font binaries.');}}
try {
  controller=new CanvasController({runtimeRoot,fonts:{fetchBytes}});await controller.open({projectRoot:project,filePath});
  await controller.fonts.lastTask;report.automatic=unpack(await tool('canvas_fonts_status'));
  assert.equal(report.automatic.native?.cyrillicReady,true,'Russian coverage must be verified by the real renderer.');
  assert.ok(report.automatic.families.some(f=>f.family==='Golos Text'&&f.faces.length),'Opening alone must acquire the document font.');
  report.onDemand=unpack(await tool('canvas_fonts_prepare',{families:['Onest'],weights:[400,700],styles:['normal'],cyrillic:true}));
  assert.equal(report.onDemand.ready,1,'Agent-selected family must be acquired through the real tool.');
  if(!report.cachedOnestBefore)assert.ok(requests.some(url=>url.includes('/onest/')),'A cold demand request must download its actual font.');
  unpack(await tool('update_node',{nodeId:'on-demand',data:{fontFamily:'Onest'}}));
  const screenshot=await tool('get_screenshot',{nodeId:'board'}),image=screenshot.content.find(c=>c.type==='image');assert.ok(image?.data);
  const imagePath=join(output,'native-automatic-cyrillic.png');await writeFile(imagePath,Buffer.from(image.data,'base64'));report.nativeScreenshot=imagePath;
  const live=await controller.session.document();assert.equal(await count(live.document),7);
  const last=live.document.children[0].children.find(n=>n.id==='on-demand');assert.equal(last.fontFamily,'Onest');
  report.state=unpack(await tool('canvas_fonts_status'));
  assert.equal(report.state.native.cyrillicReady,true);
  await controller.close();controller=null;
  const second=await realpath(await mkdtemp(join(output,'second-project-'))),secondFile=join(second,'font-probe.op');await copyFile(filePath,secondFile);
  const start=requests.length;controller=new CanvasController({runtimeRoot,fonts:{fetchBytes}});await controller.open({projectRoot:second,filePath:secondFile});await controller.fonts.lastTask;
  report.secondProject=unpack(await tool('canvas_fonts_status'));assert.equal(requests.length,start,'Another project must reuse the global cache without public requests.');
  report.checks={automaticOnOpen:true,onDemandModelTool:true,sharedCacheWithoutRedownload:true,cyrillicVerified:true,originalNodesPreserved:true,noProjectFontBinaries:true};
  await noEmbeddedFonts(project);await noEmbeddedFonts(second);report.status='PASS';
} catch(error){report.error={message:error.message,stack:error.stack};}
finally {if(controller)await controller.close();await writeFile(join(output,'fonts-smoke.json'),JSON.stringify(report,null,2)+'\n');}
console.log(JSON.stringify({status:report.status,project,filePath,report:join(output,'fonts-smoke.json'),requests:requests.length,checks:report.checks,error:report.error?.message},null,2));process.exitCode=report.status==='PASS'?0:1;
