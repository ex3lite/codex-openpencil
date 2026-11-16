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
test('downloads retain exact checked bytes from public HTTPS sources',async t=>{
  const requests=[];
  const fetchImpl=async(url,options)=>{requests.push({url,options}); return new Response(url.endsWith('LICENSE')?license:svg);};
  const {dataset}=await fixture(t,{fetchImpl,lookupImpl:async()=>[{address:'93.184.216.34',family:4}]});
  const result=await dataset.download({...metadata,licenseText:undefined,licenseUrl:'https://raw.githubusercontent.com/example/icons/main/LICENSE',url:'https://raw.githubusercontent.com/example/icons/main/search.svg'});
  assert.equal(result.format,'svg'); assert.equal(requests.length,2); assert.equal(requests[0].options.redirect,'manual');
  for (const url of ['http://127.0.0.1/a.svg','https://127.0.0.1/a.svg','https://www.figma.com/community/file/123/x']) {
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

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII=','base64');
test('license verification defaults on; explicit project opt-out retains unknown status and known evidence',async t=>{
 const {dataset,sourcePath}=await fixture(t);
 const unknown={...metadata,sourcePath,licenseText:undefined,licenseSpdx:undefined};
 assert.deepEqual(await dataset.settings(),{verifyLicenses:true});
 await assert.rejects(dataset.ingest(unknown),/License verification/);
 await dataset.settings({verifyLicenses:false});
 const entry=await dataset.ingest(unknown);
 assert.equal(entry.license.status,'unknown');assert.equal(entry.license.responsibility,'user');assert.equal(entry.license.spdx,null);
 assert.equal((await dataset.get(entry.id)).entry.id,entry.id);
 await dataset.settings({verifyLicenses:true});
 assert.equal((await dataset.search()).assets[0].available,false);
 const upgraded=await dataset.ingest({...metadata,sourcePath});assert.equal(upgraded.license.status,'recorded');
 await dataset.settings({verifyLicenses:false});
 const partial=await dataset.ingest({...metadata,sourcePath,licenseSpdx:'NOASSERTION'});
 assert.equal(partial.license.status,'unknown');assert.ok(partial.license.sha256);
 assert.equal((await dataset.search()).assets[0].available,true);
});
test('original Community og:image cover is stored with provenance and checksum independently of asset preview',async t=>{
 const requests=[];
 const fetchImpl=async url=>{requests.push(url);return new Response(url.includes('/community/')?'<meta content="https://images.example/cover.png?a=1&amp;b=2" property="og:image">':png);};
 const {dataset,sourcePath,root}=await fixture(t,{fetchImpl,lookupImpl:async()=>[{address:'93.184.216.34',family:4}]});
 const entry=await dataset.ingest({...metadata,sourcePath,communityUrl:'https://www.figma.com/community/file/123/example'});
 assert.equal(entry.cover.method,'page-og-image');assert.equal(entry.cover.sourceUrl,'https://images.example/cover.png?a=1&b=2');
 assert.equal(entry.cover.pageUrl,entry.communityUrl);assert.equal(requests.length,2);
 const stored=join(root,'.openpencil/community',entry.cover.relativePath);
 assert.deepEqual(await readFile(stored),png);
 const found=(await dataset.search()).assets[0];assert.match(found.coverDataUrl,/^data:image\/png;base64,/);assert.match(found.previewDataUrl,/^data:image\/svg/);
 await writeFile(stored,'changed');
 const changed=(await dataset.search()).assets[0];assert.equal(changed.available,true);assert.equal(changed.coverDataUrl,undefined);assert.match(changed.coverError,/checksum/);
});
test('supplied original cover keeps exact bytes; local cover requires original source URL',async t=>{
 const {dataset,sourcePath,root}=await fixture(t);const coverPath=join(root,'cover.png');await writeFile(coverPath,png);
 await assert.rejects(dataset.ingest({...metadata,sourcePath,coverPath}),/coverUrl/);
 const entry=await dataset.ingest({...metadata,sourcePath,coverPath,coverUrl:'https://images.example/original.png'});
 assert.equal(entry.cover.method,'supplied-source');assert.deepEqual(await readFile(join(root,'.openpencil/community',entry.cover.relativePath)),png);
});
test('original AVIF covers retain exact bytes, validate ftyp brands and never become asset formats',async t=>{
 const {dataset,sourcePath,root}=await fixture(t);const coverPath=join(root,'original.avif');
 const ftyp=(major,compatible='mif1')=>{const bytes=Buffer.alloc(24);bytes.writeUInt32BE(24,0);bytes.write('ftyp',4);bytes.write(major,8);bytes.write(compatible,16);bytes.write('miaf',20);return bytes;};
 for(const [major,compatible] of [['avif','mif1'],['avis','mif1'],['mif1','avif']]) {
  const bytes=ftyp(major,compatible);await writeFile(coverPath,bytes);
  const entry=await dataset.ingest({...metadata,sourcePath,coverPath,coverUrl:'https://images.example/original.avif'});
  assert.equal(entry.cover.format,'avif');assert.deepEqual(await readFile(join(root,'.openpencil/community',entry.cover.relativePath)),bytes);
  const found=(await dataset.search()).assets[0];assert.equal(found.coverDataUrl,`data:image/avif;base64,${bytes.toString('base64')}`);
 }
 for(const bytes of [ftyp('heic','mif1'),Buffer.from('not AVIF despite avif text'),(()=>{const bytes=ftyp('avif');bytes.writeUInt32BE(4096,0);return bytes;})()]) {
  await writeFile(coverPath,bytes);await assert.rejects(dataset.ingest({...metadata,sourcePath,coverPath,coverUrl:'https://images.example/original.avif'}),/Original cover/);
 }
 await writeFile(coverPath,ftyp('avif'));
 await assert.rejects(dataset.ingest({...metadata,sourcePath:coverPath}),/Unsupported asset format/);
 assert.ok(!communityTools.find(tool=>tool.name==='canvas_community_download').inputSchema.properties.format.enum.includes('avif'));
});
