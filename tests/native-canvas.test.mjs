import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeRoute,embedNativeScript} from '../plugins/openpencil/scripts/native-canvas.mjs';
test('native bridge only accepts its editor document and static resource routes',()=>{
 for(const path of ['/api/mcp/version','/api/mcp/document','/assets/i18n/ru.json','/pkg/op_host_web_bg.wasm'])assert.equal(nativeRoute(path),path);
 assert.equal(nativeRoute('/api/mcp/document','POST'),'/api/mcp/document');
 for(const path of ['https://example.com/','//example.com/file','/assets/../secret','/assets/%2e%2e/secret','/api/settings/credentials','/api/file/save'])assert.throws(()=>nativeRoute(path));
 assert.throws(()=>nativeRoute('/assets/icon.json','POST'));
 assert.throws(()=>nativeRoute('/api/mcp/document?tenant=someone-else'));
});

test('bundled script preserves replacement tokens and cannot terminate the HTML script',()=>{
 const source = `globalThis.fixture = ["$&", "$'", "$\`", "</script>"];`;
 const html=embedNativeScript('<script>/* NATIVE_SCRIPT */</script>',source);
 assert.equal((html.match(/<\/script>/g)||[]).length,1);
 const script=html.slice(8,-9);
 const context={};
 new Function('globalThis',script)(context);
 assert.deepEqual(context.fixture,["$&", "$'", "$`", "</script>"]);
});

test('bundled original editor exposes every required host adapter function',async()=>{
 const {readFile}=await import('node:fs/promises');const vm=await import('node:vm');
 const context=vm.createContext({TextDecoder,TextEncoder});
 vm.runInContext(await readFile(new URL('../plugins/openpencil/ui/native-engine.js',import.meta.url),'utf8'),context);
 for(const name of ['init','mount','onEvent','receive','documentName','selection'])assert.equal(typeof context.OpenPencilEngine[name],'function',name);
});

test('native resource permits embedded SVG decoding without external resource origins',async()=>{
 const {CanvasController}=await import('../plugins/openpencil/scripts/canvas-controller.mjs');
 const resource=await new CanvasController({nativeHtmlLoader:async()=>'<canvas></canvas>'}).resource();
 const csp=resource.contents[0]._meta.ui.csp;
 assert.deepEqual(csp.resourceDomains,['blob:','data:']);
 assert.deepEqual(csp.connectDomains,[]);
 assert.deepEqual(csp.frameDomains,[]);
});
