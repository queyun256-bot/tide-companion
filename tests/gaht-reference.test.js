import test from 'node:test';
import assert from 'node:assert/strict';
import { gahtReference, gahtReferenceMarkup } from '../src/gaht-reference.js';
import { hormoneCards } from '../src/chart.js';

const results = Object.freeze({
  estradiol: Object.freeze({ value: 152.75, unit: 'pg/mL', status: 'reference' }),
  testosterone: Object.freeze({ value: 352.5, unit: 'ng/dL', status: 'reference' }),
  cpa: Object.freeze({ value: 15.2, unit: 'ng/mL', status: 'reference' }),
});

test('MTF E2 monitoring context names its evidence limits and usable source links', () => {
  const reference = gahtReference('estradiol', 'mtf');
  assert.equal(reference.value, '100–200 pg/mL');
  assert.match(reference.context, /367–734 pmol\/L/);
  assert.match(reference.paragraphs.join(' '), /采血距上次用药/);
  assert.match(reference.paragraphs.join(' '), /不是每一时刻的安全阈值/);
  assert.match(reference.paragraphs.join(' '), /未找到证据/);
  for (const source of reference.sources) {
    const url = new URL(source.url);
    assert.equal(url.protocol, 'https:');
    assert.ok(['academic.oup.com', 'pmc.ncbi.nlm.nih.gov', 'pubmed.ncbi.nlm.nih.gov'].includes(url.hostname));
  }
});

test('FTM T midpoint condition stays visible and other sampling conditions remain distinct', () => {
  const reference = gahtReference('testosterone', 'ftm');
  assert.equal(reference.value, '400–700 ng/dL');
  assert.match(reference.context, /仅指庚酸 \/ 环戊丙酸睾酮注射间隔中点采血/);
  const markup = gahtReferenceMarkup('testosterone', 'ftm');
  assert.ok(markup.indexOf('间隔中点采血') < markup.indexOf('<details'));
  assert.match(markup, /长效十一酸睾酮.*下一次注射前/);
  assert.match(markup, /至少一周后.*至少两小时/);
});

test('no CPA range or cross-mode estradiol target is fabricated', () => {
  assert.equal(gahtReference('cpa', 'mtf'), null);
  assert.equal(gahtReference('cpa', 'ftm'), null);
  assert.equal(gahtReference('testosterone', 'mtf'), null);
  assert.equal(gahtReference('estradiol', 'other'), null);
  assert.equal(gahtReferenceMarkup('cpa', 'mtf'), '');
  const ftm = gahtReference('estradiol', 'ftm');
  assert.equal(ftm.value, '未设统一 E2 目标');
  assert.match(ftm.context, /不套用女性化治疗/);
});

test('reference cards are opt-in, preserve concentrations and never score a model result', () => {
  const baseline = hormoneCards(results, ['estradiol', 'cpa']);
  assert.doesNotMatch(baseline, /gaht-reference|100–200/);
  const mtf = hormoneCards(results, ['estradiol', 'cpa'], { referenceMode: 'mtf' });
  assert.equal((mtf.match(/data-gaht-reference=/g) || []).length, 1);
  assert.match(mtf, /<strong>152\.8<small>pg\/mL/);
  assert.match(mtf, /<strong>15\.2<small>ng\/mL/);
  assert.doesNotMatch(mtf, /data-gaht-reference="cpa"|data-in-range|data-safe|建议用量/);
  const ftm = hormoneCards(results, ['testosterone', 'estradiol'], { referenceMode: 'ftm' });
  assert.equal((ftm.match(/data-gaht-reference=/g) || []).length, 2);
  assert.match(ftm, /<strong>352\.5<small>ng\/dL/);
  assert.match(ftm, /未设统一 E2 目标/);
});

test('an unavailable estimate remains unavailable when monitoring references are visible', () => {
  const markup = hormoneCards({}, ['estradiol'], { referenceMode: 'mtf' });
  assert.match(markup, /data-status="unavailable"/);
  assert.match(markup, /<strong>—<small>pg\/mL/);
  assert.match(markup, /100–200 pg\/mL/);
});
