import {createConnection} from 'node:net';
import {readFile,readdir,lstat} from 'node:fs/promises';
import {join,isAbsolute} from 'node:path';
import {randomUUID} from 'node:crypto';
import {stateRoot} from './editor-runtime.mjs';

const fail=(code,message)=>Object.assign(new Error(message),{code});
const secure=info=>process.platform==='win32'||info.uid===process.getuid()&&(info.mode&0o077)===0;
export class CommunityBrowser {
  constructor({configPath=join(stateRoot(),'community-browser.json'),timeoutMs=38000}={}){this.configPath=configPath;this.timeoutMs=timeoutMs;}
  async config(){
    let info;try{info=await lstat(this.configPath);}catch(error){if(error.code==='ENOENT')throw fail('COMMUNITY_BROWSER_NOT_CONFIGURED','Configure the connected Community browser with configure-community-browser.mjs.');throw error;}
    if(!info.isFile()||info.isSymbolicLink()||!secure(info)||info.size>4096)throw fail('UNSAFE_COMMUNITY_BROWSER_CONFIG','Community browser configuration must be a private regular file.');
    const config=JSON.parse(await readFile(this.configPath,'utf8'));
    if(config.schemaVersion!==1||!isAbsolute(config.bridgeRoot||'')||!/^[a-p]{32}$/.test(config.extensionId||''))throw fail('INVALID_COMMUNITY_BROWSER_CONFIG','Invalid Community browser configuration.');
    return config;
  }
  async request(action){return this.call('figma.community',action);}
  async status(){
    try{const status=await this.call('status',{});return {connected:true,ready:status.figmaCommunity?.version===1,capabilities:status.figmaCommunity||null,...(!status.figmaCommunity&&{code:'COMMUNITY_BROWSER_UPDATE_REQUIRED',message:'Reload the updated browser extension to enable Community catalog tools.'})};}
    catch(error){return {connected:false,ready:false,code:error.code||'COMMUNITY_BROWSER_OFFLINE',message:error.message};}
  }
  async call(method,params){
    if(!['status','figma.community'].includes(method))throw fail('COMMUNITY_OPERATION_DENIED','Only Community catalog operations are supported.');
    const config=await this.config(),directory=join(config.bridgeRoot,config.extensionId);
    let info;try{info=await lstat(directory);}catch{throw fail('COMMUNITY_BROWSER_OFFLINE','The connected Community browser is offline.');}
    if(!info.isDirectory()||info.isSymbolicLink()||!secure(info))throw fail('UNSAFE_COMMUNITY_BROWSER_BRIDGE','Community browser bridge must be private.');
    const sockets=[];
    for(const name of (await readdir(directory)).filter(n=>/^\d+-[a-f0-9]{8}\.sock$/.test(n))){
      const path=join(directory,name),stat=await lstat(path).catch(()=>null);if(!stat?.isSocket()||!secure(stat))continue;
      const socket=await new Promise(resolve=>{const s=createConnection(path),timer=setTimeout(()=>{s.destroy();resolve(null);},500);s.once('connect',()=>{clearTimeout(timer);resolve(s);});s.once('error',()=>{clearTimeout(timer);s.destroy();resolve(null);});});
      if(socket)sockets.push(socket);
    }
    if(sockets.length!==1){sockets.forEach(s=>s.destroy());throw fail(sockets.length?'COMMUNITY_BROWSER_AMBIGUOUS':'COMMUNITY_BROWSER_OFFLINE',sockets.length?'Multiple browser profiles are connected; choose one Community browser.':'The Community browser is offline.');}
    const socket=sockets[0],id=randomUUID(),payload=Buffer.from(JSON.stringify({id,method,params})+'\n');
    if(payload.length>128000){socket.destroy();throw fail('COMMUNITY_REQUEST_TOO_LARGE','Community request is too large.');}
    return new Promise((resolve,reject)=>{
      let buffer=Buffer.alloc(0),done=false;
      const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);socket.destroy();error?reject(error):resolve(value);};
      const timer=setTimeout(()=>finish(fail('COMMUNITY_BROWSER_TIMEOUT','Community browser did not finish; no search-engine fallback was used.')),this.timeoutMs);
      socket.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);if(buffer.length>900000)return finish(fail('COMMUNITY_RESPONSE_TOO_LARGE','Community response exceeded its budget.'));const end=buffer.indexOf(10);if(end<0)return;
        try{const result=JSON.parse(buffer.subarray(0,end));if(result.id!==id)throw Error('Mismatched Community response.');if(result.error)return finish(fail('COMMUNITY_BROWSER_REJECTED',String(result.error).slice(0,1000)));finish(null,result.result);}catch(error){finish(error);}});
      socket.once('error',error=>finish(error));socket.once('close',()=>finish(fail('COMMUNITY_BROWSER_DISCONNECTED','Community browser disconnected.')));socket.write(payload);
    });
  }
}
