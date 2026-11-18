import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { basename, extname, isAbsolute, join } from 'node:path';
import { importCanvasImage } from './canvas-images.mjs';
import { importProjectDocument } from './canvas-projects.mjs';
import { liveDocument } from './document-format.mjs';
import { fetchPublicBytes, publicHttpsUrl } from './community-network.mjs';
import { communitySettings } from './community-settings.mjs';
import { stateRoot } from './editor-runtime.mjs';
import { privateDirectory, atomicBytes, safeBytes, withLibraryLock } from './library-storage.mjs';
import { prepareLibraryAsset, inspectLibraryAsset, nativeResourceSummary } from './library-conversion.mjs';

const LIMIT = 256 * 1024 * 1024;
const DOCUMENT_LIMIT = 1024 * 1024 * 1024;
const formatLimit = format => ['fig','op'].includes(format) ? DOCUMENT_LIMIT : LIMIT;
const INDEX_LIMIT = 8 * 1024 * 1024;
const FORMATS = new Set(['svg', 'png', 'jpg', 'jpeg', 'webp', 'fig', 'op']);
const KINDS = ['icon', 'ui-kit', 'reference', 'document'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const string = { type: 'string' };
const scope = {type:'string',enum:['global','project']};
const metadata = { name: string, kind: { type:'string', enum:KINDS }, sourceUrl:string, communityUrl:string, originalCommunityId:string, figmaFileKey:string,
  coverUrl:string, coverPath:string, coverPageUrl:string, author:string, licenseSpdx:string, licenseUrl:string, licenseText:string, tags:{type:'array',items:string,maxItems:32} };
const tool = (name, description, properties, required = [], readOnly = false, modelOnly = false) => ({
  name, description, inputSchema:{ type:'object', properties, required, additionalProperties:false },
  annotations:{ readOnlyHint:readOnly, destructiveHint:false, openWorldHint:name.endsWith('_download') || name.endsWith('_seed') },
  ...(modelOnly && { _meta:{ui:{visibility:['model']}} }),
});
export const communityTools = [
  tool('canvas_community_settings','Read or update global resource defaults or project overrides. Autonomous resource selection defaults enabled. License verification defaults to enabled; disabling permits unknown licenses under user responsibility, while retaining known attribution and licenses.',{scope,verifyLicenses:{type:'boolean'},autonomous:{type:'boolean'}}),
  tool('canvas_community_search','Search the global downloaded resource library by default, or scope to project-linked resources. Returns provenance, license, checksums and safe local previews. For external discovery use the host web search and Figma Community URLs; this tool searches local files only.',
    {scope,query:string,kind:{type:'string',enum:KINDS},order:{type:'string',enum:['library']},limit:{type:'integer',minimum:1,maximum:100},offset:{type:'integer',minimum:0},previews:{type:'boolean'}},[],true),
  tool('canvas_community_ingest','Copy an authorized local SVG, image, .op or .fig into the global library and link it to this project with source and retained license. .fig automatically converts and indexes all pages through the verified native converter. No archive extraction or script execution.',
    {...metadata,sourcePath:string,licensePath:string},['sourcePath','kind','sourceUrl','author'],false,true),
  tool('canvas_community_download','Download an authorized public HTTPS asset from its original source into the global library and link it to this project. Keeps source, any known license and original cover. License evidence is required when project license verification is enabled. No login, private URLs or access-control bypass.',
    {...metadata,url:string,format:{type:'string',enum:[...FORMATS]},expectedSha256:string},['url','kind','sourceUrl','author'],false,true),
  tool('canvas_community_seed','Download the pinned Lucide essential icon pack with full upstream ISC/MIT license and verified official Community plugin URL. Adds local editable SVGs; does not edit the canvas.',
    {pack:{type:'string',enum:['lucide-essential']}},[],false,true),
  tool('canvas_community_prepare','Convert an existing global .fig asset to a complete native .op resource using the verified bundled converter. Index every page and retain source fingerprint, converter version and warnings without opening the canvas.',{assetId:string},['assetId'],false,true),
  tool('canvas_community_inspect','Inspect global native resource pages, node counts and searchable node names without opening a canvas. Pagination never truncates the stored resource.',{assetId:string,query:string,pageId:string,namesOffset:{type:'integer',minimum:0},namesLimit:{type:'integer',minimum:1,maximum:32},offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:100}},['assetId'],true,true),
  { ...tool('canvas_community_file','App-only: read a checksum-verified .fig asset from the current project dataset for the native Rust Figma importer. Binary bytes are returned only in private App metadata.',{assetId:string},['assetId'],true), _meta:{ui:{visibility:['app']}} },
  tool('canvas_community_import','Use a checksum-verified dataset asset: SVG becomes editable native vectors; image embeds into an existing image node; .op creates a project document copy. .fig is converted headlessly then copied as a separate native project document. SVG/image require current page and version. Does not retry or save canvas changes.',
    {assetId:string,docJson:string,expectedVersion:{type:'integer',minimum:0},pageId:string,nodeId:string,parentId:string,x:{type:'integer'},y:{type:'integer'}},['assetId']),
];

function text(value, label, max = 2048) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /\0/.test(value)) throw Error(`Invalid ${label}.`);
  return value.trim();
}
function publicUrl(value, label = 'source URL') {
  let url; try { url = new URL(text(value, label)); } catch { throw Error(`Invalid ${label}.`); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) throw Error(`Use a public HTTPS ${label} without credentials or a port.`);
  return url.href;
}
async function bytesAt(path, limit = DOCUMENT_LIMIT) {
  if (!isAbsolute(path)) throw Error('Use an absolute local path.');
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit || info.size === 0) throw Error('Use a nonempty regular file within the size limit; symlinks are not accepted.');
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const current = await handle.stat();
    if (!current.isFile() || current.ino !== info.ino || current.dev !== info.dev || current.size > limit) throw Error('File changed while opening.');
    const bytes = await handle.readFile();
    if (!bytes.length || bytes.length > limit) throw Error('File exceeds its size limit.');
    return bytes;
  } finally { await handle.close(); }
}
export function validateContent(bytes, format) {
  if (!FORMATS.has(format) || !bytes.length || bytes.length > formatLimit(format)) throw Error('Unsupported asset format or size.');
  if (format === 'svg') {
    const svg = bytes.toString('utf8');
    // Keep native vectors self-contained. Reject active XML/CSS and all resource references.
    if (!/^\s*(?:<\?xml\s[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(svg) || !/<\/svg\s*>\s*$/i.test(svg) ||
      /<!DOCTYPE|<!ENTITY|<\s*(?:script|foreignObject|iframe|image|use|style|animate|set|a)(?:\s|\/?>)|\bon\w+\s*=|\b(?:href|src)\s*=|url\s*\(|@import/i.test(svg)) {
      throw Error('SVG must contain self-contained, inactive vector shapes only.');
    }
    const safeElements = new Set(['svg','g','path','circle','ellipse','rect','line','polyline','polygon','defs','lineargradient','radialgradient','stop','clippath','mask','title','desc']);
    for (const match of svg.matchAll(/<\/?([\w:-]+)(?=[\s/>])/g)) if (!safeElements.has(match[1].toLowerCase())) throw Error('SVG contains an unsupported element.');
    if (/<\?(?!xml\s)/i.test(svg)) throw Error('SVG processing instructions are not supported.');
  } else if (format === 'png' && !(bytes.length >= 33 && bytes.subarray(0,8).toString('hex') === '89504e470d0a1a0a' && bytes.toString('ascii',12,16) === 'IHDR')) throw Error('Invalid PNG content.');
  else if (['jpg','jpeg'].includes(format) && !(bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)) throw Error('Invalid JPEG content.');
  else if (format === 'webp' && !(bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP')) throw Error('Invalid WebP content.');
  else if (format === 'op') {
    let doc; try { doc = JSON.parse(bytes); } catch { throw Error('Invalid .op JSON.'); }
    if (!doc || (!Array.isArray(doc.pages) && !Array.isArray(doc.children))) throw Error('Invalid .op document structure.');
  }
}
function coverFormat(bytes) {
  if(bytes.subarray(0,8).toString('hex')==='89504e470d0a1a0a') return 'png';
  if(bytes[0]===255 && bytes[1]===216) return 'jpg';
  if(bytes.toString('ascii',0,4)==='RIFF') return 'webp';
  if(bytes.length>=16 && bytes.toString('ascii',4,8)==='ftyp') {
    const size=bytes.readUInt32BE(0);
    if(size>=16 && size<=bytes.length && size%4===0) {
      const brands=[bytes.toString('ascii',8,12)];
      for(let offset=16;offset<size;offset+=4) brands.push(bytes.toString('ascii',offset,offset+4));
      if(brands.some(brand=>brand==='avif' || brand==='avis')) return 'avif';
    }
  }
  return null;
}
function validateCover(bytes,format) {
  if(format==='avif') {
    if(coverFormat(bytes)!=='avif') throw Error('Invalid AVIF original cover content.');
  } else validateContent(bytes,format);
}
const importMode = format => format === 'svg' ? 'vector' : format === 'op' ? 'document' : format === 'fig' ? 'figma' : 'image';

function originalCommunityIdentity(args) {
  let originalCommunityId=null,figmaFileKey=null;
  for(const value of [args.communityUrl,args.sourceUrl]) {
    if(!value)continue;
    let url;try{url=new URL(value);}catch{continue;}
    if(url.protocol!=='https:'||!['www.figma.com','figma.com'].includes(url.hostname))continue;
    originalCommunityId ||= url.pathname.match(/^\/community\/file\/(\d+)(?:\/|$)/)?.[1] || null;
    figmaFileKey ||= url.pathname.match(/^\/(?:design|file)\/([A-Za-z0-9]+)(?:\/|$)/)?.[1] || null;
  }
  if(args.originalCommunityId!==undefined && args.originalCommunityId!==null && args.originalCommunityId!==originalCommunityId)throw Error('Original Figma Community ID must match the retained numeric Community file URL.');
  if(args.figmaFileKey!==undefined && args.figmaFileKey!==null && args.figmaFileKey!==figmaFileKey)throw Error('Figma file key must match the retained original Figma file URL.');
  return {...(originalCommunityId && {originalCommunityId}),...(figmaFileKey && {figmaFileKey})};
}

function sourcePackMetadata(value) {
  if(!value || typeof value!=='object' || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(value.id) ||
    !/^[a-f0-9]{64}$/.test(value.archiveSha256) || !/^[0-9]+$/.test(value.originalCommunityId)) throw Error('Invalid source icon pack provenance.');
  return {id:value.id,revision:text(value.revision,'pack revision',200),key:text(value.key,'pack icon key',300),
    originalCommunityId:value.originalCommunityId,archiveSha256:value.archiveSha256};
}

export class ProjectCommunityDataset {
  constructor(projectRoot, { fetchImpl, lookupImpl } = {}) { this.projectRoot = projectRoot; this.network = {fetchImpl,lookupImpl}; this.coverCache=new Map(); this.directory = join(projectRoot,'.openpencil','community'); }
  async ensure() {
    if (!isAbsolute(this.projectRoot) || await realpath(this.projectRoot) !== this.projectRoot) throw Error('Use the canonical bound project directory.');
    for (const path of [join(this.projectRoot,'.openpencil'),this.directory,join(this.directory,'assets'),join(this.directory,'licenses'),join(this.directory,'covers')]) {
      await mkdir(path,{recursive:true,mode:0o700});
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(path) !== path) throw Error('Dataset directories cannot be symlinks.');
    }
  }
  async index() {
    await this.ensure();
    let value;
    try { value = JSON.parse(await bytesAt(join(this.directory,'index.json'), INDEX_LIMIT)); }
    catch (error) { if (error.code === 'ENOENT') return {schemaVersion:1,assets:[]}; throw error; }
    if (value.schemaVersion !== 1 || !Array.isArray(value.assets)) throw Error('Invalid Community dataset index.');
    const ids = new Set();
    for (const entry of value.assets) {
      if (!entry || !/^[a-f0-9]{24}$/.test(entry.id) || ids.has(entry.id) || !/^[a-f0-9]{64}$/.test(entry.sha256) ||
          !FORMATS.has(entry.format) || entry.relativePath !== `assets/${entry.sha256}.${entry.format}` ||
          typeof entry.name !== 'string' || typeof entry.author !== 'string' || !KINDS.includes(entry.kind) ||
          !Array.isArray(entry.tags) || !entry.tags.every(tag=>typeof tag==='string') || !Number.isSafeInteger(entry.bytes) || entry.bytes<1 ||
          !entry.license || (entry.license.status === 'unknown' && entry.license.sha256 == null ? entry.license.responsibility !== 'user' || entry.license.textPath != null :
            !/^[a-f0-9]{64}$/.test(entry.license.sha256) || entry.license.textPath !== `licenses/${entry.license.sha256}.txt`) ||
          (entry.cover && (!/^[a-f0-9]{64}$/.test(entry.cover.sha256) || !['png','jpg','jpeg','webp','avif'].includes(entry.cover.format) ||
            entry.cover.relativePath !== `covers/${entry.cover.sha256}.${entry.cover.format}` || !Number.isSafeInteger(entry.cover.bytes) || entry.cover.bytes<1))) throw Error('Invalid Community asset index entry.');
      ids.add(entry.id);
    }
    return value;
  }
  async verified(entry,{licensePolicy=true} = {}) {
    const bytes = await bytesAt(join(this.directory,entry.relativePath));
    if (hash(bytes) !== entry.sha256 || bytes.length !== entry.bytes) throw Error('Dataset asset checksum changed. Re-ingest the verified source.');
    validateContent(bytes,entry.format);
    if(licensePolicy && entry.license.status==='unknown' && (await this.settings()).verifyLicenses) throw Error('License unknown. Supply license evidence or disable project license verification under user responsibility.');
    if (entry.license.textPath) {
      const license = await bytesAt(join(this.directory,entry.license.textPath),256*1024);
      if (hash(license) !== entry.license.sha256) throw Error('Dataset license checksum changed.');
    }
    return bytes;
  }
  async settings(changes = {}) { await this.ensure(); return communitySettings(this.directory,changes); }
  describe(entry) { return {...entry,...originalCommunityIdentity(entry),path:join(this.directory,entry.relativePath),importMode:importMode(entry.format)}; }
  async search({query='',kind,order,limit=32,offset=0,previews=true,assetIds,additionalMatches} = {}) {
    if (typeof query !== 'string' || query.length > 512 || (order !== undefined && order !== 'library') || (kind && !KINDS.includes(kind)) || !Number.isInteger(limit) || limit<1 || limit>100 || !Number.isInteger(offset) || offset<0) throw Error('Invalid dataset search parameters.');
    const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    const matches = (await this.index()).assets.filter(entry => (!assetIds || assetIds.has(entry.id)) && (!kind || entry.kind === kind) && terms.every(term =>
      [entry.name,entry.author,entry.kind,entry.format,...entry.tags,...(additionalMatches?.get(entry.id) || [])].join(' ').toLowerCase().includes(term)));
    // Rank the complete index before paging so browsing and searching agree.
    if (order === 'library') matches.sort((a,b) => Number(b.kind === 'ui-kit') - Number(a.kind === 'ui-kit') ||
      Number(Boolean(b.cover)) - Number(Boolean(a.cover)));
    const assets = [];
    for (const entry of matches.slice(offset,offset+limit)) {
      const result = this.describe(entry);
      try {
        const bytes = await this.verified(entry); result.available = true;
        if (previews && entry.cover) {
          try {
            const cover=await bytesAt(join(this.directory,entry.cover.relativePath),4*1024*1024);
            if(hash(cover)!==entry.cover.sha256 || cover.length!==entry.cover.bytes) throw Error('Original cover checksum changed.');
            validateCover(cover,entry.cover.format);
            result.coverDataUrl=`data:image/${['jpg','jpeg'].includes(entry.cover.format)?'jpeg':entry.cover.format};base64,${cover.toString('base64')}`;
          } catch(error) { result.coverError=error.message; }
        }
        if (previews && bytes.length <= 128*1024 && ['svg','png','jpg','jpeg','webp'].includes(entry.format)) {
          const mime = entry.format === 'svg' ? 'image/svg+xml' : ['jpg','jpeg'].includes(entry.format) ? 'image/jpeg' : `image/${entry.format}`;
          result.previewDataUrl = `data:${mime};base64,${bytes.toString('base64')}`;
        }
      } catch (error) { result.available = false; result.error = error.message; }
      assets.push(result);
    }
    return {schemaVersion:1,projectRoot:this.projectRoot,datasetPath:this.directory,total:matches.length,offset,assets};
  }
  async ingest(args, suppliedBytes) {
    const format = (args.format || extname(args.sourcePath || new URL(args.url).pathname).slice(1)).toLowerCase();
    const bytes = suppliedBytes || await bytesAt(args.sourcePath,formatLimit(format));
    validateContent(bytes,format);
    if (args.expectedSha256 && hash(bytes) !== args.expectedSha256) throw Error('Downloaded asset checksum does not match expectedSha256.');
    const licenseBytes = args.licensePath ? await bytesAt(args.licensePath,256*1024) : args.licenseText ? Buffer.from(text(args.licenseText,'license text',256*1024)) : null;
    if(licenseBytes && licenseBytes.length>256*1024) throw Error('License text exceeds its size limit.');
    const knownLicense=!!(licenseBytes && typeof args.licenseSpdx==='string' && args.licenseSpdx.trim() && !/^(?:unknown|noassertion)$/i.test(args.licenseSpdx.trim()));
    if ((await this.settings()).verifyLicenses && !knownLicense) throw Error('License verification requires a known license identifier and retained license text.');
    const cover=await this.cover(args);
    if (!KINDS.includes(args.kind)) throw Error('Invalid asset kind.');
    const digest = hash(bytes), licenseHash = licenseBytes ? hash(licenseBytes) : null,originalIdentity=originalCommunityIdentity(args);
    const entry = { id:hash(`${digest}:${args.sourceUrl}`).slice(0,24), name:text(args.name || basename(args.sourcePath || new URL(args.url).pathname),'name',200),
      kind:args.kind,format,...(args.downloadUrl && {downloadUrl:publicUrl(args.downloadUrl,'download URL')}),sourceUrl:publicUrl(args.sourceUrl),communityUrl:args.communityUrl ? publicUrl(args.communityUrl,'Community URL') : null,
      ...(args.downloadUrl && {download:{url:publicUrl(args.downloadUrl,'download URL'),requestedUrl:publicUrl(args.url,'requested download URL'),downloadedAt:new Date().toISOString()}}),
      ...originalIdentity,...(args.sourcePack && {sourcePack:sourcePackMetadata(args.sourcePack)}),
      author:text(args.author,'author',200),license:{status:knownLicense?'recorded':'unknown',responsibility:knownLicense?'license':'user',
        spdx:args.licenseSpdx ? text(args.licenseSpdx,'license identifier',100) : null,url:args.licenseUrl ? publicUrl(args.licenseUrl,'license URL') : null,
        textPath:licenseHash?`licenses/${licenseHash}.txt`:null,sha256:licenseHash},sha256:digest,bytes:bytes.length,relativePath:`assets/${digest}.${format}`,
      ...(cover && {cover:cover.metadata}),
      tags:(args.tags || []).slice(0,32).map(tag=>text(tag,'tag',80)),createdAt:new Date().toISOString() };
    if (entry.communityUrl && !/^https:\/\/www\.figma\.com\/community\/(?:file|plugin)\/\d+(?:\/|$)/.test(entry.communityUrl)) throw Error('Use an actual Figma Community file or plugin URL.');
    await this.ensure();
    return withLibraryLock(this.directory,async()=>{
      const index = await this.index();
      const existing = index.assets.find(asset=>asset.id === entry.id);
      if (existing) {
        await this.verified(existing,{licensePolicy:false});
        if(!entry.cover && existing.cover) entry.cover=existing.cover;
        if(existing.native) entry.native=existing.native;
        // The bytes are immutable; a second explicit ingestion can refresh attribution and search tags.
        entry.createdAt=existing.createdAt;
        index.assets=index.assets.filter(asset=>asset.id!==entry.id);
      }
      for (const [path,data] of [[entry.relativePath,bytes],...(licenseBytes?[[entry.license.textPath,licenseBytes]]:[]),...(cover?[[cover.metadata.relativePath,cover.bytes]]:[])]) {
        const target = join(this.directory,path);
        try { if (hash(await bytesAt(target)) !== hash(data)) throw Error('Existing dataset object checksum mismatch.'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; await atomicBytes(target,data); }
      }
      index.assets.push(entry);
      const serialized = JSON.stringify(index,null,2)+'\n';
      if (Buffer.byteLength(serialized) > INDEX_LIMIT) throw Error('Dataset index exceeds its size limit.');
      await atomicBytes(join(this.directory,'index.json'),serialized);
      return {...this.describe(entry),duplicate:!!existing};
    });
  }
  async fetchBytes(url, limit = LIMIT) {
    return (await fetchPublicBytes(url,{...this.network,limit})).bytes;
  }
  async cover(args) {
    if(args.coverUrl || args.coverPath) return this.loadCover(args);
    const page=args.coverPageUrl || args.communityUrl;
    if(!page) return null;
    if(!this.coverCache.has(page)) this.coverCache.set(page,this.loadCover(args));
    return this.coverCache.get(page);
  }
  async loadCover(args) {
    let bytes, sourceUrl=args.coverUrl, pageUrl=args.coverPageUrl || args.communityUrl, method='supplied-source';
    if (args.coverPath) {
      if(!sourceUrl) throw Error('A local original cover requires its source coverUrl.');
      bytes=await bytesAt(args.coverPath,4*1024*1024);
    } else if (sourceUrl) bytes=await this.fetchBytes(sourceUrl,4*1024*1024);
    else if (pageUrl) {
      method='page-og-image';
      try {
        const html=(await this.fetchBytes(pageUrl,2*1024*1024)).toString('utf8');
        for(const tag of html.matchAll(/<meta\s[^>]*>/gi)) {
          const attrs={};
          for(const attr of tag[0].matchAll(/([\w:-]+)\s*=\s*(["'])([\s\S]*?)\2/g)) attrs[attr[1].toLowerCase()]=attr[3];
          if((attrs.property || attrs.name)?.toLowerCase()==='og:image' && attrs.content) {
            const decoded=attrs.content.replace(/&(?:amp|quot|apos|#(\d+)|#x([a-f\d]+));/gi,(match,decimal,hex)=>
              decimal || hex ? String.fromCodePoint(parseInt(decimal || hex,hex?16:10)) : ({'&amp;':'&','&quot;':'"','&apos;':"'"}[match.toLowerCase()] || match));
            sourceUrl=new URL(decoded,pageUrl).href;break;
          }
        }
        if(!sourceUrl) return null;
        bytes=await this.fetchBytes(sourceUrl,4*1024*1024);
      } catch(error) {
        // Original covers are optional; blocked public pages never become invented thumbnails.
        return null;
      }
    } else return null;
    const format=coverFormat(bytes);
    if(!format) throw Error('Original cover must be a PNG, JPEG, WebP or AVIF image.');
    validateCover(bytes,format);
    const sha256=hash(bytes);
    return {bytes,metadata:{sourceUrl:publicHttpsUrl(sourceUrl,'cover URL').href,pageUrl:pageUrl?publicUrl(pageUrl,'cover page URL'):null,
      method,sha256,bytes:bytes.length,format,relativePath:`covers/${sha256}.${format}`,downloadedAt:new Date().toISOString()}};
  }
  async download(args) {
    const format=(args.format || extname(new URL(args.url).pathname).slice(1)).toLowerCase();
    const downloaded = await fetchPublicBytes(args.url,{...this.network,limit:formatLimit(format),timeoutMs:120000});
    const bytes=downloaded.bytes;
    let licenseText=args.licenseText;
    if(!licenseText && args.licenseUrl) {
      try { licenseText=(await this.fetchBytes(args.licenseUrl,256*1024)).toString('utf8'); }
      catch(error) { if((await this.settings()).verifyLicenses) throw error; }
    }
    return this.ingest({...args,format,licenseText,downloadUrl:downloaded.url},bytes);
  }
  async seed() {
    const revision='55782beff3a0133df79c417eb68f96e8f19e2404';
    const base=`https://raw.githubusercontent.com/lucide-icons/lucide/${revision}`;
    const licenseText=(await this.fetchBytes(`${base}/LICENSE`,256*1024)).toString('utf8');
    const names=['arrow-left','arrow-right','check','chevron-down','chevron-right','info','copy','download','external-link','file','folder','heart','house','image','layout-dashboard','mail','menu','plus','search','settings','star','trash','user','x'];
    const russian={search:'поиск',settings:'настройки',house:'дом главная',user:'пользователь профиль',heart:'сердце избранное',star:'звезда',file:'файл',folder:'папка',image:'изображение картинка',mail:'почта',menu:'меню',plus:'добавить',x:'закрыть',check:'галочка',download:'скачать',copy:'копировать',info:'информация', 'layout-dashboard':'панель', 'trash':'удалить корзина','arrow-left':'назад','arrow-right':'вперёд','chevron-down':'вниз','chevron-right':'вправо','external-link':'ссылка'};
    const assets=[];
    for (const name of names) assets.push(await this.download({url:`${base}/icons/${name}.svg`,name:`Lucide ${name}`,kind:'icon',
      sourceUrl:`https://github.com/lucide-icons/lucide/blob/${revision}/icons/${name}.svg`,communityUrl:'https://www.figma.com/community/plugin/939567362549682242/Lucide-Icons',
      author:'Lucide contributors; Feather contributors',licenseSpdx:'ISC AND MIT',licenseUrl:`${base}/LICENSE`,licenseText,tags:['lucide',...name.split('-'),...(russian[name] || '').split(' ')]}));
    return {pack:'lucide-essential',revision,count:assets.length,assets};
  }
  async get(id) {
    const entry=(await this.index()).assets.find(asset=>asset.id===id);
    if (!entry) throw Error('Asset not found in this project dataset.');
    const bytes=await this.verified(entry);
    return {entry:this.describe(entry),bytes};
  }
}

// Originals and attribution are global; project indexes contain references only.
export class CommunityDataset extends ProjectCommunityDataset {
  constructor(projectRoot, options = {}) {
    super(projectRoot,options);
    this.local = new ProjectCommunityDataset(projectRoot,options);
    this.directory = options.libraryRoot || join(stateRoot(),'library');
    this.migration = null;
  }
  async ensure() {
    if (!isAbsolute(this.projectRoot) || await realpath(this.projectRoot) !== this.projectRoot) throw Error('Use the canonical bound project directory.');
    await privateDirectory(this.directory);
    for (const name of ['assets','licenses','covers','native']) await privateDirectory(join(this.directory,name));
  }
  async settings(changes = {}) {
    const {scope: requestedScope='project',...update}=changes;
    if (!['global','project'].includes(requestedScope)) throw Error('Invalid library scope.');
    await this.ensure();
    const global = await communitySettings(this.directory);
    if (requestedScope === 'global') return communitySettings(this.directory,update);
    await this.local.ensure();
    return communitySettings(this.local.directory,update,global);
  }
  async migrate() {
    if (!this.migration) this.migration = this.migrateProject().catch(error=>{this.migration=null;throw error;});
    return this.migration;
  }
  async migrateProject() {
    const legacy = await this.local.index();
    if (!legacy.assets.length) return;
    await this.ensure();
    await withLibraryLock(this.directory,async()=>{
      const index=await super.index(); let changed=false;
      for (const entry of legacy.assets) {
        await this.local.verified(entry,{licensePolicy:false});
        for (const object of [{relativePath:entry.relativePath,sha256:entry.sha256,limit:DOCUMENT_LIMIT},
          ...(entry.license.textPath?[{relativePath:entry.license.textPath,sha256:entry.license.sha256,limit:256*1024}]:[]),
          ...(entry.cover?[{...entry.cover,limit:4*1024*1024}]:[])]) {
          const bytes=await safeBytes(join(this.local.directory,object.relativePath),object.limit);
          if(hash(bytes)!==object.sha256) throw Error('Legacy library object checksum changed.');
          await this.storeObject(object.relativePath,bytes);
        }
        if(!index.assets.some(asset=>asset.id===entry.id)) {index.assets.push(entry);changed=true;}
      }
      if(changed) await atomicBytes(join(this.directory,'index.json'),JSON.stringify(index,null,2)+'\n');
    });
    for(const entry of legacy.assets) await this.reference(entry.id,{migrated:true});
  }
  async storeObject(relativePath,bytes) {
    const path=join(this.directory,relativePath);
    try { if(hash(await safeBytes(path,DOCUMENT_LIMIT))!==hash(bytes)) throw Error('Existing library object checksum mismatch.'); }
    catch(error) {if(error.code!=='ENOENT') throw error;await atomicBytes(path,bytes);}
  }
  async reference(assetId,metadata={}) {
    await this.local.ensure();
    return withLibraryLock(this.local.directory,async()=>{
      const path=join(this.local.directory,'references.json');
      let index={schemaVersion:1,assets:[]};
      try {index=JSON.parse(await safeBytes(path,INDEX_LIMIT));} catch(error) {if(error.code!=='ENOENT') throw error;}
      if(index.schemaVersion!==1 || !Array.isArray(index.assets) || index.assets.some(item=>!/^[a-f0-9]{24}$/.test(item.assetId))) throw Error('Invalid project library references.');
      if(!index.assets.some(entry=>entry.assetId===assetId)) {
        index.assets.push({assetId,...metadata,linkedAt:new Date().toISOString()});
        await atomicBytes(path,JSON.stringify(index,null,2)+'\n');
      }
      return index;
    },'.references-lock');
  }
  async search(args={}) {
    const {scope: requestedScope='global',...query}=args;
    if(!['global','project'].includes(requestedScope)) throw Error('Invalid library scope.');
    await this.migrate();
    const additionalMatches=new Map();
    if(query.query) for(const entry of (await this.index()).assets) {
      if(!entry.native?.relativePath || !/^native\/[a-f0-9]{64}\.index\.json$/.test(entry.native.relativePath)) continue;
      try {
        const native=JSON.parse(await safeBytes(join(this.directory,entry.native.relativePath),64*1024*1024));
        if(native.sourceSha256===entry.sha256 && Array.isArray(native.pages)) additionalMatches.set(entry.id,native.pages.flatMap(page=>[page.name,...(page.names || [])]));
      } catch { /* Source search remains available when a derived index is damaged. */ }
    }
    if(requestedScope==='global') return {...await super.search({...query,additionalMatches}),scope:'global'};
    let refs={assets:[]};
    try {refs=JSON.parse(await safeBytes(join(this.local.directory,'references.json'),INDEX_LIMIT));} catch(error) {if(error.code!=='ENOENT') throw error;}
    const ids=new Set(refs.assets.map(item=>item.assetId));
    return {...await super.search({...query,assetIds:ids,additionalMatches}),scope:'project'};
  }
  async ingest(args,bytes) {
    await this.migrate();
    const result=await super.ingest(args,bytes);
    await this.reference(result.id);
    let conversion;
    if(['fig','op'].includes(result.format)) {try {const resource=await this.prepare(result.id);conversion=nativeResourceSummary(resource);} catch(error) {conversion={ready:false,error:error.message};}}
    return {...result,scope:'global',...(conversion && {conversion})};
  }
  async get(id) {await this.migrate();return super.get(id);}
  async recordNative(assetId,native) {
    return withLibraryLock(this.directory,async()=>{
      const index=await this.index();
      const entry=index.assets.find(item=>item.id===assetId);
      if(!entry) throw Error('Native source disappeared from the global library.');
      if(JSON.stringify(entry.native)===JSON.stringify(native)) return;
      entry.native=native;
      await atomicBytes(join(this.directory,'index.json'),JSON.stringify(index,null,2)+'\n');
    });
  }
  async prepare(assetId,options) {await this.migrate();return prepareLibraryAsset(this,assetId,options);}
  async inspect(args) {await this.migrate();return inspectLibraryAsset(this,args);}
}

export async function dispatchCommunityTool(controller,name,args={}) {
  if (!controller.project?.projectRoot) throw Error('Open this project’s managed canvas first.');
  const dataset = new CommunityDataset(controller.project.projectRoot,controller.options?.community || {});
  if (name === 'canvas_community_settings') return dataset.settings(args);
  if (name === 'canvas_community_search') return dataset.search(args);
  if (name === 'canvas_community_ingest') return dataset.ingest(args);
  if (name === 'canvas_community_download') return dataset.download(args);
  if (name === 'canvas_community_prepare') return nativeResourceSummary(await dataset.prepare(args.assetId),{includePages:true});
  if (name === 'canvas_community_inspect') return dataset.inspect(args);
  if (name === 'canvas_community_seed') return dataset.seed();
  if (name !== 'canvas_community_import') throw Error('Unknown Community operation.');
  let {entry,bytes} = await dataset.get(args.assetId);
  await dataset.reference(entry.id);
  if(entry.format==='fig') {const converted=await dataset.prepare(entry.id);return {asset:entry,...await importProjectDocument(controller,resourceImportArguments(controller,entry,converted.path,args.docJson)),conversion:nativeResourceSummary(converted)};}
  if (entry.importMode === 'document') return {asset:entry,...await importProjectDocument(controller,resourceImportArguments(controller,entry,entry.path,args.docJson))};
  if (entry.importMode === 'image') {
    rejectLeasedTarget(controller,args.nodeId);
    const imported=await importCanvasImage(controller.session,{...args,filePath:entry.path});
    controller.persistence?.changed(); return {asset:entry,...imported};
  }
  const before = await controller.session.document();
  const document=liveDocument(before.document), page=document.pages?.length ? document.pages[before.activePageIndex] : document;
  if (!Number.isSafeInteger(args.expectedVersion) || args.expectedVersion !== before.version || !args.pageId || args.pageId !== (document.pages?.length ? page?.id : '0')) throw Error('Read the current canvas page and version before importing vectors.');
  if (args.parentId) {
    rejectLeasedTarget(controller,args.parentId);
    const stack=[...(page.children || [])]; let parent;
    while (stack.length) { const item=stack.pop(); if(item.id===args.parentId) parent=item; stack.push(...(item.children || [])); }
    if (!parent || !['frame','group'].includes(parent.type)) throw Error('SVG parent must be an existing frame or group on the current page.');
  }
  for (const axis of ['x','y']) if(args[axis] !== undefined && (!Number.isInteger(args[axis]) || Math.abs(args[axis])>2147483647)) throw Error('Invalid SVG position.');
  const reply=await controller.session.forward({jsonrpc:'2.0',id:'community-import-svg',method:'tools/call',params:{name:'import_svg',arguments:{svg:bytes.toString('utf8'),pageId:args.pageId,...(args.parentId && {parent:args.parentId}),x:args.x || 0,y:args.y || 0}}});
  if (reply?.error || !reply?.result || reply.result.isError) throw Error('SVG import not confirmed. Inspect the canvas before another attempt; no retry was made.');
  const after=await controller.session.document();
  if(after.version<=before.version) throw Error('SVG import did not advance the canvas revision. Inspect before retrying.');
  controller.persistence?.changed();
  return {asset:entry,imported:true,editable:true,version:after.version,saved:false};
}

function resourceImportArguments(controller,entry,path,docJson) {
  const stem=entry.name.replace(/[\/\\\u0000-\u001f]/g,'-').replace(/\.(fig|op)$/i,'').replace(/^\.+/,'').slice(0,120) || 'Resource';
  return {sourcePath:path,filePath:join(controller.project.projectRoot,`${stem}-${randomUUID().slice(0,8)}.op`),name:entry.name,...(docJson!==undefined && {docJson})};
}

function rejectLeasedTarget(controller,targetId) {
  // Ownership remains with the assigned agents until their work is released.
  if (targetId && controller.agents?.status().agents?.length) throw Error('Release active agent assignments before importing into existing nodes.');
}

export async function communityAssetFile(controller,{assetId}={}) {
  if (!controller.project?.projectRoot) throw Error('Open this project’s managed canvas first.');
  const {entry,bytes}=await new CommunityDataset(controller.project.projectRoot,controller.options?.community || {}).get(assetId);
  if (entry.format !== 'fig') throw Error('This App transport accepts only a Figma .fig dataset asset.');
  const name=entry.name.replace(/[\/\\\u0000-\u001f]/g,'-').replace(/\.fig$/i,'')+'.fig';
  const value={assetId:entry.id,name,format:'fig',bytes:bytes.length,sha256:entry.sha256};
  return {content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value,
    _meta:{communityFile:{...value,mimeType:'application/octet-stream',body:bytes.toString('base64')}}};
}
