// A disposable backstop for native Windows input checks. Input itself is sent
// by the computer-use tool; this fixture never injects OS mouse/key events.
import { createRequire } from 'node:module';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { _electron: electron } = createRequire(import.meta.url)('playwright-core');
export async function launchNativePetInputFixture() {
  const data = await mkdtemp(path.join(tmpdir(), 'tide-native-ui-'));
  const env = { ...process.env, TIDE_TEST_DATA: data }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'), args: [path.join(root, 'tests/launch-smoke.cjs')], env });
  await app.firstWindow();
  let pet;
  for (let i = 0; i < 100; i++) {
    pet = app.windows().find(w => w.url().endsWith('/pet.html'));
    if (pet) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await pet.waitForFunction(() => document.querySelector('.pet-stage').dataset.behavior === 'awake');
  await pet.evaluate(async () => {
    const state = await window.petAPI.loadState();
    Object.assign(state.settings, { autoHideFullscreen: false, notifications: false, reducedMotion: true });
    await window.petAPI.saveState(state);
  });
  await app.evaluate(async ({ BrowserWindow, screen }) => {
    const pet = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/pet.html'));
    for (const window of BrowserWindow.getAllWindows()) { window.hide(); window.webContents.setBackgroundThrottling(false); }
    const area = screen.getPrimaryDisplay().workArea;
    const under = new BrowserWindow({ x: area.x + 60, y: area.y + 60, width: 600, height: 520, frame: false, show: false, title: '潮汐 · 隔离鼠标检查', backgroundColor: '#e9f1f7', webPreferences: { sandbox: true } });
    await under.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<title>潮汐 · 隔离鼠标检查</title><body style="margin:0;background:#e9f1f7;font:20px sans-serif;color:#344754"><div style="position:absolute;left:28px;top:20px">透明区域点击检查</div><div style="position:absolute;left:28px;bottom:65px">下层收到点击：<b id="count">0</b></div><div style="position:absolute;left:28px;bottom:28px;font-size:14px">这是临时测试窗口，不包含健康记录。</div><script>window.clicks=[];document.addEventListener("click",e=>{clicks.push({x:e.clientX,y:e.clientY});document.getElementById("count").textContent=clicks.length})</script></body>'));
    under.show();
    pet.setBounds({x:area.x + 200,y:area.y + 140,width:320,height:370}); pet.setAlwaysOnTop(true); pet.showInactive();
    globalThis.__tideInputBackstop = under;
  });
  return { app, pet, data };
}
if (process.argv.includes('--native-ui')) {
  const fixture = await launchNativePetInputFixture();
  for (const page of fixture.app.windows()) {
    page.on('console', message => { if (message.text().startsWith('INPUT-CHECK')) console.log(message.text()); });
    await page.evaluate(() => document.addEventListener('click', event => console.log('INPUT-CHECK', document.title, event.clientX, event.clientY)));
  }
  await fixture.app.evaluate(({ BrowserWindow }) => {
    const pet = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/pet.html'));
    pet.on('move', () => pet.webContents.executeJavaScript(`console.log('INPUT-CHECK bounds',${JSON.stringify(pet.getBounds())})`));
  });
  console.log(JSON.stringify({ ready: true, data: fixture.data, message: 'Press Enter to close only these test windows.' }));
  let timeout;
  await new Promise(resolve => { timeout = setTimeout(resolve, 300000); process.stdin.resume(); process.stdin.once('data', resolve); });
  clearTimeout(timeout);
  console.log(JSON.stringify(await fixture.app.evaluate(({ BrowserWindow }) => {
    const pet = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/pet.html'));
    return { finalBounds: pet.getBounds(), cursor: require('electron').screen.getCursorScreenPoint() };
  })));
  await fixture.app.close();
}
