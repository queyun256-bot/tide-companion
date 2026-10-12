'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const BUILTIN_SKIN_IDS = new Set(require('../assets/sharks/catalog.json').map(item => item.id));
const { validateDailyMoods, migrateDailyMoods } = require('./daily-moods.cjs');
const { emptyStarWallet, validateStarWallet } = require('./star-wallet.cjs');
const { deriveGrowth } = require('./pet-growth.cjs');

const ROUTE_IDS = new Set(require('../src/medication-catalog.json').items.map(item => item.id));
const REFERENCE_PRESETS = require('../src/reference-presets.json');
const ACTIONS = new Set(['pet', 'feed', 'sleep', 'wake', 'nuzzle', 'mood-good', 'mood-okay', 'mood-low']);
const MAX_BYTES = 5 * 1024 * 1024;

function defaultState() {
  return {
    schemaVersion: 1,
    settings: { name: '鲨鲨', nameCustomized: false, pronouns: '', mode: 'mtf', onboardingCompleted: false, showFtmEstradiol: false, alwaysOnTop: true, launchAtLogin: false, notifications: true, privateNotifications: true, petVisible: true, reducedMotion: false, autoHideFullscreen: true, activeSkin: 'builtin', skinScale: 1 },
    plans: [], doses: [], labs: [], modelConfigs: {}, pkSettings: { bodyWeightKg: 70, sublingualFraction: 0.11 }, baselines: { estradiol: 0, testosterone: 0 }, referenceBaselines: { ...REFERENCE_PRESETS.baselines.mtf }, referencePresetVersion: REFERENCE_PRESETS.version, referenceBaselineCustomized: false, moods: [], dailyMoods: [], reminderLog: [], starWallet: emptyStarWallet(), petGrowth: deriveGrowth(emptyStarWallet()),
  };
}

function fail(label) { throw new Error(`数据格式不正确：${label}`); }
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail(label);
  return value;
}
function str(value, label, max = 120, empty = false) {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) fail(label);
  return value;
}
function id(value, label) {
  str(value, label, 100);
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) fail(label);
  return value;
}
function num(value, label, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(label);
  return value;
}
function bool(value, label) { if (typeof value !== 'boolean') fail(label); return value; }
function date(value, label) {
  str(value, label, 40);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) fail(label);
  return new Date(value).toISOString();
}
function route(value) { if (!ROUTE_IDS.has(value)) fail('未知给药方式'); return value; }
function array(value, label, max, mapper) {
  if (!Array.isArray(value) || value.length > max) fail(label);
  const result = value.map(mapper);
  const ids = result.map((entry) => entry.id).filter(Boolean);
  if (new Set(ids).size !== ids.length) fail(`${label}存在重复 ID`);
  return result;
}
function optionalDuration(input, result) {
  if (input.durationHours !== undefined) result.durationHours = num(input.durationHours, '持续时长', 0.01, 8760);
  return result;
}

/** Reconstruct known fields rather than accepting imported prototype/unknown data. */
function validateState(input) {
  object(input, '状态');
  if (input.schemaVersion !== 1) fail('不支持的版本');
  const out = defaultState();
  const settings = object(input.settings, '设置');
  const priorName = str(settings.name, '桌宠名字', 40);
  const legacyName = settings.nameCustomized === undefined;
  out.settings.name = legacyName && priorName === '小浪' ? '鲨鲨' : priorName;
  out.settings.nameCustomized = legacyName ? !['小浪', '鲨鲨'].includes(priorName) : bool(settings.nameCustomized, '自定义名字');
  out.settings.pronouns = str(settings.pronouns ?? '', '称谓', 60, true);
  if (settings.mode !== undefined && !['mtf', 'ftm'].includes(settings.mode)) fail('陪伴模式');
  out.settings.mode = settings.mode ?? 'mtf';
  out.settings.onboardingCompleted = settings.onboardingCompleted === undefined ? false : bool(settings.onboardingCompleted, '初始设置完成状态');
  out.settings.showFtmEstradiol = settings.showFtmEstradiol === undefined ? false : bool(settings.showFtmEstradiol, 'FTM 显示 E2');
  out.settings.autoHideFullscreen = settings.autoHideFullscreen === undefined ? true : bool(settings.autoHideFullscreen, '全屏时隐藏');
  if (settings.activeSkin !== undefined && !BUILTIN_SKIN_IDS.has(settings.activeSkin) && !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(settings.activeSkin)) fail('皮肤 ID');
  out.settings.activeSkin = settings.activeSkin ?? 'builtin';
  out.settings.skinScale = settings.skinScale === undefined ? 1 : num(settings.skinScale, '皮肤缩放', 0.5, 2);
  for (const key of ['alwaysOnTop', 'launchAtLogin', 'notifications', 'privateNotifications', 'petVisible', 'reducedMotion']) {
    out.settings[key] = bool(settings[key], key);
  }
  out.plans = array(input.plans, '计划', 100, (value) => {
    const item = object(value, '计划');
    return optionalDuration(item, {
      id: id(item.id, '计划 ID'), name: str(item.name, '计划名称', 120), routeId: route(item.routeId),
      amount: num(item.amount, '计划用量', 0.000001, 100000), intervalHours: num(item.intervalHours, '提醒间隔', 0.25, 8760),
      startAt: date(item.startAt, '计划开始时间'), enabled: bool(item.enabled, '计划状态'),
    });
  });
  out.doses = array(input.doses, '用药记录', 20000, (value) => {
    const item = object(value, '用药记录');
    const record = optionalDuration(item, { id: id(item.id, '记录 ID'), routeId: route(item.routeId), amount: num(item.amount, '记录用量', 0.000001, 100000), at: date(item.at, '记录时间') });
    if (item.planId !== undefined && item.planId !== null && item.planId !== '') record.planId = id(item.planId, '计划 ID');
    return record;
  });
  out.labs = array(input.labs, '化验记录', 10000, (value) => {
    const item = object(value, '化验记录');
    if (!['estradiol', 'testosterone', 'cpa'].includes(item.analyte)) fail('化验项目');
    const units = item.analyte === 'estradiol' ? ['pg/mL', 'pmol/L'] : item.analyte === 'cpa' ? ['ng/mL', 'nmol/L'] : ['ng/dL', 'nmol/L'];
    if (!units.includes(item.unit)) fail('化验单位');
    return { id: id(item.id, '化验 ID'), analyte: item.analyte, value: num(item.value, '化验数值', 0, 1000000), unit: item.unit, at: date(item.at, '化验时间') };
  });
  object(input.modelConfigs, '模型参数');
  if (input.pkSettings !== undefined) {
    const pk = object(input.pkSettings, '药代参考设置');
    out.pkSettings.bodyWeightKg = num(pk.bodyWeightKg ?? 70, '模型体重（kg）', 20, 400);
    out.pkSettings.sublingualFraction = num(pk.sublingualFraction ?? 0.11, '舌下黏膜吸收份额', 0, 1);
  }
  if (Object.keys(input.modelConfigs).length > ROUTE_IDS.size) fail('模型参数');
  for (const [key, value] of Object.entries(input.modelConfigs)) {
    route(key);
    const item = object(value, '模型参数');
    const config = {};
    for (const parameter of ['absorptionHalfLifeHours', 'eliminationHalfLifeHours', 'durationHours']) {
      if (item[parameter] !== undefined) config[parameter] = num(item[parameter], '模型时间参数', 0.001, 8760);
    }
    out.modelConfigs[key] = config;
  }
  const baselines = object(input.baselines, '基线');
  out.baselines.estradiol = num(baselines.estradiol, '雌二醇基线', 0, 1000000);
  out.baselines.testosterone = num(baselines.testosterone, '睾酮基线', 0, 1000000);
  out.referenceBaselines = { ...REFERENCE_PRESETS.baselines[out.settings.mode] };
  if (input.referenceBaselines !== undefined) {
    const reference = object(input.referenceBaselines, '参考基线');
    out.referenceBaselines = { estradiol: num(reference.estradiol, '雌二醇参考基线', 0, 1000000), testosterone: num(reference.testosterone, '睾酮参考基线', 0, 1000000) };
  }
  const legacyDefaults = out.settings.mode === 'ftm' ? { estradiol: 60, testosterone: 30 } : { estradiol: 20, testosterone: 450 };
  const isLegacyDefault = out.referenceBaselines.estradiol === legacyDefaults.estradiol && out.referenceBaselines.testosterone === legacyDefaults.testosterone;
  const isPreset = out.referenceBaselines.estradiol === REFERENCE_PRESETS.baselines[out.settings.mode].estradiol && out.referenceBaselines.testosterone === REFERENCE_PRESETS.baselines[out.settings.mode].testosterone;
  out.referenceBaselineCustomized = input.referenceBaselineCustomized === undefined ? !isLegacyDefault && !isPreset : bool(input.referenceBaselineCustomized, '自定义参考背景');
  if (!input.referencePresetVersion && isLegacyDefault && !out.referenceBaselineCustomized) out.referenceBaselines = { ...REFERENCE_PRESETS.baselines[out.settings.mode] };
  out.moods = array(input.moods ?? [], '互动记录', 1000, (value) => {
    const item = object(value, '互动记录');
    if (!ACTIONS.has(item.action)) fail('互动动作');
    return { id: id(item.id, '互动 ID'), at: date(item.at, '互动时间'), action: item.action };
  });
  out.dailyMoods = input.dailyMoods === undefined ? migrateDailyMoods(out.moods) : validateDailyMoods(input.dailyMoods);
  out.starWallet = validateStarWallet(input.starWallet);
  out.petGrowth = deriveGrowth(out.starWallet);
  out.reminderLog = array(input.reminderLog ?? [], '提醒记录', 1000, (value) => {
    const item = object(value, '提醒记录');
    if (!['notified', 'missed'].includes(item.status)) fail('提醒状态');
    const planId = id(item.planId, '提醒计划 ID');
    const scheduledAt = date(item.scheduledAt, '提醒计划时间');
    if (item.id !== `${planId}@${scheduledAt}`) fail('提醒 ID');
    const record = { id: item.id, planId, scheduledAt, at: date(item.at, '提醒时间'), status: item.status };
    // Historical reminder logs have no prescription snapshot and cannot earn stars.
    if (item.routeId !== undefined || item.amount !== undefined || item.intervalHours !== undefined || item.durationHours !== undefined) {
      record.routeId = route(item.routeId);
      record.amount = num(item.amount, '提醒快照用量', .000001, 100000);
      record.intervalHours = num(item.intervalHours, '提醒快照间隔', .25, 8760);
      optionalDuration(item, record);
    }
    return record;
  });
  return out;
}

function parseState(contents) {
  if (Buffer.byteLength(contents, 'utf8') > MAX_BYTES) fail('文件超过 5 MB');
  return validateState(JSON.parse(contents));
}

function createStateStore(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'state.json');
  const backup = path.join(directory, 'state.backup.json');
  let primaryValid = false;
  function save(state) {
    const normalized = validateState(state);
    const text = JSON.stringify(normalized, null, 2);
    if (Buffer.byteLength(text) > MAX_BYTES) fail('数据超过 5 MB');
    const temporary = path.join(directory, `.state-${crypto.randomUUID()}.tmp`);
    try {
      const fd = fs.openSync(temporary, 'wx', 0o600);
      try { fs.writeFileSync(fd, text, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      if (primaryValid && fs.existsSync(file)) fs.copyFileSync(file, backup);
      fs.renameSync(temporary, file);
      primaryValid = true;
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
    return normalized;
  }
  function readFile(candidate) {
    if (fs.statSync(candidate).size > MAX_BYTES) fail('文件超过 5 MB');
    const contents = fs.readFileSync(candidate, 'utf8');
    const original = JSON.parse(contents);
    const state = parseState(contents);
    const oldMigration = original.settings?.nameCustomized === undefined || original.settings?.activeSkin === undefined || original.settings?.mode === undefined || original.referenceBaselines === undefined;
    const backgroundMigration = original.referencePresetVersion === undefined || original.referenceBaselineCustomized === undefined;
    const pkMigration = original.pkSettings === undefined;
    const setupMigration = original.settings?.onboardingCompleted === undefined;
    const dailyMoodMigration = original.dailyMoods === undefined;
    const starWalletMigration = original.starWallet === undefined;
    const olderVersion = oldMigration ? '0.2' : backgroundMigration ? '0.3' : pkMigration ? '0.4' : setupMigration ? '0.5.1' : null;
    const migrationVersions = [...(olderVersion ? [olderVersion] : []), ...(dailyMoodMigration ? ['0.6.0'] : []), ...(starWalletMigration ? ['0.8.0'] : [])];
    return { state, migrated: migrationVersions.length > 0, migrationVersion: migrationVersions[0], migrationVersions };
  }
  function preserveMigration(candidate, loaded) {
    for (const version of loaded.migrationVersions) {
      fs.copyFileSync(candidate, path.join(directory, `state.before-v${version}-migration-${Date.now()}-${crypto.randomUUID()}.json`), fs.constants.COPYFILE_EXCL);
    }
  }
  function load() {
    if (!fs.existsSync(file)) return { state: defaultState(), recovered: false, fresh: true };
    let loaded;
    try {
      loaded = readFile(file);
    } catch {
      const quarantine = path.join(directory, `state.corrupt-${Date.now()}.json`);
      // If preservation fails, refuse to replace the original with empty data.
      fs.copyFileSync(file, quarantine);
      if (fs.existsSync(backup)) {
        try { loaded = readFile(backup); } catch { /* Preserve both files. */ }
        if (loaded) {
          preserveMigration(backup, loaded);
          return { ...loaded, recovered: true, fresh: false };
        }
      }
      return { state: defaultState(), recovered: true, fresh: true };
    }
    // A failed permanent snapshot must abort migration, not fall back to empty
    // state or write over a readable original.
    preserveMigration(file, loaded);
    primaryValid = true;
    return { ...loaded, recovered: false, fresh: false };
  }
  return { file, backup, load, save };
}

module.exports = { defaultState, validateState, parseState, createStateStore, MAX_BYTES, ACTIONS };
