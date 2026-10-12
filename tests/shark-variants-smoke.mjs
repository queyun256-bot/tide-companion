import { _electron as electron } from 'playwright-core';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const userData = await mkdtemp(path.join(tmpdir(), 'tide-five-sharks-'));
const env = { ...process.env, TIDE_TEST_DATA: userData }; delete env.ELECTRON_RUN_AS_NODE;
const launch = () => electron.launch({ executablePath: path.join(root,'node_modules/electron/dist/electron.exe'), args:[path.join(root,'tests/launch-smoke.cjs')], env, timeout:30000 });
let app = await launch(); const errors = [];
async function windows() {
  await app.firstWindow();
  for (let i=0;i<100;i++) { if (app.windows().some(page=>page.url().endsWith('/pet.html'))) break; await new Promise(resolve=>setTimeout(resolve,50)); }
  const pet = app.windows().find(page=>page.url().endsWith('/pet.html'));
  const dashboard = app.windows().find(page=>page.url().endsWith('/index.html'));
  assert.ok(pet && dashboard);
  pet.on('pageerror',error=>errors.push(error.message));
  await app.evaluate(({BrowserWindow})=>{ for(const win of BrowserWindow.getAllWindows()){win.webContents.setBackgroundThrottling(false); if(win.webContents.getURL().endsWith('/index.html'))win.hide();} });
  await pet.waitForFunction(()=>document.querySelector('.pet-stage').dataset.behavior==='awake');
  return {pet,dashboard};
}
try {
  let {pet,dashboard}=await windows();
  const library=await pet.evaluate(()=>window.petAPI.listSkins());
  const builtin=library.skins.filter(item=>item.isBuiltin);
  assert.equal(builtin.length,5);
  const state=await pet.evaluate(()=>window.petAPI.loadState());
  state.settings.name='小团子'; await pet.evaluate(value=>window.petAPI.saveState(value),state);
  await mkdir(path.join(root,'screenshots'),{recursive:true});
  const lines=[];
  for(const skin of builtin){
    await pet.evaluate(id=>window.petAPI.selectSkin(id),skin.id);
    await pet.waitForFunction(id=>document.querySelector('.pet-stage').dataset.variant===id,skin.id);
    await pet.waitForTimeout(450);
    const visual=await dashboard.evaluate(()=>window.petAPI.getPetVisual());
    assert.equal(visual.variant,skin.id); assert.equal(visual.live2d,false);
    assert.equal(await pet.locator('#builtin-pet').isVisible(),true);
    assert.equal((await pet.evaluate(()=>window.petAPI.loadState())).settings.name,'小团子');
    await assert.rejects(pet.evaluate(id=>window.petAPI.removeSkin(id),skin.id),/不能删除/);
    const color=await pet.locator('#shark-body-gradient stop').first().getAttribute('stop-color');
    assert.equal(color,skin.palette['#B0E5EB']||'#B0E5EB');
    const before=(await pet.evaluate(()=>window.petAPI.loadState())).moods.length;
    await pet.evaluate(()=>window.petAPI.petAction('nuzzle'));
    lines.push(await pet.evaluate(async()=>{ const {PetBehavior}=await import('./src/pet-behavior.js'); return new PetBehavior({variant:document.querySelector('.pet-stage').dataset.variant}).line('reward',Date.now()).message; }));
    await pet.screenshot({path:path.join(root,`screenshots/shark-${skin.id}-v070.png`),omitBackground:true});
    assert.equal((await pet.evaluate(()=>window.petAPI.loadState())).moods.length,before+1);
  }
  assert.equal(new Set(lines).size,5,'every companion has a different earned-reward reply');
  await app.close(); app=await launch(); ({pet,dashboard}=await windows());
  await pet.waitForFunction(()=>document.querySelector('.pet-stage').dataset.variant==='builtin-lilac');
  assert.equal((await pet.evaluate(()=>window.petAPI.loadState())).settings.name,'小团子');
  await assert.rejects(dashboard.evaluate(()=>window.petAPI.startPetDrag()),/仅桌宠/);
  await assert.rejects(dashboard.evaluate(async()=>window.petAPI.publishPetVisual(await window.petAPI.getPetVisual())),/仅桌宠/);
  // Playwright dispatches renderer mouse input without moving the physical OS cursor.
  // Inject only the test cursor source; keep production IPC and native bounds writes.
  await app.evaluate(({BrowserWindow,screen})=>{
    const win=BrowserWindow.getAllWindows().find(win=>win.webContents.getURL().endsWith('/pet.html'));
    win.setBounds({x:120,y:120,width:320,height:370});win.showInactive();
    globalThis.testCursor={x:280,y:230}; screen.getCursorScreenPoint=()=>globalThis.testCursor;
  });
  const hit=await pet.locator('#fin-drag-handle path').boundingBox();
  const point={x:hit.x+hit.width*.55,y:hit.y+hit.height*.65};
  const bounds=()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(win=>win.webContents.getURL().endsWith('/pet.html')).getBounds());
  async function startHold(){
    const b=await bounds();
    await app.evaluate((_electron,cursor)=>{globalThis.testCursor=cursor;},{x:b.x+point.x,y:b.y+point.y});
    await pet.mouse.move(point.x,point.y);await pet.mouse.down();
  }
  await startHold();await pet.waitForTimeout(160);await pet.mouse.up();
  assert.equal(await pet.locator('.pet-stage').evaluate(el=>el.classList.contains('is-dragging')),false,'short click does not drag');
  const before=await bounds();const logs=(await pet.evaluate(()=>window.petAPI.loadState())).moods.length;
  await startHold();await pet.waitForFunction(()=>document.querySelector('.pet-stage').classList.contains('is-dragging'));
  await app.evaluate(()=>{globalThis.testCursor.x+=90;globalThis.testCursor.y+=45;});
  await pet.mouse.move(point.x+1,point.y+1);
  await pet.waitForTimeout(200);
  const after=await bounds(); assert.equal(after.x,before.x+90);assert.equal(after.y,before.y+45);
  await pet.screenshot({path:path.join(root,'screenshots/shark-fin-drag-v070.png'),omitBackground:true});
  await pet.mouse.up();
  await pet.waitForFunction(()=>!document.querySelector('.pet-stage').classList.contains('is-dragging'));
  assert.equal((await pet.evaluate(()=>window.petAPI.loadState())).moods.length,logs,'drag never creates touch or health records');
  await pet.waitForTimeout(750);
  await pet.evaluate(()=>window.petAPI.petAction('sleep'));
  await pet.waitForFunction(()=>document.querySelector('.pet-stage').dataset.behavior==='sleeping');
  await startHold();await pet.waitForFunction(()=>document.querySelector('.pet-stage').classList.contains('is-dragging'));
  await pet.mouse.up();
  assert.equal(await pet.locator('.pet-stage').getAttribute('data-behavior'),'sleeping','dragging does not wake a sleeping companion');
  await startHold();await pet.waitForFunction(()=>document.querySelector('.pet-stage').classList.contains('is-dragging'));
  await pet.keyboard.press('Escape');await pet.mouse.up();
  assert.equal(await pet.locator('.pet-stage').evaluate(el=>el.classList.contains('is-dragging')),false);
  assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(win=>win.webContents.getURL().endsWith('/pet.html')).isVisible()),true,'Escape releases a drag without hiding pet');
  await startHold();await pet.waitForFunction(()=>document.querySelector('.pet-stage').classList.contains('is-dragging'));
  await pet.evaluate(()=>window.petAPI.selectSkin('builtin-rose'));await pet.mouse.up();
  await pet.waitForFunction(()=>!document.querySelector('.pet-stage').classList.contains('is-dragging'));
  await pet.waitForTimeout(750);
  for(const cancel of ['blur','lostpointercapture','hide']) {
    await startHold();await pet.waitForFunction(()=>document.querySelector('.pet-stage').classList.contains('is-dragging'));
    if(cancel==='blur') await pet.evaluate(()=>window.dispatchEvent(new Event('blur')));
    else if(cancel==='lostpointercapture') await pet.evaluate(()=>document.getElementById('fin-drag-handle').dispatchEvent(new PointerEvent('lostpointercapture',{pointerId:1})));
    else await pet.evaluate(()=>window.petAPI.hidePet());
    await pet.mouse.up();
    await pet.waitForFunction(()=>!document.querySelector('.pet-stage').classList.contains('is-dragging'));
    if(cancel==='hide') await pet.evaluate(()=>window.petAPI.showPet());
    await pet.waitForTimeout(750);
  }
  const saved=await pet.evaluate(()=>window.petAPI.loadState());saved.settings.reducedMotion=true;
  await pet.evaluate(value=>window.petAPI.saveState(value),saved);
  await pet.waitForFunction(()=>document.documentElement.classList.contains('reduced-motion'));
  assert.equal(await pet.locator('.fin-left').evaluate(el=>getComputedStyle(el).animationName),'none');
  await pet.waitForTimeout(500);
  assert.equal((await dashboard.evaluate(()=>window.petAPI.getPetVisual())).reducedMotion,true);
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ok:true,checks:['five original palettes and accessories','five distinct dialogue banks','non-removable builtin skins','name and skin persist across restart','authoritative visual snapshot','pet-only visual and drag IPC','short press never drags','native bounded window movement from long press','release and Escape recover','skin switch cancels','blur, hidden and lost capture cancel','sleep preserved during drag','drag creates no records','reduced motion'],isolatedData:userData}));
}finally{await app.close();}
