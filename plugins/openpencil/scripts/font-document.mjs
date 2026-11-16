import { createHash } from 'node:crypto';

export const RUSSIAN_CODEPOINTS = [...'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдеёжзийклмнопрстуфхцчшщъыьэюя'].map(c=>c.codePointAt(0)).sort((a,b)=>a-b);
const generic = new Set(['serif','sans-serif','monospace','system-ui','ui-sans-serif','ui-serif','ui-monospace','-apple-system','blinkmacsystemfont','cursive','fantasy']);
const keywords = {thin:100,extralight:200,ultralight:200,light:300,normal:400,regular:400,medium:500,semibold:600,demibold:600,bold:700,extrabold:800,ultrabold:800,black:900,heavy:900};
const needsGlyph=cp=>cp>=32&&!(cp>=127&&cp<=159)&&!(cp>=0x200b&&cp<=0x200f)&&!(cp>=0x2028&&cp<=0x202e)&&!(cp>=0x2060&&cp<=0x206f)&&!(cp>=0xfe00&&cp<=0xfe0f)&&!(cp>=0xe0100&&cp<=0xe01ef);
function families(value) {
  if(typeof value!=='string') return [];
  return [...value.matchAll(/(?:"([^"]+)"|'([^']+)'|([^,]+))/g)]
    .map(match=>(match[1] || match[2] || match[3]).trim())
    .filter(name=>name && name.length<=128 && !generic.has(name.toLowerCase()) && !/[\u0000-\u001f]/.test(name));
}
function weight(value) {
  if(typeof value==='number' && Number.isFinite(value)) return Math.max(1,Math.min(1000,Math.round(value)));
  const key=String(value??'normal').toLowerCase().replace(/[\s_-]/g,'');
  return /^\d+$/.test(key)?weight(Number(key)):(keywords[key] || 400);
}
// Only schema font/content fields are inspected; arbitrary text is never scanned
// for URLs or interpreted as instructions, nor returned in the public summary.
export function documentFontRequirements(document,{fallback=true}={}) {
  const requirements=new Map(),unresolved=new Set(),index=new Map();let textRuns=0;
  const variables=document.variables || {};
  function values(value,seen=new Set()) {
    if(typeof value!=='string' || !value.startsWith('$')) return [value];
    const key=value.slice(1);
    if(seen.has(key) || !Object.hasOwn(variables,key)) {unresolved.add(value);return [];}
    const next=new Set(seen);next.add(key);
    const definition=variables[key],raw=definition?.value??definition;
    return (Array.isArray(raw)?raw.map(item=>item?.value):[raw]).flatMap(item=>values(item,next));
  }
  function add(style,text,defaultFamily='Roboto') {
    textRuns++;
    const familyValues=values(style.fontFamily??defaultFamily);
    const weights=values(style.fontWeight??400).map(weight),styles=values(style.fontStyle??'normal').map(s=>s==='italic'?'italic':'normal');
    for(const authored of familyValues) for(const family of families(authored)) {
      if(family.startsWith('$')) {unresolved.add(family);continue;}
      const key=family.toLowerCase();let item=requirements.get(key);
      if(!item){item={family,weights:new Set(),styles:new Set(),codepoints:new Set(),runCount:0};requirements.set(key,item);}
      weights.forEach(value=>item.weights.add(value));styles.forEach(value=>item.styles.add(value));item.runCount++;
      if(typeof text==='string') for(const character of text) {
        const cp=character.codePointAt(0);if(needsGlyph(cp))item.codepoints.add(cp);
      }
    }
  }
  function content(node,inherited) {
    const style={...inherited,...Object.fromEntries(['fontFamily','fontWeight','fontStyle'].filter(key=>node[key]!==undefined).map(key=>[key,node[key]]))};
    if(typeof node.content==='string') add(style,node.content);
    else if(Array.isArray(node.content)) {for(const run of node.content) if(run && typeof run.text==='string') add({...style,...run},run.text);}
    else if(node.type==='text' || node.fontFamily!==undefined) add(style,'');
    if(node.type==='text_input' || node.type==='textInput') add(style,[node.placeholder,node.value].filter(v=>typeof v==='string').join(''));
    return style;
  }
  const roots=[...(document.children || []),...(document.pages || []).flatMap(page=>page.children || [])];
  const stack=roots.map(node=>({node,inherited:{}}));
  while(stack.length) {
    const {node,inherited}=stack.pop();if(!node || typeof node!=='object')continue;
    const style=content(node,inherited);if(typeof node.id==='string')index.set(node.id,{node,style});
    if(Array.isArray(node.children)) for(const child of node.children)stack.push({node:child,inherited:style});
  }
  // Ref descendant overrides are partial nodes; borrow the original text and
  // inherited style so font-only overrides are not missed on another page.
  for(const {node,style} of index.values()) {
    if(node.type==='ref' && node.descendants && typeof node.descendants==='object') {
      for(const [id,override] of Object.entries(node.descendants)) {
        if(!override || typeof override!=='object')continue;
        const target=index.get(id) || index.get(id.split('/').at(-1));
        content({...target?.node,...override},target?.style || style);
      }
    }
    for(const override of Object.values(node.states || {})) if(override && typeof override==='object') content({...node,...override},style);
  }
  if(fallback && (requirements.size || textRuns)) {
    add({fontFamily:'Noto Sans',fontWeight:400},String.fromCodePoint(...RUSSIAN_CODEPOINTS));
    const item=requirements.get('noto sans');item.weights.add(700);item.styles.add('italic');item.fallback=true;
  }
  const array=[...requirements.values()].map(item=>({...item,weights:[...item.weights].sort((a,b)=>a-b),styles:[...item.styles].sort(),codepoints:[...item.codepoints].sort((a,b)=>a-b)})).sort((a,b)=>a.family.localeCompare(b.family));
  const fingerprint=createHash('sha256').update(JSON.stringify(array.map(({runCount,...rest})=>rest))).digest('hex');
  return {requirements:array,fingerprint,unresolvedVariables:[...unresolved].sort()};
}
export function fontRequirementSummary(plan) {
  return {fingerprint:plan.fingerprint,total:plan.requirements.length,unresolvedVariables:plan.unresolvedVariables,
    families:plan.requirements.map(({family,weights,styles,runCount,codepoints,fallback})=>({family,weights,styles,runCount,codepointCount:codepoints.length,cyrillicUsed:codepoints.some(cp=>cp>=0x400&&cp<=0x52f),...(fallback&&{fallback:true})}))};
}
