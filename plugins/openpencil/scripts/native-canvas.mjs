import { nativeDocumentHttp, nativeFontHttp } from './native-document-http.mjs';
import { downloadTransfer, consumeTransfer } from './canvas-transfer.mjs';
import { DOCUMENT_ENVELOPE_BYTES } from './document-limits.mjs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { resolveRuntime, sha256 } from './editor-runtime.mjs';

export const NATIVE_URI='ui://openbrush/native/v0.14.4.html';
const READ=new Set(['/api/mcp/document','/api/mcp/version','/api/mcp/server','/api/mcp/selection','/api/mcp/indicators']);
const WRITE=new Set(['/api/mcp/document','/api/mcp/selection','/api/mcp/sync-reset']);
export function nativeRoute(path,method='GET') {
 if(typeof path!=='string'||!path.startsWith('/')||path.startsWith('//')||path.includes('\\')||path.includes('%')||path.split('/').includes('..'))throw Error('Invalid editor route');
 const u=new URL(path,'http://local');
 if(u.search)throw Error('Query parameters are not supported by the local bridge');
 const asset=/^\/(?:pkg|assets|canvaskit)\/[A-Za-z0-9_./-]+$/.test(path);
 const fontRead=/^\/api\/mcp\/fonts(?:\/[a-f0-9]{64})?$/.test(path);
 const fontWrite=['/api/mcp/fonts','/api/mcp/fonts/readiness'].includes(path);
 if((method==='GET'&&(asset||READ.has(path)||fontRead))||(method==='POST'&&(WRITE.has(path)||fontWrite)))return path;
 throw Error('This operation is not available in the embedded local editor: '+path);
}
export async function nativeRequest(controller,args) {
 const method=args.method||'GET',path=nativeRoute(args.path,method);
 if(method==='POST'&&controller.projectSwitchUncertain)throw Error('Переключение документа не подтверждено. Изменения остановлены; откройте проект заново.');
 if(!controller.session)await controller.open({});
 const session=controller.session;session.assertLive();
 if(args.bodyToken)args={...args,body:await consumeTransfer(controller,args.bodyToken,'body')};
 if(typeof args.body==='string'&&Buffer.byteLength(args.body)>DOCUMENT_ENVELOPE_BYTES)throw Error('Document request too large');
 let response;
 const uncertain=error=>{if(method==='POST'&&path==='/api/mcp/document'){controller.projectSwitchUncertain=true;controller.persistence?.fail(error);}return error;};
 try {response=path==='/api/mcp/document'?await nativeDocumentHttp(session.port,{method,token:session.token,body:method==='POST'?(args.body||'{}'):undefined}):path.startsWith('/api/mcp/fonts')?await nativeFontHttp(session.port,{path,method,token:session.token,body:method==='POST'?(args.body||'{}'):undefined}):await fetch(`http://127.0.0.1:${session.port}${path}`,{method,redirect:'error',headers:{'X-OpenPencil-Token':session.token,'Content-Type':'application/json'},body:method==='POST'?(args.body||'{}'):undefined,signal:AbortSignal.timeout(15000)});}
 catch(error){throw uncertain(Object.assign(new Error('Canvas write outcome is unknown. Reopen the saved project before continuing.'),{code:'UNCERTAIN_WRITE',cause:error}));}
 if(response.status>=500&&method==='POST'&&path==='/api/mcp/document') uncertain(Object.assign(new Error('Canvas write outcome is unknown.'),{code:'UNCERTAIN_WRITE'}));
 if(method==='GET'&&path==='/api/mcp/document'&&response.ok){
  const transfer=await downloadTransfer(controller,response.body);
  return {content:[{type:'text',text:JSON.stringify({status:response.status,bytes:transfer.rawBytes})}],_meta:{nativeHttp:{status:response.status,type:response.headers.get('content-type')||'application/json',transfer}}};
 }
 const parts=[];let total=0;
 try {for await(const part of response.body){total+=part.length;if(total>DOCUMENT_ENVELOPE_BYTES)throw Error('Editor response too large');parts.push(part);}}
 catch(error){throw uncertain(error);}
 if(method==='POST'&&path==='/api/mcp/document'&&response.ok){
  let acknowledgement;try{acknowledgement=JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{}
  if(acknowledgement?.ok!==true||!Number.isSafeInteger(acknowledgement.version))throw uncertain(Object.assign(new Error('Canvas write acknowledgement is invalid.'),{code:'UNCERTAIN_WRITE'}));
  await session.checkpoint();
  if(controller.fonts) {
   let payload;try{payload=JSON.parse(args.body||'{}');}catch{}
   if(payload?.document&&!payload.metadataOnly)controller.fonts.schedule(payload.document);
  }
 }
 let bytes=Buffer.concat(parts);const type=response.headers.get('content-type')||'application/octet-stream';
 if(method==='GET'&&path==='/api/mcp/indicators'&&response.ok&&controller.agents) {
  const relay=controller.agents.relay(JSON.parse(bytes.toString('utf8')));
  bytes=Buffer.from(JSON.stringify(controller.presence?controller.presence.relay(relay):relay));
 }
 return {content:[{type:'text',text:JSON.stringify({status:response.status,bytes:bytes.length})}],_meta:{nativeHttp:{status:response.status,type,body:bytes.toString('base64')}}};
}
export function embedNativeScript(template, script) {
 return template.replace('/* NATIVE_SCRIPT */', () => script.replace(/<\/script/gi, '<\\/script'));
}
let cached;
export async function nativeHtml(runtimeRoot) {
 const runtime=await resolveRuntime(runtimeRoot);
 const surfaceStyles = await Promise.all(['native-feedback.css', 'native-library-surfaces.css', 'native-inspector-surfaces.css'].map(name => readFile(new URL('../ui/' + name, import.meta.url), 'utf8')));
 const [template,transport,bootstrap,engine,info,ck,wasm,ckWasm,host,editor,codegen,contextState,workspace,context,workspaceCss,launch,library,transfer,fonts,packs,catalog,sdk,documents,designCss,inspector]=await Promise.all([
  readFile(new URL('../ui/native.html',import.meta.url),'utf8'),readFile(new URL('../ui/native-transport.js',import.meta.url),'utf8'),
  readFile(new URL('../ui/native-bootstrap.js',import.meta.url),'utf8'),readFile(new URL('../ui/native-engine.js',import.meta.url),'utf8'),
  readFile(new URL('../ui/native-engine.js.json',import.meta.url),'utf8'),readFile(join(runtime.canvasKit,'canvaskit.js'),'utf8'),
  readFile(join(runtime.webBundle,'op_host_web_bg.wasm')),readFile(join(runtime.canvasKit,'canvaskit.wasm')),
  ...['native-host.js','native-editor.js','native-codegen.js','native-context-state.js','native-workspace.js','native-context.js','native-workspace.css','native-launch.js','native-library.js','native-transfer.js','native-fonts.js','native-icon-packs.js','native-community-catalog.js','native-ui-sdk.js','native-documents.js','native-design.css','native-inspector.js'].map(name=>readFile(new URL('../ui/'+name,import.meta.url),'utf8'))]);
 if(JSON.parse(info).entrySha256!==sha256(await readFile(join(runtime.webBundle,'op_host_web.js')))||JSON.parse(info).engineSha256!==sha256(wasm))throw Error('Rebuild native editor glue for this runtime: node scripts/build-native-editor.mjs');
 const styles = [designCss, workspaceCss, ...surfaceStyles].join('\n');
 const cacheKey=sha256(Buffer.from(template+transport+bootstrap+engine+host+editor+codegen+contextState+workspace+context+styles+launch+library+transfer+fonts+packs+catalog+sdk+documents+designCss+inspector));
 if(cached?.root===runtime.root&&cached.key===cacheKey)return cached.html;
 const binaries={engine:gzipSync(wasm).toString('base64'),canvaskit:gzipSync(ckWasm).toString('base64')};
 const script=`const OP_BINARIES=${JSON.stringify(binaries)};\n${transfer}\n${host}\n${transport}\n${ck}\n${engine}\n${editor}\n${codegen}\n${contextState}\n${sdk}\n${documents}\n${workspace}\n${inspector}\n${context}\n${launch}\n${fonts}\n${packs}\n${catalog}\n${library}\n${bootstrap}`;
 const html=embedNativeScript(template.replace('/* WORKSPACE_CSS */',()=>styles),script);
 cached={root:runtime.root,key:cacheKey,html};return html;
}
export const nativeTools=[{name:'canvas_native_request',description:'App-only transport for the original local OpenPencil editor. Fixed local daemon and explicit document/static asset routes; no arbitrary network destinations.',inputSchema:{type:'object',properties:{path:{type:'string'},method:{type:'string',enum:['GET','POST']},body:{type:'string'},bodyToken:{type:'string'}},required:['path'],additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false},_meta:{ui:{visibility:['app']}}}];
