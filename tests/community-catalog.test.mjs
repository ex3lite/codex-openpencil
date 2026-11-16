import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,chmod,mkdir,symlink,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {CommunityBrowser} from '../plugins/openpencil/scripts/community-browser.mjs';
import {CommunityCatalog,catalogTools,validateCommunityCard} from '../plugins/openpencil/scripts/community-catalog.mjs';
import {CommunityDataset} from '../plugins/openpencil/scripts/community-assets.mjs';

const card={resourceId:'1382343443870598429',url:'https://www.figma.com/community/file/1382343443870598429/apple',title:'Apple landing page',author:'Original Author',description:'Original public design',coverUrl:'https://s3-alpha.figma.com/hub/file/123/original.png',downloads:[],license:{name:'CC BY 4.0',url:'https://creativecommons.org/licenses/by/4.0/'}};
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j14sAAAAASUVORK5CYII=','base64');
const sha=value=>createHash('sha256').update(value).digest('hex');
async function fixture(t){
 const root=await realpath(await mkdtemp(join(tmpdir(),'community-catalog-')));t.after(()=>rm(root,{recursive:true,force:true}));const calls=[];let current=structuredClone(card),corrupt=false;
 const browser={status:async()=>({ready:true}),request:async action=>{calls.push(action);
  if(action.kind==='search')return {source:'figma-community-dom',results:[current],hasMore:false};
  if(action.kind==='get')return current;
  if(action.kind==='image')return {token:'fixture-transfer',resourceId:card.resourceId,parts:1,bytes:png.length,sha256:corrupt?'0'.repeat(64):sha(png),sourceUrl:card.coverUrl,pageUrl:card.url};
  if(action.kind==='image.read')return {index:action.index,data:png.toString('base64')};
  if(action.kind==='image.close')return {closed:true};throw Error('Unexpected browser action');
 }};
 const dataset=new CommunityDataset(root,{libraryRoot:join(root,'library'),lookupImpl:async()=>[{address:'93.184.216.34',family:4}],fetchImpl:async url=>{assert.equal(url,'https://creativecommons.org/licenses/by/4.0/legalcode.txt');return new Response('Creative Commons Attribution 4.0 International Public License. Retained complete fixture terms.');}});
 return {root,dataset,browser,catalog:new CommunityCatalog(dataset,{browser}),calls,setCard:value=>{current=value;},corrupt:()=>{corrupt=true;}};
}
test('catalog searches the connected public Figma catalog directly with bounded metadata and no local/search-engine substitute',async t=>{
 const f=await fixture(t);const result=await f.catalog.search({query:'Apple landing page',limit:8});
 assert.deepEqual(f.calls,[{kind:'search',query:'Apple landing page',limit:8,offset:0}]);assert.equal(result.source,'figma-community');assert.equal(result.results[0].originalCommunityId,card.resourceId);assert.equal(result.results[0].figmaFileKey,undefined);assert.equal(result.results[0].coverUrl,card.coverUrl);assert.equal((await f.dataset.index()).assets.length,0);
 await assert.rejects(f.catalog.search({query:'',limit:8}),/nonempty/);await assert.rejects(f.catalog.search({query:'UI',limit:25}),/1–24/);
});
test('public Community IDs, page identity, cover hosts and attribution are validated independently',()=>{
 for(const changes of [{resourceId:'fileKeyNotCommunityId'},{url:'https://www.figma.com/design/1382343443870598429/x'},{url:'https://evil.example/community/file/'+card.resourceId},{coverUrl:'https://127.0.0.1/cover.png'},{coverUrl:'https://evil.example/cover.png'}])assert.throws(()=>validateCommunityCard({...card,...changes}));
 assert.throws(()=>validateCommunityCard(card,'111111111'),/another resource/);
 const unknown=validateCommunityCard({...card,license:{name:'Unknown',url:'https://example.com/terms'}});assert.equal(unknown.license.spdx,undefined);
});
test('resource detail retains immutable observed revisions and check detects changes without replacing acquired project references',async t=>{
 const f=await fixture(t),initial=await f.catalog.get({resourceId:card.resourceId});assert.equal(initial.originalCommunityId,card.resourceId);
 assert.equal((await f.catalog.check({resourceId:card.resourceId})).updateAvailable,false);
 f.setCard({...card,title:'Updated Apple landing page'});const check=await f.catalog.check({resourceId:card.resourceId});assert.equal(check.updateAvailable,true);assert.equal(check.revisionKind,'observed-public-metadata');
 const latest=await f.catalog.get({resourceId:card.resourceId});assert.notEqual(latest.fingerprint,initial.fingerprint);
 const prior=JSON.parse(await readFile(join(f.root,'library/community-catalog/versions',initial.fingerprint+'.json')));assert.equal(prior.title,card.title);
});
test('original cover acquisition retains real bytes, Community ID, license and one project/global reference',async t=>{
 const f=await fixture(t),result=await f.catalog.acquire({resourceId:card.resourceId,mode:'reference'});
 assert.equal(result.editable,false);assert.equal(result.mode,'reference');assert.equal(result.asset.originalCommunityId,card.resourceId);assert.equal(result.asset.kind,'reference');assert.equal(result.asset.cover.sourceUrl,card.coverUrl);assert.deepEqual(await readFile(result.asset.path),png);
 assert.equal((await f.dataset.search({scope:'project'})).total,1);assert.equal((await f.dataset.search({scope:'global'})).total,1);assert.equal(result.asset.license.spdx,'CC-BY-4.0');assert.ok(f.calls.some(c=>c.kind==='image.close'));
});
test('editable acquisition never relabels an original preview as .fig or editable layers',async t=>{
 const f=await fixture(t);await assert.rejects(f.catalog.acquire({resourceId:card.resourceId,mode:'editable'}),e=>e.code==='EDITABLE_DOWNLOAD_UNAVAILABLE');
 await assert.rejects(f.catalog.acquire({resourceId:card.resourceId,mode:'editable',downloadUrl:'https://unverified.example/file.fig'}),e=>e.code==='EDITABLE_DOWNLOAD_UNAVAILABLE');assert.equal((await f.dataset.index()).assets.length,0);
});
test('corrupt cover transfers are closed and write no asset; unknown licenses obey existing global policy',async t=>{
 const f=await fixture(t);f.corrupt();await assert.rejects(f.catalog.acquire({resourceId:card.resourceId}),e=>e.code==='COMMUNITY_IMAGE_CHECKSUM');assert.equal((await f.dataset.index()).assets.length,0);assert.ok(f.calls.some(c=>c.kind==='image.close'));
 const other=await fixture(t);other.setCard({...card,license:undefined});await assert.rejects(other.catalog.acquire({resourceId:card.resourceId}),e=>e.code==='COMMUNITY_LICENSE_UNVERIFIED');
 await other.dataset.settings({verifyLicenses:false});const acquired=await other.catalog.acquire({resourceId:card.resourceId});assert.equal(acquired.asset.license.status,'unknown');assert.equal(acquired.asset.license.responsibility,'user');
});
test('MCP contract exposes direct catalog tools and keeps image bytes out of model-visible catalog results',()=>{
 assert.equal(catalogTools.length,6);assert.ok(catalogTools.every(t=>t.inputSchema.additionalProperties===false));
 assert.deepEqual(catalogTools.find(t=>t.name.endsWith('_cover'))._meta.ui.visibility,['app']);assert.deepEqual(catalogTools.find(t=>t.name.endsWith('_acquire')).inputSchema.properties.mode.enum,['reference','editable']);
});
test('native catalog client checks private config and peer frames, supports real socket fragmentation and never invokes another provider',async t=>{
 const root=await mkdtemp('/private/tmp/community-wire-');t.after(()=>rm(root,{recursive:true,force:true}));const extensionId='a'.repeat(32),dir=join(root,extensionId),configPath=join(root,'config.json');await mkdir(dir,{mode:0o700});await writeFile(configPath,JSON.stringify({schemaVersion:1,bridgeRoot:root,extensionId}),{mode:0o600});
 const server=createServer(socket=>{let buffer='';socket.on('data',bytes=>{buffer+=bytes;const end=buffer.indexOf('\n');if(end<0)return;const request=JSON.parse(buffer.slice(0,end));assert.equal(request.method,'figma.community');assert.equal(request.params.kind,'get');const reply=JSON.stringify({id:request.id,result:card})+'\n';socket.write(reply.slice(0,30));setImmediate(()=>socket.end(reply.slice(30)));});});
 const socketPath=join(dir,process.pid+'-aabbccdd.sock');await new Promise(resolve=>server.listen(socketPath,resolve));await chmod(socketPath,0o600);t.after(()=>new Promise(resolve=>server.close(resolve)));
 const browser=new CommunityBrowser({configPath});assert.equal((await browser.request({kind:'get',resourceId:card.resourceId})).title,card.title);
 await chmod(configPath,0o644);await assert.rejects(browser.request({kind:'get',resourceId:card.resourceId}),e=>e.code==='UNSAFE_COMMUNITY_BROWSER_CONFIG');await chmod(configPath,0o600);
 const linked=join(root,'link.json');await symlink(configPath,linked);await assert.rejects(new CommunityBrowser({configPath:linked}).config(),e=>e.code==='UNSAFE_COMMUNITY_BROWSER_CONFIG');
});

test('standalone stdio MCP initializes, exposes real tools and reports provider setup errors without a search fallback',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'community-stdio-')));t.after(()=>rm(root,{recursive:true,force:true}));
 const child=spawn(process.execPath,['plugins/openpencil/scripts/figma-community-mcp.mjs','--project-root',root],{env:{...process.env,OPENPENCIL_CODEX_STATE_DIR:join(root,'state')},stdio:['pipe','pipe','pipe']});
 child.stderr.resume();const lines=createInterface({input:child.stdout});let sequence=0;const pending=new Map();
 lines.on('line',line=>{const value=JSON.parse(line),request=pending.get(value.id);if(!request)return;pending.delete(value.id);clearTimeout(request.timer);request.resolve(value);});
 t.after(()=>{lines.close();child.stdin.end();child.kill();for(const request of pending.values())clearTimeout(request.timer);});
 const rpc=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>reject(Error('MCP response timeout')),5000);pending.set(id,{resolve,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
 const initialized=await rpc('initialize',{protocolVersion:'2025-11-25'});assert.equal(initialized.result.serverInfo.name,'openbrush-figma-community');
 const listed=await rpc('tools/list');assert.deepEqual(listed.result.tools.map(t=>t.name),['figma_community_status','figma_community_search','figma_community_get','figma_community_acquire','figma_community_check']);
 const status=await rpc('tools/call',{name:'figma_community_status'});assert.equal(status.result.structuredContent.code,'COMMUNITY_BROWSER_NOT_CONFIGURED');
 const search=await rpc('tools/call',{name:'figma_community_search',arguments:{query:'Apple UI Kit'}});assert.equal(search.result.isError,true);assert.equal(search.result.structuredContent.code,'COMMUNITY_BROWSER_NOT_CONFIGURED');
});
