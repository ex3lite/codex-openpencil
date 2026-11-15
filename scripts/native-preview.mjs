import http from 'node:http';
import {randomBytes} from 'node:crypto';
import {CanvasController} from '../plugins/openpencil/scripts/canvas-controller.mjs';
import {nativeHtml} from '../plugins/openpencil/scripts/native-canvas.mjs';
const controller=new CanvasController();
await controller.open({filePath:process.argv[2]});
const html=await nativeHtml(),route='/'+randomBytes(24).toString('hex');let origin;
const server=http.createServer(async(req,res)=>{
 const reply=(code,body,type='application/json')=>{res.writeHead(code,{'Content-Type':type,'Cache-Control':'no-store'});res.end(typeof body==='string'?body:JSON.stringify(body));};
 try{
  if(req.headers.host!==new URL(origin).host||(req.headers.origin&&req.headers.origin!==origin)){reply(403,{});return;}
  if(req.method==='GET'&&req.url===route){reply(200,(await nativeHtml()).replace('const OP_BINARIES=',`const OP_PREVIEW=${JSON.stringify(route+'/rpc')};const OP_BINARIES=`),'text/html; charset=utf-8');return;}
  if(req.method==='POST'&&req.url===route+'/rpc'){const parts=[];let size=0;for await(const part of req){size+=part.length;if(size>32*1024*1024)throw Error('Too large');parts.push(part);}const m=JSON.parse(Buffer.concat(parts));reply(200,await controller.call(m.name,m.arguments||{}));return;}
  reply(404,{});
 }catch(e){reply(400,{isError:true,content:[{type:'text',text:e.message}]});}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+server.address().port;console.log(origin+route);
process.on('SIGTERM',async()=>{await controller.close();server.close();process.exit(0);});
