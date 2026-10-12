import test from 'node:test';
import assert from 'node:assert/strict';
import { compileHormoneModel, analyzeHormones, buildHormoneSeries, REFERENCE_MODELS, REFERENCE_BASELINES, BASELINE_EVIDENCE } from '../src/hormones.js';
import { MEDICATIONS } from '../src/medications.js';
import { getProfile, normalizeLab, UNIT_FACTORS, calibrate, estimateAt } from '../src/pk.js';

const start = Date.parse('2026-10-01T00:00:00Z');
const at = hours => new Date(start + hours * 3_600_000).toISOString();
const dose = (routeId = 'e2-oral', amount = 1, hours = 0, extra = {}) => ({ id: `${routeId}-${hours}-${amount}`, routeId, amount, at: at(hours), ...extra });
const labsAt = (value, hours = 8, analyte = 'estradiol', unit = analyte === 'estradiol' ? 'pg/mL' : 'ng/dL') => ({ id: `lab-${analyte}-${hours}`, analyte, value, unit, at: at(hours) });
const zero = { estradiol: 0, testosterone: 0 };
const close = (actual, expected, tolerance = 1e-8) => assert.ok(Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)), `${actual} != ${expected}`);
const reference = (doses, hours, extra = {}) => analyzeHormones({ doses, at: at(hours), referenceBaselines: zero, ...extra });

test('mode baselines use published pre-GAHT medians with correct unit conversion, independent of personal baseline', () => {
  close(REFERENCE_BASELINES.mtf.estradiol, 105 * 272.38 / 1000);
  close(REFERENCE_BASELINES.mtf.testosterone, 19 * 288.42 / 10);
  close(REFERENCE_BASELINES.ftm.estradiol, 187 * 272.38 / 1000);
  close(REFERENCE_BASELINES.ftm.testosterone, 1.3 * 288.42 / 10);
  assert.equal(BASELINE_EVIDENCE.doi, '10.1002/jbmr.3762');
  const mtf = analyzeHormones({ at: at(8), mode: 'mtf', baselines: { estradiol: 8, testosterone: 9 } });
  assert.equal(mtf.estradiol.value, REFERENCE_BASELINES.mtf.estradiol);
  assert.equal(mtf.testosterone.value, REFERENCE_BASELINES.mtf.testosterone);
  assert.equal(mtf.estradiol.baselineSource, BASELINE_EVIDENCE);
  assert.equal(mtf.estradiol.status, 'reference');
  assert.equal(mtf.estradiol.reasonCode, 'baseline-only');
  assert.match(mtf.testosterone.warning, /背景假设/);
  const ftm = analyzeHormones({ at: at(8), mode: 'ftm', referenceBaselines: { estradiol: 15 } });
  assert.equal(ftm.estradiol.value, 15);
  assert.equal(ftm.testosterone.value, REFERENCE_BASELINES.ftm.testosterone);
  assert.equal(ftm.estradiol.baselineSource, null);
});

test('reference simulations carry the upstream parameter provenance rather than pretend to be observed peaks', () => {
  const ka = 0.32, ke = 0.41;
  const amount = 0.03 * ka / (ka - ke) * (Math.exp(-ke * 8) - Math.exp(-ka * 8));
  close(reference([dose('e2-oral', 1)], 8).estradiol.value, amount * 1e6 / 140);
  assert.equal(REFERENCE_MODELS['e2-oral'].anchor.kind, 'empirical-compartment-simulation');
  assert.equal(REFERENCE_MODELS['e2-ev-sublingual'].anchor.parameters.molecularRatio, 272.38 / 356.5);
  assert.equal(REFERENCE_MODELS['t-enanthate-im'].anchor.parameters.clearanceRate, 0.035);
});


test('same-hormone routes add their contributions and reference background exactly once', () => {
  const oral = reference([dose('e2-oral', 2)], 2).estradiol.value;
  const sl = reference([dose('e2-sublingual', 2)], 2).estradiol.value;
  const result = reference([dose('e2-oral', 2), dose('e2-sublingual', 2)], 2, { referenceBaselines: { estradiol: 20, testosterone: 450 } });
  close(result.estradiol.value, oral + sl + 20);
  assert.equal(result.estradiol.routeContributions.length, 2);
  assert.equal(result.testosterone.value, 450);
  assert.match(result.estradiol.warning, /基线只加一次/);
});

test('dose doubling changes absolute reference increments; there is no peak normalization', () => {
  const one = reference([dose('e2-oral', 1)], 5, { referenceBaselines: { estradiol: 20 } }).estradiol;
  const two = reference([dose('e2-oral', 2)], 5, { referenceBaselines: { estradiol: 20 } }).estradiol;
  close(two.value - 20, 2 * (one.value - 20));
  const before = reference([dose('e2-oral', 1)], -1).estradiol;
  const now = reference([dose('e2-oral', 1)], 0).estradiol;
  assert.equal(before.value, 0);
  assert.equal(now.value, 0); // Finite absorption: a swallowed dose has no instantaneous spike.
});

test('old single-compartment overrides are retained but cannot silently overwrite new multi-compartment parameters', () => {
  const base = reference([dose()], 8).estradiol.value;
  const changed = reference([dose()], 8, { modelConfigs: { 'e2-oral': { eliminationHalfLifeHours: 26 } } }).estradiol;
  close(changed.value, base);
  assert.match(changed.warning, /原版本单室半衰期设置已保留/);
  const heavier = reference([dose()], 8, { pkSettings: { bodyWeightKg: 140 } }).estradiol.value;
  close(heavier, base / 2);
});


test('E2 gel repeated-dose average obeys F times dose divided by clearance and volume', () => {
  const ds = Array.from({ length: 60 }, (_, i) => dose('e2-gel', 0.75, -24 * i));
  const model = compileHormoneModel({ doses: ds, referenceBaselines: zero, at: at(24) });
  const points = 2400;
  let avg = 0;
  for (let i = 0; i < points; i++) avg += model.at(at((i + 0.5) * 24 / points)).estradiol.value / points;
  close(avg, 0.75 * 0.05 / (0.41 * 24) * 1e6 / 140, 1e-5);
});

test('T gel reference uses systemic bioavailability once and native ng/dL conversion', () => {
  const ds = Array.from({ length: 60 }, (_, i) => dose('t-gel', 40.5, -24 * i));
  const model = compileHormoneModel({ doses: ds, referenceBaselines: zero, at: at(24) });
  let avg = 0;
  for (let i = 0; i < 2400; i++) avg += model.at(at((i + 0.5) / 100)).testosterone.value / 2400;
  close(avg, 40.5 * 0.10 / (0.5 * 24) * 1e5 / 70, 1e-5);
  assert.equal(REFERENCE_MODELS['t-gel'].anchor.parameters.bioavailability, 0.10);
});

test('patch release rate and actual removal duration produce the expected tail', () => {
  const ds = [dose('e2-patch', 50, 0, { durationHours: 84 })];
  const peak = reference(ds, 84).estradiol.value;
  close(peak, 50 / 24000 / 0.41 * (1 - Math.exp(-0.41 * 84)) * 1e6 / 140);
  close(reference(ds, 84 + Math.LN2 / 0.41).estradiol.value, peak / 2, 1e-7); // ISO timestamps have millisecond precision.
  const shorter = reference([dose('e2-patch', 50, 0, { durationHours: 48 })], 84).estradiol.value;
  assert.ok(shorter < peak / 20);
});

test('2 mg SL + 2 mg oral with a 200 pg/mL lab fits ONE combined amplitude', () => {
  const doses = [dose('e2-sublingual', 2), dose('e2-oral', 2)];
  const raw = reference(doses, 2).estradiol.value;
  const result = analyzeHormones({ doses, labs: [labsAt(200, 2)], at: at(2), baselines: { estradiol: 10 }, referenceBaselines: { estradiol: 50 } });
  close(result.estradiol.value, 200);
  close(result.estradiol.calibration.factor, 190 / raw);
  assert.equal(result.estradiol.status, 'calibrated');
  assert.equal(result.estradiol.calibration.method, 'shared-reference-scale');
  close(result.estradiol.routeContributions.reduce((sum, r) => sum + r.contribution, 0), 190);
  assert.equal(result.estradiol.baseline, 10);
  assert.match(result.estradiol.warning, /并未分别/);
});

test('adding a post-lab dose raises the subsequent estimate without changing calibration', () => {
  const labs = [labsAt(100, 8)];
  const original = analyzeHormones({ doses: [dose()], labs, at: at(30) });
  const added = analyzeHormones({ doses: [dose(), dose('e2-oral', 1, 24)], labs, at: at(30) });
  close(original.estradiol.calibration.factor, added.estradiol.calibration.factor);
  assert.ok(added.estradiol.value > original.estradiol.value);
});

test('a newly introduced route cannot silently inherit another route personal calibration', () => {
  const result = analyzeHormones({ doses: [dose(), dose('e2-sublingual', 1, 24)], labs: [labsAt(100, 8)], at: at(30) });
  assert.equal(result.estradiol.status, 'reference');
  assert.equal(result.estradiol.calibration.reasonCode, 'unrepresented-route');
});

test('CPA estimates its own concentration and never gets subtracted from testosterone', () => {
  const without = analyzeHormones({ doses: [dose('t-gel', 40.5)], at: at(8), mode: 'mtf' });
  const withCpa = analyzeHormones({ doses: [dose('t-gel', 40.5), dose('cpa-oral', 12.5)], at: at(8), mode: 'mtf' });
  close(withCpa.testosterone.value, without.testosterone.value);
  assert.equal(withCpa.testosterone.routeContributions.length, 1);
  assert.match(withCpa.testosterone.warning, /CPA自身浓度单独估计/);
  assert.equal(withCpa.estradiol.value, without.estradiol.value);
  assert.ok(withCpa.cpa.value > 0);
  assert.equal(withCpa.cpa.unit, 'ng/mL');
});

test('EV depot now has a reference amplitude and can calibrate together with oral E2', () => {
  const solo = reference([dose('e2-ev-im', 4)], 48).estradiol;
  assert.ok(solo.value > 0);
  assert.equal(solo.status, 'reference');
  const mixed = analyzeHormones({ doses: [dose('e2-ev-im', 4), dose('e2-oral', 1)], labs: [labsAt(200, 48)], at: at(48) }).estradiol;
  close(mixed.value, 200);
  assert.equal(mixed.calibration.method, 'shared-reference-scale');
  assert.equal(mixed.routeContributions.length, 2);
  assert.ok(mixed.referenceValue > 0);
});


test('latest lab retains its time and canonical unit without becoming a current value', () => {
  const result = analyzeHormones({ labs: [labsAt(7, 2, 'testosterone', 'nmol/L'), labsAt(200, 4)], at: at(8), mode: 'ftm' });
  assert.equal(result.estradiol.value, REFERENCE_BASELINES.ftm.estradiol);
  assert.equal(result.estradiol.latestLab.value, 200);
  assert.equal(result.estradiol.latestLab.at, at(4));
  close(result.testosterone.latestLab.value, 7 * 288.42 / 10);
  assert.equal(result.testosterone.value, REFERENCE_BASELINES.ftm.testosterone);
  assert.equal(result.testosterone.latestLab.unit, 'ng/dL');
});

test('E2 and T calibrate independently, with separate backgrounds added once', () => {
  const doses = [dose('e2-oral', 1), dose('t-enanthate-im', 50)];
  const labs = [labsAt(80, 8), labsAt(600, 24, 'testosterone')];
  const model = compileHormoneModel({ doses, labs, baselines: { estradiol: 5, testosterone: 25 }, at: at(24) });
  close(model.at(at(8)).estradiol.value, 80);
  close(model.at(at(24)).testosterone.value, 600);
  assert.notEqual(model.calibrations.estradiol.factor, model.calibrations.testosterone.factor);
});

test('invalid data is reported; unavailable is null rather than a fabricated concentration', () => {
  for (const change of [
    { doses: [dose('e2-oral', -1)] },
    { pkSettings: { bodyWeightKg: 0 } },
    { referenceBaselines: { estradiol: -1 } },
    { doses: [dose('unknown', 1)] },
  ]) {
    const result = analyzeHormones({ doses: [dose()], at: at(8), ...change }).estradiol;
    assert.equal(result.value, null);
    assert.equal(result.status, 'unavailable');
  }
  const badLab = analyzeHormones({ doses: [dose()], labs: [labsAt(100, 8, 'estradiol', 'ng/dL')], at: at(8) }).estradiol;
  assert.equal(badLab.status, 'reference');
  assert.match(badLab.warning, /单位/);
});

test('compile snapshots inputs and series shares the same fitted calibration object', () => {
  const doses = [dose()], labs = [labsAt(100, 8)];
  const model = compileHormoneModel({ doses, labs, at: at(24) });
  const value = model.at(at(12)).estradiol.value;
  doses[0].amount = 999;
  labs[0].value = 999;
  close(model.at(at(12)).estradiol.value, value);
  const series = model.series({ start: at(0), end: at(24), points: 201 });
  assert.equal(series.length, 201);
  assert.equal(series[0].at, at(0));
  assert.equal(series.at(-1).at, at(24));
  assert.ok(series.every(point => point.estradiol.calibration === model.calibrations.estradiol));
  assert.ok(series.every(point => finiteNumber(point.estradiol.value)));
});
function finiteNumber(value) { return typeof value === 'number' && Number.isFinite(value); }

test('series wrapper returns both hormones without normalized exposure axes', () => {
  const series = buildHormoneSeries({ doses: [dose('e2-oral', 2)], at: at(24), start: at(0), end: at(24), points: 4 });
  assert.equal(series.length, 4);
  close(series[1].estradiol.value, REFERENCE_BASELINES.mtf.estradiol + 2 * reference([dose()], 8).estradiol.value);
  assert.equal(series[1].estradiol.unit, 'pg/mL');
  assert.equal(series[1].testosterone.unit, 'ng/dL');
  assert.equal(series[1].testosterone.value, REFERENCE_BASELINES.mtf.testosterone);
  assert.deepEqual(buildHormoneSeries({ start: at(0), end: at(0) }), []);
});

test('every record-only hormone blocks only its own total, including baseline-only and mixed records', () => {
  const entries = MEDICATIONS.filter(m => m.model === 'record-only' && ['estradiol', 'testosterone'].includes(m.analyte));
  assert.ok(entries.length > 10);
  for (const entry of entries) {
    const other = entry.analyte === 'estradiol' ? 'testosterone' : 'estradiol';
    for (const existing of [[], [dose('e2-oral'), dose('t-gel', 40.5)]]) {
      const before = reference(existing, 8);
      const after = reference([...existing, dose(entry.id, 2)], 8);
      assert.equal(after[entry.analyte].value, null, entry.id);
      assert.equal(after[entry.analyte].referenceValue, null, entry.id);
      assert.equal(after[entry.analyte].reasonCode, 'record-only-hormone', entry.id);
      assert.deepEqual(after[entry.analyte].unsupportedMedications.map(m => m.routeId), [entry.id]);
      close(after[other].value, before[other].value);
      assert.equal(after[other].status, before[other].status);
    }
  }
});

test('all remaining record-only medicines do not alter E2, T or CPA totals', () => {
  const entries = MEDICATIONS.filter(m => !['estradiol', 'testosterone', 'cpa'].includes(m.analyte));
  assert.ok(entries.length > 5);
  const existing = [dose('e2-oral'), dose('t-gel', 40.5)];
  const before = reference(existing, 8);
  for (const entry of entries) {
    const after = reference([...existing, dose(entry.id, 2)], 8);
    for (const a of ['estradiol', 'testosterone', 'cpa']) {
      close(after[a].value, before[a].value);
      assert.equal(after[a].status, 'reference');
    }
    assert.match(after.testosterone.warning, /记录与提醒/);
  }
});

test('EV sublingual supports an ester-aware reference and personal lab amplitude', () => {
  const raw = reference([dose('e2-ev-sublingual', 2)], 1).estradiol;
  assert.ok(raw.value > 0);
  assert.notEqual(raw.value, reference([dose('e2-sublingual', 2)], 1).estradiol.value);
  const model = compileHormoneModel({ doses: [dose('e2-ev-sublingual', 2)], labs: [labsAt(200, 1)], at: at(8) });
  close(model.at(at(1)).estradiol.value, 200);
  const result = model.at(at(8));
  assert.ok(result.estradiol.value > 0);
  assert.equal(result.estradiol.status, 'calibrated');
  assert.equal(result.estradiol.calibration.n, 1);
  assert.equal(result.estradiol.calibration.sampleDiagnostics[0].status, 'included');
  assert.equal(result.testosterone.status, 'reference');
});


test('future record-only hormones do not block earlier values, and are never assumed washed out', () => {
  const model = compileHormoneModel({ doses: [dose('e2-spray', 1.53, 24)], at: at(8) });
  assert.equal(model.at(at(8)).estradiol.status, 'reference');
  assert.equal(model.at(at(24)).estradiol.value, null);
  assert.equal(model.at(at(24 * 365)).estradiol.value, null);
  assert.equal(model.at(at(24 * 365)).testosterone.status, 'reference');
});

test('empirical source assumptions appear alongside values', () => {
  const result = reference([dose('e2-oral'), dose('t-gel', 40.5)], 8);
  assert.match(result.estradiol.warning, /不是来源研究观测峰值或临床验证/);
  assert.match(result.testosterone.warning, /药代模型经验参考参数/);
});


test('oral reference area integrates to F times dose over clearance, without peak normalization', () => {
  const model = compileHormoneModel({ doses: [dose('e2-oral', 1)], referenceBaselines: zero, at: at(240) });
  let area = 0;
  const step = 0.01;
  for (let h = step / 2; h < 240; h += step) area += model.at(at(h)).estradiol.value * step;
  close(area, 0.03 / 0.41 * 1e6 / 140, 0.00001);
});


test('CPA source is TWO 50 mg tablets: 100 mg gives about 285 ng/mL at 3 hours', () => {
  const result = reference([dose('cpa-oral', 100)], 3).cpa;
  close(result.value, 285);
  close(reference([dose('cpa-oral', 50)], 3).cpa.value, 142.5);
  assert.equal(result.baseline, 0);
  assert.equal(result.baselineSource, null);
  assert.equal(result.referenceBaselineSource, null);
  assert.equal(REFERENCE_MODELS['cpa-oral'].anchor.dose, 100);
  assert.equal(REFERENCE_MODELS['cpa-oral'].anchor.reportedAbsoluteBioavailability, 0.88);
  assert.match(result.warning, /不再另乘88%/);
  const cfg = getProfile('cpa-oral').defaults;
  const ka = Math.LN2 / cfg.absorptionHalfLifeHours, ke = Math.LN2 / cfg.eliminationHalfLifeHours;
  close(Math.log(ka / ke) / (ka - ke), 3);
  assert.ok(reference([dose('cpa-oral', 100)], 2.9).cpa.value < result.value);
  assert.ok(reference([dose('cpa-oral', 100)], 3.1).cpa.value < result.value);
});

test('CPA no endogenous background, no instantaneous spike, terminal half-life and dose superposition', () => {
  for (const mode of ['mtf', 'ftm']) assert.equal(analyzeHormones({ mode, at: at(8) }).cpa.value, 0);
  close(reference([dose('cpa-oral', 12.5)], 0).cpa.value, 0);
  const tail = reference([dose('cpa-oral', 12.5)], 24).cpa.value;
  close(reference([dose('cpa-oral', 12.5)], 24 + 43.9).cpa.value, tail / 2);
  const combined = reference([dose('cpa-oral', 12.5), dose('cpa-oral', 12.5, 24)], 27).cpa.value;
  close(combined, reference([dose('cpa-oral', 12.5)], 27).cpa.value + reference([dose('cpa-oral', 12.5)], 3).cpa.value);
  const invalid = reference([dose('cpa-oral', 12.5)], 3, { referenceBaselines: { cpa: 5 } }).cpa;
  assert.equal(invalid.value, null);
  assert.match(invalid.warning, /背景须为0/);
});

test('CPA units use molecular mass 416.94 independently of testosterone nmol/L conversion', () => {
  const converted = normalizeLab(labsAt(100, 3, 'cpa', 'nmol/L'));
  close(converted.value, 41.694);
  close(UNIT_FACTORS.cpaNmolPerNgMl, 1000 / 416.94);
  assert.equal(converted.unit, 'ng/mL');
  assert.equal(normalizeLab(labsAt(41.694, 3, 'cpa', 'ng/mL')).value, 41.694);
  assert.equal(normalizeLab(labsAt(100, 3, 'cpa', 'ng/dL')).valid, false);
  assert.equal(normalizeLab(labsAt(100, 3, 'cpa', 'pg/mL')).valid, false);
});

test('CPA calibrates independently and cannot use an E2/T lab as a CPA result', () => {
  const doses = [dose('e2-oral'), dose('cpa-oral', 12.5), dose('t-gel', 40.5)];
  const cpaLab = labsAt(100, 3, 'cpa', 'nmol/L');
  const model = compileHormoneModel({ doses, labs: [labsAt(70, 8), cpaLab], at: at(12) });
  close(model.at(at(3)).cpa.value, 41.694);
  assert.equal(model.at().cpa.status, 'calibrated');
  assert.equal(model.at().testosterone.status, 'reference');
  assert.equal(model.at().cpa.calibration.n, 1);
  assert.equal(model.at().cpa.latestLab.unit, 'ng/mL');
  assert.doesNotMatch(model.at().cpa.warning, /真实内源激素/);
  const series = model.series({ start: at(0), end: at(24), points: 201 });
  assert.ok(series.every(p => p.cpa.calibration === model.calibrations.cpa));
  // Legacy single-route API remains compatible with the new CPA profile.
  const cal = calibrate({ doses, labs: [cpaLab], routeId: 'cpa-oral' });
  const value = estimateAt({ doses, routeId: 'cpa-oral', calibration: cal, at: at(3) });
  close(value.value, 41.694);
  assert.equal(value.unit, 'ng/mL');
});
