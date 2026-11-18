import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=(await Promise.all(['native-library.js','native-community-catalog.js'].map(file =>
 readFile(new URL('../plugins/openpencil/ui/'+file,import.meta.url),'utf8')))).join('\n');
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

test('loading, empty, offline and superseded searches keep their own query and recovery actions', async () => {
 const requests = [], tree = [];
 const make = (tag,text,className) => {
  const n = {tag,text,className,children:[],append(...children){this.children.push(...children);},
   replaceChildren(...children){this.children=children;},setAttribute(){}};
  tree.push(n); return n;
 };
 const context = vm.createContext({nativeEditor:{call(name,args){
  return new Promise((resolve,reject) => requests.push({query:args.query,resolve,reject}));
 }}});
 vm.runInContext(source+';globalThis.catalog=nativeCommunityCatalog;',context);
 let focused=0, local=0;
 const view = await context.catalog.section({drawer:make('div'),make,button:(text,action)=>({text,action}),focusQuery:()=>focused++,onLocal:()=>local++});
 const results = tree.find(n=>n.className==='library-grid');
 const first = view.search('previous'), second = view.search('latest');
 assert.equal(results.children[0].className,'library-state library-state-search');
 assert.equal(results.children[0].children[1].children[0].text,'latest');
 requests[1].resolve({results:[]}); await second;
 requests[0].reject(Error('network unavailable')); await first;
 const empty=results.children[0]; assert.equal(empty.className,'library-state library-state-empty');
 empty.children[2].children[0].action(); assert.equal(focused,1);
 const offline = view.search('offline');
 requests[2].reject(Error('fetch failed')); await offline;
 const failed=results.children[0]; assert.equal(failed.className,'library-state library-state-offline');
 failed.children[2].children[0].action(); assert.equal(local,1);
 const retry = results.children[1].children[2].action(); assert.equal(requests.at(-1).query,'offline');
 view.invalidate(); requests.at(-1).resolve({results:[]}); await retry;
 assert.equal(results.children[0].className,'library-state library-state-search');
});
