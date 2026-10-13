import test from 'node:test';
import assert from 'node:assert/strict';
import dictionary from '../src/locales/journal.json' with {type:'json'};
import catalog from '../src/medication-catalog.json' with {type:'json'};
import { setLanguage } from '../src/i18n.js';
import { ADMINISTRATIONS, MEDICATIONS, getMedication } from '../src/medications.js';
import { getProfile, normalizeLab, calibrate } from '../src/pk.js';
import { compileHormoneModel, BASELINE_EVIDENCE } from '../src/hormones.js';
import { parsePickerValue, pickerMonthCells } from '../src/date-picker.js';
import { calendarPage, journalWeekdays } from '../src/calendar.js';
import { hormoneCards, hormoneChart } from '../src/chart.js';
import { gahtReference } from '../src/gaht-reference.js';

const noHan = value => assert.doesNotMatch(String(value), /[\u3400-\u9fff]/);
const at='2026-10-13T08:00:00.000Z';
const state={settings:{mode:'mtf'},doses:[{id:'dose',routeId:'e2-ev-sublingual',amount:2,at:'2026-10-13T06:00:00.000Z'}],labs:[{id:'lab',analyte:'estradiol',value:120,unit:'pg/mL',at:'2026-10-13T07:00:00.000Z'}],dailyMoods:[],pkSettings:{bodyWeightKg:70,sublingualFraction:0.11}};

test('journal translations include all five alternatives and preserve placeholders',()=>{
  for(const [source,translations] of Object.entries(dictionary)) {
    assert.equal(translations.length,5,source);
    const placeholders=source.match(/\{[^}]+\}/g)?.sort()||[];
    for(const text of translations) {assert.ok(text.trim(),source);assert.deepEqual(text.match(/\{[^}]+\}/g)?.sort()||[],placeholders,source);}
  }
});

test('catalog views change language without changing identity, dose units or PK defaults',()=>{
  setLanguage('zh-CN');
  const medication=getMedication('e2-ev-sublingual');
  const numeric=MEDICATIONS.map(p=>({id:p.id,administrationId:p.administrationId,analyte:p.analyte,unit:p.unit,doseUnit:p.doseUnit,defaults:p.defaults}));
  for(const locale of ['en','zh-TW','ja','ko','es']) {
    setLanguage(locale);
    if(locale !== 'zh-TW') assert.notEqual(medication.drugName,'戊酸雌二醇 EV');
    assert.deepEqual(MEDICATIONS.map(p=>({id:p.id,administrationId:p.administrationId,analyte:p.analyte,unit:p.unit,doseUnit:p.doseUnit,defaults:p.defaults})),numeric);
    assert.equal(getMedication('e2-patch').unit,'μg/day');
    assert.equal(getMedication('t-patch').unit,'mg/day');
    for(const item of catalog.items) {
      const view=getMedication(item.id);
      assert.ok(view.name && view.brands && view.note);
      if(['en','ko','es'].includes(locale)) for(const text of [view.name,view.drugName,view.brands,view.note,view.evidence,...view.sources.map(s=>s.title)]) noHan(text);
    }
    if(['en','ko','es'].includes(locale)) ADMINISTRATIONS.forEach(a=>noHan(a.name));
  }
  setLanguage('zh-CN');assert.equal(medication.drugName,'戊酸雌二醇 EV');
});

test('localization preserves concentration, calibration, unit conversion and record times',()=>{
  const values=locale=>{setLanguage(locale);const result=compileHormoneModel({...state,at}).at(at);return Object.fromEntries(Object.entries(result).map(([key,r])=>[key,{value:r.value,unit:r.unit,status:r.status,baseline:r.baseline,calibration:{factor:r.calibration.factor,n:r.calibration.n,rmse:r.calibration.rmse},route:r.routeContributions.map(p=>({routeId:p.routeId,shape:p.shape,contribution:p.contribution}))}]));};
  const expected=values('zh-CN'), original=JSON.stringify(state);
  for(const locale of ['en','zh-TW','ja','ko','es']) {
    assert.deepEqual(values(locale),expected);
    assert.equal(normalizeLab({analyte:'testosterone',value:20,unit:'nmol/L',at}).at,at);
  }
  assert.equal(JSON.stringify(state),original);
  setLanguage('zh-CN');
});

test('all modeled routes expose translated model warnings and source metadata',()=>{
  for(const locale of ['en','ko','es']) {
    setLanguage(locale);
    for(const medication of MEDICATIONS) {
      const dose={id:medication.id,routeId:medication.id,amount:2,durationHours:24,at:'2026-10-13T06:00:00.000Z'};
      const results=compileHormoneModel({doses:[dose],at}).at(at);
      for(const result of Object.values(results)) {
        result.warnings.forEach(noHan);
        result.routeContributions.forEach(route=>{noHan(route.name);noHan(route.note);});
      }
      const profile=getProfile(medication.id);
      if(profile) {noHan(profile.name);noHan(profile.note);noHan(profile.evidence);profile.sources.forEach(source=>noHan(source.title));}
    }
    noHan(BASELINE_EVIDENCE.title);noHan(BASELINE_EVIDENCE.population);noHan(BASELINE_EVIDENCE.limitation);
    noHan(normalizeLab({analyte:'estradiol',value:100,unit:'wrong',at}).warning);
    noHan(calibrate({routeId:'cpa-oral',doses:[],labs:[],baseline:1}).warning);
  }
  setLanguage('zh-CN');
});

test('localized calendar stays Monday-first and does not change ISO input or date grouping',()=>{
  const parsed=parsePickerValue('2026-10-13 16:30'),cells=pickerMonthCells(2026,10);
  for(const locale of ['en','zh-TW','ja','ko','es']) {
    setLanguage(locale);
    assert.deepEqual(parsePickerValue('2026-10-13 16:30'),parsed);
    assert.deepEqual(pickerMonthCells(2026,10),cells);
    const weekdays=journalWeekdays();assert.equal(weekdays.length,7);
    assert.equal(weekdays[0],new Intl.DateTimeFormat(locale,{weekday:'short',timeZone:'UTC'}).format(new Date('2026-01-05T00:00:00Z')));
    const markup=calendarPage(state,'2026-10-13');
    assert.match(markup,/value="2026-10"/);assert.match(markup,/data-dose-id="dose"/);assert.match(markup,/data-lab-id="lab"/);
    if(['en','ko','es'].includes(locale)) noHan(markup);
  }
  setLanguage('zh-CN');
});

test('chart labels and GAHT conditions translate while reference numbers and clinical scope remain intact',()=>{
  for(const locale of ['en','ko','es']) {
    setLanguage(locale);
    const result=compileHormoneModel({...state,at}).at(at);
    noHan(hormoneCards(result,['estradiol','cpa'],{referenceMode:'mtf'}));
    noHan(hormoneChart(state,3,true));
    const e2=gahtReference('estradiol','mtf'), testosterone=gahtReference('testosterone','ftm');
    assert.equal(e2.value,'100–200 pg/mL');assert.equal(testosterone.value,'400–700 ng/dL');
    assert.equal(gahtReference('cpa','mtf'),null);
    e2.paragraphs.forEach(noHan);testosterone.paragraphs.forEach(noHan);
  }
  setLanguage('zh-CN');
});
