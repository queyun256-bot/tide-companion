import { localDateKey, dateFromKey, monthCells, dailyMood, journalIndex } from './journal.js';
import { getMedication } from './medications.js';
import { administrationIcon } from './medication-icons.js';
import { t, getLocale, formatNumber } from './i18n.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
const MOODS = {good: '心情不错', okay: '平平淡淡', low: '有点低落'};
const time = at => new Date(at).toLocaleTimeString(getLocale(), {hour:'2-digit', minute:'2-digit', hour12:false});
const action = (text, name, extra = '') => `<button type="button" class="btn ghost small" data-action="${name}" ${extra}>${esc(t(text))}</button>`;
const names = {estradiol:'雌二醇 E2', testosterone:'总睾酮 T', cpa:'醋酸环丙孕酮 CPA'};
export function moodIcon(mood) {
  const paths = {
    good: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
    okay: '<path d="M7 18a4 4 0 0 1-.8-7.9 6 6 0 0 1 11.5-.8A4.5 4.5 0 0 1 18 18Z"/>',
    low: '<path d="M6 15a3.5 3.5 0 0 1-.2-7 5.5 5.5 0 0 1 10.3-1A4 4 0 0 1 18 15M8 18l-1 3m6-3-1 3m6-3-1 3"/>',
  };
  return `<svg class="journal-mood-icon" viewBox="0 0 24 24" aria-hidden="true">${paths[mood]}</svg>`;
}
export function dailyMoodPanel(state, date = localDateKey(), pending = false, compact = false) {
  const today = localDateKey(), {mood, recorded, at} = dailyMood(state.dailyMoods, date);
  if (date > today) return `<div class="daily-mood-panel"><p class="muted">${t('这一天还没到，心情留到当天再记。')}</p></div>`;
  const canChoose = date === today && !recorded, heading = t(date === today ? '今天的心情' : '当天的心情');
  return `<section class="daily-mood-panel ${compact ? 'compact' : ''}" data-mood-date="${date}" data-mood-recorded="${recorded}">
    <div class="daily-mood-heading"><strong>${heading}</strong><span class="mood-status">${t(MOODS[mood])} · ${t(recorded ? '已记录' : '默认')}</span></div>
    <div class="daily-mood-options" role="group" aria-label="${heading}">${Object.entries(MOODS).map(([key, name]) => `<button type="button" data-action="mood-${key}" aria-label="${t(name)}" aria-pressed="${recorded && mood === key}" class="${!recorded && key === 'okay' ? 'is-default' : ''}" ${!canChoose || pending ? 'disabled' : ''}>${moodIcon(key)}<span>${t(name)}</span>${recorded && mood === key ? `<small>${t('已记录')}</small>` : !recorded && key === 'okay' ? `<small>${t('默认')}</small>` : ''}</button>`).join('')}</div>
    <p class="daily-mood-note">${recorded ? t('{day} {time} 记下的心情，已保存。', {day:t(date === today ? '今天' : '当天'),time:time(at)}) : t(canChoose ? '每天可选一次，保存后不能更改。不选择时默认为平平淡淡。' : '当天未选择心情，默认记为平平淡淡。')}</p>
  </section>`;
}
function doseRow(record) {
  const medication = getMedication(record.routeId);
  return `<li class="journal-record" data-dose-id="${esc(record.id)}"><time datetime="${esc(record.at)}">${time(record.at)}</time><span class="journal-route">${administrationIcon(medication?.administrationId, {size:22})}</span><div class="journal-record-copy"><strong>${esc(medication?.name || record.routeId)}</strong><span>${formatNumber(record.amount)} ${esc(medication?.unit)}${record.durationHours ? ` · ${t('佩戴 {hours} 小时',{hours:formatNumber(record.durationHours)})}` : ''}${new Date(record.at) > new Date() ? ` · ${t('未发生')}` : ''}</span>${medication?.brands?.length ? `<small>${esc(medication.brands)}</small>` : ''}</div><div class="journal-record-actions">${action('编辑', 'edit-dose', `data-id="${esc(record.id)}"`)}${action('删除', 'delete-dose', `data-id="${esc(record.id)}"`)}</div></li>`;
}
function labRow(record) {
  return `<li class="journal-record" data-lab-id="${esc(record.id)}"><time datetime="${esc(record.at)}">${time(record.at)}</time><span class="journal-lab-mark" aria-hidden="true">◌</span><div class="journal-record-copy"><strong>${esc(t(names[record.analyte] || record.analyte))}</strong><span>${formatNumber(record.value)} ${esc(record.unit)} · ${t('采血时间')}${new Date(record.at) > new Date() ? ` · ${t('未发生')}` : ''}</span></div><div class="journal-record-actions">${action('删除', 'delete-lab', `data-id="${esc(record.id)}"`)}</div></li>`;
}
export function journalWeekdays() {
  return Array.from({length:7},(_,i)=>new Intl.DateTimeFormat(getLocale(),{weekday:'short',timeZone:'UTC'}).format(new Date(Date.UTC(2026,0,5+i))));
}
export function calendarPage(state, selectedDate, pending = false) {
  const today = localDateKey(), month = selectedDate.slice(0, 7), index = journalIndex(state);
  const records = index.get(selectedDate) || {doses:[], labs:[]};
  const moods = new Map((state.dailyMoods || []).map(record => [record.date, record.mood]));
  const monthRecords = [...index.entries()].filter(([key]) => key.startsWith(month));
  const total = monthRecords.reduce((sum, [, entry]) => sum + entry.doses.length, 0);
  const totalLabs = monthRecords.reduce((sum, [, entry]) => sum + entry.labs.length, 0);
  return `<div class="page-title"><div><h1>${t('日历')}</h1><p class="muted">${t('把每天的用药和心情，放在一起回看。')}</p></div>${action('回到今天', 'journal-today')}</div>
    <div class="journal-layout"><section class="card journal-month" aria-label="${t('月历')}">
      <div class="journal-month-header"><label class="journal-month-label">${t('选择月份')}<input id="journal-month" type="month" value="${month}" min="1900-01" max="2200-12" aria-label="${t('选择月份')}"></label><div class="journal-month-controls">${action('‹', 'journal-previous', `aria-label="${t('上个月')}" ${month <= '1900-01' ? 'disabled' : ''}`)}${action('›', 'journal-next', `aria-label="${t('下个月')}" ${month >= '2200-12' ? 'disabled' : ''}`)}</div></div>
      <p class="journal-month-summary">${t('本月 {doses} 次用药 · {labs} 条化验',{doses:formatNumber(total),labs:formatNumber(totalLabs)})}</p>
      <div class="journal-weekdays" aria-hidden="true">${journalWeekdays().map(day => `<span>${day}</span>`).join('')}</div>
      <div class="journal-days" role="group" aria-label="${t('选择日期')}">${monthCells(month).map(date => {
        const item = index.get(date) || {doses:[],labs:[]}, mood = moods.get(date) || 'okay', recorded = moods.has(date), future = date > today;
        const description = [date,date === today?t('今天'):'',t('{doses} 次用药，{labs} 条化验',{doses:formatNumber(item.doses.length),labs:formatNumber(item.labs.length)}),future?'':`${t(MOODS[mood])} · ${t(recorded?'已记录':'默认')}`].filter(Boolean).join(' · ');
        return `<button type="button" class="journal-day ${date.startsWith(month) ? '' : 'outside-month'} ${date === today ? 'is-today' : ''}" data-action="journal-day" data-id="${date}" aria-label="${description}" aria-pressed="${date === selectedDate}" ${date === today ? 'aria-current="date"' : ''}><span class="journal-day-number">${formatNumber(Number(date.slice(-2)))}${date === today ? '<i aria-hidden="true"></i>' : ''}</span><span class="journal-day-records">${item.doses.length ? `<span>${t('用药 {count}',{count:formatNumber(item.doses.length)})}</span>` : ''}${item.labs.length ? `<span>${t('化验 {count}',{count:formatNumber(item.labs.length)})}</span>` : ''}</span>${future ? '' : `<span class="journal-day-mood ${recorded ? 'recorded' : 'default'}">${moodIcon(mood)}</span>`}</button>`;
      }).join('')}</div><div class="journal-legend"><span><i></i>${t('今天')}</span><span>${moodIcon('okay')}${t('浅色心情为默认值')}</span></div>
    </section><section class="card journal-detail" aria-labelledby="journal-day-title"><div class="card-head"><h2 id="journal-day-title" tabindex="-1">${dateFromKey(selectedDate).toLocaleDateString(getLocale(),{year:'numeric',month:'long',day:'numeric',weekday:'long'})}</h2>${selectedDate === today ? `<span class="pill">${t('今天')}</span>` : ''}</div>
      ${dailyMoodPanel(state, selectedDate, pending)}
      <div class="journal-section-heading"><h3>${t('实际用药')} <span>${formatNumber(records.doses.length)}</span></h3>${selectedDate <= today ? action('＋ 记录使用', 'journal-dose') : ''}</div>
      ${records.doses.length ? `<ol class="journal-records" aria-label="${t('当天实际用药')}">${records.doses.map(doseRow).join('')}</ol>` : `<p class="journal-empty">${t('这一天还没有实际用药记录。')}</p>`}
      <div class="journal-section-heading"><h3>${t('化验记录')} <span>${formatNumber(records.labs.length)}</span></h3>${selectedDate <= today ? action('＋ 添加化验', 'journal-lab') : ''}</div>
      ${records.labs.length ? `<ol class="journal-records" aria-label="${t('当天化验')}">${records.labs.map(labRow).join('')}</ol>` : `<p class="journal-empty">${t('这一天还没有化验记录。')}</p>`}
      <p class="journal-footnote">${t('按本机日期归档，显示所有药物与检测项目；提醒计划不计为实际用药。')}</p>
    </section></div>`;
}
