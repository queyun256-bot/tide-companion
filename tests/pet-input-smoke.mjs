// Real Electron DOM/SVG geometry and native IPC policy. Synthetic renderer
// events exercise the state machine; no OS cursor movement or input injection.
import {_electron as electron} from 'playwright-core';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const userData=await mkdtemp(path.join(tmpdir(),'tide-pet-input-policy-'));
const env={...process.env,TIDE_TEST_DATA:userData};delete env.ELECTRON_RUN_AS_NODE;
function ignoresMouse(hwnd){
  const script=`$ProgressPreference='SilentlyContinue'
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class TideInputRead{[DllImport("user32.dll",EntryPoint="GetWindowLongPtrW")]public static extern IntPtr GetWindowLongPtr(IntPtr hwnd,int index);}'
([TideInputRead]::GetWindowLongPtr([IntPtr]${hwnd},-20).ToInt64() -band 0x20) -ne 0`;
  return execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true}).trim()==='True';
}
let app;
const passed=[],errors=[];
try{
  app=await electron.launch({executablePath:path.join(root,'node_modules/electron/dist/electron.exe'),args:[path.join(root,'tests/launch-smoke.cjs')],env,timeout:30000});
  let pet;
  for(let n=0;n<100;n++){pet=app.windows().find(w=>w.url().endsWith('/pet.html'));if(pet)break;await new Promise(resolve=>setTimeout(resolve,100));}
  assert.ok(pet);pet.on('pageerror',error=>errors.push(error.message));
  await pet.waitForFunction(()=>document.querySelector('.pet-stage')?.dataset.behavior==='awake');
  await pet.evaluate(async()=>{const state=await window.petAPI.loadState();state.settings.autoHideFullscreen=false;state.settings.reducedMotion=true;state.settings.notifications=false;await window.petAPI.saveState(state);});
  const info=await app.evaluate(({BrowserWindow,screen})=>{
    const pet=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/pet.html'));
    for(const win of BrowserWindow.getAllWindows()){win.webContents.setBackgroundThrottling(false);if(win!==pet)win.hide();}
    const area=screen.getPrimaryDisplay().workArea,cursor=screen.getCursorScreenPoint();
    pet.setBounds({x:area.x+(cursor.x<area.x+area.width/2?area.width-380:60),y:area.y+60,width:320,height:370});pet.showInactive();
    return {hwnd:Number(pet.getNativeWindowHandle().readBigUInt64LE()),scale:screen.getPrimaryDisplay().scaleFactor};
  });
  await pet.evaluate(async()=>{
    const mod=await import('./src/pet-input.js');
    const stage=document.querySelector('.pet-stage');
    const calls=[];let cancelled;
    const controller=mod.installPetInput({stage,api:{setPetPointerPassthrough(value){calls.push(value);},onPetDragCancelled(callback){cancelled=callback;return()=>{cancelled=null;};}}});
    const point=(selector,x,y)=>{const p=new DOMPoint(x,y).matrixTransform(document.querySelector(selector).getScreenCTM());return {x:p.x,y:p.y};};
    const hit=(x,y)=>mod.petPointIsInteractive(stage,x,y);
    const move=(x,y,buttons=0)=>document.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:x,clientY:y,buttons}));
    // Use the stage target for synthetic state-machine events. The real touch
    // control correctly requires a native active pointer to request capture.
    const pointer=(type,x,y,buttons=0)=>stage.dispatchEvent(new PointerEvent(type,{bubbles:true,pointerId:93,isPrimary:true,button:0,buttons,clientX:x,clientY:y}));
    const frame=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    globalThis.__inputTest={stage,calls,controller,point,hit,move,pointer,frame,cancel:()=>cancelled?.({token:'test',reason:'timeout'})};
  });
  const geometry=await pet.evaluate(()=>{
    const h=__inputTest;const body=h.point('#builtin-pet svg',200,150),fin=h.point('.drag-handle',213,65),shadow=h.point('#builtin-pet svg',203,287),star=h.point('#builtin-pet svg',83,129);
    return {body:h.hit(body.x,body.y),fin:h.hit(fin.x,fin.y),shadow:h.hit(shadow.x,shadow.y),star:h.hit(star.x,star.y),outer:h.hit(3,3),transparentTouch:h.hit(20,80)};
  });
  assert.deepEqual(geometry,{body:true,fin:true,shadow:false,star:false,outer:false,transparentTouch:false});
  passed.push('actual SVG shape/fin hits; blank, shadow and decoration pass through');
  assert.deepEqual(await pet.evaluate(async()=>{
    const h=__inputTest,body=document.querySelector('#builtin-pet'),original=body.getAttribute('style');
    body.style.transform='translate(18px,9px) rotate(19deg) scale(.8)';body.style.transition='none';
    await h.frame();const p=h.point('#builtin-pet svg',200,150),hit=h.hit(p.x,p.y);
    if(original===null)body.removeAttribute('style');else body.setAttribute('style',original);
    const canvas=document.querySelector('#live2d-canvas');h.stage.classList.add('live2d-active');canvas.hidden=false;const b=canvas.getBoundingClientRect();
    const live=h.hit(b.left+b.width/2,b.top+b.height/2),outside=h.hit(3,3);canvas.hidden=true;h.stage.classList.remove('live2d-active');return {hit,live,outside};
  }),{hit:true,live:true,outside:false});
  passed.push('transformed SVG and Live2D viewport fallback use real layout geometry');
  assert.deepEqual(await pet.evaluate(async()=>{
    const h=__inputTest,controls=document.querySelector('.pet-controls'),speech=document.querySelector('.speech');
    h.stage.classList.add('controls-visible');controls.style.transition='none';await h.frame();let b=controls.getBoundingClientRect();const controlsShown=h.hit(b.left+b.width/2,b.top+b.height/2);
    h.stage.classList.remove('controls-visible');await h.frame();b=controls.getBoundingClientRect();const controlsHidden=h.hit(b.left+b.width/2,b.top+b.height/2);
    const saved={class:speech.className,aria:speech.getAttribute('aria-hidden'),style:speech.getAttribute('style')};
    speech.classList.remove('is-hidden');speech.setAttribute('aria-hidden','false');speech.style.transition='none';speech.style.opacity='1';await h.frame();b=speech.getBoundingClientRect();const speechShown=h.hit(b.left+b.width/2,b.top+10);
    speech.setAttribute('aria-hidden','true');const speechHidden=h.hit(b.left+b.width/2,b.top+10);
    speech.className=saved.class;speech.setAttribute('aria-hidden',saved.aria);if(saved.style===null)speech.removeAttribute('style');else speech.setAttribute('style',saved.style);controls.style.removeProperty('transition');
    return {controlsShown,controlsHidden,speechShown,speechHidden};
  }),{controlsShown:true,controlsHidden:false,speechShown:true,speechHidden:false});
  passed.push('only visible controls and speech intercept input');
  assert.deepEqual(await pet.evaluate(async()=>{
    const h=__inputTest;h.calls.length=0;h.move(160,170);h.pointer('pointerdown',160,170,1);h.move(3,3,1);const held=h.calls.at(-1);
    h.pointer('pointerup',3,3,0);const throughClick=h.calls.at(-1);await h.frame();const released=h.calls.at(-1);
    h.move(160,170);const reentered=h.calls.at(-1);return {held,throughClick,released,reentered};
  }),{held:false,throughClick:false,released:true,reentered:false});
  passed.push('held press stays interactive, release waits until click, mousemove re-enters');
  assert.deepEqual(await pet.evaluate(async()=>{
    const h=__inputTest;const outcomes=[];
    for(const release of ['pointercancel','blur','remote']){
      h.move(160,170);h.pointer('pointerdown',160,170,1);h.move(3,3,1);
      if(release==='pointercancel')h.pointer('pointercancel',3,3);else if(release==='blur')window.dispatchEvent(new Event('blur'));else h.cancel();
      await h.frame();outcomes.push(h.calls.at(-1));
    }
    h.move(160,170);h.pointer('pointerdown',160,170,1);h.move(3,3,0);outcomes.push(h.calls.at(-1));return outcomes;
  }),[true,true,true,true]);
  passed.push('cancel, blur, main cancellation and missed release recover pass-through');
  assert.deepEqual(await pet.evaluate(async()=>{
    const h=__inputTest;h.stage.classList.add('is-star-feed-drag');h.move(3,3);const receiving=h.calls.at(-1);
    h.stage.classList.remove('is-star-feed-drag');document.dispatchEvent(new CustomEvent('tide-star-feed-session-end'));await h.frame();return {receiving,finished:h.calls.at(-1)};
  }),{receiving:false,finished:true});
  passed.push('cross-window feeding temporarily receives drag/drop, then clears stale native hit state');
  await pet.evaluate(()=>__inputTest.move(3,3));await pet.waitForTimeout(60);assert.equal(ignoresMouse(info.hwnd),true);
  await pet.evaluate(()=>__inputTest.move(160,170));await pet.waitForTimeout(60);assert.equal(ignoresMouse(info.hwnd),false);
  await pet.evaluate(()=>__inputTest.move(3,3));await pet.waitForTimeout(60);assert.equal(ignoresMouse(info.hwnd),true);
  passed.push('production renderer + sender-checked IPC change actual HWND transparent style');
  assert.deepEqual(await pet.evaluate(async()=>{
    const h=__inputTest;h.controller.dispose();const last=h.calls.at(-1),before=h.calls.length;h.move(160,170);h.pointer('pointerdown',160,170,1);h.pointer('pointerup',160,170);h.cancel();h.stage.style.setProperty('--input-test','1');await h.frame();return {last,unsubscribed:h.calls.length===before};
  }),{last:true,unsubscribed:true});
  passed.push('dispose restores pass-through and removes listeners/subscription');
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ok:true,groups:passed.length,passed,scale:info.scale,userData,scope:'real SVG/layout and HWND styles; renderer events are synthetic, physical forward/click is verified separately'}));
}finally{if(app)await app.close();}
