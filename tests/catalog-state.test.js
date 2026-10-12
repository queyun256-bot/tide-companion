import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {MEDICATIONS,getMedication,ADMINISTRATIONS} from '../src/medications.js';
import presets from '../src/reference-presets.json' with {type:'json'};
import {compileHormoneModel} from '../src/hormones.js';
const require=createRequire(import.meta.url);
const {defaultState,validateState}=require('../electron/state.cjs');
const at='2026-10-01T00:00:00.000Z';

test('two-stage catalog retains chemically distinct EV and E2 sublingual records through storage',()=>{
  const s=defaultState();
  s.doses=[{id:'ev',routeId:'e2-ev-sublingual',amount:2,at},{id:'free',routeId:'e2-sublingual',amount:2,at}];
  assert.deepEqual(validateState(s).doses,s.doses);
  assert.equal(getMedication(s.doses[0].routeId).administrationId,'sublingual');
  assert.match(getMedication(s.doses[0].routeId).brands,/补佳乐/);
  assert.notEqual(getMedication(s.doses[0].routeId).drugName,getMedication(s.doses[1].routeId).drugName);
});
test('every displayed drug and route combination can be saved without relaxing the route allowlist',()=>{
  const s=defaultState();
  s.doses=MEDICATIONS.map((p,i)=>({id:`r-${i}`,routeId:p.id,amount:1,at,...(p.model==='infusion'?{durationHours:24}:{})}));
  assert.equal(validateState(s).doses.length,40);
  assert.ok(MEDICATIONS.every(p=>ADMINISTRATIONS.some(a=>a.id===p.administrationId)));
  assert.throws(()=>validateState({...s,doses:[{id:'x',routeId:'made-up',amount:1,at}]}),/未知给药/);
});
test('CPA laboratory units are independent from testosterone units',()=>{
  const s=defaultState();s.labs=[{id:'cpa-lab',analyte:'cpa',value:50,unit:'ng/mL',at}];
  assert.deepEqual(validateState(s).labs,s.labs);
  s.labs[0].unit='nmol/L';assert.equal(validateState(s).labs[0].unit,'nmol/L');
  s.labs[0].unit='ng/dL';assert.throws(()=>validateState(s),/化验单位/);
});
test('the old provisional background is migrated to a documented cohort median without changing personal history',()=>{
  const s=defaultState();delete s.referencePresetVersion;delete s.referenceBaselineCustomized;
  s.referenceBaselines={estradiol:20,testosterone:450};s.baselines={estradiol:4,testosterone:12};
  s.doses=[{id:'one',routeId:'e2-oral',amount:2,at}];
  const next=validateState(s);
  assert.deepEqual(next.referenceBaselines,presets.baselines.mtf);
  assert.deepEqual(next.doses,s.doses);assert.deepEqual(next.baselines,s.baselines);
  s.settings.mode='ftm';s.referenceBaselines={estradiol:60,testosterone:30};
  assert.deepEqual(validateState(s).referenceBaselines,presets.baselines.ftm);
});
test('explicitly customized background is never overwritten, even when equal to an old preset',()=>{
  const s=defaultState();delete s.referencePresetVersion;
  s.referenceBaselines={estradiol:20,testosterone:450};s.referenceBaselineCustomized=true;
  assert.deepEqual(validateState(s).referenceBaselines,s.referenceBaselines);
  delete s.referenceBaselineCustomized;s.referenceBaselines={estradiol:33,testosterone:77};
  const next=validateState(s);assert.deepEqual(next.referenceBaselines,s.referenceBaselines);assert.equal(next.referenceBaselineCustomized,true);
});

test('out-of-range numeric times return unavailable rather than throwing during curve creation',()=>{
  const model=compileHormoneModel();
  assert.equal(model.at(1e20).cpa.value,null);
  assert.equal(model.at(-1e20).estradiol.status,'unavailable');
  assert.deepEqual(model.series({start:Date.now(),end:1e20}),[]);
});

test('legacy health records acquire explicit PK assumptions without being rewritten',()=>{
  const legacy=defaultState();delete legacy.pkSettings;
  legacy.doses=[{id:'ev-sl',routeId:'e2-ev-sublingual',amount:2,at}];
  legacy.labs=[{id:'e2-lab',analyte:'estradiol',value:180,unit:'pg/mL',at}];
  legacy.modelConfigs={'e2-oral':{absorptionHalfLifeHours:3,eliminationHalfLifeHours:13}};
  const migrated=validateState(legacy);
  assert.deepEqual(migrated.pkSettings,{bodyWeightKg:70,sublingualFraction:0.11});
  for(const key of ['doses','labs','modelConfigs','baselines'])assert.deepEqual(migrated[key],legacy[key]);
});

test('body weight and sublingual assumptions round-trip and reject invalid imported numbers',()=>{
  const s=defaultState();s.pkSettings={bodyWeightKg:56.5,sublingualFraction:0.25};
  assert.deepEqual(validateState(s).pkSettings,s.pkSettings);
  for(const bodyWeightKg of [0,19.9,401,NaN,Infinity,'70'])assert.throws(()=>validateState({...s,pkSettings:{...s.pkSettings,bodyWeightKg}}),/模型体重/);
  for(const sublingualFraction of [-0.01,1.01,NaN,'0.11'])assert.throws(()=>validateState({...s,pkSettings:{...s.pkSettings,sublingualFraction}}),/黏膜吸收/);
  assert.equal(validateState({...s,pkSettings:{bodyWeightKg:70,sublingualFraction:0}}).pkSettings.sublingualFraction,0);
  assert.equal(validateState({...s,pkSettings:{bodyWeightKg:70,sublingualFraction:1}}).pkSettings.sublingualFraction,1);
});
