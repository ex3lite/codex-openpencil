import {createInterface} from 'node:readline';
import {isAbsolute} from 'node:path';
import {realpath} from 'node:fs/promises';
import {catalogTools,dispatchCatalogTool} from './community-catalog.mjs';

// The plugin binds the chat project automatically. This standalone entrypoint
// requires an explicit project so a host startup directory cannot become one.
const args=process.argv.slice(2);
if(args.length!==2||args[0]!=='--project-root'||!isAbsolute(args[1]))throw Error('Usage: node figma-community-mcp.mjs --project-root /absolute/project');
const projectRoot=await realpath(args[1]),controller={project:{projectRoot},options:{}};
const exposed=catalogTools.filter(tool=>!tool.name.endsWith('_cover')).map(tool=>({...tool,name:tool.name.replace('canvas_community_catalog_','figma_community_')}));
const text=value=>({content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value});
const input=createInterface({input:process.stdin,crlfDelay:Infinity});
for await(const line of input){
  if(!line.trim())continue;let request;
  try{
    if(Buffer.byteLength(line)>128000)throw Error('MCP request exceeds its limit.');request=JSON.parse(line);
    if(!request||request.jsonrpc!=='2.0'||typeof request.method!=='string')throw Error('Invalid JSON-RPC request.');
    if(!Object.hasOwn(request,'id'))continue;
    let result;
    if(request.method==='initialize')result={protocolVersion:request.params?.protocolVersion||'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'openbrush-figma-community',version:'0.11.0'},instructions:'Search Figma Community directly with figma_community_search. Read actual cards by original numeric ID. Acquire original references or observed public editable downloads; do not substitute web search or a screenshot for editable layers.'};
    else if(request.method==='ping')result={};
    else if(request.method==='tools/list')result={tools:exposed};
    else if(request.method==='tools/call'){
      const tool=exposed.find(tool=>tool.name===request.params?.name);if(!tool)throw Error('Unknown Community MCP tool.');
      try{result=text(await dispatchCatalogTool(controller,tool.name.replace('figma_community_','canvas_community_catalog_'),request.params.arguments||{}));}
      catch(error){result={isError:true,content:[{type:'text',text:error.message}],structuredContent:{code:error.code||'COMMUNITY_FAILED',message:error.message}};}
    }else throw Error('Unsupported MCP method.');
    process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\n');
  }catch(error){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request?.id??null,error:{code:-32600,message:error.message}})+'\n');}
}
