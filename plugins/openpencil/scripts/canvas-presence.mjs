// Model activity is ephemeral editor metadata, never document content or selection.
const COLOR = '#47A8F5';
const TTL = 120_000;
const NATIVE = new Set(['batch_get','read_nodes','snapshot_layout','get_screenshot','lint_document','batch_design','update_node','insert_node','delete_node','move_node','copy_node','finalize_design','design_refine','set_node_text','set_node_font']);
const entries = document => {
 const out=new Map();
 const walk=(nodes,pageId)=>{for(const node of nodes||[]){out.set(node.id,{node,pageId});walk(node.children,pageId);}};
 for(const page of document.pages?.length?document.pages:[{id:'0',children:document.children}])walk(page.children,page.id);
 return out;
};
export class CanvasPresence {
 constructor({session,now=Date.now}) {this.session=session;this.now=now;this.current=null;this.serial=0;this.epoch=now()*1000;}
 clear(){this.inFlight=false;this.current=null;this.serial++;return {active:false};}
 status(){if(this.current&&!this.inFlight&&this.current.expiresAt<=this.now())this.clear();return this.current?{...this.current,rootIds:[...this.current.rootIds]}:null;}
 async focus({pageId,nodeIds,activity='Изучает макет'}={}){
  if(typeof pageId!=='string'||!Array.isArray(nodeIds)||!nodeIds.length||nodeIds.length>100||nodeIds.some(id=>typeof id!=='string')||new Set(nodeIds).size!==nodeIds.length||typeof activity!=='string'||activity.length>120)throw Error('Укажите страницу, существующие элементы и короткое описание работы.');
  const {document}=await this.session.document(),index=entries(document);
  if(nodeIds.some(id=>index.get(id)?.pageId!==pageId))throw Error('Элемент отсутствует на указанной странице.');
  this.current={agentId:'codex-parent',name:'Codex',color:COLOR,pageId,rootIds:[...nodeIds],activity,state:'active',expiresAt:this.now()+TTL};
  this.serial++;return {active:true,...this.status()};
 }
 async nativeStart(name,args={}){
  if(!NATIVE.has(name))return false;
  const live=await this.session.document(),index=entries(live.document);
  const requested=[args.nodeId,args.parentId,...(Array.isArray(args.nodeIds)?args.nodeIds:[])].filter(id=>typeof id==='string'&&index.has(id));
  const pages=live.document.pages?.length?live.document.pages:[{id:'0',children:live.document.children}];
  const pageId=requested.length?index.get(requested[0]).pageId:pages[live.activePageIndex||0]?.id;
  const ids=requested.filter(id=>index.get(id).pageId===pageId);
  // Untargeted batches show neutral viewport presence, never a guessed layer.
  const write=/^(batch_design|update|insert|delete|move|copy|finalize|design_refine|set_)/.test(name);
  this.current={agentId:'codex-parent',name:'Codex',color:COLOR,pageId,rootIds:[...new Set(ids)],activity:write?'Изменяет макет':'Изучает макет',state:'active',expiresAt:this.now()+TTL};
  this.inFlight=true;this.serial++;return true;
 }
 finish(){this.inFlight=false;if(this.current)this.current.expiresAt=this.now()+15_000;}
 relay(upstream){
  const parent=this.status();
  if(!upstream.active&&!parent)return {...upstream,epoch:this.lastEpoch??upstream.epoch};
  const signature=JSON.stringify([upstream.epoch,upstream.active,this.serial,!!parent]);
  if(signature!==this.signature){this.signature=signature;this.epoch++;}
  this.lastEpoch=this.epoch;
  const nodes=new Map((upstream.nodes||[]).map(n=>[n.id,n])),reveals=new Map((upstream.reveals||[]).map(n=>[n.id,n]));
  if(parent)for(const id of parent.rootIds){
   // A subagent's exclusive scope retains its own visible identity.
   if(nodes.has(id))continue;
   nodes.set(id,{id,name:parent.name,color:parent.color});reveals.set(id,{id,ms:0});
  }
  return {...upstream,epoch:this.epoch,active:true,cursorAgent:parent&&!parent.rootIds.length?{name:parent.name,color:parent.color}:upstream.cursorAgent,nodes:[...nodes.values()],reveals:[...reveals.values()]};
 }
}
export const presenceTool={name:'canvas_activity',description:'Show the main Codex cursor at real target layers without editing or selecting them. Use focus before a longer canvas inspection or direct document update, renew focus while working, and clear when finished. Expires after two minutes without activity. Native targeted tools also publish activity automatically. Does not spawn agents.',inputSchema:{type:'object',properties:{action:{type:'string',enum:['focus','clear']},pageId:{type:'string'},nodeIds:{type:'array',items:{type:'string'},minItems:1,maxItems:100},activity:{type:'string',maxLength:120}},required:['action'],additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false}};
