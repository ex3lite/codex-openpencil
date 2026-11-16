import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {CommunityBrowser} from './community-browser.mjs';
import {CommunityDataset} from './community-assets.mjs';
import {privateDirectory,atomicBytes,safeBytes,withLibraryLock} from './library-storage.mjs';
import {publicHttpsUrl} from './community-network.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex'),str={type:'string'};
const fail=(code,message)=>Object.assign(new Error(message),{code});
const tool=(name,description,properties={},required=[],readOnly=true)=>({name,description,inputSchema:{type:'object',properties,required,additionalProperties:false},annotations:{readOnlyHint:readOnly,destructiveHint:false,openWorldHint:true},_meta:{ui:{visibility:['model','app']}}});
export const catalogTools=[
  tool('canvas_community_catalog_status','Check the direct Figma Community catalog browser and its capabilities. No model or search-engine calls.'),
  tool('canvas_community_catalog_search','Search the actual public Figma Community catalog by query, not the local library. Returns original numeric resource IDs, titles, authors and original cover URLs from rendered Community cards. No Perplexity, model calls or private API scraping.',{query:str,limit:{type:'integer',minimum:1,maximum:24},offset:{type:'integer',minimum:0,maximum:120}},['query']),
  tool('canvas_community_catalog_get','Inspect a public Community resource by original numeric ID: actual author, description, original cover, observed license and public download links. Retains version fingerprints and source provenance.',{resourceId:str},['resourceId']),
  tool('canvas_community_catalog_acquire','Acquire a Community resource into the global library and link it to this project. Reference mode retains the original cover as a labelled raster reference. Editable mode requires an actual public .fig/.op/.svg download link; unavailable exports are reported, never replaced by screenshots.',{resourceId:str,mode:{type:'string',enum:['reference','editable']},downloadUrl:str},['resourceId'],false),
  tool('canvas_community_catalog_check','Compare this original Community ID with the previously observed public card and report source changes. Fingerprints are observed metadata versions, not invented Figma file keys.',{resourceId:str},['resourceId']),
  {...tool('canvas_community_catalog_cover','App-only: load a DOM-verified original Community thumbnail for its exact resource card.',{resourceId:str},['resourceId']),_meta:{ui:{visibility:['app']}}},
];
function id(value){if(typeof value!=='string'||!/^\d{6,24}$/.test(value))throw fail('INVALID_COMMUNITY_ID','Supply the numeric ID from a Figma Community file URL.');return value;}
function text(value,max=500){if(typeof value!=='string'||value.length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value))throw fail('INVALID_COMMUNITY_RESPONSE','Invalid public Community text.');return value.trim();}
function coverUrl(value){const url=publicHttpsUrl(value);if(!['s3-alpha.figma.com','s3-alpha-sig.figma.com','figma-alpha-api.s3.us-west-2.amazonaws.com','s3-figma-hubfile-images-production-cdn-cgi.figma.com'].includes(url.hostname))throw fail('INVALID_COMMUNITY_COVER','Cover must come from an observed Figma CDN URL.');return url.href;}
export function validateCommunityCard(value,expectedId){
  if(!value||typeof value!=='object')throw fail('INVALID_COMMUNITY_RESPONSE','Missing Community resource.');
  if(value.downloads!==undefined&&(!Array.isArray(value.downloads)||value.downloads.length>20))throw fail('INVALID_COMMUNITY_RESPONSE','Invalid public Community download links.');
  const resourceId=id(value.resourceId);if(expectedId&&resourceId!==expectedId)throw fail('COMMUNITY_ID_MISMATCH','Community response belongs to another resource.');
  const source=new URL(value.url),match=source.pathname.match(/^\/community\/file\/(\d+)(?:\/|$)/);
  if(source.protocol!=='https:'||source.hostname!=='www.figma.com'||source.username||source.password||source.port||match?.[1]!==resourceId)throw fail('COMMUNITY_ID_MISMATCH','Community URL and resource ID must agree.');
  const result={resourceId,originalCommunityId:resourceId,url:`https://www.figma.com/community/file/${resourceId}`,title:text(value.title),
    ...(value.author&&{author:text(value.author,300)}),...(value.description&&{description:text(value.description,4000)}),...(value.coverUrl&&{coverUrl:coverUrl(value.coverUrl)}),
    downloads:(value.downloads||[]).map(u=>publicHttpsUrl(u).href).slice(0,20)};
  if(value.license){const url=publicHttpsUrl(value.license.url).href;result.license={name:text(value.license.name,200),url,...(/^https:\/\/creativecommons.org\/licenses\/by\/4\.0\//.test(url)&&{spdx:'CC-BY-4.0'})};}
  if(value.updatedAt)result.updatedAt=text(value.updatedAt,100);
  return result;
}
export class CommunityCatalog {
  constructor(dataset,{browser=new CommunityBrowser()}={}){this.dataset=dataset;this.browser=browser;this.directory=join(dataset.directory,'community-catalog');}
  async ensure(){await this.dataset.ensure();await privateDirectory(this.directory);await privateDirectory(join(this.directory,'versions'));}
  async index(){await this.ensure();try{const value=JSON.parse(await safeBytes(join(this.directory,'index.json'),8*1024*1024));if(value.schemaVersion!==1||!Array.isArray(value.resources))throw Error('Invalid catalog index.');return value;}catch(error){if(error.code==='ENOENT')return {schemaVersion:1,resources:[]};throw error;}}
  fingerprint(card){return sha(JSON.stringify(card));}
  async remember(card){
    await this.ensure();
    const fingerprint=this.fingerprint(card),observedAt=new Date().toISOString();
    await withLibraryLock(this.directory,async()=>{const index=await this.index();await atomicBytes(join(this.directory,'versions',`${fingerprint}.json`),JSON.stringify({schemaVersion:1,...card,fingerprint,observedAt})+'\n');
      const previous=index.resources.find(r=>r.resourceId===card.resourceId);index.resources=index.resources.filter(r=>r.resourceId!==card.resourceId);index.resources.push({resourceId:card.resourceId,fingerprint,observedAt,...(previous?.assetId&&{assetId:previous.assetId})});await atomicBytes(join(this.directory,'index.json'),JSON.stringify(index)+'\n');},'.catalog-lock');
    return {...card,fingerprint,observedAt};
  }
  async search({query,limit=12,offset=0}={}){
    if(typeof query!=='string'||!query.trim()||query.length>200||!Number.isInteger(limit)||limit<1||limit>24||!Number.isInteger(offset)||offset<0||offset>120)throw fail('INVALID_COMMUNITY_SEARCH','Use a nonempty query, limit 1–24 and offset 0–120.');
    const response=await this.browser.request({kind:'search',query:query.trim(),limit,offset});
    if(response?.source!=='figma-community-dom'||!Array.isArray(response.results)||response.results.length>limit)throw fail('INVALID_COMMUNITY_RESPONSE','Invalid direct Community catalog response.');
    const seen=new Set(),results=response.results.map(c=>validateCommunityCard(c)).filter(card=>{if(seen.has(card.resourceId))throw fail('INVALID_COMMUNITY_RESPONSE','Duplicate Community resource.');seen.add(card.resourceId);return true;});
    return {source:'figma-community',transport:'connected-browser-dom',query:query.trim(),offset,results,hasMore:response.hasMore===true,observedAt:new Date().toISOString()};
  }
  async get({resourceId}={}){id(resourceId);const response=await this.browser.request({kind:'get',resourceId});return this.remember(validateCommunityCard(response,resourceId));}
  async check({resourceId}={}){
    id(resourceId);const previous=(await this.index()).resources.find(r=>r.resourceId===resourceId),response=await this.browser.request({kind:'get',resourceId}),card=validateCommunityCard(response,resourceId),fingerprint=this.fingerprint(card);
    return {resourceId,originalCommunityId:resourceId,previousFingerprint:previous?.fingerprint||null,currentFingerprint:fingerprint,updateAvailable:previous?previous.fingerprint!==fingerprint:null,revisionKind:'observed-public-metadata',card};
  }
  async image(resourceId,variant='cover'){
    const info=await this.browser.request({kind:'image',resourceId,variant});
    if(!info||info.resourceId!==resourceId||!Number.isInteger(info.parts)||info.parts<1||info.parts>40||!Number.isInteger(info.bytes)||info.bytes<1||info.bytes>4*1024*1024||!/^[a-f0-9]{64}$/.test(info.sha256)||typeof info.token!=='string'||info.token.length>128)throw fail('INVALID_COMMUNITY_IMAGE','Invalid original cover transfer.');
    validateCommunityCard({resourceId,title:'Original cover',url:info.pageUrl},resourceId);
    coverUrl(info.sourceUrl);const chunks=[];let total=0;
    try{for(let index=0;index<info.parts;index++){const part=await this.browser.request({kind:'image.read',token:info.token,index});if(part.index!==index||typeof part.data!=='string'||part.data.length>180000||!/^[A-Za-z0-9+/]*={0,2}$/.test(part.data))throw fail('INVALID_COMMUNITY_IMAGE','Invalid cover chunk.');const bytes=Buffer.from(part.data,'base64');total+=bytes.length;if(total>info.bytes)throw fail('INVALID_COMMUNITY_IMAGE','Cover exceeds declared size.');chunks.push(bytes);}}
    finally{await this.browser.request({kind:'image.close',token:info.token}).catch(()=>{});}
    const bytes=Buffer.concat(chunks);if(bytes.length!==info.bytes||sha(bytes)!==info.sha256)throw fail('COMMUNITY_IMAGE_CHECKSUM','Original cover checksum differs.');
    return {bytes,sourceUrl:info.sourceUrl};
  }
  async cover({resourceId}={}){id(resourceId);const image=await this.image(resourceId,'thumbnail');const format=image.bytes[0]===137?'png':image.bytes[0]===255?'jpeg':image.bytes.subarray(0,4).toString()==='RIFF'?'webp':null;if(!format)throw fail('COMMUNITY_REFERENCE_FORMAT_UNSUPPORTED','Unsupported Community cover format.');return {resourceId,sourceUrl:image.sourceUrl,coverDataUrl:`data:image/${format};base64,${image.bytes.toString('base64')}`};}
  async acquire({resourceId,mode='reference',downloadUrl}={}){
    if(!['reference','editable'].includes(mode))throw fail('INVALID_COMMUNITY_MODE','Choose reference or editable.');
    const card=await this.get({resourceId}),settings=await this.dataset.settings();
    if(!card.author)throw fail('COMMUNITY_AUTHOR_UNAVAILABLE','The public card did not expose its author. No attribution was invented.');
    let licenseText;
    if(card.license?.spdx==='CC-BY-4.0')licenseText=(await this.dataset.fetchBytes('https://creativecommons.org/licenses/by/4.0/legalcode.txt',256*1024)).toString('utf8');
    if(settings.verifyLicenses&&!licenseText)throw fail('COMMUNITY_LICENSE_UNVERIFIED','The public card license is unknown; current library settings require verified terms.');
    const format=downloadUrl&&new URL(downloadUrl).pathname.match(/\.(fig|op|svg)$/i)?.[1]?.toLowerCase();
    if(mode==='editable'&&(!format||!card.downloads.includes(downloadUrl)))throw fail('EDITABLE_DOWNLOAD_UNAVAILABLE','This public card exposes no selected .fig/.op/.svg original. Use an authorized export or a public author download; a preview is not editable layers.');
    const original=await this.image(resourceId);await this.ensure();const temporary=await mkdtemp(join(this.directory,'.acquire-'));
    try{
      const coverPath=join(temporary,'original-cover');await writeFile(coverPath,original.bytes,{mode:0o600,flag:'wx'});
      const metadata={name:card.title,author:card.author,communityUrl:card.url,originalCommunityId:resourceId,coverUrl:original.sourceUrl,coverPath,licenseSpdx:card.license?.spdx,licenseUrl:card.license?.url,licenseText,tags:['figma-community',resourceId,mode]};
      const imageFormat=original.bytes[0]===137?'png':original.bytes[0]===255?'jpeg':original.bytes.subarray(0,4).toString()==='RIFF'?'webp':null;
      if(mode==='reference'&&!imageFormat)throw fail('COMMUNITY_REFERENCE_FORMAT_UNSUPPORTED','This original image format is not supported as an editable canvas reference.');
      const asset=mode==='editable'?await this.dataset.download({...metadata,kind:'ui-kit',format,url:downloadUrl,sourceUrl:card.url}):await this.dataset.ingest({...metadata,sourcePath:coverPath,format:imageFormat,kind:'reference',sourceUrl:original.sourceUrl},original.bytes);
      await withLibraryLock(this.directory,async()=>{const index=await this.index(),row=index.resources.find(r=>r.resourceId===resourceId);if(row)row.assetId=asset.id;await atomicBytes(join(this.directory,'index.json'),JSON.stringify(index)+'\n');},'.catalog-lock');
      return {mode,editable:mode==='editable'&&(!asset.conversion||asset.conversion.ready===true),card,asset};
    }finally{await rm(temporary,{recursive:true,force:true});}
  }
}
export async function dispatchCatalogTool(controller,name,args={}){
  const browser=controller.options?.catalog?.browser||new CommunityBrowser();
  if(name==='canvas_community_catalog_status')return browser.status();
  if(!controller.project?.projectRoot)throw fail('PROJECT_ROOT_REQUIRED','Open this project canvas first.');
  const catalog=new CommunityCatalog(new CommunityDataset(controller.project.projectRoot,controller.options?.community||{}),{browser});
  const method={canvas_community_catalog_search:'search',canvas_community_catalog_get:'get',canvas_community_catalog_acquire:'acquire',canvas_community_catalog_check:'check',canvas_community_catalog_cover:'cover'}[name];
  if(!method)throw fail('COMMUNITY_OPERATION_DENIED','Unknown Community catalog operation.');return catalog[method](args);
}
