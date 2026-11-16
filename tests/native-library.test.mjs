import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../plugins/openpencil/ui/native-library.js',import.meta.url),'utf8');
test('library hands verified fig bytes to the original canvas file importer',async()=>{
 const controls=[],events=[];
 const make=(tag,text)=>({tag,text,append(){},setAttribute(){},replaceChildren(){}});
 const context=vm.createContext({document:{createElement:make,getElementById:()=>({dispatchEvent:e=>events.push(e)})},
  nativeEditor:{async flush(){},async call(){return {assets:[{id:'fixture',name:'Kit',format:'fig',importMode:'figma',author:'Author',license:{spdx:'CC-BY-4.0'},available:true,sourceUrl:'https://example.com'}]};},status(){}},
  nativeBridge:{async call(name,args){assert.equal(name,'canvas_community_file');assert.equal(args.assetId,'fixture');return {_meta:{communityFile:{name:'Kit.fig',body:'RklH'}}};}},
  atob:s=>Buffer.from(s,'base64').toString('binary'),Uint8Array,
  File:class {constructor(parts,name){this.parts=parts;this.name=name;}},
  DataTransfer:class{constructor(){this.files=[];this.items={add:f=>this.files.push(f)};}},
  DragEvent:class{constructor(type,options){this.type=type;Object.assign(this,options);}}});
 vm.runInContext(source+'\nglobalThis.library=nativeLibrary;',context);
 await context.library.open({show(){},drawer:make('div'),make,button(text,action){const b={text,action};controls.push(b);return b;}});
 await controls.find(c=>c.text==='Импортировать Figma').action();
 assert.equal(events.length,1);assert.equal(events[0].type,'drop');
 assert.equal(events[0].dataTransfer.files[0].name,'Kit.fig');
 assert.deepEqual([...events[0].dataTransfer.files[0].parts[0]],[70,73,71]);
});
