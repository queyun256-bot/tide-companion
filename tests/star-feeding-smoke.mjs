// Isolated real Electron windows, renderer drag handlers and persisted main
// transactions. DataTransfer/DragEvent are synthetic: no OS input is injected.
import {_electron as electron} from 'playwright-core';
import {mkdtemp,writeFile,readFile,rename,mkdir,rmdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url),root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const appRoot=process.env.TIDE_TEST_APP_ROOT || root;
const userData=await mkdtemp(path.join(tmpdir(),'tide-star-feeding-'));
const env={...process.env,TIDE_TEST_DATA:userData};delete env.ELECTRON_RUN_AS_NODE;
const state=require(path.join(root,'electron/state.cjs')).defaultState();
const {localDay}=require(path.join(root,'electron/star-wallet.cjs'));
const earned=Date.now()-10000,scheduledAt=new Date(earned-1000).toISOString(),earnedAt=new Date(earned).toISOString();
state.settings.onboardingCompleted=true;state.settings.reducedMotion=true;state.settings.notifications=false;state.settings.autoHideFullscreen=false;
state.starWallet.entries=[{id:`feed-fixture@${scheduledAt}`,doseId:'fixture-dose',planId:'feed-fixture',scheduledAt,earnedAt,doseAt:earnedAt,day:localDay(earned),kind:'long',amount:7,intervalHours:168,routeId:'e2-oral',doseAmount:2}];
await writeFile(path.join(userData,'state.json'),JSON.stringify(state));
const disk=()=>readFile(path.join(userData,'state.json'),'utf8').then(JSON.parse);
const balance=s=>s.starWallet.entries.reduce((sum,e)=>sum+e.amount,0),feeds=s=>s.starWallet.entries.filter(e=>e.kind==='feed').length;
let app,win,pet;const passed=[],errors=[];
async function launch(){
  app=await electron.launch({executablePath:path.join(root,'node_modules/electron/dist/electron.exe'),args:[path.join(root,'tests/launch-smoke.cjs')],env,timeout:30000});
  for(let n=0;n<100;n++){win=app.windows().find(w=>w.url().endsWith('/index.html'));pet=app.windows().find(w=>w.url().endsWith('/pet.html'));if(win&&pet)break;await new Promise(resolve=>setTimeout(resolve,100));}
  assert.ok(win&&pet);win.setDefaultTimeout(8000);pet.setDefaultTimeout(8000);
  for(const page of [win,pet])page.on('pageerror',error=>errors.push(error.message));
  await win.locator('h1').waitFor();await pet.waitForFunction(()=>document.querySelector('.pet-stage')?.dataset.behavior==='awake');
  await app.evaluate(({BrowserWindow,screen})=>{
    const cursor=screen.getCursorScreenPoint(),area=screen.getPrimaryDisplay().workArea;
    for(const window of BrowserWindow.getAllWindows()){
      window.webContents.setBackgroundThrottling(false);window.showInactive();
      if(window.webContents.getURL().endsWith('/pet.html'))window.setBounds({x:area.x+(cursor.x<area.x+area.width/2?area.width-380:60),y:area.y+60,width:320,height:370});
    }
  });
  await win.locator('[data-page="settings"]').click();await win.locator('[data-star-feed-source]').waitFor();
  await win.locator('.wallet-pet-preview').scrollIntoViewIfNeeded();
  await win.waitForFunction(()=>document.querySelector('.wallet-pet-preview')?.shadowRoot?.querySelector('.round-body'));
}
async function start(){
  const token=await win.evaluate(()=>{
    const source=document.querySelector('[data-star-feed-source]'),transfer=new DataTransfer();globalThis.__feedTransfer=transfer;
    source.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:transfer}));return transfer.getData('application/x-tide-star-feed');
  });
  assert.match(token,/^[a-f0-9-]{36}$/);
  await pet.waitForFunction(()=>document.querySelector('.pet-stage').classList.contains('is-star-feed-drag'));
  return token;
}
async function finishSource(effect){await win.evaluate(effect=>{
  // A synthetic DataTransfer has no OS drag manager to copy the target's final
  // effect back to its source. Supply only that native dragend metadata here.
  if(effect)Object.defineProperty(globalThis.__feedTransfer,'dropEffect',{value:effect,configurable:true});
  document.dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer:globalThis.__feedTransfer}));
},effect);}
async function dropPreview(token){
  return win.evaluate(token=>{
    const target=document.querySelector('.wallet-pet-preview'),svg=target.shadowRoot.querySelector('.shark');
    const point=new DOMPoint(200,160).matrixTransform(svg.getScreenCTM()),transfer=globalThis.__feedTransfer||new DataTransfer();transfer.setData('application/x-tide-star-feed',token);
    const over=new DragEvent('dragover',{bubbles:true,cancelable:true,clientX:point.x,clientY:point.y,dataTransfer:transfer});target.dispatchEvent(over);
    const hover=target.classList.contains('is-star-feed-hover');
    target.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,clientX:point.x,clientY:point.y,dataTransfer:transfer}));return {accepted:over.defaultPrevented,hover};
  },token);
}
async function dropDesktop(token,point={x:160,y:170}){
  return pet.evaluate(({token,point})=>{
    const transfer=new DataTransfer();transfer.setData('application/x-tide-star-feed',token);const target=document.querySelector('.pet-stage');
    const over=new DragEvent('dragover',{bubbles:true,cancelable:true,clientX:point.x,clientY:point.y,dataTransfer:transfer});target.dispatchEvent(over);
    target.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,clientX:point.x,clientY:point.y,dataTransfer:transfer}));return {accepted:over.defaultPrevented,dropEffect:transfer.dropEffect};
  },{token,point});
}
async function waitFeeds(count){
  const deadline=Date.now()+8000;
  while(Date.now()<deadline){if(feeds(await disk())===count)return;await new Promise(resolve=>setTimeout(resolve,30));}
  assert.equal(feeds(await disk()),count,'persisted feed transaction did not arrive');
}
if(process.argv.includes('--native-ui')){
  try{
    await launch();
    await app.evaluate(({BrowserWindow,screen})=>{
      const area=screen.getPrimaryDisplay().workArea;
      for(const window of BrowserWindow.getAllWindows()){
        if(window.webContents.getURL().endsWith('/pet.html'))window.hide();
        else {window.setBounds({x:area.x+40,y:area.y+40,width:1020,height:820});window.setAlwaysOnTop(true,'screen-saver');window.show();window.focus();}
      }
    });
    await win.locator('.wallet-pet-preview').scrollIntoViewIfNeeded();
    const points=await win.evaluate(()=>{
      const source=document.querySelector('[data-star-feed-source]').getBoundingClientRect(),svg=document.querySelector('.wallet-pet-preview').shadowRoot.querySelector('.shark');
      const destination=new DOMPoint(200,160).matrixTransform(svg.getScreenCTM());return {source:{x:source.left+source.width/2,y:source.top+source.height/2},destination:{x:destination.x,y:destination.y}};
    });
    const native=await app.evaluate(({BrowserWindow,screen},points)=>{
      const window=BrowserWindow.getAllWindows().find(window=>window.webContents.getURL().endsWith('/index.html')),bounds=window.getContentBounds();
      const physical=point=>screen.dipToScreenPoint({x:Math.round(bounds.x+point.x),y:Math.round(bounds.y+point.y)});
      return {hwnd:Number(window.getNativeWindowHandle().readBigUInt64LE()),contentBounds:bounds,source:physical(points.source),destination:physical(points.destination)};
    },points);
    console.log(JSON.stringify({ready:true,mode:'native-ui',userData,native,cssPoints:points,timeoutSeconds:120,notes:'No synthetic drag dispatched. Waiting for real Windows drag from source star to companion.'}));
    const deadline=Date.now()+120000;
    while(Date.now()<deadline && feeds(await disk())===0)await new Promise(resolve=>setTimeout(resolve,150));
    const stored=await disk();
    if(feeds(stored)>0){
      await win.waitForTimeout(1500);const screenshot=path.join(userData,'native-fed.png');await win.screenshot({path:screenshot});
      console.log(JSON.stringify({ok:true,nativeInput:true,feedCount:feeds(stored),balance:balance(stored),growth:(await win.evaluate(()=>window.petAPI.loadState())).petGrowth,screenshot,userData}));
    }else console.log(JSON.stringify({ok:false,reason:'No real feed before 120-second timeout; native path remains unverified',userData}));
  }finally{if(app)await app.close();}
  process.exit(0);
}
try{
  await launch();assert.equal(balance(await disk()),7);
  const token=await start();assert.deepEqual(await dropPreview(token),{accepted:true,hover:true});await finishSource();await waitFeeds(1);
  assert.equal(balance(await disk()),6);assert.equal((await win.evaluate(()=>window.petAPI.loadState())).petGrowth.experience,1);
  await win.waitForFunction(()=>!document.documentElement.classList.contains('has-star-feed-drag'));
  passed.push('journal source → real ShadowDOM preview consumes one star and adds one persisted XP');

  const cancelled=await start();assert.deepEqual(await dropDesktop(cancelled,{x:20,y:80}),{accepted:false,dropEffect:'none'});await finishSource();
  await pet.waitForFunction(()=>!document.querySelector('.pet-stage').classList.contains('is-star-feed-drag'));assert.equal(balance(await disk()),6);assert.equal(feeds(await disk()),1);
  passed.push('transparent pet rectangle rejects a drop; dragend cancels without spending');

  const desktop=await start();assert.equal((await dropDesktop(desktop)).accepted,true);await finishSource('move');await waitFeeds(2);
  assert.equal(balance(await disk()),5);await pet.waitForFunction(()=>!document.querySelector('.pet-stage').classList.contains('is-star-feed-drag'));
  const duplicate=await pet.evaluate(token=>window.petAPI.commitStarFeed({token}),desktop);assert.equal(duplicate.duplicate,true);assert.equal(balance(await disk()),5);
  passed.push('cross-renderer token/drop reaches real desktop IPC; repeated token is idempotent');

  const wrong=await start();assert.equal((await dropDesktop('00000000-0000-0000-0000-000000000000')).accepted,true);await finishSource();
  await pet.waitForFunction(()=>!document.querySelector('.pet-stage').classList.contains('is-star-feed-drag'));assert.equal(balance(await disk()),5);
  await win.evaluate(async()=>{const state=await window.petAPI.loadState();state.settings.petVisible=false;await window.petAPI.saveState(state);});
  const hidden=await start();const rejected=await pet.evaluate(token=>window.petAPI.commitStarFeed({token}).then(()=>'',error=>error.message),hidden);assert.match(rejected,/画面/);await finishSource();assert.equal(balance(await disk()),5);
  await win.evaluate(async()=>{const state=await window.petAPI.loadState();state.settings.petVisible=true;await window.petAPI.saveState(state);});
  passed.push('foreign token and hidden desktop cannot spend; hidden pet is never shown by drag');

  const failure=await start(),statePath=path.join(userData,'state.json'),preserved=path.join(userData,'state.preserved.json');
  assert.match(path.basename(userData),/^tide-star-feeding-/);await rename(statePath,preserved);await mkdir(statePath);
  try{assert.deepEqual(await dropPreview(failure),{accepted:true,hover:true});await win.waitForFunction(()=>document.getElementById('star-feed-status')?.textContent.includes('稍后再试试'));}
  finally{await rmdir(statePath);await rename(preserved,statePath);}
  await finishSource();assert.equal(balance(await disk()),5);assert.equal(feeds(await disk()),2);
  passed.push('real atomic file failure keeps stars and XP unchanged and reports a retryable failure');

  await win.evaluate(()=>window.petAPI.selectSkin('builtin-rose'));const rose=await start();await dropPreview(rose);await finishSource();await waitFeeds(3);
  await win.evaluate(()=>window.petAPI.selectSkin('builtin-mint'));const mint=await start();await dropPreview(mint);await finishSource();await waitFeeds(4);
  assert.equal((await win.evaluate(()=>window.petAPI.loadState())).petGrowth.experience,4);
  await app.close();app=null;await launch();assert.equal(balance(await disk()),3);assert.equal(feeds(await disk()),4);assert.equal((await win.evaluate(()=>window.petAPI.loadState())).petGrowth.experience,4);
  passed.push('different shark skins share XP and wallet; complete restart preserves both');
  for(const page of [win,pet])await page.evaluate(()=>{globalThis.__feedEvents=[];window.petAPI.onStarFeedSession(event=>__feedEvents.push(event));});
  const delayed=await start();
  await pet.evaluate(()=>document.addEventListener('drop',event=>{
    const token=event.dataTransfer.getData('application/x-tide-star-feed'),x=event.clientX,y=event.clientY;
    event.preventDefault();event.stopImmediatePropagation();event.dataTransfer.dropEffect='move';
    // Model a busy target renderer: accepted native dragend arrives at source
    // before the target handler can enqueue its real main-process transaction.
    setTimeout(()=>{const dataTransfer=new DataTransfer();dataTransfer.setData('application/x-tide-star-feed',token);document.querySelector('.pet-stage').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,clientX:x,clientY:y,dataTransfer}));},700);
  },{capture:true,once:true}));
  assert.equal((await dropDesktop(delayed)).accepted,true);await finishSource('move');
  await win.waitForTimeout(350);assert.equal(balance(await disk()),3);assert.equal(await pet.locator('.is-star-feed-drag').count(),1,JSON.stringify({source:await win.evaluate(()=>({events:__feedEvents,effect:__feedTransfer.dropEffect})),target:await pet.evaluate(()=>({events:__feedEvents,classes:document.querySelector('.pet-stage').className}))}));
  await waitFeeds(5);assert.equal(balance(await disk()),2);
  passed.push('accepted cross-window drop delayed 700ms retains its session and commits exactly once');
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ok:true,groups:passed.length,passed,userData,appRoot,scope:'synthetic DataTransfer events across real renderers with production IPC/disk; native OLE drag is a separate manual check'}));
}finally{if(app)await app.close();}
