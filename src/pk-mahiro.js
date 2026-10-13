import { t as translate } from './i18n.js';
/**
 * Reference simulation adapted from Oyama's HRT Tracker, MIT licensed.
 * Copyright (c) 2025 Joseph Smirnova Oyama.
 * Source: fa48eb72a80f2adc65fec0b0045ec25204ad7250 / logic.ts.
 * Full upstream notice: assets/vendor/oyama-hrt-LICENSE.txt.
 * Parameters are empirical simulation assumptions, not validated personal PK.
 * The numerical kernels below are independently implemented to remain stable
 * at equal rates (notably TE ka = ke), without perturbing physical parameters.
 */
export const MAHIRO_SOURCE = Object.freeze({
  get title(){return translate('HRT Tracker 参考算法（经验模拟参数）');}, url: 'https://hrt.mahiro.uk',
  repository: 'https://github.com/xunxunProjects/Oyama-s-HRT-Tracker',
  commit: 'fa48eb72a80f2adc65fec0b0045ec25204ad7250',
});
export const DEFAULT_PK_SETTINGS = Object.freeze({ bodyWeightKg: 70, sublingualFraction: 0.11 });

export function resolvePkSettings(value = {}) {
  const result = { bodyWeightKg: value.bodyWeightKg ?? DEFAULT_PK_SETTINGS.bodyWeightKg,
    sublingualFraction: value.sublingualFraction ?? DEFAULT_PK_SETTINGS.sublingualFraction };
  if (!Number.isFinite(result.bodyWeightKg) || result.bodyWeightKg < 20 || result.bodyWeightKg > 400) throw new Error(translate('模型体重须为20–400 kg的有限数；默认70 kg只是参考假设。'));
  if (!Number.isFinite(result.sublingualFraction) || result.sublingualFraction < 0 || result.sublingualFraction > 1) throw new Error(translate('舌下黏膜分流比例须在0–1之间。'));
  return result;
}

const e2 = (kind, data) => ({ analyte: 'estradiol', kernelKind: kind, vdLPerKg: 2, clearanceRate: 0.41, molecularRatio: 1, ...data });
const t = (kind, data) => ({ analyte: 'testosterone', kernelKind: kind, vdLPerKg: 1, clearanceRate: 0.5, molecularRatio: 1, ...data });
const evRatio = 272.38 / 356.50;
const definition = {
  'e2-oral': e2('oral', { absorptionRate: 0.32, bioavailability: 0.03 }),
  'e2-ev-oral': e2('oral', { absorptionRate: 0.05, bioavailability: 0.03, molecularRatio: evRatio }),
  'e2-sublingual': e2('sublingual', { absorptionRate: 1.8, swallowedAbsorptionRate: 0.32, hydrolysisRate: 0, oralBioavailability: 0.03 }),
  'e2-ev-sublingual': e2('sublingual', { absorptionRate: 1.8, swallowedAbsorptionRate: 0.05, hydrolysisRate: 0.07, oralBioavailability: 0.03, molecularRatio: evRatio }),
  'e2-gel': e2('gel', { absorptionRate: 0.0193, bioavailability: 0.05 }),
  'e2-patch': e2('patch', { bioavailability: 1, durationHours: 84, unit: 'μg/day' }),
  'e2-eb-im': e2('depot', { fastFraction: 0.90, absorptionRate: 0.144, slowAbsorptionRate: 0.114, hydrolysisRate: 0.09, clearanceRate: 0.041, formationFraction: 0.1092, molecularRatio: 272.38 / 376.50 }),
  'e2-ev-im': e2('depot', { fastFraction: 0.40, absorptionRate: 0.0216, slowAbsorptionRate: 0.0138, hydrolysisRate: 0.07, clearanceRate: 0.041, formationFraction: 0.0623, molecularRatio: evRatio }),
  'e2-ec-im': e2('depot', { fastFraction: 0.229164549, absorptionRate: 0.005035046, slowAbsorptionRate: 0.004510574, hydrolysisRate: 0.045, clearanceRate: 0.041, formationFraction: 0.1173, molecularRatio: 272.38 / 396.58 }),
  'e2-een-im': e2('depot', { fastFraction: 0.05, absorptionRate: 0.001, slowAbsorptionRate: 0.005, hydrolysisRate: 0.015, clearanceRate: 0.041, formationFraction: 0.12, molecularRatio: 272.38 / 384.56 }),
  't-cypionate-im': t('depot', { fastFraction: 0.35, absorptionRate: 0.025, slowAbsorptionRate: 0.005, hydrolysisRate: 0.20, clearanceRate: 0.035, formationFraction: 0.025, molecularRatio: 288.42 / 412.60 }),
  't-enanthate-im': t('depot', { fastFraction: 0.40, absorptionRate: 0.035, slowAbsorptionRate: 0.008, hydrolysisRate: 0.20, clearanceRate: 0.035, formationFraction: 0.025, molecularRatio: 288.42 / 400.59 }),
  't-undecanoate-im': t('depot', { fastFraction: 0.10, absorptionRate: 0.008, slowAbsorptionRate: 0.0009, hydrolysisRate: 0.20, clearanceRate: 0.035, formationFraction: 0.025, molecularRatio: 288.42 / 456.70 }),
  't-gel': t('gel', { absorptionRate: 0.05, bioavailability: 0.10 }),
  't-patch': t('patch', { bioavailability: 1, durationHours: 24, unit: 'mg/day' }),
};
export const MAHIRO_MODELS = Object.freeze(Object.fromEntries(Object.entries(definition).map(([id, p]) => [id, Object.freeze(p)])));

/** Unit input, absorption -> central clearance; result is central mass fraction. */
export function twoCompartment(tau, ka, ke) {
  if (tau <= 0) return 0;
  const difference = Math.abs(ka - ke), slow = Math.min(ka, ke);
  if (difference <= 1e-12 * Math.max(ka, ke)) return ka * tau * Math.exp(-ka * tau);
  return ka * Math.exp(-slow * tau) * -Math.expm1(-difference * tau) / difference;
}

// Lower-triangular 3x3 matrices are [00,10,11,20,21,22].
function multiply(a, b) {
  return [a[0] * b[0], a[1] * b[0] + a[2] * b[1], a[2] * b[2],
    a[3] * b[0] + a[4] * b[1] + a[5] * b[3], a[4] * b[2] + a[5] * b[4], a[5] * b[5]];
}
function matrixCentral(tau, ka, kh, ke) {
  const norm = tau * Math.max(2 * ka, 2 * kh, ke);
  const squares = Math.max(0, Math.ceil(Math.log2(norm / 0.5)));
  const h = tau / 2 ** squares;
  const a = [-ka * h, ka * h, -kh * h, 0, kh * h, -ke * h];
  let sum = [1, 0, 1, 0, 0, 1], term = [...sum];
  for (let n = 1; n <= 24; n++) {
    term = multiply(term, a).map(v => v / n);
    sum = sum.map((v, i) => v + term[i]);
    if (n > 4 && Math.max(...term.map(Math.abs)) < 1e-17) break;
  }
  for (let i = 0; i < squares; i++) sum = multiply(sum, sum);
  return Math.max(0, sum[3]);
}

/** Unit ester input, absorption -> hydrolysis -> clearance. Stable at all equal rates. */
export function threeCompartment(tau, ka, kh, ke) {
  if (tau <= 0) return 0;
  if (tau * Math.min(ka, kh, ke) > 750) return 0;
  const max = Math.max(ka, kh, ke), gap = Math.min(Math.abs(ka - kh), Math.abs(ka - ke), Math.abs(kh - ke));
  // Direct divided differences lose precision at coalescing roots and t≈0.
  if (gap < max * 0.01 || tau * max < 0.5) return matrixCentral(tau, ka, kh, ke);
  const value = ka * kh * (Math.exp(-ka * tau) / ((ka - kh) * (ka - ke))
    + Math.exp(-kh * tau) / ((kh - ka) * (kh - ke))
    + Math.exp(-ke * tau) / ((ke - ka) * (ke - kh)));
  return Math.max(0, value);
}

/** Per-dose amount in mg of circulating active parent, NOT input ester mg. */
export function mahiroAmount({ routeId, amount, hours, durationHours, pkSettings = DEFAULT_PK_SETTINGS }) {
  const p = MAHIRO_MODELS[routeId];
  if (!p) throw new Error(translate('该途径无可用药代模型参考参数。'));
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isFinite(hours)) throw new Error(translate('给药量或时间无效。'));
  if (hours <= 0) return 0;
  const dose = amount * p.molecularRatio;
  const two = rate => twoCompartment(hours, rate, p.clearanceRate);
  const three = rate => threeCompartment(hours, rate, p.hydrolysisRate, p.clearanceRate);
  if (p.kernelKind === 'depot') return dose * p.formationFraction * (p.fastFraction * three(p.absorptionRate) + (1 - p.fastFraction) * three(p.slowAbsorptionRate));
  if (p.kernelKind === 'sublingual') {
    const theta = pkSettings.sublingualFraction;
    const mucosal = p.hydrolysisRate > 0 ? three(p.absorptionRate) : two(p.absorptionRate);
    return dose * (theta * mucosal + (1 - theta) * p.oralBioavailability * two(p.swallowedAbsorptionRate));
  }
  if (p.kernelKind === 'patch') {
    const duration = durationHours ?? p.durationHours;
    if (!Number.isFinite(duration) || duration <= 0 || duration > 8760) throw new Error(translate('贴片实际佩戴时长须为0–8760小时内的正数。'));
    const rate = amount / (p.unit === 'μg/day' ? 24000 : 24);
    return rate / p.clearanceRate * -Math.expm1(-p.clearanceRate * Math.min(hours, duration)) * Math.exp(-p.clearanceRate * Math.max(0, hours - duration));
  }
  return dose * p.bioavailability * two(p.absorptionRate);
}

export function mahiroConcentrationScale(routeId, bodyWeightKg = DEFAULT_PK_SETTINGS.bodyWeightKg) {
  const p = MAHIRO_MODELS[routeId];
  // mg→pg/mL E2 = 1e9 / (L/kg * kg * 1000); mg→ng/dL T = 1e8 / same.
  return (p.analyte === 'estradiol' ? 1e6 : 1e5) / (p.vdLPerKg * bodyWeightKg);
}

const names = {
  'e2-oral': '雌二醇 · 口服', 'e2-ev-oral': '戊酸雌二醇 EV · 口服',
  'e2-sublingual': '雌二醇 · 舌下', 'e2-ev-sublingual': '戊酸雌二醇 EV · 舌下',
  'e2-gel': '雌二醇 · 凝胶', 'e2-patch': '雌二醇 · 贴片',
  'e2-eb-im': '苯甲酸雌二醇 EB · 肌注', 'e2-ev-im': '戊酸雌二醇 EV · 肌注',
  'e2-ec-im': '环戊丙酸雌二醇 EC · 肌注', 'e2-een-im': '庚酸雌二醇 EEn · 肌注',
  't-cypionate-im': '环戊丙酸睾酮 TC · 肌注', 't-enanthate-im': '庚酸睾酮 TE · 肌注',
  't-undecanoate-im': '十一酸睾酮 TU · 肌注', 't-gel': '睾酮 · 凝胶', 't-patch': '睾酮 · 贴片',
};
export const MAHIRO_PROFILES = Object.freeze(Object.entries(MAHIRO_MODELS).map(([id, p]) => Object.freeze({
  id, get name(){return names[id].split(' · ').map(part=>translate(part)).join(' · ');}, analyte: p.analyte, model: 'mahiro', kernelKind: p.kernelKind,
  unit: p.unit ?? 'mg', doseUnit: p.unit ?? 'mg', concentrationUnit: p.analyte === 'estradiol' ? 'pg/mL' : 'ng/dL',
  defaults: Object.freeze({ absorptionHalfLifeHours: Math.LN2 / (p.absorptionRate ?? p.clearanceRate), eliminationHalfLifeHours: Math.LN2 / p.clearanceRate,
    ...(p.durationHours ? { durationHours: p.durationHours } : {}) }),
  pkParameters: p, sources: [MAHIRO_SOURCE], get evidence(){return translate('经验参考模拟；未经个体或临床验证');},
  get note(){return translate(p.kernelKind === 'sublingual'
    ? '双分支参考模型：黏膜吸收与吞咽首过分别计算；EV黏膜分支额外经酯水解。剂量为片剂标示的化合物mg，分子量只换算一次；黏膜比例默认11%为经验假设。'
    : p.kernelKind === 'depot' ? '双储库→酯水解→清除参考模型；形成分数和清除常数是经验有效参数，输入为酯mg，不等同于游离激素mg。'
      : p.kernelKind === 'gel' ? '凝胶参考模型，默认普通手臂/大腿参数；产品、涂抹部位与个体差异未个体化。输入有效激素mg。'
        : p.kernelKind === 'patch' ? '恒速释放参考模型，剂量为标称每日释放量；按实际佩戴时长停止输入，移除后继续衰减。'
          : '口服参考模型；EV首过与水解近似折入有效吸收速率，按酯mg输入并进行一次分子量换算。');},
})));
