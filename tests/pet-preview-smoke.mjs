// Desktop and journal share one behavior source; this test uses isolated app data.
import { _electron as electron } from 'playwright-core';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { localDateKey } from '../src/journal.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const userData = await mkdtemp(path.join(tmpdir(), 'tide-pet-preview-'));
const fixture = createRequire(import.meta.url)('../electron/state.cjs').defaultState();
const earnedAt = new Date(Date.now() - 30000).toISOString(), scheduledAt = new Date(Date.now() - 60000).toISOString();
fixture.starWallet = { version: 1, entries: [{ id: `preview-earned@${scheduledAt}`, planId: 'preview-earned', doseId: 'preview-earned-dose', scheduledAt, earnedAt, doseAt: scheduledAt, day: localDateKey(earnedAt), kind: 'long', amount: 7, intervalHours: 168, routeId: 'e2-oral', doseAmount: 2 }] };
await writeFile(path.join(userData, 'state.json'), JSON.stringify(fixture));
const env = { ...process.env, TIDE_TEST_DATA: userData }; delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'), args: [path.join(root, 'tests/launch-smoke.cjs')], env, timeout: 30000 });
const checks = [], errors = [], pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let page, pet;
try {
  for (let n = 0; n < 100; n++) {
    page = app.windows().find(window => window.url().endsWith('/index.html'));
    pet = app.windows().find(window => window.url().endsWith('/pet.html'));
    if (page && pet) break;
    await pause(100);
  }
  assert.ok(page && pet); page.setDefaultTimeout(10000); pet.setDefaultTimeout(10000);
  await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) { window.webContents.setBackgroundThrottling(false); window.hide(); } });
  for (const window of [page, pet]) window.on('pageerror', error => errors.push(error.message));
  await page.locator('h1').waitFor();
  await page.evaluate(async () => { const state = await window.petAPI.loadState(); state.settings.autoHideFullscreen = false; await window.petAPI.saveState(state); });
  const preview = () => page.locator('tide-pet-preview').first();
  const ready = () => page.waitForFunction(() => document.querySelector('tide-pet-preview')?.dataset.previewState === 'ready');
  const nav = key => page.evaluate(value => document.querySelector(`[data-page="${value}"]`).click(), key);
  await ready();
  assert.equal(await preview().locator('.pet-controls,.speech,.drag-handle,canvas,script').count(), 0);
  assert.equal(await preview().locator('#builtin-pet svg').count(), 1);
  await preview().evaluate(element => { element.dataset.identityProbe = 'same-host'; });
  const beforeAt = Number(await preview().getAttribute('data-visual-at'));
  await page.waitForFunction(previous => Number(document.querySelector('tide-pet-preview')?.dataset.visualAt) > previous, beforeAt);
  assert.equal(await preview().getAttribute('data-identity-probe'), 'same-host');
  checks.push('one shared rig without controls or second engine; snapshots update in place');

  await page.evaluate(() => window.petAPI.selectSkin('builtin-rose', 1));
  await page.waitForFunction(() => document.querySelector('tide-pet-preview')?.dataset.visualVariant === 'builtin-rose');
  const sourceColor = await pet.locator('#shark-body-gradient stop').first().getAttribute('stop-color');
  assert.equal(await preview().locator('#shark-body-gradient stop').first().getAttribute('stop-color'), sourceColor);
  assert.equal(sourceColor, '#F7D4E1');
  await page.evaluate(() => window.petAPI.petAction('pet'));
  await page.waitForFunction(() => document.querySelector('tide-pet-preview')?.shadowRoot.querySelector('.pet-stage')?.classList.contains('is-enjoying-touch'));
  assert.equal(await pet.locator('.pet-stage').evaluate(stage => stage.classList.contains('is-enjoying-touch')), true);
  checks.push('selected palette and actual touch expression match the desktop');

  await page.evaluate(() => window.petAPI.petAction('mood-low'));
  await page.waitForFunction(() => document.querySelector('tide-pet-preview')?.shadowRoot.querySelector('.pet-stage')?.dataset.mood === 'low');
  assert.equal(await pet.locator('.pet-stage').getAttribute('data-mood'), 'low');
  await page.waitForFunction(() => document.querySelector('tide-pet-preview')?.shadowRoot.querySelector('.star-lights')?.classList.contains('is-visible'));
  assert.equal(await preview().locator('.star-lights').getAttribute('data-count'), '7');
  assert.equal(await preview().locator('.star-lights').getAttribute('data-count'), await pet.locator('.star-lights').getAttribute('data-count'));
  assert.equal(await preview().locator('.star-point').count(), await pet.locator('.star-point').count());
  checks.push('the actual daily mood and persistent earned-star field reach the journal');

  await page.evaluate(() => window.petAPI.petAction('sleep'));
  await page.waitForFunction(() => document.querySelector('tide-pet-preview')?.dataset.visualBehavior === 'sleeping');
  const paused = await page.evaluate(async () => {
    const snapshot = await window.petAPI.getPetVisual();
    const host = document.querySelector('tide-pet-preview');
    const stage = host.shadowRoot.querySelector('.pet-stage');
    const animation = stage.querySelector('.fin-left').getAnimations().find(item => item.animationName === 'fin-left');
    const frame = snapshot.animations.find(item => item.target === 'fin-left' && item.name === 'fin-left');
    return { playState: animation?.playState, time: animation?.currentTime, source: frame?.time, sourceRate: frame?.rate, classes: [...stage.classList] };
  });
  assert.equal(paused.playState, 'paused'); assert.equal(paused.sourceRate, 0);
  assert.ok(Math.abs(paused.time - paused.source) < 20, JSON.stringify(paused));
  assert.ok(paused.classes.includes('is-sleeping'));
  const snooze = await page.evaluate(async () => {
    const snapshot = await window.petAPI.getPetVisual();
    const animation = document.querySelector('tide-pet-preview').shadowRoot.querySelector('.sleep-sign').getAnimations().find(item => item.animationName === 'snooze');
    const source = snapshot.animations.find(item => item.target === 'sleep' && item.name === 'snooze');
    return { state: animation?.playState, time: animation?.currentTime, target: source ? source.time + Math.max(0, Date.now() - snapshot.at) * source.rate : null };
  });
  assert.equal(snooze.state, 'running');
  assert.ok(Number.isFinite(snooze.time) && Math.abs(snooze.time - snooze.target) < 150, JSON.stringify(snooze));
  await page.evaluate(() => { window.__removedPreview = document.querySelector('tide-pet-preview'); window.__removedAt = window.__removedPreview.dataset.visualAt; });
  await nav('curves'); await pause(650);
  assert.equal(await page.evaluate(() => window.__removedPreview.dataset.visualAt === window.__removedAt), true);
  await nav('overview'); await ready();
  assert.equal(await preview().getAttribute('data-visual-behavior'), 'sleeping');
  checks.push('sleep state, paused fin phase and moving Z phase match; navigation restores state and detached preview unsubscribes');

  await page.evaluate(() => window.petAPI.petAction('wake'));
  await page.waitForFunction(() => document.querySelector('tide-pet-preview')?.dataset.visualBehavior === 'awake');
  // Exercise the publisher/IPC/mirror with a desktop drag-pose fixture. Native
  // pointer holding/movement is covered by the separate pet-desktop smoke suite;
  // this phase assertion must not depend on the user's physical cursor location.
  await pet.evaluate(() => document.querySelector('.pet-stage').classList.add('is-dragging'));
  try {
    await page.waitForFunction(() => document.querySelector('tide-pet-preview')?.shadowRoot.querySelector('.pet-stage')?.classList.contains('is-dragging'));
    const mirrored = await page.evaluate(async () => {
      const snapshot = await window.petAPI.getPetVisual();
      const stage = document.querySelector('tide-pet-preview').shadowRoot.querySelector('.pet-stage');
      return { source: snapshot.pose.finLeftTransform, preview: getComputedStyle(stage.querySelector('.fin-left')).transform, classes: snapshot.classes };
    });
    assert.ok(mirrored.classes.includes('is-dragging'));
    assert.match(mirrored.preview, /^matrix/);
    await pause(550);
    const phase = await page.evaluate(async () => {
      const snapshot = await window.petAPI.getPetVisual();
      const stage = document.querySelector('tide-pet-preview').shadowRoot.querySelector('.pet-stage');
      const tail = stage.querySelector('.tail').getAnimations().find(item => item.animationName === 'carried-tail');
      const source = snapshot.animations.find(item => item.name === 'carried-tail');
      return { time: tail?.currentTime, target: source ? source.time + Math.max(0, Date.now() - snapshot.at) * source.rate : null };
    });
    assert.ok(Number.isFinite(phase.time) && Math.abs(phase.time - phase.target) < 150, JSON.stringify(phase));
  } finally { await pet.evaluate(() => document.querySelector('.pet-stage').classList.remove('is-dragging')); }
  await page.waitForFunction(() => !document.querySelector('tide-pet-preview')?.shadowRoot.querySelector('.pet-stage')?.classList.contains('is-dragging'));
  checks.push('desktop carried pose and tail animation phase arrive through the real visual publisher and IPC');

  // Force each new visual class only to exercise actual CSS + publisher + IPC.
  // Random eligibility and selection are separately covered by behavior tests.
  // Hidden Chromium renderers may stop their CSS timeline between paints. These
  // fine phase comparisons exercise the user-visible windows on a rendered frame.
  await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.showInactive(); });
  const idleMoves = { wave: 'wave-fin', scarf: 'scarf-left', sway: 'lazy-sway', peek: 'peek-face', tailcurl: 'tail-curl', bob: 'gentle-bob' };
  const stableBounds = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/pet.html')).getBounds());
  for (const [action, animationName] of Object.entries(idleMoves)) {
    await pet.evaluate(action => {
      const stage = document.querySelector('.pet-stage');
      stage.classList.remove(...[...stage.classList].filter(name => name.startsWith('action-')));
      stage.classList.add(`action-${action}`);
    }, action);
    await page.waitForFunction(action => document.querySelector('tide-pet-preview')?.shadowRoot.querySelector('.pet-stage')?.classList.contains(`action-${action}`), action);
    const phase = await page.evaluate(animationName => new Promise(resolve => requestAnimationFrame(() => {
      const host = document.querySelector('tide-pet-preview');
      // Compare the frame this element actually received; asking main for a
      // newer frame can race its separate queued renderer IPC delivery.
      const snapshot = host._latest;
      const animation = host.shadowRoot.querySelector('.pet-stage').getAnimations({ subtree: true }).find(item => item.animationName === animationName);
      const source = snapshot.animations.find(item => item.name === animationName);
      resolve({ time: animation?.currentTime, source: source ? source.time + Math.max(0, Date.now() - snapshot.at) * source.rate : null, playState: animation?.playState });
    })), animationName);
    assert.ok(Number.isFinite(phase.time) && Math.abs(phase.time - phase.source) < 150, `${action}: ${JSON.stringify(phase)}`);
    assert.equal(phase.playState, 'running');
  }
  assert.deepEqual(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/pet.html')).getBounds()), stableBounds);
  await page.evaluate(() => window.petAPI.petAction('sleep'));
  await page.waitForFunction(() => document.querySelector('tide-pet-preview')?.dataset.visualBehavior === 'sleeping');
  assert.equal(await preview().locator('.action-wave,.action-scarf,.action-sway,.action-peek,.action-tailcurl,.action-bob').count(), 0);
  checks.push('six new idle gestures render and mirror their live phases without moving the window; sleep clears them');

  // Only the visual event is injected here. Transaction persistence and drag
  // authorization are covered by star-feeding-smoke; this checks real CSS/IPC.
  for (const [action, gesture, animationName] of [
    ['star-feed', 'star-eat', 'star-swallow'],
    ['star-produced', 'star-produce', 'star-release'],
  ]) {
    await app.evaluate(({ BrowserWindow }, action) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/pet.html')).webContents.send('pet:action', { action, id: `visual-fixture-${action}`, amount: action === 'star-feed' ? 1 : 3, balance: 7 }), action);
    await page.waitForFunction(gesture => document.querySelector('tide-pet-preview')?.shadowRoot.querySelector('.pet-stage')?.classList.contains(`action-${gesture}`), gesture);
    const phase = await page.evaluate(animationName => new Promise(resolve => requestAnimationFrame(() => {
      const host = document.querySelector('tide-pet-preview'), snapshot = host._latest;
      const animation = host.shadowRoot.querySelector('.pet-stage').getAnimations({ subtree: true }).find(item => item.animationName === animationName);
      const source = snapshot.animations.find(item => item.name === animationName);
      resolve({ time: animation?.currentTime, target: source ? source.time + Math.max(0, Date.now() - snapshot.at) * source.rate : null, state: animation?.playState, amount: host.shadowRoot.querySelector('.born-stars-amount').textContent, idle: snapshot.idleEligible });
    })), animationName);
    assert.equal(phase.state, 'running'); assert.equal(phase.idle, false);
    assert.ok(Number.isFinite(phase.time) && Math.abs(phase.time - phase.target) < 150, JSON.stringify(phase));
    if (action === 'star-produced') assert.equal(phase.amount, '＋3');
    else assert.equal(await pet.locator('.pet-stage').evaluate(stage => stage.classList.contains('is-sleeping')), false);
    await page.waitForFunction(gesture => !document.querySelector('tide-pet-preview')?.shadowRoot.querySelector('.pet-stage')?.classList.contains(`action-${gesture}`), gesture);
  }
  checks.push('eating and producing use distinct synchronized effects, production amount and phases; feeding wakes and effects end cleanly');

  await page.evaluate(async () => { const state = await window.petAPI.loadState(); state.settings.reducedMotion = true; await window.petAPI.saveState(state); });
  await page.waitForFunction(() => document.querySelector('tide-pet-preview')?.shadowRoot.querySelector('.reduced-motion'));
  assert.equal(await preview().evaluate(element => element.shadowRoot.querySelector('.pet-stage').getAnimations({ subtree: true }).length), 0);
  checks.push('reduced motion stops preview animations');
  await mkdir(path.join(root, 'screenshots'), { recursive: true });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('/index.html')).showInactive());
  try {
    await page.screenshot({ path: path.join(root, 'screenshots/pet-preview-overview.png'), fullPage: true });
    await nav('settings'); await ready();
    await page.screenshot({ path: path.join(root, 'screenshots/pet-preview-settings.png'), fullPage: true });
  } finally { await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('/index.html')).hide()); }
  await preview().evaluate(element => element.setAttribute('skin', 'imported-model-fixture'));
  assert.equal(await preview().locator('.preview-placeholder').isVisible(), false);
  assert.equal(await preview().locator('.preview-scene').isVisible(), true);
  assert.equal(await preview().locator('.pet-stage').getAttribute('data-variant'), 'builtin');
  checks.push('hidden Live2D selections use the builtin companion preview without exposing model controls');

  await page.addInitScript(() => {
    const fetch = window.fetch;
    window.fetch = (input, ...args) => String(input).endsWith('/pet.html') ? Promise.reject(new Error('fixture template failure')) : fetch(input, ...args);
  });
  await page.reload();
  await page.waitForFunction(() => document.querySelector('tide-pet-preview')?.dataset.previewState === 'fallback');
  assert.match(await preview().locator('.preview-note').innerText(), /静态外观/);
  assert.equal(await preview().locator('.preview-fallback img').evaluate(image => image.complete && image.naturalWidth > 0), true);
  checks.push('template failure retains a labeled visible thumbnail');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks, userData }, null, 2));
} finally { await app.close(); }
