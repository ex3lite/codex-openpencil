import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { CommunityDataset, ProjectCommunityDataset, dispatchCommunityTool } from '../plugins/openpencil/scripts/community-assets.mjs';
import { prepareLibraryAsset, nativeResourceSummary } from '../plugins/openpencil/scripts/library-conversion.mjs';
import { withLibraryLock } from '../plugins/openpencil/scripts/library-storage.mjs';
const svg='<svg><path d="M0 0 L10 10"/></svg>';
const metadata={kind:'reference',name:'Shared buttons',author:'Designer',sourceUrl:'https://example.com/ui',licenseSpdx:'MIT',licenseText:'Copyright Designer. Permission granted.',tags:['buttons']};
async function fixture(t) {
  const root=await realpath(await mkdtemp(join(tmpdir(),'global-library-')));t.after(()=>rm(root,{recursive:true,force:true}));
  const a=join(root,'a'),b=join(root,'b'),libraryRoot=join(root,'global');await mkdir(a);await mkdir(b);
  const sourcePath=join(root,'source.svg');await writeFile(sourcePath,svg);
  return {root,a,b,sourcePath,libraryRoot,first:new CommunityDataset(a,{libraryRoot}),second:new CommunityDataset(b,{libraryRoot})};
}
test('global content deduplication retains provenance and per-project references',async t=>{
  const {first,second,sourcePath,libraryRoot}=await fixture(t);
  const entry=await first.ingest({...metadata,sourcePath});
  assert.equal((await second.search()).total,1);assert.equal((await second.search({scope:'project'})).total,0);
  const duplicate=await second.ingest({...metadata,sourcePath});assert.equal(duplicate.duplicate,true);
  assert.equal((await second.search({scope:'project'})).total,1);
  const alternate=await second.ingest({...metadata,sourcePath,sourceUrl:'https://other.example/ui'});
  assert.notEqual(alternate.id,entry.id);assert.equal(alternate.path,entry.path);
  assert.equal((await readdir(join(libraryRoot,'assets'))).length,1);
  assert.equal((await stat(libraryRoot)).mode & 0o777,0o700);
  await writeFile(join(first.projectRoot,'changed.op'),'project-only');
  assert.equal(await readFile(entry.path,'utf8'),svg);
});
test('legacy migration preserves exact original, license and identity without deleting project evidence',async t=>{
  const {a,first,sourcePath}=await fixture(t);const legacy=new ProjectCommunityDataset(a);
  const entry=await legacy.ingest({...metadata,sourcePath});
  const migrated=await first.search({scope:'project'});assert.equal(migrated.assets[0].id,entry.id);
  assert.equal(await readFile(migrated.assets[0].path,'utf8'),svg);
  assert.equal(await readFile(entry.path,'utf8'),svg);
  assert.equal((await new CommunityDataset(a,{libraryRoot:first.directory}).search()).total,1);
});
test('global settings inherit into projects without overriding project license policy',async t=>{
  const {first,second,sourcePath}=await fixture(t);
  await first.settings({scope:'global',verifyLicenses:false,autonomous:false});
  assert.deepEqual(await second.settings(),{verifyLicenses:false,autonomous:false});
  await first.settings({verifyLicenses:true});
  await assert.rejects(first.ingest({...metadata,sourcePath,licenseText:undefined}),/License verification/);
  const entry=await second.ingest({...metadata,sourcePath,licenseText:undefined,licenseSpdx:undefined});
  assert.equal(entry.license.status,'unknown');assert.equal((await first.search()).assets[0].available,false);
  await second.settings({scope:'global',autonomous:true});assert.equal((await first.settings()).autonomous,true);
});
test('dead process lock is recoverable and a live writer is never retried',async t=>{
  const {first,sourcePath,libraryRoot}=await fixture(t);await first.ensure();
  await writeFile(join(libraryRoot,'.write-lock'),JSON.stringify({pid:2147483647,token:'dead'}));
  assert.ok((await first.ingest({...metadata,sourcePath})).id);
  await withLibraryLock(libraryRoot,async()=>{
    await assert.rejects(first.ingest({...metadata,sourcePath}),/Another dataset writer/);
  });
});
test('headless conversion indexes every page, fingerprints converter and source, and caches exact output',async t=>{
  const {first,root}=await fixture(t);const sourcePath=join(root,'kit.fig');await writeFile(sourcePath,'fig-kiwi-fixture');
  const entry=await first.ingest({...metadata,sourcePath});
  const runtime={root:join(root,'runtime'),version:'0.8.6'};await mkdir(join(runtime.root,'bin'),{recursive:true});await writeFile(join(runtime.root,'bin','op'),'test-converter-v1');
  let calls=0;const runConverter=async(_binary,args)=>{
    const output=args[3];
    calls++;const pages=Array.from({length:77},(_,i)=>({id:`p${i}`,name:`Page ${i}`,children:[{id:`f${i}`,type:'frame',name:`Buttons ${i}`,children:[{id:`t${i}`,type:'text',name:'Label'}]}]}));
    await writeFile(output,JSON.stringify({version:'0.8.6',pages}));return {ok:true,warnings:['Font unavailable']};
  };
  const converterInfo={path:join(runtime.root,'bin','op'),version:runtime.version,sha256:createHash('sha256').update('test-converter-v1').digest('hex')};
  const resource=await prepareLibraryAsset(first,entry.id,{converterInfo,runConverter});
  assert.equal(resource.pageCount,77);assert.equal(resource.nodeCount,154);assert.equal(resource.pages[76].types.text,1);assert.equal(resource.warnings[0],'Font unavailable');
  assert.equal((await first.search({query:'Buttons 76',previews:false})).total,1);
  assert.equal(resource.sourceSha256,entry.sha256);assert.match(resource.converter.sha256,/^[a-f0-9]{64}$/);
  const cached=await prepareLibraryAsset(first,entry.id,{converterInfo,runConverter});assert.equal(cached.cached,true);assert.equal(calls,1);
  await writeFile(join(runtime.root,'bin','op'),'test-converter-v2');
  converterInfo.sha256=createHash('sha256').update('test-converter-v2').digest('hex');
  await prepareLibraryAsset(first,entry.id,{converterInfo,runConverter});assert.equal(calls,2);
  assert.equal(JSON.parse(await readFile(resource.path)).pages.length,77);
  await writeFile(resource.path,'changed');
  await assert.rejects(prepareLibraryAsset(first,entry.id,{converterInfo,runConverter}),/checksum/);
});

test('tool summaries bound large node-name indexes while internal discovery remains complete',async t=>{
  const {first,root,a,libraryRoot}=await fixture(t);
  const sourcePath=join(root,'large-names.op');
  const pages=Array.from({length:77},(_,page)=>({id:`p${page}`,name:`Page ${page}`,children:Array.from({length:1000},(_,node)=>({id:`p${page}-n${node}`,type:'text',name:`Searchable label ${page}-${String(node).padStart(4,'0')}`,content:'Label'}))}));
  await writeFile(sourcePath,JSON.stringify({version:'0.8.6',pages}));
  const entry=await first.ingest({...metadata,sourcePath});
  const controller={project:{projectRoot:a},options:{community:{libraryRoot}}};
  const internal=await first.prepare(entry.id);assert.equal(internal.pages[76].names.length,1000);
  const prepared=await dispatchCommunityTool(controller,'canvas_community_prepare',{assetId:entry.id});
  assert.equal(prepared.pages.length,77);
  assert.ok(Buffer.byteLength(JSON.stringify(prepared))<32*1024,'Prepare descriptors must stay small despite the complete name index.');
  assert.equal(Object.hasOwn(nativeResourceSummary(internal),'pages'),false,'Import conversion summaries must not expose full page/name indexes.');assert.equal(prepared.pages[76].nodeCount,1000);
  assert.ok(prepared.pages.every(page=>!Object.hasOwn(page,'names')));
  assert.ok(Buffer.byteLength(JSON.stringify(prepared))<20000,'Prepare reply must contain metadata, not the all-node name index.');
  const inspected=await dispatchCommunityTool(controller,'canvas_community_inspect',{assetId:entry.id,query:'Searchable label',offset:76,limit:1});
  assert.equal(inspected.total,77);assert.equal(inspected.pages.length,1);
  const page=inspected.pages[0];assert.equal(page.namesTotal,1000);assert.equal(page.namesMatched,1000);assert.equal(page.names.length,32);assert.equal(page.namesHasMore,true);
  const next=await dispatchCommunityTool(controller,'canvas_community_inspect',{assetId:entry.id,pageId:'p76',namesOffset:32,namesLimit:16});
  assert.equal(next.pages[0].names.length,16);assert.equal(next.pages[0].namesOffset,32);
  assert.ok(!page.names.includes(next.pages[0].names[0]),'Name pagination must advance through matches.');
  assert.equal((await first.prepare(entry.id)).pages[76].names.length,1000,'Tool summaries must not truncate the cache.');
  assert.equal((await first.search({query:'76-0999',previews:false})).total,1,'Full internal discovery remains searchable.');
});
