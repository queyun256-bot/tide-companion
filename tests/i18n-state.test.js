import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { defaultState, validateState, parseState, createStateStore } = require('../electron/state.cjs');
const { createNativeI18n, readSystemLocale } = require('../electron/i18n.cjs');
const { createI18n } = require('../src/i18n-core.cjs');
const catalog = require('../src/locales/native.json');
const plain = value => JSON.parse(JSON.stringify(value));
function fixture(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-language-test-'));
  const clean = () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.match(path.basename(directory), /^tide-language-test-/);
    fs.rmSync(directory, { recursive: true, force: true });
  };
  try { const result = run(directory); if (result?.finally) return result.finally(clean); clean(); return result; }
  catch (error) { clean(); throw error; }
}

test('language defaults follow the system; old settings migrate without changing health records', () => fixture(directory => {
  assert.equal(defaultState().settings.language, 'system');
  const old = defaultState();
  delete old.settings.language;
  old.settings.name = 'My user-defined 鯊';
  old.doses = [{ id: 'synthetic-dose', routeId: 'e2-oral', amount: 1, at: '2026-10-01T00:00:00.000Z' }];
  fs.writeFileSync(path.join(directory, 'state.json'), JSON.stringify(old));
  const store = createStateStore(directory), loaded = store.load();
  assert.equal(loaded.migrated, true);
  assert.equal(loaded.state.settings.language, 'system');
  assert.equal(loaded.state.settings.name, old.settings.name);
  assert.deepEqual(loaded.state.doses, old.doses);
  store.save(loaded.state);
  assert.equal(createStateStore(directory).load().migrated, false);
}));

test('all supported preferences round-trip through backup validation and storage; invalid values are rejected', () => fixture(directory => {
  const store = createStateStore(directory);
  for (const language of ['system', 'en', 'zh-CN', 'zh-TW', 'ja', 'ko', 'es']) {
    const state = defaultState(); state.settings.language = language;
    const imported = parseState(JSON.stringify(state));
    store.save(imported);
    assert.equal(createStateStore(directory).load().state.settings.language, language);
  }
  for (const language of ['', null, 'en-US', 'fr', 'SYSTEM', {}, ['en'], 1]) {
    const state = defaultState(); state.settings.language = language;
    assert.throws(() => validateState(state), /界面语言/);
  }
}));

test('native locale uses preferred OS language, falls back across Electron APIs, and retains explicit preferences', () => {
  assert.equal(readSystemLocale({}), 'zh-CN');
  assert.equal(readSystemLocale({ getPreferredSystemLanguages: () => ['ja-JP'], getSystemLocale: () => 'en-US' }), 'ja-JP');
  assert.equal(readSystemLocale({ getPreferredSystemLanguages: () => [], getSystemLocale: () => 'ko-KR' }), 'ko-KR');
  assert.equal(readSystemLocale({ getPreferredSystemLanguages() { throw Error('unavailable'); }, getLocale: () => 'es-MX' }), 'es-MX');
  const app = { getPreferredSystemLanguages: () => ['zh-Hant-HK'] }, i18n = createNativeI18n(app);
  i18n.setLanguage('system');
  assert.deepEqual(i18n.getInfo(), { systemLocale: 'zh-Hant-HK', locale: 'zh-TW', preference: 'system' });
  assert.equal(i18n.t('打开手账'), '開啟手帳');
  i18n.setLanguage('en');
  assert.equal(i18n.t('隐藏{name}', { name: '小明 {user}' }), 'Hide 小明 {user}');
  app.getPreferredSystemLanguages = () => ['es-MX']; i18n.setLanguage('en');
  assert.equal(i18n.getInfo().locale, 'en');
  i18n.setLanguage('system'); assert.equal(i18n.getInfo().locale, 'es');
});

test('every native translation has five nonempty strings with unchanged placeholders', () => {
  const placeholders = text => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
  for (const [source, translations] of Object.entries(catalog)) {
    assert.equal(translations.length, 5, source);
    for (const value of translations) {
      assert.equal(typeof value, 'string', source); assert.ok(value.trim(), source);
      assert.deepEqual(placeholders(value), placeholders(source), `${source}: ${value}`);
    }
  }
  const i18n = createI18n([catalog]);
  for (const language of ['en', 'zh-TW', 'ja', 'ko', 'es']) {
    i18n.setLanguage(language);
    assert.notEqual(i18n.t('你设置的 {count} 项提醒到时间了，可以打开计划查看。', { count: 2 }), '你设置的 2 项提醒到时间了，可以打开计划查看。');
  }
});

function nativeHarness(directory) {
  const handlers = new Map(), broadcasts = [], disk = { fail: false }, titles = [];
  const initial = defaultState(), store = createStateStore(directory); store.save(initial);
  const normalize = value => validateState(plain(value));
  const stateStore = { file: store.file, save(value) { if (disk.fail) throw Error('Synthetic disk full'); return store.save(normalize(value)); } };
  const mainFile = fileURLToPath(new URL('../electron/main.cjs', import.meta.url));
  const context = vm.createContext({
    require(specifier) {
      if (specifier === 'electron') return {
        app: { setName() {}, setPath() {}, getName: () => '潮汐', getPath: () => directory, getPreferredSystemLanguages: () => ['ja-JP'], setAppUserModelId() {}, requestSingleInstanceLock: () => false, quit() {}, isPackaged: false },
        ipcMain: { on() {} }, protocol: { registerSchemesAsPrivileged() {} }, Notification: { isSupported: () => false },
        dialog: { async showOpenDialog() { return { canceled: false, filePaths: [path.join(directory, 'import.json')] }; }, async showMessageBox() { return { response: 1 }; } },
      };
      if (specifier === './state.cjs') return { ...require('../electron/state.cjs'), validateState: normalize };
      if (specifier === './pet-desktop.cjs') return { setupPetDesktop: () => ({}) };
      if (specifier === './pet-growth-desktop.cjs') return { setupPetGrowthDesktop: () => ({}) };
      return require(specifier.startsWith('.') ? path.resolve(path.dirname(mainFile), specifier) : specifier);
    },
    __dirname: path.dirname(mainFile), process: { platform: 'win32', execPath: 'C:\\Synthetic\\Tide.exe', argv: [] }, Buffer, URL, console,
    __initial: initial, __store: stateStore, __handlers: handlers, __broadcasts: broadcasts, __titles: titles,
  });
  vm.runInContext(fs.readFileSync(mainFile, 'utf8'), context, { filename: mainFile });
  vm.runInContext('state=__initial;store=__store;nativeI18n.setLanguage(state.settings.language);handle=(channel,handler)=>__handlers.set(channel,handler);broadcast=(channel,value)=>__broadcasts.push({channel,value});dashboard={isDestroyed:()=>false,setTitle:title=>__titles.push(title)};setupIpc();', context);
  return { call: (channel, ...args) => handlers.get(channel)(...args), state: () => vm.runInContext('state', context), disk, titles, broadcasts };
}

test('native IPC switches language only after a successful save and restores it from imports', () => fixture(async directory => {
  const h = nativeHarness(directory);
  assert.equal(h.call('app:locale').locale, 'ja');
  const next = plain(h.state()); next.settings.language = 'es'; next.settings.name = 'custom 中文 name';
  h.disk.fail = true;
  assert.throws(() => h.call('state:save', next), /Synthetic disk full/);
  assert.equal(h.call('app:locale').locale, 'ja');
  assert.equal(h.state().settings.language, 'system');
  assert.equal(h.broadcasts.length, 0);
  h.disk.fail = false; h.call('state:save', next);
  assert.equal(h.call('app:locale').locale, 'es');
  assert.equal(h.titles.at(-1), 'Tide · Diario');
  assert.equal(h.state().settings.name, 'custom 中文 name');
  h.call('notification:test');
  assert.equal(h.broadcasts.at(-1).value.message, 'Este es un recordatorio de prueba. Puedes cambiar tus preferencias cuando quieras.');
  const imported = plain(h.state()); imported.settings.language = 'ko';
  fs.writeFileSync(path.join(directory, 'import.json'), JSON.stringify(imported));
  await h.call('data:import');
  assert.equal(h.call('app:locale').locale, 'ko');
  assert.equal(h.titles.at(-1), 'Tide · 기록장');
  assert.equal(createStateStore(directory).load().state.settings.language, 'ko');
}));
