import {auditDesignSystem} from './design-system-audit.mjs';
import {designSystemPreset} from './design-system-preset.mjs';
import {writeReplacement,assertCurrentWriter} from './canvas-projects.mjs';
export {auditDesignSystem};
export {newDesignDocument} from './design-system-preset.mjs';
export function addDesignSystem(document,options={}) {
 const next=structuredClone(document),preset=designSystemPreset(options);
 if(next.pages?.some(p=>preset.pages.some(q=>q.id===p.id)))throw Object.assign(Error('Дизайн-система уже существует. Изменяйте её мастера и переменные.'),{code:'DESIGN_SYSTEM_EXISTS'});
 const collisions=Object.keys(preset.tokens).filter(k=>Object.hasOwn(next.variables||{},k));
 if(collisions.length)throw Object.assign(Error('Переменные уже существуют: '+collisions.join(', ')),{code:'TOKEN_CONFLICT'});
 if(!next.pages?.length){next.pages=[{id:'0',name:'Макеты',children:next.children||[]}];next.children=[];}
 const allIds=new Set();const stack=[...next.pages];while(stack.length){const n=stack.pop();if(n.id)allIds.add(n.id);stack.push(...(n.children||[]));}
 const proposed=[...preset.pages];while(proposed.length){const n=proposed.pop();if(allIds.has(n.id))throw Object.assign(Error('Идентификатор компонента уже существует: '+n.id),{code:'COMPONENT_CONFLICT'});proposed.push(...(n.children||[]));}
 next.variables={...next.variables,...preset.tokens};next.pages.push(...preset.pages);return next;
}
export const designSystemTools=[
 {name:'canvas_design_system_audit',description:'Audit all project document pages for tokens, reusable masters, canonical linked instances, interaction states and safe motion. Static audit only: preview, propagation and reduced-motion checks are still required before completion.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,openWorldHint:false}},
 {name:'canvas_design_system_init',description:'Add editable foundations, shared variables, reusable buttons/field/card and a UI Kit to the active project document. Preserves existing pages. Requires observed expectedVersion; never retries or overwrites an existing system. Adapt the system to the brief and compose screens with ref instances.',inputSchema:{type:'object',properties:{expectedVersion:{type:'integer',minimum:0},accent:{type:'string',pattern:'^#[0-9A-Fa-f]{6}$'},fontFamily:{type:'string',maxLength:100}},required:['expectedVersion'],additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false}}
];
export async function designSystemOperation(controller,name,args){
 const live=await controller.session.document();
 if(name==='canvas_design_system_audit')return {...auditDesignSystem(live.document),version:live.version};
 if(controller.agents?.status().agents.length)throw Error('Завершите работу агентов перед добавлением общих компонентов.');
 if(args.expectedVersion!==live.version)throw Object.assign(Error('Холст изменился. Прочитайте актуальную версию.'),{code:'VERSION_CONFLICT'});
 await assertCurrentWriter(controller);
 const next=addDesignSystem(live.document,args);
 next.editorMeta={...next.editorMeta,activePageIndex:live.activePageIndex};
 const version=await writeReplacement(controller,next,live.version);
 controller.session.selectionSnapshot=null;controller.persistence?.changed();controller.fonts?.schedule();
 return {version,...auditDesignSystem(next)};
}
