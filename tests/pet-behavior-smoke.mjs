import { _electron as electron } from 'playwright-core';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function findPet(app) {
  await app.firstWindow();
  for (let index = 0; index < 100; index += 1) {
    const pet = app.windows().find(window => window.url().endsWith('/pet.html'));
    if (pet) return pet;
    await pause(100);
  }
  assert.fail('pet window did not open');
}
// Daily choices are permanent. Test distinct mood profiles in separate stores,
// rather than changing or erasing a production daily choice to reuse a fixture.
const lowData = await mkdtemp(path.join(tmpdir(), 'tide-pet-low-mood-'));
const lowEnv = { ...process.env, TIDE_TEST_DATA: lowData };
delete lowEnv.ELECTRON_RUN_AS_NODE;
const lowApp = await electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'), args: [path.join(root, 'tests/launch-smoke.cjs')], env: lowEnv, timeout: 30000 });
try {
  const lowPet = await findPet(lowApp);
  await lowPet.waitForFunction(() => document.querySelector('.pet-stage').dataset.behavior === 'awake');
  assert.equal(await lowPet.locator('.pet-stage').getAttribute('data-mood'), 'okay');
  await lowPet.evaluate(() => window.petAPI.petAction('mood-low'));
  await lowPet.waitForFunction(() => document.querySelector('.pet-stage').dataset.mood === 'low');
  assert.equal(await lowPet.locator('.fin-left').evaluate(element => getComputedStyle(element).animationDuration), '6.8s');
  await assert.rejects(lowPet.evaluate(() => window.petAPI.petAction('mood-good')));
  assert.equal(await lowPet.locator('.pet-stage').getAttribute('data-mood'), 'low');
  await lowPet.reload();
  await lowPet.waitForFunction(() => document.querySelector('.pet-stage').dataset.mood === 'low');
} finally { await lowApp.close(); }
const userData = await mkdtemp(path.join(tmpdir(), 'tide-pet-behavior-'));
const env = { ...process.env, TIDE_TEST_DATA: userData };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'), args: [path.join(root, 'tests/launch-smoke.cjs')], env, timeout: 30000 });
const errors = [];
try {
  const pet = await findPet(app);
  pet.on('pageerror', error => errors.push(error.message));
  pet.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await pet.clock.install({ time: new Date() });
  await pet.reload();
  await pet.waitForFunction(() => document.querySelector('.pet-stage').dataset.behavior === 'awake');
  const bounds = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/pet.html')).getBounds());
  const startBounds = await bounds();
  await pet.evaluate(() => window.petAPI.petAction('mood-good'));
  await pet.waitForFunction(() => document.querySelector('.pet-stage').dataset.mood === 'good');
  assert.equal(await pet.locator('.fin-left').evaluate(element => getComputedStyle(element).animationDuration), '2.8s');
  const replies = [];
  for (let index = 0; index < 6; index += 1) {
    if (index) await pet.clock.fastForward(13000);
    await pet.evaluate(() => window.petAPI.petAction('pet'));
    await pet.waitForTimeout(50);
    replies.push(await pet.locator('#speech-text').textContent());
  }
  assert.ok(new Set(replies).size >= 4, 'mood-specific touch responses vary');
  const beforeWallet=(await pet.evaluate(()=>window.petAPI.loadState())).moods.length;
  await pet.locator('#wallet-pet').evaluate(element=>element.click());
  assert.match(await pet.locator('#speech-text').textContent(), /0 颗星星/);
  assert.equal((await pet.evaluate(()=>window.petAPI.loadState())).moods.length,beforeWallet,'reading the wallet writes no interaction or credit');
  await assert.rejects(pet.evaluate(()=>window.petAPI.petAction('feed')));
  await pet.evaluate(() => window.petAPI.petAction('sleep'));
  await pet.waitForFunction(() => document.querySelector('.pet-stage').dataset.behavior === 'drowsy');
  await pet.waitForTimeout(800);
  assert.equal(await pet.locator('.pet-stage').getAttribute('data-behavior'), 'drowsy');
  const eyeScale = await pet.locator('.eyes').evaluate(element => new DOMMatrix(getComputedStyle(element).transform).d);
  assert.ok(eyeScale > .1 && eyeScale < 1, 'eyelids ease down instead of snapping closed');
  await pet.waitForFunction(() => document.querySelector('.pet-stage').dataset.behavior === 'sleeping');
  await mkdir(path.join(root, 'screenshots'), { recursive: true });
  await pet.screenshot({ path: path.join(root, 'screenshots/pet-v03-sleeping.png'), omitBackground: true });
  await pet.mouse.click(170, 225);
  await pet.waitForFunction(() => document.querySelector('.pet-stage').dataset.behavior === 'waking');
  await pet.waitForFunction(() => document.querySelector('.pet-stage').dataset.behavior === 'awake');
  // Long press is one nuzzle, without a trailing click being logged as another pet.
  const beforeHold = (await pet.evaluate(() => window.petAPI.loadState())).moods.length;
  await pet.mouse.move(170, 225); await pet.mouse.down(); await pet.waitForTimeout(650); await pet.mouse.up();
  await pet.waitForTimeout(450);
  const afterHold = (await pet.evaluate(() => window.petAPI.loadState())).moods;
  assert.equal(afterHold.length, beforeHold + 1); assert.equal(afterHold.at(-1).action, 'nuzzle');
  const beforeStroke = afterHold.length;
  await pet.mouse.move(130, 225); await pet.mouse.down(); await pet.mouse.move(190, 225, { steps: 8 });
  await pet.waitForFunction(() => document.querySelector('.pet-stage').classList.contains('action-stroke'));
  await pet.mouse.up(); await pet.waitForTimeout(450);
  const afterStroke = (await pet.evaluate(() => window.petAPI.loadState())).moods;
  assert.equal(afterStroke.length, beforeStroke + 1); assert.equal(afterStroke.at(-1).action, 'pet');
  await pet.screenshot({ path: path.join(root, 'screenshots/pet-v03-round-shark.png'), omitBackground: true });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/pet.html')).webContents.send('pet:action', { action: 'reminder', message: '测试提醒优先显示' }));
  await pet.waitForTimeout(50);
  await pet.evaluate(() => window.petAPI.petAction('nuzzle'));
  await pet.waitForTimeout(50);
  assert.equal(await pet.locator('#speech-text').textContent(), '测试提醒优先显示');
  // Advance only the renderer clock. No artificial user records are created by idle behavior.
  const beforeIdle = (await pet.evaluate(() => window.petAPI.loadState())).moods.length;
  await pet.clock.fastForward(332000);
  assert.equal(await pet.locator('.pet-stage').getAttribute('data-behavior'), 'drowsy');
  await pet.clock.runFor(2200);
  assert.equal(await pet.locator('.pet-stage').getAttribute('data-behavior'), 'sleeping');
  await pet.clock.fastForward(95000);
  assert.equal(await pet.locator('.pet-stage').getAttribute('data-behavior'), 'waking');
  await pet.clock.runFor(1500);
  assert.equal(await pet.locator('.pet-stage').getAttribute('data-behavior'), 'awake');
  assert.equal((await pet.evaluate(() => window.petAPI.loadState())).moods.length, beforeIdle);
  assert.deepEqual(await bounds(), startBounds, 'all automatic and interaction motion stays inside the same desktop window');
  const savedMood = (await pet.evaluate(() => window.petAPI.loadState())).dailyMoods;
  assert.equal(savedMood.length, 1);
  assert.equal(savedMood[0].mood, 'good');
  const nextDay = new Date(savedMood[0].at); nextDay.setHours(24, 0, 1, 0);
  await pet.clock.setSystemTime(nextDay); await pet.clock.runFor(600);
  assert.equal(await pet.locator('.pet-stage').getAttribute('data-mood'), 'okay', 'a new local day resets the pet to the unselected middle mood');
  assert.deepEqual((await pet.evaluate(() => window.petAPI.loadState())).dailyMoods, savedMood, 'the midnight default must not create or change a daily choice');
  assert.deepEqual(errors, [], 'no renderer errors or CSP violations');
  console.log(JSON.stringify({ ok: true, checks: ['round SVG', 'independently tested daily mood profiles', 'daily choice cannot change and survives reload', 'varied dialogue', 'read-only wallet and feed rejection', 'gradual sleep', 'touch wake', 'hold nuzzle', 'drag stroke', 'reminder priority', 'automatic nap and waking', 'no fabricated records', 'unchanged window position', 'local midnight resets mood without locking next day'], isolatedData: [lowData, userData] }));
} finally { await app.close(); }
