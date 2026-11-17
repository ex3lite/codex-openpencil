import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../plugins/openpencil/ui/native-documents.js',import.meta.url),'utf8');
function fixture(fail=false){
 const elements=[],calls=[];let closed=0;
 const make=(tag,text='',className='')=>{const n={tag,textContent:text,className,children:[],dataset:{},value:'',append(...ns){this.children.push(...ns);},replaceChildren(...ns){this.children=ns;},contains(n){return this.children.includes(n);},setAttribute(){}};elements.push(n);return n;};
 const drawer=make('div'),ui={make,drawer,show(){drawer.replaceChildren();},close(){closed++;},button(text,action){const n=make('button',text);n.onclick=action;return n;}};
 const sandbox=vm.createContext({nativeEditor:{async call(name){calls.push(name);return {project:{name:'This project'},documentId:'a',documents:[{id:'a',name:'Current',status:'available'},{id:'b',name:'UI Kit',status:'available'},{id:'c',name:'Missing',status:'missing'}]};},async switchDocument(id){calls.push(id);if(fail)throw Error('Snapshot stale');}}});
 vm.runInContext(source+';globalThis.docs=nativeDocuments;',sandbox);
 return {calls,elements,drawer,closed:()=>closed,open:()=>sandbox.docs.open(ui)};
}
test('project picker opens without a chat message, disables current/missing, and filters locally',async()=>{
 const f=fixture();await f.open();
 const buttons=f.elements.filter(n=>n.tag==='button');assert.equal(buttons[0].disabled,true);assert.equal(buttons[2].disabled,true);
 const input=f.elements.find(n=>n.tag==='input');input.value='UI';input.oninput();
 assert.equal(f.elements.find(n=>n.className==='documents-grid').children.length,1);
 await buttons[1].onclick();assert.deepEqual(f.calls,['canvas_documents','b']);assert.equal(f.closed(),1);
});
test('failed switching keeps the picker open and shows the actual error',async()=>{
 const f=fixture(true);await f.open();await f.elements.filter(n=>n.tag==='button')[1].onclick();
 assert.equal(f.closed(),0);assert.ok(f.elements.some(n=>n.textContent==='Snapshot stale'));
});
