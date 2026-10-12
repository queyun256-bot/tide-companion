// Real Windows foreground-process integration. Uses isolated app and fixture data.
// This briefly displays a full-screen test surface; both Electron processes close
// in finally. No actual user health records, reminders or preferences are opened.
import { _electron as electron } from 'playwright-core';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') {
  console.log(JSON.stringify({ skipped: true, reason: 'Windows foreground detection integration requires Windows.' }));
  process.exit(0);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(path.join(tmpdir(), 'tide-fullscreen-smoke-'));
const userData = path.join(temporary, 'tide-data');
const helperData = path.join(temporary, 'foreground-data');
const fixtureEntry = path.join(temporary, 'foreground-fixture.cjs');
const executablePath = path.join(root, 'node_modules/electron/dist/electron.exe');
const env = { ...process.env, TIDE_TEST_DATA: userData, TIDE_FOREGROUND_TEST_DATA: helperData };
delete env.ELECTRON_RUN_AS_NODE;
await writeFile(fixtureEntry, `
const {app,BrowserWindow,screen} = require('electron');
app.setName('Tide fullscreen integration fixture');
app.setPath('userData',process.env.TIDE_FOREGROUND_TEST_DATA);
let fixture;
app.whenReady().then(()=>{
  const area=screen.getPrimaryDisplay().workArea;
  fixture=new BrowserWindow({x:area.x+40,y:area.y+40,width:640,height:420,
    frame:false,show:false,backgroundColor:'#203347',autoHideMenuBar:true,
    webPreferences:{contextIsolation:true,sandbox:true,nodeIntegration:false}});
  fixture.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<!doctype html><title>Tide fullscreen integration fixture</title><style>body{background:#203347;color:white;font:24px system-ui;padding:60px}p{font-size:16px;color:#b7ccde}</style><h1>Fullscreen integration test</h1><p>Temporary isolated fixture. This window closes automatically.</p>'));
  fixture.once('ready-to-show',()=>{fixture.show();fixture.focus();});
});
app.on('window-all-closed',()=>app.quit());
`, 'utf8');

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let app, fixture, dashboard;
const checks = [], details = [];

async function petVisibility() {
  return app.evaluate(({ BrowserWindow }) => {
    const pet = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/pet.html'));
    return pet ? pet.isVisible() : null;
  });
}

async function waitForVisibility(expected, label, stableMilliseconds = 1800) {
  const deadline = Date.now() + 15_000;
  let stableSince = null, actual = null;
  while (Date.now() < deadline) {
    actual = await petVisibility();
    if (actual === expected) {
      stableSince ??= Date.now();
      if (Date.now() - stableSince >= stableMilliseconds) {
        checks.push(label);
        console.log(`PASS ${label}`);
        return;
      }
    } else stableSince = null;
    await pause(200);
  }
  const foreground = await fixture.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    return { focused: w.isFocused(), fullScreen: w.isFullScreen(), bounds: w.getBounds() };
  });
  assert.fail(`${label}: expected pet visibility ${expected}, got ${actual}; fixture=${JSON.stringify(foreground)}`);
}

async function setFullscreen(enabled) {
  await fixture.evaluate(({ BrowserWindow, screen }, enabled) => {
    const w = BrowserWindow.getAllWindows()[0], area = screen.getPrimaryDisplay().workArea;
    w.setFullScreen(enabled);
    if (!enabled) w.setBounds({ x: area.x + 40, y: area.y + 40, width: 640, height: 420 });
    w.show();
    w.focus();
  }, enabled);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const geometry = await fixture.evaluate(({ BrowserWindow, screen }) => {
      const w = BrowserWindow.getAllWindows()[0];
      return { fullScreen: w.isFullScreen(), focused: w.isFocused(), bounds: w.getBounds(), display: screen.getDisplayMatching(w.getBounds()).bounds };
    });
    const fillsDisplay = ['x', 'y', 'width', 'height'].every(key => Math.abs(geometry.bounds[key] - geometry.display[key]) <= 2);
    if (geometry.fullScreen === enabled && geometry.focused && (!enabled || fillsDisplay)) {
      details.push({ enabled, ...geometry });
      return;
    }
    await pause(100);
  }
  assert.fail(`Could not make the independent fixture foreground/fullscreen=${enabled}`);
}

async function setSettings(changes) {
  return dashboard.evaluate(async changes => {
    const state = await window.petAPI.loadState();
    return window.petAPI.saveState({ ...state, settings: { ...state.settings, ...changes } });
  }, changes);
}

try {
  app = await electron.launch({ executablePath, args: [path.join(root, 'tests/launch-smoke.cjs'), '--hidden'], env, timeout: 30_000 });
  await app.firstWindow();
  for (let i = 0; i < 100; i++) {
    dashboard = app.windows().find(w => w.url().endsWith('/index.html'));
    if (dashboard && await petVisibility() !== null) break;
    await pause(100);
  }
  assert.ok(dashboard, 'isolated dashboard renderer is available');
  const initial = await dashboard.evaluate(() => window.petAPI.loadState());
  assert.equal(initial.doses.length, 0);
  assert.equal(initial.labs.length, 0);
  assert.equal(initial.plans.length, 0);
  assert.equal(initial.settings.autoHideFullscreen, true);
  assert.equal(initial.settings.petVisible, true);

  fixture = await electron.launch({ executablePath, args: [fixtureEntry], env, timeout: 30_000 });
  await fixture.firstWindow();
  assert.notEqual(app.process().pid, fixture.process().pid, 'foreground fixture must be another OS process');
  await setFullscreen(false);
  await waitForVisibility(true, 'windowed foreground leaves the pet visible');

  await setFullscreen(true);
  await waitForVisibility(false, 'independent fullscreen foreground automatically hides the pet');
  let state = await dashboard.evaluate(() => window.petAPI.loadState());
  assert.equal(state.settings.petVisible, true, 'automatic suppression must not overwrite manual preference');
  await setFullscreen(false);
  await waitForVisibility(true, 'leaving fullscreen restores an automatically hidden pet');

  await setFullscreen(true);
  await waitForVisibility(false, 'second fullscreen entry suppresses again');
  await dashboard.evaluate(() => window.petAPI.hidePet());
  state = await dashboard.evaluate(() => window.petAPI.loadState());
  assert.equal(state.settings.petVisible, false);
  await setFullscreen(false);
  await waitForVisibility(false, 'manual hide during fullscreen remains hidden after fullscreen ends', 2600);

  await dashboard.evaluate(() => window.petAPI.showPet());
  await waitForVisibility(true, 'explicit show restores the manually hidden pet');
  await setSettings({ autoHideFullscreen: false });
  await setFullscreen(true);
  await waitForVisibility(true, 'disabled autoHideFullscreen keeps pet visible over fullscreen', 2600);
  await setSettings({ autoHideFullscreen: true });
  await waitForVisibility(false, 're-enabling option while fullscreen applies suppression');
  await setFullscreen(false);
  await waitForVisibility(true, 'final fullscreen exit restores visibility');

  const saved = JSON.parse(await readFile(path.join(userData, 'state.json'), 'utf8'));
  assert.equal(saved.settings.petVisible, true);
  assert.equal(saved.settings.autoHideFullscreen, true);
  assert.deepEqual(saved.doses, []);
  assert.deepEqual(saved.labs, []);
  assert.deepEqual(saved.plans, []);
  console.log(JSON.stringify({ ok: true, checks, isolatedData: userData, appPid: app.process().pid, fixturePid: fixture.process().pid, geometryChecks: details }));
} finally {
  await fixture?.close().catch(() => {});
  await app?.close().catch(() => {});
}
