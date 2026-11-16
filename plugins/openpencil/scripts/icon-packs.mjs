import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { join } from 'node:path';
import { CommunityDataset, validateContent } from './community-assets.mjs';
import { fetchPublicBytes, publicHttpsUrl } from './community-network.mjs';
import { atomicBytes, privateDirectory, safeBytes, withLibraryLock } from './library-storage.mjs';

const MiB=1024*1024, MAX_FILES=50000, MAX_ARCHIVE=64*MiB, MAX_EXPANDED=128*MiB, MAX_FILE=4*MiB;
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const str={type:'string'}, idPattern=/^[a-z0-9][a-z0-9-]{0,79}$/;
const schema={id:str,name:str,communityUrl:str,author:str,repository:str,assetPrefix:str,licenseSpdx:str,licensePath:str,svgRoot:str,
  layout:{type:'string',enum:['style/radius/name','name']}};
export const COOLICONS_PRESET=Object.freeze({id:'coolicons',name:'Coolicons',
  communityUrl:'https://www.figma.com/community/file/800815864899415771/coolicons-1-700-free-icons',
  author:'Kryston Schwarze',repository:'krystonschwarze/coolicons',assetPrefix:'coolicons-',licenseSpdx:'MIT',licensePath:'LICENSE',svgRoot:'svg',layout:'style/radius/name'});
const tool=(name,description,properties={},required=[],readOnly=false)=>({name,description,
  inputSchema:{type:'object',properties,required,additionalProperties:false},annotations:{readOnlyHint:readOnly,destructiveHint:false,openWorldHint:!readOnly||name.endsWith('_check')},
  _meta:{ui:{visibility:['model','app']}}});
export const iconPackTools=[
  tool('canvas_icon_pack_list','List grouped global icon packs and the Coolicons basic preset. Returns counts and provenance, never thousands of icon names.',{previews:{type:'boolean'}},[],true),
  tool('canvas_icon_pack_acquire','Download the complete Coolicons basic preset or a discovered public GitHub SVG pack. Retains the original Figma Community file ID, upstream release, license, archive hash and original cover. No canvas edits. Custom manifest requires verified original author and license evidence; this tool does not discover websites.',
    {pack:{type:'string',enum:['coolicons']},manifest:{type:'object',properties:schema,required:Object.keys(schema),additionalProperties:false},coverUrl:{type:'string',description:'Original og:image URL read from this exact Community page, when direct page metadata is unavailable.'},coverPath:{type:'string',description:'Absolute path to the original cover obtained through an authorized browser download. Requires its original coverUrl; screenshots are not original covers.'}}),
  tool('canvas_icon_pack_search','Search an acquired global pack by icon name/category, style and radius. Bounded results default to line/regular; set allVariants to inspect every style. Returns keys for selection, no project or canvas edits.',
    {packId:str,query:str,style:str,radius:str,allVariants:{type:'boolean'},limit:{type:'integer',minimum:1,maximum:32},offset:{type:'integer',minimum:0},previews:{type:'boolean'}},['packId'],true),
  tool('canvas_icon_pack_select','Materialize one checksum-verified editable SVG from the global pack into the ordinary Community library and link it to the current project. Then use canvas_community_import with current page/version. Retains pack revision and original Figma ID.',{packId:str,key:str},['packId','key']),
  tool('canvas_icon_pack_check','Check the official GitHub release for a newer source version without updating files or project copies.',{packId:str},['packId'],true),
  tool('canvas_icon_pack_update','Acquire the latest official release using expectedRevision as a compare-and-swap guard. Keeps previous immutable revisions and all selected project copies. Returns compact pack status.',{packId:str,expectedRevision:str},['packId','expectedRevision']),
];

function text(value,label,max=200) {
  if(typeof value!=='string'||!value.trim()||value.length>max||/[\u0000-\u001f]/.test(value))throw Error(`Invalid ${label}.`);
  return value.trim();
}
function archivePath(value,allowEmpty=false) {
  if(allowEmpty && value==='')return '';
  if(typeof value!=='string'||value.length>512||!value||value.startsWith('/')||/[\\:\u0000-\u001f]/.test(value)||value.split('/').some(p=>p==='.'||p==='..'||!p))throw Error('Unsafe archive path.');
  return value;
}
function definition(input) {
  if(!input||typeof input!=='object'||!idPattern.test(input.id))throw Error('Invalid pack ID.');
  const communityUrl=publicHttpsUrl(input.communityUrl).href;
  const originalCommunityId=communityUrl.match(/^https:\/\/www\.figma\.com\/community\/file\/(\d+)(?:\/|$)/)?.[1];
  if(!originalCommunityId)throw Error('Pack requires its original Figma Community file URL.');
  if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository)||input.repository.split('/').some(p=>p==='.'||p==='..'))throw Error('Invalid public GitHub repository.');
  if(!['style/radius/name','name'].includes(input.layout))throw Error('Unsupported SVG pack path layout.');
  return {id:input.id,name:text(input.name,'pack name'),communityUrl,originalCommunityId,author:text(input.author,'pack author'),
    repository:input.repository,assetPrefix:text(input.assetPrefix,'release asset prefix',100),licenseSpdx:text(input.licenseSpdx,'license identifier',100),
    licensePath:archivePath(input.licensePath),svgRoot:archivePath(input.svgRoot,true),layout:input.layout};
}

const crcTable=Array.from({length:256},(_,n)=>{for(let k=0;k<8;k++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
const crc32=bytes=>{let n=0xffffffff;for(const b of bytes)n=crcTable[(n^b)&255]^(n>>>8);return (n^0xffffffff)>>>0;};

// No archive path is written to disk. Validate every central/local header before bounded inflation.
export function readIconZip(bytes) {
  if(!Buffer.isBuffer(bytes)||bytes.length>MAX_ARCHIVE||bytes.length<22)throw Error('Invalid icon ZIP size.');
  let end=-1;
  for(let n=bytes.length-22;n>=Math.max(0,bytes.length-65557);n--)if(bytes.readUInt32LE(n)===0x06054b50 && n+22+bytes.readUInt16LE(n+20)===bytes.length){end=n;break;}
  if(end<0)throw Error('Invalid icon ZIP directory.');
  const count=bytes.readUInt16LE(end+10),size=bytes.readUInt32LE(end+12),start=bytes.readUInt32LE(end+16);
  if(bytes.readUInt16LE(end+4)||bytes.readUInt16LE(end+6)||bytes.readUInt16LE(end+8)!==count||count===65535||count>MAX_FILES||start+size!==end)throw Error('Unsupported or oversized icon ZIP directory.');
  const files=new Map(),seen=new Set(),ranges=[];let cursor=start,total=0;
  for(let n=0;n<count;n++) {
    if(cursor+46>end||bytes.readUInt32LE(cursor)!==0x02014b50)throw Error('Invalid ZIP entry.');
    const flags=bytes.readUInt16LE(cursor+8),method=bytes.readUInt16LE(cursor+10),crc=bytes.readUInt32LE(cursor+16),compressed=bytes.readUInt32LE(cursor+20),expanded=bytes.readUInt32LE(cursor+24);
    const nameSize=bytes.readUInt16LE(cursor+28),extra=bytes.readUInt16LE(cursor+30),comment=bytes.readUInt16LE(cursor+32),local=bytes.readUInt32LE(cursor+42),mode=bytes.readUInt32LE(cursor+38)>>>16;
    const next=cursor+46+nameSize+extra+comment;
    if(next>end||!nameSize||bytes.readUInt16LE(cursor+34)||flags&~(0x800|8|2|4)||![0,8].includes(method)||[compressed,expanded,local].includes(0xffffffff))throw Error('Unsupported ZIP entry encoding.');
    const raw=bytes.subarray(cursor+46,cursor+46+nameSize),name=raw.toString('utf8'),directory=name.endsWith('/');
    archivePath(directory?name.slice(0,-1):name);
    if(!Buffer.from(name).equals(raw)||seen.has(name)||((mode&0xf000)!==0 && (mode&0xf000)!==(directory?0x4000:0x8000)))throw Error('ZIP duplicate, symlink or special entry rejected.');
    seen.add(name);
    if(local+30>start||bytes.readUInt32LE(local)!==0x04034b50||bytes.readUInt16LE(local+6)!==flags||bytes.readUInt16LE(local+8)!==method)throw Error('ZIP local header mismatch.');
    const localNameSize=bytes.readUInt16LE(local+26),localExtra=bytes.readUInt16LE(local+28),dataStart=local+30+localNameSize+localExtra,dataEnd=dataStart+compressed;
    if(dataEnd>start||!bytes.subarray(local+30,local+30+localNameSize).equals(raw)||(!(flags&8)&&(bytes.readUInt32LE(local+14)!==crc||bytes.readUInt32LE(local+18)!==compressed||bytes.readUInt32LE(local+22)!==expanded)))throw Error('ZIP local entry mismatch.');
    ranges.push([local,dataEnd]);total+=expanded;
    if(expanded>MAX_FILE||total>MAX_EXPANDED||expanded>Math.max(1,compressed)*200)throw Error('ZIP expansion exceeds its size limit.');
    const value=method===0?bytes.subarray(dataStart,dataEnd):inflateRawSync(bytes.subarray(dataStart,dataEnd),{maxOutputLength:Math.max(1,expanded)});
    if(value.length!==expanded||crc32(value)!==crc)throw Error('ZIP entry checksum mismatch.');
    if(!directory)files.set(name,value);else if(expanded)throw Error('Invalid ZIP directory payload.');
    cursor=next;
  }
  ranges.sort((a,b)=>a[0]-b[0]);
  if(cursor!==end||ranges.some((range,n)=>n&&range[0]<ranges[n-1][1]))throw Error('ZIP overlapping entries or directory mismatch.');
  return files;
}

export class IconPackLibrary {
  constructor(dataset) {this.dataset=dataset;this.directory=join(dataset.directory,'packs');}
  async ensure() {await this.dataset.ensure();await privateDirectory(this.directory);await privateDirectory(join(this.directory,'objects'));await privateDirectory(join(this.directory,'revisions'));await privateDirectory(join(this.directory,'archives'));}
  async json(path,limit=16*MiB) {return JSON.parse(await safeBytes(path,limit));}
  async index() {
    await this.ensure();let value;
    try {value=await this.json(join(this.directory,'index.json'),MiB);}catch(error){if(error.code==='ENOENT')return {schemaVersion:1,packs:[]};throw error;}
    if(value.schemaVersion!==1||!Array.isArray(value.packs)||value.packs.length>1000)throw Error('Invalid icon pack index.');
    const ids=new Set();
    for(const p of value.packs){if(!idPattern.test(p.id)||ids.has(p.id)||!/^[a-f0-9]{64}$/.test(p.manifestSha256))throw Error('Invalid icon pack index entry.');ids.add(p.id);}
    return value;
  }
  async revision(packId) {
    if(!idPattern.test(packId))throw Error('Invalid pack ID.');
    const row=(await this.index()).packs.find(p=>p.id===packId);if(!row)throw Error('Acquire this icon pack first.');
    const bytes=await safeBytes(join(this.directory,'revisions',`${row.manifestSha256}.json`),16*MiB);
    if(digest(bytes)!==row.manifestSha256)throw Error('Icon pack manifest checksum changed.');
    const pack=JSON.parse(bytes);definition(pack.definition);
    if(pack.id!==packId||!Array.isArray(pack.files)||pack.files.length>MAX_FILES||!/^[a-f0-9]{64}$/.test(pack.archiveSha256)||!/^[a-f0-9]{64}$/.test(pack.licenseSha256))throw Error('Invalid stored icon pack revision.');
    const keys=new Set();
    for(const f of pack.files){if(typeof f.key!=='string'||keys.has(f.key)||!/^[a-f0-9]{64}$/.test(f.sha256)||!Number.isSafeInteger(f.bytes)||f.bytes<1||f.bytes>MAX_FILE)throw Error('Invalid stored icon pack file.');archivePath(f.path);keys.add(f.key);}
    return pack;
  }
  summary(pack) {
    const {files,licenseText,...value}=pack;
    return {...value,count:files.length,iconCount:new Set(files.map(f=>f.name)).size,
      styles:[...new Set(files.map(f=>f.style))],radii:[...new Set(files.map(f=>f.radius))]};
  }
  async list({previews=false}={}) {
    if(typeof previews!=='boolean')throw Error('Invalid pack preview option.');
    const rows=[];
    for(const p of (await this.index()).packs){try{
      const pack=await this.revision(p.id),row={...this.summary(pack),installed:true};
      if(previews&&pack.cover){
        try {
          if(!/^covers\/[a-f0-9]{64}\.(?:png|jpe?g|webp|avif)$/.test(pack.cover.relativePath))throw Error('Invalid original pack cover path.');
          const bytes=await safeBytes(join(this.dataset.directory,pack.cover.relativePath),4*MiB);
          if(digest(bytes)!==pack.cover.sha256||bytes.length!==pack.cover.bytes)throw Error('Original pack cover checksum changed.');
          row.coverDataUrl=`data:image/${['jpg','jpeg'].includes(pack.cover.format)?'jpeg':pack.cover.format};base64,${bytes.toString('base64')}`;
        }catch(error){row.coverError=error.message;}
      }
      rows.push(row);
    }catch(error){rows.push({id:p.id,installed:true,available:false,error:error.message});}}
    if(!rows.some(p=>p.id==='coolicons'))rows.unshift({...definition(COOLICONS_PRESET),installed:false,preset:true});
    return {scope:'global',packs:rows};
  }
  async fetch(url,limit=MAX_ARCHIVE) {return fetchPublicBytes(url,{...this.dataset.network,limit,timeoutMs:120000,accept:'application/vnd.github+json,application/zip,text/plain'});}
  async latest(def) {
    const {bytes}=await this.fetch(`https://api.github.com/repos/${def.repository}/releases/latest`,2*MiB);const r=JSON.parse(bytes);
    if(r.draft||r.prerelease||typeof r.tag_name!=='string'||!Array.isArray(r.assets)||r.assets.length>1000)throw Error('Invalid public GitHub release.');
    const revision=text(r.tag_name,'source release');
    const candidates=r.assets.filter(a=>typeof a.name==='string'&&a.name.startsWith(def.assetPrefix)&&a.name.endsWith('.zip'));
    if(candidates.length!==1)throw Error('Release must contain exactly one matching SVG ZIP asset.');
    const a=candidates[0],url=publicHttpsUrl(a.browser_download_url).href;
    if(!url.startsWith(`https://github.com/${def.repository}/releases/download/`)||!Number.isSafeInteger(a.size)||a.size<1||a.size>MAX_ARCHIVE)throw Error('Invalid official release archive.');
    return {revision,version:revision.replace(/^v/,''),url,bytes:a.size,publishedAt:r.published_at || null};
  }
  async acquire({pack,manifest,coverUrl,coverPath}={}) {
    if(coverPath&&!coverUrl)throw Error('A local original cover requires its source coverUrl.');
    if((pack&&manifest)||(!manifest&&pack&&pack!=='coolicons'))throw Error('Choose one icon preset or custom manifest.');
    const def=definition(manifest || COOLICONS_PRESET),existing=(await this.index()).packs.find(p=>p.id===def.id);
    if(existing) {
      const current=await this.revision(def.id);
      if(JSON.stringify(current.definition)!==JSON.stringify(def))throw Error('Pack ID already belongs to another source definition.');
      await this.archive(current.archiveSha256,undefined,current.archiveUrl,current.archiveBytes);
      if(coverUrl)return this.attachCover(def.id,coverUrl,coverPath);
      return {...this.summary(current),installed:true,cached:true};
    }
    return this.install(def,await this.latest(def),null,coverUrl,coverPath);
  }
  async install(def,release,expectedRevision,coverUrl,coverPath) {
    const archive=await this.fetch(release.url),archiveSha256=digest(archive.bytes);
    if(archive.bytes.length!==release.bytes)throw Error('Official archive size changed.');
    if(def.id==='coolicons'&&def.repository===COOLICONS_PRESET.repository&&release.revision==='v5.4.0'&&archiveSha256!=='af0002b4a0cfe66aa94e80b0623f5199ba7038db9fecffdcbc675855c4bbed46')throw Error('Pinned Coolicons archive checksum changed.');
    const entries=readIconZip(archive.bytes),licenseBytes=entries.get(def.licensePath);
    if(!licenseBytes||licenseBytes.length>256*1024)throw Error('Pack archive requires retained original license evidence.');
    const licenseText=licenseBytes.toString('utf8');
    if(!licenseText.trim()||/^(?:unknown|noassertion)$/i.test(def.licenseSpdx))throw Error('Supply a verified original upstream license identifier.');
    if(def.id==='coolicons'&&(!licenseText.includes('MIT License')||!licenseText.includes('Kryston Schwarze')))throw Error('Coolicons upstream MIT attribution mismatch.');
    const root=def.svgRoot?`${def.svgRoot}/`:'';const files=[];
    let categories=new Map();
    if(entries.has('manifest.json')) {
      const upstream=JSON.parse(entries.get('manifest.json'));
      if(Array.isArray(upstream.icons))categories=new Map(upstream.icons.filter(i=>typeof i.name==='string'&&typeof i.category==='string').map(i=>[i.name,i.category.slice(0,200)]));
    }
    for(const [path,bytes] of entries) {
      if(!path.startsWith(root)||!path.endsWith('.svg'))continue;
      const key=path.slice(root.length),parts=key.slice(0,-4).split('/');
      if((def.layout==='name'&&parts.length!==1)||(def.layout==='style/radius/name'&&parts.length!==3)||parts.some(p=>!/^[a-zA-Z0-9_-]+$/.test(p)))throw Error('SVG path does not match declared pack layout.');
      validateContent(bytes,'svg');const sha256=digest(bytes),name=parts.at(-1),style=parts.length===3?parts[0]:'default',radius=parts.length===3?parts[1]:'default';
      files.push({key,path,name,style,radius,category:categories.get(name)||'',sha256,bytes:bytes.length});
    }
    if(!files.length)throw Error('Archive contains no SVG icons in its declared root.');
    files.sort((a,b)=>a.key.localeCompare(b.key));
    let cover=expectedRevision?(await this.revision(def.id)).cover:null;
    try{const original=await this.dataset.cover({communityUrl:def.communityUrl,...(coverUrl&&{coverUrl}),...(coverPath&&{coverPath})});if(original){await this.dataset.storeObject(original.metadata.relativePath,original.bytes);cover=original.metadata;}}catch{/* Retain the previous original when its public page is unavailable. */}
    const value={schemaVersion:1,id:def.id,name:def.name,definition:def,originalCommunityId:def.originalCommunityId,communityUrl:def.communityUrl,
      sourceUrl:`https://github.com/${def.repository}`,author:def.author,revision:release.revision,version:release.version,publishedAt:release.publishedAt,
      archiveUrl:release.url,archiveSha256,archiveBytes:archive.bytes.length,licenseSpdx:def.licenseSpdx,licenseSha256:digest(licenseBytes),
      licenseText,licenseUrl:`https://github.com/${def.repository}/blob/${encodeURIComponent(release.revision)}/${def.licensePath}`,
      communityLicenseNote:def.id==='coolicons'?'SVGs acquired from the author’s MIT release. The Figma Community file separately lists CC BY 4.0.':null,
      cover,coverStatus:cover?'original':'unavailable',installedAt:new Date().toISOString(),files};
    const serialized=Buffer.from(JSON.stringify(value)),manifestSha256=digest(serialized);
    if(serialized.length>16*MiB)throw Error('Icon pack manifest exceeds its size limit.');
    await withLibraryLock(this.directory,async()=>{
      const index=await this.index(),current=index.packs.find(p=>p.id===def.id);
      const currentRevision=current?(await this.revision(def.id)).revision:null;
      if(currentRevision!==expectedRevision)throw Error('Icon pack revision changed; inspect it before retrying.');
      await this.archive(archiveSha256,archive.bytes);
      // The complete durable archive is authoritative; expand individual SVGs on demand.
      await this.object(value.licenseSha256,'txt',licenseBytes);
      await atomicBytes(join(this.directory,'revisions',`${manifestSha256}.json`),serialized);
      index.packs=index.packs.filter(p=>p.id!==def.id);index.packs.push({id:def.id,manifestSha256});
      await atomicBytes(join(this.directory,'index.json'),JSON.stringify(index)+'\n');
    },'.packs-lock');
    return {...this.summary(value),installed:true,cached:false};
  }
  async object(sha256,extension,bytes) {
    const path=join(this.directory,'objects',`${sha256}.${extension}`);
    try{if(digest(await safeBytes(path,MAX_FILE))!==sha256)throw Error('Icon pack object checksum changed.');}
    catch(error){if(error.code!=='ENOENT')throw error;await atomicBytes(path,bytes);}
  }
  async archive(sha256,bytes,url,expectedBytes) {
    if(!/^[a-f0-9]{64}$/.test(sha256))throw Error('Invalid original archive checksum.');
    const path=join(this.directory,'archives',`${sha256}.zip`);
    try {if(digest(await safeBytes(path,MAX_ARCHIVE))!==sha256)throw Error('Original pack archive checksum changed.');return;}
    catch(error){if(error.code!=='ENOENT')throw error;}
    if(!bytes)bytes=(await this.fetch(url)).bytes;
    if(bytes.length>MAX_ARCHIVE||digest(bytes)!==sha256||(expectedBytes!==undefined&&bytes.length!==expectedBytes))throw Error('Original pack archive bytes changed.');
    await atomicBytes(path,bytes);
  }
  async attachCover(packId,coverUrl,coverPath) {
    const before=await this.index(),entry=before.packs.find(row=>row.id===packId),pack=await this.revision(packId);
    const original=await this.dataset.cover({communityUrl:pack.communityUrl,coverUrl,...(coverPath&&{coverPath})});
    if(!original)throw Error('Original Community cover was unavailable.');
    await this.dataset.storeObject(original.metadata.relativePath,original.bytes);
    const value={...pack,cover:original.metadata,coverStatus:'original'},bytes=Buffer.from(JSON.stringify(value)),manifestSha256=digest(bytes);
    await withLibraryLock(this.directory,async()=>{
      const index=await this.index(),row=index.packs.find(item=>item.id===packId);
      if(row?.manifestSha256!==entry.manifestSha256)throw Error('Pack changed while acquiring its cover; inspect before retrying.');
      await atomicBytes(join(this.directory,'revisions',`${manifestSha256}.json`),bytes);row.manifestSha256=manifestSha256;
      await atomicBytes(join(this.directory,'index.json'),JSON.stringify(index)+'\n');
    },'.packs-lock');
    return {...this.summary(value),installed:true,cached:true};
  }
  async search({packId,query='',style,radius,allVariants=false,limit=24,offset=0,previews=false}={}) {
    if(typeof query!=='string'||query.length>512||!Number.isInteger(limit)||limit<1||limit>32||!Number.isInteger(offset)||offset<0||typeof allVariants!=='boolean'||typeof previews!=='boolean')throw Error('Invalid icon pack search parameters.');
    const pack=await this.revision(packId),terms=query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    const styles=new Set(pack.files.map(f=>f.style)),radii=new Set(pack.files.map(f=>f.radius));
    style=style || (!allVariants?(styles.has('line')?'line':styles.values().next().value):null);
    radius=radius || (!allVariants?(radii.has('regular')?'regular':radii.values().next().value):null);
    if(style&&!styles.has(style)||radius&&!radii.has(radius))throw Error('Unknown pack style or radius.');
    const matches=pack.files.filter(f=>(!style||f.style===style)&&(!radius||f.radius===radius)&&terms.every(t=>`${f.name} ${f.category}`.toLowerCase().includes(t)));
    const icons=[];
    for(const file of matches.slice(offset,offset+limit)) {
      const row={...file};
      if(previews){const bytes=await this.iconBytes(pack,file);if(bytes.length<=128*1024)row.previewDataUrl=`data:image/svg+xml;base64,${bytes.toString('base64')}`;}
      icons.push(row);
    }
    return {packId,revision:pack.revision,total:matches.length,offset,style,radius,icons};
  }
  async iconBytes(pack,file) {
    let bytes;
    try{bytes=await safeBytes(join(this.directory,'objects',`${file.sha256}.svg`),MAX_FILE);}
    catch(error){
      if(error.code!=='ENOENT')throw error;
      if(this.unpacked?.sha256!==pack.archiveSha256) {
        const archive=await safeBytes(join(this.directory,'archives',`${pack.archiveSha256}.zip`),MAX_ARCHIVE);
        if(archive.length!==pack.archiveBytes||digest(archive)!==pack.archiveSha256)throw Error('Original pack archive checksum changed.');
        this.unpacked={sha256:pack.archiveSha256,files:readIconZip(archive)};
      }
      bytes=this.unpacked.files.get(file.path);
      if(!bytes||digest(bytes)!==file.sha256||bytes.length!==file.bytes)throw Error('Archived icon SVG checksum changed.');
      validateContent(bytes,'svg');await this.object(file.sha256,'svg',bytes);
    }
    if(digest(bytes)!==file.sha256||bytes.length!==file.bytes)throw Error('Icon SVG checksum changed.');validateContent(bytes,'svg');return bytes;
  }
  async select({packId,key}={}) {
    const pack=await this.revision(packId),file=pack.files.find(f=>f.key===key);
    if(!file)throw Error('Search for an existing pack icon key first.');
    const bytes=await this.iconBytes(pack,file),license=await safeBytes(join(this.directory,'objects',`${pack.licenseSha256}.txt`),256*1024);
    if(digest(license)!==pack.licenseSha256)throw Error('Icon pack license checksum changed.');
    // Cover was acquired once for the group; do not refetch Community HTML for every selected icon.
    this.dataset.coverCache.set(pack.communityUrl,Promise.resolve(null));
    return this.dataset.ingest({format:'svg',name:`${pack.name} ${file.name} ${file.style} ${file.radius}`,kind:'icon',sourceUrl:`${pack.archiveUrl}#${file.path}`,
      communityUrl:pack.communityUrl,author:pack.author,licenseSpdx:pack.licenseSpdx,licenseUrl:pack.licenseUrl,licenseText:license.toString('utf8'),
      sourcePack:{id:packId,revision:pack.revision,key,originalCommunityId:pack.originalCommunityId,archiveSha256:pack.archiveSha256},
      tags:[packId,file.name,file.style,file.radius,...file.category.toLowerCase().split(/\s+/)].filter(Boolean)},bytes);
  }
  async check({packId}={}) {
    const pack=await this.revision(packId),latest=await this.latest(pack.definition);
    return {packId,originalCommunityId:pack.originalCommunityId,currentRevision:pack.revision,latestRevision:latest.revision,updateAvailable:pack.revision!==latest.revision,publishedAt:latest.publishedAt};
  }
  async update({packId,expectedRevision}={}) {
    const pack=await this.revision(packId);
    if(pack.revision!==expectedRevision)throw Error('Icon pack revision changed; inspect it before retrying.');
    const latest=await this.latest(pack.definition);
    if(pack.revision===latest.revision)return {...this.summary(pack),installed:true,cached:true};
    return this.install(pack.definition,latest,expectedRevision);
  }
}

export async function dispatchIconPackTool(controller,name,args={}) {
  if(!controller.project?.projectRoot)throw Error('Open this project’s managed canvas first.');
  const library=new IconPackLibrary(new CommunityDataset(controller.project.projectRoot,controller.options?.community || {}));
  const action={canvas_icon_pack_list:'list',canvas_icon_pack_acquire:'acquire',canvas_icon_pack_search:'search',canvas_icon_pack_select:'select',canvas_icon_pack_check:'check',canvas_icon_pack_update:'update'}[name];
  if(!action)throw Error('Unknown icon pack operation.');return library[action](args);
}
