import {_electron as electron} from 'playwright-core';
import {mkdtemp, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const userData = await mkdtemp(path.join(tmpdir(), 'tide-i18n-companion-'));
const fixture = createRequire(import.meta.url)('../electron/state.cjs').defaultState();
fixture.settings.language = 'system'; fixture.settings.name = '小浪 <friend>'; fixture.settings.autoHideFullscreen = false;
await writeFile(path.join(userData, 'state.json'), JSON.stringify(fixture));
const env = {...process.env, TIDE_TEST_DATA: userData, TIDE_TEST_SYSTEM_LOCALE: 'es-ES'}; delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'), args: [path.join(root, 'tests/launch-smoke.cjs')], env, timeout: 30000});
const errors = [], checked = [];
try {
  let page, pet;
  for (let n = 0; n < 100; n++) {
    page = app.windows().find(window => window.url().endsWith('/index.html'));
    pet = app.windows().find(window => window.url().endsWith('/pet.html'));
    if (page && pet) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(page && pet);
  for (const window of [page, pet]) window.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({BrowserWindow}) => {for (const window of BrowserWindow.getAllWindows()) {window.webContents.setBackgroundThrottling(false); window.hide();}});
  await pet.waitForFunction(() => document.documentElement.lang === 'es');
  await page.waitForFunction(() => document.querySelector('tide-pet-preview')?.dataset.previewState === 'ready');
  assert.match(await pet.locator('#pat-pet').getAttribute('title'), /Acariciar/);
  await page.evaluate(() => window.petAPI.petAction('sleep'));
  await pet.waitForFunction(() => document.querySelector('.pet-stage').dataset.behavior === 'sleeping');
  const marker = 'same-pet-instance';
  await pet.locator('.pet-stage').evaluate((element, value) => {element.dataset.identityTest = value;}, marker);
  for (const locale of ['en', 'zh-CN', 'zh-TW', 'ja', 'ko', 'es']) {
    await page.evaluate(async language => {const state = await window.petAPI.loadState(); state.settings.language = language; await window.petAPI.saveState(state);}, locale);
    await pet.waitForFunction(value => document.documentElement.lang === value, locale);
    await page.waitForFunction(value => document.documentElement.lang === value, locale);
    assert.equal(await pet.locator('.pet-stage').getAttribute('data-identity-test'), marker);
    assert.equal(await pet.locator('.pet-stage').getAttribute('data-behavior'), 'sleeping');
    assert.equal(await pet.locator('#speech').getAttribute('aria-hidden'), 'true');
    const title = await pet.locator('#pat-pet').getAttribute('title');
    assert.ok(title.includes('小浪 <friend>'));
    await pet.locator('#wallet-pet').evaluate(element => element.click());
    const speech = await pet.locator('#speech-text').textContent();
    if (['en', 'ko', 'es'].includes(locale)) assert.doesNotMatch(speech, /[\u3400-\u9fff]/);
    assert.ok(speech.length > 5);
    const aria = await page.locator('tide-pet-preview').first().getAttribute('aria-label');
    assert.ok(aria.includes('小浪 <friend>'));
    checked.push({locale, title, speech, preview: aria});
  }
  // A state broadcast can change the language while an existing editor holds a
  // draft. The modal sits outside the rerendered page and must keep its fields.
  await page.evaluate(() => document.querySelector('[data-page="plans"]').click());
  await page.evaluate(() => document.querySelector('[data-action="plan"]:not([data-id])').click());
  const draftName = '今天 <img src=x onerror="alert(1)"> & {0}';
  await page.locator('#dialog-form [name="name"]').fill(draftName);
  await page.locator('#dialog-form [name="amount"]').fill('1.25');
  await page.locator('#dialog-form [name="intervalHours"]').fill('24');
  await page.locator('#dialog-form [name="startAt"]').evaluate(input => {input.value = '2099-10-13T08:20'; input.dispatchEvent(new Event('change', {bubbles: true}));});
  const before = await page.locator('#dialog-form').evaluate(form => {form.dataset.draftIdentity = 'same-draft'; return Object.fromEntries(new FormData(form));});
  await pet.evaluate(async () => {const state = await window.petAPI.loadState(); state.settings.language = 'ja'; await window.petAPI.saveState(state);});
  await page.waitForFunction(() => document.documentElement.lang === 'ja');
  assert.equal(await page.locator('#dialog-form').getAttribute('data-draft-identity'), 'same-draft');
  assert.deepEqual(await page.locator('#dialog-form').evaluate(form => Object.fromEntries(new FormData(form))), before);
  await page.locator('#dialog-form button[type="submit"]').evaluate(button => button.click());
  await page.waitForFunction(() => !document.querySelector('#modal').open);
  const saved = await page.evaluate(() => window.petAPI.loadState());
  assert.equal(saved.plans.at(-1).name, draftName);
  assert.equal(saved.plans.at(-1).amount, 1.25);
  assert.equal(saved.plans.at(-1).intervalHours, 24);
  assert.equal(await page.locator('.plan-card img').count(), 0);
  assert.ok((await page.locator('.plan-card').last().innerText()).includes(draftName));
  checked.push({draft: 'Survived language broadcast and saved without translation or HTML injection'});
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({passed: true, userData, checked}, null, 2));
} finally {await app.close();}
