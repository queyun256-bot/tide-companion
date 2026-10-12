// Synthetic saved ledger, real main-process validation and live Electron UI.
// Native drag transactions have a separate star-feeding-smoke fixture.
import { _electron as electron } from 'playwright-core';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { localDateKey } from '../src/journal.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { defaultState, validateState } = createRequire(import.meta.url)('../electron/state.cjs');
const userData = await mkdtemp(path.join(tmpdir(), 'tide-growth-ui-'));
const state = defaultState(), now = Date.now();
state.settings.notifications = false; state.settings.autoHideFullscreen = false; state.settings.onboardingCompleted = true;
state.starWallet.entries = Array.from({ length: 8 }, (_, index) => {
  const at = new Date(now - (index + 2) * 86400000).toISOString(), id = `grown-fixture-${index}`;
  return { id: `${id}@${at}`, planId: id, doseId: id, routeId: 'e2-oral', doseAmount: 2, intervalHours: 168, kind: 'long', amount: 7, scheduledAt: at, doseAt: at, earnedAt: at, day: localDateKey(at) };
});
state.starWallet.entries.push(...Array.from({ length: 14 }, (_, index) => {
  const at = new Date(now - 120000 + index * 1000).toISOString();
  return { id: `feed@growth-fixture-${index}`, kind: 'feed', amount: -1, earnedAt: at, day: localDateKey(at), sharkId: 'builtin' };
}));
const at = new Date(now - 10000).toISOString();
state.starWallet.entries.push({ id: `idle@${localDateKey(at)}`, kind: 'idle', amount: 3, earnedAt: at, day: localDateKey(at), sharkId: 'builtin', level: 3 });
await writeFile(path.join(userData, 'state.json'), JSON.stringify(validateState(state)));
const env = { ...process.env, TIDE_TEST_DATA: userData }; delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'), args: [path.join(root, 'tests/launch-smoke.cjs')], env, timeout: 30000 });
const checks = [], errors = []; let page;
try {
  for (let n = 0; n < 100; n++) {
    page = app.windows().find(window => window.url().endsWith('/index.html'));
    if (page) break; await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(page); page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) { window.webContents.setBackgroundThrottling(false); window.hide(); } });
  await page.locator('h1').waitFor();
  await page.evaluate(() => document.querySelector('[data-page="settings"]').click());
  await page.waitForFunction(() => document.querySelector('.wallet-pet-preview')?.dataset.previewState === 'ready');
  assert.equal(await page.locator('[data-star-balance]').innerText(), '45');
  assert.equal(await page.locator('[data-pet-level]').innerText(), 'Lv.3');
  assert.equal(await page.locator('[data-pet-experience]').innerText(), '1 / 12');
  assert.match(await page.locator('[data-star-today]').innerText(), /＋3/);
  assert.equal(await page.locator('.pet-experience').getAttribute('max'), '12');
  assert.equal(await page.locator('.pet-experience').getAttribute('value'), '1');
  assert.equal(await page.locator('[data-star-feed-source]').getAttribute('draggable'), 'true');
  assert.equal(await page.locator('.wallet-pet-preview .round-body').count(), 1);
  checks.push('validated signed ledger derives level 3, 1/12 XP and 45-star balance with an adjacent live feeding target');

  assert.match(await page.locator('.star-wallet-history li').first().innerText(), /留下的星光[\s\S]*＋3/);
  assert.equal(await page.locator('.star-wallet-history .wallet-spent').count(), 4);
  assert.match(await page.locator('.pet-growth-hint').innerText(), /今天的星光已经留下/);
  assert.equal((await page.evaluate(() => window.petAPI.loadState())).petGrowth.maxLevel, false);
  checks.push('recent records distinguish spent stars from idle earnings and the daily shared claim state');

  await mkdir(path.join(root, 'screenshots'), { recursive: true });
  for (const [width, height] of [[1440, 960], [860, 620]]) {
    await app.evaluate(({ BrowserWindow }, size) => { const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('/index.html')); window.setContentSize(size.width, size.height); window.showInactive(); }, { width, height });
    await page.locator('#star-wallet-card').scrollIntoViewIfNeeded();
    await page.waitForFunction(() => !document.querySelector('.page')?.getAnimations().some(item => item.playState === 'running'));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${width}px document overflow`);
    const layout = await page.evaluate(() => { const card = document.querySelector('#star-wallet-card').getBoundingClientRect(), target = document.querySelector('.wallet-pet-preview').getBoundingClientRect(), source = document.querySelector('[data-star-feed-source]').getBoundingClientRect(); return { card: [card.left, card.right], target: [target.left, target.right], source: [source.left, source.right] }; });
    assert.ok(layout.target[0] >= layout.card[0] && layout.target[1] <= layout.card[1], JSON.stringify(layout));
    assert.ok(layout.source[0] >= layout.card[0] && layout.source[1] <= layout.card[1], JSON.stringify(layout));
    await page.locator('#star-wallet-card').screenshot({ path: path.join(root, `screenshots/pet-growth-wallet-mtf-${width}.png`) });
  }
  checks.push('MTF wallet screenshots at 1440×960 and 860×620 keep the source and pet in-card without horizontal overflow');
  await page.evaluate(async () => { const state = await window.petAPI.loadState(); state.settings.reducedMotion = true; await window.petAPI.saveState(state); });
  await page.waitForFunction(() => document.querySelector('.wallet-pet-preview')?.shadowRoot.querySelector('.reduced-motion'));
  assert.equal(await page.locator('.wallet-pet-preview').evaluate(host => host.shadowRoot.querySelector('.pet-stage').getAnimations({ subtree: true }).length), 0);
  assert.equal(await page.locator('.pet-experience').evaluate(element => getComputedStyle(element, '::-webkit-progress-value').transitionDuration), '0s');
  checks.push('reduced motion retains the growth values, feeding source and static companion');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks, userData }, null, 2));
} finally { await app.close(); }
