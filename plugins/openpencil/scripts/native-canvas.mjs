import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { resolveRuntime, sha256 } from './editor-runtime.mjs';

export const NATIVE_URI='ui://openpencil/native/v0.5.0.html';
const READ=new Set(['/api/mcp/document','/api/mcp/version','/api/mcp/server','/api/mcp/selection','/api/mcp/indicators']);
const WRITE=new Set(['/api/mcp/document','/api/mcp/selection','/api/mcp/sync-reset']);
export function nativeRoute(path,method='GET') {
 if(typeof path!=='string'||!path.startsWith('/')||path.startsWith('//')||path.includes('\\')||path.includes('%')||path.split('/').includes('..'))throw Error('Invalid editor route');
 const u=new URL(path,'http://local');
 if(u.search)throw Error('Query parameters are not supported by the local bridge');
 const asset=/^\/(?:pkg|assets|canvaskit)\/[A-Za-z0-9_./-]+$/.test(path);
 if((method==='GET'&&(asset||READ.has(path)))||(method==='POST'&&WRITE.has(path)))return path;
 throw Error('This operation is not available in the embedded local editor: '+path);
}
export async function nativeRequest(controller,args) {
 const method=args.method||'GET',path=nativeRoute(args.path,method);
 if(method==='POST'&&controller.projectSwitchUncertain)throw Error('Переключение документа не подтверждено. Изменения остановлены; откройте проект заново.');
 if(!controller.session)await controller.open({});
 const session=controller.session;session.assertLive();
 if(typeof args.body==='string'&&Buffer.byteLength(args.body)>32*1024*1024)throw Error('Document request too large');
 const response=await fetch(`http://127.0.0.1:${session.port}${path}`,{method,redirect:'error',headers:{'X-OpenPencil-Token':session.token,'Content-Type':'application/json'},body:method==='POST'?(args.body||'{}'):undefined,signal:AbortSignal.timeout(15000)});
 const parts=[];let total=0;
 for await(const part of response.body){total+=part.length;if(total>32*1024*1024)throw Error('Editor response too large');parts.push(part);}
 if(method==='POST'&&path==='/api/mcp/document'&&response.ok)await session.checkpoint();
 let bytes=Buffer.concat(parts);const type=response.headers.get('content-type')||'application/octet-stream';
 if(method==='GET'&&path==='/api/mcp/indicators'&&response.ok&&controller.agents) bytes=Buffer.from(JSON.stringify(controller.agents.relay(JSON.parse(bytes.toString('utf8')))));
 return {content:[{type:'text',text:JSON.stringify({status:response.status,bytes:bytes.length})}],_meta:{nativeHttp:{status:response.status,type,body:bytes.toString('base64')}}};
}
export function embedNativeScript(template, script) {
 return template.replace('/* NATIVE_SCRIPT */', () => script.replace(/<\/script/gi, '<\\/script'));
}
let cached;
export async function nativeHtml(runtimeRoot) {
 const runtime=await resolveRuntime(runtimeRoot);
 const [template,transport,bootstrap,engine,info,ck,wasm,ckWasm,host,editor,codegen,workspace,context,workspaceCss]=await Promise.all([
  readFile(new URL('../ui/native.html',import.meta.url),'utf8'),readFile(new URL('../ui/native-transport.js',import.meta.url),'utf8'),
  readFile(new URL('../ui/native-bootstrap.js',import.meta.url),'utf8'),readFile(new URL('../ui/native-engine.js',import.meta.url),'utf8'),
  readFile(new URL('../ui/native-engine.js.json',import.meta.url),'utf8'),readFile(join(runtime.canvasKit,'canvaskit.js'),'utf8'),
  readFile(join(runtime.webBundle,'op_host_web_bg.wasm')),readFile(join(runtime.canvasKit,'canvaskit.wasm')),
  ...['native-host.js','native-editor.js','native-codegen.js','native-workspace.js','native-context.js','native-workspace.css'].map(name=>readFile(new URL('../ui/'+name,import.meta.url),'utf8'))]);
 if(JSON.parse(info).entrySha256!==sha256(await readFile(join(runtime.webBundle,'op_host_web.js')))||JSON.parse(info).engineSha256!==sha256(wasm))throw Error('Rebuild native editor glue for this runtime: node scripts/build-native-editor.mjs');
 const cacheKey=sha256(Buffer.from(template+transport+bootstrap+engine+host+editor+codegen+workspace+context+workspaceCss));
 if(cached?.root===runtime.root&&cached.key===cacheKey)return cached.html;
 const binaries={engine:gzipSync(wasm).toString('base64'),canvaskit:gzipSync(ckWasm).toString('base64')};
 const script=`const OP_BINARIES=${JSON.stringify(binaries)};\n${host}\n${transport}\n${ck}\n${engine}\n${editor}\n${codegen}\n${workspace}\n${context}\n${bootstrap}`;
 const html=embedNativeScript(template.replace('/* WORKSPACE_CSS */',workspaceCss),script);
 cached={root:runtime.root,key:cacheKey,html};return html;
}
export const nativeTools=[{name:'canvas_native_request',description:'App-only transport for the original local OpenPencil editor. Fixed local daemon and explicit document/static asset routes; no arbitrary network destinations.',inputSchema:{type:'object',properties:{path:{type:'string'},method:{type:'string',enum:['GET','POST']},body:{type:'string'}},required:['path'],additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false},_meta:{ui:{visibility:['app']}}}];
