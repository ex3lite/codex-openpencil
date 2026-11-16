import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,mkdir,readFile,writeFile,readdir,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CanvasFonts,fontTools} from '../plugins/openpencil/scripts/canvas-fonts.mjs';
import {nativeRoute} from '../plugins/openpencil/scripts/native-canvas.mjs';
import {validateCanvasSessionOperation} from '../plugins/openpencil/scripts/canvas-session-broker.mjs';
import {sha256} from '../plugins/openpencil/scripts/editor-runtime.mjs';
async function fixture(t) {
  const root=await realpath(await mkdtemp(join(tmpdir(),'openbrush-font-lifecycle-'))),project=join(root,'project');await mkdir(project);
  const known=new Map(),calls={scans:0,ensure:[],registrations:0};let generation=0;
  const server=http.createServer(async(req,res)=>{
    const reply=data=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
    if(req.url!=='/api/mcp/fonts'){res.writeHead(404);res.end();return;}
    if(req.method==='POST') {
      assert.equal(req.headers['x-openpencil-token'],'owned-session');const chunks=[];for await(const c of req)chunks.push(c);
      for(const font of JSON.parse(Buffer.concat(chunks)).fonts){const bytes=Buffer.from(font.dataBase64,'base64'),hash=sha256(bytes);known.set(hash,{sha256:hash});}
      generation++;calls.registrations++;
    }
    reply({ok:true,generation,faces:[...known.values()],browser:{generation,loadedSha256:[...known.keys()],ready:true}});
  });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const library={async ensure(requirements,settings){calls.ensure.push({requirements,settings});const families=[];
    for(const r of requirements){const bytes=Buffer.from('mock-parsed-font:'+r.family),hash=sha256(bytes),path=join(root,hash+'.font');await writeFile(path,bytes);
      families.push({family:r.family,status:'ready',missingCodepoints:[],missingCodepointCount:0,faces:[{family:r.family,style:'normal',weight:400,weightMin:100,weightMax:900,path,sha256:hash,bytes:bytes.length,license:{spdx:'OFL-1.1'}}]});}
    return {families,totalFamilies:families.length,ready:families.length,partial:0,unavailable:0,disabled:0};},async list(){return {families:[],total:0};}};
  let doc={children:[{type:'text',id:'text',fontFamily:'Manrope',content:'Привет, Ёж!',fontWeight:700}]};
  const controller={options:{fonts:{library},community:{libraryRoot:join(root,'library')}},project:{projectRoot:project,directory:join(project,'.openpencil')},documentId:'document-1',
    session:{port:server.address().port,token:'owned-session',async document(){calls.scans++;return {document:doc};}}};
  const fonts=new CanvasFonts(controller);t.after(async()=>{fonts.close();await fonts.active?.catch(()=>{});server.closeAllConnections();await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true});});
  return {fonts,controller,calls,root,project,setDocument:value=>{doc=value;}};
}
test('automatic detection loads globally and registers bytes without embedding font files or changing text nodes',async t=>{
  const f=await fixture(t);f.fonts.attach();await f.fonts.lastTask;
  const status=await f.fonts.status();assert.equal(status.status,'ready');assert.equal(f.calls.registrations,2);
  assert.deepEqual(f.calls.ensure[0].requirements.map(r=>r.family),['Manrope','Noto Sans']);
  assert.ok(f.calls.ensure[0].requirements.find(r=>r.family==='Manrope').codepoints.includes('Ё'.codePointAt(0)));
  const raw=await readFile(join(f.project,'.openpencil/fonts/document-1.json'),'utf8');
  assert.ok(!raw.includes('mock-parsed-font'));assert.ok(!raw.includes('Привет'));assert.ok(!raw.includes(f.root));
  assert.deepEqual(await readdir(f.project),['.openpencil']);
  await f.fonts.readyForPreview();assert.equal(f.calls.ensure.length,1,'same requirements do not redownload before previews');
});
test('agent can acquire a new arbitrary family on demand without editing the project design',async t=>{
  const f=await fixture(t);await f.fonts.prepare({families:['Golos Text'],weights:[400,700],styles:['italic'],cyrillic:true});
  assert.deepEqual(f.calls.ensure[0].requirements[0].weights,[400,700]);assert.equal(f.calls.ensure[0].requirements[0].codepoints.length,66);
  assert.equal(f.calls.scans,0,'explicit family selection does not read or rewrite document content');assert.equal(f.calls.registrations,1);
  assert.equal((await f.fonts.status()).families[0].family,'Golos Text');
});
test('a new text font triggers acquisition while duplicate snapshots coalesce',async t=>{
  const f=await fixture(t);f.fonts.attach();await f.fonts.lastTask;
  const doc={children:[{id:'new',type:'text',fontFamily:'Onest',content:'Русский текст'}]};
  f.fonts.schedule(doc);f.fonts.schedule(doc);await f.fonts.lastTask;
  assert.equal(f.calls.ensure.length,2);assert.ok(f.calls.ensure[1].requirements.some(r=>r.family==='Onest'));
  assert.equal(f.calls.registrations,3,'already registered fallback is not resent');
});
test('agent font tools are discoverable and App access stays on exact local font routes',()=>{
  assert.deepEqual(fontTools.map(t=>t.name),['canvas_fonts_status','canvas_fonts_prepare','canvas_fonts_library']);
  for(const tool of fontTools)assert.notDeepEqual(tool._meta?.ui?.visibility,['app'],'font tools must be available to the model');
  assert.equal(validateCanvasSessionOperation('canvas_fonts_status').mutation,false);
  assert.equal(validateCanvasSessionOperation('canvas_fonts_prepare',{families:['Onest']}).mutation,true);
  for(const path of ['/api/mcp/fonts','/api/mcp/fonts/'+'a'.repeat(64)])assert.equal(nativeRoute(path),path);
  assert.equal(nativeRoute('/api/mcp/fonts/readiness','POST'),'/api/mcp/fonts/readiness');
  for(const path of ['/api/mcp/fonts/../../file','/api/mcp/fonts/any-font.ttf','/api/mcp/fonts?url=https://external.test'])assert.throws(()=>nativeRoute(path));
});
