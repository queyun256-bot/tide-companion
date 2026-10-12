// Exercise the real gallery with synthetic isolated settings; never use installed user data.
import { _electron as electron } from 'playwright-core';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const userData=await mkdtemp(path.join(tmpdir(),'tide-skin-gallery-v070-'));
const env={...process.env,TIDE_TEST_DATA:userData};delete env.ELECTRON_RUN_AS_NODE;
const ids=['builtin','builtin-rose','builtin-mint','builtin-peach','builtin-lilac'];
const names=['浅海蓝','绒绒粉','薄荷绿','蜜桃橙','暮云紫'];
const checks=[],errors=[];
let app,win;
const disk=()=>readFile(path.join(userData,'state.json'),'utf8').then(JSON.parse);
async function launch(){
  app=await electron.launch({executablePath:path.join(root,'node_modules/electron/dist/electron.exe'),args:[path.join(root,'tests/launch-smoke.cjs')],env,timeout:30000});
  for(let n=0;n<100;n++){win=app.windows().find(w=>w.url().endsWith('/index.html'));if(win)break;await new Promise(resolve=>setTimeout(resolve,100));}
  assert.ok(win);win.setDefaultTimeout(8000);await win.locator('h1').waitFor();
  win.on('pageerror',error=>errors.push(error.message));
  await app.evaluate(({BrowserWindow})=>{for(const w of BrowserWindow.getAllWindows()){w.webContents.setBackgroundThrottling(false);w.hide();}BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/index.html')).setSize(1440,1000);});
}
async function close(){if(app){await app.close();app=null;win=null;}}
async function settings(){await win.locator('[data-page="settings"]').click();await win.locator('.shark-skin').first().waitFor();}
async function screenshot(file, galleryOnly=true){
  await win.locator('.skin-card').scrollIntoViewIfNeeded();
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/index.html')).showInactive());
  await (galleryOnly?win.locator('.skin-card'):win).screenshot({path:path.join(root,'screenshots',file),animations:'disabled'});
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/index.html')).hide());
}
try{
  await launch();
  await win.evaluate(async()=>{const s=await window.petAPI.loadState();s.settings.reducedMotion=true;s.settings.petVisible=false;s.settings.autoHideFullscreen=false;await window.petAPI.saveState(s);});
  await settings();
  await win.locator('[data-action="rename"]').click();await win.locator('[name="name"]').fill('星星');
  await win.locator('#dialog-form button[type="submit"]').click();await win.locator('#modal').waitFor({state:'hidden'});
  await win.locator('.shark-skin').first().waitFor();
  assert.equal(await win.locator('.shark-skin').count(),5);
  assert.deepEqual(await win.locator('.shark-skin h3').allTextContents(),names);
  assert.equal(await win.locator('.shark-skin [data-action="remove-skin"]').count(),0);
  assert.equal(await win.locator('.imported-skins,[data-action="import-skin"],#skin-scale').count(),0);
  assert.match(await win.locator('.shark-collection-note').innerText(),/星星.*名字保持不变/s);
  checks.push('five named personality cards render; Live2D import and scale options are hidden; companion name is reflected');

  const pixels=await win.locator('.shark-skin').evaluateAll(async cards=>Promise.all(cards.map(async card=>{
    const img=card.querySelector('img');img.loading='eager';await img.decode();
    const canvas=document.createElement('canvas');canvas.width=400;canvas.height=320;
    const context=canvas.getContext('2d');context.drawImage(img,0,0,400,320);
    // Forehead is unobstructed by eyes, cheeks and the unchanged trans flag scarf.
    const rgb=[...context.getImageData(200,115,1,1).data];
    return {id:card.dataset.skinId,src:img.getAttribute('src'),width:img.naturalWidth,height:img.naturalHeight,rgb};
  })));
  assert.equal(new Set(pixels.map(item=>item.src)).size,5);
  assert.equal(new Set(pixels.map(item=>item.rgb.join(','))).size,5);
  for(const item of pixels){assert.ok(item.width>0&&item.height>0);assert.equal(item.rgb[3],255);}
  const byId=Object.fromEntries(pixels.map(item=>[item.id,item.rgb]));
  assert.ok(byId.builtin[2]>byId.builtin[0]);
  assert.ok(byId['builtin-rose'][0]>byId['builtin-rose'][2]);
  assert.ok(byId['builtin-mint'][1]>byId['builtin-mint'][0]);
  assert.ok(byId['builtin-peach'][0]>byId['builtin-peach'][1]&&byId['builtin-peach'][1]>byId['builtin-peach'][2]);
  assert.ok(byId['builtin-lilac'][2]>byId['builtin-lilac'][0]&&byId['builtin-lilac'][0]>byId['builtin-lilac'][1]);
  checks.push('all five thumbnails decode and render real distinct blue/pink/green/orange/purple forehead pixels');

  // Start with a non-default skin, then exercise every choice through visible UI.
  for(const id of [...ids.slice(1),ids[0],ids.at(-1)]){
    await win.locator(`.shark-skin [data-action="select-skin"][data-id="${id}"]`).click();
    await win.waitForFunction(id=>document.querySelector(`.shark-skin[data-skin-id="${id}"]`)?.classList.contains('is-selected'),id);
    assert.equal(await win.locator('.shark-skin.is-selected').count(),1);
    assert.equal(await win.locator('.shark-skin [data-action="select-skin"]:disabled').count(),1);
    const state=await disk();assert.equal(state.settings.activeSkin,id);assert.equal(state.settings.name,'星星');
    const preview=win.locator('tide-pet-preview.settings-pet-preview');
    assert.equal(await preview.getAttribute('skin'),id);
    assert.equal(await preview.getAttribute('name'),'星星');
    assert.equal(await preview.getAttribute('aria-label'),'摸摸星星');
  }
  checks.push('each builtin selection immediately persists, updates preview and selected card, and preserves custom name');

  await mkdir(path.join(root,'screenshots'),{recursive:true});
  for(const [mode,width,height] of [['mtf',1440,1000],['ftm',1440,1000],['ftm',860,620]]){
    await win.locator(`[data-action="mode-${mode}"]`).click();
    await app.evaluate(({BrowserWindow},size)=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/index.html')).setSize(...size),[width,height]);
    await win.waitForFunction(mode=>document.body.dataset.mode===mode,mode);
    await win.locator('.shark-skin').first().waitFor();
    await win.waitForTimeout(80);
    const overflow=await win.evaluate(()=>({scroll:document.documentElement.scrollWidth,width:innerWidth,cards:[...document.querySelectorAll('.shark-skin')].map(el=>({scroll:el.scrollWidth,width:el.clientWidth}))}));
    assert.ok(overflow.scroll<=overflow.width,JSON.stringify(overflow));
    for(const card of overflow.cards)assert.ok(card.scroll<=card.width,JSON.stringify(card));
    await screenshot(`skin-gallery-${mode}-${width}-v070.png`,width>860);
  }
  checks.push('pink/blue gallery and 860×620 layout fit without horizontal clipping; screenshots captured');

  await close();await launch();await settings();
  assert.equal(await win.locator('.shark-skin.is-selected').getAttribute('data-skin-id'),'builtin-lilac');
  assert.equal((await disk()).settings.name,'星星');
  assert.equal((await disk()).settings.activeSkin,'builtin-lilac');
  assert.equal(await win.locator('.shark-skin [data-action="remove-skin"]').count(),0);
  checks.push('complete process restart preserves chosen skin and custom name');
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ok:true,checks,pixels,isolatedData:userData,installerPayload:!!process.env.TIDE_TEST_APP_ROOT}));
}finally{await close();}
