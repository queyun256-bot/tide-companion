import { MEDICATIONS as PROFILES, getMedication as getProfile, ADMINISTRATIONS, medicationsForAdministration } from './medications.js';
import { mountAdministrationPicker } from './administration-picker.js';
import { mountDatePickers, closeDatePickers, isDatePickerEditing } from './date-picker.js';
import { administrationIcon } from './medication-icons.js';
import { localDateKey, dateFromKey, dailyMood, moveMonth } from './journal.js';
import { calendarPage, dailyMoodPanel } from './calendar.js';
import { getBuiltinShark, isBuiltinShark } from './shark-variants.js';
import { renderSkinGallery } from './skin-gallery.js';
import { LIVE2D_ENABLED, visibleSkinId } from './skin-features.js';
import './pet-preview.js';
import { renderStarWallet, renderStarWalletSummary } from './star-wallet-ui.js';
import { installStarFeeding, isStarFeedDragging } from './star-feeding.js';
import { normalizeLab } from './pk.js';
import { MAHIRO_SOURCE } from './pk-mahiro.js';
import { REFERENCE_BASELINES } from './hormones.js';
import referencePresets from './reference-presets.json' with { type: 'json' };
import { engineFor, hormoneCards, hormoneChart, bindChart, isChartDragging, statusLabel, visibleAnalytes, sampleReason } from './chart.js';

const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const nowISO = () => new Date().toISOString();
const id = () => crypto.randomUUID();
const stamp = (v, short = false) => new Date(v).toLocaleString('zh-CN', {month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit', ...(short ? {} : {year:'numeric'})});
const localInput = v => { const d = new Date(v || Date.now()); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0,16); };
const label = a => ({estradiol:'雌二醇 E2',testosterone:'总睾酮 T',cpa:'醋酸环丙孕酮 CPA'})[a] || a;
const requiresDuration = p => p?.model==='infusion'||p?.kernelKind==='patch';
const blank = () => ({schemaVersion:1,settings:{name:'鲨鲨',pronouns:'',mode:'mtf',onboardingCompleted:false,showFtmEstradiol:false,autoHideFullscreen:true,activeSkin:'builtin',skinScale:1,alwaysOnTop:true,launchAtLogin:false,notifications:true,privateNotifications:true,petVisible:true,reducedMotion:false},plans:[],doses:[],labs:[],modelConfigs:{},pkSettings:{bodyWeightKg:70,sublingualFraction:.11},baselines:{estradiol:0,testosterone:0},moods:[],dailyMoods:[],reminderLog:[],starWallet:{version:1,entries:[]},referenceBaselines:{...REFERENCE_BASELINES.mtf},referenceBaselineCustomized:false,referencePresetVersion:referencePresets.version});
let state = blank(), page = 'overview', routeId = 'e2-oral', days = 3, toastTimer, savePending = false, renderedPage = null, renderQueued = false;
let journalDate = localDateKey(), moodPending = false;
let skinCatalog = null;
const native = window.petAPI;
let runtime = { id: 'unknown', label: '桌面', fullscreenDetection: false, automaticLoginSettings: false };
const starFeeding = installStarFeeding({ root: document, api: native });
const nav = [['overview','概览','home'],['calendar','日历','calendar'],['plans','用药计划','plan'],['curves','浓度曲线','chart'],['labs','化验与校准','lab'],['settings','桌宠与设置','heart']];
const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${({home:'<path d="m3 10 9-7 9 7v10H3Z"/><path d="M9 20v-7h6v7"/>',plan:'<rect x="4" y="4" width="16" height="17" rx="3"/><path d="M8 2v4h8V2M8 11h8M8 16h5"/>',calendar:'<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 2v6M17 2v6M3 11h18M8 15h2M14 15h2"/>',chart:'<path d="M3 3v18h18M6 16l5-6 4 3 6-9"/>',lab:'<path d="M9 3h6M10 3v7L4 19q-1 2 2 2h12q3 0 2-2l-6-9V3M8 15h8"/>',heart:'<path d="M20 5c-3-3-6-1-8 1-2-2-5-4-8-1-5 5 8 15 8 15S25 10 20 5Z"/>'})[name]}</svg>`;
const btn = (text, action, cls = '', extra = '') => `<button type="button" class="btn ${cls}" data-action="${action}" ${extra}>${text}</button>`;
const empty = (title, text, action = '') => `<div class="empty"><span class="empty-symbol">○</span><strong>${title}</strong>${text}${action ? `<div class="spaced-15">${action}</div>` : ''}</div>`;
const field = (title, body, full = false, note = '') => `<label class="field ${full ? 'full' : ''}"><span>${title}</span>${body}${note ? `<small>${note}</small>` : ''}</label>`;
const textInput = (name, value = '', extra = '') => `<input name="${name}" value="${esc(value)}" ${extra}>`;
const motionPreference = matchMedia('(prefers-reduced-motion: reduce)');
const activeMotions = new Set();
let modalOpener = null, modalClose = null;
const motionAllowed = () => !state.settings.reducedMotion && !motionPreference.matches;
const petPreview = (cls = "") => `<tide-pet-preview class="${cls}" name="${esc(state.settings.name)}" skin="${esc(visibleSkinId(state.settings.activeSkin))}" mode="${esc(state.settings.mode)}" reduced-motion="${!motionAllowed()}" data-star-feed-target data-action="pet"></tide-pet-preview>`;
function cancelMotion(scope) {
  for (const entry of [...activeMotions]) if (!scope || entry.scope === scope) entry.animation.cancel();
}
function syncMotion() {
  document.body.classList.toggle('no-motion', !motionAllowed());
  if (!motionAllowed()) cancelMotion();
}
function animateUI(element, keyframes, {scope='page',name='reveal',duration=260,delay=0}={}) {
  if (!element || !motionAllowed()) return null;
  const animation=element.animate(keyframes,{duration,delay,easing:'cubic-bezier(.22,.72,.25,1)',fill:'none'});
  animation.id=`tide-${name}`;
  const entry={animation,element,scope};activeMotions.add(entry);
  const cleanup=()=>{activeMotions.delete(entry);if(name==='page-reveal')element.classList.remove('page-enter');};
  animation.addEventListener('finish',cleanup,{once:true});
  animation.addEventListener('cancel',cleanup,{once:true});
  return animation;
}
function revealPage() {
  const view=$('.page-view');if(!motionAllowed()||!view)return;
  view.classList.add('page-enter');
  // The chart's coordinates and marker stay fixed; only its paths reveal horizontally.
  animateUI(view,page==='curves'?[{opacity:.65},{opacity:1}]:[{opacity:0,transform:'translateY(7px)'},{opacity:1,transform:'translateY(0)'}],{name:'page-reveal',duration:280});
  if(page==='curves')animateUI($('.chart-series'),[{clipPath:'inset(0 100% 0 0)',transform:'translateX(-7px)'},{clipPath:'inset(0 0% 0 0)',transform:'translateX(0)'}],{name:'curve-reveal',duration:650});
}
motionPreference.addEventListener('change',syncMotion);
function toast(message) {
  const el=$('#toast');cancelMotion('toast');el.textContent=message;el.classList.add('show');clearTimeout(toastTimer);
  animateUI(el,[{opacity:0,transform:'translateX(-50%) translateY(7px)'},{opacity:1,transform:'translateX(-50%) translateY(0)'}],{scope:'toast',name:'toast-reveal',duration:200});
  toastTimer=setTimeout(()=>el.classList.remove('show'),4200);
}
async function save(next = state, doseId) {
  if (savePending) throw new Error('上一项修改正在保存，请稍后再试。');
  savePending = true; document.body.classList.add('is-saving');
  try {
  if (native && doseId) {
    const result = await native.saveDoseState(next,doseId);
    state = result.state;
    return result.reward;
  }
  else if (native) state = await native.saveState(next);
  else throw new Error('请在潮汐桌面程序中保存记录。');
  } finally { savePending = false; document.body.classList.remove('is-saving'); render(); }
}
function nextTime(p) { const start = +new Date(p.startAt), step = p.intervalHours * 3600000; return new Date(start + Math.max(0, Math.ceil((Date.now() - start) / step)) * step).toISOString(); }
function orderedPlans() { return state.plans.filter(p => p.enabled).sort((a,b) => +new Date(nextTime(a)) - +new Date(nextTime(b))); }
function analysis() { return engineFor(state).at(nowISO()); }
const visibleKeys = () => visibleAnalytes(state.settings.mode,state.settings.showFtmEstradiol);
const analyteToggle = () => state.settings.mode==='ftm'?`<label class="analyte-toggle"><input type="checkbox" data-setting="showFtmEstradiol" ${state.settings.showFtmEstradiol?'checked':''}>同时查看雌二醇 E2</label>`:'';
function currentSummary() { return analyteToggle()+hormoneCards(analysis(),visibleKeys()); }

function render() {
  if (isStarFeedDragging()) { renderQueued = true; return; }
  syncMotion();
  if(isChartDragging()||isDatePickerEditing()){renderQueued=true;return;}
  renderQueued=false;
  const pageChanged=renderedPage!==null&&renderedPage!==page;
  const chartHadFocus=document.activeElement?.id==='hormone-chart-svg';
  const focus=document.activeElement;
  const journalFocus=page==='calendar'&&!pageChanged&&focus?.closest('.journal-layout')?{action:focus.dataset.action,id:focus.dataset.id,elementId:focus.id}:null;
  renderedPage=page;
  cancelMotion('page');
  document.body.dataset.mode=state.settings.mode||'mtf';
  $('#app').innerHTML = `<div class="shell"><aside class="sidebar"><div class="brand"><span class="brand-icon">≈</span><span class="brand-text">潮汐<small>TIDE</small></span></div><div class="mode-switch" aria-label="模式与主题"><button data-action="mode-mtf" aria-pressed="${state.settings.mode!=='ftm'}">MTF</button><button data-action="mode-ftm" aria-pressed="${state.settings.mode==='ftm'}">FTM</button></div><div class="nav-label">日常记录</div><nav class="nav">${nav.map(([key,name,i]) => `<button data-page="${key}" class="${page===key?'active':''}" ${page===key?'aria-current="page"':''} title="${name}">${icon(i)}<span>${name}</span></button>`).join('')}</nav><div class="side-bottom"><div class="flag" aria-label="跨性别旗帜"><i></i><i></i><i></i><i></i><i></i></div><p>按自己的节奏就好。</p><p>v0.9.2 · ${esc(runtime.label)}</p></div></aside><main class="content"><header class="topbar"><span>${new Date().toLocaleDateString('zh-CN',{year:'numeric',month:'long',day:'numeric',weekday:'long'})}</span><div class="top-actions"><span class="local-badge"><i class="dot"></i>本机保存</span><span class="avatar">♡</span></div></header>${state.settings.onboardingCompleted?'':`<div class="setup-reminder"><span>确认模式与模型体重后，就可以开始记录。</span>${btn('完成初始设置','onboarding','secondary small')}</div>`}<div class="page-view" data-page-view="${page}">${({overview:overview,calendar:()=>calendarPage(state,journalDate,moodPending),plans:plansPage,curves:curvesPage,labs:labsPage,settings:settingsPage})[page]()}</div><div class="footer-note">本机记录 · 随时可以导出备份</div></main></div>`;
  starFeeding.recheck();
  bindChart();
  mountDatePickers($('#app'));
  if(journalFocus){
    const element=journalFocus.elementId?document.getElementById(journalFocus.elementId):[...document.querySelectorAll('.journal-layout [data-action]')].find(el=>el.dataset.action===journalFocus.action&&el.dataset.id===journalFocus.id);
    if(element&&!element.disabled)element.focus({preventScroll:true});
  }
  if(chartHadFocus&&!pageChanged)$('#hormone-chart-svg')?.focus({preventScroll:true});
  if(pageChanged)revealPage();
  if(page==='settings')loadSkins();
}

function title(heading, description, action = '') {return `<div class="page-title"><div><h1>${heading}</h1><p class="muted">${description}</p></div>${action}</div>`;}
function overview() {
  const upcoming=orderedPlans(),recent=state.doses.filter(d=>new Date(d.at).toDateString()===new Date().toDateString());
  return `${title('今天',`${esc(state.settings.name)}在桌面上，日常记录在这里。`,btn('＋ 记录使用','dose'))}<section class="hero"><div class="hero-copy"><span class="eyebrow">A LITTLE PAUSE</span><h2>留一点时间，<br>给自己。</h2><p>记下一次用药，或只是和${esc(state.settings.name)}待一会儿。</p>${renderStarWalletSummary(state)}<div class="button-row">${btn('看看桌宠 ↗','show-pet')}${btn('摸摸 ♡','pet','secondary')}</div></div><div class="hero-art">${petPreview()}</div></section>${currentSummary()}<div class="grid-main"><section class="card"><div class="card-head"><h2>浓度曲线</h2>${btn('完整曲线 ↗','curves','ghost small')}</div>${hormoneChart(state,3,true,visibleKeys())}<p class="muted">参考估计与个人校准分开标注；实测点始终保留。</p></section><section class="card"><div class="card-head"><h2>接下来的提醒</h2>${btn('所有计划','plans','ghost small')}</div>${upcoming.length?upcoming.slice(0,3).map(planRow).join(''):empty('还没有提醒计划',`可以设置固定间隔，由${esc(state.settings.name)}提醒你。`,btn('＋ 添加提醒','plan','secondary small'))}<div class="mini-message">今天已记录 ${recent.length} 次使用 · ${state.labs.filter(l=>localDateKey(l.at)===localDateKey()).length} 条化验${dailyMoodPanel(state,localDateKey(),moodPending,true)}${btn('查看日历 ↗','calendar','ghost small')}</div></section></div><div class="notice">未校准参考值采用资料锚点与假设背景，并非你的实测结果。MTF / FTM 不足以决定个人激素水平；可在模型设置中修改假设。</div>`;
}

function planRow(p) {return `<div class="list-row"><span class="row-icon route-symbol">${administrationIcon(getProfile(p.routeId)?.administrationId,{size:24})}</span><div class="row-text"><strong>${esc(p.name)}</strong><span>${stamp(nextTime(p),true)} · 每 ${p.intervalHours} 小时</span></div>${btn('记录','dose','secondary small',`data-id="${p.id}"`)}</div>`;}
function plansPage() {
  return `${title('用药记录与提醒','固定间隔提醒；按你已有的用药方案填写。',btn('＋ 新建提醒','plan'))}<div class="page-stack"><section>${state.plans.length?state.plans.map(p=>`<article class="card plan-card"><div class="list-row"><span class="row-icon route-symbol">${administrationIcon(getProfile(p.routeId)?.administrationId,{size:24})}</span><div class="row-text"><strong>${esc(p.name)} <span class="pill ${p.enabled?'green':''}">${p.enabled?'已启用':'已暂停'}</span></strong><span>${esc(getProfile(p.routeId)?.name)} · ${p.amount} ${esc(getProfile(p.routeId)?.unit)} · 每 ${p.intervalHours} 小时${p.durationHours?' · 佩戴 '+p.durationHours+' 小时':''}</span><span>${p.enabled?'下次 '+stamp(nextTime(p)):'提醒暂停中'}</span></div><div class="button-row">${btn('记录使用','dose','secondary small',`data-id="${p.id}"`)}${btn('编辑','plan','ghost small',`data-id="${p.id}"`)}${btn(p.enabled?'暂停':'启用','toggle-plan','ghost small',`data-id="${p.id}"`)}${btn('删除','delete-plan','ghost small',`data-id="${p.id}"`)}</div></div></article>`).join(''):`<div class="card">${empty('还没有提醒计划','提醒设置独立于使用记录。你可以先记录历史，也可以从设置提醒开始。',btn('＋ 创建计划','plan','secondary'))}</div>`}</section><section class="card"><div class="card-head"><h2>实际使用记录</h2>${btn('＋ 补充记录','dose','secondary small')}</div>${doseTable()}</section><section class="card"><div class="card-head"><h2>最近提醒</h2><span class="pill">不代表已经使用</span></div>${state.reminderLog.length?state.reminderLog.slice(-8).reverse().map(r=>`<div class="list-row"><span class="row-icon">◷</span><div class="row-text"><strong>${esc(state.plans.find(p=>p.id===r.planId)?.name||'已删除的计划')}</strong><span>原定 ${stamp(r.scheduledAt)} · ${r.status==='missed'?'启动或唤醒后补发提醒':'已提交提醒'}</span></div></div>`).join(''):empty('提醒会出现在这里','软件在托盘运行时可发出提醒；完全退出或关机期间无法实时提醒。')}</section></div><div class="notice">关闭管理窗口后程序留在系统托盘继续运行。关机、睡眠或退出期间不会发出实时提醒；恢复运行后只汇总最近一次到期事项，不自动补记使用，也不建议补用。</div>`;
}
function doseTable() {return state.doses.length?`<div class="table-scroll"><table class="history"><thead><tr><th>实际时间</th><th>给药方式</th><th>记录用量</th><th>佩戴时长</th><th></th></tr></thead><tbody>${[...state.doses].sort((a,b)=>new Date(b.at)-new Date(a.at)).slice(0,200).map(d=>`<tr><td>${stamp(d.at)}${new Date(d.at)>new Date()?'<small class="future-record">未发生 · 暂不计入估算</small>':''}</td><td><span class="medication-route-label">${administrationIcon(getProfile(d.routeId)?.administrationId,{size:20})}<span>${esc(getProfile(d.routeId)?.name)}</span></span></td><td>${d.amount} ${esc(getProfile(d.routeId)?.unit)}</td><td>${d.durationHours?d.durationHours+' h':'—'}</td><td>${btn('编辑','edit-dose','ghost small',`data-id="${d.id}"`)}${btn('删除','delete-dose','ghost small',`data-id="${d.id}"`)}</td></tr>`).join('')}</tbody></table></div>${state.doses.length>200?'<p class="muted">显示最近 200 条，模型使用完整历史。</p>':''}`:empty('还没有实际使用记录','只有明确记录的实际使用，才会进入浓度模型。');}

function curvesPage() {
  const results=analysis(),keys=visibleKeys(),ftm=state.settings.mode==='ftm';
  const axis=ftm?(state.settings.showFtmEstradiol?'T 左轴 / E2 右轴':'T · ng/dL'):'E2 左轴 / CPA 右轴';
  return `${title('浓度曲线','身体的潮汐',btn('＋ 记录使用','dose'))}${analyteToggle()}${hormoneCards(results,keys,{referenceMode:state.settings.mode})}<section class="card"><div class="card-head"><div class="chart-controls"><span class="pill">${axis}</span><select id="chart-days" aria-label="图表时间范围">${[1,3,7,14,30].map(d=>`<option value="${d}" ${days===d?'selected':''}>${d} 天视图</option>`).join('')}</select></div>${btn('模型与参考背景','model','secondary small')}</div>${hormoneChart(state,days,false,keys)}<p class="muted">右键按住并左右拖动标线；也支持选中图表后按方向键。未来虚线假设不追加给药。</p></section><div class="notice">${keys.map(k=>`<details><summary>${label(k)} · ${statusLabel(results[k].status)}</summary><p>${esc(results[k].warnings.join(' '))}</p></details>`).join('')}</div><div class="notice warm">CPA 曲线表示药物本身的参考浓度（ng/mL）。CPA、雌二醇和睾酮之间的内分泌抑制及芳香化未建模；请结合实测结果理解。</div>`;
}

function labFitStatus(lab,result) {
  const calibration=result?.calibration||{};
  const diagnostic=calibration.sampleDiagnostics?.find(sample=>sample.id===lab.id);
  if(diagnostic)return esc(diagnostic.status==='included'?'已参与校准':sampleReason(diagnostic.reasonCode));
  if(calibration.sampleTimes?.includes(new Date(lab.at).toISOString()))return '已参与校准';
  return '未参与校准 · 见上方说明';
}
function labsPage() {
  const results=analysis(),keys=visibleKeys(),visibleLabs=state.labs.filter(l=>keys.includes(l.analyte));
  return `${title('化验与校准','填写采血时间、结果及单位，各检测项目分别校准。',btn('＋ 添加化验','lab'))}${analyteToggle()}<div class="page-stack"><section class="card"><div class="card-head"><h2>个人校准</h2>${btn('参考背景与模型','model','secondary small')}</div>${hormoneCards(results,keys)}<div class="calibration-grid">${keys.map(k=>{const a=results[k],c=a.calibration||{};return `<div><h3>${label(k)}</h3><p class="muted">有效样本 ${c.n||0} · 拟合 RMSE ${Number.isFinite(c.rmse)?c.rmse.toFixed(1)+' '+a.unit:'—'}</p><p class="muted">${esc(a.warnings.join(' '))}</p></div>`;}).join('')}</div><p class="muted">各项目按总参考贡献拟合一个幅度；不会按不同途径重复加入背景。CPA 的固定背景为 0。</p></section><section class="card"><div class="card-head"><h2>化验记录</h2><small>以采血时刻为准</small></div>${visibleLabs.length?`<div class="table-scroll"><table class="history"><thead><tr><th>采血时间</th><th>项目</th><th>测定结果</th><th>校准状态</th><th></th></tr></thead><tbody>${[...visibleLabs].sort((a,b)=>new Date(b.at)-new Date(a.at)).map(l=>`<tr><td>${stamp(l.at)}</td><td>${label(l.analyte)}</td><td>${l.value} ${esc(l.unit)}</td><td class="lab-fit-status">${labFitStatus(l,results[l.analyte])}</td><td>${btn('删除','delete-lab','ghost small',`data-id="${l.id}"`)}</td></tr>`).join('')}</tbody></table></div>`:empty('当前显示项目还没有化验结果','切换显示项目不会删除已有记录。尚未校准时仍可查看明确标注的参考估计。')}</section></div>`;
}

function settingsPage() {
  const settings=[['alwaysOnTop','桌宠保持置顶','陪在其他窗口上方'],['autoHideFullscreen','全屏时自动隐藏','前台游戏、视频或无边框全屏窗口下隐藏，退出全屏后恢复'],['notifications','系统通知',`需要 ${runtime.label} 允许通知`],['privateNotifications','通知隐私模式','不显示药物名称与剂量'],['launchAtLogin',`登录 ${runtime.label} 时启动`,'仅打包后的程序支持'],['reducedMotion','减少动画','关闭界面过渡与桌宠的持续动作']].filter(([key])=>(key!=='autoHideFullscreen'||runtime.fullscreenDetection)&&(key!=='launchAtLogin'||runtime.automaticLoginSettings));
  const platformHelp = runtime.id==='darwin' ? '<p class="muted">macOS 版暂不自动检测其他应用的全屏状态，需要时可从菜单栏隐藏桌宠。登录时启动可在系统设置的“通用 → 登录项”中添加潮汐。</p>' : '';
  return `${title('桌宠与设置','名字、外观和提醒方式，都可以在这里调整。')}<div class="settings-grid"><section class="card"><div class="card-head"><h2>${esc(state.settings.name)}</h2>${btn('修改名字','rename','ghost small')}</div>${petPreview("settings-pet-preview")}<p class="skin-preview-label">${esc(isBuiltinShark(visibleSkinId(state.settings.activeSkin))?getBuiltinShark(visibleSkinId(state.settings.activeSkin)).personality:'本机 Live2D')}</p><div class="care-grid"><button class="care-btn" data-action="pet"><span>♡</span>摸摸</button><button class="care-btn" data-action="stars"><span>✧</span>星星</button><button class="care-btn" data-action="sleep"><span>☾</span>打盹</button></div><div class="button-row spaced-20">${btn('显示桌宠','show-pet','secondary')}${btn('隐藏桌宠','hide-pet','ghost')}</div></section><section class="card"><h2>使用偏好</h2>${platformHelp}${settings.map(([key,name,help])=>`<label class="setting-line"><div>${name}<p>${help}</p></div><input type="checkbox" data-setting="${key}" ${state.settings[key]?'checked':''} aria-label="${name}"></label>`).join('')}<div class="button-row spaced-18">${btn('测试提醒','test-notify','secondary small')}${btn('初始设置：模式与体重','onboarding','ghost small')}</div></section>${renderStarWallet(state)}<section class="card skin-card"><div class="card-head"><h2>桌宠换肤</h2><span class="pill">五种颜色 · 各自的小习惯</span></div><div id="skin-list">${skinCatalog?renderSkinGallery({skins:skinCatalog,activeSkin:state.settings.activeSkin},{petName:state.settings.name}):'正在读取本机皮肤…'}</div>${LIVE2D_ENABLED?`<label class="setting-line"><div>模型缩放<p>适配不同模型的画布比例</p></div><select id="skin-scale" aria-label="模型缩放">${[.5,.75,1,1.25,1.5,2].map(n=>`<option value="${n}" ${state.settings.skinScale===n?'selected':''}>${n}×</option>`).join('')}</select></label><p class="muted">支持 Cubism 3/4 的 model3 格式；部分新版本渲染特性不兼容时会提示并显示默认鲨鱼。</p>`:""}</section><section class="card"><h2>数据属于你</h2><p class="muted">健康数据只在本机保存，无账号和云同步。备份为可读 JSON，请妥善保存。</p><div class="button-row">${btn('导出备份','export','secondary')}${btn('导入备份','import','ghost')}</div><p class="muted">皮肤素材单独保存在本机，不包含于健康数据备份。</p><div class="help-links"><button data-source="https://transcare.ucsf.edu/guidelines/feminizing-hormone-therapy">UCSF · 女性化激素治疗 ↗</button><button data-source="https://transcare.ucsf.edu/guidelines/masculinizing-therapy">UCSF · 男性化激素治疗 ↗</button></div><p class="muted">v0.9.2 · 个人记录与模型探索工具。</p></section></div>`;
}
async function loadSkins(){
  const holder=$('#skin-list');if(!holder)return;
  try{
    const data=await native.listSkins();
    const changed=JSON.stringify(skinCatalog)!==JSON.stringify(data.skins);
    skinCatalog=data.skins;
    if(!holder.isConnected)return;
    if(changed||!holder.querySelector('.shark-collection'))holder.innerHTML=renderSkinGallery({...data,activeSkin:state.settings.activeSkin},{petName:state.settings.name});
  }catch(error){holder.textContent=error.message;}
}

function modal(titleText, description, fields, handler, buttonText='保存', options={}) {
  const el=$('#modal');
  cancelMotion('dialog');modalClose=null;el.classList.remove('modal-leaving');
  el.classList.toggle('onboarding-modal',options.onboarding===true);
  el.dataset.purpose=options.onboarding?'onboarding':'form';
  const opener=document.activeElement;
  modalOpener={element:opener,action:opener?.dataset.action,id:opener?.dataset.id,page:opener?.dataset.page};
  el.innerHTML=`${options.onboarding?'<div class="onboarding-welcome" aria-hidden="true"><img src="assets/shark.svg" alt=""><span>欢迎来到潮汐</span></div>':''}<h2 id="modal-title">${titleText}</h2><p class="muted" id="modal-description">${description}</p><form id="dialog-form"><div class="form-grid">${fields}</div><div class="error" role="alert"></div><div class="form-footer">${btn(options.onboarding?'稍后设置':'取消','close-modal','ghost')}<button type="submit" class="btn">${buttonText}</button></div></form>`;
  el.setAttribute('aria-describedby','modal-description');
  $('#dialog-form').addEventListener('submit',async event=>{event.preventDefault();const button=event.submitter;button.disabled=true;try{await handler(new FormData(event.target));await closeModal();}catch(error){el.querySelector('.error').textContent=error.message;}finally{button.disabled=false;}});
  el.showModal();
  mountDatePickers(el);
  el.scrollTop=0;
  if(options.onboarding)el.querySelector('[name="mode"]:checked')?.focus({preventScroll:true});
  animateUI(el,[{opacity:0,transform:'translateY(10px) scale(.985)'},{opacity:1,transform:'translateY(0) scale(1)'}],{scope:'dialog',name:'dialog-reveal',duration:240});
}
function closeModal() {
  const el=$('#modal');if(!el.open)return Promise.resolve();if(modalClose)return modalClose;
  closeDatePickers();
  const computed=getComputedStyle(el),from={opacity:computed.opacity,transform:computed.transform==='none'?'translateY(0)':computed.transform};
  cancelMotion('dialog');el.classList.add('modal-leaving');
  const animation=animateUI(el,[from,{opacity:0,transform:'translateY(5px)'}],{scope:'dialog',name:'dialog-dismiss',duration:120});
  modalClose=(animation?animation.finished.catch(()=>{}):Promise.resolve()).then(()=>{el.close();el.classList.remove('modal-leaving');modalClose=null;});
  return modalClose;
}
function withMode(next,mode) {
  const previousMode=next.settings.mode||'mtf';
  return {...next,settings:{...next.settings,mode},referenceBaselines:next.referenceBaselineCustomized?{...(next.referenceBaselines||REFERENCE_BASELINES[previousMode])}:{...REFERENCE_BASELINES[mode]},referencePresetVersion:referencePresets.version};
}
function onboardingForm() {
  const currentMode=state.settings.mode||'mtf';
  const choices=[['mtf','MTF','粉色界面 · 雌二醇与 CPA'],['ftm','FTM','蓝色界面 · 总睾酮，可选雌二醇']];
  const modeFields=`<fieldset class="onboarding-mode field full"><legend>选择使用模式</legend><div class="onboarding-choices">${choices.map(([value,name,detail])=>`<label class="onboarding-choice ${value}"><input type="radio" name="mode" value="${value}" ${currentMode===value?'checked':''} required><span><strong>${name}</strong><small>${detail}</small></span></label>`).join('')}</div><small>模式决定界面配色与默认显示项目，之后可在左上角切换。</small></fieldset>`;
  modal('先确认两项设置','设置和记录保存在本机，之后都可以修改。',modeFields+field('药代模型体重（kg）',textInput('bodyWeightKg',state.pkSettings?.bodyWeightKg??70,'type="number" min="20" max="400" step="any" inputmode="decimal" required aria-describedby="onboarding-weight-note"'),true,'<span id="onboarding-weight-note">体重用于药代模型的参考计算，请确认或修改当前数值。可填写 20–400 kg。</span>'),async form=>{
    const mode=form.get('mode'),bodyWeightKg=Number(form.get('bodyWeightKg'));
    if(!['mtf','ftm'].includes(mode))throw new Error('请选择 MTF 或 FTM。');
    if(!Number.isFinite(bodyWeightKg)||bodyWeightKg<20||bodyWeightKg>400)throw new Error('请填写 20–400 kg 之间的体重。');
    const next=withMode(state,mode);
    await save({...next,settings:{...next.settings,onboardingCompleted:true},pkSettings:{...next.pkSettings,bodyWeightKg}});
    routeId=mode==='ftm'?'t-enanthate-im':'e2-oral';
    toast('设置已保存。');
  },'开始使用',{onboarding:true});
}
const medicationOptions = (administrationId,selected) => medicationsForAdministration(administrationId).map(p=>`<option value="${p.id}" ${p.id===selected?'selected':''}>${esc(p.drugName)}</option>`).join('');
function medicationPreview(p) {
  if(!p)return '<span>请选择给药方式与药物。</span>';
  return `<span class="medication-symbol" aria-hidden="true">${administrationIcon(p.administrationId,{size:32})}</span><div class="medication-copy"><strong>${esc(p.drugName)}</strong><small>代表药品：${esc(p.brands||'以产品标示为准')}</small>${p.offLabel?'<span class="medication-caution">非说明书给药方式</span>':''}${p.model==='record-only'?'<span class="medication-caution">仅记录与提醒 · 模型待核查</span>':'<span class="medication-model">参考估算 · 可用化验校准</span>'}<p>${esc(p.note||'')}</p></div>`;
}
function routeFields(selected, amount='', duration='') {
  const p=getProfile(selected)||getProfile(routeId)||PROFILES[0];
  return `<div class="field"><span id="form-administration-label">给药方式</span><span class="administration-select"><span class="administration-select-icon" id="form-administration-icon">${administrationIcon(p.administrationId,{size:20})}</span><select name="administrationId" id="form-administration" aria-labelledby="form-administration-label" required>${ADMINISTRATIONS.map(a=>`<option value="${a.id}" ${a.id===p.administrationId?'selected':''}>${esc(a.name)}</option>`).join('')}</select></span></div>`+field('药物',`<select name="routeId" id="form-route" required>${medicationOptions(p.administrationId,p.id)}</select>`)+`<div class="medication-preview field full" id="medication-preview" role="status" aria-live="polite">${medicationPreview(p)}</div>`+field(`用量（<span id="dose-unit">${esc(p.unit)}</span>）`,textInput('amount',amount,'type="number" min="0.000001" max="100000" step="any" required placeholder="按实际使用填写"'),false,'按所选单位填写有效药物或酯的量；凝胶不是克数。')+`<label class="field" id="duration-field" ${requiresDuration(p)?'':'hidden'}><span>本次贴片佩戴时长（小时）</span>${textInput('durationHours',duration,'type="number" min="0.01" max="8760" step="any" placeholder="请明确填写"')}<small>提前移除时需更新为实际时长。</small></label>`;
}
function wireRoute() {
  const form=$('#dialog-form'),medication=$('#form-route'),administration=$('#form-administration');
  const update=(clear=false)=>{const p=getProfile(medication.value);$('#dose-unit').textContent=p?.unit||'';$('#duration-field').hidden=!requiresDuration(p);form.elements.durationHours.required=requiresDuration(p);$('#medication-preview').innerHTML=medicationPreview(p);$('#form-administration-icon').innerHTML=administrationIcon(p?.administrationId,{size:20});if(clear){form.elements.amount.value='';form.elements.durationHours.value='';}};
  administration.addEventListener('change',()=>{
    const previous=getProfile(medication.value),choices=medicationsForAdministration(administration.value);
    const preferred=choices.find(p=>p.drugName===previous?.drugName)||choices.find(p=>p.analyte===previous?.analyte)||choices[0];
    medication.innerHTML=medicationOptions(administration.value,preferred?.id);update(true);
  });
  medication.addEventListener('change',()=>update(true));
  update();
  mountAdministrationPicker(administration);
}
function doseForm(planId,editId,initialAt) {
  const editing=state.doses.find(d=>d.id===editId);
  const p=editing||state.plans.find(p=>p.id===planId);
  const reminderField=editing?'':field('关联提醒',`<select name="planId"><option value="">自动匹配已有提醒</option>${state.plans.map(plan=>`<option value="${esc(plan.id)}" ${plan.id===planId?'selected':''}>${esc(plan.name)}${plan.enabled?'':'（已暂停）'}</option>`).join('')}</select>`,true,'按实际使用的药物、用量和时间匹配；已有提醒前后各 2 小时内用药可获得星星。');
  modal('记录一次实际使用','只有你确认的实际使用才会加入模型；提醒不会自动记账。',routeFields(p?.routeId||routeId,p?.amount||'',p?.durationHours||'')+field('实际使用时间',textInput('at',localInput(editing?.at||initialAt),'type="datetime-local" required'),true)+reminderField,async f=>{
    const at=new Date(f.get('at')).toISOString();if(new Date(at)>new Date())throw new Error('实际使用时间不能在未来。');
    const record={id:editing?.id||id(),routeId:f.get('routeId'),amount:Number(f.get('amount')),at};
    if(editing?.planId)record.planId=editing.planId;else if(!editing&&f.get('planId'))record.planId=f.get('planId');
    if(requiresDuration(getProfile(record.routeId))){record.durationHours=Number(f.get('durationHours'));if(!(record.durationHours>0))throw new Error('请填写贴片佩戴时长。正在佩戴时可先填计划时长，提前移除后编辑实际时长。');}
    if(!editing && (await native.previewDoseReward(record))?.code==='ambiguous')throw new Error('有多个相同的提醒，请选择这次记录对应的提醒计划。');
    const reward=await save({...state,doses:editing?state.doses.map(d=>d.id===editing.id?record:d):[...state.doses,record]},record.id);routeId=record.routeId;
    const reasons={'daily-limit':'今天普通提醒的 2 颗星星已经领齐了。','already-claimed':'这次提醒的星星已经领取过了。',duplicate:'同一次使用不会重复增加星星。','expired-or-unmatched':'未匹配到前后 2 小时内、药物与用量一致的已有提醒。',capacity:'星星账本空间已满，本次未增加星星。'};
    toast(reward?.code==='awarded' ? `实际使用已记录，星星口袋里多了 ${reward.amount} 颗。` : `实际使用已记录，曲线已更新。${editing?'':reasons[reward?.code]||''}`);
  },'确认已使用并记录');wireRoute();
}
function planForm(planId) {
  const p=state.plans.find(p=>p.id===planId);
  modal(p?'编辑提醒':'创建提醒计划','按既有方案设置固定间隔，不会自动决定或调整用量。',field('计划名称',textInput('name',p?.name||'','required maxlength="120" placeholder="给这个提醒起个名字"'),true)+routeFields(p?.routeId||routeId,p?.amount||'',p?.durationHours||'')+field('首次提醒时间',textInput('startAt',localInput(p?.startAt),'type="datetime-local" required'))+field('间隔（小时）',textInput('intervalHours',p?.intervalHours||'','type="number" min="0.25" max="8760" step="any" required placeholder="如 24 或 168"')),async f=>{
    const record={id:p?.id||id(),name:String(f.get('name')).trim(),routeId:f.get('routeId'),amount:Number(f.get('amount')),intervalHours:Number(f.get('intervalHours')),startAt:new Date(f.get('startAt')).toISOString(),enabled:p?.enabled??true};
    if(requiresDuration(getProfile(record.routeId))){record.durationHours=Number(f.get('durationHours'));if(!(record.durationHours>0))throw new Error('请明确填写贴片计划佩戴时长。');}
    await save({...state,plans:p?state.plans.map(item=>item.id===p.id?record:item):[...state.plans,record]});routeId=record.routeId;toast('提醒计划已保存。');
  });wireRoute();
}
function labForm(initialAt) {
  const keys=state.settings.mode==='ftm'?['testosterone','estradiol']:['estradiol','cpa'];
  const units=a=>({estradiol:['pg/mL','pmol/L'],testosterone:['ng/dL','nmol/L'],cpa:['ng/mL','nmol/L']})[a].map(unit=>`<option>${unit}</option>`).join('');
  modal('添加化验结果','请使用采血时刻；不要填写报告发出时间。',field('化验项目',`<select name="analyte" id="lab-analyte">${keys.map(key=>`<option value="${key}">${label(key)}</option>`).join('')}</select>`,true)+field('测定数值',textInput('value','','type="number" min="0" max="1000000" step="any" required'))+field('报告单位',`<select name="unit" id="lab-unit">${units(keys[0])}</select>`)+field('采血时间',textInput('at',localInput(initialAt),'type="datetime-local" required'),true),async f=>{
    const lab={id:id(),analyte:f.get('analyte'),value:Number(f.get('value')),unit:f.get('unit'),at:new Date(f.get('at')).toISOString()};
    if(new Date(lab.at)>new Date())throw new Error('采血时间不能在未来。');
    const normalized=normalizeLab(lab);if(!normalized.valid)throw new Error(normalized.warning);
    await save({...state,labs:[...state.labs,lab]});toast('化验已保存，模型已重新评估。');
  });$('#lab-analyte').addEventListener('change',e=>{$('#lab-unit').innerHTML=units(e.target.value);});
}
function modelParameterFields(p, config) {
  if(p.model!=='mahiro')return `<div class="form-grid">${field('吸收过程半衰期（小时）',textInput('absorptionHalfLifeHours',config.absorptionHalfLifeHours,'type="number" min="0.001" max="8760" step="any" required'))}${field('终末过程半衰期（小时）',textInput('eliminationHalfLifeHours',config.eliminationHalfLifeHours,'type="number" min="0.001" max="8760" step="any" required'))}</div>`;
  const names={analyte:'检测项目',kernelKind:'模型过程',vdLPerKg:'表观分布容积（L/kg）',clearanceRate:'清除速率（h⁻¹）',molecularRatio:'游离激素 / 化合物分子量比',absorptionRate:'吸收速率（h⁻¹）',swallowedAbsorptionRate:'吞咽支路吸收速率（h⁻¹）',hydrolysisRate:'酯水解速率（h⁻¹）',oralBioavailability:'吞咽支路生物利用度',bioavailability:'参考生物利用度',fastFraction:'快储库份额',slowAbsorptionRate:'慢储库吸收速率（h⁻¹）',formationFraction:'有效形成份额',durationHours:'默认佩戴时长（小时）',unit:'给药记录单位'};
  const kinds={oral:'口服吸收与清除',sublingual:'黏膜 / 吞咽双支路',depot:'双储库、酯水解与清除',gel:'皮肤吸收与清除',patch:'恒速释放与移除后清除'};
  const rows=Object.entries(p.pkParameters||{}).filter(([,value])=>value!==null&&typeof value!=='object').map(([name,value])=>`<tr><td>${esc(names[name]||name)}</td><td>${esc(name==='analyte'?label(value):name==='kernelKind'?(kinds[value]||value):typeof value==='number'?Number(value.toPrecision(7)):value)}</td></tr>`).join('');
  const legacy=state.modelConfigs[p.id];
  return `<div class="reference-source model-parameters"><strong>药代动力学参考模型</strong><small>使用对应药物与给药途径的模型；体重和舌下吸收份额可在上方修改。个人化验只拟合幅度，不验证时间曲线。</small>${legacy&&(legacy.absorptionHalfLifeHours!==undefined||legacy.eliminationHalfLifeHours!==undefined)?'<p class="medication-caution">已保留旧版自定义半衰期，但新版多过程模型不再使用这两个旧参数。</p>':''}${rows?`<details><summary>查看参考实现参数</summary><table class="history"><thead><tr><th>参数</th><th>值</th></tr></thead><tbody>${rows}</tbody></table></details>`:''}</div>`;
}
function modelSource(p) {
  const sources=p.sources.filter(s=>s.url!==MAHIRO_SOURCE.url&&s.url!==MAHIRO_SOURCE.repository);
  return `<p class="muted">${esc(p.note)}</p>${sources.map(s=>`<button type="button" class="soft-link" data-source="${esc(s.url)}">${esc(s.title)} ↗</button>`).join('')}`;
}
function modelForm() {
  const modelId=getProfile(routeId)?.model==='record-only'?'e2-oral':routeId,p=getProfile(modelId),cfg={...p.defaults,...state.modelConfigs[modelId]};
  const mode=state.settings.mode||'mtf',preset=REFERENCE_BASELINES[mode],refs={...(state.referenceBaselines||preset)},source=referencePresets.source;
  const pkSettings={bodyWeightKg:70,sublingualFraction:.11,...state.pkSettings};
  let restoreReference=false;
  const sourceRows=['estradiol','testosterone'].map(key=>{const value=source[mode][key];return `<tr><td>${label(key)}</td><td>${value.median} ${esc(value.unit)}</td><td>${value.iqr.join('–')}</td></tr>`;}).join('');
  const referenceInfo=`<div class="field full reference-source"><strong>${esc(source.title)}</strong><small>${esc(source.population)}</small><table class="history"><thead><tr><th>项目</th><th>中位数（原单位）</th><th>四分位距</th></tr></thead><tbody>${sourceRows}</tbody></table><small>治疗前队列参考背景，并非治疗后浓度或个体目标；CPA 背景固定为 0 ng/mL。</small><div class="button-row"><button type="button" class="soft-link" data-source="${esc(source.url)}">论文与原始单位 ↗</button><button type="button" class="btn secondary small" id="restore-reference">恢复论文背景</button><span id="reference-state">${state.referenceBaselineCustomized?'当前为自定义背景':'当前随模式采用论文背景'}</span></div></div>`;
  modal('参考背景与模型','参考假设、个人固定基线与药代参数分别保存。',
    field('模型体重（kg）',textInput('bodyWeightKg',pkSettings.bodyWeightKg,'type="number" min="20" max="400" step="any" required'),false,'初始 70 kg 仅为可修改的参考假设，请按个人情况填写。')+
    field('舌下黏膜吸收份额（%）',textInput('sublingualPercent',pkSettings.sublingualFraction*100,'type="number" min="0" max="100" step="any" required'),false,'默认 11% 是参考实现的经验假设，不能由含服时长精确推得；其余按吞咽支路计算。')+
    referenceInfo+field('参考 E2 背景（pg/mL）',textInput('refE',refs.estradiol,'type="number" min="0" max="1000000" step="any" required'))+field('参考 T 背景（ng/dL）',textInput('refT',refs.testosterone,'type="number" min="0" max="1000000" step="any" required'))+field('个人校准 E2 固定基线（pg/mL）',textInput('baseE',state.baselines.estradiol,'type="number" min="0" max="1000000" step="any" required'))+field('个人校准 T 固定基线（ng/dL）',textInput('baseT',state.baselines.testosterone,'type="number" min="0" max="1000000" step="any" required'))+field('高级 · 选择要查看的药代模型',`<select id="model-route" name="modelRoute">${PROFILES.filter(p=>p.model!=='record-only').map(p=>`<option value="${p.id}" ${p.id===modelId?'selected':''}>${p.name}</option>`).join('')}</select>`,true)+`<div class="field full" id="model-parameters">${modelParameterFields(p,cfg)}</div><div class="field full" id="model-source">${modelSource(p)}</div>`,async f=>{
    const rid=f.get('modelRoute'),profile=getProfile(rid);
    const referenceBaselines={estradiol:Number(f.get('refE')),testosterone:Number(f.get('refT'))};
    const matchesPreset=referenceBaselines.estradiol===preset.estradiol&&referenceBaselines.testosterone===preset.testosterone;
    const edited=referenceBaselines.estradiol!==refs.estradiol||referenceBaselines.testosterone!==refs.testosterone;
    const referenceBaselineCustomized=restoreReference?!matchesPreset:(state.referenceBaselineCustomized||edited);
    const modelConfigs={...state.modelConfigs};
    if(profile.model!=='mahiro')modelConfigs[rid]={...profile.defaults,...modelConfigs[rid],absorptionHalfLifeHours:Number(f.get('absorptionHalfLifeHours')),eliminationHalfLifeHours:Number(f.get('eliminationHalfLifeHours'))};
    const pkSettings={bodyWeightKg:Number(f.get('bodyWeightKg')),sublingualFraction:Number(f.get('sublingualPercent'))/100};
    await save({...state,pkSettings,referenceBaselines,referenceBaselineCustomized,referencePresetVersion:referencePresets.version,baselines:{estradiol:Number(f.get('baseE')),testosterone:Number(f.get('baseT'))},modelConfigs});routeId=rid;toast('参考参数已保存，浓度曲线已重新计算。');
  });
  $('#restore-reference').addEventListener('click',()=>{const form=$('#dialog-form');form.elements.refE.value=preset.estradiol;form.elements.refT.value=preset.testosterone;restoreReference=true;$('#reference-state').textContent='保存后恢复随模式采用论文背景';});
  $('#model-route').addEventListener('change',e=>{const p=getProfile(e.target.value),c={...p.defaults,...state.modelConfigs[p.id]};$('#model-parameters').innerHTML=modelParameterFields(p,c);$('#model-source').innerHTML=modelSource(p);});
}

function deleteRecord(type,recordId) {
  const names={plans:'提醒计划',doses:'实际使用记录',labs:'化验记录'};
  modal(`删除${names[type]}`,type==='plans'?'删除计划会停止对应提醒，保留已有使用记录。':'删除后将重新计算相关曲线与校准。',`<p class="muted field full">请确认删除所选${names[type]}。</p>`,async()=>{await save({...state,[type]:state[type].filter(r=>r.id!==recordId)});toast('已删除。');},'确认删除');
}
async function act(action, recordId) {
  if(nav.some(([key])=>key===action)){page=action;render();return;}
  if(action==='stars'){page='settings';render();requestAnimationFrame(()=>{const card=$('#star-wallet-card');card?.scrollIntoView({behavior:motionAllowed()?'smooth':'instant',block:'center'});card?.focus({preventScroll:true});});return;}
  if(action==='journal-day'&&dateFromKey(recordId)){journalDate=recordId;render();return;}
  if(action==='journal-today'){journalDate=localDateKey();render();return;}
  if(action==='journal-previous'||action==='journal-next'){
    const next=moveMonth(journalDate,action==='journal-next'?1:-1);
    if(next&&next>='1900-01-01'&&next<='2200-12-31'){journalDate=next;render();}return;
  }
  if(action==='journal-dose'||action==='journal-lab'){
    if(journalDate>localDateKey())return;
    const initialAt=journalDate===localDateKey()?nowISO():`${journalDate}T12:00:00`;
    if(action==='journal-dose')doseForm(null,null,initialAt);else labForm(initialAt);return;
  }
  if(action==='close-modal'){await closeModal();return;}
  if(action==='onboarding'){onboardingForm();return;}
  if(action.startsWith('mode-')){
    const mode=action==='mode-ftm'?'ftm':'mtf';
    await save(withMode(state,mode));
    routeId=mode==='ftm'?'t-enanthate-im':'e2-oral';toast('主题已切换；个人记录和校准基线保持不变。');return;
  }
  if(action==='import-skin' && LIVE2D_ENABLED){const result=await native.importSkin();if(result){await loadSkins();toast('模型已导入，点击「使用」切换。');}return;}
  if(action==='select-skin' && (LIVE2D_ENABLED || isBuiltinShark(recordId))){await native.selectSkin(recordId);toast('皮肤已切换。');return;}
  if(action==='remove-skin' && LIVE2D_ENABLED){modal('移除本机皮肤','只移除应用导入的副本；原始模型文件不受影响。','',async()=>{await native.removeSkin(recordId);await loadSkins();},'移除');return;}
  if(action==='plan'){planForm(recordId);return;}
  if(action==='dose'){doseForm(recordId);return;}
  if(action==='edit-dose'){doseForm(null,recordId);return;}
  if(action==='lab'){labForm();return;}
  if(action==='model'){modelForm();return;}
  if(action.startsWith('delete-')){deleteRecord({'delete-plan':'plans','delete-dose':'doses','delete-lab':'labs'}[action],recordId);return;}
  if(action==='toggle-plan'){await save({...state,plans:state.plans.map(p=>p.id===recordId?{...p,enabled:!p.enabled}:p)});return;}
  if(action==='rename'){modal('修改桌宠名字','桌面、提醒和这里会使用同一个名字。',field('名字',textInput('name',state.settings.name,'required maxlength="40"'),true),async f=>{const name=String(f.get('name')).trim();if(!name)throw new Error('名字不能为空。');await save({...state,settings:{...state.settings,name}});});return;}
  if(['mood-good','mood-okay','mood-low'].includes(action)){
    if(moodPending||dailyMood(state.dailyMoods).recorded)return;
    if(!native)throw new Error('请通过桌面程序保存心情。');
    moodPending=true;render();
    try{await native.petAction(action);state=await native.loadState();toast('今天的心情记下了。');}
    finally{moodPending=false;render();}return;
  }
  if(['pet','sleep'].includes(action)){
    if(native)await native.petAction(action);
    toast(({pet:`${state.settings.name}轻轻蹭了蹭你的手。`,sleep:`${state.settings.name}打算眯一会儿。`,'mood-good':'今天的心情已保存。','mood-okay':'今天的心情已保存。','mood-low':'今天的心情已保存。'})[action]);return;
  }
  if(!native)throw new Error('请通过桌面程序使用此功能。');
  if(action==='show-pet'){await native.showPet();toast(`${state.settings.name}已经来到桌面。`);}
  if(action==='hide-pet'){await native.hidePet();toast(`${state.settings.name}暂时隐藏，提醒继续运行。`);}
  if(action==='test-notify'){const result=await native.notifyTest();toast(result.enabled?`已提交测试提醒；也请检查 ${runtime.label} 通知权限。`:'系统通知当前关闭，已向桌宠发送测试气泡。');}
  if(action==='export'){const result=await native.exportData();if(!result.canceled)toast('数据备份已导出。');}
  if(action==='import'){const result=await native.importData();if(result){state=result;render();toast('备份已导入。');}}
}
document.addEventListener('click',event=>{
  const source=event.target.closest('[data-source]');if(source){if(native)native.openExternal(source.dataset.source).catch(e=>toast(e.message));return;}
  const item=event.target.closest('[data-action],[data-page]');if(!item)return;
  act(item.dataset.page||item.dataset.action,item.dataset.id).catch(error=>toast(error.message));
});
document.addEventListener('change',async event=>{
  if(event.target.id==='journal-month'){
    const month=event.target.value;
    if(!/^\d{4}-\d{2}$/.test(month)||month<'1900-01'||month>'2200-12')return;
    const old=dateFromKey(journalDate),next=dateFromKey(`${month}-01`);
    if(next){journalDate=moveMonth(journalDate,(next.getFullYear()-old.getFullYear())*12+next.getMonth()-old.getMonth());render();}return;
  }
  if(event.target.id==='skin-scale' && LIVE2D_ENABLED){try{await native.selectSkin(state.settings.activeSkin,Number(event.target.value));}catch(e){toast(e.message);}}
  if(event.target.id==='chart-days'){days=Number(event.target.value);render();}
  if(event.target.dataset.setting){const key=event.target.dataset.setting;if(key==='reducedMotion'&&event.target.checked){document.body.classList.add('no-motion');cancelMotion();}try{await save({...state,settings:{...state.settings,[key]:event.target.checked}});}catch(e){render();toast(e.message);}}
});
// Keep drafts open when the backdrop is clicked; only explicit controls or Escape close the dialog.
$('#modal').addEventListener('cancel',event=>{event.preventDefault();closeModal();});
$('#modal').addEventListener('close',()=>{
  cancelMotion('dialog');
  const saved=modalOpener;modalOpener=null;
  if($('#modal').dataset.purpose==='onboarding'){
    ($('#app [data-action="onboarding"]')||$('.nav [aria-current="page"]'))?.focus({preventScroll:true});return;
  }
  if(saved?.element?.isConnected){saved.element.focus({preventScroll:true});return;}
  const replacement=[...document.querySelectorAll('[data-action],[data-page]')].find(el=>saved&&(saved.action?el.dataset.action===saved.action&&el.dataset.id===saved.id:el.dataset.page===saved.page));
  replacement?.focus({preventScroll:true});
});
document.addEventListener('toggle',event=>{
  if(event.target.tagName!=='DETAILS'||!event.target.open)return;
  for(const child of event.target.children)if(child.tagName!=='SUMMARY')animateUI(child,[{opacity:.4,transform:'translateY(-3px)'},{opacity:1,transform:'translateY(0)'}],{scope:$('#modal').contains(child)?'dialog':'page',name:'detail-reveal',duration:180});
},true);
async function init() {
  try { if(native){runtime=await native.getPlatform();state=await native.loadState();routeId=state.settings.mode==='ftm'?'t-enanthate-im':'e2-oral';native.onState(next=>{const changed=next.settings.mode!==state.settings.mode;state=next;if(changed)routeId=state.settings.mode==='ftm'?'t-enanthate-im':'e2-oral';render();});}render();if(native&&!state.settings.onboardingCompleted)onboardingForm(); }
  catch(error){$('#app').innerHTML=`<div class="loading">本机数据读取失败：${esc(error.message)}。请重新启动软件。</div>`;}
}
window.addEventListener('beforeunload', () => starFeeding.dispose());
document.addEventListener('tide-star-feed-session-end',()=>{if(renderQueued)render();});
document.addEventListener('tide-chart-drag-end',()=>{if(renderQueued)render();});
document.addEventListener('tide-date-picker-close',()=>{if(renderQueued)render();});
document.addEventListener('tide-chart-interaction',()=>cancelMotion('page'));
setInterval(()=>{if(!$('#modal').open&&!document.activeElement?.matches('input,select')&&['overview','curves','calendar'].includes(page))render();},60000);
init();
