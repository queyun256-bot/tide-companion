import test from 'node:test';
import assert from 'node:assert/strict';
import { compileHormoneModel } from '../src/hormones.js';

const dose = { routeId: 'e2-ev-sublingual', amount: 2, at: '2026-10-01T00:00:00Z' };
test('invalid query times with active EV records return unavailable rather than throwing', () => {
  const model = compileHormoneModel({ doses: [dose], at: '2026-10-01T08:00:00Z' });
  for (const at of [NaN, Infinity, -Infinity, 1e300, '2026-10-01T08:00:00', new Date(NaN)]) {
    const point = model.at(at);
    for (const analyte of ['estradiol', 'testosterone', 'cpa']) {
      assert.equal(point[analyte].status, 'unavailable');
      assert.equal(point[analyte].value, null);
      assert.match(point[analyte].warning, /时间无效/);
    }
  }
});

test('calibration diagnostics explain future, duplicate, invalid-unit and pre-dose samples', () => {
  const model = compileHormoneModel({ doses: [dose], at: '2026-10-01T08:00:00Z', labs: [
    { id: 'ok', analyte: 'estradiol', value: 180, unit: 'pg/mL', at: '2026-10-01T04:00:00Z' },
    { id: 'duplicate', analyte: 'estradiol', value: 180, unit: 'pg/mL', at: '2026-10-01T04:00:00Z' },
    { id: 'future', analyte: 'estradiol', value: 180, unit: 'pg/mL', at: '2026-10-02T04:00:00Z' },
    { id: 'unit', analyte: 'estradiol', value: 180, unit: 'ng/dL', at: '2026-10-01T04:00:00Z' },
    { id: 'before', analyte: 'estradiol', value: 180, unit: 'pg/mL', at: '2026-09-30T04:00:00Z' },
  ] });
  const result = model.at();
  assert.equal(result.estradiol.status, 'calibrated');
  const reasons = Object.fromEntries(result.estradiol.calibration.sampleDiagnostics.map(d => [d.id, d.reasonCode]));
  assert.deepEqual(reasons, { future: 'future', unit: 'invalid-lab', before: 'no-exposure', ok: 'included', duplicate: 'duplicate' });
  assert.equal(model.at('2026-10-01T04:00:00Z').estradiol.value, 180);
});
