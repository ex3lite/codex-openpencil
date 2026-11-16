import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { rm, readFile } from 'node:fs/promises';
import { resolveRuntime, sha256 } from './editor-runtime.mjs';
import { atomicBytes, safeBytes, withLibraryLock } from './library-storage.mjs';

const NATIVE_LIMIT = 1024 * 1024 * 1024;
const INDEX_LIMIT = 64 * 1024 * 1024;
async function converter() {
  const runtime = await resolveRuntime();
  const manifest = JSON.parse(await readFile(join(runtime.root,'openpencil-runtime.json'),'utf8'));
  const relative = process.platform === 'win32' ? 'bin/op.exe' : 'bin/op';
  if (!manifest.files[relative]) throw Error('The configured runtime does not contain a verified native Figma converter. Install the complete current runtime.');
  return {path:join(runtime.root,relative),version:runtime.version,sha256:manifest.files[relative]};
}
async function run(binary,args) {
  return new Promise((resolve,reject)=>{
    const child=spawn(binary,args,{shell:false,stdio:['ignore','pipe','pipe'],windowsHide:true});
    const stdout=[],stderr=[];let size=0,overflow=false;
    const timer=setTimeout(()=>child.kill('SIGKILL'),120000);
    for(const [stream,chunks] of [[child.stdout,stdout],[child.stderr,stderr]]) stream.on('data',bytes=>{
      size+=bytes.length;
      if(size>4*1024*1024) {overflow=true;child.kill('SIGKILL');} else chunks.push(bytes);
    });
    child.on('error',error=>{clearTimeout(timer);reject(error);});
    child.on('close',(code,signal)=>{
      clearTimeout(timer);
      if(code!==0 || overflow) return reject(Error(`Native conversion failed (${signal || code}${overflow?', output limit':''}): ${Buffer.concat(stderr).toString('utf8').slice(0,4096)}`));
      try {const result=JSON.parse(Buffer.concat(stdout).toString('utf8'));if(result.ok!==true) throw Error('Native converter did not confirm success.');resolve(result);}
      catch(error) {reject(error);}
    });
  });
}
function pageSummary(page,index) {
  const names=[],types={},stack=[...(page.children || [])];let nodes=0;
  while(stack.length) {
    const node=stack.pop();nodes++;
    const type=typeof node.type==='string'?node.type:'unknown';types[type]=(types[type] || 0)+1;
    if(typeof node.name==='string' && node.name.trim()) names.push(node.name);
    if(Array.isArray(node.children)) for(const child of node.children) stack.push(child);
  }
  return {id:typeof page.id==='string'?page.id:`page-${index}`,name:page.name || `Page ${index+1}`,index,nodeCount:nodes,topLevelCount:page.children?.length || 0,types,names:[...new Set(names)]};
}
function validateIndex(value,entry) {
  if(value.schemaVersion!==1 || value.sourceSha256!==entry.sha256 || !Array.isArray(value.pages) || !/^[a-f0-9]{64}$/.test(value.nativeSha256) || value.relativePath!==`native/${value.nativeSha256}.op` || !Number.isSafeInteger(value.bytes) || value.bytes<1) throw Error('Invalid converted resource index.');
  return value;
}
export async function prepareLibraryAsset(dataset,assetId,{converterInfo,runConverter=run}={}) {
  const {entry}=await dataset.get(assetId);
  if(!['fig','op'].includes(entry.format)) throw Error('Only .fig and .op documents have a native resource index.');
  const info=entry.format==='fig'?(converterInfo || await converter()):{version:'native-op',sha256:null};
  const fingerprint=sha256(`${entry.sha256}:${info.sha256 || info.version}`);
  const indexPath=join(dataset.directory,'native',`${fingerprint}.index.json`);
  await dataset.ensure();
  return withLibraryLock(join(dataset.directory,'native'),async()=>{
    try {
      const cached=validateIndex(JSON.parse(await safeBytes(indexPath,INDEX_LIMIT)),entry);
      const bytes=await safeBytes(join(dataset.directory,cached.relativePath),NATIVE_LIMIT);
      if(sha256(bytes)!==cached.nativeSha256 || bytes.length!==cached.bytes) throw Error('Converted resource checksum changed.');
      if(dataset.recordNative) await dataset.recordNative(entry.id,{relativePath:`native/${fingerprint}.index.json`,nativeSha256:cached.nativeSha256,pageCount:cached.pageCount,nodeCount:cached.nodeCount,converter:cached.converter,warnings:cached.warnings});
      return {...cached,assetId:entry.id,sourceUrl:entry.sourceUrl,path:join(dataset.directory,cached.relativePath),cached:true};
    } catch(error) {if(error.code!=='ENOENT') throw error;}
    const temporary=join(dataset.directory,'native',`.conversion-${randomUUID()}.op`);
    try {
      let report={warnings:[]},bytes;
      if(entry.format==='fig') {
        report=await runConverter(info.path,['import:figma',entry.path,'--out',temporary]);
        bytes=await safeBytes(temporary,NATIVE_LIMIT);
      } else bytes=await safeBytes(entry.path,NATIVE_LIMIT);
      const document=JSON.parse(bytes);
      const pages=Array.isArray(document.pages)&&document.pages.length?document.pages:[document];
      if(!pages.every(page=>Array.isArray(page.children))) throw Error('Native conversion produced an invalid document.');
      const summaries=pages.map(pageSummary),nativeSha256=sha256(bytes);
      const relativePath=`native/${nativeSha256}.op`;
      const result={schemaVersion:1,assetId:entry.id,sourceSha256:entry.sha256,sourceBytes:entry.bytes,sourceUrl:entry.sourceUrl,
        nativeSha256,relativePath,bytes:bytes.length,converter:{version:info.version,sha256:info.sha256},
        warnings:Array.isArray(report.warnings)?report.warnings.map(String):[],pageCount:summaries.length,nodeCount:summaries.reduce((sum,page)=>sum+page.nodeCount,0),
        pages:summaries,convertedAt:new Date().toISOString()};
      await dataset.storeObject(relativePath,bytes);
      const serialized=JSON.stringify(result)+'\n';
      if(Buffer.byteLength(serialized)>INDEX_LIMIT) throw Error('Converted resource metadata exceeds its size limit. Original bytes retained.');
      await atomicBytes(indexPath,serialized);
      if(dataset.recordNative) await dataset.recordNative(entry.id,{relativePath:`native/${fingerprint}.index.json`,nativeSha256,pageCount:result.pageCount,nodeCount:result.nodeCount,converter:result.converter,warnings:result.warnings});
      return {...result,path:join(dataset.directory,relativePath),cached:false};
    } finally {await rm(temporary,{force:true});}
  },`.${fingerprint}.lock`);
}
// Keep the complete discovery index on disk; tool replies carry bounded summaries.
const previewText = value => String(value).slice(0,256);
function publicPage(page) {
  return {id:page.id,name:previewText(page.name),index:page.index,nodeCount:page.nodeCount,topLevelCount:page.topLevelCount,types:page.types};
}
export function nativeResourceSummary(resource,{includePages=false}={}) {
  const {pages,warnings=[],...summary}=resource;
  return {...summary,warnings:warnings.slice(0,64).map(previewText),warningsTotal:warnings.length,
    ...(includePages && {pages:pages.map(publicPage)})};
}
export async function inspectLibraryAsset(dataset,{assetId,query='',pageId,offset=0,limit=32,namesOffset=0,namesLimit=32}={}) {
  if(typeof query!=='string' || query.length>512 || !Number.isSafeInteger(offset) || offset<0 || !Number.isSafeInteger(limit) || limit<1 || limit>100 ||
    !Number.isSafeInteger(namesOffset) || namesOffset<0 || !Number.isSafeInteger(namesLimit) || namesLimit<1 || namesLimit>32) throw Error('Invalid native resource inspection parameters.');
  const resource=await prepareLibraryAsset(dataset,assetId);
  const terms=query.toLowerCase().split(/\s+/).filter(Boolean);
  const pages=resource.pages.filter(page=>(!pageId || page.id===pageId) && terms.every(term=>[page.name,...page.names].join(' ').toLowerCase().includes(term)));
  return {...nativeResourceSummary(resource),total:pages.length,offset,limit,pages:pages.slice(offset,offset+limit).map(page=>{
    const matched=page.names.filter(name=>terms.every(term=>name.toLowerCase().includes(term)));
    return {...publicPage(page),namesTotal:page.names.length,namesMatched:matched.length,namesOffset,namesLimit,
      names:matched.slice(namesOffset,namesOffset+namesLimit).map(previewText),namesHasMore:namesOffset+namesLimit<matched.length};
  })};
}
