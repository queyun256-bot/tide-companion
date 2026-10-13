import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const source = readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');
const installedExe = 'C:\\Users\\Example User\\AppData\\Local\\Programs\\Tide Companion\\Tide-Companion.exe';

// Exercise the real main-process helper without launching Electron or accessing
// Windows registry/user records. The losing-instance branch avoids app startup.
function harness({ packaged = true, platform = 'win32', current = false, readError = false, writeError = false, silentFailure = false } = {}) {
  const writes = [], reads = [], warnings = [];
  const app = {
    isPackaged: packaged, setName() {}, setPath() {}, getName: () => '潮汐',
    getPath: name => name === 'appData' ? 'C:\\Users\\Fixture\\AppData\\Roaming' : 'C:\\Users\\Fixture\\AppData\\Roaming\\潮汐', setAppUserModelId() {},
    requestSingleInstanceLock: () => false, quit() {},
    getLoginItemSettings(options) {
      reads.push(structuredClone(options));
      if (readError) throw new Error('Registry access denied');
      return { openAtLogin: current, executableWillLaunchAtLogin: false };
    },
    setLoginItemSettings(options) {
      writes.push(structuredClone(options));
      if (writeError) throw new Error('Registry write denied');
      if (!silentFailure) current = options.openAtLogin;
    },
  };
  const electron = { app, protocol: { registerSchemesAsPrivileged() {} } };
  const context = vm.createContext({
    require(id) {
      if (id === 'electron') return electron;
      if (id.startsWith('node:')) return require(id);
      if (id === './platform.cjs') return require('../electron/platform.cjs');
      if (id === './i18n.cjs') return require('../electron/i18n.cjs');
      if (id === './tray-icon.cjs') return () => Buffer.alloc(0);
      return {};
    },
    __dirname: 'C:\\fixture\\electron', process: { platform, execPath: installedExe },
    console: { warn: (message) => warnings.push(message) },
  });
  vm.runInContext(`${source}\nglobalThis.testSync = (settings) => { state = { settings }; syncLoginItemAtStartup(); };\nglobalThis.testLoginOptions = loginItemSettings;`, context);
  return { writes, reads, warnings, sync: context.testSync, options: context.testLoginOptions };
}

test('installation migrates opted-in login startup to the installed path with the existing registry identity', () => {
  const h = harness();
  const settings = Object.freeze({ launchAtLogin: true, name: 'My shark' });
  h.sync(settings);
  assert.deepEqual(h.writes, [{ openAtLogin: true, name: 'org.transpet.desktop', path: installedExe, args: ['--hidden'] }]);
  assert.equal(h.reads.length, 2);
  assert.equal(h.warnings.length, 0);
  assert.equal(settings.launchAtLogin, true);
});

test('a disabled app preference leaves existing portable login registration untouched', () => {
  const h = harness();
  h.sync({ launchAtLogin: false });
  assert.deepEqual(h.reads, []);
  assert.deepEqual(h.writes, []);
});

test('development and non-Windows launches never register login items', () => {
  for (const options of [{ packaged: false }, { platform: 'linux' }, { platform: 'darwin' }]) {
    const h = harness(options);
    h.sync({ launchAtLogin: true });
    assert.deepEqual(h.reads, []);
    assert.deepEqual(h.writes, []);
  }
});

test('an already current Run entry is not rewritten even when disabled in Windows settings', () => {
  const h = harness({ current: true });
  h.sync({ launchAtLogin: true });
  assert.equal(h.reads.length, 1);
  assert.deepEqual(h.writes, []);
});

test('registry read and write errors cannot interrupt application startup', () => {
  for (const options of [{ readError: true }, { writeError: true }, { silentFailure: true }]) {
    const h = harness(options);
    assert.doesNotThrow(() => h.sync({ launchAtLogin: true }));
    assert.equal(h.warnings.length, 1);
    assert.match(h.warnings[0], /开机启动路径暂时未能更新/);
  }
});

test('explicit setting changes use the same login identity and hidden launch arguments', () => {
  const h = harness();
  for (const enabled of [true, false]) {
    assert.deepEqual(structuredClone(h.options(enabled)), {
      openAtLogin: enabled, name: 'org.transpet.desktop', path: installedExe, args: ['--hidden'],
    });
  }
});
