import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { defaultState, validateState, parseState, createStateStore } = require('../electron/state.cjs');
const { localDayKey, migrateDailyMoods, validateDailyMoods, appendDailyMood, restoreDailyMoods, MAX_DAILY_MOODS } = require('../electron/daily-moods.cjs');
const mainFile = fileURLToPath(new URL('../electron/main.cjs', import.meta.url));
const now = new Date(2026, 9, 12, 12, 0, 0).getTime();
const entry = (mood = 'good', time = now) => ({ date: localDayKey(time), mood, at: new Date(time).toISOString() });

function fixture(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-daily-moods-'));
  const clean = () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.match(path.basename(directory), /^tide-daily-moods-/);
    fs.rmSync(directory, { recursive: true, force: true });
  };
  try {
    const result = run(directory);
    if (result?.finally) return result.finally(clean);
    clean();
    return result;
  } catch (error) { clean(); throw error; }
}

function harness(directory, initial = defaultState()) {
  const handlers = new Map(), broadcasts = [], clock = { now }, disk = { fail: false };
  const store = createStateStore(directory);
  store.save(initial);
  const normalize = (value) => validateState(JSON.parse(JSON.stringify(value)));
  const stateStore = { file: store.file, save(value) { if (disk.fail) throw new Error('Disk full'); return store.save(normalize(value)); } };
  const dialog = {
    async showSaveDialog() { return { filePath: path.join(directory, 'export.json') }; },
    async showOpenDialog() { return { canceled: false, filePaths: [path.join(directory, 'import.json')] }; },
    async showMessageBox() { return { response: 1 }; },
  };
  class TestDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.now])); }
    static now() { return clock.now; }
  }
  const context = vm.createContext({
    require(specifier) {
      // This harness exercises production mood persistence; window visual/drag
      // IPC is independently covered by shark-variants and native smoke tests.
      if (specifier === './pet-desktop.cjs') return { setupPetDesktop: () => ({ cancelDrag() {} }) };
      if (specifier === './pet-growth-desktop.cjs') return { setupPetGrowthDesktop: () => ({ dispose() {}, isFeeding: () => false }) };
      if (specifier === 'electron') return {
        app: { setName() {}, setPath() {}, getName: () => '潮汐', getPath: () => directory, setAppUserModelId() {}, requestSingleInstanceLock: () => false, quit() {}, isPackaged: false },
        protocol: { registerSchemesAsPrivileged() {} }, ipcMain: { on() {} }, dialog,
      };
      if (specifier === './state.cjs') return { ...require('../electron/state.cjs'), validateState: normalize };
      return require(specifier.startsWith('.') ? path.resolve(path.dirname(mainFile), specifier) : specifier);
    },
    __dirname: path.dirname(mainFile), process: { platform: 'win32', execPath: 'C:\\Fixture\\Tide-Companion.exe', argv: [] },
    Buffer, URL, console, Date: TestDate, __initial: initial, __store: stateStore, __handlers: handlers, __broadcasts: broadcasts,
  });
  vm.runInContext(fs.readFileSync(mainFile, 'utf8'), context, { filename: mainFile });
  vm.runInContext('state = __initial; store = __store; handle = (channel, handler) => __handlers.set(channel, handler); broadcast = (channel, value) => __broadcasts.push({channel, value}); setupIpc();', context);
  return { call: (channel, ...args) => handlers.get(channel)(...args), state: () => vm.runInContext('state', context), clock, disk, broadcasts, store };
}

test('local diary dates stay correct around UTC midnight in positive and negative timezones', () => {
  const file = fileURLToPath(new URL('../electron/daily-moods.cjs', import.meta.url));
  for (const [tz, instant, expected] of [
    ['Asia/Shanghai', '2026-10-11T16:30:00.000Z', '2026-10-12'],
    ['America/Los_Angeles', '2026-10-12T04:30:00.000Z', '2026-10-11'],
  ]) {
    const script = `process.stdout.write(require(${JSON.stringify(file)}).localDayKey(${JSON.stringify(instant)}))`;
    assert.equal(execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', env: { ...process.env, TZ: tz }, windowsHide: true }), expected);
  }
});

test('no selection remains an unlocked implicit middle mood, not a stored fake choice', () => {
  assert.deepEqual(defaultState().dailyMoods, []);
  assert.deepEqual(validateState(defaultState()).dailyMoods, []);
  const state = defaultState();
  state.moods = [{ id: 'old-choice', action: 'mood-good', at: entry().at }];
  assert.deepEqual(validateState(state).dailyMoods, []);
  assert.equal(appendDailyMood([], { action: 'mood-okay', at: entry().at })[0].mood, 'okay');
});

test('daily records reject invalid dates, values, duplicate days, timestamps and excessive capacity', () => {
  assert.equal(validateDailyMoods([{ ...entry(), date: '2024-02-29' }])[0].date, '2024-02-29');
  for (const date of ['2026-02-29', '2026-04-31', '2026-13-01', '2026-00-10', '2026-1-01', '0000-01-01', '2026-10-00']) {
    assert.throws(() => validateState({ ...defaultState(), dailyMoods: [{ ...entry(), date }] }), /心情日期/);
  }
  for (const mood of ['great', '', null, 0]) assert.throws(() => validateDailyMoods([{ ...entry(), mood }]), /心情选项/);
  for (const at of ['yesterday', '2026-02-30T12:00:00.000Z', null]) assert.throws(() => validateDailyMoods([{ ...entry(), at }]), /心情/);
  for (const value of [null, {}, '']) assert.throws(() => validateDailyMoods(value), /每日心情/);
  assert.throws(() => validateDailyMoods([entry(), entry('low')]), /重复日期/);
  assert.throws(() => validateDailyMoods(Array(MAX_DAILY_MOODS + 1).fill(entry())), /每日心情/);
  assert.deepEqual(validateDailyMoods([{ ...entry(), unwanted: 'ignored' }]), [entry()]);
});

test('legacy migration keeps the earliest explicit choice per local day and excludes future actions', () => {
  const yesterday = now - 86400000;
  const events = [
    { id: 'latest', action: 'mood-low', at: new Date(now - 1000).toISOString() },
    { id: 'feed', action: 'feed', at: new Date(yesterday).toISOString() },
    { id: 'first', action: 'mood-good', at: new Date(now - 2000).toISOString() },
    { id: 'older', action: 'mood-okay', at: new Date(yesterday).toISOString() },
    { id: 'future', action: 'mood-low', at: new Date(now + 86400000).toISOString() },
  ];
  assert.deepEqual(migrateDailyMoods(events, now), [entry('okay', yesterday), entry('good', now - 2000)]);
});

test('migration permanently snapshots v0.5.2 before adding diary days and preserves all health information', () => fixture(directory => {
  const legacy = defaultState();
  delete legacy.dailyMoods;
  legacy.moods = [{ id: 'old-mood', action: 'mood-low', at: '2020-01-01T00:00:00.000Z' }];
  legacy.doses = [{ id: 'dose', routeId: 'e2-oral', amount: 2, at: '2020-01-01T00:00:00.000Z' }];
  legacy.labs = [{ id: 'lab', analyte: 'estradiol', value: 100, unit: 'pg/mL', at: '2020-01-01T00:00:00.000Z' }];
  legacy.modelConfigs = { 'cpa-oral': { eliminationHalfLifeHours: 48 } };
  legacy.pkSettings = { bodyWeightKg: 61, sublingualFraction: 0.2 };
  const original = JSON.stringify(legacy);
  fs.writeFileSync(path.join(directory, 'state.json'), original);
  const store = createStateStore(directory), loaded = store.load();
  assert.equal(loaded.migrated, true);
  assert.equal(loaded.state.dailyMoods.length, 1);
  for (const key of ['settings', 'doses', 'labs', 'plans', 'modelConfigs', 'pkSettings', 'referenceBaselines', 'baselines', 'moods']) assert.deepEqual(loaded.state[key], legacy[key]);
  const snapshot = fs.readdirSync(directory).find(name => name.startsWith('state.before-v0.6.0-migration-'));
  assert.ok(snapshot);
  store.save(loaded.state);
  store.save({ ...loaded.state, moods: [] });
  assert.equal(fs.readFileSync(path.join(directory, snapshot), 'utf8'), original);
  const reopened = createStateStore(directory).load();
  assert.equal(reopened.migrated, false);
  assert.deepEqual(reopened.state.dailyMoods, loaded.state.dailyMoods);
}));

test('first mood persists before it is broadcast, duplicate and concurrent attempts cannot change it', () => fixture(async directory => {
  const h = harness(directory);
  const results = await Promise.allSettled(['mood-good', 'mood-low'].map(action => Promise.resolve().then(() => h.call('pet:interact', action))));
  assert.deepEqual(results.map(result => result.status), ['fulfilled', 'rejected']);
  assert.equal(h.state().dailyMoods[0].mood, 'good');
  assert.equal(h.state().moods.length, 1);
  assert.throws(() => h.call('pet:interact', 'mood-good'), /今天的心情已经记下/);
  assert.deepEqual(JSON.parse(fs.readFileSync(h.store.file, 'utf8')).dailyMoods, [entry()]);
  assert.equal(h.broadcasts.filter(event => event.channel === 'pet:action').length, 1);
  assert.deepEqual(h.broadcasts.filter(event => event.channel === 'state:changed').at(-1).value.dailyMoods, [entry()]);
}));

test('failed saving leaves today unlocked and emits no successful mood response', () => fixture(directory => {
  const h = harness(directory);
  h.disk.fail = true;
  assert.throws(() => h.call('pet:interact', 'mood-low'), /Disk full/);
  assert.deepEqual(h.state().dailyMoods, []);
  assert.deepEqual(h.state().moods, []);
  assert.equal(h.broadcasts.length, 0);
  h.disk.fail = false;
  h.call('pet:interact', 'mood-good');
  assert.deepEqual(h.state().dailyMoods, [entry()]);
}));

test('ordinary state saves cannot erase, forge or overwrite daily choices from a stale UI snapshot', () => fixture(directory => {
  const h = harness(directory);
  const stale = structuredClone(h.state());
  h.call('pet:interact', 'mood-low');
  stale.dailyMoods = [{ ...entry(), mood: 'good' }];
  stale.settings.name = '阿潮';
  h.call('state:save', stale);
  assert.equal(h.state().settings.name, '阿潮');
  assert.deepEqual(h.state().dailyMoods, [entry('low')]);
  delete stale.dailyMoods;
  h.call('state:save', stale);
  assert.deepEqual(h.state().dailyMoods, [entry('low')]);
}));

test('200-event interaction rollover and restarting cannot unlock a selected day; local midnight can', () => fixture(directory => {
  let h = harness(directory);
  h.call('pet:interact', 'mood-low');
  for (let i = 0; i < 205; i++) h.call('pet:interact', 'nuzzle');
  assert.equal(h.state().moods.length, 200);
  assert.equal(h.state().moods.some(event => event.action.startsWith('mood-')), false);
  const persisted = createStateStore(directory).load().state;
  h = harness(directory, persisted);
  assert.throws(() => h.call('pet:interact', 'mood-good'), /今天的心情/);
  h.clock.now = new Date(2026, 9, 13, 0, 0, 1).getTime();
  h.call('pet:interact', 'mood-okay');
  assert.deepEqual(h.state().dailyMoods.map(item => item.date), ['2026-10-12', '2026-10-13']);
  assert.deepEqual(h.state().dailyMoods.map(item => item.mood), ['low', 'okay']);
}));

test('export includes permanent diary; explicit restore replaces history while preserving today’s lock', () => fixture(async directory => {
  const h = harness(directory);
  h.call('pet:interact', 'mood-low');
  await h.call('data:export');
  const exported = parseState(fs.readFileSync(path.join(directory, 'export.json'), 'utf8'));
  assert.deepEqual(exported.dailyMoods, [entry('low')]);
  const imported = defaultState();
  imported.settings.activeSkin = 'builtin-rose';
  imported.dailyMoods = [entry('good', now - 86400000), entry('good')];
  fs.writeFileSync(path.join(directory, 'import.json'), JSON.stringify(imported));
  await h.call('data:import');
  assert.equal(h.state().settings.activeSkin, 'builtin-rose', 'a bundled companion selection restores without external model files');
  assert.deepEqual(h.state().dailyMoods, [entry('good', now - 86400000), entry('low')]);
  assert.throws(() => h.call('pet:interact', 'mood-good'), /今天的心情/);
  assert.ok(fs.readdirSync(directory).some(name => name.startsWith('before-import-')));
  assert.deepEqual(restoreDailyMoods([entry('good')], [], now), [entry('good')]);
}));
