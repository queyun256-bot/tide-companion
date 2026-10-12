// Exercises the macOS UI capability contract with real Electron renderers on
// any host. This does not substitute for native macOS window/notification QA.
import { _electron as electron } from 'playwright-core';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const userData = await mkdtemp(path.join(tmpdir(), 'tide-platform-ui-'));
const env = { ...process.env, TIDE_TEST_DATA: userData }; delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'), args: [path.join(root, 'tests/launch-smoke.cjs')], env });
try {
  await app.firstWindow();
  let dashboard;
  for (let n = 0; n < 100; n++) {
    dashboard = app.windows().find(page => page.url().endsWith('/index.html'));
    if (dashboard) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(dashboard);
  await app.evaluate(({ BrowserWindow, ipcMain }) => {
    for (const window of BrowserWindow.getAllWindows()) { window.hide(); window.webContents.setBackgroundThrottling(false); }
    ipcMain.removeHandler('app:platform');
    ipcMain.handle('app:platform', () => ({ id: 'darwin', label: 'macOS', fullscreenDetection: false, automaticLoginSettings: false }));
  });
  await dashboard.reload();
  await dashboard.locator('[data-page="settings"]').click();
  await dashboard.locator('[data-setting="notifications"]').waitFor();
  assert.match(await dashboard.locator('.side-bottom').innerText(), /v0\.9\.1 · macOS/);
  assert.equal(await dashboard.locator('[data-setting="autoHideFullscreen"]').count(), 0);
  assert.equal(await dashboard.locator('[data-setting="launchAtLogin"]').count(), 0);
  assert.match(await dashboard.locator('.settings-grid').innerText(), /macOS 版暂不自动检测/);
  assert.match(await dashboard.locator('.settings-grid').innerText(), /通用 → 登录项/);
  assert.doesNotMatch(await dashboard.locator('.settings-grid').innerText(), /Windows/);
  assert.equal(await dashboard.locator('tide-pet-preview.settings-pet-preview').count(), 1);
  const state = await dashboard.evaluate(() => window.petAPI.loadState());
  assert.equal(state.settings.autoHideFullscreen, true, 'unsupported capability does not rewrite stored preference');
  assert.deepEqual(state.doses, []); assert.deepEqual(state.labs, []);
  console.log(JSON.stringify({ ok: true, checks: ['macOS label and notification help', 'unsupported controls replaced by actionable platform help', 'pet preview and journal render', 'stored preferences and records unchanged'], userData, scope: 'macOS capability response simulated on host Electron; no native Mac claim' }));
} finally { await app.close(); }
