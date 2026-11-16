import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
test('an active panel survives removal of its installed UI files during a plugin update',async t=>{
 const root=await mkdtemp('/private/tmp/openbrush-panel-assets-');t.after(()=>rm(root,{recursive:true,force:true}));
 await mkdir(join(root,'scripts'));await mkdir(join(root,'ui'));
 await writeFile(join(root,'scripts/canvas-panel.mjs'),await readFile(new URL('../plugins/openpencil/scripts/canvas-panel.mjs',import.meta.url)));
 await writeFile(join(root,'scripts/transport.mjs'),'export const MAX_BYTES=1024;');
 for(const name of ['panel.html','panel.css','panel.js','selection.js','codegen.js'])await writeFile(join(root,'ui',name),name==='panel.html'?'<html>/* PANEL_CSS *//* PANEL_GRANT *//* PANEL_JS */</html>':'retained-'+name);
 const {startPanel}=await import(pathToFileURL(join(root,'scripts/canvas-panel.mjs')));
 const controller={enqueue:fn=>fn(),open:async()=>({_meta:{canvas:{editorOrigin:'http://127.0.0.1:1'}},structuredContent:{filePath:'/fixture.op'}})};
 const panel=await startPanel(controller);t.after(()=>panel.close());
 // Updating the plugin may remove this old cache before the first browser GET.
 await rm(join(root,'ui'),{recursive:true});
 const response=await fetch(panel.url);assert.equal(response.status,200);const html=await response.text();assert.match(html,/retained-panel.css/);assert.match(html,/fixture.op/);
});
