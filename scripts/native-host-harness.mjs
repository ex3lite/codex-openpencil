import {dirname,resolve} from 'node:path';
// Local protocol acceptance harness, not the Codex desktop host.
import http from 'node:http';
import {randomBytes} from 'node:crypto';
import {CanvasController} from '../plugins/openpencil/scripts/canvas-controller.mjs';
import {nativeHtml} from '../plugins/openpencil/scripts/native-canvas.mjs';
const controller=new CanvasController(),appController=new CanvasController();
const opened=await controller.open({filePath:resolve(process.argv[2]),projectRoot:process.argv[3]||dirname(resolve(process.argv[2]))});
const toolResult=JSON.stringify({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:opened}).replace(/</g,'\\u003c');
const html=await nativeHtml(),key=randomBytes(24).toString('hex');
const report={initialized:0,methods:{},contexts:[],messages:[]};
const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
const child=http.createServer((req,res)=>{if(req.url!=='/'+key){res.writeHead(404);res.end();return;}res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});res.end(html);});
await new Promise(resolve=>child.listen(0,'127.0.0.1',resolve));
const childUrl=`http://127.0.0.1:${child.address().port}/${key}`;
let origin;
const host=http.createServer(async(req,res)=>{
 try {
  if(req.headers.host!==new URL(origin).host||(req.headers.origin&&req.headers.origin!==origin)){json(res,403,{});return;}
  if(req.method==='GET'&&req.url===`/${key}/report`){json(res,200,report);return;}
  if(req.method==='GET'&&req.url===`/${key}/direct`){
   const proxy=`<script>const harnessFetch=window.fetch.bind(window);window.addEventListener('message',async event=>{const m=event.data;if(event.source!==window||m?.jsonrpc!=='2.0'||!m.method)return;const response=await(await harnessFetch(${JSON.stringify('/'+key+'/rpc')},{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(m)})).json();if(m.id!==undefined)window.postMessage(response,location.origin);if(m.method==='ui/notifications/initialized')window.postMessage(${toolResult},location.origin);});</script>`;
   res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});res.end(html.replace('<head>','<head>'+proxy));return;
  }
  if(req.method==='GET'&&req.url===`/${key}`){
   res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
   res.end(`<!doctype html><html lang="ru"><meta charset="utf-8"><title>OpenPencil · Проверка MCP Apps</title><style>html,body{margin:0;height:100%;background:#18181b;color:#ccc;font:12px system-ui}header{height:34px;display:flex;align-items:center;gap:20px;padding:0 12px}iframe{display:block;width:100%;height:calc(100% - 34px);border:0}#result{color:#aaccaa}</style><header>Локальная проверка протокола MCP Apps <span id="result">Запуск…</span></header><iframe id="app" title="OpenPencil MCP App" sandbox="allow-scripts allow-same-origin allow-downloads allow-forms allow-modals" src="${childUrl}"></iframe><script>
   const frame=document.getElementById('app'),status=document.getElementById('result');
   window.addEventListener('message',async event=>{
    if(event.source!==frame.contentWindow||event.origin!==${JSON.stringify(new URL(childUrl).origin)}||event.data?.jsonrpc!=='2.0')return;
    const message=event.data;if(!message.method)return;
    let response;
    try {
     response=await (await fetch(${JSON.stringify('/'+key+'/rpc')},{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(message)})).json();
     if(message.method==='ui/notifications/initialized'){status.textContent='MCP UI инициализирован';frame.contentWindow.postMessage(${toolResult},${JSON.stringify(new URL(childUrl).origin)});}
     if(message.method==='ui/message')status.textContent='Запрос из панели «Код» получен';
     if(message.id!==undefined)frame.contentWindow.postMessage(response,${JSON.stringify(new URL(childUrl).origin)});
    } catch(error){status.textContent=error.message;}
   });</script></html>`);return;
  }
  if(req.method==='POST'&&req.url===`/${key}/rpc`){
   const parts=[];let total=0;for await(const part of req){total+=part.length;if(total>32*1024*1024)throw Error('Request too large');parts.push(part);}
   const message=JSON.parse(Buffer.concat(parts));
   report.methods[message.method]=(report.methods[message.method]||0)+1;
   const reply=result=>json(res,200,{jsonrpc:'2.0',id:message.id,result});
   if(message.method==='ui/initialize'){report.initialized++;reply({protocolVersion:'2026-01-26',hostInfo:{name:'local-test-harness',version:'1'},hostCapabilities:{serverTools:{},message:{text:{}},updateModelContext:{}},hostContext:{theme:'dark',displayMode:'inline',availableDisplayModes:['inline','fullscreen']}});return;}
   if(message.method==='ui/notifications/initialized'){reply({});return;}
   if(message.method==='ui/update-model-context'){report.contexts.push(message.params);report.contexts=report.contexts.slice(-5);reply({});return;}
   if(message.method==='ui/message'){report.messages.push(message.params);reply({});return;}
   if(message.method==='ui/request-display-mode'){report.displayMode=message.params.mode;reply({mode:message.params.mode});return;}
   if(message.method==='tools/call'){json(res,200,await appController.enqueue(()=>appController.dispatch(message)));return;}
   throw Error('Unsupported host method');
  }
  json(res,404,{});
 }catch(error){json(res,400,{jsonrpc:'2.0',error:{code:-32000,message:error.message}});}
});
await new Promise(resolve=>host.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${host.address().port}`;
console.log(`${origin}/${key}`);
process.on('SIGTERM',async()=>{await appController.close();await controller.close();host.close();child.close();process.exit(0);});
