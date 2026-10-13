// Real Electron with synthetic records and an isolated profile. No user data.
import { _electron as electron } from 'playwright-core';
import { mkdtemp, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const userData=await mkdtemp(path.join(tmpdir(),'tide-i18n-ui-'));
const env={...process.env,TIDE_TEST_DATA:userData,TIDE_TEST_SYSTEM_LOCALE:'ja-JP',TIDE_TEST_ONBOARDING:'1'};
delete env.ELECTRON_RUN_AS_NODE;
const launch=()=>electron.launch({executablePath:path.join(root,'node_modules/electron/dist/electron.exe'),args:[path.join(root,'tests/launch-smoke.cjs')],env});
const errors=[], untranslated=[];
const sources=Object.assign({},...await Promise.all(['native','journal','companion','app'].map(async name=>JSON.parse(await readFile(path.join(root,`src/locales/${name}.json`),'utf8')))));
const translated=(key,language)=>language==='zh-CN'?key:sources[key]?.[['en','zh-TW','ja','ko','es'].indexOf(language)]||key;
let app;
async function windows(){
  await app.firstWindow();
  for(let count=0;count<100;count++){
    const dashboard=app.windows().find(page=>page.url().endsWith('/index.html'));
    const pet=app.windows().find(page=>page.url().endsWith('/pet.html'));
    if(dashboard&&pet){
      for(const page of [dashboard,pet]){page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});}
      await dashboard.locator('h1').waitFor({timeout:15000}).catch(async error=>{console.error(JSON.stringify({errors,body:await dashboard.locator('body').innerText()}));throw error;});
      return {dashboard,pet};
    }
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  throw Error('App windows did not load');
}
try{
  app=await launch();let {dashboard:win,pet}=await windows();
  await win.locator('#modal[open]').waitFor();
  assert.equal(await win.locator('html').getAttribute('lang'),'ja','first run follows preferred OS language');
  assert.equal(await win.locator('#modal h2').innerText(),translated('先确认两项设置','ja'));
  await win.locator('[data-action="close-modal"]').click();
  await win.evaluate(async()=>{const state=await window.petAPI.loadState();state.settings.name='今天';state.settings.onboardingCompleted=true;state.settings.reducedMotion=true;state.settings.autoHideFullscreen=false;state.plans=[{id:'synthetic-plan',name:'今天',routeId:'e2-oral',amount:2,intervalHours:24,startAt:'2026-10-01T00:00:00.000Z',enabled:false}];state.doses=[{id:'synthetic-dose',routeId:'e2-oral',amount:2,at:'2026-10-01T00:00:00.000Z'}];state.labs=[{id:'synthetic-lab',analyte:'estradiol',value:150,unit:'pg/mL',at:'2026-10-01T01:00:00.000Z'}];await window.petAPI.saveState(state);});
  const initial=await win.evaluate(()=>window.petAPI.loadState());
  const nav=async page=>{await win.locator(`[data-page="${page}"]`).click();await win.locator('h1').waitFor();};
  const audit=async(label,language)=>{
    assert.doesNotMatch(await win.locator('body').innerText(),/\uE000|\uE001|undefined|\{[0-9]+\}/,label);
    assert.equal(await win.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2),false,`${language}/${label}: page overflow`);
    if(language==='en'||language==='es'){
      const found=await win.evaluate(()=>{const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);const out=[];while(walker.nextNode()){const node=walker.currentNode, parent=node.parentElement;if(!parent||!parent.checkVisibility()||parent.closest('script,style,select'))continue;const text=node.textContent.trim();if(/[\u3400-\u9fff]/.test(text.replace(/潮汐|今天|鲨鲨/g,''))&&!['潮汐','今天','鲨鲨'].includes(text))out.push(text);}return [...new Set(out)];});
      if(found.length)untranslated.push({language,label,found});
    }
  };
  await mkdir(path.join(root,'screenshots'),{recursive:true});
  for(const language of ['en','zh-CN','zh-TW','ja','ko','es']){
    await nav('settings');await win.locator('#language-select').selectOption(language);
    await win.waitForFunction(language=>document.documentElement.lang===language,language);
    await pet.waitForFunction(language=>document.documentElement.lang===language,language);
    assert.equal((await win.evaluate(()=>window.petAPI.getLocale())).locale,language);
    assert.equal(await win.locator('[data-page="calendar"] span').innerText(),translated('日历',language));
    assert.equal(await win.locator('#language-select').inputValue(),language);
    await audit('settings',language);
    if(language==='es')await win.screenshot({path:path.join(root,'screenshots/language-es-settings.png'),fullPage:true});
    for(const page of ['overview','calendar','plans','curves','labs']){await nav(page);await audit(page,language);}
    await win.locator('[data-action="lab"]').first().click();await audit('lab dialog',language);await win.locator('[data-action="close-modal"]').click();
    await nav('plans');await win.locator('[data-action="dose"]:not([data-id])').first().click();
    assert.equal(await win.locator('#modal h2').innerText(),translated('记录一次实际使用',language));
    await win.locator('#form-administration-trigger').click();await audit('route dropdown',language);await win.keyboard.press('Escape');
    await win.locator('.date-picker-trigger').first().click();await audit('date picker',language);await win.keyboard.press('Escape');
    await audit('dose dialog',language);await win.locator('[data-action="close-modal"]').click();
    await nav('curves');await win.locator('[data-action="model"]').click();await audit('model dialog',language);await win.locator('[data-action="close-modal"]').click();
    const current=await win.evaluate(()=>window.petAPI.loadState());
    for(const key of ['doses','labs','plans','pkSettings','baselines','starWallet'])assert.deepEqual(current[key],initial[key],`${language}: ${key} must not change`);
    assert.equal(current.settings.name,'今天');
    assert.equal(current.settings.language,language);
    console.log(`Locale ${language} UI checked`);
  }
  await app.close();app=null;
  // Explicit selection survives a full process restart, even with a different OS language.
  env.TIDE_TEST_SYSTEM_LOCALE='ko-KR';app=await launch();({dashboard:win,pet}=await windows());
  assert.equal(await win.locator('html').getAttribute('lang'),'es');
  await win.locator('[data-page="settings"]').click();assert.equal(await win.locator('#language-select').inputValue(),'es');
  await win.locator('#language-select').selectOption('system');await win.waitForFunction(()=>document.documentElement.lang==='ko');await pet.waitForFunction(()=>document.documentElement.lang==='ko');
  assert.equal((await win.evaluate(()=>window.petAPI.loadState())).settings.language,'system');
  assert.equal((await win.evaluate(()=>window.petAPI.getLocale())).systemLocale,'ko-KR');
  console.log(JSON.stringify({untranslated,errors,userData}));
  assert.deepEqual(errors,[],'no renderer errors');
  assert.deepEqual(untranslated,[],'visible authored text must not fall back to Chinese in English/Spanish');
  console.log('Six-language desktop smoke passed: first run, switching, native/pet sync, persistence, data integrity.');
}finally{if(app)await app.close();}
