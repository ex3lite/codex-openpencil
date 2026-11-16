import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchPublicBytes,isPublicAddress} from '../plugins/openpencil/scripts/community-network.mjs';
const lookupImpl=async()=>[{address:'93.184.216.34',family:4}];
test('public HTTPS downloads allow ordinary origins and queries, recheck redirects, and omit credentials',async()=>{
 const calls=[];
 const fetchImpl=async(url,options)=>{calls.push({url,options});return calls.length===1?new Response(null,{status:302,headers:{location:'https://cdn.example.net/asset.png?v=2'}}):new Response('original');};
 const result=await fetchPublicBytes('https://designer.example/asset?version=1',{lookupImpl,fetchImpl});
 assert.equal(result.bytes.toString(),'original');assert.equal(result.url,'https://cdn.example.net/asset.png?v=2');
 assert.equal(calls[0].options.credentials,'omit');assert.equal(calls[0].options.redirect,'manual');
 await assert.rejects(fetchPublicBytes('https://designer.example/a',{lookupImpl,fetchImpl:async()=>new Response(null,{status:302,headers:{location:'https://127.0.0.1/private'}})}),/private/);
});
test('SSRF guard rejects private and reserved addresses including mixed DNS answers before requesting',async()=>{
 for(const address of ['0.0.0.0','10.2.3.4','100.64.0.1','127.0.0.1','169.254.169.254','172.16.0.1','192.168.0.1','198.18.0.1','192.0.2.1','224.0.0.1','::1','fc00::1','fe80::1','::ffff:127.0.0.1','2001:db8::1','2002:7f00:1::']) assert.equal(isPublicAddress(address),false,address);
 for(const address of ['1.1.1.1','93.184.216.34','2606:4700:4700::1111']) assert.equal(isPublicAddress(address),true,address);
 let calls=0;
 await assert.rejects(fetchPublicBytes('https://designer.example/a',{lookupImpl:async()=>[{address:'1.1.1.1',family:4},{address:'10.0.0.1',family:4}],fetchImpl:async()=>{calls++;}}),/private/);
 assert.equal(calls,0);
 for(const url of ['http://example.com/a','https://user:password@example.com/a','https://example.com:8443/a']) await assert.rejects(fetchPublicBytes(url,{lookupImpl}),/public HTTPS/);
});
test('downloads bound redirect chains and stream size',async()=>{
 await assert.rejects(fetchPublicBytes('https://example.com/a',{lookupImpl,fetchImpl:async()=>new Response(null,{status:302,headers:{location:'/a'}})}),/redirect limit/);
 await assert.rejects(fetchPublicBytes('https://example.com/a',{lookupImpl,limit:3,fetchImpl:async()=>new Response('oversize')}),/size limit/);
});
