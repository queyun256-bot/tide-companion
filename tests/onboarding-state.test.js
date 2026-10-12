import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const require=createRequire(import.meta.url);
const { defaultState,validateState,createStateStore }=require('../electron/state.cjs');

test('first setup requires explicit completion and rejects non-boolean imported markers',()=>{
  assert.equal(defaultState().settings.onboardingCompleted,false);
  for(const value of ['true',1,null,{}])assert.throws(()=>validateState({...defaultState(),settings:{...defaultState().settings,onboardingCompleted:value}}),/初始设置/);
});

test('legacy setup migration preserves FTM, individual model parameters and health history',()=>{
  const old=defaultState();delete old.settings.onboardingCompleted;
  old.settings.mode='ftm';old.pkSettings={bodyWeightKg:58.5,sublingualFraction:.32};
  old.referenceBaselines={estradiol:34,testosterone:50};old.referenceBaselineCustomized=true;
  old.baselines={estradiol:9,testosterone:17};old.modelConfigs={'cpa-oral':{absorptionHalfLifeHours:1.2,eliminationHalfLifeHours:48}};
  old.doses=[{id:'legacy-t',routeId:'t-enanthate-im',amount:30,at:'2026-10-01T00:00:00.000Z'}];
  old.labs=[{id:'legacy-lab',analyte:'testosterone',value:460,unit:'ng/dL',at:'2026-10-02T00:00:00.000Z'}];
  const directory=mkdtempSync(path.join(tmpdir(),'tide-onboarding-state-'));
  try {
    writeFileSync(path.join(directory,'state.json'),JSON.stringify(old));
    const store=createStateStore(directory),loaded=store.load();
    assert.equal(loaded.migrated,true);assert.equal(loaded.state.settings.onboardingCompleted,false);
    assert.equal(loaded.state.settings.mode,'ftm');
    for(const key of ['pkSettings','referenceBaselines','baselines','modelConfigs','doses','labs'])assert.deepEqual(loaded.state[key],old[key]);
    const snapshot=readdirSync(directory).find(file=>file.startsWith('state.before-v0.5.1-migration-'));
    assert.ok(snapshot);assert.deepEqual(JSON.parse(readFileSync(path.join(directory,snapshot),'utf8')),old);
    store.save({...loaded.state,settings:{...loaded.state.settings,onboardingCompleted:true}});
    const reopened=createStateStore(directory).load();
    assert.equal(reopened.migrated,false);assert.equal(reopened.state.settings.onboardingCompleted,true);
    assert.equal(reopened.state.settings.mode,'ftm');assert.deepEqual(reopened.state.pkSettings,old.pkSettings);
  } finally { rmSync(directory,{recursive:true,force:true}); }
});
