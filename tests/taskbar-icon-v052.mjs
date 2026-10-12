// Exercise real Win32 window properties with isolated records; never pin a
// shortcut, clear Explorer's icon cache, or write to the user's app directory.
import { _electron as electron } from 'playwright-core';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
const root = process.cwd();
const userData = await mkdtemp(path.join(tmpdir(), 'tide-taskbar-v052-'));
const env = { ...process.env, TIDE_TEST_DATA: userData }; delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({
  executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'),
  args: [path.join(root, 'tests/launch-smoke.cjs'), '--hidden'], env,
});
const checks = [];
try {
  await app.firstWindow();
  let dashboardPage;
  for (let attempt = 0; attempt < 100; attempt++) {
    dashboardPage = app.windows().find(w => w.url().endsWith('/index.html'));
    if (dashboardPage) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(dashboardPage);
  await dashboardPage.locator('h1').waitFor();
  const details = await app.evaluate(({ app, BrowserWindow }) => {
    const dashboard = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html'));
    return { name: app.getName(), userData: app.getPath('userData'), handle: dashboard.getNativeWindowHandle().readBigUInt64LE().toString(), title: dashboard.getTitle() };
  });
  assert.equal(details.name, '潮汐'); assert.equal(details.title, '潮汐 · 手账'); assert.equal(details.userData, userData);
  checks.push('visible app name and native hand journal title; test userData remains isolated');
  const packagedRoot = process.env.TIDE_TEST_PACKAGED_ROOT;
  const iconPath = packagedRoot
    ? path.join(packagedRoot, 'resources', `tide-app-${createHash('sha256').update(await readFile(path.join(root, 'assets/app.ico'))).digest('hex').slice(0, 12)}.ico`)
    : path.join(root, 'assets/app.ico');
  // Loading an asar through the isolated harness is still a development process;
  // the native path test below additionally proves the packaged external ICO.
  const params = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'tests/native-icon-check.ps1'), '-WindowHandle', details.handle,
    '-IconResourcePath', path.join(root, 'assets/app.ico'), '-OutputDirectory', path.join(userData, 'icons')];
  const native = await promisify(execFile)('powershell.exe', params, { windowsHide: true });
  const nativeResult = JSON.parse(native.stdout);
  assert.equal(nativeResult.identity.relaunchCommand, `"${path.join(root, 'node_modules/electron/dist/electron.exe')}" "${root}"`);
  checks.push(...nativeResult.checks);
  if (packagedRoot) {
    const payload = await promisify(execFile)('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'tests/native-icon-check.ps1'),
      '-ExecutablePath', path.join(packagedRoot, 'Tide-Companion.exe'), '-IconResourcePath', iconPath, '-OutputDirectory', path.join(userData, 'payload-icons')], { windowsHide: true });
    checks.push(...JSON.parse(payload.stdout).checks);
  }
  console.log(JSON.stringify({ ok: true, checks, isolatedData: userData }));
} finally { await app.close(); }
