// Production IPC + journal forms, with synthetic plans in isolated app data only.
import { _electron as electron } from 'playwright-core';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checks = [], errors = [], isolatedData = [];
let app, win, userData;
const balance = state => state.starWallet.entries.reduce((sum, entry) => sum + entry.amount, 0);
const disk = () => readFile(path.join(userData, 'state.json'), 'utf8').then(JSON.parse);
const minute = () => Math.floor(Date.now() / 60000) * 60000;
const iso = time => new Date(time).toISOString();
const localInput = time => {
  const date = new Date(time), pad = number => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};
async function launch(fresh = false) {
  if (fresh) {
    userData = await mkdtemp(path.join(tmpdir(), 'tide-star-rewards-v092-'));
    isolatedData.push(userData);
  }
  const env = {...process.env, TIDE_TEST_DATA:userData};
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({
    executablePath:path.join(root, 'node_modules/electron/dist/electron.exe'),
    args:[path.join(root, 'tests/launch-smoke.cjs')], env, timeout:30000,
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    win = app.windows().find(page => page.url().endsWith('/index.html'));
    if (win) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(win, 'journal window must open');
  win.setDefaultTimeout(10000);
  win.on('pageerror', error => errors.push(error.message));
  await win.locator('h1').waitFor();
  await app.evaluate(({BrowserWindow}) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.setBackgroundThrottling(false);
      window.hide();
    }
  });
  if (fresh) await win.evaluate(async () => {
    const state = await window.petAPI.loadState();
    Object.assign(state.settings, {notifications:false, petVisible:false, autoHideFullscreen:false, reducedMotion:true});
    await window.petAPI.saveState(state);
  });
}
async function close() {
  if (app) await app.close();
  app = null; win = null;
}
async function plans(items) {
  await win.evaluate(async items => {
    const state = await window.petAPI.loadState();
    state.plans = items;
    await window.petAPI.saveState(state);
  }, items);
  await win.locator('[data-page="plans"]').click();
}
const plan = (id, amount, startAt, intervalHours = 24) => ({
  id, name:`合成测试 ${id}`, routeId:'e2-oral', amount,
  startAt:iso(startAt), intervalHours, enabled:true,
});
async function openGenericDose(amount, at) {
  await win.locator('[data-page="plans"]').click();
  await win.locator('[data-action="dose"]:not([data-id])').click();
  assert.equal(await win.locator('#dialog-form select[name="planId"]').inputValue(), '');
  await win.locator('#dialog-form [name="amount"]').fill(String(amount));
  if (at !== undefined) {
    await win.locator('#dialog-form [data-date-picker-input]').fill(localInput(at));
    await win.locator('#dialog-form [data-date-picker-input]').press('Tab');
  }
}
async function submitDose() {
  await win.locator('#dialog-form button[type="submit"]').click();
  await win.locator('#modal').waitFor({state:'hidden'});
}
async function toastContains(text) {
  await win.waitForFunction(text => document.querySelector('#toast')?.textContent.includes(text), text);
}
async function preview(record) {
  const before = await disk();
  const result = await win.evaluate(record => window.petAPI.previewDoseReward(record), record);
  assert.deepEqual(await disk(), before, 'preview must not persist a dose, receipt, or star');
  return result;
}

try {
  await launch(true);
  const now = minute();
  await plans([plan('early', 1, now + 3600000), plan('late', 2, now - 3600000), plan('third', 3, now + 3600000)]);
  const scheduled = await disk();
  assert.equal(scheduled.reminderLog.some(receipt => receipt.planId === 'early'), false);
  assert.equal(scheduled.reminderLog.find(receipt => receipt.planId === 'late')?.status, 'missed');
  assert.equal(balance(scheduled), 0);
  const earlyPreview = await preview({id:'preview-early', routeId:'e2-oral', amount:1, at:iso(now)});
  assert.deepEqual(earlyPreview, {doseId:'preview-early', code:'awarded', amount:1});
  await openGenericDose(1, now); await submitDose();
  await toastContains('多了 1 颗');
  assert.equal(balance(await disk()), 1);
  assert.equal((await disk()).starWallet.entries[0].planId, 'early');
  assert.equal((await disk()).reminderLog.some(receipt => receipt.planId === 'early'), false);
  checks.push('existing reminder one hour in the future awards through the generic journal form before any notification; preview is read-only');

  await openGenericDose(2, now); await submitDose();
  await toastContains('多了 1 颗');
  assert.equal(balance(await disk()), 2);
  assert.equal((await disk()).starWallet.entries[1].planId, 'late');
  checks.push('use one hour after a reminder awards even when startup classifies the emitted reminder as missed');

  await openGenericDose(3, now); await submitDose();
  await toastContains('今天普通提醒的 2 颗星星已经领齐了');
  assert.equal(balance(await disk()), 2);
  assert.equal((await disk()).doses.length, 3);
  await openGenericDose(1, now); await submitDose();
  await toastContains('同一次使用不会重复增加星星');
  assert.equal(balance(await disk()), 2);
  assert.equal((await disk()).doses.length, 4);
  checks.push('daily cap and duplicate-use feedback explain zero rewards while preserving actual-use records');

  await win.locator('[data-page="curves"]').click();
  assert.equal(await win.locator('body').getAttribute('data-mode'), 'mtf');
  assert.equal(await win.locator('[data-page-view="curves"]').getByText('身体的潮汐', {exact:true}).count(), 1);
  await win.locator('[data-action="mode-ftm"]').click();
  await win.waitForFunction(() => document.body.dataset.mode === 'ftm');
  assert.equal(await win.locator('[data-page-view="curves"]').getByText('身体的潮汐', {exact:true}).count(), 1);
  await close(); await launch();
  const restarted = await disk();
  assert.equal(balance(restarted), 2);
  assert.equal(restarted.settings.mode, 'ftm');
  const existing = restarted.doses[0];
  assert.equal((await preview(existing)).code, 'existing');
  const repeated = await win.evaluate(async id => {
    const state = await window.petAPI.loadState();
    return window.petAPI.saveDoseState(state, id);
  }, existing.id);
  assert.equal(repeated.reward.code, 'existing');
  assert.equal(balance(repeated.state), 2);
  checks.push('both modes show 身体的潮汐; full restart restores mode, wallet and deduplication');
  await close();

  await launch(true);
  const secondNow = minute(), sameSchedule = secondNow + 3600000;
  await plans([plan('same-a', 4, sameSchedule, 168), plan('same-b', 4, sameSchedule, 168), plan('later-record', 5, secondNow - 24 * 3600000, 168)]);
  const ambiguous = {id:'preview-ambiguous', routeId:'e2-oral', amount:4, at:iso(secondNow)};
  assert.equal((await preview(ambiguous)).code, 'ambiguous');
  const beforeAmbiguity = await disk();
  const rejection = await win.evaluate(async record => {
    const state = await window.petAPI.loadState();
    state.doses.push(record);
    return window.petAPI.saveDoseState(state, record.id).then(() => '', error => error.message);
  }, ambiguous);
  assert.match(rejection, /有多个相同的提醒/);
  assert.deepEqual(await disk(), beforeAmbiguity, 'main process must also reject an ambiguous requested reward atomically');
  await openGenericDose(4, secondNow);
  await win.locator('#dialog-form button[type="submit"]').click();
  await win.waitForFunction(() => document.querySelector('#dialog-form .error')?.textContent.includes('有多个相同的提醒'));
  assert.equal(await win.locator('#modal').evaluate(dialog => dialog.open), true);
  assert.equal(await win.locator('#dialog-form [name="amount"]').inputValue(), '4');
  assert.deepEqual(await disk(), beforeAmbiguity);
  await win.locator('#dialog-form select[name="planId"]').selectOption('same-b');
  if (process.argv.includes('--screenshot')) {
    await mkdir(path.join(root, 'build'), {recursive:true});
    await win.screenshot({path:path.join(root, 'build/v092-dose-form.png')});
  }
  await submitDose(); await toastContains('多了 7 颗');
  assert.equal(balance(await disk()), 7);
  assert.equal((await disk()).starWallet.entries[0].planId, 'same-b');
  checks.push('ambiguous reminders preserve the form and disk; choosing the matching reminder permits one seven-star reward');

  const actualYesterday = secondNow - 23 * 3600000;
  await openGenericDose(5, actualYesterday); await submitDose();
  await toastContains('多了 7 颗');
  assert.equal(balance(await disk()), 14);
  assert.equal((await disk()).starWallet.entries.find(entry => entry.planId === 'later-record').doseAt, iso(actualYesterday));
  await close(); await launch();
  assert.equal(balance(await disk()), 14);
  assert.equal(balance(await win.evaluate(() => window.petAPI.loadState())), 14);
  assert.deepEqual(errors, []);
  checks.push('later entry uses the actual medication time within the reminder window; long-interval rewards survive restart');
  console.log(JSON.stringify({ok:true, checks, isolatedData, installerPayload:Boolean(process.env.TIDE_TEST_APP_ROOT), pageErrors:errors}));
} finally {
  await close();
}
