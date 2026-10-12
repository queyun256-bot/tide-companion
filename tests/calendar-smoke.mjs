// Real Electron UI, isolated synthetic records; can also run against an extracted installer ASAR.
import { _electron as electron } from 'playwright-core';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { localDateKey, dateFromKey } from '../src/journal.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const userData=await mkdtemp(path.join(tmpdir(),'tide-calendar-v060-'));
const env={...process.env,TIDE_TEST_DATA:userData};delete env.ELECTRON_RUN_AS_NODE;
const today=localDateKey(),previous=dateFromKey(today);previous.setDate(previous.getDate()-1);
const yesterday=localDateKey(previous), before=dateFromKey(yesterday);before.setDate(before.getDate()-1);
const dayBefore=localDateKey(before),checks=[],errors=[];
let app,win;
async function launch(){
  app=await electron.launch({executablePath:path.join(root,'node_modules/electron/dist/electron.exe'),args:[path.join(root,'tests/launch-smoke.cjs')],env,timeout:30000});
  for(let n=0;n<100;n++){win=app.windows().find(w=>w.url().endsWith('/index.html'));if(win)break;await new Promise(resolve=>setTimeout(resolve,100));}
  assert.ok(win);win.setDefaultTimeout(8000);await win.locator('h1').waitFor();
  win.on('pageerror',e=>errors.push(e.message));win.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await app.evaluate(({BrowserWindow})=>{for(const w of BrowserWindow.getAllWindows()){w.webContents.setBackgroundThrottling(false);w.hide();}});
}
const nav=async page=>{await win.locator(`.nav [data-page="${page}"]`).click();await win.locator(`[data-page-view="${page}"]`).waitFor();};
const chooseMonth=async month=>{
  const input=win.locator('#app [data-date-picker-input]');
  await input.fill(month);await input.press('Tab');
  // Manual input defers a queued redraw until blur's destination click has run.
  // Wait for the displayed month, not just the immediately updated native value.
  await win.waitForFunction(month=>document.querySelector('.journal-day:not(.outside-month)')?.dataset.id.startsWith(`${month}-`),month);
};
const choose=async date=>{
  await chooseMonth(date.slice(0,7));
  await win.locator(`[data-action="journal-day"][data-id="${date}"]`).click();
  await win.locator(`.daily-mood-panel[data-mood-date="${date}"]`).waitFor();
};
const disk=()=>readFile(path.join(userData,'state.json'),'utf8').then(JSON.parse);
async function close(){if(app){await app.close();app=null;win=null;}}
try{
  await launch();
  await win.evaluate(async dates=>{
    const s=await window.petAPI.loadState();
    s.settings.reducedMotion=true;s.settings.petVisible=false;s.settings.autoHideFullscreen=false;
    s.doses=[{id:'calendar-e2',routeId:'e2-ev-sublingual',amount:1,at:new Date(`${dates.yesterday}T09:10:00`).toISOString()},{id:'calendar-cpa',routeId:'cpa-oral',amount:12.5,at:new Date(`${dates.yesterday}T20:30:00`).toISOString()},{id:'other-day',routeId:'t-undecanoate-im',amount:1,at:new Date(`${dates.dayBefore}T12:00:00`).toISOString()}];
    s.labs=['estradiol','testosterone','cpa'].map((analyte,i)=>({id:`calendar-lab-${i}`,analyte,value:i+1,unit:analyte==='estradiol'?'pg/mL':analyte==='testosterone'?'ng/dL':'ng/mL',at:new Date(`${dates.yesterday}T08:00:00`).toISOString()}));
    s.plans=[{id:'not-a-dose',name:'仅提醒',routeId:'e2-oral',amount:1,intervalHours:24,startAt:new Date(`${dates.yesterday}T12:00:00`).toISOString(),enabled:false}];
    await window.petAPI.saveState(s);
  },{yesterday,dayBefore});
  await nav('calendar');
  assert.equal(await win.locator('.journal-day').count(),42);
  assert.equal(await win.locator('.daily-mood-panel').getAttribute('data-mood-recorded'),'false');
  assert.match(await win.locator('.mood-status').innerText(),/平平淡淡 · 默认/);
  assert.equal(await win.locator('.daily-mood-options button:enabled').count(),3);
  assert.equal((await disk()).dailyMoods.length,0);
  checks.push('default neutral is displayed without creating or locking a record');

  await choose(yesterday);
  assert.equal(await win.locator('[data-dose-id]').count(),2);
  assert.equal(await win.locator('[data-lab-id]').count(),3);
  assert.deepEqual(await win.locator('[data-dose-id]').evaluateAll(items=>items.map(el=>el.dataset.doseId)),['calendar-e2','calendar-cpa']);
  assert.match(await win.locator('.journal-detail').innerText(),/补佳乐/);
  assert.equal(await win.locator('.daily-mood-options button:enabled').count(),0);
  await win.locator('[data-action="journal-dose"]').click();
  assert.match(await win.locator('[name="at"]').inputValue(),new RegExp(`^${yesterday}T`));
  await win.keyboard.press('Escape');await win.locator('#modal').waitFor({state:'hidden'});
  await win.locator('[data-action="journal-lab"]').click();
  assert.match(await win.locator('[name="at"]').inputValue(),new RegExp(`^${yesterday}T`));
  await win.keyboard.press('Escape');await win.locator('#modal').waitFor({state:'hidden'});
  checks.push('selected local date lists all medications and all analytes, excludes reminder-only plans and prefills record dates');

  const sourceMonth=await win.locator('#journal-month').inputValue();
  await win.locator('[data-action="journal-previous"]').click();
  assert.notEqual(await win.locator('#journal-month').inputValue(),sourceMonth);
  await win.locator('[data-action="journal-next"]').click();
  assert.equal(await win.locator('#journal-month').inputValue(),sourceMonth);
  await chooseMonth('2024-02');
  assert.equal(await win.locator('[data-action="journal-day"][data-id^="2024-02"]').count(),29);
  await win.locator('[data-action="journal-today"]').click();
  await win.locator('[data-action="mood-okay"]').click();
  await win.waitForFunction(()=>document.querySelector('.daily-mood-panel')?.dataset.moodRecorded==='true');
  assert.equal(await win.locator('.daily-mood-options button:enabled').count(),0);
  assert.equal(await win.locator('[data-action="mood-okay"]').getAttribute('aria-pressed'),'true');
  await nav('overview');assert.equal(await win.locator('.daily-mood-options button:enabled').count(),0);
  const rejection=await win.evaluate(()=>window.petAPI.petAction('mood-low').then(()=>null,e=>e.message));
  assert.match(rejection,/今天的心情/);
  checks.push('month navigation and leap day work; explicit neutral locks immediately across overview/calendar and main-process API');

  await nav('calendar');await choose(yesterday);
  await win.evaluate(async()=>{const s=await window.petAPI.loadState();s.settings.reducedMotion=false;await window.petAPI.saveState(s);});
  await mkdir(path.join(root,'screenshots'),{recursive:true});
  for(const [mode,width,height] of [['mtf',1440,1040],['ftm',1440,1040],['ftm',860,620]]){
    await win.locator(`[data-action="mode-${mode}"]`).click();
    await app.evaluate(({BrowserWindow},size)=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/index.html')).setSize(...size),[width,height]);
    await win.waitForTimeout(120);
    assert.equal(await win.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`no horizontal overflow ${mode} ${width}`);
    const first=win.locator(`[data-action="journal-day"][data-id="${yesterday}"]`);await first.focus();
    await win.evaluate(()=>window.petAPI.petAction('nuzzle'));
    await win.waitForFunction(date=>document.activeElement?.dataset.id===date,yesterday);
    if(width===1440){
      await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/index.html')).showInactive());
      await win.screenshot({path:path.join(root,`screenshots/calendar-${mode}-v060.png`),animations:'disabled'});
      await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/index.html')).hide());
    }
    assert.equal(await win.locator('[data-dose-id]').count(),2);
    assert.equal(await win.locator('[data-lab-id]').count(),3);
  }
  checks.push('pink/blue themes preserve full records; 860×620 fits; broadcasts preserve selected day and keyboard focus');

  await win.evaluate(async date=>{const s=await window.petAPI.loadState();for(let i=0;i<205;i++)s.doses.push({id:`all-${i}`,routeId:'t-undecanoate-im',amount:1,at:new Date(`${date}T10:00:00`).toISOString()});await window.petAPI.saveState(s);},yesterday);
  assert.equal(await win.locator('[data-dose-id]').count(),207);
  checks.push('calendar keeps every record of a day rather than truncating to the latest 200');
  await close();await launch();
  assert.equal(await win.locator('.daily-mood-options button:enabled').count(),0);
  assert.equal((await disk()).dailyMoods.find(item=>item.date===today).mood,'okay');
  await nav('calendar');await choose(yesterday);assert.equal(await win.locator('[data-dose-id]').count(),207);
  checks.push('complete process restart preserves all day records and the daily choice lock');
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ok:true,checks,isolatedData:userData,installerPayload:!!process.env.TIDE_TEST_APP_ROOT}));
}finally{await close();}
