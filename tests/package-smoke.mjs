// Read-only packaged application smoke. No clinical records are added or changed.
import { _electron as electron } from 'playwright-core';
import path from 'node:path';
import { readFile, copyFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
const statePath=path.join(process.env.APPDATA,'小浪桌宠','state.json');
const before=JSON.parse(await readFile(statePath,'utf8'));
const version=JSON.parse(await readFile(path.resolve('package.json'),'utf8')).version;
const recovery=path.join(path.dirname(statePath),`state.before-release-${version}-${Date.now()}.json`);
await copyFile(statePath,recovery);
const app=await electron.launch({executablePath:path.resolve('dist/Tide-Companion-win32-x64/Tide-Companion.exe'),env,timeout:30000});
try {
  await app.firstWindow();
  let win;
  for(let i=0;i<100;i++){win=app.windows().find(w=>w.url().endsWith('/index.html'));if(win)break;await new Promise(r=>setTimeout(r,100));}
  assert.ok(win);
  await win.locator('h1').waitFor();
  const result=await app.evaluate(({app,BrowserWindow,shell})=>{
    const shortcut=app.getPath('appData')+'\\Microsoft\\Windows\\Start Menu\\Programs\\潮汐.lnk';
    return {packaged:app.isPackaged,windows:BrowserWindow.getAllWindows().length,shortcut:shell.readShortcutLink(shortcut),version:app.getVersion(),userData:app.getPath('userData')};
  });
  assert.equal(result.packaged,true);assert.equal(result.windows,2);assert.equal(result.shortcut.appUserModelId,'org.transpet.desktop');assert.equal(result.version,version);
  const iconDigest=createHash('sha256').update(await readFile(path.resolve('assets/app.ico'))).digest('hex').slice(0,12);
  const shellIcon=path.resolve(`dist/Tide-Companion-win32-x64/resources/tide-app-${iconDigest}.ico`);
  assert.equal(path.resolve(result.shortcut.icon),shellIcon);
  const after=await win.evaluate(()=>window.petAPI.loadState());
  for(const key of ['doses','labs','plans','modelConfigs','baselines','pkSettings','referenceBaselines'])assert.deepEqual(after[key],before[key],`retain actual ${key}`);
  for(const [key,value] of Object.entries(before.settings))assert.deepEqual(after.settings[key],value,`retain actual setting ${key}`);
  assert.equal(after.settings.onboardingCompleted,before.settings.onboardingCompleted??false);
  // Existing users can defer the new setup without marking it complete.
  if(await win.locator('.onboarding-modal[open]').count()){
    await win.keyboard.press('Escape');await win.locator('#modal').waitFor({state:'hidden'});
  }
  assert.equal(await win.locator('.hormone-card').count(),after.settings.mode==='ftm'&&!after.settings.showFtmEstradiol?1:2);
  if(after.settings.mode==='mtf'){assert.equal(await win.locator('.hormone-card.testosterone').count(),0);assert.equal(await win.locator('.hormone-card.cpa').count(),1);}
  // Reproduce the user's EV-sublingual failure using the bundled engine without
  // modifying or printing any personal dose, lab value or timestamp.
  const evRegression=await win.evaluate(async()=>{
    const {engineFor}=await import('./src/chart.js');
    const s=await window.petAPI.loadState(),model=engineFor(s),value=model.at().estradiol;
    const ev=s.doses.some(d=>d.routeId==='e2-ev-sublingual');
    return {hasEvSublingual:ev,finite:Number.isFinite(value.value),status:value.status,
      hasSupportedOnly:value.unsupportedMedications.length===0,calibrationN:value.calibration.n};
  });
  if(evRegression.hasEvSublingual&&evRegression.hasSupportedOnly){
    assert.equal(evRegression.finite,true,'existing EV-sublingual records must render a numeric E2 estimate');
    if(evRegression.calibrationN>0)assert.equal(evRegression.status,'calibrated');
    if(after.settings.mode!=='ftm'||after.settings.showFtmEstradiol)assert.doesNotMatch(await win.locator('.hormone-card.estradiol > strong').innerText(),/—/);
  }
  const pet=app.windows().find(w=>w.url().endsWith('/pet.html'));assert.ok(pet);await pet.locator('#builtin-pet svg').waitFor({state:'attached'});
  await win.screenshot({path:path.resolve('screenshots/packaged-dashboard.png'),fullPage:true});
  // getFileIcon may return a stale shell-cache image. Verify the executable's
  // actual Windows resource and extract WM_GETICON from the dashboard instead.
  const windowHandle=await app.evaluate(({BrowserWindow})=>{
    const handle=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/index.html')).getNativeWindowHandle();
    return handle.readBigUInt64LE().toString();
  });
  await promisify(execFile)('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.resolve('tests/native-icon-check.ps1'),'-WindowHandle',windowHandle,'-ExecutablePath',path.resolve('dist/Tide-Companion-win32-x64/Tide-Companion.exe'),'-IconResourcePath',shellIcon],{windowsHide:true});
  console.log(JSON.stringify({ok:true,healthHistoryPreserved:true,recovery,evRegression,...result}));
}finally{await app.close();}
