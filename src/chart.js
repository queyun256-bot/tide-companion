import { t, getLocale, formatNumber } from './i18n.js';
import { compileHormoneModel } from './hormones.js';
import { normalizeLab } from './pk.js';
import { gahtReferenceMarkup } from './gaht-reference.js';

const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const analytes = {
  estradiol: { label:'雌二醇 E2', short:'E2', unit:'pg/mL', color:'e2', minimum:50 },
  testosterone: { label:'总睾酮 T', short:'T', unit:'ng/dL', color:'t', minimum:100 },
  cpa: { label:'醋酸环丙孕酮 CPA', short:'CPA', unit:'ng/mL', color:'cpa', minimum:10 },
};
export const visibleAnalytes = (mode, showEstradiol = false) => mode === 'ftm' ? (showEstradiol ? ['testosterone','estradiol'] : ['testosterone']) : ['estradiol','cpa'];
export const statusLabel = status => t(({reference:'未校准参考',calibrated:'个人校准估计',unavailable:'暂无法估计',invalid:'记录需核对'})[status] || '未校准参考');
export function engineFor(state) {
  const at=Date.now();
  // The desktop view forecasts decay of actual history, never an imported future dose.
  // Keep invalid dates in the input so the engine reports them instead of hiding them.
  const doses=state.doses.filter(d=>{const t=+new Date(d.at);return !Number.isFinite(t)||t<=at;});
  return compileHormoneModel({...state,doses,at,mode:state.settings.mode||'mtf'});
}
const resultFor = (results, key) => results[key] || {value:null,unit:analytes[key].unit,status:'unavailable',warnings:[]};
export const sampleReason = code => t(({included:'已参与校准',future:'未来采血时间，未参与校准','invalid-lab':'数值、单位或采血时间无效',duplicate:'重复实测点，未重复拟合','no-exposure':'该时刻没有已记录给药的模型暴露','baseline-conflict':'测值低于个人固定基线'})[code] || '未参与本次校准');
function concentrationHint(a) {
  const c=a.calibration||{},diagnostics=c.sampleDiagnostics||[];
  if(a.status==='unavailable'||a.status==='invalid') {
    const reasons={'record-only-hormone':'已记录药物中仍有缺少浓度模型的组合，详见模型说明。','unsupported-route':'当前给药组合缺少可叠加的模型幅度。','invalid-records':'给药记录或模型参数需要核对，详见浓度曲线说明。','numeric-error':'模型数值超出范围，请检查参数与用量。'};
    return t(reasons[a.reasonCode]||c.warnings?.at(-1)||'模型暂无法计算，请查看校准说明。');
  }
  if(a.status==='calibrated') {
    const excluded=diagnostics.filter(d=>d.status==='excluded').length;
    return t('{count} 个实测点用于幅度校准。',{count:formatNumber(c.n||0)}) + (excluded?t('另有 {count} 个点未参与。',{count:formatNumber(excluded)}):'') + (c.n===1?t('单点校准不能验证峰谷形状。'):'');
  }
  if(diagnostics.length&&diagnostics.every(d=>d.reasonCode==='future'))return t('采血记录在未来，尚未参与校准；当前显示参考估计。');
  const reasons={'no-exposure':'化验时刻没有足够的已记录给药暴露，当前保留参考估计。','baseline-conflict':'化验低于个人固定基线，尚未完成校准。','unrepresented-route':'新增途径没有被化验覆盖，当前使用参考估计。','unsupported-combination':'此给药组合尚不能由一个化验倍率确定总贡献。','unidentifiable':'实测未提供可识别的药物增量，当前保留参考估计。'};
  if(c.reasonCode!=='no-labs'&&(a.latestLab||diagnostics.length))return t(reasons[c.reasonCode]||'现有实测未能用于个人校准，详见化验与校准页。');
  return t(a.reasonCode==='baseline-only'?'当前仅显示参考背景；没有对应药物的已记录贡献。':'根据已记录用量和参考参数计算，可用采血结果校准。');
}
export function hormoneCards(results, keys = ['estradiol','cpa'], options = {}) {
  return `<div class="hormone-cards ${keys.length === 1 ? 'single' : ''}">${keys.map(key => {
    const a = resultFor(results,key);
    return `<div class="hormone-card ${key}" data-status="${escape(a.status)}"><div class="hormone-title"><i></i>${t(analytes[key].label)}<span>${statusLabel(a.status)}</span></div><strong>${Number.isFinite(a.value)?formatNumber(a.value,{minimumFractionDigits:1,maximumFractionDigits:1}):'—'}<small>${a.unit}</small></strong>${gahtReferenceMarkup(key,options.referenceMode)}<p>${a.latestLab?t('最近实测 {value} {unit} · {date}',{value:formatNumber(a.latestLab.value,{minimumFractionDigits:1,maximumFractionDigits:1}),unit:a.unit,date:new Date(a.latestLab.at).toLocaleString(getLocale())}):t(a.calibration?.sampleDiagnostics?.length?'暂无当前时刻以前的有效实测':'还没有化验记录')}</p><p class="concentration-hint">${escape(concentrationHint(a))}</p></div>`;
  }).join('')}</div>`;
}

let chartContext, markerTime = null, dragging = false;
export const isChartDragging = () => dragging;
export function hormoneChart(state, days = 3, compact = false, keys = visibleAnalytes(state.settings.mode)) {
  const engine = engineFor(state), now = Date.now(), start = now-days*.75*864e5, end = now+days*.25*864e5;
  const series = engine.series({start:new Date(start).toISOString(),end:new Date(end).toISOString(),points:compact?121:241});
  const times = new Set(series.map(value => new Date(value.at).getTime()));
  for (const dose of state.doses) {
    const time = +new Date(dose.at);
    if (time > now || time > end || time < start-864e5) continue;
    for (const hours of [0,.25,.5,1,2,4,8,12,24,48,96]) if (time+hours*36e5 >= start && time+hours*36e5 <= end) times.add(time+hours*36e5);
  }
  const rows = [...times].sort((a,b)=>a-b).map(at=>({at,...engine.at(new Date(at).toISOString())}));
  const labs = state.labs.map(normalizeLab).filter(lab=>lab.valid&&keys.includes(lab.analyte)&&+new Date(lab.at)>=start&&+new Date(lab.at)<=Math.min(now,end));
  const maxFor = key => labs.filter(lab=>lab.analyte===key).reduce((largest,lab)=>Math.max(largest,lab.value),rows.reduce((largest,row)=>Math.max(largest,resultFor(row,key).value??0),analytes[key].minimum))*1.16;
  const max = Object.fromEntries(keys.map(key=>[key,maxFor(key)]));
  const w=820,h=compact?240:350,left=56,right=keys.length>1?60:26,top=28,bottom=43,pw=w-left-right,ph=h-top-bottom;
  const x = time => left+(time-start)/(end-start)*pw;
  const y = (value,key) => top+(1-value/max[key])*ph;
  const pathFor = key => {
    let started=false;
    return rows.map(row=>{const value=resultFor(row,key).value;if(!Number.isFinite(value)){started=false;return '';}const point=`${started?'L':'M'}${x(row.at).toFixed(2)},${y(value,key).toFixed(2)}`;started=true;return point;}).join(' ');
  };
  chartContext = {engine,start,end,left,pw,w,top,bottom,h,max,now,keys};
  const dateLabel=time=>new Date(time).toLocaleString(getLocale(),days<=3?{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}:{month:'2-digit',day:'2-digit'});
  const names=new Intl.ListFormat(getLocale(),{style:'long',type:'conjunction'}).format(keys.map(key=>analytes[key].short));
  return `<div class="hormone-chart" data-chart><div class="chart-readout" id="chart-readout">${t('按住鼠标右键拖动标线，查看任意时刻的 {names}',{names})}</div><svg id="hormone-chart-svg" class="chart" viewBox="0 0 ${w} ${h}" role="slider" tabindex="0" aria-label="${t('时间标线。按左右方向键或鼠标右键拖动，读取 {names} 浓度',{names})}" aria-valuemin="${start}" aria-valuemax="${end}" aria-valuenow="${now}"><defs><clipPath id="chart-past"><rect x="0" y="0" width="${x(now)}" height="${h}"/></clipPath><clipPath id="chart-future"><rect x="${x(now)}" y="0" width="${w-x(now)}" height="${h}"/></clipPath></defs>${keys.map((key,index)=>`<text class="${analytes[key].color}-label" x="${index?w-right:left}" y="13" text-anchor="${index?'end':'start'}">${analytes[key].short} · ${analytes[key].unit}</text>`).join('')}${[0,.25,.5,.75,1].map(f=>`<line class="grid" x1="${left}" x2="${w-right}" y1="${top+f*ph}" y2="${top+f*ph}"/>${keys.map((key,index)=>`<text class="${analytes[key].color}-label" x="${index?w-right+8:left-8}" y="${top+f*ph+3}" text-anchor="${index?'start':'end'}">${(max[key]*(1-f)).toFixed(0)}</text>`).join('')}`).join('')}<g class="chart-series">${keys.map(key=>`<path class="hormone-line ${key}" d="${pathFor(key)}" clip-path="url(#chart-past)"/><path class="hormone-line ${key} future" d="${pathFor(key)}" clip-path="url(#chart-future)"/>`).join('')}</g>${labs.map(lab=>`<circle class="lab-point ${lab.analyte}" cx="${x(+new Date(lab.at))}" cy="${y(lab.value,lab.analyte)}" r="4"><title>${escape(t(analytes[lab.analyte].label))} ${t('实测')} ${formatNumber(lab.value,{minimumFractionDigits:1,maximumFractionDigits:1})} ${lab.unit} · ${escape(dateLabel(+new Date(lab.at)))}</title></circle>`).join('')}<line class="time-now" x1="${x(now)}" x2="${x(now)}" y1="${top}" y2="${h-bottom}"/><text x="${x(now)+5}" y="${top+10}">${t('现在')}</text><g id="chart-marker"><line id="marker-line" x1="${x(now)}" x2="${x(now)}" y1="${top}" y2="${h-bottom}"/>${keys.map(key=>`<circle id="marker-${analytes[key].color}" r="4"/>`).join('')}</g>${[0,.25,.5,.75,1].map(f=>`<text x="${left+f*pw}" y="${h-14}" text-anchor="middle">${escape(dateLabel(start+f*(end-start)))}</text>`).join('')}</svg><div class="chart-legend">${keys.map((key,index)=>`<span><i class="legend-line ${analytes[key].color}"></i>${t(analytes[key].label)} · ${t(index?'右轴':'左轴')}</span>`).join('')}<span>${t('圆点为实测 · 虚线为不追加给药的推算')}</span></div></div>`;
}

export function bindChart() {
  const svg=document.querySelector('#hormone-chart-svg');if(!svg||!chartContext)return;
  const ctx=chartContext;let mark=markerTime??ctx.now,activePointer=null;
  function update(time,remember=false) {
    mark=Math.max(ctx.start,Math.min(ctx.end,time));if(remember||markerTime!==null)markerTime=mark;
    const values=ctx.engine.at(new Date(mark).toISOString()),x=ctx.left+(mark-ctx.start)/(ctx.end-ctx.start)*ctx.pw;
    const line=svg.querySelector('#marker-line');line.setAttribute('x1',x);line.setAttribute('x2',x);
    for(const key of ctx.keys){const point=svg.querySelector('#marker-'+analytes[key].color),value=resultFor(values,key).value;point.setAttribute('cx',x);point.setAttribute('cy',Number.isFinite(value)?ctx.top+(1-value/ctx.max[key])*(ctx.h-ctx.top-ctx.bottom):ctx.top);point.setAttribute('visibility',Number.isFinite(value)?'visible':'hidden');}
    const readout=document.querySelector('#chart-readout');
    readout.innerHTML=`<time>${new Date(mark).toLocaleString(getLocale(),{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})}</time>${ctx.keys.map(key=>{const value=resultFor(values,key);return `<span class="${analytes[key].color}-text">${analytes[key].short} ${Number.isFinite(value.value)?formatNumber(value.value,{minimumFractionDigits:1,maximumFractionDigits:1}):'—'} ${value.unit} · ${statusLabel(value.status)}</span>`;}).join('')}`;
    svg.setAttribute('aria-valuenow',mark);svg.setAttribute('aria-valuetext',readout.textContent);
  }
  const move=event=>{const matrix=svg.getScreenCTM();if(!matrix)return;const point=svg.createSVGPoint();point.x=event.clientX;point.y=event.clientY;const local=point.matrixTransform(matrix.inverse());update(ctx.start+(local.x-ctx.left)/ctx.pw*(ctx.end-ctx.start),true);};
  const finish=()=>{if(!dragging)return;dragging=false;svg.classList.remove('is-dragging');if(activePointer!==null&&svg.hasPointerCapture(activePointer))svg.releasePointerCapture(activePointer);activePointer=null;document.dispatchEvent(new Event('tide-chart-drag-end'));};
  svg.addEventListener('contextmenu',event=>event.preventDefault());
  svg.addEventListener('pointerdown',event=>{if(event.button!==2)return;document.dispatchEvent(new Event('tide-chart-interaction'));event.preventDefault();dragging=true;activePointer=event.pointerId;svg.classList.add('is-dragging');svg.focus({preventScroll:true});svg.setPointerCapture(event.pointerId);move(event);});
  svg.addEventListener('pointermove',event=>{if(dragging){if(!(event.buttons&2)){finish();return;}move(event);}});
  svg.addEventListener('pointerup',event=>{if(dragging){move(event);finish();}});
  svg.addEventListener('pointercancel',finish);svg.addEventListener('lostpointercapture',finish);
  svg.addEventListener('keydown',event=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){document.dispatchEvent(new Event('tide-chart-interaction'));event.preventDefault();update(event.key==='Home'?ctx.start:event.key==='End'?ctx.end:mark+(event.key==='ArrowRight'?1:-1)*(event.shiftKey?36e5:9e5),true);}});
  update(mark);
}
