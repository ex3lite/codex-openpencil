import { join } from 'node:path';
import { FontLibrary } from './font-library.mjs';
import { documentFontRequirements, fontRequirementSummary, RUSSIAN_CODEPOINTS } from './font-document.mjs';
import { CommunityDataset } from './community-assets.mjs';
import { nativeFontHttp } from './native-document-http.mjs';
import { privateDirectory, atomicBytes, safeBytes } from './library-storage.mjs';
import { MAX_FONT_BYTES } from './font-file.mjs';
import { sha256 } from './editor-runtime.mjs';

function publicResult(result) {
  return {totalFamilies:result.totalFamilies,ready:result.ready,partial:result.partial,unavailable:result.unavailable,disabled:result.disabled,
    families:result.families.map(f=>({family:f.family,status:f.status,error:f.error,missingFaces:f.missingFaces,nearestFaces:f.nearestFaces,weightMismatches:f.weightMismatches,
      missingCodepoints:f.missingCodepoints?.slice(0,64),missingCodepointCount:f.missingCodepointCount,
      faces:f.faces.map(({family,style,weight,weightMin,weightMax,sourceWeight,weightMismatch,sha256,bytes,sourceUrl,sourceCommit,license})=>({family,style,weight,weightMin,weightMax,sourceWeight,weightMismatch,sha256,bytes,sourceUrl,sourceCommit,license}))}))};
}
const nativeSummary=native=>({generation:native.generation,faces:native.faces.length,cyrillicReady:native.faces.some(face=>face.cyrillic===true||face.cyrillicSupported===true),browser:native.browser});
function explicitPlan({families,weights=[400],styles=['normal'],cyrillic=true}) {
  if(!Array.isArray(families) || families.length<1 || families.length>64 || families.some(f=>typeof f!=='string'||!f.trim()||f.length>128))throw Error('Supply 1–64 exact font family names.');
  if(typeof cyrillic!=='boolean')throw Error('cyrillic must be a boolean.');
  const requirements=families.map(family=>({family:family.trim(),weights,styles,codepoints:cyrillic?RUSSIAN_CODEPOINTS:[],runCount:0}));
  return {requirements,fingerprint:sha256(JSON.stringify(requirements)),unresolvedVariables:[]};
}

export class CanvasFonts {
  constructor(controller) {
    this.controller=controller;this.closed=false;this.epoch=0;this.current={status:'idle'};
    const options=controller.options.fonts || {};
    this.library=options.library || new FontLibrary({...(controller.options.community?.libraryRoot&&{directory:join(controller.options.community.libraryRoot,'fonts')}),...options});
  }
  same(session,documentId,epoch) {return !this.closed&&this.controller.session===session&&this.controller.documentId===documentId&&this.epoch===epoch;}
  attach() {
    this.epoch++;this.capability=undefined;this.fingerprint=null;this.current={status:'checking'};
    this.schedule();
  }
  async manifest(session=this.controller.session) {
    if(!session)throw Error('Open a managed canvas first.');
    const response=await nativeFontHttp(session.port,{token:session.token});
    if(response.status===404)return null;
    const data=await response.json();
    return response.ok&&data.ok===true&&Array.isArray(data.faces)&&Number.isSafeInteger(data.generation)?data:null;
  }
  async supported(session) {
    if(this.controller.options.fonts===false)return false;
    if(this.capability===undefined)this.capability=Boolean(await this.manifest(session));
    return this.capability;
  }
  schedule(document,{force=false}={}) {
    if(this.closed || this.controller.options.fonts===false)return;
    const task=this.request({document,force}).catch(error=>{if(!this.closed)this.current={...this.current,status:'error',error:error.message};});
    this.lastTask=task;
  }
  async request({document,families,weights,styles,cyrillic,force=false}={}) {
    const session=this.controller.session,documentId=this.controller.documentId,epoch=this.epoch;
    if(!session)return {status:'idle'};
    if(!await this.supported(session))return this.current={status:'unsupported',error:'Update the local runtime to enable font registration.'};
    if(!this.same(session,documentId,epoch))return this.current;
    if(!document&&!families)document=(await session.document()).document;
    const plan=families?explicitPlan({families,weights,styles,cyrillic}):documentFontRequirements(document);
    const register=true;
    if(register&&plan.fingerprint===this.fingerprint&&this.active)return this.active;
    if(!force&&register&&plan.fingerprint===this.fingerprint&&['ready','partial','disabled'].includes(this.current.status))return this.current;
    if(register)this.fingerprint=plan.fingerprint;
    const previous=this.active || Promise.resolve();
    const task=previous.catch(()=>{}).then(async()=>{
      if(!this.same(session,documentId,epoch))return this.current;
      if(!families&&plan.fingerprint!==this.fingerprint)return this.current;
      this.current={status:'loading',requirements:fontRequirementSummary(plan)};
      const settings=await new CommunityDataset(this.controller.project.projectRoot,this.controller.options.community || {}).settings();
      const result=await this.library.ensure(plan.requirements,settings);
      if(!this.same(session,documentId,epoch))return this.current;
      const summary=publicResult(result);
      let native=await this.manifest(session);
      if(!native)throw Error('The runtime font endpoint is unavailable.');
      if(register) {
        const known=new Set(native.faces.map(face=>face.sha256));
        for(const family of result.families)for(const face of family.faces) {
          if(known.has(face.sha256))continue;
          if(!this.same(session,documentId,epoch))return this.current;
          const bytes=await safeBytes(face.path,MAX_FONT_BYTES);
          if(sha256(bytes)!==face.sha256)throw Error('Cached font checksum changed before registration.');
          const response=await nativeFontHttp(session.port,{method:'POST',token:session.token,body:JSON.stringify({fonts:[{dataBase64:bytes.toString('base64')}]})});
          const acknowledged=await response.json();
          if(!response.ok||acknowledged.ok!==true||!acknowledged.faces?.some(item=>item.sha256===face.sha256))throw Error('Font registration was not confirmed; no automatic retry was made.');
          native=acknowledged;known.add(face.sha256);
        }
      }
      if(!this.same(session,documentId,epoch))return this.current;
      this.current={status:result.disabled?'disabled':result.partial||result.unavailable||plan.unresolvedVariables.length?'partial':'ready',requirements:fontRequirementSummary(plan),...summary,native:nativeSummary(native),scope:'document'};
      const directory=join(this.controller.project.directory,'fonts');await privateDirectory(directory);
      await atomicBytes(join(directory,`${documentId}.json`),JSON.stringify({schemaVersion:1,...this.current})+'\n');
      return this.current;
    });
    this.active=task;
    try{return await task;}finally{if(this.active===task)this.active=null;}
  }
  async status() {
    const status={...this.current};
    if(this.capability && !this.closed) {
      const native=await this.manifest();
      if(native)status.native=nativeSummary(native);
    }
    return status;
  }
  async prepare(args={}) {
    await this.lastTask;
    return this.request({...args,force:true});
  }
  async readyForPreview() {await this.lastTask;return this.request();}
  async acquireResource(resourcePath) {
    await this.lastTask;
    if(!await this.supported(this.controller.session))return {status:'unsupported'};
    const plan=documentFontRequirements(JSON.parse(await safeBytes(resourcePath,1024*1024*1024)));
    const settings=await new CommunityDataset(this.controller.project.projectRoot,this.controller.options.community || {}).settings();
    const result=await this.library.ensure(plan.requirements,settings);
    return {...publicResult(result),requirements:fontRequirementSummary(plan),scope:'library'};
  }
  async list(args) {return this.library.list(args);}
  close() {this.closed=true;this.epoch++;}
}

const schema=properties=>({type:'object',properties,additionalProperties:false});
export const fontTools=[
  {name:'canvas_fonts_status',description:'Inspect auto-detected font requirements and actual native/browser registration for this exact project canvas. Summaries only; no text content or binary fonts are added to model context.',inputSchema:schema({}),annotations:{readOnlyHint:true,openWorldHint:false}},
  {name:'canvas_fonts_prepare',description:'Automatically scan all pages of this canvas and acquire missing open fonts into the shared library, then register the exact bytes in native previews and CanvasKit. Or supply exact families chosen by the agent; this does not change text layers or embed font files into the project. Reuses the global offline cache and existing autonomy/license settings. Check status for missing/proprietary families and browser readiness.',inputSchema:schema({families:{type:'array',items:{type:'string'},minItems:1,maxItems:64},weights:{type:'array',items:{type:'integer',minimum:1,maximum:1000}},styles:{type:'array',items:{type:'string',enum:['normal','italic']}},cyrillic:{type:'boolean',description:'Require all Russian letters for explicitly selected families; default true.'}}),annotations:{destructiveHint:false,openWorldHint:true}},
  {name:'canvas_fonts_library',description:'List globally cached font families, sources and licenses across projects. Does not download fonts or expose binary data. Use canvas_fonts_prepare with selected family names to acquire and connect fonts when needed.',inputSchema:schema({offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:64}}),annotations:{readOnlyHint:true,openWorldHint:false}}
];
