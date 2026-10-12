// Real hidden Win32 HWND and production drag IPC. Cursor coordinates and the
// visibility eligibility check are synthetic: this never moves the OS pointer,
// shows a window, or opens the user's records. The native size/position are real.
import { _electron as electron } from 'playwright-core';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appRoot = process.env.TIDE_TEST_APP_ROOT || root;
const scaleOption = process.argv.find(value => value.startsWith('--scale='));
const scale = scaleOption ? Number(scaleOption.slice(8)) : null;
if (scale !== null && (!Number.isFinite(scale) || scale < 1 || scale > 3)) throw new Error('Use --scale=1..3; OS display settings are never changed.');
const directory = await mkdtemp(path.join(tmpdir(), 'tide-drag-dpi-'));
const entry = path.join(directory, 'entry.cjs'), preload = path.join(directory, 'preload.cjs');
await writeFile(preload, `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('geometry',{
start:async(input,cursor)=>{await ipcRenderer.invoke('geometry:cursor',cursor);return ipcRenderer.invoke('pet:drag-start',input);},
move:async(input,cursor)=>{await ipcRenderer.invoke('geometry:cursor',cursor);return ipcRenderer.invoke('pet:drag-move',input);},
end:input=>ipcRenderer.invoke('pet:drag-end',input),bounds:()=>ipcRenderer.invoke('geometry:bounds')});`);
await writeFile(entry, `const {app,BrowserWindow,ipcMain,screen}=require('electron');
app.setPath('userData',${JSON.stringify(directory)});
const {setupPetDesktop,clampDragPosition}=require(${JSON.stringify(path.join(appRoot, 'electron/pet-desktop.cjs'))});
const {PET_WINDOW_SIZE,movePetWindow}=require(${JSON.stringify(path.join(appRoot, 'electron/pet-window.cjs'))});
app.whenReady().then(async()=>{
const area=screen.getPrimaryDisplay().workArea;
globalThis.testOrigin={x:area.x+Math.max(30,area.width-PET_WINDOW_SIZE.width-220),y:area.y+Math.max(30,area.height-PET_WINDOW_SIZE.height-220)};
globalThis.testWindow=new BrowserWindow({show:false,...PET_WINDOW_SIZE,...testOrigin,frame:false,transparent:true,resizable:false,hasShadow:false,skipTaskbar:true,alwaysOnTop:false,webPreferences:{preload:${JSON.stringify(preload)},contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
globalThis.geometryEvents={boundsWrites:0,moves:0,resizes:0};
testWindow.on('move',()=>geometryEvents.moves++);testWindow.on('resize',()=>geometryEvents.resizes++);
globalThis.testCursor={x:testOrigin.x+160,y:testOrigin.y+90};
const adapter={webContents:testWindow.webContents,isDestroyed:()=>testWindow.isDestroyed(),isVisible:()=>true,getBounds:()=>testWindow.getBounds(),setIgnoreMouseEvents:(...args)=>testWindow.setIgnoreMouseEvents(...args),setBounds(...args){geometryEvents.boundsWrites++;testWindow.setBounds(...args);}};
globalThis.testDesktop=setupPetDesktop({ipcMain,screen:{getCursorScreenPoint:()=>({...testCursor}),getDisplayNearestPoint:point=>screen.getDisplayNearestPoint(point)},getPet:()=>adapter,trustedSender:event=>event.sender===testWindow.webContents,broadcast(){}});
ipcMain.handle('geometry:cursor',(_event,cursor)=>{testCursor=cursor;return true;});ipcMain.handle('geometry:bounds',()=>testWindow.getBounds());
globalThis.resetGeometry=()=>{testDesktop.cancelDrag();movePetWindow(testWindow,testOrigin);return testWindow.getBounds();};
globalThis.runLegacy=points=>{resetGeometry();const initial=testWindow.getBounds(),offset={x:160,y:90},rows=[];for(const point of points){const cursor={x:testOrigin.x+offset.x+point.x,y:testOrigin.y+offset.y+point.y},before=testWindow.getBounds(),target=clampDragPosition(before,cursor,offset,screen.getDisplayNearestPoint(cursor).workArea);testWindow.setPosition(target.x,target.y,false);rows.push({direction:point.direction,cursor,target,before,after:testWindow.getBounds()});}return {initial,rows,last:testWindow.getBounds()};};
await testWindow.loadURL('data:text/html,<p>Isolated hidden HWND geometry regression</p>');});`);

function readNativeRect(handle) {
  if (process.platform !== 'win32') return null;
  assert.match(handle, /^\d+$/);
  const command = `Add-Type @'
using System;using System.Runtime.InteropServices;
[StructLayout(LayoutKind.Sequential)]public struct TideGeometryRect{public int Left,Top,Right,Bottom;}
public static class TideGeometryProbe{
[DllImport("user32.dll")]public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
[DllImport("user32.dll")]public static extern bool GetWindowRect(IntPtr hwnd,out TideGeometryRect rect);}
'@
[void][TideGeometryProbe]::SetThreadDpiAwarenessContext([IntPtr](-4))
$rect=New-Object TideGeometryRect
if(-not [TideGeometryProbe]::GetWindowRect([IntPtr]${handle},[ref]$rect)){throw 'Cannot read isolated test HWND'}
@{x=$rect.Left;y=$rect.Top;width=$rect.Right-$rect.Left;height=$rect.Bottom-$rect.Top}|ConvertTo-Json -Compress`;
  return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true }));
}
const points = []; let x = 0, y = 0;
for (let round = 0; round < 6; round++) for (const [direction, dx, dy] of [['right', 1, 0], ['down', 0, 1], ['left', -1, 0], ['up', 0, -1]]) {
  for (let step = 0; step < 25; step++) { x += dx; y += dy; points.push({ direction, x, y }); }
}
assert.equal(points.length, 600);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const args = [...(scale === null ? [] : [`--force-device-scale-factor=${scale}`]), entry];
const app = await electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'), args, env, timeout: 30000 });
try {
  const page = await app.firstWindow(); await page.waitForLoadState();
  const info = await app.evaluate(({ screen }) => ({ version: process.versions.electron, shown: testWindow.isVisible(), alwaysOnTop: testWindow.isAlwaysOnTop(), handle: testWindow.getNativeWindowHandle().readBigUInt64LE().toString(), origin: testOrigin, displays: screen.getAllDisplays().map(d => ({ id: d.id, scaleFactor: d.scaleFactor, bounds: d.bounds, workArea: d.workArea })) }));
  assert.equal(info.shown, false); assert.equal(info.alwaysOnTop, false);
  const legacy = await app.evaluate((_electron, input) => runLegacy(input), points);
  const legacyNative = readNativeRect(info.handle);
  const growth = { width: legacy.last.width - legacy.initial.width, height: legacy.last.height - legacy.initial.height };
  const rejectedDirections = Object.fromEntries(['right', 'down'].map(direction => [direction, legacy.rows.filter(row => row.direction === direction && (direction === 'right' ? row.after.x <= row.before.x : row.after.y <= row.before.y)).length]));
  if (process.platform === 'win32' && info.displays[0].scaleFactor === 1.75) {
    assert.ok(growth.width > 100 && growth.height > 100, 'the 175% legacy control must expose cumulative size inflation');
    assert.ok(rejectedDirections.right > 0 && rejectedDirections.down > 0, 'the inflated dimensions progressively block right and down movement');
  }
  const initial = await app.evaluate(() => resetGeometry());
  const fixedNativeBefore = readNativeRect(info.handle);
  const fixed = await page.evaluate(async ({ origin, points }) => {
    const cursor = point => ({ x: origin.x + 160 + point.x, y: origin.y + 90 + point.y });
    const session = await geometry.start({ pointerId: 1, requestId: 1, buttons: 1 }, cursor({ x: 0, y: 0 }));
    const rows = []; let sequence = 0;
    for (const point of points) {
      const before = await geometry.bounds();
      const ok = await geometry.move({ ...session, pointerId: 1, buttons: 1, sequence: ++sequence }, cursor(point));
      if (!ok) throw new Error(`production drag ended at movement ${sequence}`);
      rows.push({ direction: point.direction, point, before, after: await geometry.bounds() });
    }
    await geometry.end(session);
    return { rows, last: await geometry.bounds() };
  }, { origin: info.origin, points });
  for (const [index, row] of fixed.rows.entries()) {
    assert.equal(row.after.x, info.origin.x + row.point.x, `x at input ${index}`);
    assert.equal(row.after.y, info.origin.y + row.point.y, `y at input ${index}`);
    assert.ok(Math.abs(row.after.width - 320) <= 2 && Math.abs(row.after.height - 370) <= 2, `no cumulative native size growth at input ${index}`);
  }
  const fixedNativeAfter = readNativeRect(info.handle);
  if (fixedNativeBefore) assert.deepEqual(fixedNativeAfter, fixedNativeBefore, 'closed four-direction tour returns the HWND to the same physical rectangle');

  const restart = await page.evaluate(async () => {
    const rows = [];
    for (let n = 0; n < 40; n++) {
      const before = await geometry.bounds(), cursor = { x: before.x + 160, y: before.y + 90 };
      const session = await geometry.start({ pointerId: 1, requestId: n + 2, buttons: 1 }, cursor);
      const dx = n % 2 ? -1 : 1, dy = n % 2 ? 1 : -1;
      const ok = await geometry.move({ ...session, pointerId: 1, buttons: 1, sequence: 1 }, { x: cursor.x + dx, y: cursor.y + dy });
      if (!ok) throw new Error('restart movement rejected');
      await geometry.end(session); rows.push({ before, after: await geometry.bounds(), dx, dy });
    }
    return rows;
  });
  for (const row of restart) {
    assert.equal(row.after.x, row.before.x + row.dx); assert.equal(row.after.y, row.before.y + row.dy);
    assert.ok(Math.abs(row.after.width - 320) <= 2 && Math.abs(row.after.height - 370) <= 2, 'new sessions never learn an already rounded size');
  }
  const noFeedback = await app.evaluate(async () => {
    const before = { ...geometryEvents }, bounds = testWindow.getBounds();
    await new Promise(resolve => setTimeout(resolve, 350));
    return { before, after: { ...geometryEvents }, bounds, final: testWindow.getBounds() };
  });
  assert.deepEqual(noFeedback.after, noFeedback.before, 'ending input cannot trigger recursive native movement');
  assert.deepEqual(noFeedback.final, noFeedback.bounds);
  const trace = path.join(directory, 'drag-dpi-trace.json');
  await writeFile(trace, JSON.stringify({ info, legacy, legacyNative, growth, rejectedDirections, initial, fixed, fixedNativeBefore, fixedNativeAfter, restart, noFeedback }, null, 2));
  console.log(JSON.stringify({ ok: true, checks: ['legacy position-only native size growth and direction loss control', '600 production IPC movements in all four directions', '40 release/restart sessions keep canonical size', 'native physical rectangle roundtrip and no post-input feedback'], scale: info.displays.map(d => d.scaleFactor), syntheticCursor: true, hidden: !info.shown, legacyGrowth: growth, rejectedDirections, fixedSizeRange: { width: [Math.min(...fixed.rows.map(row => row.after.width)), Math.max(...fixed.rows.map(row => row.after.width))], height: [Math.min(...fixed.rows.map(row => row.after.height)), Math.max(...fixed.rows.map(row => row.after.height))] }, trace }));
} finally { await app.close(); }
