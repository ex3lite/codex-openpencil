// Transport adapter only. The original Rust editor owns geometry, rendering,
// interaction, layout, document history and synchronization rules.
const previewFetch=window.fetch.bind(window);
const bytesFromBase64=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
async function unpack(s){return new Response(new Blob([bytesFromBase64(s)]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();}
const originalFetch=window.fetch.bind(window);
const assetCache=new Map();
async function localFetch(input,options={}){
 const request=input instanceof Request?input:null,url=new URL(request?request.url:String(input),location.href);
 if(['blob:','data:'].includes(url.protocol))return originalFetch(input,options);
 if(url.origin!==location.origin)throw Error('Внешние подключения отключены: '+url.hostname);
 const method=options.method||request?.method||'GET';
 const body=options.body??(request&&method!=='GET'?await request.text():undefined);
 const path=url.pathname+url.search,key=method+' '+path;
 if(method==='POST'&&path==='/api/mcp/document')await nativeEditor.syncBarrier();
 const isAsset=method==='GET'&&/^\/(pkg|assets|canvaskit)\//.test(path);
 let promise=isAsset&&assetCache.get(key);
 if(!promise){promise=nativeBridge.call('canvas_native_request',{path,method,...(body!==undefined?{body:String(body)}:{})}).then(r=>{if(!r._meta?.nativeHttp)throw Error('Нет ответа транспорта редактора');return r._meta.nativeHttp;});if(isAsset)assetCache.set(key,promise);}
 const data=await promise;return new Response(data.transfer?await nativeTransfer.download(nativeBridge.call,data.transfer):bytesFromBase64(data.body),{status:data.status,headers:{'content-type':data.type}});
}
window.fetch=localFetch;
class McpXMLHttpRequest extends EventTarget {
 constructor(){super();this.readyState=0;this.status=0;this.statusText='';this.responseType='';this.responseText='';this.response=null;this.timeout=0;this.upload=new EventTarget();this.headers={};this.responseHeaders=new Headers();}
 fire(name){const e=new Event(name);this.dispatchEvent(e);this['on'+name]?.call(this,e);}
 open(method,url,async=true){if(!async)throw Error('Synchronous HTTP is unavailable');this.method=method;this.url=url;this.readyState=1;this.fire('readystatechange');}
 setRequestHeader(k,v){this.headers[k]=v;}
 getResponseHeader(k){return this.responseHeaders.get(k);}
 getAllResponseHeaders(){return [...this.responseHeaders].map(([k,v])=>k+': '+v).join('\r\n');}
 overrideMimeType(){}
 abort(){this.aborted=true;this.fire('abort');this.fire('loadend');}
 async send(body){try{const r=await localFetch(this.url,{method:this.method,body,headers:this.headers});if(this.aborted)return;this.status=r.status;this.responseHeaders=r.headers;this.readyState=2;this.fire('readystatechange');const buffer=await r.arrayBuffer();this.responseText=['','text','json'].includes(this.responseType)?new TextDecoder().decode(buffer):'';this.response=this.responseType==='arraybuffer'?buffer:this.responseType==='blob'?new Blob([buffer],{type:r.headers.get('content-type')}):this.responseType==='json'?JSON.parse(this.responseText):this.responseText;this.readyState=4;this.fire('readystatechange');this.fire('load');}catch(e){this.status=0;this.readyState=4;this.fire('error');}finally{if(!this.aborted)this.fire('loadend');}}
}
window.XMLHttpRequest=McpXMLHttpRequest;
// CanvasKit's image loader uses Image.src for local library previews. Resolve
// those through the same asset channel, preserving data/blob image behavior.
const imageSrc=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,'src');
Object.defineProperty(HTMLImageElement.prototype,'src',{...imageSrc,set(value){const u=new URL(value,location.href);if(u.origin===location.origin&&/^\/(assets|pkg)\//.test(u.pathname)){const generation=(this.__opLoadGeneration||0)+1;this.__opLoadGeneration=generation;localFetch(value).then(r=>r.blob()).then(b=>{if(this.__opLoadGeneration!==generation)return;const url=URL.createObjectURL(b);this.addEventListener('load',()=>URL.revokeObjectURL(url),{once:true});imageSrc.set.call(this,url);}).catch(()=>this.dispatchEvent(new Event('error')));}else imageSrc.set.call(this,value);}});
