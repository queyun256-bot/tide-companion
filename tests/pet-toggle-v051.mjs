import { _electron as electron } from 'playwright-core';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const userData = await mkdtemp(path.join(tmpdir(), 'tide-pet-toggle-'));
const env = { ...process.env, TIDE_TEST_DATA: userData };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'), args: [path.join(root, 'tests/launch-smoke.cjs')], env, timeout: 30000 });
const checks = [], errors = [];
try {
  await app.firstWindow();
  let pet;
  for (let index = 0; index < 100; index += 1) {
    pet = app.windows().find(window => window.url().endsWith('/pet.html'));
    if (pet) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(pet);
  pet.on('pageerror', error => errors.push(error.message));
  await pet.waitForFunction(() => Boolean(window.petAPI?.toggleDashboard));
  const snapshot = () => app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'));
    return { exists: Boolean(window), visible: window?.isVisible() ?? false, minimized: window?.isMinimized() ?? false };
  });
  const clickToggle = async () => {
    await pet.mouse.move(100, 320);
    await pet.locator('#open-dashboard').click();
  };
  const expectToggle = label => pet.waitForFunction(expected => document.getElementById('open-dashboard').getAttribute('aria-label') === expected, label);
  const before = await pet.evaluate(() => window.petAPI.loadState());
  await expectToggle('收起手账');
  await clickToggle();
  await expectToggle('打开手账');
  assert.equal((await snapshot()).visible, false);
  await clickToggle();
  await expectToggle('收起手账');
  assert.deepEqual(await snapshot(), { exists: true, visible: true, minimized: false });
  checks.push('left button hides a visible dashboard and reopens a hidden dashboard');

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html')).minimize());
  await expectToggle('打开手账');
  await clickToggle();
  await expectToggle('收起手账');
  assert.deepEqual(await snapshot(), { exists: true, visible: true, minimized: false });
  await clickToggle();
  assert.equal((await snapshot()).visible, false);
  checks.push('minimized dashboard restores before a later click hides it');

  await pet.mouse.dblclick(170, 225);
  await expectToggle('收起手账');
  assert.equal((await snapshot()).visible, true);
  await pet.mouse.dblclick(170, 225);
  assert.equal((await snapshot()).visible, true);
  checks.push('double clicking the shark only opens the dashboard');

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/pet.html')).webContents.send('pet:action', { action: 'reminder', message: '测试用药提醒。' }));
  await pet.locator('#speech-open').waitFor({ state: 'visible' });
  await clickToggle();
  assert.equal((await snapshot()).visible, false);
  await pet.locator('#speech-open').click();
  await expectToggle('收起手账');
  await pet.locator('#speech-open').click();
  assert.equal((await snapshot()).visible, true);
  checks.push('reminder button only opens, including repeated clicks');

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html')).close());
  await expectToggle('打开手账');
  assert.deepEqual(await snapshot(), { exists: true, visible: false, minimized: false });
  assert.deepEqual(await pet.evaluate(() => window.petAPI.loadState()), before, 'window visibility changes never create health or interaction records');
  checks.push('closing keeps the process alive and all window operations leave records unchanged');

  // Native window destruction is only a fixture for the missing-window branch.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html')).destroy());
  await clickToggle();
  await expectToggle('收起手账');
  for (let index = 0; index < 50 && !(await snapshot()).exists; index += 1) await pet.waitForTimeout(100);
  assert.equal((await snapshot()).exists, true);
  checks.push('toggle recreates a missing dashboard');

  await pet.evaluate(() => window.petAPI.petAction('pet'));
  await pet.waitForFunction(() => Boolean(document.querySelector('#builtin-pet').getAnimations().find(animation => animation.animationName === 'soft-pat')));
  const beforeTime = await pet.evaluate(() => {
    window.testPatAnimation = document.querySelector('#builtin-pet').getAnimations().find(animation => animation.animationName === 'soft-pat');
    return window.testPatAnimation.currentTime;
  });
  await pet.waitForTimeout(180);
  await pet.evaluate(() => window.petAPI.petAction('pet'));
  const continued = await pet.evaluate(() => {
    const active = document.querySelector('#builtin-pet').getAnimations().find(animation => animation.animationName === 'soft-pat');
    return { same: active === window.testPatAnimation, time: active?.currentTime, relaxed: document.querySelector('.pet-stage').classList.contains('is-enjoying-touch') };
  });
  assert.ok(continued.same && continued.time > beforeTime && continued.relaxed);
  await pet.evaluate(() => window.petAPI.petAction('nuzzle'));
  assert.ok(await pet.locator('.pet-stage').evaluate(element => element.classList.contains('action-pat')));
  await pet.waitForFunction(() => document.querySelector('.pet-stage').classList.contains('action-nuzzle'));
  checks.push('repeat touch retains animation progress and relaxed eyes; next distinct gesture follows smoothly');

  await pet.evaluate(async () => { const state = await window.petAPI.loadState(); state.settings.reducedMotion = true; await window.petAPI.saveState(state); });
  await pet.waitForFunction(() => document.documentElement.classList.contains('reduced-motion'));
  assert.equal(await pet.locator('#builtin-pet').evaluate(element => getComputedStyle(element).animationName), 'none');
  checks.push('reduced motion keeps the new touch response still');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, checks, isolatedData: userData }));
} finally { await app.close(); }
