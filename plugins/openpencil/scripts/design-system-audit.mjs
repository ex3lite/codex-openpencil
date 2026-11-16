const controls=new Set(['text_input','text_area','select','checkbox','switch','slider','radio_group','number_input','tabs']);
const motionProps=new Set(['opacity','fill','stroke','cornerRadius','translateX','translateY','scaleX','scaleY','rotation']);
function expandInstance(instance, master) {
 const {children:slots,...properties}=instance;
 const root={...master,...instance.descendants?.[master.id],...properties,type:master.type};
 const stack=[{source:master,target:root}];let count=0;
 while(stack.length){const {source,target}=stack.pop();
  if(++count>10000)return null;
  target.children=(source.children||[]).map(child=>{
   const copy={...child,...instance.descendants?.[child.id]};stack.push({source:child,target:copy});return copy;
  });
 }
 return root;
}
export function auditDesignSystem(document) {
 const pages=document.pages?.length?document.pages:[{id:'0',name:document.name||'',children:document.children||[]}];
 const entries=[],masters=new Map(),ids=new Set(),issues=[];let issueCount=0;
 const issue=(code,nodeId,message)=>{issueCount++;if(issues.length<100)issues.push({code,nodeId,message});};
 const stack=pages.flatMap(page=>(page.children||[]).map(node=>({node,pageId:page.id,master:null})));
 while(stack.length){const entry=stack.pop(),{node}=entry;entries.push(entry);
  if(ids.has(node.id))issue('DUPLICATE_ID',node.id,'Node IDs must be unique across project pages.');ids.add(node.id);
  const master=node.reusable===true?node:entry.master;
  if(node.reusable===true)masters.set(node.id,node);
  for(const child of node.children||[])stack.push({node:child,pageId:entry.pageId,master});
 }
 const variables=Object.entries(document.variables||{});
 if(!variables.some(([,v])=>v.type==='color'))issue('COLOR_TOKENS',null,'Define shared semantic colors.');
 if(!variables.some(([k,v])=>v.type==='number'&&/space|spacing|gap/i.test(k)))issue('SPACING_TOKENS',null,'Define shared spacing tokens.');
 if(!variables.some(([k])=>/font|type|text/i.test(k)))issue('TYPE_TOKENS',null,'Define shared typography tokens.');
 if(!pages.some(p=>/основ|дизайн.?систем|foundation|design.?system/i.test(p.name)))issue('FOUNDATIONS_PAGE',null,'Create a named design-system foundations page.');
 if(!pages.some(p=>/ui.?kit|компонент/i.test(p.name)))issue('UI_KIT_PAGE',null,'Create a named UI Kit page with reusable masters and state examples.');
 if(!masters.size)issue('NO_COMPONENTS',null,'Define reusable components before composing screens.');
 let instances=0,controlCount=0;
 const inspectControl=(node,owner)=>{
  const isButton=node.semantics?.role==='button'||node.semantics?.role==='link';
  if(!isButton&&!controls.has(node.type))return;controlCount++;
  if(!owner&&node.reusable!==true)issue('ONE_OFF_CONTROL',node.id,'Use a linked instance of a reusable component.');
  if(isButton&&['horizontal','vertical'].includes(node.layout)) for(const child of node.children||[]) if(child.type==='text'&&(child.x!=null||child.y!=null)) issue('CONTROL_LABEL_POSITION',child.id,'Let auto layout position button labels; remove explicit x/y coordinates.');
  const events=node.events||{},bindings=node.bindings||{};
  const expressions=JSON.stringify([events,bindings,node.enabled,node.semantics?.disabled]);
  for(const key of Object.keys(node.state||{})) if(expressions.includes('$state.'+key)||expressions.includes('$app.'+key)) issue('SHARED_INTERACTION_STATE',node.id,'Use $self for this control local state: '+key);
  if(node.state?.disabled&&node.enabled!==false&&!(typeof node.enabled==='string'&&node.enabled.includes('$self.disabled'))) issue('DISABLED_GUARD',node.id,'The enabled guard must honor the local disabled state.');
  const requirements={hover:['onHoverEnter','onHoverLeave'],pressed:['onPressStart','onPressEnd','onPressCancel'],focused:['onFocus','onBlur']};
  for(const [mode,hooks] of Object.entries(requirements)){
   const direct=node.states?.[mode];
   const reactive=hooks.every(h=>Array.isArray(events[h])&&events[h].length)&&Object.keys(bindings).length>0;
   if(!direct&&!reactive)issue('STATE_'+mode.toUpperCase(),node.id,'Define and preview the '+mode+' state.');
  }
  if(!node.states?.disabled&&!(node.state?.disabled&&node.enabled&&Object.keys(bindings).length))issue('STATE_DISABLED',node.id,'Define disabled behavior and visuals.');
  if(!node.transition||!Number.isFinite(node.transition.durationMs)||node.transition.durationMs<0||node.transition.durationMs>500)issue('CONTROL_MOTION',node.id,'Declare a short transition; verify reduced motion in preview.');
 };
 const inspectMotion=node=>{
  for(const property of node.transition?.properties||[])if(!motionProps.has(property))issue('LAYOUT_MOTION',node.id,'Animate paint properties instead of layout: '+property);
  for(const animation of node.animations||[])if(!['mount','inView'].includes(animation.trigger))issue('ANIMATION_TRIGGER',node.id,'Use supported mount/inView triggers; interactions use events and transitions.');
 };
 for(const {node,master} of entries){
  if(node.type==='ref'){
   instances++;
   if(!masters.has(node.ref)){issue('BROKEN_COMPONENT',node.id,'The component master is missing.');inspectMotion(node);continue;}
   const target=masters.get(node.ref),expanded=expandInstance(node,target);
   if(!expanded){issue('AUDIT_COMPLEXITY_LIMIT',node.id,'Inspect this component separately: instance expansion exceeds 10000 nodes.');continue;}
   const stack=[expanded];while(stack.length){const child=stack.pop();inspectControl(child,target);inspectMotion(child);stack.push(...(child.children||[]));}
  }else{inspectControl(node,master);inspectMotion(node);}
 }
 if(controlCount&&instances===0)issue('NO_LINKED_INSTANCES',null,'Compose the product with canonical ref instances, not cloned masters.');
 return {schemaVersion:1,complete:issues.length===0,kind:'static-document-audit',pages:pages.length,nodes:entries.length,tokens:variables.length,components:masters.size,instances,controls:controlCount,issues,issueCount,issuesTruncated:issueCount>issues.length,
  verificationRequired:['Render and inspect the product and UI Kit','Change a master and verify linked instances','Exercise hover, press, focus and disabled states','Verify transitions with full and reduced motion','Verify autosave and reopen']};
}
