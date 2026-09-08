#!/usr/bin/env node
// End-to-end study checks use actual node positions, projected geometry, rendered
// locator elements and renderer calls. State flags alone cannot prove these flows.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const port=Number(process.env.STUDY_TEST_PORT||8801),base=`http://127.0.0.1:${port}`;
const server=spawn(process.execPath,[path.join(root,'scripts/serve.mjs'),'--root',path.join(root,'site')],{env:{...process.env,PORT:String(port)},stdio:['ignore','pipe','pipe']});
let browser;
const distance=(a,b)=>Math.hypot(...a.map((x,i)=>x-b[i]));
try {
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('test server timeout')),10000);server.stdout.on('data',d=>{if(String(d).includes('ready')){clearTimeout(timer);resolve();}});server.on('exit',c=>{clearTimeout(timer);reject(Error('test server exit '+c));});});
 browser=await chromium.launch({args:process.env.ARMOR_TEST_METAL==='1'?['--use-angle=metal']:[]});
 const page=await browser.newPage({viewport:{width:1440,height:900},reducedMotion:'reduce',deviceScaleFactor:2});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 page.on('response',r=>{if(r.status()>=400&&!r.url().includes('favicon'))errors.push(r.status()+' '+r.url());});
 const settle=async()=>{await page.waitForFunction(()=>window.__ready===true && !window.__performance().pending,null,{timeout:60000});await page.waitForTimeout(100);};
 const stage=async n=>{await page.locator(`[data-stage="${n}"]`).click();await settle();return page.evaluate(()=>__studyParts());};
 for(const model of ['hulkbuster','ironman','samurai']){
  await page.goto(`${base}/?model=${model}&quality=balanced`);await settle();
  const before=await page.evaluate(()=>__performance().frames);await page.waitForTimeout(900);
  assert.equal(await page.evaluate(()=>__performance().frames),before,model+' redraws while idle');
  await page.getByRole('button',{name:'Inspect center chest',exact:true}).click();await settle();
  const assembled=await stage(0);
  assert(assembled.some((p,i)=>assembled.slice(i+1).some(q=>Math.min(p.bounds.right,q.bounds.right)-Math.max(p.bounds.left,q.bounds.left)>1&&Math.min(p.bounds.bottom,q.bounds.bottom)-Math.max(p.bounds.top,q.bounds.top)>1)),model+' projection overlap control did not detect assembled geometry');
  assert(assembled.every(p=>distance(p.position,p.base)<1e-5),model+' stage 0 changed original positions');
  const big=await stage(1);
  assert(big.filter(p=>!p.large).every(p=>distance(p.position,p.base)<1e-5),model+' stage 1 moved details too early');
  assert(big.some(p=>p.large&&distance(p.position,p.base)>1e-3),model+' large pieces did not separate');
  const all=await stage(2);
  for(let i=0;i<all.length;i++)for(let j=i+1;j<all.length;j++){
   const a=all[i].bounds,b=all[j].bounds;
   const w=Math.min(a.right,b.right)-Math.max(a.left,b.left),h=Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top);
   assert(!(w>1&&h>1),`${model} projected parts overlap: ${all[i].node}/${all[j].node}`);
  }
  assert(all.every(p=>distance(p.position,p.target)<1e-5),model+' stage 2 incomplete');
  await page.getByRole('button',{name:'Next part',exact:true}).click();await settle();
  const focused=await page.evaluate(()=>__studyParts().find(p=>p.index===__state.focus));
  const located=await page.locator('#locator .located').getAttribute('data-node');assert.equal(Number(located),focused.node,model+' locator does not point at focused node');
  await page.locator('#insOrigin').click();await page.keyboard.down('Space');await settle();
  assert((await page.evaluate(()=>__studyParts())).every(p=>distance(p.position,p.base)<1e-5),model+' origin hold did not restore geometry');
  await page.keyboard.up('Space');await settle();
  assert((await page.evaluate(()=>__studyParts())).every(p=>distance(p.position,p.target)<1e-5),model+' release did not restore separated parts');
  await page.getByRole('button',{name:'返回整体',exact:true}).click();await settle();
  assert.equal(await page.evaluate(()=>__state.selected),null);
  // A stage in a shared URL restores its actual arrangement after a fresh load.
  await page.getByRole('button',{name:'Inspect center chest',exact:true}).click();await stage(1);
  await page.waitForFunction(()=>new URL(location.href).searchParams.get('stage')==='1');
  await page.reload();await settle();
  const restored=await page.evaluate(()=>__studyParts());
  assert(restored.filter(p=>!p.large).every(p=>distance(p.position,p.base)<1e-5));
  console.log('PASS study stages / projection / locator / origin / shared stage:',model);
 }
 // Captured from the pre-study live version: Hulkbuster chest p=0 is source node 245.
 await page.goto(`${base}/?model=hulkbuster&g=chest%2FC&p=0`);await settle();
 assert.equal(await page.evaluate(()=>__studyParts().find(p=>p.index===__state.focus).node),245,'legacy part URL changed identity');
 await page.waitForFunction(()=>new URL(location.href).searchParams.has('node'));
 const pinnedNode=await page.evaluate(()=>__studyParts().find(p=>p.index===__state.focus).node);
 await page.reload();await settle();
 assert.equal(await page.evaluate(()=>__studyParts().find(p=>p.index===__state.focus).node),pinnedNode,'stable node URL changed identity');
 console.log('PASS legacy p URL / stable source node URL');
 await page.goto(`${base}/?model=hulkbuster&quality=high`);await settle();
 await page.getByRole('button',{name:'SETTINGS',exact:true}).click();
 const engineered=await page.evaluate(()=>__surfaceMaterials());
 await page.getByRole('button',{name:'ENGINEERED',exact:true}).click();await settle();
 const source=await page.evaluate(()=>__surfaceMaterials());
 const gold=source.find(m=>m.name==='Gold_1');assert(gold && gold.metalness===0 && Math.abs(gold.color[0]-.8)<1e-6,'source material differs from glTF');
 assert.notDeepEqual(source,engineered);
 await page.getByRole('button',{name:'SOURCE',exact:true}).click();await settle();
 assert.deepEqual(await page.evaluate(()=>__surfaceMaterials()),engineered);
 const detailedCalls=await page.evaluate(()=>__info().calls);
 await page.locator('#quality').selectOption('low');await settle();
 assert.equal(await page.evaluate(()=>__performance().pixelRatio),1);
 assert(await page.evaluate(()=>__info().calls)<detailedCalls,'low quality did not reduce draw calls');
 await page.getByRole('button',{name:'SETTINGS',exact:true}).click();
 console.log('PASS source materials round trip / reduced render cost');
 await page.emulateMedia({reducedMotion:'no-preference'});
 await page.getByRole('button',{name:'TOUR',exact:true}).click();await page.waitForTimeout(450);
 await page.getByRole('button',{name:'暂停',exact:true}).click();await page.waitForTimeout(150);
 const paused=await page.evaluate(()=>({time:__state.tourElapsed,step:__state.tourIndex,frames:__performance().frames,pose:__stateSnapshot()}));
 await page.waitForTimeout(1000);
 assert.deepEqual(await page.evaluate(()=>({time:__state.tourElapsed,step:__state.tourIndex,frames:__performance().frames,pose:__stateSnapshot()})),paused,'pause did not freeze scene');
 await page.getByRole('button',{name:'导览下一步',exact:true}).click();await page.waitForTimeout(100);
 assert.equal(await page.evaluate(()=>__state.tourIndex),1);assert.equal(await page.evaluate(()=>__state.explode),1);
 await page.getByRole('button',{name:'导览上一步',exact:true}).click();await page.waitForTimeout(100);
 assert.equal(await page.evaluate(()=>__state.tourIndex),0);assert.equal(await page.evaluate(()=>__state.explode),0);
 await page.getByRole('button',{name:'继续',exact:true}).click();
 await page.waitForFunction(()=>__state.tourElapsed>.2);
 await page.getByRole('button',{name:'FRONT',exact:true}).click();assert.equal(await page.evaluate(()=>__state.touring),false);
 console.log('PASS narrated tour pause / back / next / resume / interruption');
 await page.emulateMedia({reducedMotion:'reduce'});
 for(const [width,height] of [[375,667],[390,844],[430,740],[844,390]]){
  await page.setViewportSize({width,height});await page.goto(`${base}/?model=hulkbuster`);await settle();
  await page.evaluate(()=>armorLab.call('focusGroup',{key:'chest/C'}));await settle();
  const checks=await page.evaluate(()=>({hud:__verifyHud(),scrim:__verifyScrim(),a:__verifyAnnotations()}));
  assert(checks.hud.ok&&checks.scrim.ok&&checks.a.ok,JSON.stringify({width,height,checks}));
  assert(checks.a.layout.height>=120,'too little drawing space '+width+'x'+height);
  if(width<=820){await page.locator('#insContext summary').click();await settle();assert(await page.locator('#insOrigin').isVisible());await page.locator('#insContext summary').click();}
  await page.getByRole('button',{name:'Next part',exact:true}).click();await settle();
  assert.equal(await page.evaluate(()=>__state.focus),0);
  await page.getByRole('button',{name:'TOUR',exact:true}).click();await page.getByRole('button',{name:'暂停',exact:true}).click();
  for(let i=0;i<4;i++)await page.getByRole('button',{name:'导览下一步',exact:true}).click();await page.waitForTimeout(100);
  assert(await page.evaluate(()=>__verifyHud().ok&&__verifyScrim().ok),'tour layout '+width+'x'+height);
  await page.getByRole('button',{name:'结束导览',exact:true}).click();
  console.log('PASS mobile study and tour:',width+'x'+height);
 }
 assert.deepEqual(errors,[]);
} finally {await browser?.close();server.kill();}
