const string = { type:'string' }, ids = { type:'array', items:string, minItems:1, maxItems:100 };
const schema = (properties, required=[]) => ({ type:'object', properties, required, additionalProperties:false });
const tool = (name, description, properties={}, required=[], app=false, readOnly=false) => ({name,description,
  inputSchema:schema(properties,required), annotations:{readOnlyHint:readOnly,destructiveHint:!readOnly,openWorldHint:false},
  ...(app ? {_meta:{ui:{visibility:['app']}}} : {})});
export const workspaceTools = [
  tool('canvas_documents','List only the documents belonging to this canvas project. Never discover another project or a global latest canvas.',{},[],false,true),
  tool('canvas_document_open','Switch to a registered document in this project, or explicitly create an empty project document. UI must flush before switching. Refuses active agent assignments and conflicts. Never retries.',
    {documentId:string,create:{type:'boolean'},docJson:string},[],true),
  tool('canvas_document_import','Import an external .op as a new copy inside this project. The original is preserved and no existing file is replaced.',{sourcePath:string,filePath:string},['sourcePath']),
  tool('canvas_comment_create','Persist feedback on exact selected layers after UI flush. Captures project, document, page, nodes and version; does not send a chat message.',
    {requestId:string,text:{type:'string',maxLength:8000},pageId:string,nodeIds:ids,expectedVersion:{type:'integer'},docJson:string},['requestId','text','pageId','nodeIds','expectedVersion','docJson'],true),
  tool('canvas_comments','Read durable comments for this project document. Use fixed node IDs and captured version, never the later selection. A missing layer is not permission to edit the whole canvas.',{},[],false,true),
  tool('canvas_comment_update','Update delivery or resolution of a saved comment. Mark resolved only after implementing and verifying its requested change.',
    {commentId:string,status:{type:'string',enum:['sent','uncertain','resolved']}},['commentId','status']),
  tool('canvas_agents','Read main Codex presence and the real subagents assigned to this canvas, their names, colors and exclusive subtree scopes. Maximum 10. Does not spawn a model.',{},[],false,true),
  tool('canvas_agent_assign','Parent agent: reserve disjoint existing root subtrees for one Codex subagent. Returns canvasId and leaseId to pass to that subagent along with projectRoot. Spawn via Codex collaboration tools, not the editor AI. Each child uses canvas_agent; keep parent canvas open. Up to 10 concurrent assignments.',
    {agentId:string,name:string,pageId:string,rootIds:ids,ttlMs:{type:'integer',minimum:10000,maximum:3600000}},['agentId','name','pageId','rootIds']),
  tool('canvas_agent','Work on the parent canvas without opening another editor. Requires explicit projectRoot, canvasId and leaseId supplied by the parent. Read returns canonical scoped subtrees/version. Apply replaces only assigned subtrees using the observed expectedVersion; preserves every unrelated node. On VERSION_CONFLICT read and explicitly rebase; on uncertainty read before another write. Never retry a mutation automatically. Use focus with nodeIds to place your named cursor inside the assigned scope. Release when finished.',
    {projectRoot:string,canvasId:string,leaseId:string,action:{type:'string',enum:['read','apply','renew','release','inspect','focus']},nodeIds:ids,expectedVersion:{type:'integer',minimum:0},subtrees:{type:'array',items:{type:'object'},maxItems:100}},['projectRoot','canvasId','leaseId','action']),
];
