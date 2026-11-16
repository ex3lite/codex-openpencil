import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, symlink, mkdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommunityDataset, communityTools, dispatchCommunityTool, communityAssetFile } from '../plugins/openpencil/scripts/community-assets.mjs';

const svg='<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><path d="M2 2L20 20" stroke="black"/></svg>';
const license='Copyright Example. Permission to use, copy and modify.';
const metadata={name:'Search icon',kind:'icon',sourceUrl:'https://example.com/search',author:'Example',licenseSpdx:'MIT',licenseText:license,tags:['search','поиск']};
async function fixture(t,options) {
  const root=await realpath(await mkdtemp(join(tmpdir(),'community-dataset-')));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const sourcePath=join(root,'source.svg'); await writeFile(sourcePath,svg);
  return {root,sourcePath,dataset:new CommunityDataset(root,options)};
}
test('ingest retains bytes, license and provenance; search and repeated ingestion are deterministic', async t=>{
  const {root,sourcePath,dataset}=await fixture(t);
  const result=await dataset.ingest({...metadata,sourcePath});
  assert.equal(result.duplicate,false); assert.equal(await readFile(result.path,'utf8'),svg);
  const index=JSON.parse(await readFile(join(root,'.openpencil/community/index.json')));
  assert.equal(await readFile(join(root,'.openpencil/community',index.assets[0].license.textPath),'utf8'),license);
  assert.equal((await dataset.ingest({...metadata,sourcePath})).duplicate,true);
  const found=await dataset.search({query:'поиск'});
  assert.equal(found.total,1); assert.equal(found.assets[0].available,true); assert.equal(found.assets[0].importMode,'vector');
  assert.match(found.assets[0].previewDataUrl,/^data:image\/svg\+xml;base64,/);
  assert.equal((await dataset.search({query:'missing'})).total,0);
  assert.equal((await dataset.search({kind:'reference'})).total,0);
});
test('symlinks, active SVG and foreign resource references are rejected before indexing',async t=>{
  const {root,sourcePath,dataset}=await fixture(t);
  const link=join(root,'link.svg'); await symlink(sourcePath,link);
  await assert.rejects(dataset.ingest({...metadata,sourcePath:link}),/symlink/);
  for(const attack of ['<script>alert(1)</script>','<image href="https://example.com/x"/>','<path onload="x"/>','<style>@import "evil";</style>']) {
    await writeFile(sourcePath,`<svg>${attack}</svg>`);
    await assert.rejects(dataset.ingest({...metadata,sourcePath}),/self-contained/);
  }
  await assert.rejects(dataset.ingest({...metadata,sourcePath,sourceUrl:'http://localhost'}));
});
test('dataset refuses storage symlinks and flags changed local bytes rather than showing a preview',async t=>{
  const {root,sourcePath,dataset}=await fixture(t);
  const entry=await dataset.ingest({...metadata,sourcePath}); await writeFile(entry.path,svg+'changed');
  const found=await dataset.search(); assert.equal(found.assets[0].available,false); assert.equal(found.assets[0].previewDataUrl,undefined);
  await assert.rejects(dataset.get(entry.id),/checksum/);
  const other=await realpath(await mkdtemp(join(tmpdir(),'community-other-'))); t.after(()=>rm(other,{recursive:true,force:true}));
  await mkdir(join(other,'.openpencil')); await symlink(join(root,'.openpencil/community'),join(other,'.openpencil/community'));
  await assert.rejects(new CommunityDataset(other).search(),/symlinks/);
});
test('downloads use fixed HTTPS public hosts, never redirects, and preserve exact checked bytes',async t=>{
  const requests=[];
  const fetchImpl=async(url,options)=>{requests.push({url,options}); return new Response(url.endsWith('LICENSE')?license:svg);};
  const {dataset}=await fixture(t,{fetchImpl});
  const result=await dataset.download({...metadata,licenseText:undefined,licenseUrl:'https://raw.githubusercontent.com/example/icons/main/LICENSE',url:'https://raw.githubusercontent.com/example/icons/main/search.svg'});
  assert.equal(result.format,'svg'); assert.equal(requests.length,2); assert.equal(requests[0].options.redirect,'error');
  for (const url of ['http://127.0.0.1/a.svg','https://127.0.0.1/a.svg','https://www.figma.com/community/file/123/x','https://raw.githubusercontent.com/x.svg?token=secret']) {
    await assert.rejects(dataset.download({...metadata,url}));
  }
  await assert.rejects(dataset.download({...metadata,url:'https://raw.githubusercontent.com/example/x.svg',expectedSha256:'0'.repeat(64)}),/checksum/);
});
test('SVG import guards page, version and parent then makes one native edit; .fig requires native import',async t=>{
  const {root,sourcePath,dataset}=await fixture(t);
  const entry=await dataset.ingest({...metadata,sourcePath});
  let version=7; const calls=[]; let saves=0;
  const controller={project:{projectRoot:root},persistence:{changed:()=>saves++},session:{document:async()=>({version,activePageIndex:0,document:{pages:[{id:'p',children:[{id:'f',type:'frame',children:[]}]}]}}),forward:async msg=>{calls.push(msg);version++;return {result:{content:[]}};}}};
  await assert.rejects(dispatchCommunityTool(controller,'canvas_community_import',{assetId:entry.id,pageId:'p',expectedVersion:6}),/version/);
  const imported=await dispatchCommunityTool(controller,'canvas_community_import',{assetId:entry.id,pageId:'p',parentId:'f',expectedVersion:7});
  assert.equal(imported.editable,true); assert.equal(calls.length,1); assert.equal(calls[0].params.name,'import_svg'); assert.equal(saves,1);
  const figPath=join(root,'test.fig');await writeFile(figPath,'fig-kiwi-fixture');
  const fig=await dataset.ingest({...metadata,kind:'reference',sourcePath:figPath});
  const retained=await dispatchCommunityTool(controller,'canvas_community_import',{assetId:fig.id});
  assert.equal(retained.imported,false); assert.equal(retained.requiresNativeImport,true); assert.equal(calls.length,1);
});
test('model file-reading and network tools are not exposed to app UI',()=>{
  for(const name of ['canvas_community_ingest','canvas_community_download','canvas_community_seed']) assert.deepEqual(communityTools.find(tool=>tool.name===name)._meta.ui.visibility,['model']);
});

test('App Figma transport verifies bytes and keeps binary payload out of model text',async t=>{
  const {root,sourcePath,dataset}=await fixture(t);
  const svgAsset=await dataset.ingest({...metadata,sourcePath});
  const controller={project:{projectRoot:root}};
  await assert.rejects(communityAssetFile(controller,{assetId:svgAsset.id}),/only a Figma/);
  const figPath=join(root,'kit.fig'),binary=Buffer.from('fig-kiwi-binary-fixture');
  await writeFile(figPath,binary);
  const asset=await dataset.ingest({...metadata,sourcePath:figPath,kind:'ui-kit'});
  const result=await communityAssetFile(controller,{assetId:asset.id});
  assert.equal(result.structuredContent.format,'fig');
  assert.deepEqual(Buffer.from(result._meta.communityFile.body,'base64'),binary);
  assert.ok(!JSON.stringify(result.content).includes(binary.toString('base64')));
  assert.ok(!JSON.stringify(result.structuredContent).includes(binary.toString('base64')));
  assert.deepEqual(communityTools.find(tool=>tool.name==='canvas_community_file')._meta.ui.visibility,['app']);
  await writeFile(asset.path,'tampered');
  await assert.rejects(communityAssetFile(controller,{assetId:asset.id}),/checksum/);
});
