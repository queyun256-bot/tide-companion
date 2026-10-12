// Isolated real Electron: persisted wallet -> read-only UI and synchronized sky.
import { _electron as electron } from 'playwright-core';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { localDateKey } from '../src/journal.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const userData = await mkdtemp(path.join(tmpdir(), 'tide-star-wallet-ui-'));
const { defaultState, validateState } = createRequire(import.meta.url)('../electron/state.cjs');
const fixture = defaultState();
const base = Date.now();
fixture.settings.notifications = false; fixture.settings.autoHideFullscreen = false; fixture.settings.activeSkin = 'builtin-lilac';
fixture.starWallet = { version: 1, entries: Array.from({ length: 14 }, (_, index) => {
  const scheduledAt = new Date(base - (index + 1) * 86400000).toISOString(), earnedAt = new Date(+new Date(scheduledAt) + 1000).toISOString();
  const planId = `past-week-${index}`;
  return { id: `${planId}@${scheduledAt}`, planId, doseId: `past-dose-${index}`, scheduledAt, earnedAt, doseAt: scheduledAt, day: localDateKey(earnedAt), kind: 'long', amount: 7, intervalHours: 168, routeId: 'e2-ev-im', doseAmount: 4 };
}) };
const earlier = new Date(base).toISOString();
fixture.starWallet.entries.push({ id: `today-past@${earlier}`, planId: 'today-past', doseId: 'today-past-dose', scheduledAt: earlier, earnedAt: earlier, doseAt: earlier, day: localDateKey(earlier), kind: 'regular', amount: 1, intervalHours: 24, routeId: 'e2-oral', doseAmount: 1 });
fixture.plans = [
  { id: 'earn-daily-a', name: '普通提醒 A', routeId: 'e2-oral', amount: 2, intervalHours: 24, startAt: new Date(base - 5000).toISOString(), enabled: true },
  { id: 'earn-daily-b', name: '普通提醒 B', routeId: 'cpa-oral', amount: 12.5, intervalHours: 24, startAt: new Date(base - 4000).toISOString(), enabled: true },
  { id: 'earn-long', name: '长周期提醒', routeId: 'e2-ev-im', amount: 4, intervalHours: 48, startAt: new Date(base - 3000).toISOString(), enabled: true },
];
await writeFile(path.join(userData, 'state.json'), JSON.stringify(validateState(fixture)));
const env = { ...process.env, TIDE_TEST_DATA: userData }; delete env.ELECTRON_RUN_AS_NODE;
const launch = () => electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'), args: [path.join(root, 'tests/launch-smoke.cjs')], env, timeout: 30000 });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const checks = [], errors = [];
let app = await launch(), page, pet;
async function windows() {
  for (let n = 0; n < 100; n++) {
    page = app.windows().find(window => window.url().endsWith('/index.html')); pet = app.windows().find(window => window.url().endsWith('/pet.html'));
    if (page && pet) break; await pause(100);
  }
  assert.ok(page && pet); page.setDefaultTimeout(10000); pet.setDefaultTimeout(10000);
  await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) { window.webContents.setBackgroundThrottling(false); window.hide(); } });
  for (const window of [page, pet]) window.on('pageerror', error => errors.push(error.message));
  await page.locator('h1').waitFor();
  await page.waitForFunction(() => document.querySelector('tide-pet-preview')?.dataset.previewState === 'ready');
}
const confirm = id => page.evaluate(async planId => {
  const state = await window.petAPI.loadState(), plan = state.plans.find(item => item.id === planId);
  // A past instant within the real reminder window avoids sub-millisecond
  // renderer/main clock rounding making a just-created timestamp look future.
  state.doses.push({ id: `${planId}-actual`, planId, routeId: plan.routeId, amount: plan.amount, at: new Date(Date.parse(plan.startAt) + 1000).toISOString() });
  return window.petAPI.saveState(state);
}, id);
try {
  await windows();
  assert.match(await page.locator('.star-wallet-summary').innerText(), /已攒下 99 颗/);
  assert.equal(await page.locator('tide-pet-preview').locator('.star-lights').getAttribute('data-count'), '99');
  assert.equal(await page.locator('tide-pet-preview').locator('.star-lights').getAttribute('data-star-tier'), '60');
  await page.waitForFunction(async () => (await window.petAPI.loadState()).reminderLog.filter(item => item.status === 'notified').length === 3);
  checks.push('persisted 99-star balance appears in the overview and the correct sky tier');

  await confirm('earn-daily-a');
  await page.waitForFunction(() => document.querySelector('tide-pet-preview')?.dataset.visualStars === '100');
  assert.match(await page.locator('.star-wallet-summary').innerText(), /已攒下 100 颗/);
  assert.equal(await page.locator('tide-pet-preview').locator('.star-lights').getAttribute('data-star-tier'), '100');
  const snapshot = await page.evaluate(() => window.petAPI.getPetVisual());
  assert.equal(snapshot.stars, 100);
  const sourceSVG = await pet.locator('.star-sky').evaluate(element => element.outerHTML);
  assert.equal(await page.locator('tide-pet-preview').locator('.star-sky').evaluate(element => element.outerHTML), sourceSVG);
  const motion = await page.evaluate(async () => {
    const snapshot = await window.petAPI.getPetVisual();
    const element = document.querySelector('tide-pet-preview').shadowRoot.querySelector('[data-star-motion="point"]');
    const animation = element.getAnimations().find(item => item.animationName === 'star-drift');
    return { time: animation?.currentTime, playState: animation?.playState, expected: (snapshot.starPaused ? snapshot.starPausedAt : Date.now()) - snapshot.starEpoch + Number(element.dataset.phase), paused: snapshot.starPaused };
  });
  assert.ok(Number.isFinite(motion.time) && Math.abs(motion.time - motion.expected) < 150, JSON.stringify(motion));
  assert.equal(motion.playState, motion.paused ? 'paused' : 'running');
  checks.push('a real reminder confirmation crosses 100 stars; desktop and preview share layout and animation phase');

  await confirm('earn-daily-b');
  const capped = await page.evaluate(() => window.petAPI.loadState());
  assert.equal(capped.starWallet.entries.reduce((sum, item) => sum + item.amount, 0), 100);
  assert.ok(capped.doses.some(item => item.id === 'earn-daily-b-actual'));
  await confirm('earn-long');
  await page.waitForFunction(() => document.querySelector('tide-pet-preview')?.dataset.visualStars === '102');
  await page.evaluate(() => document.querySelector('.star-wallet-summary').click());
  await page.locator('#star-wallet-card').waitFor();
  assert.equal(await page.locator('#star-wallet-card [data-star-balance]').innerText(), '102');
  assert.match(await page.locator('#star-wallet-card [data-star-today]').innerText(), /＋4/);
  assert.match(await page.locator('#star-wallet-card [data-star-regular]').innerText(), /2\s*\/ 2/);
  assert.equal(await page.locator('.star-wallet-history li').count(), 5);
  assert.equal(await page.locator('#star-wallet-card input,#star-wallet-card form,[data-action="feed"]').count(), 0);
  assert.equal(await page.locator('#star-wallet-card [data-star-feed-source]').count(), 1);
  assert.equal(await page.locator('#star-wallet-card [data-star-feed-target]').count(), 1);
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'star-wallet-card');
  await page.locator('.star-wallet-rules summary').evaluate(element => element.click());
  assert.match(await page.locator('.star-wallet-rules').innerText(), /2 小时内[\s\S]*48 小时及以上[\s\S]*不占当天普通额度/);
  checks.push('regular quota stays at 2 while long-cycle rewards remain separate; wallet has five recent records and only the star feeding source');

  assert.equal(await page.evaluate(async () => { try { await window.petAPI.petAction('feed'); return false; } catch { return true; } }), true);
  const counterfeit = await page.evaluate(async () => { const state = await window.petAPI.loadState(); state.starWallet.entries = []; return window.petAPI.saveState(state); });
  assert.equal(counterfeit.starWallet.entries.reduce((sum, item) => sum + item.amount, 0), 102);
  checks.push('legacy feeding is rejected and renderer state edits cannot reset currency');

  await mkdir(path.join(root, 'screenshots'), { recursive: true });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html')).showInactive());
  try {
    await page.locator('#star-wallet-card').screenshot({ path: path.join(root, 'screenshots/star-wallet-card.png') });
    await page.evaluate(() => document.querySelector('[data-page="overview"]').click());
    await page.waitForFunction(() => document.querySelector('tide-pet-preview')?.dataset.visualStars === '102');
    await page.locator('.hero').screenshot({ path: path.join(root, 'screenshots/star-wallet-sky.png') });
  } finally { await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html')).hide()); }
  await page.evaluate(async () => { const state = await window.petAPI.loadState(); state.settings.reducedMotion = true; await window.petAPI.saveState(state); });
  await page.waitForFunction(() => document.querySelector('tide-pet-preview')?.shadowRoot.querySelector('.stars-reduced'));
  assert.equal(await page.locator('tide-pet-preview').locator('.star-sky').evaluate(element => element.getAnimations({ subtree: true }).length), 0);
  assert.equal(await page.locator('tide-pet-preview').locator('.star-point').count(), 14);
  checks.push('reduced motion keeps the accumulated sky visible without particles moving');

  await app.close(); app = null;
  const saved = JSON.parse(await readFile(path.join(userData, 'state.json'), 'utf8'));
  assert.equal(saved.starWallet.entries.reduce((sum, item) => sum + item.amount, 0), 102);
  app = await launch(); await windows();
  assert.match(await page.locator('.star-wallet-summary').innerText(), /已攒下 102 颗/);
  assert.equal(await page.locator('tide-pet-preview').locator('.star-lights').getAttribute('data-count'), '102');
  checks.push('relaunch retains the wallet and sky without granting startup rewards');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks, userData }, null, 2));
} finally { if (app) await app.close(); }
