import test from 'node:test';
import assert from 'node:assert/strict';
import {documentFontRequirements,fontRequirementSummary,RUSSIAN_CODEPOINTS} from '../plugins/openpencil/scripts/font-document.mjs';
test('scans every page, inherited typography, styled runs and component overrides without changing nodes',()=>{
  const doc={variables:{family:{type:'string',value:[{value:'Inter'},{value:'Golos Text'}]},bold:{type:'number',value:700}},pages:[
    {id:'first',children:[{id:'parent',type:'frame',fontFamily:'$family',children:[{id:'label',type:'text',content:[{text:'Привет Ёж',fontWeight:'$bold'},{text:'Italic',fontFamily:'Manrope',fontStyle:'italic'}]}]}]},
    {id:'last',children:[{id:'ref',type:'ref',ref:'parent',descendants:{label:{fontFamily:'Onest'}}}]}
  ]};const before=JSON.stringify(doc),plan=documentFontRequirements(doc),byName=Object.fromEntries(plan.requirements.map(item=>[item.family,item]));
  assert.equal(JSON.stringify(doc),before);assert.deepEqual(byName.Inter.weights,[400,700]);
  assert.ok(byName.Inter.codepoints.includes('Ё'.codePointAt(0)));assert.ok(byName['Golos Text']);
  assert.deepEqual(byName.Manrope.styles,['italic']);assert.ok(byName.Onest.codepoints.includes('П'.codePointAt(0)));
  assert.equal(byName['Noto Sans'].codepoints.length,66);assert.equal(RUSSIAN_CODEPOINTS.length,66);
  assert.ok(!JSON.stringify(fontRequirementSummary(plan)).includes('Привет'));
});
test('cycles/unresolved variables do not turn into guessed download names; generic CSS stacks are skipped',()=>{
  const d={variables:{a:{value:'$b'},b:{value:'$a'}},children:[{type:'text',id:'a',fontFamily:'$a',content:'x'},
    {type:'text',id:'b',fontFamily:'"Inter", system-ui, sans-serif',fontWeight:'semi-bold',content:'a'}]};
  const plan=documentFontRequirements(d,{fallback:false});assert.equal(plan.requirements.length,1);assert.equal(plan.requirements[0].family,'Inter');
  assert.deepEqual(plan.requirements[0].weights,[600]);assert.ok(plan.unresolvedVariables.includes('$a'));
});
test('fingerprint coalesces equivalent text coverage and catches newly used Cyrillic or faces',()=>{
  const d={children:[{type:'text',id:'x',content:'abc',fontFamily:'Inter'}]};
  const a=documentFontRequirements(d).fingerprint;d.children[0].content='cbab';assert.equal(documentFontRequirements(d).fingerprint,a);
  d.children[0].fontStyle='italic';assert.notEqual(documentFontRequirements(d).fingerprint,a);
  d.children[0].fontStyle='normal';d.children[0].content+='Я';assert.notEqual(documentFontRequirements(d).fingerprint,a);
});
test('nonprinting controls and variation selectors are not falsely reported as missing font glyphs',()=>{
  const p=documentFontRequirements({children:[{type:'text',id:'x',fontFamily:'Inter',content:'Ё\n\u2028\u200d\ufe0f'}]},{fallback:false});
  assert.deepEqual(p.requirements[0].codepoints,['Ё'.codePointAt(0)]);
});
