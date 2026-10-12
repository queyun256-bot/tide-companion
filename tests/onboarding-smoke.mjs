// Real desktop first-run setup and process restarts, with isolated synthetic data.
// TIDE_TEST_APP_ROOT optionally points at the actual installer payload's app.asar.
import { _electron as electron } from 'playwright-core';
import { mkdtemp,writeFile,readFile,mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import presets from '../src/reference-presets.json' with {type:'json'};
const require=createRequire(import.meta.url),{defaultState}=require('../electron/state.cjs');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const freshDirectory=await mkdtemp(path.join(tmpdir(),'tide-setup-fresh-'));
const legacyDirectory=await mkdtemp(path.join(tmpdir(),'tide-setup-legacy-'));
const errors=[],checks=[],pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let app,win;
async function launch(userData) {
  const env={...process.env,TIDE_TEST_DATA:userData,TIDE_TEST_ONBOARDING:'1'};delete env.ELECTRON_RUN_AS_NODE;
  app=await electron.launch({executablePath:path.join(root,'node_modules/electron/dist/electron.exe'),args:[path.join(root,'tests/launch-smoke.cjs')],env,timeout:30000});
  for(let n=0;n<100;n++){win=app.windows().find(window=>window.url().endsWith('/index.html'));if(win)break;await pause(100);}
  assert.ok(win);win.setDefaultTimeout(8000);
  win.on('pageerror',error=>errors.push(error.message));win.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
  await win.locator('h1').waitFor();
}
async function close() { if(app){await app.close();app=null;win=null;} }
const disk=directory=>readFile(path.join(directory,'state.json'),'utf8').then(JSON.parse);
const submit=async()=>{await win.locator('#dialog-form button[type="submit"]').click();await win.locator('#modal').waitFor({state:'hidden'});};
async function mode(expected) {
  await win.waitForFunction(value=>document.body.dataset.mode===value,expected);
  assert.equal(await win.locator(`[data-action="mode-${expected}"]`).getAttribute('aria-pressed'),'true');
  assert.equal(await win.evaluate(()=>getComputedStyle(document.body).getPropertyValue('--accent').trim()),expected==='ftm'?'#407aa7':'#aa5a7e');
  assert.equal(await win.locator(expected==='ftm'?'.hormone-card.testosterone':'.hormone-card.estradiol').count(),1);
}
try {
  await launch(freshDirectory);
  await win.locator('.onboarding-modal[open]').waitFor();
  assert.equal((await disk(freshDirectory)).settings.onboardingCompleted,false);
  assert.equal(await win.locator('[name="bodyWeightKg"]').inputValue(),'70');
  assert.equal(await win.evaluate(()=>document.querySelector('#modal').contains(document.activeElement)),true);
  await win.keyboard.press('Escape');await win.locator('#modal').waitFor({state:'hidden'});
  assert.equal((await disk(freshDirectory)).settings.onboardingCompleted,false);
  assert.equal(await win.evaluate(()=>document.activeElement?.dataset.action),'onboarding');
  await win.locator('[data-action="onboarding"]').click();await win.locator('.onboarding-modal[open]').waitFor();
  await win.locator('[name="mode"][value="ftm"]').check();
  await win.locator('[name="bodyWeightKg"]').fill('19');
  await win.locator('#dialog-form button[type="submit"]').click();
  assert.equal(await win.locator('[name="bodyWeightKg"]').evaluate(element=>element.validity.rangeUnderflow),true);
  assert.equal((await disk(freshDirectory)).settings.onboardingCompleted,false);
  await win.locator('[name="bodyWeightKg"]').fill('401');
  await win.locator('#dialog-form button[type="submit"]').click();
  assert.equal(await win.locator('[name="bodyWeightKg"]').evaluate(element=>element.validity.rangeOverflow),true);
  await win.locator('[name="bodyWeightKg"]').fill('61.5');await submit();await mode('ftm');
  const first=await disk(freshDirectory);
  assert.equal(first.settings.onboardingCompleted,true);assert.equal(first.pkSettings.bodyWeightKg,61.5);
  assert.equal(first.pkSettings.sublingualFraction,.11);assert.deepEqual(first.referenceBaselines,presets.baselines.ftm);
  assert.equal(await win.locator('[data-action="onboarding"]').count(),0);
  assert.equal(await win.evaluate(()=>document.activeElement?.dataset.page),'overview');
  checks.push('fresh native setup, keyboard cancel/resume, weight bounds, FTM completion and preset');
  await close();await launch(freshDirectory);await mode('ftm');
  assert.equal(await win.locator('#modal').evaluate(element=>element.open),false);
  assert.equal((await disk(freshDirectory)).pkSettings.bodyWeightKg,61.5);
  checks.push('complete process restart restores saved FTM blue mode and model weight without setup');
  await win.locator('[data-action="mode-mtf"]').click();await mode('mtf');
  assert.equal((await disk(freshDirectory)).settings.mode,'mtf');
  await close();await launch(freshDirectory);await mode('mtf');
  assert.equal(await win.locator('#modal').evaluate(element=>element.open),false);
  assert.equal((await disk(freshDirectory)).pkSettings.bodyWeightKg,61.5);
  checks.push('subsequent MTF switch survives process restart with pink theme and unchanged weight');
  await close();

  const legacy=defaultState();delete legacy.settings.onboardingCompleted;
  legacy.settings.mode='ftm';legacy.settings.name='小圆';legacy.settings.nameCustomized=true;legacy.settings.reducedMotion=true;
  legacy.pkSettings={bodyWeightKg:57.2,sublingualFraction:.27};
  legacy.referenceBaselines={estradiol:32,testosterone:44};legacy.referenceBaselineCustomized=true;
  legacy.baselines={estradiol:2,testosterone:15};
  legacy.doses=[{id:'old-t',routeId:'t-enanthate-im',amount:25,at:'2026-10-01T00:00:00.000Z'}];
  legacy.labs=[{id:'old-lab',analyte:'testosterone',value:380,unit:'ng/dL',at:'2026-10-02T00:00:00.000Z'}];
  legacy.plans=[{id:'old-plan',routeId:'t-enanthate-im',name:'原有计划',amount:25,intervalHours:168,startAt:'2026-10-01T00:00:00.000Z',enabled:false}];
  legacy.modelConfigs={'cpa-oral':{absorptionHalfLifeHours:1.2,eliminationHalfLifeHours:48}};
  await writeFile(path.join(legacyDirectory,'state.json'),JSON.stringify(legacy));
  await launch(legacyDirectory);await mode('ftm');await win.locator('.onboarding-modal[open]').waitFor();
  assert.equal(await win.locator('[name="mode"][value="ftm"]').isChecked(),true);
  assert.equal(await win.evaluate(()=>document.activeElement?.value),'ftm');
  assert.equal(await win.locator('[name="bodyWeightKg"]').inputValue(),'57.2');
  assert.equal(await win.locator('#modal').evaluate(element=>element.getAnimations().length),0);
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(window=>window.webContents.getURL().endsWith('/index.html')).setSize(860,620));
  const layout=await win.locator('#modal').evaluate(element=>({width:element.clientWidth,content:element.scrollWidth,rect:element.getBoundingClientRect().toJSON(),viewport:{width:innerWidth,height:innerHeight}}));
  assert.ok(layout.content<=layout.width);assert.ok(layout.rect.left>=0&&layout.rect.right<=layout.viewport.width);
  await mkdir(path.join(root,'screenshots'),{recursive:true});await win.screenshot({path:path.join(root,'screenshots/onboarding-ftm.png')});
  await win.keyboard.press('Escape');await win.locator('#modal').waitFor({state:'hidden'});await close();
  await launch(legacyDirectory);await win.locator('.onboarding-modal[open]').waitFor();
  assert.equal(await win.locator('[name="mode"][value="ftm"]').isChecked(),true);
  assert.equal(await win.locator('[name="bodyWeightKg"]').inputValue(),'57.2');
  await win.locator('[name="mode"][value="mtf"]').check();await submit();await mode('mtf');
  const migrated=await disk(legacyDirectory);
  assert.equal(migrated.settings.onboardingCompleted,true);assert.equal(migrated.settings.name,'小圆');
  for(const key of ['doses','labs','plans','pkSettings','modelConfigs','referenceBaselines','baselines'])assert.deepEqual(migrated[key],legacy[key]);
  assert.equal(migrated.referenceBaselineCustomized,true);
  checks.push('legacy values prefill, deferred setup repeats next launch, reduced motion and minimum window fit');
  checks.push('legacy completion keeps custom background, absorption fraction, existing records and calibration settings');
  assert.deepEqual(errors,[]);console.log(JSON.stringify({ok:true,checks,installerPayload:!!process.env.TIDE_TEST_APP_ROOT,isolatedData:[freshDirectory,legacyDirectory]}));
} finally { await close(); }
