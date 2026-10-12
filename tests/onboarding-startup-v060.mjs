// Fresh/legacy startup visibility and recovery of setup after reinstalling.
// All profiles are synthetic temporary directories, never the real user profile.
import { _electron as electron } from 'playwright-core';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { defaultState } = createRequire(import.meta.url)('../electron/state.cjs');
const checks = [], directories = [], errors = [];
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
let app, win;

async function fixture(label, state) {
  const directory = await mkdtemp(path.join(tmpdir(), `tide-startup-${label}-`));
  directories.push(directory);
  if (state) await writeFile(path.join(directory, 'state.json'), JSON.stringify(state));
  return directory;
}

async function launch(directory, args = [], entry = path.join(root, 'tests/launch-smoke.cjs')) {
  const env = { ...process.env, TIDE_TEST_DATA: directory, TIDE_TEST_ONBOARDING: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({
    executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'),
    args: [entry, ...args], env, timeout: 30000,
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    win = app.windows().find(window => window.url().endsWith('/index.html'));
    if (win) break;
    await pause(100);
  }
  assert.ok(win);
  win.setDefaultTimeout(8000);
  win.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) window.webContents.setBackgroundThrottling(false);
  });
  await win.locator('h1').waitFor();
}

async function close() {
  if (app) await app.close();
  app = null; win = null;
}
const readState = directory => readFile(path.join(directory, 'state.json'), 'utf8').then(JSON.parse);
const visibility = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html')).isVisible());
const click = selector => win.locator(selector).evaluate(element => element.click());

async function anotherInstance(directory) {
  const env = { ...process.env, TIDE_TEST_DATA: directory, TIDE_TEST_ONBOARDING: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  await new Promise((resolve, reject) => {
    const child = spawn(path.join(root, 'node_modules/electron/dist/electron.exe'), [path.join(root, 'tests/launch-smoke.cjs')], { env, windowsHide: true, stdio: 'ignore' });
    const timeout = setTimeout(() => { child.kill(); reject(new Error('The isolated second instance did not exit')); }, 10000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error(`The isolated second instance exited with ${code}`)); });
  });
}

try {
  const fresh = await fixture('fresh');
  await launch(fresh, ['--hidden']);
  await win.locator('.onboarding-modal[open]').waitFor();
  assert.equal(await visibility(), true, 'Incomplete setup must remain visible even when launched with --hidden');
  assert.equal((await readState(fresh)).settings.onboardingCompleted, false);
  checks.push('fresh profile shows visible setup even with the login startup --hidden argument');
  await close();

  const legacyState = defaultState();
  delete legacyState.settings.onboardingCompleted;
  legacyState.settings.mode = 'ftm';
  legacyState.settings.petVisible = false;
  legacyState.pkSettings.bodyWeightKg = 58.5;
  const legacy = await fixture('legacy', legacyState);
  await launch(legacy, ['--hidden']);
  await win.locator('.onboarding-modal[open]').waitFor();
  assert.equal(await visibility(), true, 'Legacy data without setup completion must not leave every window hidden');
  assert.equal(await win.locator('[name="mode"][value="ftm"]').isChecked(), true);
  assert.equal(await win.locator('[name="bodyWeightKg"]').inputValue(), '58.5');
  checks.push('legacy uncompleted setup remains visible with the pet hidden and existing FTM/weight prefilled');
  await close();

  const completedState = defaultState();
  completedState.settings.onboardingCompleted = true;
  completedState.settings.mode = 'ftm';
  completedState.settings.petVisible = false;
  completedState.pkSettings.bodyWeightKg = 62.5;
  completedState.doses = [{ id: 'fixture-dose', routeId: 't-enanthate-im', amount: 25, at: '2026-10-01T00:00:00.000Z' }];
  const early = await fixture('early-instance', completedState);
  // Deterministically deliver the real Electron event before ready and while
  // production startup is paused at its first asynchronous module import.
  const earlyEntry = path.join(early, 'early-instance.cjs');
  await writeFile(earlyEntry, `const { app } = require('electron');
app.setPath('userData', process.env.TIDE_TEST_DATA);
require(${JSON.stringify(path.join(process.env.TIDE_TEST_APP_ROOT || root, 'electron/main.cjs'))});
app.emit('second-instance', {}, [], process.cwd());
app.whenReady().then(() => app.emit('second-instance', {}, [], process.cwd()));
`);
  await launch(early, ['--hidden'], earlyEntry);
  assert.equal(await visibility(), true, 'An explicit second launch must reveal the completed hidden profile after startup is ready');
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter(window => window.webContents.getURL().endsWith('/index.html')).length), 1);
  assert.equal(await win.evaluate(async () => (await window.petAPI.loadState()).settings.mode), 'ftm');
  checks.push('early repeated launches queue until IPC is ready, create exactly one journal, and override hidden startup');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html')).hide());
  assert.equal(await visibility(), false);
  await anotherInstance(early);
  assert.equal(await visibility(), true);
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter(window => window.webContents.getURL().endsWith('/index.html')).length), 1);
  checks.push('a real isolated secondary process exits and restores the existing journal without duplicate windows');
  await close();

  const completed = await fixture('completed', completedState);
  await launch(completed, ['--hidden']);
  assert.equal(await visibility(), false, 'Completed profiles keep quiet login startup');
  assert.equal(await win.locator('#modal').evaluate(element => element.open), false);
  assert.equal(await win.locator('.setup-reminder').count(), 0);
  checks.push('already completed profiles preserve quiet startup and do not reopen initial setup');
  await close();

  // Installer re-launches updates with --updated; it must retain completion and
  // all existing data rather than resetting records just to show a welcome.
  await launch(completed, ['--updated']);
  assert.equal(await visibility(), true);
  assert.equal(await win.locator('#modal').evaluate(element => element.open), false);
  await click('[data-page="settings"]');
  await click('.page-view [data-action="onboarding"]');
  await win.locator('.onboarding-modal[open]').waitFor();
  assert.equal(await win.locator('[name="mode"][value="ftm"]').isChecked(), true);
  assert.equal(await win.locator('[name="bodyWeightKg"]').inputValue(), '62.5');
  await click('[data-action="close-modal"]');
  await win.locator('#modal').waitFor({ state: 'hidden' });
  let saved = await readState(completed);
  assert.equal(saved.settings.onboardingCompleted, true);
  assert.equal(saved.settings.mode, 'ftm');
  assert.equal(saved.pkSettings.bodyWeightKg, 62.5);
  assert.deepEqual(saved.doses, completedState.doses);
  checks.push('installer-style re-launch retains completed setup; settings can reopen and cancel without modifying records');

  await click('.page-view [data-action="onboarding"]');
  await win.locator('.onboarding-modal[open]').waitFor();
  await win.locator('[name="bodyWeightKg"]').fill('63');
  await click('#dialog-form button[type="submit"]');
  await win.locator('#modal').waitFor({ state: 'hidden' });
  saved = await readState(completed);
  assert.equal(saved.settings.onboardingCompleted, true);
  assert.equal(saved.settings.mode, 'ftm');
  assert.equal(saved.pkSettings.bodyWeightKg, 63);
  assert.deepEqual(saved.doses, completedState.doses);
  checks.push('reopened setup updates model weight while keeping saved mode and HRT history');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, checks, installerPayload: Boolean(process.env.TIDE_TEST_APP_ROOT), isolatedData: directories }));
} finally {
  await close();
}
