// Native Electron renderer with isolated data. No clinical records are imported.
import { _electron as electron } from 'playwright-core';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const userData = await mkdtemp(path.join(tmpdir(), 'tide-gaht-reference-'));
const env = { ...process.env, TIDE_TEST_DATA: userData }; delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'), args: [path.join(root, 'tests/launch-smoke.cjs')], env, timeout: 30000 });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const checks = [], errors = [];
try {
  let page;
  for (let n = 0; n < 100; n++) {
    page = app.windows().find(window => window.url().endsWith('/index.html'));
    if (page) break;
    await pause(100);
  }
  assert.ok(page); page.setDefaultTimeout(8000);
  await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) { window.hide(); window.webContents.setBackgroundThrottling(false); } });
  await page.locator('h1').waitFor();
  page.on('pageerror', error => errors.push(error.message));
  const nav = key => page.evaluate(value => document.querySelector(`[data-page="${value}"]`).click(), key);
  assert.equal(await page.locator('.gaht-reference').count(), 0);
  await nav('curves');
  const e2 = page.locator('.hormone-card.estradiol .gaht-reference');
  await e2.waitFor();
  assert.match(await e2.innerText(), /指南监测参考[\s\S]*100–200 pg\/mL[\s\S]*367–734/);
  assert.equal(await page.locator('.hormone-card.cpa .gaht-reference').count(), 0);
  assert.equal(await e2.locator('details').getAttribute('open'), null);
  await e2.locator('summary').click();
  assert.match(await e2.innerText(), /不是每一时刻的安全阈值/);
  assert.equal(await e2.locator('[data-source]').count(), 3);
  checks.push('MTF current E2 has visible monitoring context, expandable evidence, and CPA has no invented target');

  await mkdir(path.join(root, 'screenshots'), { recursive: true });
  await page.screenshot({ path: path.join(root, 'screenshots/gaht-reference-mtf.png'), fullPage: true, animations: 'disabled' });
  await nav('labs'); assert.equal(await page.locator('.gaht-reference').count(), 0);
  await nav('curves');
  await page.evaluate(() => document.querySelector('[data-action="mode-ftm"]').click());
  await page.waitForFunction(() => document.body.dataset.mode === 'ftm');
  const t = page.locator('.hormone-card.testosterone .gaht-reference');
  assert.match(await t.innerText(), /400–700 ng\/dL[\s\S]*仅指庚酸 \/ 环戊丙酸睾酮注射间隔中点采血/);
  await page.locator('[data-setting="showFtmEstradiol"]').check();
  await page.locator('.hormone-card.estradiol .gaht-reference').waitFor();
  assert.match(await page.locator('.hormone-card.estradiol .gaht-reference').innerText(), /未设统一 E2 目标/);
  checks.push('references are curve-only, mode-specific, and FTM E2 never inherits feminizing target');

  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().endsWith('/index.html')); window.setContentSize(860, 620); });
  // Fractional Windows DPI scaling can round DIP content bounds by one pixel.
  await page.waitForFunction(() => window.innerWidth >= 850 && window.innerWidth <= 870);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  const context = await t.locator('.gaht-reference-context').evaluate(element => {
    const rect = element.getBoundingClientRect();
    return { width: rect.width, overflow: element.scrollWidth > element.clientWidth, text: element.textContent };
  });
  assert.ok(context.width > 100); assert.equal(context.overflow, false);
  await page.screenshot({ path: path.join(root, 'screenshots/gaht-reference-ftm-small.png'), fullPage: true, animations: 'disabled' });
  checks.push('sampling conditions wrap without horizontal overflow at the minimum desktop width');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks, userData }, null, 2));
} finally { await app.close(); }
