import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../plugins/openpencil/ui/native-community-catalog.js',import.meta.url),'utf8');
test('catalog drawer searches through MCP, displays the original card cover and acquires without sending a chat/context message',async()=>{
 const controls=[],nodes=[],calls=[];let refreshed=0;
 const make=(tag,text,className)=>{const n={tag,text,className,children:[],append(...items){this.children.push(...items);},setAttribute(){},replaceChildren(...items){this.children=items;}};nodes.push(n);return n;};
 const card={resourceId:'1382343443870598429',title:'Apple landing page',author:'Pierrick',url:'https://www.figma.com/community/file/1382343443870598429'};
 const context=vm.createContext({document:{createElement:make},nativeEditor:{status(){},async call(name,args){calls.push({name,args});if(name.endsWith('_search'))return {results:[card]};if(name.endsWith('_cover'))return {coverDataUrl:'data:image/png;base64,T1JJR0lOQUw='};if(name.endsWith('_acquire'))return {card};throw Error('Unexpected MCP call');}},nativeBridge:{request(){throw Error('Catalog browsing must not inject a chat message');}}});
 vm.runInContext(source+';globalThis.catalog=nativeCommunityCatalog;',context);
 const section=await context.catalog.section({drawer:make('div'),make,button(text,action){const control={text,action};controls.push(control);return control;},onAcquire:async()=>{refreshed++;}});
 await section.search('Apple UI Kit');
 assert.equal(calls[0].name,'canvas_community_catalog_search');assert.equal(calls[0].args.query,'Apple UI Kit');assert.equal(nodes.find(n=>n.tag==='img').src,'data:image/png;base64,T1JJR0lOQUw=');
 await controls.find(b=>b.text==='Сохранить референс').action();assert.equal(calls.at(-1).name,'canvas_community_catalog_acquire');assert.equal(calls.at(-1).args.mode,'reference');assert.equal(refreshed,1);
});
