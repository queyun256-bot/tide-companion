// Native Electron, isolated records: route icons and protection against accidental dismissal.
import { _electron as electron } from 'playwright-core';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { ADMINISTRATIONS, getMedication } from '../src/medications.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const userData=await mkdtemp(path.join(tmpdir(),'tide-dialog-v052-'));
const env={...process.env,TIDE_TEST_DATA:userData};delete env.ELECTRON_RUN_AS_NODE;
const app=await electron.launch({executablePath:path.join(root,'node_modules/electron/dist/electron.exe'),args:[path.join(root,'tests/launch-smoke.cjs')],env,timeout:30000});
const errors=[],checks=[];let win;
try {
  for(let n=0;n<100;n++){win=app.windows().find(w=>w.url().endsWith('/index.html'));if(win)break;await new Promise(resolve=>setTimeout(resolve,100));}
  assert.ok(win);win.setDefaultTimeout(8000);await win.locator('h1').waitFor();
  win.on('pageerror',error=>errors.push(error.message));win.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
  await app.evaluate(({BrowserWindow})=>{for(const window of BrowserWindow.getAllWindows()){window.webContents.setBackgroundThrottling(false);window.hide();}});
  await win.evaluate(async()=>{const s=await window.petAPI.loadState();s.settings.reducedMotion=true;s.settings.petVisible=false;s.settings.autoHideFullscreen=false;await window.petAPI.saveState(s);});
  const state=()=>win.evaluate(()=>window.petAPI.loadState());
  const before=await state();
  const nav=async page=>{await win.locator(`[data-page="${page}"]`).click();await win.locator(`[data-page-view="${page}"]`).waitFor();};
  const close=async()=>{await win.locator('#modal [data-action="close-modal"]').click();await win.locator('#modal').waitFor({state:'hidden'});};
  const openDose=()=>win.locator('[data-action="dose"]:not([data-id])').first().click();
  const trigger=()=>win.locator('#form-administration-trigger');
  const list=()=>win.locator('#form-administration-listbox');
  async function backdropKeepsDraft(selector,value){
    await win.locator(selector).fill(value);
    const rect=await win.locator('#modal').boundingBox();
    assert.ok(rect.x>3,'need an actual backdrop point');
    await win.mouse.click(rect.x-3,Math.max(2,rect.y+20));
    await win.waitForTimeout(180);
    assert.equal(await win.locator('#modal').evaluate(element=>element.open),true);
    assert.equal(await win.locator(selector).inputValue(),value);
  }

  await openDose();
  assert.equal(await win.locator('#modal').getAttribute('closedby'),'closerequest');
  await backdropKeepsDraft('[name="amount"]','1.25');
  await trigger().click();await list().waitFor({state:'visible'});
  assert.equal(await list().getByRole('option').count(),ADMINISTRATIONS.length);
  for(const route of ADMINISTRATIONS){
    const option=list().locator(`[data-value="${route.id}"]`);
    assert.match(await option.innerText(),new RegExp(route.name));
    assert.equal(await option.locator('svg.administration-icon').count(),1);
    const style=await option.locator('svg.administration-icon').evaluate(element=>{const s=getComputedStyle(element);return {background:s.backgroundColor,border:s.borderTopWidth};});
    assert.deepEqual(style,{background:'rgba(0, 0, 0, 0)',border:'0px'});
  }
  await list().locator('[data-value="sublingual"]').click();
  assert.equal(await win.locator('#form-administration').inputValue(),'sublingual');
  assert.equal(await trigger().getAttribute('aria-expanded'),'false');
  assert.equal(getMedication(await win.locator('#form-route').inputValue()).administrationId,'sublingual');
  assert.equal(await trigger().locator('svg.administration-icon').innerHTML(),await win.locator('#medication-preview svg').innerHTML());
  checks.push('all ten expanded options show transparent SVG icons and selection updates medication/preview');

  await trigger().click();await trigger().press('End');await trigger().press('Enter');
  assert.equal(await win.locator('#form-administration').inputValue(),'implant');
  await trigger().click();await trigger().press('Home');await trigger().press('Enter');
  assert.equal(await win.locator('#form-administration').inputValue(),'oral');
  await trigger().click();await trigger().press('ArrowDown');await trigger().press('Escape');
  assert.equal(await trigger().getAttribute('aria-expanded'),'false');
  assert.equal(await win.locator('#modal').evaluate(element=>element.open),true);
  assert.equal(await win.locator('#form-administration').inputValue(),'oral','Escape never commits a highlighted option');
  await trigger().press('Escape');await win.locator('#modal').waitFor({state:'hidden'});
  checks.push('keyboard navigation commits explicitly; first Escape folds the list, second closes the dialog');

  await openDose();await trigger().click();await trigger().press('Tab');
  assert.equal(await win.locator('#modal').evaluate(element=>element.open),true);
  assert.equal(await win.evaluate(()=>document.activeElement.id),'form-route');
  await close();
  for(const [page,action,selector,value] of [
    ['plans','plan','[name="name"]','临时提醒草稿'],
    ['labs','lab','[name="value"]','123'],
    ['curves','model','[name="bodyWeightKg"]','66.5'],
    ['settings','rename','[name="name"]','临时名字'],
  ]){
    await nav(page);await win.locator(`[data-action="${action}"]`).first().click();
    await backdropKeepsDraft(selector,value);await close();
  }
  await win.evaluate(async()=>{const s=await window.petAPI.loadState();s.settings.onboardingCompleted=false;await window.petAPI.saveState(s);});
  await win.locator('.setup-reminder [data-action="onboarding"]').click();await backdropKeepsDraft('[name="bodyWeightKg"]','62.5');
  await win.keyboard.press('Escape');await win.locator('#modal').waitFor({state:'hidden'});
  assert.equal((await state()).settings.onboardingCompleted,false);
  const after=await state();for(const key of ['doses','plans','labs','pkSettings','modelConfigs'])assert.deepEqual(after[key],before[key]);
  checks.push('dose, reminder, lab, model, rename and setup drafts survive backdrop clicks; cancel leaves records intact');

  await win.evaluate(async()=>{const s=await window.petAPI.loadState();s.settings.onboardingCompleted=true;await window.petAPI.saveState(s);});
  await nav('overview');
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/index.html')).setSize(860,620));
  await mkdir(path.join(root,'screenshots'),{recursive:true});
  for(const mode of ['mtf','ftm']){
    await win.locator(`[data-action="mode-${mode}"]`).click();await openDose();await trigger().click();
    await list().waitFor({state:'visible'});
    const geometry=await list().evaluate(element=>{const rect=element.getBoundingClientRect(),dialog=document.querySelector('#modal').getBoundingClientRect();return {x:rect.x,y:rect.y,right:rect.right,bottom:rect.bottom,dialog:{x:dialog.x,y:dialog.y,right:dialog.right,bottom:dialog.bottom},width:innerWidth,height:innerHeight,scrollable:element.scrollHeight>element.clientHeight};});
    assert.ok(geometry.x>=0&&geometry.right<=geometry.width&&geometry.y>=0&&geometry.bottom<=geometry.height,JSON.stringify(geometry));
    assert.ok(geometry.bottom<=geometry.dialog.bottom+1,JSON.stringify(geometry));
    assert.ok(geometry.scrollable,'all ten options remain accessible through scrolling in a small window');
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/index.html')).showInactive());
    await win.screenshot({path:path.join(root,`screenshots/administration-list-${mode}-v052.png`),animations:'disabled'});
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/index.html')).hide());
    await list().locator('[data-value="implant"]').click();assert.equal(await win.locator('#form-administration').inputValue(),'implant');
    await close();
  }
  checks.push('pink and blue dropdowns fit 860×620, scroll to the last option and preserve transparent icons');
  assert.deepEqual(errors,[]);console.log(JSON.stringify({ok:true,checks,installerPayload:!!process.env.TIDE_TEST_APP_ROOT,isolatedData:userData}));
}finally{await app.close();}
