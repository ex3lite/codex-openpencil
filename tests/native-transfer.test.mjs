import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {webcrypto,randomBytes} from 'node:crypto';
import {dispatchTransfer,consumeTransfer,downloadTransfer,closeTransfers} from '../plugins/openpencil/scripts/canvas-transfer.mjs';
const source=await readFile(new URL('../plugins/openpencil/ui/native-transfer.js',import.meta.url),'utf8');
function client(call){const context=vm.createContext({crypto:webcrypto,TextEncoder,Uint8Array,Response,Blob,CompressionStream,DecompressionStream,
 btoa:s=>Buffer.from(s,'binary').toString('base64'),atob:s=>Buffer.from(s,'base64').toString('binary')});
 vm.runInContext(source+'\nglobalThis.transfer=nativeTransfer;',context);return context.transfer;}
test('browser compression and server chunks preserve the entire document in both directions',async()=>{
 const controller={session:{assertLive(){}},documentId:'test-document'};
 try{
  const raw=JSON.stringify({content:randomBytes(800000).toString('base64')});let appends=0;
  const call=async(name,args)=>{assert.equal(name,'canvas_transfer');if(args.action==='append')appends++;return {_meta:{transfer:await dispatchTransfer(controller,args)}};};
  const browser=client();const args=await browser.prepare(call,'canvas_autosave',{docJson:raw});
  assert.equal(args.docJson,'');assert.ok(appends>1);assert.equal(await consumeTransfer(controller,args.snapshotToken,'snapshot'),raw);
  const descriptor=await downloadTransfer(controller,Buffer.from(raw));const blob=await browser.download(call,descriptor);
  assert.equal(await blob.text(),raw);
 }finally{await closeTransfers(controller);}
});
test('browser never retries a chunk whose acknowledgement was lost',async()=>{
 const controller={session:{assertLive(){}},documentId:'test-document'};let writes=0,disposed=0;
 try{
  const call=async(_name,args)=>{
   if(args.action==='dispose')disposed++;
   const reply=await dispatchTransfer(controller,args);
   if(args.action==='append'){writes++;throw Error('acknowledgement lost');}
   return {_meta:{transfer:reply}};
  };
  await assert.rejects(client().prepare(call,'canvas_autosave',{docJson:randomBytes(250000).toString('base64')}),/acknowledgement lost/);
  assert.equal(writes,1);assert.equal(disposed,1);
 }finally{await closeTransfers(controller);}
});
