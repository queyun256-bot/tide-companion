import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const source = readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');
const appData = '/Users/Fixture/Library/Application Support';

// Run the actual shell functions with macOS paths and only macOS API methods.
// This checks the platform branches without launching a window, registering a
// login item or reading any real user data. It is not a native macOS test.
function harness({ packaged = true, login = {}, loginReadError = false, argv = [], customUserData } = {}) {
  let name = 'tide-companion';
  let userData = customUserData ?? path.posix.join(appData, name);
  let menu, about;
  const windows = [], loginReads = [];
  const app = {
    isPackaged: packaged,
    getName: () => name,
    setName: value => { name = value; },
    getVersion: () => '0.9.1',
    getPath: key => key === 'appData' ? appData : userData,
    setPath(key, value) { assert.equal(key, 'userData'); userData = value; },
    requestSingleInstanceLock: () => false,
    quit() {},
    getLoginItemSettings(options) {
      loginReads.push(options);
      if (loginReadError) throw new Error('Login settings unavailable');
      return { ...login };
    },
    setAboutPanelOptions(options) { about = options; },
    // Deliberately no setAppUserModelId, setLoginItemSettings or Windows shell.
  };
  class Window extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.shows = 0;
      this.inactiveShows = 0;
      this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = () => {};
      this.webContents.send = () => {};
      windows.push(this);
    }
    loadFile(file) { this.file = file; return Promise.resolve(); }
    show() { this.shows++; }
    showInactive() { this.inactiveShows++; }
    setIgnoreMouseEvents(ignore, options) { this.passthrough = { ignore, options }; }
    isDestroyed() { return false; }
  }
  const electron = {
    app, BrowserWindow: Window,
    protocol: { registerSchemesAsPrivileged() {} },
    screen: { getPrimaryDisplay: () => ({ workArea: { x: -1440, y: 25, width: 1440, height: 875 } }) },
    nativeImage: { createFromBuffer: () => ({ resize: options => ({ ...options }) }) },
    Menu: { buildFromTemplate: value => value, setApplicationMenu: value => { menu = value; } },
  };
  const context = vm.createContext({
    require(id) {
      if (id === 'electron') return electron;
      if (id === 'node:path') return path.posix;
      if (id === 'node:fs') return { readFileSync: () => Buffer.alloc(1) };
      if (id.startsWith('node:')) return require(id);
      if (['./platform.cjs', './pet-window.cjs'].includes(id)) return require(`../electron/${id.slice(2)}`);
      if (id === './tray-icon.cjs') return () => Buffer.alloc(1);
      return {};
    },
    __dirname: '/fixture/潮汐.app/Contents/Resources/app/electron',
    process: { platform: 'darwin', execPath: '/Applications/潮汐.app/Contents/MacOS/潮汐', argv },
    console,
  });
  vm.runInContext(`${source}\nglobalThis.shellTest = {
    configureApplicationMenu, loginItemSettings, shouldStartHidden,
    syncLoginItemAtStartup, registerNotificationShortcut, createDashboard, createPet,
    settings(value) { state = { settings: value }; },
    requestOpen(value) { dashboardOpenRequested = value; },
  };`, context);
  return {
    api: context.shellTest, windows, loginReads,
    get name() { return name; }, get userData() { return userData; },
    get menu() { return menu; }, get about() { return about; },
  };
}

test('macOS shell starts without Windows-only methods and uses its own product data directory', () => {
  const h = harness();
  assert.equal(h.name, '潮汐');
  assert.equal(h.userData, `${appData}/潮汐`);
  assert.doesNotThrow(() => h.api.registerNotificationShortcut());
  h.api.settings({ launchAtLogin: true });
  assert.doesNotThrow(() => h.api.syncLoginItemAtStartup());
  assert.deepEqual(h.loginReads, []);
});

test('macOS keeps explicitly isolated user-data paths unchanged', () => {
  const h = harness({ customUserData: '/tmp/tide-mac-fixture/records' });
  assert.equal(h.userData, '/tmp/tide-mac-fixture/records');
});

test('macOS menu includes application and editing roles with a Command shortcut for the journal', () => {
  const h = harness();
  h.api.configureApplicationMenu();
  assert.equal(h.about.applicationName, '潮汐');
  const roles = h.menu.flatMap(item => [item.role, ...(item.submenu ?? []).map(child => child.role)]).filter(Boolean);
  for (const role of ['about', 'hide', 'hideOthers', 'unhide', 'quit', 'close', 'editMenu', 'windowMenu']) {
    assert.ok(roles.includes(role), `missing macOS menu role: ${role}`);
  }
  const openItem = h.menu.flatMap(item => item.submenu ?? []).find(item => item.accelerator === 'Cmd+1');
  assert.equal(typeof openItem?.click, 'function');
  assert.doesNotThrow(() => openItem.click());
});

test('macOS login-launch detection uses the OS boolean and never Windows login options', () => {
  const h = harness({ login: { wasOpenedAtLogin: true } });
  assert.equal(h.api.shouldStartHidden(), true);
  assert.deepEqual(h.loginReads, [undefined]);
  assert.deepEqual(structuredClone(h.api.loginItemSettings(true)), { openAtLogin: true });
  assert.deepEqual(structuredClone(h.api.loginItemSettings(false)), { openAtLogin: false });
  assert.equal(harness({ login: { wasOpenedAtLogin: false } }).api.shouldStartHidden(), false);
  assert.equal(harness({ loginReadError: true }).api.shouldStartHidden(), false);
  const development = harness({ packaged: false, login: { wasOpenedAtLogin: true } });
  assert.equal(development.api.shouldStartHidden(), false);
  assert.deepEqual(development.loginReads, []);
  assert.equal(harness({ argv: ['--hidden'] }).api.shouldStartHidden(), true);
});

test('a macOS login launch shows first-run onboarding but keeps an already configured journal hidden', () => {
  for (const completed of [false, true]) {
    const h = harness({ login: { wasOpenedAtLogin: true } });
    h.api.settings({ onboardingCompleted: completed });
    h.api.createDashboard();
    h.windows[0].emit('ready-to-show');
    assert.equal(h.windows[0].shows, completed ? 0 : 1);
  }
  const manual = harness();
  manual.api.settings({ onboardingCompleted: true });
  manual.api.createDashboard();
  manual.windows[0].emit('ready-to-show');
  assert.equal(manual.windows[0].shows, 1);
});

test('an explicit open request during macOS startup overrides hidden login startup', () => {
  const h = harness({ login: { wasOpenedAtLogin: true } });
  h.api.settings({ onboardingCompleted: true });
  h.api.requestOpen(true);
  h.api.createDashboard();
  h.windows[0].emit('ready-to-show');
  assert.equal(h.windows[0].shows, 1);
  h.api.createDashboard();
  h.windows[1].emit('ready-to-show');
  assert.equal(h.windows[1].shows, 0, 'the one-time request should be consumed');
});

test('the macOS pet keeps fixed DIP bounds on a negative-origin display and starts with native passthrough', () => {
  const h = harness();
  h.api.settings({ name: '鲨鲨', alwaysOnTop: true, petVisible: true });
  h.api.createPet();
  const window = h.windows[0];
  assert.equal(window.options.width, 320);
  assert.equal(window.options.height, 370);
  assert.equal(window.options.x, -340);
  assert.equal(window.options.y, 510);
  assert.equal(window.options.transparent, true);
  assert.equal(window.options.frame, false);
  assert.equal(window.options.fullscreenable, false);
  assert.equal(window.options.acceptFirstMouse, true);
  assert.deepEqual(structuredClone(window.passthrough), { ignore: true, options: { forward: true } });
  window.emit('ready-to-show');
  assert.equal(window.inactiveShows, 1);
});
