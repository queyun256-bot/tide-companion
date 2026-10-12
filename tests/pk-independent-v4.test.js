import test from 'node:test';
import assert from 'node:assert/strict';
import { compileHormoneModel } from '../src/hormones.js';

// Independent audit oracle: integrate the defining mass-balance ODE with RK4.
// It deliberately does not import the application's analytic/matrix kernels.
// Parameters frozen from Oyama-s-HRT-Tracker fa48eb72a80f2adc65fec0b0045ec25204ad7250.
const epoch = Date.parse('2026-10-01T00:00:00Z');
const at = hours => new Date(epoch + hours * 3_600_000).toISOString();
const zero = { estradiol: 0, testosterone: 0, cpa: 0 };
const E2_FACTOR = 1e9 / (2 * 70 * 1000);
const T_FACTOR = 1e8 / (1 * 70 * 1000);
const dose = (routeId, amount, hours = 0, extra = {}) => ({ id: `${routeId}-${amount}-${hours}`, routeId, amount, at: at(hours), ...extra });
const modelFor = (doses, extra = {}) => compileHormoneModel({ doses, at: at(500), referenceBaselines: zero, pkSettings: { bodyWeightKg: 70, sublingualFraction: .11 }, ...extra });
const close = (actual, expected, label, relative = 2e-7, absolute = 2e-8) => {
  assert.ok(Number.isFinite(actual), `${label}: non-finite ${actual}`);
  assert.ok(Math.abs(actual - expected) <= Math.max(absolute, Math.abs(expected) * relative), `${label}: ${actual} != ODE ${expected}`);
};

function integrate(rates, initialMass, hours) {
  if (hours <= 0) return 0;
  const state = [initialMass, ...Array(rates.length - 1).fill(0)];
  const steps = Math.max(1, Math.ceil(hours / .005));
  const h = hours / steps;
  const derivative = values => rates.map((rate, index) => -rate * values[index] + (index ? rates[index - 1] * values[index - 1] : 0));
  for (let n = 0; n < steps; n++) {
    const k1 = derivative(state);
    const k2 = derivative(state.map((value, i) => value + h * k1[i] / 2));
    const k3 = derivative(state.map((value, i) => value + h * k2[i] / 2));
    const k4 = derivative(state.map((value, i) => value + h * k3[i]));
    for (let i = 0; i < state.length; i++) state[i] += h * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]) / 6;
  }
  return state.at(-1);
}

const cases = [
  { route: 'e2-oral', amount: 2, analyte: 'estradiol', unit: 'pg/mL', factor: E2_FACTOR, branches: [[1, .03, [.32, .41]]] },
  // Upstream's oral path intentionally uses the 2-compartment kernel. An oral EV
  // kh parameter exists in its resolver but is NOT applied by oneCompAmount.
  { route: 'e2-ev-oral', amount: 2, analyte: 'estradiol', unit: 'pg/mL', factor: E2_FACTOR, branches: [[1, .03 * 272.38 / 356.5, [.05, .41]]] },
  { route: 'e2-sublingual', amount: 2, analyte: 'estradiol', unit: 'pg/mL', factor: E2_FACTOR, branches: [[.11, 1, [1.8, .41]], [.89, .03, [.32, .41]]] },
  { route: 'e2-ev-sublingual', amount: 2, analyte: 'estradiol', unit: 'pg/mL', factor: E2_FACTOR, branches: [[.11, 272.38 / 356.5, [1.8, .07, .41]], [.89, .03 * 272.38 / 356.5, [.05, .41]]] },
  { route: 'e2-gel', amount: .75, analyte: 'estradiol', unit: 'pg/mL', factor: E2_FACTOR, branches: [[1, .05, [.0193, .41]]] },
  { route: 't-gel', amount: 50, analyte: 'testosterone', unit: 'ng/dL', factor: T_FACTOR, branches: [[1, .1, [.05, .5]]] },
  { route: 'e2-eb-im', amount: 5, analyte: 'estradiol', unit: 'pg/mL', factor: E2_FACTOR, branches: [[.9, .1092 * 272.38 / 376.5, [.144, .09, .041]], [.1, .1092 * 272.38 / 376.5, [.114, .09, .041]]] },
  { route: 'e2-ev-im', amount: 5, analyte: 'estradiol', unit: 'pg/mL', factor: E2_FACTOR, branches: [[.4, .0623 * 272.38 / 356.5, [.0216, .07, .041]], [.6, .0623 * 272.38 / 356.5, [.0138, .07, .041]]] },
  { route: 'e2-ec-im', amount: 5, analyte: 'estradiol', unit: 'pg/mL', factor: E2_FACTOR, branches: [[.229164549, .1173 * 272.38 / 396.58, [.005035046, .045, .041]], [1 - .229164549, .1173 * 272.38 / 396.58, [.004510574, .045, .041]]] },
  { route: 'e2-een-im', amount: 5, analyte: 'estradiol', unit: 'pg/mL', factor: E2_FACTOR, branches: [[.05, .12 * 272.38 / 384.56, [.001, .015, .041]], [.95, .12 * 272.38 / 384.56, [.005, .015, .041]]] },
  { route: 't-cypionate-im', amount: 100, analyte: 'testosterone', unit: 'ng/dL', factor: T_FACTOR, branches: [[.35, .025 * 288.42 / 412.6, [.025, .2, .035]], [.65, .025 * 288.42 / 412.6, [.005, .2, .035]]] },
  // The TE fast branch has ka === ke. This is a removable singularity, not zero.
  { route: 't-enanthate-im', amount: 100, analyte: 'testosterone', unit: 'ng/dL', factor: T_FACTOR, branches: [[.4, .025 * 288.42 / 400.59, [.035, .2, .035]], [.6, .025 * 288.42 / 400.59, [.008, .2, .035]]] },
  { route: 't-undecanoate-im', amount: 1000, analyte: 'testosterone', unit: 'ng/dL', factor: T_FACTOR, branches: [[.1, .025 * 288.42 / 456.7, [.008, .2, .035]], [.9, .025 * 288.42 / 456.7, [.0009, .2, .035]]] },
];

for (const item of cases) test(`independent ODE: ${item.route}, ester mass and central concentration`, () => {
  const model = modelFor([dose(item.route, item.amount)]);
  for (const hours of [.001, .1, 1, 4, 8, 24, 96]) {
    const expected = item.factor * item.branches.reduce((total, [fraction, bio, rates]) => total + integrate(rates, item.amount * fraction * bio, hours), 0);
    const actual = model.at(at(hours))[item.analyte];
    assert.equal(actual.unit, item.unit);
    assert.equal(actual.status, 'reference');
    close(actual.value, expected, `${item.route} @ ${hours} h`);
  }
});

test('independent zero-order oracle: E2 μg/day and T mg/day patches differ by a factor 1000 in input units', () => {
  for (const item of [{ route: 'e2-patch', amount: 50, mgDay: .05, ke: .41, analyte: 'estradiol', factor: E2_FACTOR },
    { route: 't-patch', amount: 5, mgDay: 5, ke: .5, analyte: 'testosterone', factor: T_FACTOR }]) {
    const duration = 24;
    const model = modelFor([dose(item.route, item.amount, 0, { durationHours: duration })]);
    for (const hours of [0, .1, 4, 24, 25, 36]) {
      const expected = item.mgDay / 24 / item.ke * (1 - Math.exp(-item.ke * Math.min(hours, duration))) * Math.exp(-item.ke * Math.max(0, hours - duration)) * item.factor;
      close(model.at(at(hours))[item.analyte].value, expected, `${item.route} @ ${hours} h`);
    }
  }
});

test('EV SL public flow: uncalibrated reference, pmol/L lab, future concentration and one baseline', () => {
  const doses = [dose('e2-ev-sublingual', 2), dose('e2-oral', 1)];
  const raw = modelFor(doses);
  const base = 12;
  const labPg = 180;
  const model = modelFor(doses, { baselines: { estradiol: base }, referenceBaselines: { ...zero, estradiol: 28.6 },
    labs: [{ id: 'audit-lab', analyte: 'estradiol', value: labPg * 1000 / 272.38, unit: 'pmol/L', at: at(4) }] });
  close(model.at(at(4)).estradiol.value, labPg, 'lab crossing');
  close(model.at(at(8)).estradiol.value, base + (labPg - base) / raw.at(at(4)).estradiol.value * raw.at(at(8)).estradiol.value, 'future calibrated prediction');
  assert.equal(model.at(at(8)).estradiol.status, 'calibrated');
  assert.equal(model.at(at(8)).estradiol.routeContributions.length, 2);
  assert.equal(model.at(at(8)).testosterone.value, 0);
  assert.equal(model.at(at(8)).cpa.value, 0);
});

test('body-weight scaling is applied exactly once and never changes CPA tag-based anchor', () => {
  const doses = [dose('e2-ev-sublingual', 2), dose('t-enanthate-im', 100), dose('cpa-oral', 100)];
  const light = modelFor(doses), heavy = modelFor(doses, { pkSettings: { bodyWeightKg: 140, sublingualFraction: .11 } });
  for (const analyte of ['estradiol', 'testosterone']) close(heavy.at(at(8))[analyte].value, light.at(at(8))[analyte].value / 2, analyte);
  close(light.at(at(3)).cpa.value, 285, 'CPA source anchor');
  close(heavy.at(at(3)).cpa.value, 285, 'CPA independent source anchor');
});

test('EV SL θ=0 matches oral EV while θ=1 retains hydrolysis instead of free E2 kinetics', () => {
  const oral = modelFor([dose('e2-ev-oral', 2)]);
  const swallowed = modelFor([dose('e2-ev-sublingual', 2)], { pkSettings: { bodyWeightKg: 70, sublingualFraction: 0 } });
  const mucosal = modelFor([dose('e2-ev-sublingual', 2)], { pkSettings: { bodyWeightKg: 70, sublingualFraction: 1 } });
  for (const hours of [.1, 1, 8, 24]) {
    close(swallowed.at(at(hours)).estradiol.value, oral.at(at(hours)).estradiol.value, `θ=0 @ ${hours}`);
    close(mucosal.at(at(hours)).estradiol.value, integrate([1.8, .07, .41], 2 * 272.38 / 356.5, hours) * E2_FACTOR, `θ=1 @ ${hours}`);
  }
});

const calibrationFixture = futureDose => modelFor([dose('e2-ev-sublingual', 2), futureDose], {
  at: at(8), labs: [{ id: 'past-lab', analyte: 'estradiol', value: 180, unit: 'pg/mL', at: at(4) }],
});

test('future new route does not erase current calibration or inherit its multiplier when activated', () => {
  const model = calibrationFixture(dose('e2-patch', 50, 48, { durationHours: 24 }));
  assert.equal(model.at(at(8)).estradiol.status, 'calibrated');
  close(model.at(at(4)).estradiol.value, 180, 'past lab before new future route');
  assert.equal(model.at(at(49)).estradiol.status, 'reference');
  assert.match(model.at(at(49)).estradiol.warning, /未被化验覆盖/);
});

test('future invalid patch does not poison a valid current EV SL calibration', () => {
  const model = calibrationFixture(dose('e2-patch', 50, 48, { durationHours: 0 }));
  assert.equal(model.at(at(8)).estradiol.status, 'calibrated');
  close(model.at(at(4)).estradiol.value, 180, 'past lab before invalid future patch');
  assert.equal(model.at(at(49)).estradiol.status, 'unavailable');
  assert.equal(model.at(at(49)).estradiol.value, null);
});

test('future invalid dose on the same route is excluded until its timestamp', () => {
  const model = calibrationFixture(dose('e2-ev-sublingual', -2, 48));
  assert.equal(model.at(at(8)).estradiol.status, 'calibrated');
  close(model.at(at(4)).estradiol.value, 180, 'past lab before invalid future dose');
  assert.equal(model.at(at(49)).estradiol.status, 'unavailable');
});

test('unknown future drug cannot block current personal fits before it exists', () => {
  const model = calibrationFixture(dose('unknown-audit-drug', 2, 48));
  assert.equal(model.at(at(8)).estradiol.status, 'calibrated');
  close(model.at(at(4)).estradiol.value, 180, 'past lab before unknown future drug');
  assert.equal(model.at(at(49)).estradiol.status, 'unavailable');
});
