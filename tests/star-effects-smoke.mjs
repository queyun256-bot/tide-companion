import {_electron as electron} from 'playwright-core';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(import.meta.url),{defaultState}=require('../electron/state.cjs');
const checks=[],dirs=[];
await mkdir(path.join(root,'screenshots'),{recursive:true});
for(const balance of [0,1,3,7,15,30,60,100]){
  const directory=await mkdtemp(path.join(tmpdir(),`tide-star-tier-${balance}-`));dirs.push(directory);
  const initial=defaultState();initial.settings.onboardingCompleted=true;initial.settings.notifications=false;initial.settings.activeSkin='builtin-lilac';
  const base=Date.now()-100*86400000;
  initial.starWallet={version:1,entries:Array.from({length:balance},(_,index)=>{
    const time=base-Math.floor(index/2)*86400000-index%2*60000,at=new Date(time).toISOString(),day=new Date(time);
    const planId=`fixture${index}`,dayKey=`${day.getFullYear()}-${String(day.getMonth()+1).padStart(2,'0')}-${String(day.getDate()).padStart(2,'0')}`;
    return{id:`${planId}@${at}`,planId,doseId:`historic${index}`,scheduledAt:at,earnedAt:at,doseAt:at,day:dayKey,kind:'regular',amount:1,intervalHours:24,routeId:'e2-oral',doseAmount:index+1};
  })};
  await writeFile(path.join(directory,'state.json'),JSON.stringify(initial));
  const env={...process.env,TIDE_TEST_DATA:directory};delete env.ELECTRON_RUN_AS_NODE;
  const app=await electron.launch({executablePath:path.join(root,'node_modules/electron/dist/electron.exe'),args:[path.join(root,'tests/launch-smoke.cjs')],env,timeout:30000});
  try{
    await app.firstWindow();let pet;
    for(let i=0;i<100;i++){pet=app.windows().find(page=>page.url().endsWith('/pet.html'));if(pet)break;await new Promise(resolve=>setTimeout(resolve,50));}
    assert.ok(pet);
    await app.evaluate(({BrowserWindow})=>{for(const win of BrowserWindow.getAllWindows()){win.webContents.setBackgroundThrottling(false);if(win.webContents.getURL().endsWith('/index.html'))win.hide();}});
    await pet.waitForFunction(expected=>document.querySelector('.star-lights')?.dataset.count===String(expected),balance);
    await pet.waitForFunction(()=>document.querySelector('.pet-stage').dataset.variant==='builtin-lilac');
    assert.equal(await pet.locator('.star-lights').evaluate(el=>el.classList.contains('is-star-celebrating')),false,'restored balances do not celebrate');
    await pet.waitForTimeout(500);
    await pet.screenshot({path:path.join(root,`screenshots/star-tier-${balance}-v080.png`),omitBackground:true});
    if(balance===100){await pet.evaluate(()=>document.body.style.background='#fbf8fa');await pet.screenshot({path:path.join(root,'screenshots/star-tier-100-light-v080.png')});await pet.evaluate(()=>document.body.style.background='transparent');}
    assert.equal(Number(await pet.locator('.star-lights').getAttribute('data-star-tier')),balance);
    assert.ok(await pet.locator('[data-star-motion]').count()<=30);
    await pet.locator('#wallet-pet').evaluate(el=>el.click());
    assert.match(await pet.locator('#speech-text').textContent(),new RegExp(`${balance} 颗星星`));
    assert.equal((await pet.evaluate(()=>window.petAPI.loadState())).moods.length,0);
    if(balance===100){
      const error=await pet.evaluate(()=>window.petAPI.petAction('feed').then(()=>'',error=>error.message));assert.ok(error);
      await pet.evaluate(async()=>{const s=await window.petAPI.loadState();s.starWallet={version:1,entries:[]};await window.petAPI.saveState(s);});
      assert.equal(await pet.locator('.star-lights').getAttribute('data-count'),'100','stale or forged UI wallet cannot erase main-process balance');
      await pet.evaluate(async()=>{const s=await window.petAPI.loadState();s.settings.reducedMotion=true;await window.petAPI.saveState(s);});
      await pet.waitForFunction(()=>document.documentElement.classList.contains('reduced-motion'));
      assert.equal(await pet.locator('.star-point').first().evaluate(el=>getComputedStyle(el).animationName),'none');
      assert.ok(Number(await pet.locator('.star-point').first().evaluate(el=>getComputedStyle(el).opacity))>.7);
      assert.equal(await pet.locator('.star-lights').isVisible(),true,'reduced motion keeps accumulated static light');
      const before=await pet.locator('.star-lights').screenshot();await pet.waitForTimeout(700);
      assert.ok(before.equals(await pet.locator('.star-lights').screenshot()));
      checks.push('readonly balance, feed rejection, renderer cannot overwrite wallet, static reduced motion');
      await pet.evaluate(()=>window.petAPI.petAction('sleep'));
      await pet.waitForFunction(()=>document.querySelector('.pet-stage').dataset.behavior==='sleeping');
      await pet.evaluate(async()=>{const s=await window.petAPI.loadState();s.plans.push({id:'weekly-reward',name:'隔离测试计划',routeId:'e2-ev-im',amount:2,intervalHours:168,startAt:new Date(Date.now()-60000).toISOString(),enabled:true});await window.petAPI.saveState(s);});
      await pet.waitForFunction(async()=>(await window.petAPI.loadState()).reminderLog.some(item=>item.planId==='weekly-reward'&&item.status==='notified'));
      await pet.evaluate(async()=>{const s=await window.petAPI.loadState();s.doses.push({id:'earned-now',planId:'weekly-reward',routeId:'e2-ev-im',amount:2,at:new Date().toISOString()});await window.petAPI.saveState(s);});
      await pet.waitForFunction(()=>document.querySelector('.star-lights').dataset.count==='107');
      await pet.waitForFunction(()=>document.querySelector('.star-lights').classList.contains('is-star-celebrating'));
      assert.equal(await pet.locator('.pet-stage').getAttribute('data-behavior'),'sleeping','a real persisted reward does not wake the pet');
      checks.push('real scheduled dose earns seven persisted stars and celebrates without waking a nap');
    }
  }finally{await app.close();}
}
checks.push('all eight persisted balances render bounded distinct tiers without startup celebration','wallet control never creates a record');
console.log(JSON.stringify({ok:true,checks,isolatedData:dirs}));
