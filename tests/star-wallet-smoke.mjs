// Real main-process rewards from emitted synthetic reminders in isolated app data.
import { _electron as electron } from 'playwright-core';
import { mkdtemp,readFile,rename,mkdir,rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const userData=await mkdtemp(path.join(tmpdir(),'tide-star-wallet-v080-'));
const env={...process.env,TIDE_TEST_DATA:userData};delete env.ELECTRON_RUN_AS_NODE;
const checks=[],errors=[];let app,win;
const disk=()=>readFile(path.join(userData,'state.json'),'utf8').then(JSON.parse);
const total=state=>state.starWallet.entries.reduce((sum,entry)=>sum+entry.amount,0);
async function launch(){
  app=await electron.launch({executablePath:path.join(root,'node_modules/electron/dist/electron.exe'),args:[path.join(root,'tests/launch-smoke.cjs')],env,timeout:30000});
  for(let n=0;n<100;n++){win=app.windows().find(w=>w.url().endsWith('/index.html'));if(win)break;await new Promise(resolve=>setTimeout(resolve,100));}
  assert.ok(win);win.setDefaultTimeout(8000);await win.locator('h1').waitFor();win.on('pageerror',error=>errors.push(error.message));
  await app.evaluate(({BrowserWindow})=>{for(const w of BrowserWindow.getAllWindows()){w.webContents.setBackgroundThrottling(false);w.hide();}});
}
async function close(){if(app){await app.close();app=null;win=null;}}
// Match the real form's minute precision; renderer/main millisecond clocks can
// differ slightly, which must not turn this synthetic record into a future dose.
const addDose=async(id,planId,overrides={})=>win.evaluate(async({id,planId,overrides})=>{const state=await window.petAPI.loadState(),plan=state.plans.find(item=>item.id===planId);state.doses.push({id,planId,routeId:plan.routeId,amount:plan.amount,at:new Date(Math.floor(Date.now()/60000)*60000).toISOString(),...overrides});return window.petAPI.saveState(state);},{id,planId,overrides});
try{
  await launch();
  await win.evaluate(async()=>{const s=await window.petAPI.loadState();s.settings.notifications=false;s.settings.petVisible=false;s.settings.autoHideFullscreen=false;s.settings.reducedMotion=true;await window.petAPI.saveState(s);});
  assert.equal(total(await disk()),0);
  const feed=await win.evaluate(()=>window.petAPI.petAction('feed').then(()=>'',error=>error.message));assert.match(feed,/自动获得/);
  await win.evaluate(()=>window.petAPI.notifyTest());assert.equal((await disk()).reminderLog.length,0);assert.equal(total(await disk()),0);
  checks.push('fresh wallet starts empty; manual feed is rejected; test notifications create no eligible receipt');

  await win.evaluate(async()=>{const s=await window.petAPI.loadState();s.plans=[['regular-a',24,1],['regular-b',24,2],['regular-c',24,3],['weekly',168,4],['snapshot',72,5],['failure',100,8]].map(([id,intervalHours,amount])=>({id,name:`合成测试 ${id}`,routeId:'e2-oral',amount,intervalHours,startAt:new Date(Date.now()-60000).toISOString(),enabled:true}));await window.petAPI.saveState(s);});
  const reminded=await disk();assert.equal(reminded.reminderLog.length,6);assert.equal(total(reminded),0);
  assert.ok(reminded.reminderLog.every(r=>r.status==='notified'&&r.routeId==='e2-oral'&&Number.isFinite(r.intervalHours)&&r.amount>0));
  checks.push('production reminderTick persists six genuine notified occurrences with immutable prescription snapshots, without creating doses or currency');

  await win.locator('[data-page="plans"]').click();await win.locator('[data-action="dose"][data-id="regular-a"]').click();
  await win.locator('#dialog-form button[type="submit"]').click();await win.locator('#modal').waitFor({state:'hidden'});
  assert.equal(total(await disk()),1);
  assert.equal((await disk()).starWallet.entries[0].planId,'regular-a');
  await addDose('regular-b-dose','regular-b');await addDose('regular-c-dose','regular-c');
  const regular=await disk();assert.equal(regular.doses.length,3);assert.equal(total(regular),2);assert.equal(regular.starWallet.entries.length,2);
  checks.push('a real reminder Record button plus form confirmation earns one star; three regular confirmations persist all clinical records but stop at two stars');

  await addDose('weekly-dose','weekly');assert.equal(total(await disk()),9);
  await win.evaluate(async()=>{const s=await window.petAPI.loadState(),plan=s.plans.find(p=>p.id==='snapshot');plan.routeId='cpa-oral';plan.amount=99;plan.intervalHours=8760;await window.petAPI.saveState(s);});
  await addDose('snapshot-dose','snapshot',{routeId:'e2-oral',amount:5});
  const snap=await disk();assert.equal(total(snap),12);assert.equal(snap.starWallet.entries.find(e=>e.doseId==='snapshot-dose').amount,3);
  checks.push('weekly reminder adds seven outside the regular cap; editing an emitted plan cannot inflate its frozen three-star reward');

  const first=regular.doses.find(d=>d.planId==='regular-a');
  await win.evaluate(async()=>{const s=await window.petAPI.loadState();s.doses=s.doses.filter(d=>d.planId!=='regular-a');s.starWallet={version:1,entries:[]};s.plans.push({id:'copy-plan',name:'合成副本',routeId:'e2-oral',amount:1,intervalHours:168,startAt:new Date(Date.now()-5*60000).toISOString(),enabled:true});await window.petAPI.saveState(s);});
  await addDose('changed-id-copy','copy-plan',{at:first.at});
  assert.equal(total(await disk()),12);
  await addDose('same-occurrence-copy','weekly');assert.equal(total(await disk()),12);
  checks.push('deleting records or submitting an empty wallet never removes earned currency; changed IDs/plans and duplicate occurrences cannot reward the same actual use twice');

  // Deliberately make only this isolated state path unwritable without changing permissions.
  const statePath=path.join(userData,'state.json'),preserved=path.join(userData,'state.test-preserved.json');
  assert.equal(path.dirname(statePath),userData);assert.match(path.basename(userData),/^tide-star-wallet-v080-/);
  await rename(statePath,preserved);await mkdir(statePath);
  let rejection;
  try{rejection=await addDose('failure-dose','failure').then(()=>'',error=>error.message);}finally{await rmdir(statePath);await rename(preserved,statePath);}
  assert.ok(rejection);assert.equal(total(await disk()),12);
  const liveAfterFailure=await win.evaluate(()=>window.petAPI.loadState());assert.equal(total(liveAfterFailure),12);assert.equal(liveAfterFailure.doses.some(d=>d.id==='failure-dose'),false);
  await addDose('failure-dose','failure');assert.equal(total(await disk()),16);
  checks.push('real atomic storage failure saves neither dose nor stars; restoring the isolated file path permits exactly one four-star retry');

  await close();await launch();
  assert.equal(total(await disk()),16);assert.equal(total(await win.evaluate(()=>window.petAPI.loadState())),16);
  await addDose('restart-duplicate','failure');assert.equal(total(await disk()),16);
  checks.push('complete process restart restores the persistent balance and receipt deduplication');

  await win.evaluate(async()=>{const s=await window.petAPI.loadState();s.plans.push({id:'recovery',name:'合成恢复提醒',routeId:'e2-oral',amount:9,intervalHours:48,startAt:new Date(Date.now()-20*60000).toISOString(),enabled:true});await window.petAPI.saveState(s);});
  assert.equal((await disk()).reminderLog.find(r=>r.planId==='recovery').status,'missed');
  await addDose('recovery-dose','recovery');assert.equal(total(await disk()),18);
  await close();await launch();assert.equal(total(await disk()),18);
  await addDose('recovery-duplicate','recovery');assert.equal(total(await disk()),18);
  assert.deepEqual(errors,[]);
  checks.push('a real 20-minute recovery notification earns its two-star reward and remains deduplicated after a complete restart');
  console.log(JSON.stringify({ok:true,checks,balance:18,isolatedData:userData,installerPayload:!!process.env.TIDE_TEST_APP_ROOT}));
}finally{await close();}
