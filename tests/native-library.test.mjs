import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../plugins/openpencil/ui/native-library.js',import.meta.url),'utf8');
test('global library opens the complete converted resource through the project workflow',async()=>{
 const controls=[],calls=[];let opened;
 const make=(tag,text)=>({tag,text,append(){},setAttribute(){},replaceChildren(){}});
 const context=vm.createContext({document:{createElement:make},
  nativeEditor:{async flush(){return {docJson:'latest-ui'};},async call(name,args){calls.push({name,args});
    if(name==='canvas_community_import')return {documentId:'previous-doc',imported:{id:'imported-doc'}};
    if(name==='canvas_community_settings')return {autonomous:true,verifyLicenses:true};
    return {assets:[{id:'fixture',name:'Kit',kind:'ui-kit',format:'fig',author:'Author',license:{spdx:'CC-BY-4.0'},available:true,sourceUrl:'https://example.com'}]};},status(){},async switchDocument(id){opened=id;}},nativeBridge:{}});
 vm.runInContext(source+'\nglobalThis.library=nativeLibrary;',context);
 await context.library.open({show(){},drawer:make('div'),make,button(text,action){const b={text,action,setAttribute(){}};controls.push(b);return b;}});
 assert.equal(calls.find(c=>c.name==='canvas_community_search').args.scope,'global');
 await controls.find(c=>c.text==='Открыть набор в проекте').action();
 assert.deepEqual(JSON.parse(JSON.stringify(calls.find(c=>c.name==='canvas_community_import').args)),{assetId:'fixture'});
 assert.equal(opened,'imported-doc');
 await controls.find(c=>c.text==='В этом проекте').action();
 assert.equal(calls.filter(c=>c.name==='canvas_community_search').at(-1).args.scope,'project');
});
test('library preserves original kit covers, uses source SVGs for compact icons and labels unknown licenses truthfully',async()=>{
 const nodes=[];const make=(tag,text,className)=>{const node={tag,text,className,children:[],append(...items){this.children.push(...items);},setAttribute(){},replaceChildren(){this.children=[];}};nodes.push(node);return node;};
 const assets=[{id:'covered',name:'Original kit',kind:'ui-kit',format:'fig',author:'Author',license:{status:'unknown'},available:false,sourceUrl:'https://example.com',coverDataUrl:'data:image/png;base64,T1JJR0lOQUw=',previewDataUrl:'data:image/svg+xml;base64,RkFLRQ=='},
  {id:'uncovered',name:'Icon',kind:'icon',format:'svg',author:'Author',license:{spdx:'MIT'},available:false,sourceUrl:'https://example.com',previewDataUrl:'data:image/svg+xml;base64,RkFLRQ=='},
  {id:'uncovered-kit',name:'Kit without original',kind:'ui-kit',format:'op',author:'Author',license:{spdx:'MIT'},available:false,sourceUrl:'https://example.com',previewDataUrl:'data:image/svg+xml;base64,RkFLRQ=='}];
 const context=vm.createContext({document:{createElement:make},nativeEditor:{async call(){return {assets};}},nativeBridge:{}});
 vm.runInContext(source+'\nglobalThis.library=nativeLibrary;',context);
 await context.library.open({show(){},drawer:make('div'),make,button:(text,action)=>({text,action,setAttribute(){}})});
 const images=nodes.filter(n=>n.tag==='img');assert.equal(images.length,2);
 assert.equal(images.find(n=>n.className==='library-cover-image').src,assets[0].coverDataUrl);
 assert.equal(images.find(n=>n.className==='asset-preview').src,assets[1].previewDataUrl);
 assert.ok(nodes.some(n=>n.text==='Оригинальная обложка недоступна'));
 assert.ok(nodes.some(n=>n.text==='Лицензия неизвестна · ответственность пользователя'));
});
