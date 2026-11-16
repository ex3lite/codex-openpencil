import test from 'node:test';
import assert from 'node:assert/strict';
import {auditPrototype} from '../plugins/openpencil/scripts/prototype-audit.mjs';
test('static cover boards are not an authored prototype',()=>{
 const result=auditPrototype({children:[{id:'cover',type:'image'}]});
 assert.equal(result.issues[0].code,'NO_EXPLICIT_SCREENS');assert.equal(result.pages[0].images,1);
 assert.equal(result.capabilities.runtimeVerified,false);
});
test('instances inherit motion and their route overrides are audited',()=>{
 const doc={pages:[{id:'kit',children:[{id:'button',type:'frame',reusable:true,transition:{durationMs:120},events:{onTap:[{push:'"/missing"'}]}}]},
 {id:'ui',children:[{id:'home',type:'frame',screen:'/',children:[{id:'cta',type:'ref',ref:'button',descendants:{button:{events:{onTap:[{push:'"/next"'}]}}}}]}, {id:'next',type:'frame',screen:'/next'}]}]};
 const r=auditPrototype(doc);assert.equal(r.links.find(x=>x.nodeId==='cta').path,'/next');assert(r.motion.some(x=>x.nodeId==='cta'));assert.equal(r.issues.filter(x=>x.code==='MISSING_SCREEN').length,1);
});
test('duplicate routes and unwired screens are visible',()=>{
 const r=auditPrototype({children:[{id:'a',screen:'/'},{id:'b',screen:'/'}]});
 assert(r.issues.some(x=>x.code==='DUPLICATE_SCREEN'));assert(r.issues.some(x=>x.code==='NO_NAVIGATION'));
});

test('event-triggered animation is inventoried even without mount or transition',()=>{
 const r=auditPrototype({children:[{id:'cta',events:{onTap:[{animate:{target:'panel',property:'opacity',from:0,to:1,durationMs:160}}]}}]});
 assert.equal(r.motionCount,1);assert.equal(r.motion[0].eventAnimations[0].animate.target,'panel');
 assert.equal(r.motion[0].eventAnimations[0].event,'onTap');
});
