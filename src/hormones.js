/**
 * E2/T empirical compartment simulation and independent CPA label model.
 * Personal labs fit one shared amplitude per analyte; clinical accuracy is not
 * implied. Sources, reference-version pin and assumptions: docs/MODELS-v4.md.
 */
import { getProfile, doseShape, normalizeLab, SOURCES } from './pk.js';
import { MAHIRO_PROFILES, MAHIRO_SOURCE, mahiroAmount, mahiroConcentrationScale, resolvePkSettings } from './pk-mahiro.js';
import { getMedication } from './medications.js';
import referencePresets from './reference-presets.json' with { type: 'json' };

const HOUR = 3_600_000;
const ANALYTES = ['estradiol', 'testosterone', 'cpa'];
const UNITS = { estradiol: 'pg/mL', testosterone: 'ng/dL', cpa: 'ng/mL' };
const EPOCH = '2026-01-01T00:00:00Z';

export const REFERENCE_BASELINES = Object.freeze(Object.fromEntries(
  Object.entries(referencePresets.baselines).map(([mode, values]) => [mode, Object.freeze(values)])));
export const BASELINE_EVIDENCE = Object.freeze(referencePresets.source);
export const MODE_BASELINES = REFERENCE_BASELINES;
export const CPA_SOURCE = Object.freeze(SOURCES.cpa);

function peakScale(routeId, amount, hours, target) {
  return target / doseShape({ dose: { amount, at: EPOCH }, profile: getProfile(routeId), at: Date.parse(EPOCH) + hours * HOUR });
}
function ref(routeId, scale, anchor, source, note) {
  return Object.freeze({ routeId, scale, anchor: Object.freeze(anchor), source, note, evidence: '来源数值锚定的参考情境，含未验证形状与外推假设' });
}

// Freeze amplitude against the original profiles. Editing half-lives must NOT
// silently re-normalize every new curve to the same peak or average.
export const REFERENCE_MODELS = Object.freeze({
  ...Object.fromEntries(MAHIRO_PROFILES.map(p => [p.id, ref(p.id, mahiroConcentrationScale(p.id),
    { kind: 'empirical-compartment-simulation', bodyWeightKg: 70, parameters: p.pkParameters, commit: MAHIRO_SOURCE.commit }, MAHIRO_SOURCE,
    `${p.note} 体重仅用于表观分布容积；这是经验参考模拟，不是来源研究观测峰值或临床验证。`)])),
  'cpa-oral': ref('cpa-oral', peakScale('cpa-oral', 100, 3, 285),
    { kind: 'observed-parent-drug-peak', dose: 100, hours: 3, total: 285, sourceBaseline: 0,
      terminalHalfLifeHours: 43.9, reportedAbsoluteBioavailability: 0.88 }, CPA_SOURCE,
    'Androcur 50mg片标签中的PK给药实际为两片共100mg，约3h总CPA峰285ng/mL、终末半衰期43.9h；一室近似吸收速率由峰时推得。幅度已含吸收影响，不再另乘88%生物利用度。其他剂量作线性外推，未验证个体准确性。'),
});

function finite(n) { return typeof n === 'number' && Number.isFinite(n); }
function time(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return finite(value) && Math.abs(value) <= 8.64e15 ? value : NaN;
  if (typeof value !== 'string' || !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) return NaN;
  return Date.parse(value);
}
function info(warnings) { const unique = [...new Set(warnings)]; return { warnings: unique, warning: unique.join(' ') }; }
function fixedBaseline(values, analyte, fallback) {
  const value = values?.[analyte] ?? fallback;
  if (!finite(value) || value < 0) throw new Error('基线必须是对应浓度单位的有限非负数。');
  return value;
}

// Prepared dose kernels avoid date parsing and config resolution at each point.
function prepareRoute(routeId, records, configs, pkSettings) {
  const profile = getProfile(routeId);
  if (profile.model === 'mahiro') {
    const duration = configs?.[routeId]?.durationHours ?? profile.defaults.durationHours;
    const doses = records.map(dose => {
      const start = time(dose.at);
      if (!finite(start) || !finite(dose.amount) || dose.amount <= 0) throw new Error(`${profile.name}：存在无效给药时间或用量。`);
      const wear = dose.durationHours ?? duration;
      if (profile.kernelKind === 'patch' && (!finite(wear) || wear <= 0 || wear > 8760)) throw new Error('贴片佩戴时长须明确且在0–8760小时内。');
      return { start, amount: dose.amount, durationHours: wear };
    });
    const shapeAt = instant => doses.reduce((total, dose) => total + mahiroAmount({ routeId,
      amount: dose.amount, hours: (instant - dose.start) / HOUR, durationHours: dose.durationHours, pkSettings }), 0);
    return { routeId, profile, reference: { ...REFERENCE_MODELS[routeId], scale: mahiroConcentrationScale(routeId, pkSettings.bodyWeightKg) },
      shapeAt, firstAt: Math.min(...doses.map(d => d.start)), count: doses.length };
  }
  const config = { ...profile.defaults, ...configs?.[routeId] };
  for (const key of ['absorptionHalfLifeHours', 'eliminationHalfLifeHours']) {
    if (!finite(config[key]) || config[key] < 0.001 || config[key] > 8760) throw new Error(`${profile.name}：半衰期须在0.001–8760小时内。`);
  }
  const ka = Math.LN2 / config.absorptionHalfLifeHours;
  const ke = Math.LN2 / config.eliminationHalfLifeHours;
  const difference = Math.abs(ka - ke), slow = Math.min(ka, ke);
  const doses = records.map(dose => {
    const start = time(dose.at);
    if (!finite(start) || !finite(dose.amount) || dose.amount <= 0) throw new Error(`${profile.name}：存在无效给药时间或用量。`);
    const duration = dose.durationHours ?? config.durationHours;
    if (profile.model === 'infusion' && (!finite(duration) || duration <= 0 || duration > 8760)) throw new Error('贴片佩戴时长须明确且在0–8760小时内。');
    return { start, amount: dose.amount, duration };
  });
  const shapeAt = instant => {
    let total = 0;
    for (const d of doses) {
      const t = (instant - d.start) / HOUR;
      if (t <= 0) continue;
      if (profile.model === 'infusion') {
        total += d.amount / 24000 / ke * -Math.expm1(-ke * Math.min(t, d.duration)) * Math.exp(-ke * Math.max(0, t - d.duration));
      } else if (difference < 1e-8 * Math.max(ka, ke)) {
        total += d.amount * ka * t * Math.exp(-ka * t);
      } else {
        total += d.amount * ka / difference * Math.exp(-slow * t) * -Math.expm1(-difference * t);
      }
    }
    return total;
  };
  return { routeId, profile, reference: REFERENCE_MODELS[routeId] ?? null, shapeAt,
    firstAt: Math.min(...doses.map(d => d.start)), count: doses.length };
}

function fitAmplitude({ routes, samples, baseline, unsupported, blocking, analyte, diagnostics = [] }) {
  const warnings = [];
  const sampleDiagnostics = [...diagnostics];
  const routeIds = routes.map(r => r.routeId);
  const fail = (reasonCode, message) => ({ status: 'unavailable', factor: null, n: 0, rmse: null, method: null, routeIds, reasonCode,
    sampleDiagnostics: sampleDiagnostics.map(d => d.status === 'included' ? { ...d, status: 'excluded', reasonCode: 'calibration-blocked' } : d), ...info([...warnings, message]) });
  if (blocking) return fail('invalid-records', blocking);
  if (!routes.length) return fail('no-exposure', '没有对应激素给药模型，化验保留为最近实测，不能直接外推为当前浓度。');
  if (!samples.length) return fail('no-labs', '尚无可用个人化验，显示有明确假设的参考情境。');
  const shapeOnly = unsupported.length === 1 && routes.length === 1;
  if (unsupported.length && !shapeOnly) return fail('unsupported-combination', '组合中包含缺少参考幅度的途径，单一缩放系数无法确定各途径贡献；保留历史与化验，不输出不完整总值。');
  const contribution = (route, t) => route.shapeAt(t) * (shapeOnly ? 1 : route.reference.scale);
  const rows = [], seen = new Set();
  let excluded = 0;
  for (const sample of samples) {
    const signature = `${sample.at}|${sample.value}`;
    if (seen.has(signature)) { excluded++; sampleDiagnostics.push({ id: sample.id, at: sample.at, status: 'excluded', reasonCode: 'duplicate' }); continue; }
    seen.add(signature);
    const parts = routes.map(route => contribution(route, time(sample.at)));
    const x = parts.reduce((sum, value) => sum + value, 0);
    if (!finite(x)) return fail('numeric-error', '模型暴露溢出，无法校准。');
    if (x <= 1e-10) { excluded++; sampleDiagnostics.push({ id: sample.id, at: sample.at, status: 'excluded', reasonCode: 'no-exposure', predicted: x }); continue; }
    if (sample.value < baseline) {
      sampleDiagnostics.push({ id: sample.id, at: sample.at, status: 'excluded', reasonCode: 'baseline-conflict', predicted: x });
      return fail('baseline-conflict', '至少一条有效暴露时的化验低于个人固定基线，请核对基线与记录；不能拟合负药物增量。');
    }
    sampleDiagnostics.push({ id: sample.id, at: sample.at, status: 'included', reasonCode: 'included', predicted: x, observed: sample.value });
    rows.push({ x, y: sample.value - baseline, parts, at: sample.at });
  }
  if (!rows.length) return fail('no-exposure', '化验时刻没有足够的已记录药物暴露，不能确定幅度；最近实测仍可查看。');
  if (routes.some((_, index) => !rows.some(row => row.parts[index] > 1e-10))) {
    return fail('unrepresented-route', '有途径未被任何校准化验覆盖；不能把另一种途径的个人倍率迁移到新增途径，当前退回参考情境。');
  }
  const xx = rows.reduce((sum, row) => sum + row.x ** 2, 0);
  const xy = rows.reduce((sum, row) => sum + row.x * row.y, 0);
  const factor = xy / xx;
  if (!finite(factor) || factor <= 0) return fail('unidentifiable', '无法识别正的药物幅度，请核对个人基线、化验与给药历史。');
  const rmse = Math.sqrt(rows.reduce((sum, row) => sum + (baseline + factor * row.x - (row.y + baseline)) ** 2, 0) / rows.length);
  if (!finite(rmse)) return fail('numeric-error', '拟合数值超出范围。');
  warnings.push(shapeOnly ? '该途径缺少群体参考幅度，使用个人化验对单途径形状拟合；未经临床验证。'
    : '只对该激素的合成参考增量拟合一个共同倍率；各途径的比例来自参考假设，并未分别得到个人校准。');
  if (rows.length === 1) warnings.push('仅1个样本，模型强制经过该点；零RMSE不能证明曲线准确。');
  else if (rows.length < 3) warnings.push('少于3个样本，不能验证峰谷或未来预测。');
  if (baseline === 0 && analyte !== 'cpa') warnings.push('个人校准基线0是固定假设，不代表真实内源激素为0。');
  if (excluded) warnings.push(`${excluded}条重复或无模型暴露的样本未参与幅度拟合。`);
  const meanX = rows.reduce((sum, row) => sum + row.x, 0) / rows.length;
  const cv = Math.sqrt(rows.reduce((sum, row) => sum + (row.x - meanX) ** 2, 0) / rows.length) / meanX;
  if (rows.length > 1 && cv < 0.1) warnings.push('化验覆盖的模型暴露相似，不能验证时间曲线形状。');
  const meanY = rows.reduce((sum, row) => sum + row.y + baseline, 0) / rows.length;
  if (rmse > meanY * 0.3) warnings.push('拟合残差较大，记录或模型可能不适用。RMSE不是预测区间。');
  return { status: 'calibrated', method: shapeOnly ? 'single-route-shape' : 'shared-reference-scale', factor, n: rows.length, excluded, rmse, routeIds,
    sampleTimes: rows.map(row => row.at), sampleDiagnostics, exposureRange: [Math.min(...rows.map(row => row.x)), Math.max(...rows.map(row => row.x))], ...info(warnings) };
}

/** Compile once per data/config change. at() and series() never refit laboratories. */
export function compileHormoneModel({ doses = [], labs = [], modelConfigs = {}, pkSettings = {}, baselines = {}, referenceBaselines = {}, mode = 'mtf', at } = {}) {
  const compiledAt = time(at ?? new Date().toISOString());
  const modeKey = String(mode).toLowerCase();
  const modeDefaults = REFERENCE_BASELINES[modeKey] ?? REFERENCE_BASELINES.mtf;
  const records = Array.isArray(doses) ? doses.map(d => ({ ...d })) : [];
  const labRecords = Array.isArray(labs) ? labs.map(l => ({ ...l })) : [];
  const grouped = {}, normalized = Object.fromEntries(ANALYTES.map(a => [a, []]));
  const globalWarnings = [], validation = Object.fromEntries(ANALYTES.map(a => [a, []]));
  const diagnostics = Object.fromEntries(ANALYTES.map(a => [a, []]));
  let resolvedSettings;
  try { resolvedSettings = resolvePkSettings(pkSettings); } catch (error) { globalWarnings.push(error.message); resolvedSettings = resolvePkSettings(); }
  if (!finite(compiledAt)) globalWarnings.push('计算时间无效，需包含时区。');
  if (!Array.isArray(doses) || !Array.isArray(labs)) globalWarnings.push('给药与化验记录必须为数组。');
  const unknown = [], recorded = [], missingModels = Object.fromEntries(ANALYTES.map(a => [a, []]));
  for (const d of records) {
    const p = getMedication(d.routeId);
    if (!p) { unknown.push(d); continue; }
    if (!ANALYTES.includes(p.analyte)) { recorded.push({ ...d, profile: p, start: time(d.at) }); continue; }
    // A recorded hormone with no kernel is an unknown contribution, never zero.
    // Do not infer a washout duration when no validated model exists.
    if (p.model === 'record-only' || !getProfile(p.id)) {
      missingModels[p.analyte].push({ ...d, profile: p, start: time(d.at) });
      continue;
    }
    (grouped[p.id] ??= []).push(d);
  }
  for (const l of labRecords) {
    if (!ANALYTES.includes(l.analyte)) continue;
    const sample = normalizeLab(l);
    if (!sample.valid) { validation[l.analyte].push(sample.warning); diagnostics[l.analyte].push({ id: l.id, at: l.at, status: 'excluded', reasonCode: 'invalid-lab' }); continue; }
    if (time(sample.at) > compiledAt) { validation[l.analyte].push('未来采血记录未参与校准。'); diagnostics[l.analyte].push({ id: l.id, at: l.at, status: 'excluded', reasonCode: 'future' }); continue; }
    normalized[l.analyte].push({ ...sample, id: l.id ?? null, originalValue: l.value, originalUnit: l.unit });
  }
  for (const a of ANALYTES) normalized[a].sort((a, b) => time(a.at) - time(b.at));

  const prepared = {};
  for (const analyte of ANALYTES) {
    const routes = [], errors = [...globalWarnings], timedErrors = [];
    let personalBaseline = 0, referenceBaseline = modeDefaults[analyte] ?? 0;
    try {
      personalBaseline = fixedBaseline(baselines, analyte, 0);
      referenceBaseline = fixedBaseline(referenceBaselines, analyte, modeDefaults[analyte] ?? 0);
      if (analyte === 'cpa' && (personalBaseline !== 0 || referenceBaseline !== 0)) throw new Error('CPA是外源药物，参考和个人固定背景须为0；已有残留须用给药历史表示。');
    } catch (error) { errors.push(error.message); }
    for (const [routeId, ds] of Object.entries(grouped)) {
      if (getProfile(routeId).analyte !== analyte) continue;
      // Validate events individually so a malformed future import cannot erase
      // valid earlier exposure (including earlier doses on the same route).
      const usable = [];
      for (const dose of ds) {
        try { prepareRoute(routeId, [dose], modelConfigs, resolvedSettings); usable.push(dose); }
        catch (error) { timedErrors.push({ start: time(dose.at), message: error.message }); }
      }
      if (usable.length) routes.push(prepareRoute(routeId, usable, modelConfigs, resolvedSettings));
    }
    const calibrationRoutes = routes.filter(r => r.firstAt <= compiledAt);
    const unsupported = calibrationRoutes.filter(r => !r.reference);
    const missingBeforeNow = missingModels[analyte].filter(d => !finite(d.start) || d.start <= compiledAt);
    const invalidBeforeNow = timedErrors.filter(d => !finite(d.start) || d.start <= compiledAt);
    const unknownBeforeNow = unknown.some(d => !finite(time(d.at)) || time(d.at) <= compiledAt);
    const calibration = fitAmplitude({ routes: calibrationRoutes, samples: normalized[analyte], baseline: personalBaseline, unsupported, analyte, diagnostics: diagnostics[analyte],
      blocking: errors[0] ?? invalidBeforeNow[0]?.message ?? (unknownBeforeNow ? '存在未知药物途径，无法确认其激素贡献。' : null)
        ?? (missingBeforeNow.length ? `已记录的${missingBeforeNow.map(d => d.profile.name).join('、')}缺少浓度模型，不能在遗漏贡献时进行个人总值校准。` : null) });
    if (missingBeforeNow.length && !errors.length && !invalidBeforeNow.length && !unknownBeforeNow) calibration.reasonCode = 'record-only-hormone';
    prepared[analyte] = { routes, unsupported, errors, timedErrors, personalBaseline, referenceBaseline, calibration };
  }

  const evaluate = input => {
    const instant = time(input ?? compiledAt), output = {};
    for (const analyte of ANALYTES) {
      const p = prepared[analyte], warnings = [...validation[analyte]];
      const activeErrors = [...p.errors, ...p.timedErrors.filter(d => !finite(d.start) || d.start <= instant).map(d => d.message)];
      const latestLab = [...normalized[analyte]].reverse().find(l => time(l.at) <= instant) ?? null;
      const active = p.routes.filter(r => r.firstAt <= instant);
      const unsupported = active.filter(r => !r.reference);
      const unsupportedMedications = [...new Map(missingModels[analyte]
        .filter(d => !finite(d.start) || d.start <= instant)
        .map(d => [d.routeId, { routeId: d.routeId, name: d.profile.name, note: d.profile.note, sources: d.profile.sources }])).values()];
      const activeRecorded = recorded.filter(d => !finite(d.start) || d.start <= instant);
      const hasUnknown = unknown.some(d => !finite(time(d.at)) || time(d.at) <= instant);
      const unrepresented = active.some(r => !p.calibration.routeIds.includes(r.routeId));
      let calibrated = p.calibration.status === 'calibrated' && !unrepresented;
      if (p.calibration.status === 'calibrated' && unrepresented) warnings.push('该时刻出现未被化验覆盖的新途径，当前退回参考情境，不迁移其他途径的个人倍率。');
      const shapeOnly = p.calibration.method === 'single-route-shape';
      const routeContributions = active.map(route => {
        let shape;
        try { shape = finite(instant) ? route.shapeAt(instant) : NaN; } catch { shape = NaN; }
        const referenceIncrement = route.reference ? shape * route.reference.scale : null;
        const contribution = calibrated ? p.calibration.factor * (shapeOnly ? shape : referenceIncrement) : referenceIncrement;
        return { routeId: route.routeId, name: route.profile.name, shape, referenceIncrement, contribution,
          supported: Boolean(route.reference), unit: UNITS[analyte], note: route.reference?.note ?? '缺少经过核查的群体参考幅度。' };
      });
      const valid = finite(instant) && !activeErrors.length && !hasUnknown;
      const numeric = routeContributions.every(r => finite(r.shape) && (r.contribution === null || finite(r.contribution)));
      let status = calibrated ? 'calibrated' : 'reference';
      let reasonCode = calibrated ? 'personal-amplitude' : p.calibration.status === 'calibrated' && unrepresented ? 'unrepresented-route' : active.length ? 'source-anchored-scenario' : 'baseline-only';
      let value = null;
      if (!valid || !numeric) {
        status = 'unavailable'; reasonCode = 'invalid-records';
        warnings.push(...activeErrors, ...(!finite(instant) ? ['计算时间无效。'] : []), ...(hasUnknown ? ['存在未知药物途径，无法确认其激素贡献。'] : []), ...(!numeric ? ['模型数值超出范围。'] : []));
      } else if (unsupportedMedications.length) {
        status = 'unavailable'; reasonCode = 'record-only-hormone';
        warnings.push(`以下已记录药物缺少该激素的浓度模型：${unsupportedMedications.map(m => m.name).join('、')}。其贡献未知，不能当作0或输出不完整总值；历史记录和实测仍保留。`);
      } else if (unsupported.length && !(calibrated && shapeOnly && active.length === 1)) {
        status = 'unavailable'; reasonCode = 'unsupported-route';
        warnings.push(`以下途径缺少可用于叠加的参考幅度：${unsupported.map(r => r.profile.name).join('、')}。未把这些贡献当作0，当前不显示不完整总值。`);
      } else {
        const background = calibrated ? p.personalBaseline : p.referenceBaseline;
        value = background + routeContributions.reduce((sum, route) => sum + route.contribution, 0);
        if (!finite(value)) { value = null; status = 'unavailable'; reasonCode = 'numeric-error'; }
      }
      if (status === 'reference') {
        warnings.push('未个人校准：这是来源数值与简化形状组成的参考情境，不是你的实际血药浓度。');
        if (analyte === 'cpa') {
          warnings.push('CPA无内源背景，基线固定为0；只按已记录的CPA口服剂量估计母药总浓度，不包括代谢物。');
          if (!active.length) warnings.push('没有已记录的CPA给药贡献，模型为0；不代表化验证实为0或排除了遗漏用药。');
        } else {
          warnings.push(p.referenceBaseline === modeDefaults[analyte]
          ? `参考背景来自Vlot 2019成人队列GAHT前中位数（${p.referenceBaseline}${UNITS[analyte]}），作为可编辑情境；不代表你的当前内源水平，也不是治疗目标。`
          : `参考背景${p.referenceBaseline}${UNITS[analyte]}为自定义情境；不代表实测或治疗目标。`);
          warnings.push('MTF/FTM仅选择参考队列，不从身份推断器官、内源水平或用药后的抑制程度。');
          if (!active.length) warnings.push('没有对应激素给药贡献，显示的只是背景假设；最近化验不会被冒充为实时值。');
        }
      }
      if (active.some(route => route.profile.model === 'mahiro')) {
        warnings.push(`药代模型经验参考参数：模型体重${resolvedSettings.bodyWeightKg}kg，表观分布容积E2为2L/kg、T为1L/kg；默认体重不是个人测量。`);
        if (active.some(route => route.profile.kernelKind === 'sublingual')) warnings.push(`舌下黏膜分流比例${(resolvedSettings.sublingualFraction * 100).toFixed(1)}%为情境假设；不代表给定含服时间一定达到该吸收比例。`);
        if (active.some(route => route.profile.model === 'mahiro' && (modelConfigs?.[route.routeId]?.absorptionHalfLifeHours != null || modelConfigs?.[route.routeId]?.eliminationHalfLifeHours != null))) warnings.push('原版本单室半衰期设置已保留，但不用于当前多室参考模型；当前参数见模型说明。');
      }
      // Surface the anchor assumptions with the number, not only in source docs.
      for (const route of active) if (route.reference) warnings.push(`${route.profile.name}：${route.reference.note}`);
      warnings.push(...p.calibration.warnings);
      if (active.length > 1) warnings.push('多途径数值按固定参考比例线性叠加，基线只加一次；跨制剂等比例、个体吸收和内源变化未验证。');
      if (calibrated) {
        const exposure = routeContributions.reduce((sum, r) => sum + (shapeOnly ? r.shape : r.referenceIncrement), 0);
        if (exposure < p.calibration.exposureRange[0] * 0.8 || exposure > p.calibration.exposureRange[1] * 1.2) warnings.push('当前模型暴露超出化验覆盖范围，属于外推。');
      }
      if (analyte === 'testosterone' && records.some(d => getMedication(d.routeId)?.analyte === 'cpa' && time(d.at) <= instant)) warnings.push('CPA自身浓度单独估计；其受体阻断、内源T抑制不能从用量或CPA浓度直接换算。此T曲线未模拟CPA抑制，不可解释为CPA后的实际T。');
      const otherRecorded = [...new Set(activeRecorded.filter(d => d.routeId !== 'cpa-oral').map(d => d.profile.name))];
      if (otherRecorded.length) warnings.push(`${otherRecorded.join('、')}仅记录与提醒；其药效及相互作用未进入当前浓度计算。`);
      if (analyte === 'testosterone' && records.some(d => getMedication(d.routeId)?.analyte === 'estradiol' && time(d.at) <= instant)) warnings.push('E2对内源T的抑制未建模；没有T给药或实测校准时，T数字只是假设背景。');
      if (analyte === 'estradiol' && records.some(d => getMedication(d.routeId)?.analyte === 'testosterone' && time(d.at) <= instant)) warnings.push('外源T的芳香化与内源E2变化未建模。');
      warnings.push(analyte === 'cpa' ? 'CPA曲线仅为标签约束的一室近似；不提供T抑制程度、治疗效果判断或用药建议。' : '曲线形状仍含教学假设，数值不提供治疗效果判断或用药建议。');
      output[analyte] = { analyte, value, unit: UNITS[analyte], status, reasonCode, latestLab,
        baseline: calibrated ? p.personalBaseline : p.referenceBaseline, referenceBaseline: p.referenceBaseline, personalBaseline: p.personalBaseline,
        baselineSource: !calibrated && p.referenceBaseline === modeDefaults[analyte] ? BASELINE_EVIDENCE : null,
        referenceBaselineSource: p.referenceBaseline === modeDefaults[analyte] ? BASELINE_EVIDENCE : null,
        baselineKind: calibrated ? 'personal-fixed' : 'scenario', calibration: p.calibration, routeContributions, unsupportedMedications,
        referenceValue: unsupported.length || unsupportedMedications.length || !valid || !numeric ? null : p.referenceBaseline + routeContributions.reduce((sum, r) => sum + r.referenceIncrement, 0),
        ...info(warnings) };
    }
    return output;
  };
  const series = ({ start, end, points = 201 } = {}) => {
    const first = time(start), last = time(end);
    if (!finite(first) || !finite(last) || last <= first || !Number.isInteger(points) || points < 2 || points > 2000) return [];
    return Array.from({ length: points }, (_, i) => {
      const at = new Date(first + (last - first) * i / (points - 1)).toISOString();
      return { at, ...evaluate(at) };
    });
  };
  return { at: evaluate, series, mode: modeKey, compiledAt, pkSettings: resolvedSettings,
    calibrations: Object.fromEntries(ANALYTES.map(a => [a, prepared[a].calibration])) };
}

export function analyzeHormones(options = {}) { return compileHormoneModel(options).at(options.at); }
export function buildHormoneSeries({ start, end, points = 201, ...options } = {}) {
  return compileHormoneModel(options).series({ start, end, points });
}
