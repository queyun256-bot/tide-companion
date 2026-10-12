import test from 'node:test';
import { twoCompartment, threeCompartment } from '../src/pk-mahiro.js';
import assert from 'node:assert/strict';
import { PROFILES, UNIT_FACTORS, getProfile, doseShape, normalizeLab, calibrate, estimateAt, buildSeries } from '../src/pk.js';

const origin = Date.parse('2026-10-01T00:00:00Z');
const at = hours => new Date(origin + hours * 3_600_000).toISOString();
const routeId = 'e2-oral';
const dose = (hour = 0, amount = 2, route = routeId) => ({ id: `dose-${hour}-${route}`, routeId: route, amount, at: at(hour) });
const shape = (hour, doses = [dose()], config = {}) => estimateAt({ doses, routeId, at: at(hour), config }).shape;
const lab = (hour, factor = 80, baseline = 0, doses = [dose()]) => ({ id: `lab-${hour}`, analyte: 'estradiol', value: baseline + factor * shape(hour, doses), unit: 'pg/mL', at: at(hour) });
const close = (actual, expected, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)), `${actual} != ${expected}`);

test('all sixteen profiles expose documented dose units and validated configuration defaults', () => {
  assert.equal(PROFILES.length, 16);
  assert.equal(new Set(PROFILES.map(p => p.id)).size, 16);
  assert.equal(getProfile('e2-patch').unit, 'μg/day');
  for (const p of PROFILES) {
    assert.ok(p.sources.length);
    const value = estimateAt({ doses: [dose(0, 1, p.id)], routeId: p.id, at: at(24) });
    assert.equal(value.status, 'uncalibrated');
    assert.equal(value.value, null);
    assert.ok(value.shape > 0 && Number.isFinite(value.shape));
  }
});

test('legacy CPA calibration and estimation reject positive background instead of inventing pre-dose CPA', () => {
  const cpaRoute = 'cpa-oral';
  const doses = [dose(0, 12.5, cpaRoute)];
  const labs = [{ analyte: 'cpa', value: 50, unit: 'ng/mL', at: at(3) }];
  const rejected = calibrate({ doses, labs, routeId: cpaRoute, baseline: 10 });
  assert.equal(rejected.status, 'invalid');
  assert.equal(rejected.factor, null);
  assert.match(rejected.warning, /CPA.*背景须为0/);

  const valid = calibrate({ doses, labs, routeId: cpaRoute, baseline: 0 });
  assert.equal(valid.status, 'calibrated');
  for (const calibration of [null, valid]) {
    for (const hour of [-1, 3]) {
      const estimate = estimateAt({ doses, routeId: cpaRoute, baseline: 10, calibration, at: at(hour) });
      assert.equal(estimate.status, 'invalid');
      assert.equal(estimate.value, null);
      assert.match(estimate.warning, /CPA.*背景须为0/);
    }
  }
  close(estimateAt({ doses, routeId: cpaRoute, calibration: valid, baseline: 0, at: at(-1) }).value, 0);
  close(estimateAt({ doses, routeId: cpaRoute, calibration: valid, baseline: 0, at: at(3) }).value, 50);
});

test('a dose has no effect before or exactly at administration', () => {
  close(shape(-1), 0);
  close(shape(0), 0);
  assert.ok(shape(1) > 0);
  assert.equal(shape(1_000_000), 0);
});

test('Bateman result agrees with direct analytical expression', () => {
  const ka = 0.32, ke = 0.41, t = 8;
  close(shape(t), 2 * 0.03 * ka / (ka - ke) * (Math.exp(-ke * t) - Math.exp(-ka * t)));
});

test('identical and nearly identical rates use exact stable limits', () => {
  const k = Math.LN2 / 8;
  close(twoCompartment(8, k, k), Math.LN2 * 0.5);
  close(twoCompartment(8, k, k + 1e-12), Math.LN2 * 0.5);
  close(threeCompartment(8, k, k, k), 0.5 * (k * 8) ** 2 * Math.exp(-k * 8));
  close(threeCompartment(8, k, k + 1e-12, k - 1e-12), 0.5 * (k * 8) ** 2 * Math.exp(-k * 8));
});

test('slow absorption / fast elimination never overflows and remains nonnegative', () => {
  for (const hour of [0.0001, 1, 100, 100000]) {
    const value = twoCompartment(hour, Math.LN2 / 192, Math.LN2 / 0.001);
    assert.ok(Number.isFinite(value) && value >= 0);
  }
});

test('known non-hormonal records do not block legacy E2 or CPA calibration', () => {
  const doses = [dose(), dose(0, 50, 'spiro-oral')];
  const c = calibrate({ doses, labs: [lab(4)], routeId });
  assert.equal(c.status, 'calibrated');
  close(estimateAt({ doses, routeId, at: at(4), calibration: c }).value, lab(4).value);
  const cpaDoses = [dose(0, 12.5, 'cpa-oral'), dose(0, 50, 'spiro-oral')];
  const cpaLab = { analyte: 'cpa', value: 40, unit: 'ng/mL', at: at(3) };
  const cpa = calibrate({ doses: cpaDoses, labs: [cpaLab], routeId: 'cpa-oral' });
  assert.equal(cpa.status, 'calibrated');
  close(estimateAt({ doses: cpaDoses, routeId: 'cpa-oral', at: at(3), calibration: cpa }).value, 40);
});

test('superposition uses every earlier dose, ignores future doses and other analytes', () => {
  const combined = shape(30, [dose(0), dose(24), dose(48), dose(0, 50, 't-gel')]);
  close(combined, shape(30) + shape(6));
  close(shape(8, [dose(0, 4)]), 2 * shape(8));
});

test('patch rate converts μg/day to mg/hour and declines continuously after removal', () => {
  const p = getProfile('e2-patch');
  const d = { ...dose(0, 100, p.id), durationHours: 48 };
  const valueAt = hour => doseShape({ dose: d, profile: p, at: at(hour) });
  const ke = 0.41;
  close(valueAt(24), 100 / 24000 / ke * (1 - Math.exp(-ke * 24)));
  close(valueAt(48 + Math.LN2 / ke), valueAt(48) / 2);
  close(valueAt(48 + 1e-7), valueAt(48), 1e-7);
  const replacement = { ...d, at: at(48) };
  close(doseShape({ dose: replacement, profile: p, at: at(48) }), 0);
});

test('lab conversion is analyte specific and accepts equivalent SI units', () => {
  close(normalizeLab({ ...lab(4), value: 100 * UNIT_FACTORS.estradiolPmolPerPg, unit: 'pmol/L' }).value, 100);
  close(normalizeLab({ ...lab(4), analyte: 'testosterone', value: 500 * UNIT_FACTORS.testosteroneNmolPerNgDl, unit: 'nmol/L' }).value, 500);
  close(normalizeLab({ ...lab(4), analyte: 'testosterone', value: 5, unit: 'ng/mL' }).value, 500);
  assert.equal(normalizeLab({ ...lab(4), unit: 'ng/dL' }).valid, false);
  assert.equal(normalizeLab({ ...lab(4), value: -1 }).valid, false);
  assert.equal(normalizeLab({ ...lab(4), unit: '' }).valid, false);
});

test('multiple noiseless samples recover scale and fixed baseline exactly', () => {
  const doses = [dose(0), dose(24)];
  const labs = [4, 10, 30].map(hour => lab(hour, 80, 12, doses));
  const calibration = calibrate({ doses, labs, routeId, baseline: 12 });
  assert.equal(calibration.status, 'calibrated');
  assert.equal(calibration.n, 3);
  close(calibration.factor, 80);
  close(calibration.rmse, 0);
  const current = estimateAt({ doses, routeId, at: at(32), calibration, baseline: 12 });
  close(current.value, 12 + 80 * shape(32, doses));
});

test('least squares fits a single amplitude, not the sample mean', () => {
  const x1 = shape(2), x2 = shape(10);
  const labs = [{ ...lab(2), value: 40 }, { ...lab(10), value: 120 }];
  const result = calibrate({ doses: [dose()], labs, routeId });
  const expected = (x1 * 40 + x2 * 120) / (x1 * x1 + x2 * x2);
  close(result.factor, expected);
  close(result.rmse, Math.sqrt(((expected * x1 - 40) ** 2 + (expected * x2 - 120) ** 2) / 2));
});

test('single point fit is allowed only with explicit limitations', () => {
  const result = calibrate({ doses: [dose()], labs: [lab(4)], routeId });
  close(result.factor, 80);
  assert.match(result.warning, /仅1个样本/);
  assert.match(result.warning, /基线设为0/);
});

test('unusable exposure and inconsistent baseline never manufacture a scale', () => {
  for (const options of [
    { doses: [], labs: [lab(4)] },
    { doses: [dose()], labs: [lab(-1)] },
    { doses: [dose()], labs: [lab(4)], baseline: 100000 },
    { doses: [dose()], labs: [{ ...lab(4), value: 0 }] },
  ]) assert.equal(calibrate({ ...options, routeId }).factor, null);
});

test('estradiol and testosterone labs are independent; invalid units are explicitly excluded', () => {
  const result = calibrate({ doses: [dose()], routeId, labs: [lab(4), { ...lab(8), unit: 'wrong' }, { ...lab(10), analyte: 'testosterone', unit: 'ng/dL' }] });
  assert.equal(result.n, 1);
  assert.equal(result.excluded, 1);
  close(result.factor, 80);
  assert.match(result.warning, /单位/);
});

test('mixed routes are refused, including after a formerly valid calibration', () => {
  const doses = [dose()];
  const calibration = calibrate({ doses, labs: [lab(4)], routeId });
  const mixed = [...doses, dose(1, 1, 'e2-gel')];
  assert.equal(calibrate({ doses: mixed, labs: [lab(4)], routeId }).factor, null);
  assert.match(calibrate({ doses: mixed, labs: [lab(4)], routeId }).warning, /其他或未知途径/);
  assert.equal(estimateAt({ doses: mixed, routeId, at: at(8), calibration }).value, null);
  assert.equal(calibrate({ doses: [...doses, dose(0, 50, 't-gel')], labs: [lab(4)], routeId }).status, 'calibrated');
});

test('changing model, baseline, history or route invalidates calibration; new later doses do not', () => {
  const doses = [dose()];
  const calibration = calibrate({ doses, labs: [lab(4)], routeId });
  for (const change of [
    { config: { bodyWeightKg: 80 } },
    { baseline: 1 },
    { doses: [dose(0, 3)] },
    { routeId: 'e2-gel' },
  ]) assert.equal(estimateAt({ doses, routeId, at: at(30), calibration, ...change }).value, null);
  const result = estimateAt({ doses: [...doses, dose(24)], routeId, at: at(30), calibration });
  close(result.value, 80 * shape(30, [...doses, dose(24)]));
});

test('invalid data returns structured errors instead of NaN concentrations', () => {
  for (const change of [
    { config: { bodyWeightKg: 0 } },
    { config: { sublingualFraction: Infinity } },
    { config: { bodyWeightKg: '70' } },
    { at: '2026-10-01T12:00:00' },
    { doses: [dose(0, -5)] },
    { baseline: NaN },
    { routeId: 'unsupported' },
  ]) {
    const result = estimateAt({ doses: [dose()], routeId, at: at(4), ...change });
    assert.equal(result.status, 'invalid');
    assert.equal(result.value, null);
    assert.ok(result.warning);
  }
  assert.equal(estimateAt({ doses: [{ ...dose(0, 100, 'e2-patch'), durationHours: -4 }], routeId: 'e2-patch', at: at(4) }).status, 'invalid');
});

test('ISO offsets represent the same instant and series endpoints are inclusive', () => {
  const utc = estimateAt({ doses: [dose()], routeId, at: at(4) });
  const offset = estimateAt({ doses: [dose()], routeId, at: '2026-10-01T12:00:00+08:00' });
  close(utc.shape, offset.shape);
  const points = buildSeries({ doses: [dose()], routeId, start: at(0), end: at(24), points: 3 });
  assert.deepEqual(points.map(point => point.at), [at(0), at(12), at(24)]);
  assert.equal(points[1].y, points[1].shape);
  assert.equal(points[1].value, null);
  assert.deepEqual(buildSeries({ start: at(2), end: at(1) }), []);
});

test('testosterone calibration with nmol/L reports canonical ng/dL', () => {
  const tRoute = 't-cypionate-im';
  const doses = [dose(0, 50, tRoute)];
  const x = estimateAt({ doses, routeId: tRoute, at: at(72) }).shape;
  const labs = [{ analyte: 'testosterone', at: at(72), value: (20 + x * 9) * UNIT_FACTORS.testosteroneNmolPerNgDl, unit: 'nmol/L' }];
  const calibration = calibrate({ doses, labs, routeId: tRoute, baseline: 20 });
  close(calibration.factor, 9);
  const result = estimateAt({ doses, routeId: tRoute, calibration, baseline: 20, at: at(72) });
  close(result.value, 20 + x * 9);
  assert.equal(result.unit, 'ng/dL');
});
