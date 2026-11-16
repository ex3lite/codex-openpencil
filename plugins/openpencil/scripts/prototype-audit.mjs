// Static inventory; only a PreviewSession run can verify interaction behavior.
export function auditPrototype(document) {
 const pages=document.pages?.length?document.pages:[{id:'0',name:document.name||'',children:document.children||[]}];
 const entries=[],masters=new Map();
 const walk=(nodes,pageId)=>{for(const node of nodes){entries.push({node,pageId});if(node.reusable)masters.set(node.id,node);walk(node.children||[],pageId);}};
 for(const page of pages)walk(page.children||[],page.id);
 const screens=entries.filter(({node})=>node.screen).map(({node,pageId})=>({nodeId:node.id,pageId,path:node.screen,name:node.name}));
 const paths=new Set(screens.map(s=>s.path)),issues=[],links=[],motion=[];
 const duplicate=new Set();for(const screen of screens){if(duplicate.has(screen.path))issues.push({code:'DUPLICATE_SCREEN',nodeId:screen.nodeId,path:screen.path});duplicate.add(screen.path);}
 for(const {node,pageId} of entries){
  const master=node.type==='ref'?masters.get(node.ref):null;
  const effective=master?{...master,...node.descendants?.[master.id],...node}:node;
  const eventAnimations=Object.entries(effective.events||{}).flatMap(([event,actions])=>(actions||[]).filter(action=>action.animate).map(action=>({event,animate:action.animate})));
  if(effective.transition||effective.animations?.length||eventAnimations.length)motion.push({nodeId:node.id,pageId,transition:effective.transition||null,animations:effective.animations||[],eventAnimations});
  for(const [event,actions] of Object.entries(effective.events||{}))for(const action of actions||[]){
   const kind=['push','replace'].find(key=>typeof action[key]==='string');if(!kind)continue;
   let path;try{path=JSON.parse(action[kind]);}catch{path=null;}
   links.push({nodeId:node.id,pageId,event,action:kind,path,expression:action[kind]});
   if(typeof path==='string'&&!paths.has(path))issues.push({code:'MISSING_SCREEN',nodeId:node.id,path});
  }
 }
 if(!screens.length)issues.push({code:'NO_EXPLICIT_SCREENS',message:'Preview may infer screens, but no routes are authored.'});
 if(screens.length>1&&!links.length)issues.push({code:'NO_NAVIGATION',message:'Screens exist without authored navigation actions.'});
 return {kind:'static-prototype-audit',screens,links,motion:motion.slice(0,50),motionCount:motion.length,motionTruncated:motion.length>50,issues,
  pages:pages.map(page=>{const nodes=entries.filter(e=>e.pageId===page.id).map(e=>e.node);return {id:page.id,name:page.name,nodes:nodes.length,images:nodes.filter(n=>n.type==='image').length,paths:nodes.filter(n=>n.type==='path').length,linkedInstances:nodes.filter(n=>n.type==='ref').length};}),
  capabilities:{authoring:['transition','animations:mount','animations:inView','events:animate','events:push','events:replace','events:pop'],paintProperties:['opacity','translateX','translateY','scaleX','scaleY','rotation','fill','stroke','cornerRadius'],hostPreviewControl:'toolbar',runtimeVerified:false},
  verificationRequired:['Launch Preview and click the authored routes','Check full and reduced motion','Check disabled controls and modal dismissal','Switch document pages while preview is active']};
}
export const prototypeAuditTool={name:'canvas_prototype_audit',description:'Inventory authored screen routes, navigation, inherited motion and image/vector/instance counts per page. Distinguishes an editable prototype from static boards. Static only, not proof of rendered animation or successful interactions. Author motion through native update_node/batch_design.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,openWorldHint:false}};
