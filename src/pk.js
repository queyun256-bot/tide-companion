import { t as translate } from './i18n.js';
/**
 * Shared route registry, dose kernels and legacy single-route calibration API.
 * Multi-analyte reference concentrations are provided by hormones.js using the
 * empirical HRT Tracker model and a separate CPA label model. Never a blood
 * measurement or dosing algorithm. Current assumptions: docs/MODELS-v4.md.
 */
import { MAHIRO_PROFILES, mahiroAmount, resolvePkSettings } from './pk-mahiro.js';
import medicationCatalog from './medication-catalog.json' with { type: 'json' };

const HOUR = 3_600_000;
const LN2 = Math.LN2;
const VERSION = 'pk-4';
export const UNIT_FACTORS = Object.freeze({ estradiolPmolPerPg: 1000 / 272.38, testosteroneNmolPerNgDl: 10 / 288.42, cpaNmolPerNgMl: 1000 / 416.94 });

export const SOURCES = Object.freeze({
  oral: { get title(){return translate('Doll et al., 2022：舌下与口服雌二醇原始研究');}, url: 'https://pubmed.ncbi.nlm.nih.gov/34781041/' },
  depot: { get title(){return translate('Oriowo et al., 1980：雌二醇酯药代原始研究');}, url: 'https://pubmed.ncbi.nlm.nih.gov/7389356/' },
  ev: { get title(){return translate('DailyMed：Estradiol valerate 标签');}, url: 'https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=2984bce2-89bf-4768-a1ca-ccf03b1197be' },
  ec: { get title(){return translate('DailyMed：Depo-Estradiol 标签');}, url: 'https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=9a4229fd-fecd-4ac1-9c4f-6d442533457f' },
  egel: { get title(){return translate('DailyMed：EstroGel 标签');}, url: 'https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=762ac371-bb8b-47e7-b48f-e80d452c9dd4' },
  patch: { get title(){return translate('DailyMed：Vivelle-Dot 标签');}, url: 'https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=5ccb77f9-d47b-4381-ad5c-5b92524e1c4a' },
  tc: { get title(){return translate('DailyMed：Testosterone cypionate 标签');}, url: 'https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=f60c5520-b336-44a2-95d5-f274939fa595' },
  te: { get title(){return translate('emc：Testosterone Enantate SmPC');}, url: 'https://www.medicines.org.uk/emc/product/3733/smpc' },
  tgel: { get title(){return translate('DailyMed：AndroGel 1.62% 标签');}, url: 'https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=f4e8d29b-8707-4d47-e053-2a95a90aecee' },
  cpa: { get title(){return translate('Androcur 50mg SmPC 5.1/5.2：CPA药效与口服药代');}, url: 'https://www.medicines.org.uk/emc/product/15996/smpc' },
});

const profile = (id, name, analyte, absorption, elimination, note, sources, extra = {}) => Object.freeze({
  id, get name(){return translate(name);}, analyte, unit: 'mg', doseUnit: 'mg', concentrationUnit: analyte === 'estradiol' ? 'pg/mL' : analyte === 'cpa' ? 'ng/mL' : 'ng/dL',
  model: 'bateman', defaults: Object.freeze({ absorptionHalfLifeHours: absorption, eliminationHalfLifeHours: elimination, ...extra.defaults }),
  ...extra, get note(){return translate(note);}, get evidence(){return translate(extra.evidence || '含教学假设，未经个体或临床验证');}, get sources(){return sources.map(key => ({...SOURCES[key],title:translate(SOURCES[key].title)}));},
});

export const PROFILES = Object.freeze([
  ...MAHIRO_PROFILES,
  profile('cpa-oral', 'CPA 醋酸环丙孕酮 · 口服', 'cpa', 0.449155675133261, 43.9,
    'Androcur 50mg片标签实际PK给药为两片共100mg：约3h总CPA峰285ng/mL、终末半衰期43.9h。吸收半衰期0.449h由一室模型峰时方程推得，非直接测量。仅估计CPA本身，不等于T抑制。', ['cpa'],
    { evidence: '标签峰时与终末半衰期约束的一室近似，未作个体或临床验证' }),
]);

export function getProfile(routeId) { return PROFILES.find(item => item.id === routeId) ?? null; }

function time(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return Number.isFinite(value) && Math.abs(value) <= 8.64e15 ? value : NaN;
  if (typeof value !== 'string' || !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) return NaN;
  return Date.parse(value);
}

function finite(value) { return typeof value === 'number' && Number.isFinite(value); }
function positive(value) { return finite(value) && value > 0; }
function messages(warnings) { const localized = [...new Set(warnings.map(message=>translate(message)))]; return {warnings:localized,warning:localized.join(' ')}; }

function resolveConfig(p, config = {}) {
  if (p.model === 'mahiro') return { ...p.defaults, ...resolvePkSettings(config), durationHours: config.durationHours ?? p.defaults.durationHours };
  const result = { ...p.defaults, ...config };
  for (const key of ['absorptionHalfLifeHours', 'eliminationHalfLifeHours']) {
    if (!positive(result[key]) || result[key] < 0.001 || result[key] > 8760) throw new Error(translate('半衰期须为0.001–8760小时内的有限正数。'));
  }
  if (p.model === 'infusion' && (!positive(result.durationHours) || result.durationHours > 8760)) throw new Error(translate('默认佩戴时长须为0–8760小时内的正数。'));
  return result;
}

function modelSignature(p, cfg, baseline) {
  return JSON.stringify([VERSION, p.id, p.model, cfg.absorptionHalfLifeHours, cfg.eliminationHalfLifeHours, cfg.durationHours ?? null, cfg.bodyWeightKg ?? null, cfg.sublingualFraction ?? null, baseline]);
}

function doseSignature(doses, cutoff) {
  return JSON.stringify(doses.filter(d => time(d.at) <= cutoff).map(d => [d.routeId, d.amount, time(d.at), d.durationHours ?? null]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
}

/** Bateman kernel with a stable equal-rate limit. The result is unscaled exposure. */
export function doseShape({ dose, profile: p, config, at }) {
  const t = (time(at) - time(dose.at)) / HOUR;
  if (!Number.isFinite(t) || !positive(dose.amount)) throw new Error(translate('给药量或时间无效。'));
  if (t < 0) return 0;
  const cfg = resolveConfig(p, config);
  if (p.model === 'mahiro') return mahiroAmount({ routeId: p.id, amount: dose.amount, hours: t, durationHours: dose.durationHours ?? cfg.durationHours, pkSettings: cfg });
  const ke = LN2 / cfg.eliminationHalfLifeHours;
  if (p.model === 'infusion') {
    const duration = dose.durationHours ?? cfg.durationHours;
    if (!positive(duration) || duration > 8760) throw new Error(translate('贴片实际佩戴时长须为0–8760小时内的正数。'));
    // μg/day -> mg/hour. No assumed bioavailability or distribution volume.
    const rate = dose.amount / 24_000;
    const active = Math.min(t, duration);
    return rate / ke * -Math.expm1(-ke * active) * Math.exp(-ke * Math.max(0, t - duration));
  }
  const ka = LN2 / cfg.absorptionHalfLifeHours;
  const difference = Math.abs(ka - ke);
  if (difference < 1e-8 * Math.max(ka, ke)) return dose.amount * ka * t * Math.exp(-ka * t);
  // This rearrangement avoids exp(large positive number) for slow depot absorption.
  const slow = Math.min(ka, ke);
  return dose.amount * ka / difference * Math.exp(-slow * t) * -Math.expm1(-difference * t);
}

function relevantDoses(doses, p) {
  if (!Array.isArray(doses)) throw new Error(translate('给药记录须为数组。'));
  const selected = doses.filter(d => d?.routeId === p.id);
  if (selected.some(d => !positive(d.amount) || !Number.isFinite(time(d.at)))) throw new Error(translate('存在无效的给药量或时间，请修正记录。'));
  return selected;
}

function mixedBefore(doses, p, cutoff) {
  return doses.some(d => {
    if (d?.routeId === p.id || time(d?.at) > cutoff) return false;
    const other = medicationCatalog.items.find(item => item.id === d?.routeId);
    return !other || other.analyte === p.analyte;
  });
}

function exposure(doses, p, cfg, at) {
  const result = doses.reduce((sum, dose) => sum + doseShape({ dose, profile: p, config: cfg, at }), 0);
  if (!Number.isFinite(result)) throw new Error(translate('模型数值超出范围。'));
  return result;
}

/** Convert an actual lab to the analyte's canonical serum unit, without guessing. */
export function normalizeLab(lab) {
  const invalid = source => { const warning=translate(source); return { valid: false, value: null, warning }; };
  if (!lab || !['estradiol', 'testosterone', 'cpa'].includes(lab.analyte)) return invalid('化验项目须明确为雌二醇、总睾酮或CPA。');
  if (!finite(lab.value) || lab.value < 0 || !Number.isFinite(time(lab.at))) return invalid('化验数值或采血时间无效。');
  const unit = String(lab.unit ?? '').replace(/\s+/g, '').toLowerCase();
  const e2 = lab.analyte === 'estradiol', cpa = lab.analyte === 'cpa';
  const factors = e2 ? { 'pg/ml': 1, 'pmol/l': 1 / UNIT_FACTORS.estradiolPmolPerPg, 'ng/l': 1 }
    : cpa ? { 'ng/ml': 1, 'nmol/l': 1 / UNIT_FACTORS.cpaNmolPerNgMl }
      : { 'ng/dl': 1, 'nmol/l': 1 / UNIT_FACTORS.testosteroneNmolPerNgDl, 'ng/ml': 100 };
  if (!(unit in factors)) return invalid('化验单位与项目不匹配；E2使用pg/mL或pmol/L，总T使用ng/dL或nmol/L，CPA使用ng/mL或nmol/L。');
  const value = lab.value * factors[unit];
  if (!Number.isFinite(value)) return invalid('化验数值超出范围。');
  return { valid: true, value, unit: e2 ? 'pg/mL' : cpa ? 'ng/mL' : 'ng/dL', analyte: lab.analyte, at: new Date(time(lab.at)).toISOString() };
}

/**
 * Fit ONE nonnegative amplitude, with fixed baseline and fixed shape parameters.
 * n counts accepted exposure-bearing samples. No automatic dose or half-life fit.
 */
export function calibrate({ doses = [], labs = [], routeId, config = {}, baseline = 0 } = {}) {
  const p = getProfile(routeId);
  const warnings = ['校准只拟合幅度，未验证半衰期或生物利用度；结果是模型估计，不是实时检测。'];
  const fail = message => ({ factor: null, rmse: null, n: 0, status: 'invalid', routeId, analyte: p?.analyte ?? null, unit: p?.concentrationUnit ?? null, ...messages([...warnings, message]) });
  if (!p) return fail('请选择已支持的给药途径。');
  if (!finite(baseline) || baseline < 0) return fail('基线须为非负数，单位与当前激素浓度一致。');
  if (p.analyte === 'cpa' && baseline !== 0) return fail('CPA是外源药物，固定背景须为0；已有残留须用给药历史表示。');
  if (!Array.isArray(labs)) return fail('化验记录须为数组。');
  try {
    const cfg = resolveConfig(p, config);
    const selected = relevantDoses(doses, p);
    const samples = [];
    let excluded = 0;
    for (const lab of labs.filter(item => item?.analyte === p.analyte)) {
      const normalized = normalizeLab(lab);
      if (!normalized.valid) { warnings.push(normalized.warning); excluded++; continue; }
      samples.push(normalized);
    }
    if (!samples.length) return fail('没有可用于当前激素的有效化验。');
    const cutoff = Math.max(...samples.map(lab => time(lab.at)));
    if (mixedBefore(doses, p, cutoff)) return fail('当前激素在化验前存在其他或未知途径记录，无法区分贡献；请选择完整且单一途径时期的数据后校准。');
    const rows = samples.map(lab => ({ x: exposure(selected, p, cfg, lab.at), y: lab.value - baseline, at: lab.at }));
    if (rows.some(row => row.y < 0)) return fail('化验低于所设固定基线；请核对基线、单位与采血时刻后重新校准。');
    if (rows.some(row => row.x <= 1e-10)) return fail('至少一个化验时刻没有足够的已记录模型暴露，无法校准；请补齐给药历史并核对采血时间。');
    const xx = rows.reduce((sum, row) => sum + row.x * row.x, 0);
    const xy = rows.reduce((sum, row) => sum + row.x * row.y, 0);
    const factor = xy / xx;
    if (!positive(factor)) return fail('化验未提供可识别的正药物增量，不能确定幅度。');
    const rmse = Math.sqrt(rows.reduce((sum, row) => sum + (factor * row.x - row.y) ** 2, 0) / rows.length);
    if (!Number.isFinite(rmse)) return fail('校准数值超出范围。');
    if (baseline === 0 && p.analyte !== 'cpa') warnings.push('基线设为0是假设，不代表真实内源激素为0；单一幅度无法区分基线与药物贡献。');
    if (rows.length === 1) warnings.push('仅1个样本：曲线被强制穿过该点，零误差不能证明准确性。');
    else if (rows.length < 3) warnings.push('少于3个样本：只能粗略校准幅度，不能验证曲线。');
    const meanX = rows.reduce((sum, row) => sum + row.x, 0) / rows.length;
    const variation = Math.sqrt(rows.reduce((sum, row) => sum + (row.x - meanX) ** 2, 0) / rows.length) / meanX;
    if (rows.length > 1 && variation < 0.1) warnings.push('样本处于相似模型暴露水平，不能识别峰谷形状；RMSE是拟合误差，不是预测区间。');
    const meanY = samples.reduce((sum, lab) => sum + lab.value, 0) / samples.length;
    if (rmse > 0.3 * meanY) warnings.push('拟合误差相对较大，请核对记录与模型适用性；不据此调整给药。');
    warnings.push('基线固定，内源抑制、个体变化、SHBG及其他药物作用未建模；各途径不能直接合并为总浓度。');
    return {
      factor, rmse, n: rows.length, excluded, status: 'calibrated', routeId, analyte: p.analyte, unit: p.concentrationUnit,
      baseline, signature: modelSignature(p, cfg, baseline), historySignature: doseSignature(selected, cutoff), cutoff,
      sampleTimes: rows.map(row => row.at), exposureRange: [Math.min(...rows.map(row => row.x)), Math.max(...rows.map(row => row.x))],
      ...messages(warnings),
    };
  } catch (error) { return fail(error.message); }
}

export function estimateAt({ doses = [], routeId, at = new Date().toISOString(), config = {}, calibration = null, baseline = 0 } = {}) {
  const p = getProfile(routeId);
  const warnings = [];
  const result = { value: null, shape: 0, unit: p?.concentrationUnit ?? null, status: 'uncalibrated', routeId, analyte: p?.analyte ?? null };
  try {
    if (!p) throw new Error(translate('请选择已支持的给药途径。'));
    if (!Number.isFinite(time(at))) throw new Error(translate('计算时间无效，须含时区。'));
    if (!finite(baseline) || baseline < 0) throw new Error(translate('固定基线须为非负数。'));
    if (p.analyte === 'cpa' && baseline !== 0) throw new Error(translate('CPA是外源药物，固定背景须为0；已有残留须用给药历史表示。'));
    const cfg = resolveConfig(p, config);
    const selected = relevantDoses(doses, p);
    result.shape = exposure(selected, p, cfg, at);
    if (!calibration || !positive(calibration.factor) || calibration.status !== 'calibrated') {
      warnings.push('尚未完成个人校准：仅显示相对模型暴露，不能当作血药浓度。');
      return { ...result, ...messages(warnings) };
    }
    if (calibration.routeId !== routeId || calibration.signature !== modelSignature(p, cfg, baseline)
      || calibration.historySignature !== doseSignature(selected, calibration.cutoff)) {
      warnings.push('模型参数、基线或校准前给药记录已改变，请重新校准。');
      return { ...result, ...messages(warnings) };
    }
    if (mixedBefore(doses, p, time(at))) {
      warnings.push('存在同一激素的其他途径，单途径模型不能估算当前总血浓度。');
      return { ...result, ...messages(warnings) };
    }
    const value = baseline + result.shape * calibration.factor;
    if (!Number.isFinite(value)) throw new Error(translate('模型数值超出范围。'));
    warnings.push(...(calibration.warnings ?? []));
    if (calibration.exposureRange && (result.shape < calibration.exposureRange[0] * 0.8 || result.shape > calibration.exposureRange[1] * 1.2)) warnings.push('当前暴露超出校准样本覆盖范围，属于外推估计。');
    return { ...result, value, status: 'calibrated', ...messages(warnings) };
  } catch (error) { return { ...result, status: 'invalid', ...messages([...warnings, error.message]) }; }
}

/** Inclusive uniform series. at is an ISO string; y uses relative exposure until calibrated. */
export function buildSeries({ start, end, points = 169, ...options } = {}) {
  const first = time(start), last = time(end);
  if (!Number.isFinite(first) || !Number.isFinite(last) || last <= first || !Number.isInteger(points) || points < 2 || points > 2000) return [];
  return Array.from({ length: points }, (_, i) => {
    const at = new Date(first + (last - first) * i / (points - 1)).toISOString();
    const estimate = estimateAt({ ...options, at });
    return { at, ...estimate, y: estimate.value ?? estimate.shape };
  });
}
