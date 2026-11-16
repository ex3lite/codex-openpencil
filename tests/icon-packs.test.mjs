import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { CommunityDataset, dispatchCommunityTool } from '../plugins/openpencil/scripts/community-assets.mjs';
import { COOLICONS_PRESET, IconPackLibrary, iconPackTools, readIconZip } from '../plugins/openpencil/scripts/icon-packs.mjs';

const svg=n=>Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0L${n} 10"/></svg>`);
const hash=b=>createHash('sha256').update(b).digest('hex');
function crc32(bytes) {let crc=0xffffffff;for(const b of bytes){crc^=b;for(let i=0;i<8;i++)crc=crc&1?0xedb88320^(crc>>>1):crc>>>1;}return (crc^0xffffffff)>>>0;}
function zip(items,{method=8,symlink=false}={}) {
 const locals=[],central=[];let offset=0;
 for(const [name,input] of items){const bytes=Buffer.from(input),encoded=Buffer.from(name),data=method===8?deflateRawSync(bytes):bytes;
  const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(method,8);
  local.writeUInt32LE(crc32(bytes),14);local.writeUInt32LE(data.length,18);local.writeUInt32LE(bytes.length,22);local.writeUInt16LE(encoded.length,26);
  const row=Buffer.alloc(46);row.writeUInt32LE(0x02014b50);row.writeUInt16LE(0x314,4);row.writeUInt16LE(20,6);row.writeUInt16LE(method,10);
  row.writeUInt32LE(crc32(bytes),16);row.writeUInt32LE(data.length,20);row.writeUInt32LE(bytes.length,24);row.writeUInt16LE(encoded.length,28);
  row.writeUInt32LE((symlink?0xa1ff:0x81a4)*65536,38);row.writeUInt32LE(offset,42);
  const chunk=Buffer.concat([local,encoded,data]);locals.push(chunk);central.push(row,encoded);offset+=chunk.length;
 }
 const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(items.length,8);end.writeUInt16LE(items.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
 return Buffer.concat([...locals,directory,end]);
}
const manifest={id:'example-icons',name:'Example Icons',communityUrl:'https://www.figma.com/community/file/123456789/example',author:'Original Author',repository:'original/icons',assetPrefix:'icons-',licenseSpdx:'MIT',licensePath:'LICENSE',svgRoot:'svg',layout:'style/radius/name'};
const license='MIT License\nCopyright Original Author\nPermission is hereby granted to use and modify.';
const pack=n=>zip([['LICENSE',license],['manifest.json',JSON.stringify({icons:[{name:'house',category:'Buildings'},{name:'search',category:'Interface'}]})],['svg/line/regular/house.svg',svg(n)],['svg/fill/round/house.svg',svg(n+1)],['svg/line/regular/search.svg',svg(n+2)]]);
async function fixture(t) {
 const root=await realpath(await mkdtemp(join(tmpdir(),'icon-packs-')));t.after(()=>rm(root,{recursive:true,force:true}));let version=1;const requests=[];
 const archives={1:pack(1),2:pack(7)};
 const fetchImpl=async url=>{requests.push(url);
  if(url.includes('/community/'))return new Response('<html>No original cover</html>');
  if(url.endsWith('/releases/latest'))return Response.json({tag_name:`v${version}`,published_at:'2026-11-14T00:00:00Z',assets:[{name:`icons-${version}.zip`,browser_download_url:`https://github.com/original/icons/releases/download/v${version}/icons.zip`,size:archives[version].length}]});
  if(url.includes('/releases/download/'))return new Response(archives[Number(url.match(/\/v(\d)\//)[1])]);
  throw Error(`Unexpected request ${url}`);
 };
 const dataset=new CommunityDataset(root,{libraryRoot:join(root,'library'),fetchImpl,lookupImpl:async()=>[{address:'93.184.216.34',family:4}]});
 return {root,dataset,library:new IconPackLibrary(dataset),requests,setVersion:n=>{version=n;}};
}

test('ZIP rejects traversal, duplicate names, symlinks, encrypted input, bombs, corruption and overlapping entries',()=>{
 for(const name of ['../evil.svg','/etc/test.svg','C:/test.svg','svg/../test.svg','svg\\test.svg','a//test.svg'])assert.throws(()=>readIconZip(zip([[name,svg(1)]])),/Unsafe/);
 assert.throws(()=>readIconZip(zip([['a.svg',svg(1)],['a.svg',svg(1)]])),/duplicate/);
 assert.throws(()=>readIconZip(zip([['a.svg',svg(1)]],{symlink:true})),/symlink/);
 const encrypted=zip([['a.svg',svg(1)]]);encrypted.writeUInt16LE(1,6);encrypted.writeUInt16LE(1,encrypted.indexOf(Buffer.from('504b0102','hex'))+8);assert.throws(()=>readIconZip(encrypted),/encoding/);
 assert.throws(()=>readIconZip(zip([['bomb.svg',Buffer.alloc(1000000,65)]])),/expansion/);
 const corrupt=zip([['a.svg',svg(1)]],{method:0});corrupt[35]^=1;assert.throws(()=>readIconZip(corrupt),/checksum/);
 const overlap=zip([['a.svg',svg(1)],['b.svg',svg(1)]]);const first=overlap.indexOf(Buffer.from('504b0102','hex')),second=overlap.indexOf(Buffer.from('504b0102','hex'),first+4);overlap.writeUInt32LE(0,second+42);assert.throws(()=>readIconZip(overlap),/mismatch|overlapping/);
 assert.equal(readIconZip(zip([['a.svg',svg(1)]])).get('a.svg').toString(),svg(1).toString());
});

test('full pack cache remains grouped; bounded search selects exactly one project reference with source identity and license',async t=>{
 const {library,dataset,requests}=await fixture(t);
 const before=await library.list();assert.equal(before.packs[0].originalCommunityId,'800815864899415771');assert.equal(before.packs[0].installed,false);
 const acquired=await library.acquire({manifest});assert.equal(acquired.count,3);assert.equal(acquired.iconCount,2);assert.equal(acquired.originalCommunityId,'123456789');assert.equal(acquired.files,undefined);assert.equal(acquired.licenseText,undefined);
 assert.equal((await dataset.index()).assets.length,0);assert.equal(acquired.coverStatus,'unavailable');assert.equal(acquired.cover,null);
 const search=await library.search({packId:manifest.id,query:'Buildings',limit:1,previews:true});assert.equal(search.total,1);assert.equal(search.icons[0].key,'line/regular/house.svg');assert.match(search.icons[0].previewDataUrl,/^data:image\/svg/);
 assert.equal((await library.search({packId:manifest.id,query:'house',allVariants:true})).total,2);
 await assert.rejects(library.search({packId:manifest.id,limit:33}),/Invalid/);
 const selected=await library.select({packId:manifest.id,key:search.icons[0].key});assert.equal(selected.sourcePack.originalCommunityId,'123456789');assert.equal(selected.sourcePack.revision,'v1');assert.equal(selected.sourcePack.archiveSha256,acquired.archiveSha256);
 assert.equal((await dataset.search({scope:'project'})).total,1);assert.equal(selected.license.spdx,'MIT');assert.equal((await dataset.index()).assets.length,1);
 assert.equal(requests.filter(u=>u.includes('/community/')).length,1);
 const repeated=await library.acquire({manifest});assert.equal(repeated.cached,true);assert.equal(requests.filter(u=>u.includes('/releases/download/')).length,1);
 let version=3,calls=0,changes=0;
 const controller={project:{projectRoot:dataset.projectRoot},options:{community:{libraryRoot:dataset.directory}},persistence:{changed:()=>changes++},session:{
  document:async()=>({version,activePageIndex:0,document:{pages:[{id:'page',children:[]}]}}),
  forward:async message=>{assert.equal(message.params.name,'import_svg');assert.equal(message.params.arguments.svg,svg(1).toString());calls++;version++;return {result:{content:[]}};}
 }};
 const imported=await dispatchCommunityTool(controller,'canvas_community_import',{assetId:selected.id,pageId:'page',expectedVersion:3});
 assert.equal(imported.editable,true);assert.equal(calls,1);assert.equal(changes,1);assert.equal(imported.asset.sourcePack.originalCommunityId,'123456789');
});

test('update CAS preserves original Figma ID, attribution, old selected SVG and previous immutable revision',async t=>{
 const {library,dataset,root,setVersion}=await fixture(t);await library.acquire({manifest});
 const key='line/regular/house.svg',old=await library.select({packId:manifest.id,key}),oldBytes=await readFile(old.path),oldManifest=(await library.index()).packs[0].manifestSha256;
 setVersion(2);assert.equal((await library.check({packId:manifest.id})).updateAvailable,true);
 await assert.rejects(library.update({packId:manifest.id,expectedRevision:'stale'}),/revision changed/);
 const updated=await library.update({packId:manifest.id,expectedRevision:'v1'});assert.equal(updated.revision,'v2');assert.equal(updated.originalCommunityId,'123456789');assert.equal(updated.author,'Original Author');
 assert.deepEqual(await readFile(old.path),oldBytes);assert.equal((await dataset.get(old.id)).entry.sourcePack.revision,'v1');
 assert.ok(await readFile(join(root,'library','packs','revisions',`${oldManifest}.json`)));
 const current=await library.select({packId:manifest.id,key});assert.notEqual(current.id,old.id);assert.equal(current.sourcePack.revision,'v2');
 assert.equal((await dataset.search({scope:'project'})).total,2);assert.equal((await library.check({packId:manifest.id})).updateAvailable,false);
});

test('stored SVG, retained license and revision manifests are checksum checked before selection',async t=>{
 for(const target of ['svg','license','manifest']) {
  const {library,root}=await fixture(t);await library.acquire({manifest});const revision=await library.revision(manifest.id);let path;
  if(target==='svg')path=join(root,'library','packs','objects',`${revision.files.find(f=>f.key==='line/regular/house.svg').sha256}.svg`);
  else if(target==='license')path=join(root,'library','packs','objects',`${revision.licenseSha256}.txt`);
  else path=join(root,'library','packs','revisions',`${(await library.index()).packs[0].manifestSha256}.json`);
  await writeFile(path,'tampered');await assert.rejects(library.select({packId:manifest.id,key:'line/regular/house.svg'}),/checksum/);
 }
});

test('custom pack requires public original Figma and GitHub identity and rejects active SVG before publishing a pack',async t=>{
 const {library,dataset}=await fixture(t);
 for(const changes of [{communityUrl:'https://example.com/file/123'},{repository:'../private'},{licensePath:'../LICENSE'},{svgRoot:'/tmp'}])await assert.rejects(library.acquire({manifest:{...manifest,...changes}}));
 const bad=zip([['LICENSE',license],['svg/line/regular/evil.svg','<svg><script>alert(1)</script></svg>']]);
 library.latest=async()=>({revision:'v1',version:'1',url:'https://example.com/icons.zip',bytes:bad.length});library.fetch=async url=>({bytes:bad,url});
 await assert.rejects(library.acquire({manifest}),/inactive/);assert.equal((await library.index()).packs.length,0);assert.equal((await dataset.index()).assets.length,0);
 assert.equal(iconPackTools.length,6);assert.equal(COOLICONS_PRESET.communityUrl.match(/file\/(\d+)/)[1],'800815864899415771');
 assert.ok(iconPackTools.every(tool=>tool.inputSchema.additionalProperties===false));
});

test('original cover can be acquired from the exact Community og:image without changing source revision or icons',async t=>{
 const {library,dataset,root}=await fixture(t);const before=await library.acquire({manifest});
 const originalFetch=dataset.network.fetchImpl,png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j14sAAAAASUVORK5CYII=','base64');
 dataset.network.fetchImpl=async(url,args)=>url==='https://cdn.example/cover.png'?new Response(png):originalFetch(url,args);
 const after=await library.acquire({manifest,coverUrl:'https://cdn.example/cover.png'});
 assert.equal(after.coverStatus,'original');assert.equal(after.revision,before.revision);assert.equal(after.archiveSha256,before.archiveSha256);assert.equal(after.count,before.count);
 assert.equal(after.cover.pageUrl,manifest.communityUrl);assert.equal(after.cover.sha256,hash(png));
 assert.deepEqual(await readFile(join(root,'library',after.cover.relativePath)),png);
 assert.ok((await library.list({previews:true})).packs.find(p=>p.id===manifest.id).coverDataUrl.startsWith('data:image/png;base64,'));
 assert.ok(await readFile(join(root,'library','packs','archives',`${after.archiveSha256}.zip`)));
 const coverPath=join(root,'browser-original.png');await writeFile(coverPath,png);
 await assert.rejects(library.acquire({manifest,coverPath}),/source coverUrl/);
 dataset.network.fetchImpl=async()=>{throw Error('Remote original temporarily unavailable');};
 const cached=await library.acquire({manifest,coverPath,coverUrl:'https://cdn.example/cover.png'});
 assert.equal(cached.cover.sha256,hash(png));assert.equal(cached.revision,before.revision);
});
