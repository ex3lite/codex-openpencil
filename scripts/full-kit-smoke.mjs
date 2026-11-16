import assert from 'node:assert/strict';
import { mkdir, mkdtemp, copyFile, readFile, writeFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { performance } from 'node:perf_hooks';
import { CanvasController } from '../plugins/openpencil/scripts/canvas-controller.mjs';
import { callCanvasSession } from '../plugins/openpencil/scripts/canvas-session-broker.mjs';
import { diskDocument } from '../plugins/openpencil/scripts/document-format.mjs';
import { resolveRuntime, sha256 } from '../plugins/openpencil/scripts/editor-runtime.mjs';

const usage='node scripts/full-kit-smoke.mjs --runtime /absolute/runtime --source /absolute/full-kit.op --output /absolute/evidence';
const options={};
for(let index=2;index<process.argv.length;index++) {
  const key=process.argv[index];
  if(key==='--help') {console.log(usage);process.exit(0);}
  if(!['--runtime','--source','--output'].includes(key) || !process.argv[index+1]) throw Error(usage);
  options[key.slice(2)]=process.argv[++index];
}
if(![options.runtime,options.source,options.output].every(value=>typeof value==='string' && isAbsolute(value))) throw Error(usage);
await mkdir(options.output,{recursive:true});
const output=await realpath(await mkdtemp(join(options.output,'full-kit-')));
const projectRoot=join(output,'project');await mkdir(projectRoot);
process.env.OPENPENCIL_CODEX_STATE_DIR=join(output,'state');
const originalBytes=await readFile(options.source),originalHash=sha256(originalBytes);
const original=JSON.parse(originalBytes);
const report={status:'FAIL',output,source:options.source,sourceSha256:originalHash,sourceBytes:originalBytes.length,
  scope:'Native Rust daemon and real App session HTTP broker; Codex desktop UI embedding and human visual fidelity are separate checks.',
  visualInspection:'pending',timings:[],transfers:[],edits:[],screenshots:[],pageSwitches:[],checks:{}};
let controller;
const measured=async(name,action)=>{const start=performance.now();console.error(`START ${name}`);try{return await action();}finally{const ms=Math.round(performance.now()-start);report.timings.push({name,ms});console.error(`END ${name} ${ms}ms`);}};
const json=async(path,value)=>writeFile(path,JSON.stringify(value,null,2)+'\n',{mode:0o600});
function content(result) {
  if(result?.isError) throw Error(result.content?.find(item=>item.type==='text')?.text || 'Tool failed. No retry was made.');
  if(result?.structuredContent!==undefined) return result.structuredContent;
  const text=result?.content?.find(item=>item.type==='text')?.text;
  if(!text) return {};
  try{return JSON.parse(text);}catch{return {text};}
}
async function model(name,args={}) {
  assert.ok(controller?.session,'Model calls require the isolated managed session.');
  const reply=await controller.dispatch({jsonrpc:'2.0',id:`full-kit-${name}`,method:'tools/call',params:{name,arguments:args}});
  if(reply.error || !reply.result) throw Error(`${name} failed: ${reply.error?.message || 'missing result'}; not retried.`);
  content(reply.result);return reply.result;
}
async function app(name,args={}) {
  // This uses the actual capability-bound HTTP broker, not a mock/in-process call.
  const result=await callCanvasSession(controller.sessionBroker.identity,name,args);
  content(result);return result;
}
function nodes(document) {
  const entries=new Map(),pageIds=[];
  for(const page of document.pages || [{id:'0',children:document.children || []}]) {
    pageIds.push(page.id);
    const stack=[...(page.children || [])];
    while(stack.length) {
      const node=stack.pop();assert.equal(typeof node.id,'string','Every native node must keep its ID.');
      assert.ok(!entries.has(node.id),`Duplicate node ID ${node.id}`);entries.set(node.id,node);
      for(const child of node.children || []) stack.push(child);
    }
  }
  return {entries,pageIds};
}
function imageHashes(document) {
  const table=document.images || {},images=new Set();
  const add=input=>{
    let value=input;
    if(typeof value!=='string') return;
    if(value.startsWith('op-image:')) value=table[value.slice(9)];
    if(typeof value!=='string') return;
    // Compare bytes rather than table key or inline/externalized representation.
    if(/^data:[^,]+;base64,/i.test(value)) images.add(sha256(Buffer.from(value.slice(value.indexOf(',')+1),'base64')));
    else if(value) images.add(sha256(value));
  };
  for(const value of Object.values(table)) add(value);
  for(const node of nodes(document).entries.values()) {
    if(node.type==='image') add(node.src);
    for(const fill of [...(Array.isArray(node.fill)?node.fill:[]),...(node.stroke?.fill || [])]) if(fill.type==='image') add(fill.url);
  }
  return [...images].sort();
}
function structure(document) {
  const {entries,pageIds}=nodes(document),ids=[...entries.keys()].sort();
  return {pageCount:pageIds.length,nodeCount:entries.size,uniqueIds:ids.length,idsSha256:sha256(ids.join('\n')),pageIds,
    images:imageHashes(document).length,imageHashes:imageHashes(document)};
}
function checkComplete(document,expected,stage) {
  const actual=structure(document);
  assert.equal(actual.pageCount,77,`${stage}: all 77 pages must survive.`);
  assert.equal(actual.nodeCount,119191,`${stage}: all 119191 nodes must survive.`);
  assert.equal(actual.uniqueIds,119191,`${stage}: IDs must remain unique.`);
  assert.equal(actual.images,52,`${stage}: all 52 original images must survive.`);
  assert.deepEqual(actual.pageIds,expected.pageIds,`${stage}: page identities/order changed.`);
  assert.equal(actual.idsSha256,expected.idsSha256,`${stage}: node identities changed.`);
  assert.deepEqual(actual.imageHashes,expected.imageHashes,`${stage}: image bytes changed.`);
  return actual;
}
function ownHash(node) {const {children,...properties}=node;return sha256(JSON.stringify(properties));}
function selectText(document,pageIndex) {
  const page=document.pages[pageIndex],candidates=[];
  assert.ok(page,`Page ${pageIndex} missing.`);
  const stack=(page.children || []).map(node=>({node,parents:[]}));
  while(stack.length) {
    const {node,parents}=stack.pop();
    if(node.type==='text' && typeof node.content==='string' && node.content.trim() && node.visible!==false) {
      const frames=parents.filter(parent=>parent.type==='frame' && parent.width>=120 && parent.height>=40 && parent.width<=1800 && parent.height<=1800);
      const root=frames.sort((a,b)=>a.width*a.height-b.width*b.height)[0];
      if(root) candidates.push({node,root,pageId:page.id,pageName:page.name,pageIndex});
    }
    for(const child of node.children || []) stack.push({node:child,parents:[...parents,node]});
  }
  const priority=target=>/^Label text$/i.test(target.node.content)?0:/^Testo/i.test(target.node.content)?1:target.node.content.length>=5&&target.node.content.length<=60?2:3;
  candidates.sort((a,b)=>(priority(a)-priority(b)) || (a.root.width*a.root.height-b.root.width*b.root.height));
  assert.ok(candidates.length,`Page ${pageIndex} has no visible editable text with a bounded screenshot root.`);
  return candidates[0];
}
async function upload(kind,raw,label) {
  const bytes=Buffer.isBuffer(raw)?raw:Buffer.from(raw),gzip=gzipSync(bytes);
  const started=await app('canvas_transfer',{action:'start',kind,bytes:gzip.length,rawBytes:bytes.length,sha256:sha256(gzip)});
  const transfer=started._meta?.transfer;assert.ok(transfer?.id && transfer.chunkBytes>0,'Upload did not return a transfer.');
  let chunks=0;
  for(let offset=0;offset<gzip.length;offset+=transfer.chunkBytes) {
    const ack=await app('canvas_transfer',{action:'append',id:transfer.id,index:chunks,data:gzip.subarray(offset,offset+transfer.chunkBytes).toString('base64')});
    chunks++;assert.equal(ack._meta?.transfer?.index,chunks,'Chunk acknowledgement does not match.');
  }
  assert.equal((await app('canvas_transfer',{action:'finish',id:transfer.id}))._meta?.transfer?.ready,true);
  report.transfers.push({label,direction:'upload',kind,rawBytes:bytes.length,gzipBytes:gzip.length,chunks,sha256:sha256(gzip)});
  return transfer.id;
}
async function appDocument(label) {
  const response=await app('canvas_native_request',{path:'/api/mcp/document'});
  const native=response._meta?.nativeHttp;assert.equal(native?.status,200);
  const transfer=native.transfer;assert.ok(transfer && !native.body,'Full document must use chunks, not one base64 response.');
  const pieces=[];let chunks=0;
  for(let offset=0;offset<transfer.bytes;offset+=transfer.chunkBytes) {
    const result=await app('canvas_transfer',{action:'read',id:transfer.id,index:chunks});
    assert.equal(result._meta?.transfer?.index,chunks++);pieces.push(Buffer.from(result._meta.transfer.data,'base64'));
  }
  const compressed=Buffer.concat(pieces);assert.equal(compressed.length,transfer.bytes);assert.equal(sha256(compressed),transfer.sha256);
  const bytes=gunzipSync(compressed);assert.equal(bytes.length,transfer.rawBytes);
  await app('canvas_transfer',{action:'dispose',id:transfer.id});
  report.transfers.push({label,direction:'download',rawBytes:bytes.length,gzipBytes:compressed.length,chunks,sha256:transfer.sha256});
  return JSON.parse(bytes);
}
async function switchPage(pageIndex) {
  const current=await controller.session.document();
  const body={metadataOnly:true,baseVersion:current.version,activePageIndex:pageIndex,preserveAuthoredGeometry:current.preserveAuthoredGeometry};
  assert.equal(Object.hasOwn(body,'document'),false,'Page metadata request must not include document content.');
  const reply=await app('canvas_native_request',{path:'/api/mcp/document',method:'POST',body:JSON.stringify(body)});
  const native=reply._meta?.nativeHttp;assert.equal(native?.status,200);
  const ack=JSON.parse(Buffer.from(native.body,'base64'));assert.equal(ack.ok,true);
  const after=await controller.session.document();assert.equal(after.activePageIndex,pageIndex);
  report.pageSwitches.push({pageIndex,requestBytes:Buffer.byteLength(JSON.stringify(body)),containedDocument:false,versionBefore:current.version,versionAfter:after.version});
  return after;
}
async function screenshot(target) {
  const result=await model('get_screenshot',{nodeId:target.root.id});
  const image=result.content?.find(item=>item.type==='image' && item.mimeType==='image/png');assert.ok(image?.data,'Native screenshot missing.');
  const bytes=Buffer.from(image.data,'base64');assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
  const path=join(output,`page-${target.pageIndex}-edited.png`);await writeFile(path,bytes,{mode:0o600});
  report.screenshots.push({path,pageIndex:target.pageIndex,pageId:target.pageId,nodeId:target.root.id,width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20),bytes:bytes.length});
}
try {
  const runtime=await resolveRuntime(options.runtime);report.runtime={root:runtime.root,version:runtime.version};
  // Exact fixture guards prevent accidentally substituting a smaller representative document.
  const expected=structure(original);assert.equal(originalBytes.length,55100532,'Use the original complete 55 MB conversion.');
  assert.equal(originalHash,'4ca972b9b5dda9c97eeead2521afc2c38f674f5018d4af4ccc8e53ef712894aa','Full-kit baseline fingerprint changed.');
  report.baseline=checkComplete(original,expected,'source');
  const filePath=join(projectRoot,'full-kit.op');await copyFile(options.source,filePath);
  controller=new CanvasController({runtimeRoot:runtime.root});
  await measured('open-complete-native-kit',()=>controller.open({projectRoot,filePath}));
  const initial=await measured('initial-app-chunked-download',()=>appDocument('initial'));
  report.initial=checkComplete(initial.document,expected,'initial live');
  const initialNodes=nodes(initial.document).entries,initialHashes=new Map([...initialNodes].map(([id,node])=>[id,ownHash(node)]));
  const targets=[selectText(initial.document,35),selectText(initial.document,76)];
  const changedIds=new Set(targets.map(target=>target.node.id));
  for(const target of targets) {
    await measured(`metadata-page-${target.pageIndex}`,()=>switchPage(target.pageIndex));
    const newContent=`Brush ${target.pageIndex}`;
    await measured(`model-edit-page-${target.pageIndex}`,()=>model('update_node',{nodeId:target.node.id,data:{content:newContent}}));
    report.edits.push({pageIndex:target.pageIndex,pageId:target.pageId,pageName:target.pageName,nodeId:target.node.id,rootId:target.root.id,before:target.node.content,after:newContent});
    const live=await controller.session.document();
    assert.equal(nodes(live.document).entries.get(target.node.id)?.content,newContent);
    await measured(`native-screenshot-page-${target.pageIndex}`,()=>screenshot(target));
  }
  let live=await measured('edited-app-chunked-download',()=>appDocument('edited'));
  report.edited=checkComplete(live.document,expected,'edited live');
  for(const [id,node] of nodes(live.document).entries) if(!changedIds.has(id)) assert.equal(ownHash(node),initialHashes.get(id),`Unrelated node ${id} changed.`);
  report.checks.unrelatedNodesUnchanged=119191-changedIds.size;
  // Exercise a full body upload through App HTTP chunks and the real Rust CAS endpoint.
  const body=JSON.stringify({document:live.document,baseVersion:live.version,activePageIndex:live.activePageIndex,preserveAuthoredGeometry:live.preserveAuthoredGeometry,sourceClientId:'full-kit-smoke'});
  const bodyToken=await measured('app-body-chunked-upload',()=>upload('body',body,'full-document-CAS-body'));
  const pushed=await measured('native-CAS-body-apply',()=>app('canvas_native_request',{path:'/api/mcp/document',method:'POST',body:'',bodyToken}));
  assert.equal(pushed._meta?.nativeHttp?.status,200);
  live=await controller.session.document();report.bodyRoundTrip=checkComplete(live.document,expected,'body round trip');
  const snapshot=JSON.stringify(diskDocument(live));
  const snapshotToken=await measured('app-snapshot-chunked-upload',()=>upload('snapshot',snapshot,'save-snapshot'));
  report.saved=content(await measured('save-complete-project-copy',()=>app('canvas_save',{filePath,docJson:'',snapshotToken})));
  await measured('commit-full-document-history',()=>controller.persistence.boundary());
  const history=content(await model('canvas_history'));assert.ok(history.entries.length>=2,'History must retain original and edited versions.');
  report.history={documentId:history.documentId,versions:[]};
  for(const entry of history.entries) {
    const stored=await controller.persistence.history.read(entry.id),document=JSON.parse(stored.bytes);
    const checked=checkComplete(document,expected,`history ${entry.id}`);
    report.history.versions.push({id:entry.id,source:entry.source,bytes:stored.bytes.length,sha256:entry.sha256,pageCount:checked.pageCount,nodeCount:checked.nodeCount,images:checked.images});
  }
  const savedBytes=await readFile(filePath);report.savedBytes=savedBytes.length;report.savedDisk=checkComplete(JSON.parse(savedBytes),expected,'saved disk');
  await measured('close-first-native-session',()=>controller.close());controller=null;
  controller=new CanvasController({runtimeRoot:runtime.root});await measured('reopen-complete-project-copy',()=>controller.open({projectRoot,filePath}));
  const reopened=await measured('reopened-app-chunked-download',()=>appDocument('reopened'));
  report.reopened=checkComplete(reopened.document,expected,'reopened');
  const reopenedNodes=nodes(reopened.document).entries;
  for(const edit of report.edits) assert.equal(reopenedNodes.get(edit.nodeId)?.content,edit.after,`Page ${edit.pageIndex} edit did not survive reopen.`);
  for(const [id,node] of reopenedNodes) if(!changedIds.has(id)) assert.equal(ownHash(node),initialHashes.get(id),`Unrelated node ${id} changed on reopen.`);
  report.checks.bothIndependentEditsSurvivedReopen=true;report.checks.allPagesNodesIdsImagesPreserved=true;
  report.status='PASS';
} catch(error) {
  report.error={message:error.message,stack:error.stack};
} finally {
  if(controller) try{await controller.close();}catch(error){report.status='FAIL';report.closeError=error.message;}
  report.checks.originalSourceUnchanged=sha256(await readFile(options.source))===originalHash;
  if(!report.checks.originalSourceUnchanged) report.status='FAIL';
  await json(join(output,'report.json'),report);
}
console.log(JSON.stringify({status:report.status,output,report:join(output,'report.json'),error:report.error?.message,checks:report.checks},null,2));
process.exitCode=report.status==='PASS'?0:1;
