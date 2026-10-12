import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { collectDueReminders, appendReminderLog, nextReminderAt } from '../src/reminders.js';
const require = createRequire(import.meta.url);
const { defaultState, validateState, parseState, createStateStore } = require('../electron/state.cjs');

const start = '2026-10-11T00:00:00.000Z';
const plan = { id: 'morning', name: '定期记录', enabled: true, startAt: start, intervalHours: 8 };
const state = (overrides = {}) => ({ plans: [plan], doses: [], reminderLog: [], ...overrides });

test('not due before start, due once at exact start and future recurrence', () => {
  const now = Date.parse(start);
  assert.deepEqual(collectDueReminders(state(), now - 1), []);
  const first = collectDueReminders(state(), now);
  assert.equal(first.length, 1);
  assert.equal(first[0].status, 'notified');
  const persisted = state({ reminderLog: appendReminderLog([], first) });
  assert.equal(collectDueReminders(persisted, now + 30000).length, 0);
  assert.equal(collectDueReminders(persisted, now + 8 * 3600000).length, 1);
});

test('restart restores deduplication and never manufactures a dose', () => {
  const initial = state();
  const due = collectDueReminders(initial, Date.parse(start));
  const restarted = JSON.parse(JSON.stringify({ ...initial, reminderLog: appendReminderLog([], due) }));
  assert.deepEqual(collectDueReminders(restarted, Date.parse(start) + 60000), []);
  assert.deepEqual(restarted.doses, []);
});

test('sleep recovery emits only latest missed event, not accumulated occurrences', () => {
  const now = Date.parse(start) + 73 * 3600000;
  const due = collectDueReminders(state(), now);
  assert.equal(due.length, 1);
  assert.equal(due[0].scheduledAt, '2026-10-14T00:00:00.000Z');
  assert.equal(due[0].status, 'missed');
  assert.deepEqual(collectDueReminders(state({ reminderLog: appendReminderLog([], due) }), now), []);
});

test('disabling or removing plan cancels subsequent reminders', () => {
  assert.deepEqual(collectDueReminders(state({ plans: [{ ...plan, enabled: false }] }), Date.parse(start)), []);
  assert.deepEqual(collectDueReminders(state({ plans: [] }), Date.parse(start)), []);
});

test('fractional hour intervals and next due time work across midnight', () => {
  const fractional = { ...plan, intervalHours: 1.5 };
  assert.equal(nextReminderAt(fractional, Date.parse(start) + 89 * 60000), Date.parse(start) + 90 * 60000);
  assert.equal(nextReminderAt(fractional, Date.parse(start) + 90 * 60000), Date.parse(start) + 180 * 60000);
  assert.equal(nextReminderAt({ ...plan, enabled: false }), null);
});

test('bounded log protects latest records of less frequent plans', () => {
  const slow = { id: 'slow@1', planId: 'slow', scheduledAt: start, at: start, status: 'notified' };
  const fast = Array.from({ length: 20 }, (_, i) => ({ id: `fast@${i}`, planId: 'fast', scheduledAt: start, at: new Date(Date.parse(start) + i * 1000 + 1000).toISOString(), status: 'notified' }));
  const log = appendReminderLog([slow], fast, 5);
  assert.equal(log.length, 5);
  assert.ok(log.some((record) => record.id === 'slow@1'));
  assert.ok(log.some((record) => record.id === 'fast@19'));
});

test('malformed plan cannot create a runaway reminder loop', () => {
  for (const intervalHours of [0, -1, NaN, Infinity]) {
    assert.deepEqual(collectDueReminders(state({ plans: [{ ...plan, intervalHours }] }), Date.parse(start)), []);
  }
});

test('import validation rejects unsupported routes, negative values, and duplicate records', () => {
  const valid = defaultState();
  valid.plans.push({ ...plan, routeId: 'e2-oral', amount: 2 });
  assert.equal(validateState(valid).plans.length, 1);
  assert.throws(() => validateState({ ...valid, plans: [{ ...valid.plans[0], routeId: 'unknown' }] }), /未知给药方式/);
  assert.throws(() => validateState({ ...valid, plans: [{ ...valid.plans[0], amount: -2 }] }), /数据格式/);
  assert.throws(() => validateState({ ...valid, plans: [valid.plans[0], valid.plans[0]] }), /重复/);
  assert.throws(() => parseState(JSON.stringify({ ...valid, schemaVersion: 99 })), /版本/);
});

test('mood events and both hormone laboratory units survive storage normalization', () => {
  const initial = defaultState();
  initial.moods.push({ id: 'mood-1', action: 'mood-good', at: start });
  initial.labs.push({ id: 'e2-1', analyte: 'estradiol', value: 100, unit: 'pmol/L', at: start });
  initial.labs.push({ id: 't-1', analyte: 'testosterone', value: 10, unit: 'nmol/L', at: start });
  const loaded = parseState(JSON.stringify(initial));
  assert.deepEqual(loaded.moods, initial.moods);
  assert.deepEqual(loaded.labs, initial.labs);
});

test('atomic storage keeps previous valid snapshot and recovers corrupt primary without erasing evidence', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaolang-store-test-'));
  try {
    const store = createStateStore(folder);
    const initial = defaultState();
    store.save(initial);
    store.save({ ...initial, settings: { ...initial.settings, name: '潮汐' } });
    assert.equal(JSON.parse(fs.readFileSync(store.file, 'utf8')).settings.name, '潮汐');
    assert.equal(JSON.parse(fs.readFileSync(store.backup, 'utf8')).settings.name, '鲨鲨');
    fs.writeFileSync(store.file, '{broken');
    const restarted = createStateStore(folder);
    const recovered = restarted.load();
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.state.settings.name, '鲨鲨');
    restarted.save(recovered.state);
    assert.equal(JSON.parse(fs.readFileSync(store.backup, 'utf8')).settings.name, '鲨鲨');
    assert.ok(fs.readdirSync(folder).some((name) => name.startsWith('state.corrupt-')));
    assert.ok(!fs.readdirSync(folder).some((name) => name.endsWith('.tmp')));
  } finally {
    // This freshly created test fixture is the only deletion target.
    assert.equal(path.dirname(path.resolve(folder)), path.resolve(os.tmpdir()));
    assert.match(path.basename(folder), /^xiaolang-store-test-/);
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('imported extra properties cannot modify Object.prototype', () => {
  const json = JSON.stringify(defaultState()).replace('"modelConfigs":{}', '"modelConfigs":{},"__proto__":{"polluted":true}');
  const checked = parseState(json);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.hasOwn(checked, '__proto__'), false);
});

test('import model time limits agree with the PK model maximum', () => {
  for (const parameter of ['absorptionHalfLifeHours', 'eliminationHalfLifeHours', 'durationHours']) {
    const initial = defaultState();
    initial.modelConfigs['e2-patch'] = { [parameter]: 8760 };
    assert.equal(validateState(initial).modelConfigs['e2-patch'][parameter], 8760);
    initial.modelConfigs['e2-patch'][parameter] = 8760.001;
    assert.throws(() => validateState(initial), /模型时间参数/);
  }
});

/** Execute the main-process error paths with an in-memory Electron stub, no GUI. */
function desktopHarness({ notifications = true, notificationThrows = false, packaged = false, shortcutSaved = true, watchThrows = false } = {}) {
  const errors = [], notificationCalls = [], shortcutCalls = [], warnings = [], fullscreenCallbacks = [], petEvents = [];
  class FakeNotification extends EventEmitter {
    static isSupported() { return true; }
    constructor(options) { super(); this.options = options; }
    show() { if (notificationThrows) throw new Error('Notification unavailable'); notificationCalls.push(this); }
  }
  const fakeElectron = {
    protocol: { registerSchemesAsPrivileged() {} },
    app: { setName() {}, setPath() {}, getName: () => '潮汐', setAppUserModelId() {}, requestSingleInstanceLock: () => false, quit() {}, isPackaged: packaged, getPath: () => 'C:\\Users\\Fixture\\AppData\\Roaming' },
    Notification: FakeNotification,
    nativeImage: { createFromBuffer: () => ({}) },
    dialog: { showErrorBox: (title, message) => errors.push({ title, message }), showMessageBox: (options) => { warnings.push(options); return Promise.resolve({ response: 0 }); } },
    shell: { writeShortcutLink: (...args) => { shortcutCalls.push(args); return shortcutSaved; } },
  };
  const mainFile = fileURLToPath(new URL('../electron/main.cjs', import.meta.url));
  const context = vm.createContext({
    require: (specifier) => specifier === 'electron' ? fakeElectron : specifier === 'node:fs' ? { mkdirSync() {}, existsSync: () => false } : specifier === 'node:path' ? path.win32 : specifier === './fullscreen.cjs' ? { watchFullscreen(onChange, onError) { if (watchThrows) throw new Error('Helper unavailable'); fullscreenCallbacks.push({ onChange, onError }); return () => {}; } } : require(specifier.startsWith('.') ? path.resolve(path.dirname(mainFile), specifier) : specifier),
    __dirname: path.dirname(mainFile), process: { platform: 'win32', execPath: 'C:\\Fixture\\Tide Companion.exe', argv: [] },
    URL, Buffer, Date, console, setInterval, clearInterval,
    __initial: { ...defaultState(), settings: { ...defaultState().settings, notifications }, plans: [{ ...plan, startAt: new Date(Date.now() - 3600000).toISOString(), routeId: 'e2-oral', amount: 2 }] },
    __reminders: { collectDueReminders, appendReminderLog },
    __petEvents: petEvents,
  });
  vm.runInContext(fs.readFileSync(mainFile, 'utf8'), context, { filename: mainFile });
  vm.runInContext('state = __initial; reminders = __reminders; store = { save() { throw new Error("Disk is full"); } };', context);
  return { context, errors, notificationCalls, shortcutCalls, warnings, fullscreenCallbacks, petEvents };
}

test('failed reminder storage remains unacknowledged and visibly reports once even with hidden windows', () => {
  const harness = desktopHarness();
  vm.runInContext('reminderTick(); reminderTick();', harness.context);
  assert.equal(harness.notificationCalls.length, 1);
  assert.match(harness.notificationCalls[0].options.body, /无法保存/);
  assert.equal(vm.runInContext('state.reminderLog.length', harness.context), 0);
  assert.equal(vm.runInContext('state.doses.length', harness.context), 0);
  harness.notificationCalls[0].emit('failed');
  assert.equal(harness.errors.length, 1);
});

test('unavailable or disabled system notifications use one visible storage error fallback', () => {
  for (const options of [{ notifications: false }, { notificationThrows: true }]) {
    const harness = desktopHarness(options);
    assert.doesNotThrow(() => vm.runInContext('reminderTick(); reminderTick();', harness.context));
    assert.equal(harness.errors.length, 1);
    assert.equal(vm.runInContext('state.reminderLog.length', harness.context), 0);
  }
});

test('tray storage failure is caught and leaves the previous visibility state unchanged', () => {
  const harness = desktopHarness();
  assert.equal(vm.runInContext('runDesktopAction(() => setPetVisible(false))', harness.context), false);
  assert.equal(harness.errors.length, 1);
  assert.equal(vm.runInContext('state.settings.petVisible', harness.context), true);
});

test('notification shortcut is limited to packaged builds and fails without aborting startup', () => {
  const development = desktopHarness();
  vm.runInContext('registerNotificationShortcut()', development.context);
  assert.equal(development.shortcutCalls.length, 0);
  const release = desktopHarness({ packaged: true });
  vm.runInContext('registerNotificationShortcut()', release.context);
  assert.equal(release.shortcutCalls.length, 1);
  const [shortcut, operation, details] = release.shortcutCalls[0];
  assert.match(shortcut, /Microsoft\\Windows\\Start Menu\\Programs\\潮汐\.lnk$/);
  assert.equal(operation, 'create');
  assert.equal(details.appUserModelId, 'org.transpet.desktop');
  assert.equal(details.target, 'C:\\Fixture\\Tide Companion.exe');
  assert.equal(details.cwd, 'C:\\Fixture');
  const failure = desktopHarness({ packaged: true, shortcutSaved: false });
  assert.doesNotThrow(() => vm.runInContext('registerNotificationShortcut()', failure.context));
  assert.equal(failure.warnings.length, 1);
});

test('legacy state migrates the former default name and adds settings without changing health records', () => {
  const old = defaultState();
  for (const key of ['nameCustomized','mode','activeSkin','skinScale','autoHideFullscreen']) delete old.settings[key];
  delete old.referenceBaselines;
  old.settings.name = '小浪';
  old.plans = [{ ...plan, routeId: 'e2-oral', amount: 2 }];
  old.doses = [{ id: 'historic', routeId: 'e2-oral', amount: 2, at: start }];
  old.labs = [{ id: 'lab-historic', analyte: 'estradiol', value: 100, unit: 'pg/mL', at: start }];
  old.baselines = { estradiol: 15, testosterone: 40 };
  const migrated = validateState(old);
  assert.equal(migrated.settings.name, '鲨鲨');
  assert.equal(migrated.settings.nameCustomized, false);
  assert.equal(migrated.settings.mode, 'mtf');
  assert.equal(migrated.settings.activeSkin, 'builtin');
  assert.equal(migrated.settings.skinScale, 1);
  assert.equal(migrated.settings.autoHideFullscreen, true);
  assert.deepEqual(migrated.referenceBaselines, defaultState().referenceBaselines);
  for (const field of ['plans','doses','labs','baselines']) assert.deepEqual(migrated[field], old[field]);
  assert.equal(old.settings.name, '小浪');
  old.settings.name = '阿蓝';
  assert.equal(validateState(old).settings.name, '阿蓝');
  old.settings.name = '小浪'; old.settings.nameCustomized = true;
  assert.equal(validateState(old).settings.name, '小浪');
});

test('first v0.2 load permanently snapshots legacy data before normal backups rotate', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaolang-migration-test-'));
  try {
    const old = defaultState(); old.settings.name = '小浪'; delete old.settings.nameCustomized; delete old.settings.mode; delete old.referenceBaselines;
    const original = JSON.stringify(old);
    fs.writeFileSync(path.join(folder, 'state.json'), original);
    const store = createStateStore(folder);
    const loaded = store.load();
    assert.equal(loaded.migrated, true);
    const snapshots = fs.readdirSync(folder).filter(name => name.startsWith('state.before-v0.2-migration-'));
    assert.equal(snapshots.length, 1);
    store.save(loaded.state);
    store.save({ ...loaded.state, settings: { ...loaded.state.settings, name: '我的鲨鱼', nameCustomized: true } });
    assert.equal(fs.readFileSync(path.join(folder, snapshots[0]), 'utf8'), original);
    const restarted = createStateStore(folder).load();
    assert.equal(restarted.migrated, false);
    assert.equal(restarted.state.settings.name, '我的鲨鱼');
    assert.equal(fs.readdirSync(folder).filter(name => name.startsWith('state.before-v0.2-migration-')).length, 1);
  } finally {
    assert.equal(path.dirname(path.resolve(folder)), path.resolve(os.tmpdir()));
    assert.match(path.basename(folder), /^xiaolang-migration-test-/);
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('CPA records and explicit reference baselines persist independently of fitted baselines', () => {
  const input = defaultState();
  input.settings.mode = 'ftm';
  input.referenceBaselines = { estradiol: 70, testosterone: 35 };
  input.baselines = { estradiol: 2, testosterone: 3 };
  input.doses = [{ id: 'cpa-1', routeId: 'cpa-oral', amount: 12.5, at: start }];
  input.plans = [{ ...plan, id: 'cpa-plan', routeId: 'cpa-oral', amount: 12.5 }];
  const stored = parseState(JSON.stringify(input));
  assert.deepEqual(stored.doses, input.doses);
  assert.deepEqual(stored.plans, input.plans);
  assert.deepEqual(stored.referenceBaselines, input.referenceBaselines);
  assert.deepEqual(stored.baselines, input.baselines);
  assert.throws(() => validateState({ ...input, settings: { ...input.settings, activeSkin: '../../state.json' } }), /皮肤 ID/);
  assert.throws(() => validateState({ ...input, settings: { ...input.settings, skinScale: 10 } }), /皮肤缩放/);
});

test('fullscreen suppression is temporary and never overwrites the user visibility preference', () => {
  const harness = desktopHarness();
  vm.runInContext("pet = { isDestroyed: () => false, hide() { __petEvents.push('hide'); }, showInactive() { __petEvents.push('show'); } }; startFullscreenWatch();", harness.context);
  harness.fullscreenCallbacks[0].onChange(true);
  assert.equal(harness.petEvents.at(-1), 'hide');
  assert.equal(vm.runInContext('state.settings.petVisible', harness.context), true);
  harness.fullscreenCallbacks[0].onChange(false);
  assert.equal(harness.petEvents.at(-1), 'show');
  vm.runInContext('state.settings.petVisible = false;', harness.context);
  const before = harness.petEvents.length;
  harness.fullscreenCallbacks[0].onError();
  assert.equal(harness.petEvents.length, before);
  assert.equal(vm.runInContext('state.settings.petVisible', harness.context), false);
  assert.equal(vm.runInContext('state.reminderLog.length', harness.context), 0);
});

test('fullscreen helper launch failure does not prevent the app from continuing', () => {
  const harness = desktopHarness({ watchThrows: true });
  vm.runInContext("pet = { isDestroyed: () => false, hide() { __petEvents.push('hide'); }, showInactive() { __petEvents.push('show'); } };", harness.context);
  assert.doesNotThrow(() => vm.runInContext('startFullscreenWatch()', harness.context));
  assert.equal(harness.petEvents.at(-1), 'show');
});
