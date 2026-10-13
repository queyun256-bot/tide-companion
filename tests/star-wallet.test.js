import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { collectDueReminders,appendReminderLog } from '../src/reminders.js';
const require=createRequire(import.meta.url);
const {defaultState,validateState,createStateStore,parseState}=require('../electron/state.cjs');
const {rewardNewDoses,mergeStarWallet,validateStarWallet,balance,localDay,REWARD_WINDOW_MS,MAX_ENTRIES}=require('../electron/star-wallet.cjs');
const now=new Date(2026,9,12,12,30,0).getTime();
const iso=value=>new Date(value).toISOString();
function receipt(planId='plan',options={}){const scheduledAt=iso(now-30*60000);return {id:`${planId}@${scheduledAt}`,planId,scheduledAt,at:iso(now-29*60000),status:'notified',routeId:'e2-oral',amount:1,intervalHours:24,...options};}
function dose(id,record,options={}){return {id,planId:record.planId,routeId:record.routeId,amount:record.amount,at:iso(now),...(record.durationHours===undefined?{}:{durationHours:record.durationHours}),...options};}
function planFor(record,options={}){return {id:record.planId,name:'synthetic',routeId:record.routeId,amount:record.amount,intervalHours:record.intervalHours,startAt:record.scheduledAt,enabled:true,...(record.durationHours===undefined?{}:{durationHours:record.durationHours}),...options};}
function awarding(records,doses,previous={},at=now){const state={...defaultState(),reminderLog:records,...previous};return rewardNewDoses(state,{...state,doses},at);}
function walletFor(record,id=record.planId){return awarding([record],[dose(id,record)]).wallet;}
const plain=value=>JSON.parse(JSON.stringify(value));
function fixture(run){const directory=fs.mkdtempSync(path.join(os.tmpdir(),'tide-wallet-test-'));const clean=()=>{assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));assert.match(path.basename(directory),/^tide-wallet-test-/);fs.rmSync(directory,{recursive:true,force:true});};try{const result=run(directory);if(result?.finally)return result.finally(clean);clean();return result;}catch(error){clean();throw error;}}

function harness(directory,initial=defaultState(),maxBytesOverride){
  const handlers=new Map(),broadcasts=[],notifications=[],clock={now},disk={fail:false};
  const store=createStateStore(directory);store.save(initial);
  const normalize=value=>validateState(plain(value));
  const stateStore={file:store.file,save(value){if(disk.fail)throw Error('Disk full');return store.save(normalize(value));}};
  const mainFile=fileURLToPath(new URL('../electron/main.cjs',import.meta.url));
  class TestDate extends Date{constructor(...args){super(...(args.length?args:[clock.now]));}static now(){return clock.now;}}
  const context=vm.createContext({
    require(specifier){
      if(specifier==='electron')return {app:{setName(){},setPath(){},getName:()=> '潮汐',getPath:()=>directory,setAppUserModelId(){},requestSingleInstanceLock:()=>false,quit(){},isPackaged:false},ipcMain:{on(){}},protocol:{registerSchemesAsPrivileged(){}},dialog:{async showSaveDialog(){return {filePath:path.join(directory,'export.json')};},async showOpenDialog(){return {canceled:false,filePaths:[path.join(directory,'import.json')]};},async showMessageBox(){return {response:1};}},Notification:{isSupported:()=>false}};
      if(specifier==='./pet-desktop.cjs')return {setupPetDesktop:()=>({cancelDrag(){},attachPet(){},isDragging:()=>false,getVisual:()=>null})};
      if(specifier==='./pet-growth-desktop.cjs')return {setupPetGrowthDesktop:()=>({dispose(){},attachPet(){}})};
      if(specifier==='./state.cjs')return {...require('../electron/state.cjs'),validateState:normalize,...(maxBytesOverride===undefined?{}:{MAX_BYTES:maxBytesOverride})};
      return require(specifier.startsWith('.')?path.resolve(path.dirname(mainFile),specifier):specifier);
    },__dirname:path.dirname(mainFile),process:{platform:'win32',execPath:'C:\\Fixture\\Tide-Companion.exe',argv:[]},Buffer,URL,console,Date:TestDate,
    __initial:initial,__store:stateStore,__handlers:handlers,__broadcasts:broadcasts,__notifications:notifications,__reminders:{collectDueReminders,appendReminderLog},
  });
  vm.runInContext(fs.readFileSync(mainFile,'utf8'),context,{filename:mainFile});
  vm.runInContext('state=__initial;store=__store;handle=(channel,handler)=>__handlers.set(channel,handler);broadcast=(channel,value)=>__broadcasts.push({channel,value});showNotification=(detail)=>{__notifications.push(detail);return false;};reminders=__reminders;setupIpc();',context);
  return {call:(channel,...args)=>handlers.get(channel)(...args),tick:()=>vm.runInContext('reminderTick()',context),state:()=>vm.runInContext('state',context),clock,disk,broadcasts,notifications,store};
}

test('a real reminder snapshot can reward matching newly created doses; minute precision is intentional',()=>{
  const r=receipt();
  assert.equal(balance(awarding([r],[dose('a',r)]).wallet),1);
  const scheduled=now-60000+32123,precise={...r,id:`plan@${iso(scheduled)}`,scheduledAt:iso(scheduled),at:iso(scheduled)};
  assert.equal(balance(awarding([precise],[dose('b',precise,{at:iso(Math.floor(scheduled/60000)*60000)})]).wallet),1);
  for(const invalid of [{at:iso(Math.floor((scheduled-REWARD_WINDOW_MS)/60000)*60000-1)},{at:iso(now+1)},{amount:2},{routeId:'cpa-oral'},{durationHours:24}])assert.equal(balance(awarding([precise],[dose('c',precise,invalid)]).wallet),0);
  for(const invalid of [{status:'pending'},{status:'test'},{routeId:undefined},{at:iso(now+1)}])assert.equal(balance(awarding([{...r,...invalid}],[dose('d',r)]).wallet),0);
  assert.equal(balance(awarding([], [dose('e',r)]).wallet),0);
});
test('actual use may occur two hours before or after an existing reminder plan, with later confirmation allowed',()=>{
  const r=receipt(),scheduled=Date.parse(r.scheduledAt),previous={plans:[planFor(r)]};
  for(const offset of [-REWARD_WINDOW_MS,-60000,0,REWARD_WINDOW_MS]){
    const at=scheduled+offset,result=awarding([],[dose('dose',r,{at:iso(at)})],previous,at);
    assert.equal(balance(result.wallet),1,`offset ${offset}`);assert.equal(result.rewards[0].scheduledAt,r.scheduledAt);
    assert.deepEqual(validateStarWallet(result.wallet),result.wallet);
  }
  for(const offset of [-REWARD_WINDOW_MS-1,REWARD_WINDOW_MS+1])assert.equal(balance(awarding([],[dose('outside',r,{at:iso(scheduled+offset)})],previous,scheduled+REWARD_WINDOW_MS+1000).wallet),0);
  const delayed=awarding([],[dose('later-entry',r,{at:r.scheduledAt})],previous,scheduled+6*3600000);
  assert.equal(balance(delayed.wallet),1);assert.equal(delayed.rewards[0].earnedAt,iso(scheduled+6*3600000));
  assert.equal(balance(awarding([],[dose('future',r,{at:iso(now+1)})],previous,now).wallet),0);
  assert.equal(balance(awarding([],[dose('disabled',r)],{plans:[planFor(r,{enabled:false})]}).wallet),0);
});
test('plans infer the nearest real occurrence, never a negative occurrence or a newly added incoming plan',()=>{
  const r=receipt('recurring',{intervalHours:6}),p=planFor(r),actual=Date.parse(p.startAt)+6*3600000-30*60000;
  const result=awarding([],[dose('next',r,{at:iso(actual)})],{plans:[p]},actual);
  assert.equal(result.rewards[0].scheduledAt,iso(Date.parse(p.startAt)+6*3600000));
  const earlier=Date.parse(p.startAt)-6*3600000;
  assert.equal(awarding([],[dose('before-start',r,{at:iso(earlier)})],{plans:[p]},now).rewards.length,0);
  const previous=defaultState(),incoming={...previous,plans:[p],doses:[dose('same-save',r)]};
  assert.equal(rewardNewDoses(previous,incoming,now).rewards.length,0);
});
test('recovery receipts and old notified receipts use the same actual-use window, including after plan removal',()=>{
  for(const status of ['notified','missed']){
    const r=receipt('recovered',{status,at:iso(now-10*60000)}),scheduled=Date.parse(r.scheduledAt);
    assert.equal(balance(awarding([r],[dose('recovered-dose',r)]).wallet),1);
    assert.equal(balance(awarding([r],[dose('early-record',r,{at:iso(scheduled-REWARD_WINDOW_MS)})],{},now).wallet),1);
    assert.equal(balance(awarding([r],[dose('late-record',r,{at:iso(scheduled+REWARD_WINDOW_MS)})],{},scheduled+3*3600000).wallet),1);
    assert.equal(balance(awarding([r],[dose('outside',r,{at:iso(scheduled+REWARD_WINDOW_MS+1)})],{},scheduled+3*3600000).wallet),0);
    assert.equal(balance(awarding([r],[dose('disabled-after-reminder',r)],{plans:[planFor(r,{enabled:false})]}).wallet),1);
  }
});
test('an emitted snapshot replaces the current plan occurrence before matching dose or reward amount',()=>{
  const r=receipt('snapshot',{intervalHours:72,durationHours:72,routeId:'e2-patch',amount:50,status:'missed'});
  const changed=planFor(r,{amount:100,durationHours:24,intervalHours:168});
  assert.equal(awarding([r],[dose('changed',r,{amount:100,durationHours:24})],{plans:[changed]}).rewards.length,0);
  assert.equal(awarding([r],[dose('snapshot-dose',r)],{plans:[changed]}).rewards[0].amount,3);
});
test('reward outcomes explain existing, duplicate, ambiguous, claimed, unmatched and daily limit cases',()=>{
  const a=receipt('a'),b=receipt('b'),record=dose('first',a),prior=walletFor(a,'first');
  assert.deepEqual(awarding([a],[record]).outcomes,[{doseId:'first',code:'awarded',amount:1}]);
  assert.equal(awarding([a],[record],{doses:[record]}).outcomes[0].code,'existing');
  assert.equal(awarding([a],[dose('copied',a)],{starWallet:prior}).outcomes[0].code,'duplicate');
  assert.equal(awarding([a,b],[dose('ambiguous',a,{planId:undefined})]).outcomes[0].code,'ambiguous');
  assert.equal(awarding([a],[dose('already',a,{at:iso(now-60000)})],{starWallet:prior}).outcomes[0].code,'already-claimed');
  assert.equal(awarding([],[record]).outcomes[0].code,'expired-or-unmatched');
  const receipts=[1,2,3].map(n=>receipt(`limit${n}`,{amount:n}));
  assert.equal(awarding(receipts,receipts.map((r,n)=>dose(`d${n}`,r))).outcomes[2].code,'daily-limit');
});
test('regular confirmations cap at two local-day stars, long intervals do not consume this cap',()=>{
  const receipts=[1,2,3].map(n=>receipt(`p${n}`,{amount:n}));
  const long=receipt('long',{intervalHours:168,amount:4});
  const result=awarding([...receipts,long],[...receipts.map((r,n)=>dose(`d${n}`,r)),dose('dl',long)]);
  assert.equal(balance(result.wallet),9);assert.equal(result.rewards.length,3);
  assert.deepEqual(result.rewards.map(r=>r.kind),['regular','regular','long']);
  assert.ok(result.rewards.every(r=>r.day===localDay(now)));
  for(const [interval,expected] of [[47.99,1],[48,2],[71.99,2],[72,3],[167.99,6],[168,7],[8760,7]])assert.equal(balance(walletFor(receipt('p',{intervalHours:interval}))),expected);
});
test('matching uses reminder-time prescription snapshot and excludes ambiguous latest plans',()=>{
  const first=receipt('one'),newer=receipt('two',{scheduledAt:iso(now-600000),id:`two@${iso(now-600000)}`,at:iso(now-590000)});
  const result=awarding([first,newer],[dose('dose',first,{planId:undefined})]);
  assert.equal(result.rewards[0].planId,'two');
  assert.equal(awarding([first,{...first,planId:'copy',id:`copy@${first.scheduledAt}`}],[dose('a',first,{planId:undefined})]).rewards.length,0);
  assert.equal(awarding([first],[dose('a',first,{planId:'different'})]).rewards.length,0);
  assert.equal(awarding([first],[dose('a',first)],{plans:[{id:'one',routeId:'cpa-oral',amount:25,intervalHours:8760}]}).rewards[0].amount,1);
  const used=walletFor(newer);
  assert.equal(awarding([first,newer],[dose('other',first,{planId:undefined,at:iso(now-60000)})],{starWallet:used}).rewards.length,0,'claimed latest does not fall back to older reminder');
});
test('same occurrence and same actual minute cannot earn twice after edits, deletion, changed dose IDs or plans',()=>{
  const a=receipt('one',{intervalHours:72}),b=receipt('two',{intervalHours:72});
  const original=dose('first',a),copy=dose('copy',b,{at:iso(now-1)});
  const prior=walletFor(a,'first');
  assert.equal(awarding([a,b],[{...original,amount:2}],{doses:[original],starWallet:prior}).rewards.length,0);
  assert.equal(awarding([a,b],[original],{starWallet:prior}).rewards.length,0);
  assert.equal(awarding([a,b],[dose('new-id',a)],{starWallet:prior}).rewards.length,0);
  // Same minute, even seconds differ, is one actual use. Use noon + 1 second.
  const sameMinute=dose('copy',b,{at:iso(now+1000)});
  assert.equal(awarding([a,b],[sameMinute],{starWallet:prior},now+1000).rewards.length,0);
  assert.equal(awarding([a,b],[original,dose('copy',b)]).rewards.length,1);
  assert.equal(balance(prior),3);
});
test('existing historical records and editing them never get retrospective rewards',()=>{
  const r=receipt(),record=dose('historic',r);
  assert.equal(awarding([r],[record],{doses:[record]}).rewards.length,0);
  assert.equal(awarding([r],[{...record,at:iso(now-60000)}],{doses:[record]}).rewards.length,0);
  assert.equal(awarding([r],[{...record,id:'copied-history'}],{doses:[record]}).rewards.length,0);
});
test('full wallet stops rewards without rejecting newly saved actual medication records',()=>{
  const example=walletFor(receipt('capacity',{intervalHours:48})).entries[0];
  const entries=Array.from({length:MAX_ENTRIES},(_,n)=>({...example,id:`capacity-${n}@${example.scheduledAt}`,planId:`capacity-${n}`,doseId:`dose-${n}`,doseAmount:n+1}));
  const r=receipt('new-capacity',{intervalHours:48,amount:MAX_ENTRIES+1});
  const result=awarding([r],[dose('new-dose',r)],{starWallet:{version:1,entries}});
  assert.equal(result.rewards.length,0);assert.equal(result.wallet.entries.length,MAX_ENTRIES);
  assert.equal(result.outcomes[0].code,'capacity');
  assert.throws(()=>mergeStarWallet(walletFor(r),result.wallet),/星星账本/);
});
test('reminder receipt stores an immutable route/dose/interval/duration snapshot through normalization',()=>{
  const s=defaultState();s.plans=[{id:'patch',name:'synthetic',routeId:'e2-patch',amount:50,intervalHours:72,durationHours:72,startAt:iso(now-1000),enabled:true}];
  const emitted=collectDueReminders(s,now);s.reminderLog=appendReminderLog([],emitted);s.plans[0].amount=100;s.plans[0].durationHours=24;
  const stored=validateState(s).reminderLog[0];assert.equal(stored.amount,50);assert.equal(stored.intervalHours,72);assert.equal(stored.durationHours,72);
  assert.equal(awarding([stored],[dose('a',stored)]).rewards[0].amount,3);
  assert.equal(awarding([stored],[dose('b',stored,{durationHours:24})]).rewards.length,0);
});
test('backup merge preserves local ledger, deduplicates occurrence/dose/fingerprint and retains daily cap',()=>{
  const first=walletFor(receipt('a',{amount:1})),second=walletFor(receipt('b',{amount:2}));
  const local=mergeStarWallet(second,first),third=walletFor(receipt('c',{amount:3}));
  assert.equal(balance(mergeStarWallet(third,local)),2);
  assert.deepEqual(mergeStarWallet({version:1,entries:[]},local),local);
  assert.deepEqual(mergeStarWallet(local,local),local);
  assert.equal(balance(mergeStarWallet(walletFor(receipt('clone',{amount:1})),first)),1);
  assert.equal(balance(mergeStarWallet(walletFor(receipt('long',{amount:4,intervalHours:240})),local)),9);
});
test('malformed wallets and fake counters cannot replace the derived persistent ledger',()=>{
  const good=walletFor(receipt());
  for(const changes of [{amount:999},{kind:'long'},{day:'2026-02-30'},{earnedAt:iso(now-1)},{doseAt:iso(now+1)},{doseAt:iso(Date.parse(good.entries[0].scheduledAt)-REWARD_WINDOW_MS-1)},{routeId:'fake'}])assert.throws(()=>validateStarWallet({version:1,entries:[{...good.entries[0],...changes}]}),/星星/);
  assert.throws(()=>validateStarWallet({version:1,entries:[good.entries[0],good.entries[0]]}),/重复/);
  assert.deepEqual(validateStarWallet({...good,balance:999999}),good);
  assert.equal(balance(validateState({...defaultState(),moods:[{id:'old',action:'feed',at:iso(now)}]}).starWallet),0);
});
test('v0.8 migration starts an empty wallet and preserves a permanent pre-migration snapshot',()=>fixture(directory=>{
  const old=defaultState();delete old.starWallet;old.moods=[{id:'old-feed',action:'feed',at:iso(now)}];old.doses=[dose('historic',receipt())];
  const original=JSON.stringify(old);fs.writeFileSync(path.join(directory,'state.json'),original);
  const store=createStateStore(directory),loaded=store.load();assert.equal(loaded.migrated,true);assert.equal(balance(loaded.state.starWallet),0);
  const snapshot=fs.readdirSync(directory).find(name=>name.startsWith('state.before-v0.8.0-migration-'));assert.ok(snapshot);assert.equal(fs.readFileSync(path.join(directory,snapshot),'utf8'),original);
  store.save(loaded.state);assert.equal(createStateStore(directory).load().migrated,false);assert.equal(loaded.state.moods[0].action,'feed');
}));
test('authoritative IPC rejects manual feed and ignores a renderer forged wallet and reminder log',()=>fixture(directory=>{
  const h=harness(directory),incoming=plain(h.state());incoming.starWallet=walletFor(receipt());incoming.reminderLog=[receipt()];incoming.doses=[dose('fake',receipt())];
  h.call('state:save',incoming);assert.equal(balance(h.state().starWallet),0);assert.equal(h.state().reminderLog.length,0);
  assert.throws(()=>h.call('pet:interact','feed'),/自动获得/);assert.equal(h.state().moods.length,0);
}));
test('IPC never retroactively rewards a dose saved alongside its first new reminder plan',()=>fixture(directory=>{
  const h=harness(directory),s=plain(h.state());const r=receipt();s.plans=[{id:r.planId,name:'synthetic',routeId:r.routeId,amount:r.amount,intervalHours:24,startAt:iso(now-1000),enabled:true}];s.doses=[dose('same-save',r)];
  h.call('state:save',s);assert.equal(balance(h.state().starWallet),0);assert.equal(h.state().reminderLog.length,1);
  h.call('state:save',plain(h.state()));assert.equal(balance(h.state().starWallet),0);
}));
test('production IPC rewards a 20-minute recovery notification and retains its receipt across restart',()=>fixture(directory=>{
  const r=receipt('recovery',{scheduledAt:iso(now-20*60000)}),initial={...defaultState(),plans:[planFor(r)]},h=harness(directory,initial);
  h.tick();assert.equal(h.state().reminderLog[0].status,'missed');assert.equal(h.notifications.length,1);
  assert.equal(h.broadcasts.filter(e=>e.channel==='pet:action'&&e.value.action==='reminder').length,1);
  const record=dose('recovery-dose',r);h.call('state:save',{...plain(h.state()),doses:[record]});
  assert.equal(balance(h.state().starWallet),1);assert.equal(h.state().doses.length,1);
  const restarted=harness(directory,createStateStore(directory).load().state);
  restarted.call('state:save',{...plain(restarted.state()),doses:[]});
  restarted.call('state:save',{...plain(restarted.state()),doses:[{...record,id:'recovery-copy'}]});
  assert.equal(balance(restarted.state().starWallet),1);
}));
test('production IPC can reward before notification but never re-awards an existing historical record',()=>fixture(directory=>{
  const scheduledAt=iso(now+30*60000),r=receipt('upcoming',{scheduledAt,id:`upcoming@${scheduledAt}`}),record=dose('early',r);
  const h=harness(directory,{...defaultState(),plans:[planFor(r)]});
  h.call('state:save',{...plain(h.state()),doses:[record]});
  assert.equal(h.state().reminderLog.length,0);assert.equal(balance(h.state().starWallet),1);
  assert.ok(Date.parse(h.state().starWallet.entries[0].earnedAt)<Date.parse(scheduledAt));
  const old=harness(directory,{...defaultState(),plans:[planFor(r)],doses:[record]});
  old.call('state:save',plain(old.state()));assert.equal(balance(old.state().starWallet),0);
  old.call('state:save',{...plain(old.state()),doses:[{...record,id:'renamed-history'}]});assert.equal(balance(old.state().starWallet),0);
}));
test('IPC reward preview is read-only and the optional save report describes the committed reward',()=>fixture(directory=>{
  const r=receipt('preview'),h=harness(directory,{...defaultState(),reminderLog:[r]}),record=dose('preview-dose',r);
  const before=fs.readFileSync(h.store.file,'utf8');
  assert.deepEqual(h.call('dose:reward-preview',record),{doseId:record.id,code:'awarded',amount:1});
  assert.equal(fs.readFileSync(h.store.file,'utf8'),before);assert.equal(h.state().doses.length,0);assert.equal(h.broadcasts.length,0);
  const result=h.call('state:save',{...plain(h.state()),doses:[record]},{reportDoseId:record.id});
  assert.deepEqual(result.reward,{doseId:record.id,code:'awarded',amount:1});assert.equal(balance(result.state.starWallet),1);
  assert.equal(balance(createStateStore(directory).load().state.starWallet),1);
  const ordinary=h.call('state:save',plain(h.state()));assert.equal(ordinary,h.state());assert.equal(ordinary.starWallet.entries.length,1);assert.equal(ordinary.state,undefined);
}));
test('IPC reported ambiguous plan matching leaves disk and live state unchanged until a plan is selected',()=>fixture(directory=>{
  const a=receipt('one'),b=receipt('two'),h=harness(directory,{...defaultState(),reminderLog:[a,b]}),record=dose('choose-plan',a,{planId:undefined});
  const before=fs.readFileSync(h.store.file,'utf8');
  assert.equal(h.call('dose:reward-preview',record).code,'ambiguous');
  assert.throws(()=>h.call('state:save',{...plain(h.state()),doses:[record]},{reportDoseId:record.id}),/多个相同的提醒/);
  assert.equal(fs.readFileSync(h.store.file,'utf8'),before);assert.equal(h.state().doses.length,0);assert.equal(h.broadcasts.length,0);
  const saved=h.call('state:save',{...plain(h.state()),doses:[{...record,planId:b.planId}]},{reportDoseId:record.id});
  assert.equal(saved.reward.code,'awarded');assert.equal(saved.state.starWallet.entries[0].planId,b.planId);
}));
test('optional reward growth never makes an otherwise valid clinical save exceed its byte budget',()=>fixture(directory=>{
  const r=receipt(),initial={...defaultState(),reminderLog:[r]},incoming={...plain(initial),doses:[dose('first',r)]};
  const h=harness(directory,initial,Buffer.byteLength(JSON.stringify(incoming,null,2))+32);
  const saved=h.call('state:save',incoming,{reportDoseId:'first'});assert.equal(h.state().doses.length,1);assert.equal(balance(h.state().starWallet),0);
  assert.deepEqual(plain(saved.reward),{doseId:'first',code:'capacity',amount:0});
  assert.equal(h.broadcasts.filter(e=>e.channel==='pet:action'&&e.value.action==='star-reward').length,0);
}));
test('atomic IPC reward saving handles failure and concurrent stale renderers before broadcasting or restart',()=>fixture(async directory=>{
  const r=receipt(),initial={...defaultState(),reminderLog:[r]},h=harness(directory,initial),incoming={...plain(initial),doses:[dose('first',r)]};
  h.disk.fail=true;assert.throws(()=>h.call('state:save',incoming),/Disk full/);assert.equal(balance(h.state().starWallet),0);assert.equal(h.broadcasts.length,0);
  h.disk.fail=false;
  const other={...plain(initial),doses:[dose('second',r)]};
  await Promise.all([incoming,other].map(value=>Promise.resolve().then(()=>h.call('state:save',value))));
  assert.equal(balance(h.state().starWallet),1);assert.equal(h.broadcasts.filter(e=>e.channel==='pet:action'&&e.value.action==='star-reward').length,1);
  const persisted=createStateStore(directory).load().state;assert.equal(balance(persisted.starWallet),1);assert.equal(persisted.starWallet.entries[0].doseId,'first');
  const restarted=harness(directory,persisted);restarted.call('state:save',{...plain(persisted),doses:[]});assert.equal(balance(restarted.state().starWallet),1);
  restarted.call('state:save',{...plain(restarted.state()),doses:[dose('recreated',r)]});assert.equal(balance(restarted.state().starWallet),1);
}));
test('real import/export IPC merges earned currency without awarding imported doses or reopening a day',()=>fixture(async directory=>{
  const a=receipt('a'),h=harness(directory,{...defaultState(),reminderLog:[a]});h.call('state:save',{...plain(h.state()),doses:[dose('a',a)]});
  await h.call('data:export');assert.equal(balance(parseState(fs.readFileSync(path.join(directory,'export.json'),'utf8')).starWallet),1);
  const imported=defaultState(),b=receipt('b',{amount:2});imported.reminderLog=[b];imported.doses=[dose('imported-dose',b)];
  fs.writeFileSync(path.join(directory,'import.json'),JSON.stringify(imported));await h.call('data:import');assert.equal(balance(h.state().starWallet),1);
  h.call('state:save',plain(h.state()));assert.equal(balance(h.state().starWallet),1);
  imported.starWallet=walletFor(b,'different-dose');fs.writeFileSync(path.join(directory,'import.json'),JSON.stringify(imported));await h.call('data:import');assert.equal(balance(h.state().starWallet),2);
  await h.call('data:import');assert.equal(balance(h.state().starWallet),2);
}));
