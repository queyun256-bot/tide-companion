// Real Electron with an isolated store; animation never delays data or interrupts chart input.
import { _electron as electron } from 'playwright-core';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const userData=await mkdtemp(path.join(tmpdir(),'tide-motion-v5-'));
const env={...process.env,TIDE_TEST_DATA:userData};delete env.ELECTRON_RUN_AS_NODE;
const app=await electron.launch({executablePath:path.join(root,'node_modules/electron/dist/electron.exe'),args:[path.join(root,'tests/launch-smoke.cjs')],env,timeout:30000});
const errors=[],checks=[],pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let win;
try {
  for(let n=0;n<100;n++){win=app.windows().find(w=>w.url().endsWith('/index.html'));if(win)break;await pause(100);}
  assert.ok(win);win.setDefaultTimeout(8000);await win.locator('h1').waitFor();
  // Use real Electron renderer input without sharing a foreground surface with
  // the user's mouse. Native wheel/mouse messages can otherwise interrupt a CDP
  // right-button gesture or scroll the axis coordinates during an assertion.
  await app.evaluate(({BrowserWindow})=>{for(const window of BrowserWindow.getAllWindows()){window.webContents.setBackgroundThrottling(false);window.hide();}});
  win.on('pageerror',error=>errors.push(error.message));win.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
  await win.addInitScript(()=>{
    const interval=window.setInterval;
    window.setInterval=function(callback,delay,...args){if(delay===60000)window.__minuteRefresh=()=>callback(...args);return interval(callback,delay,...args);};
  });
  await win.reload();await win.locator('h1').waitFor();
  await win.emulateMedia({reducedMotion:'no-preference'});
  await win.evaluate(async()=>{
    const s=await window.petAPI.loadState();s.settings.autoHideFullscreen=false;s.settings.reducedMotion=false;s.settings.petVisible=false;
    s.doses=[{id:'motion-e2',routeId:'e2-ev-sublingual',amount:2,at:new Date(Date.now()-3600000).toISOString()},{id:'motion-cpa',routeId:'cpa-oral',amount:12.5,at:new Date(Date.now()-7200000).toISOString()}];
    await window.petAPI.saveState(s);
    window.__motionRuns=[];const animate=Element.prototype.animate;
    Element.prototype.animate=function(...args){const animation=animate.apply(this,args);window.__motionRuns.push({animation,element:this});return animation;};
  });
  const nav=page=>win.evaluate(key=>document.querySelector(`[data-page="${key}"]`).click(),page);
  const runs=name=>win.evaluate(key=>window.__motionRuns.filter(entry=>entry.animation.id===`tide-${key}`).length,name);
  const quiet=()=>win.waitForFunction(()=>document.getAnimations().every(animation=>!animation.id.startsWith('tide-')));
  const noCurveMotion=()=>win.evaluate(()=>!document.querySelector('.chart-series')?.getAnimations().some(animation=>animation.id==='tide-curve-reveal'));
  await nav('curves');
  const initial=await win.evaluate(()=>({
    paths:document.querySelectorAll('.chart-series .hormone-line').length,
    curve:document.querySelector('.chart-series').getAnimations().map(animation=>({id:animation.id,frames:animation.effect.getKeyframes()})),
    grid:document.querySelector('.grid').getBoundingClientRect().toJSON(),
    marker:document.querySelector('#marker-line').getBoundingClientRect().toJSON(),
    gridAnimations:document.querySelector('.grid').getAnimations().length,
    value:document.querySelector('.hormone-card.estradiol strong').textContent,
  }));
  assert.equal(initial.paths,4);assert.match(initial.value,/\d+\.\d/);assert.equal(initial.gridAnimations,0);
  assert.ok(initial.curve.some(animation=>animation.id==='tide-curve-reveal'&&animation.frames[0].clipPath==='inset(0px 100% 0px 0px)'));
  await quiet();
  const after=await win.evaluate(()=>({grid:document.querySelector('.grid').getBoundingClientRect().toJSON(),marker:document.querySelector('#marker-line').getBoundingClientRect().toJSON(),clip:getComputedStyle(document.querySelector('.chart-series')).clipPath,pageClasses:document.querySelector('.page-view').className}));
  assert.deepEqual(after.grid,initial.grid);assert.deepEqual(after.marker,initial.marker);assert.equal(after.clip,'none');assert.doesNotMatch(after.pageClasses,/page-enter/);
  checks.push('left-to-right curve reveal, fixed axes and marker, immediate values, cleanup');
  const firstRuns=await runs('curve-reveal');
  await win.evaluate(()=>window.petAPI.petAction('pet'));await pause(100);
  assert.equal(await runs('curve-reveal'),firstRuns);assert.equal(await noCurveMotion(),true);
  await win.evaluate(()=>window.__minuteRefresh());assert.equal(await runs('curve-reveal'),firstRuns);assert.equal(await noCurveMotion(),true);
  await win.locator('#chart-days').selectOption('7');assert.equal(await runs('curve-reveal'),firstRuns);
  await nav('curves');assert.equal(await runs('curve-reveal'),firstRuns);
  checks.push('broadcasts, minute refresh, time-range and same-page navigation never replay entry');
  // Start another entry then interact before it finishes. Its reveal must finish immediately.
  await nav('overview');await nav('curves');
  const chart=win.locator('#hormone-chart-svg'),box=await chart.boundingBox();
  await chart.evaluate(element=>{window.__dragEvents=[];for(const type of ['pointerdown','pointermove','pointerup','pointercancel','gotpointercapture','lostpointercapture'])element.addEventListener(type,event=>window.__dragEvents.push({type,buttons:event.buttons,pointerId:event.pointerId,target:event.target.tagName,focused:document.hasFocus()}));});
  await win.mouse.move(box.x+box.width*.3,box.y+box.height*.4);await win.mouse.down({button:'right'});
  assert.equal(await chart.evaluate(element=>element.classList.contains('is-dragging')),true,JSON.stringify(await win.evaluate(()=>window.__dragEvents)));
  assert.equal(await noCurveMotion(),true);
  await chart.evaluate(element=>element.dataset.protected='yes');
  await win.evaluate(()=>window.petAPI.petAction('nuzzle'));
  assert.equal(await chart.getAttribute('data-protected'),'yes',JSON.stringify(await win.evaluate(()=>window.__dragEvents)));
  assert.equal(await chart.evaluate(element=>element.classList.contains('is-dragging')),true,JSON.stringify(await win.evaluate(()=>window.__dragEvents)));
  await win.mouse.move(box.x+box.width*.65,box.y+box.height*.4,{steps:4});await win.mouse.up({button:'right'});
  const selected=Number(await chart.getAttribute('aria-valuenow'));
  await win.evaluate(()=>window.petAPI.petAction('nuzzle'));assert.equal(Number(await chart.getAttribute('aria-valuenow')),selected);
  const dragRuns=await runs('curve-reveal');await chart.focus();await chart.press('ArrowRight');assert.equal(Number(await chart.getAttribute('aria-valuenow')),selected+900000);assert.equal(await runs('curve-reveal'),dragRuns);
  await win.evaluate(()=>window.__minuteRefresh());assert.equal(await win.evaluate(()=>document.activeElement?.id),'hormone-chart-svg');assert.equal(Number(await chart.getAttribute('aria-valuenow')),selected+900000);assert.equal(await runs('curve-reveal'),dragRuns);
  checks.push('entry can be interrupted by right-drag; broadcast preserves capture and selected time');
  // An OS preference change cancels an already running animation, without a reload.
  await nav('overview');await nav('curves');assert.equal(await noCurveMotion(),false);
  await win.emulateMedia({reducedMotion:'reduce'});await win.waitForFunction(()=>document.body.classList.contains('no-motion'));
  assert.equal(await noCurveMotion(),true);const reducedRuns=await runs('curve-reveal');
  await nav('settings');await nav('curves');assert.equal(await runs('curve-reveal'),reducedRuns);
  await win.locator('[data-action="dose"]').click();assert.equal(await win.locator('#modal').evaluate(element=>element.getAnimations().length),0);await win.keyboard.press('Escape');await win.locator('#modal').waitFor({state:'hidden'});
  checks.push('live OS reduced-motion preference stops active and future animations');
  await win.emulateMedia({reducedMotion:'no-preference'});
  await nav('settings');await win.locator('[data-setting="reducedMotion"]').check();
  const appReducedRuns=await runs('curve-reveal');await nav('curves');assert.equal(await runs('curve-reveal'),appReducedRuns);assert.equal(await noCurveMotion(),true);
  await nav('settings');await win.locator('[data-setting="reducedMotion"]').uncheck();await quiet();
  checks.push('saved reduced-motion setting covers navigation and curve animations');
  await win.locator('[data-action="rename"]').click();assert.equal(await win.locator('#modal').evaluate(element=>element.contains(document.activeElement)),true);
  assert.ok(await runs('dialog-reveal')>0);await win.locator('[name="name"]').fill('小圆');await win.locator('#dialog-form button[type="submit"]').click();await win.locator('#modal').waitFor({state:'hidden'});
  assert.equal(await win.evaluate(()=>document.activeElement?.dataset.action),'rename');
  await win.locator('[data-action="rename"]').click();await win.keyboard.press('Escape');await win.locator('#modal').waitFor({state:'hidden'});assert.equal(await win.evaluate(()=>document.activeElement?.dataset.action),'rename');
  await win.locator('[data-action="rename"]').click();await win.locator('[data-action="close-modal"]').click();await win.locator('#modal').waitFor({state:'hidden'});assert.equal(await win.evaluate(()=>document.activeElement?.dataset.action),'rename');
  checks.push('dialog animation preserves input focus, save/cancel/Escape restore opener after re-render');
  await win.evaluate(()=>{for(const key of ['curves','overview','plans','curves','labs','settings'])document.querySelector(`[data-page="${key}"]`).click();});await quiet();
  assert.equal(await win.evaluate(()=>document.querySelector('.page-view').dataset.pageView),'settings');
  assert.equal(await win.evaluate(()=>window.__motionRuns.filter(entry=>!entry.element.isConnected&&entry.animation.playState==='running').length),0);
  checks.push('rapid navigation cancels detached animations and leaves no stale transitions');
  // Chromium's screenshot compositor needs a native surface. The gesture and
  // motion assertions above have finished; expose the window without activation
  // only while saving visual artifacts, then close it in finally.
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(window=>window.webContents.getURL().endsWith('/index.html')).showInactive());
  await nav('overview');await quiet();await mkdir(path.join(root,'screenshots'),{recursive:true});await win.screenshot({path:path.join(root,'screenshots/overview-v5.png'),fullPage:true});
  await nav('curves');await quiet();await win.screenshot({path:path.join(root,'screenshots/curves-v5.png'),fullPage:true});
  assert.deepEqual(errors,[]);console.log(JSON.stringify({ok:true,checks,isolatedData:userData}));
}finally{await app.close();}
