// Real Electron flow, isolated data only: never reads the user's health history.
import { _electron as electron } from 'playwright-core';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { getMedication, MEDICATIONS } from '../src/medications.js';
import { UNIT_FACTORS } from '../src/pk.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(import.meta.url),{defaultState}=require('../electron/state.cjs');
const userData=await mkdtemp(path.join(tmpdir(),'tide-pk-v4-'));
const seed=defaultState();
// Old snapshots have no new PK settings, and may contain old half-life overrides.
delete seed.pkSettings;
seed.modelConfigs['e2-sublingual']={absorptionHalfLifeHours:.4,eliminationHalfLifeHours:2};
seed.doses=[{id:'legacy-cpa',routeId:'cpa-oral',amount:10,at:new Date(Date.now()-3*36e5).toISOString()}];
await writeFile(path.join(userData,'state.json'),JSON.stringify(seed));
const env={...process.env,TIDE_TEST_DATA:userData};delete env.ELECTRON_RUN_AS_NODE;
const app=await electron.launch({executablePath:path.join(root,'node_modules/electron/dist/electron.exe'),args:[path.join(root,'tests/launch-smoke.cjs')],env,timeout:30000});
const errors=[],checks=[],pause=ms=>new Promise(r=>setTimeout(r,ms));
const localTime=hours=>{const d=new Date(Date.now()-hours*36e5);return new Date(+d-d.getTimezoneOffset()*6e4).toISOString().slice(0,16);};
try {
  await app.firstWindow();let win;
  for(let i=0;i<100;i++){win=app.windows().find(w=>w.url().endsWith('/index.html'));if(win)break;await pause(100);}
  assert.ok(win);win.on('pageerror',e=>errors.push(e.message));win.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await win.locator('h1').waitFor();
  await mkdir(path.join(root,'screenshots'),{recursive:true});
  const nav=async page=>{await win.locator(`[data-page="${page}"]`).click();await win.locator(`[data-page-view="${page}"]`).waitFor();};
  const submit=async()=>{await win.locator('#dialog-form button[type="submit"]').click();await win.locator('#modal').waitFor({state:'hidden'});};
  const state=()=>win.evaluate(()=>window.petAPI.loadState());
  const result=()=>win.evaluate(async()=>{const {engineFor}=await import('./src/chart.js');return engineFor(await window.petAPI.loadState()).at();});
  const removedReference=/hrt\.mahiro\.uk|Oyama|HRT Tracker/i;
  const selectMedication=async id=>{await win.locator('#form-administration-trigger').click();await win.locator('#form-administration-listbox [data-value="'+getMedication(id).administrationId+'"]').click();await win.locator('#form-route').selectOption(id);};
  const addDose=async(id,amount,hours,duration)=>{
    await win.locator('[data-action="dose"]:not([data-id])').first().click();await selectMedication(id);
    await win.locator('[name="amount"]').fill(String(amount));await win.locator('#modal [data-date-picker-input]').fill(localTime(hours));
    if(duration)await win.locator('[name="durationHours"]').fill(String(duration));
    await submit();
  };
  const addLab=async(value,unit,hours)=>{
    await nav('labs');await win.locator('[data-action="lab"]').click();await win.locator('#lab-analyte').selectOption('estradiol');
    await win.locator('#lab-unit').selectOption(unit);await win.locator('[name="value"]').fill(String(value));await win.locator('#modal [data-date-picker-input]').fill(localTime(hours));await submit();
  };
  let s=await state();assert.deepEqual(s.pkSettings,{bodyWeightKg:70,sublingualFraction:.11});assert.equal(s.doses[0].id,'legacy-cpa');
  checks.push('legacy history plus new settings migration');
  await nav('curves');await win.locator('[data-action="dose"]').click();await selectMedication('e2-ev-sublingual');
  assert.match(await win.locator('#medication-preview').innerText(),/补佳乐/);
  assert.match(await win.locator('#medication-preview').innerText(),/参考估算.*可用化验校准/s);
  assert.doesNotMatch(await win.locator('#medication-preview').innerText(),/仅记录与提醒|模型待核查/);
  for(const medication of MEDICATIONS){
    await selectMedication(medication.id);
    assert.doesNotMatch(await win.locator('#medication-preview').textContent(),removedReference);
    assert.equal(await win.locator('#medication-preview .administration-icon').count(),1);
    assert.equal(await win.locator('#form-administration-trigger svg.administration-icon').innerHTML(),await win.locator('#medication-preview svg').innerHTML());
  }
  await selectMedication('e2-ev-sublingual');
  const symbolStyle=await win.locator('.medication-symbol').evaluate(element=>{const style=getComputedStyle(element);return {background:style.backgroundColor,border:style.borderTopWidth};});
  assert.deepEqual(symbolStyle,{background:'rgba(0, 0, 0, 0)',border:'0px'});
  await win.screenshot({path:path.join(root,'screenshots/medication-icons-mtf.png')});
  checks.push('all 40 medication choices use matching transparent route symbols without white borders');
  await win.locator('[name="amount"]').fill('2');await win.locator('#modal [data-date-picker-input]').fill(localTime(8));await submit();
  assert.equal(await win.locator('.hormone-card.estradiol').getAttribute('data-status'),'reference');
  assert.doesNotMatch(await win.locator('.hormone-card.estradiol strong').innerText(),/—/);
  assert.ok(Number.isFinite((await result()).estradiol.value));checks.push('EV sublingual has reference number before labs');
  assert.doesNotMatch(await win.locator('[data-page-view="curves"]').textContent(),removedReference);

  await addLab(160,'pg/mL',4);
  assert.equal(await win.locator('.hormone-card.estradiol').getAttribute('data-status'),'calibrated');
  assert.match(await win.locator('.lab-fit-status').innerText(),/已参与校准/);
  let model=await result();assert.ok(model.estradiol.value>0);assert.equal(model.estradiol.calibration.n,1);assert.equal(model.cpa.status,'reference');
  s=await state();
  const atSample=await win.evaluate(async at=>{const {engineFor}=await import('./src/chart.js');return engineFor(await window.petAPI.loadState()).at(at).estradiol.value;},s.labs[0].at);
  assert.ok(Math.abs(atSample-160)<1e-7);checks.push('EV sublingual plus E2 lab yields calibrated curve');

  const valueBeforeUnits=model.estradiol.value;
  await win.locator('[data-action="delete-lab"]').click();await submit();
  await addLab(160*UNIT_FACTORS.estradiolPmolPerPg,'pmol/L',4);
  model=await result();assert.equal(model.estradiol.status,'calibrated');assert.ok(Math.abs(model.estradiol.value-valueBeforeUnits)<.2);
  assert.match(await win.locator('.hormone-card.estradiol').innerText(),/最近实测 160.0 pg\/mL/);checks.push('pmol/L and pg/mL calibration equivalence');
  await addLab(30,'pg/mL',24);
  assert.equal((await result()).estradiol.calibration.n,1);
  assert.match(await win.locator('.lab-fit-status').allTextContents().then(v=>v.join(' ')),/没有已记录给药的模型暴露/);
  assert.match(await win.locator('.hormone-card.estradiol .concentration-hint').innerText(),/未参与/);checks.push('unexposed older lab does not discard good calibration');

  await nav('curves');await addDose('e2-oral',1,6);
  model=await result();assert.equal(model.estradiol.status,'calibrated');assert.ok(model.estradiol.routeContributions.length===2);
  assert.equal(await win.locator('.hormone-line.estradiol').count(),2);
  assert.ok((await win.locator('.hormone-line.estradiol').first().getAttribute('d')).includes('L'));checks.push('mixed oral and sublingual contributions');
  const chart=win.locator('#hormone-chart-svg'),box=await chart.boundingBox(),before=await chart.getAttribute('aria-valuenow');
  await win.mouse.move(box.x+box.width*.45,box.y+box.height*.5);await win.mouse.down({button:'right'});await win.mouse.move(box.x+box.width*.72,box.y+box.height*.5,{steps:8});await win.mouse.up({button:'right'});
  assert.notEqual(await chart.getAttribute('aria-valuenow'),before);assert.match(await win.locator('#chart-readout').innerText(),/E2 [\d.]+ pg\/mL.*CPA [\d.]+ ng\/mL/s);checks.push('right-drag marker has finite E2 and CPA');

  await win.locator('[data-action="model"]').click();await win.locator('#model-route').selectOption('e2-ev-sublingual');
  assert.equal(await win.locator('[name="absorptionHalfLifeHours"]').count(),0);
  assert.match(await win.locator('#model-parameters').innerText(),/药代动力学参考模型/);
  for(const modelId of await win.locator('#model-route option').evaluateAll(options=>options.map(o=>o.value))){
    await win.locator('#model-route').selectOption(modelId);
    assert.doesNotMatch(await win.locator('#dialog-form').textContent(),removedReference);
    assert.doesNotMatch((await win.locator('#dialog-form [data-source]').evaluateAll(nodes=>nodes.map(n=>n.dataset.source))).join(' '),removedReference);
  }
  assert.equal(await win.locator('#dialog-form [data-source]').filter({hasText:'论文与原始单位'}).count(),1);
  await win.locator('#model-route').selectOption('cpa-oral');
  assert.match(await win.locator('#model-source [data-source]').getAttribute('data-source'),/medicines\.org\.uk/);
  await win.locator('#model-route').selectOption('e2-ev-sublingual');
  checks.push('all medication and model views omit the requested website while preserving other references');
  await win.locator('[name="bodyWeightKg"]').fill('63');await win.locator('[name="sublingualPercent"]').fill('15');await submit();
  assert.deepEqual((await state()).pkSettings,{bodyWeightKg:63,sublingualFraction:.15});assert.equal((await result()).estradiol.status,'calibrated');
  await win.locator('[data-action="model"]').click();await win.locator('#model-route').selectOption('e2-sublingual');
  assert.match(await win.locator('#model-parameters').innerText(),/保留旧版自定义半衰期/);
  await win.locator('#model-route').selectOption('cpa-oral');assert.equal(await win.locator('[name="absorptionHalfLifeHours"]').count(),1);await win.locator('[data-action="close-modal"]').click();
  checks.push('empirical model parameters and legacy overrides are clearly separated');
  await win.locator('[data-action="dose"]').click();await selectMedication('t-patch');
  assert.equal(await win.locator('#duration-field').isVisible(),true);assert.equal(await win.locator('[name="durationHours"]').getAttribute('required'),'');
  assert.equal(await win.locator('#dose-unit').innerText(),'mg/day');await win.locator('[data-action="close-modal"]').click();checks.push('new testosterone patch keeps duration and units');
  await win.locator('[data-action="mode-ftm"]').click();await win.waitForFunction(()=>document.body.dataset.mode==='ftm');
  assert.equal(await win.locator('.hormone-card.testosterone').count(),1);assert.equal(await win.locator('.hormone-card.cpa').count(),0);
  await win.locator('[data-action="dose"]').click();await selectMedication('t-enanthate-im');
  await win.screenshot({path:path.join(root,'screenshots/medication-icons-ftm.png')});
  await win.locator('[data-action="close-modal"]').click();
  await win.locator('[data-setting="showFtmEstradiol"]').check();await win.waitForFunction(()=>document.querySelector('.hormone-card.estradiol'));
  assert.equal(await win.locator('.hormone-card.estradiol').getAttribute('data-status'),'calibrated');
  await win.locator('[data-action="mode-mtf"]').click();await win.waitForFunction(()=>document.body.dataset.mode==='mtf');
  assert.doesNotMatch(await win.locator('.hormone-card.cpa strong').innerText(),/—/);checks.push('mode switch preserves E2 calibration and CPA');
  await win.screenshot({path:path.join(root,'screenshots/ev-sublingual-calibrated-v4.png'),fullPage:true});
  await win.locator('[data-action="model"]').click();await win.locator('#model-route').selectOption('e2-ev-sublingual');
  await win.screenshot({path:path.join(root,'screenshots/pk-settings-v4.png')});await win.locator('[data-action="close-modal"]').click();

  const forecastAt=new Date(Date.now()+4*36e5).toISOString();
  const futureValue=()=>win.evaluate(async at=>{const {engineFor}=await import('./src/chart.js');return engineFor(await window.petAPI.loadState()).at(at).estradiol.value;},forecastAt);
  const previousForecast=await futureValue();
  await win.evaluate(async()=>{const s=await window.petAPI.loadState();s.doses.push({id:'future-dose',routeId:'e2-ev-sublingual',amount:20,at:new Date(Date.now()+36e5).toISOString()});await window.petAPI.saveState(s);});
  assert.ok(Math.abs((await futureValue())-previousForecast)<1e-7);
  await nav('plans');assert.match(await win.locator('.future-record').innerText(),/未发生.*暂不计入估算/);checks.push('future imported dose is retained but omitted from forecast');

  await win.evaluate(async()=>{const s=await window.petAPI.loadState();s.doses=s.doses.filter(d=>d.routeId==='cpa-oral');s.labs=[{id:'future-e2',analyte:'estradiol',value:100,unit:'pg/mL',at:new Date(Date.now()+2*36e5).toISOString()}];await window.petAPI.saveState(s);});
  await nav('labs');assert.match(await win.locator('.hormone-card.estradiol .concentration-hint').innerText(),/未来/);assert.match(await win.locator('.lab-fit-status').innerText(),/未来采血时间/);checks.push('future imported lab explains exclusion visibly');
  await nav('curves');assert.equal(await win.locator('.lab-point.estradiol').count(),0,'future imported lab must not be drawn as an actual measured point');
  const persisted=JSON.parse(await readFile(path.join(userData,'state.json'),'utf8'));assert.deepEqual(persisted.pkSettings,{bodyWeightKg:63,sublingualFraction:.15});
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ok:true,checks,isolatedData:userData}));
}catch(error){console.error(JSON.stringify({errors,checks}));throw error;}finally{await app.close();}
