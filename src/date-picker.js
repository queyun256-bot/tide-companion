import { t, getLocale, html } from './i18n.js';
const mounted = new WeakMap();
let active = null;
let manual = null;
let nextId = 0;
const pad = value => String(value).padStart(2, '0');
const calendarIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="16" rx="4"/><path d="M7.5 3v4M16.5 3v4M4 10h16M8 14h1m6 0h1m-8 3h1"/></svg>';
const arrow = direction => `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="${direction === 'prev' ? 'm12 5-5 5 5 5' : 'm8 5 5 5-5 5'}"/></svg>`;

export function localPickerValue(type, date = new Date()) {
  const day = `${String(date.getFullYear()).padStart(4, '0')}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return type === 'month' ? day.slice(0, 7) : type === 'date' ? day : `${day}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Strict civil-date parsing: never normalize February 30 or 24:00 into another day. */
export function parsePickerValue(value, type = 'datetime-local') {
  const pattern = type === 'month' ? /^(\d{4})-(\d{2})$/ : type === 'date' ? /^(\d{4})-(\d{2})-(\d{2})$/ : /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/;
  const match = String(value).trim().match(pattern);
  if (!match) return null;
  const [, y, m, d = '01', h = '00', mm = '00'] = match;
  const year = Number(y), month = Number(m), day = Number(d), hour = Number(h), minute = Number(mm);
  if (year < 1 || month < 1 || month > 12 || hour > 23 || minute > 59) return null;
  const days = new Date(Date.UTC(year === 1 ? 2001 : year, month, 0)).getUTCDate();
  // Date.UTC treats 0..99 as 1900..1999; their leap pattern is identical except year 0,
  // which is excluded above. Leap-year arithmetic still handles year 0100 correctly.
  const limit = month === 2 ? (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28) : days;
  if (day < 1 || day > limit) return null;
  return {year, month, day, hour, minute, value: type === 'month' ? `${y}-${m}` : type === 'date' ? `${y}-${m}-${d}` : `${y}-${m}-${d}T${h}:${mm}`};
}

const dateKey = date => `${String(date.getUTCFullYear()).padStart(4, '0')}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
const civilDate = (year, month, day) => { const date = new Date(0); date.setUTCFullYear(year, month - 1, day); date.setUTCHours(12, 0, 0, 0); return date; };
export function pickerMonthCells(year, month) {
  const start = civilDate(year, month, 1);
  start.setUTCDate(start.getUTCDate() - (start.getUTCDay() + 6) % 7);
  return Array.from({length:42}, (_, index) => { const date = new Date(start); date.setUTCDate(start.getUTCDate() + index); return dateKey(date); });
}
const shiftedDate = (value, days) => { const parsed = parsePickerValue(value, 'date'); const date = civilDate(parsed.year, parsed.month, parsed.day + days); return dateKey(date); };
const formatText = value => value.replace('T', ' ');
const labelFor = input => input.getAttribute('aria-label') || input.labels?.[0]?.firstChild?.textContent?.trim() || (input.type === 'month' ? t('选择月份') : t('选择日期与时间'));
export const isDatePickerOpen = () => Boolean(active);
export const isDatePickerEditing = () => Boolean(active || manual?.input.isConnected);
export function closeDatePickers() {
  const hadManual = Boolean(manual); manual = null;
  if (active) active.close(false);
  else if (hadManual) document.dispatchEvent(new CustomEvent('tide-date-picker-close'));
}

export function mountDatePickers(root = document) {
  const inputs = [...root.querySelectorAll('input[type="datetime-local"],input[type="date"],input[type="month"]')];
  if (root.matches?.('input[type="datetime-local"],input[type="date"],input[type="month"]')) inputs.unshift(root);
  if (active && !active.input.isConnected) active.close(false);
  if (manual && !manual.input.isConnected) manual = null;
  return inputs.map(input => mounted.get(input) || mount(input));
}

function mount(input) {
  const type = input.type, id = input.id || `tide-date-${++nextId}`;
  const original = {tabIndex:input.getAttribute('tabindex'), ariaHidden:input.getAttribute('aria-hidden')};
  const labels = [...(input.labels || [])].map(label => ({label, htmlFor:label.getAttribute('for')}));
  const host = document.createElement('span');
  host.className = `date-picker date-picker-${type}`;
  host.dataset.for = id;
  input.before(host);
  host.append(input);
  input.classList.add('date-picker-native');
  input.tabIndex = -1;
  input.setAttribute('aria-hidden', 'true');
  const textInput = document.createElement('input');
  textInput.type = 'text';
  textInput.dataset.datePickerInput = '';
  textInput.id = `${id}-display`;
  textInput.className = 'date-picker-input';
  textInput.autocomplete = 'off';
  textInput.spellcheck = false;
  textInput.required = input.required;
  textInput.setAttribute('aria-label', labelFor(input));
  textInput.placeholder = type === 'month' ? 'YYYY-MM' : type === 'date' ? 'YYYY-MM-DD' : 'YYYY-MM-DD HH:mm';
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'date-picker-trigger';
  trigger.dataset.datePickerTrigger = '';
  trigger.setAttribute('aria-label', t(type === 'month' ? '打开月份选择器' : '打开日期选择器'));
  trigger.setAttribute('aria-haspopup', 'dialog');
  trigger.setAttribute('aria-controls', `${id}-popover`);
  trigger.setAttribute('aria-expanded', 'false');
  trigger.innerHTML = calendarIcon;
  host.append(textInput, trigger);
  // A wrapping label would otherwise focus the visually hidden native field.
  for (const {label} of labels) label.htmlFor = textInput.id;

  let panel = null, draft = '', viewedYear = 0, viewedMonth = 0, focusedDay = '', committing = false, frame = 0;
  let listeners = null;
  const sync = () => {
    if (committing) return;
    textInput.value = formatText(input.value);
    textInput.disabled = trigger.disabled = input.disabled;
    textInput.required = input.required;
    textInput.setCustomValidity(''); input.setCustomValidity('');
    textInput.removeAttribute('aria-invalid');
  };
  const validity = value => {
    if (!value.trim()) return input.required ? t('请填写日期。') : '';
    const parsed = parsePickerValue(value, type);
    if (!parsed) return type === 'month' ? t('请填写有效月份，例如 2026-10。') : type === 'date' ? t('请填写有效日期，例如 2026-10-12。') : t('请填写有效日期和时间，例如 2026-10-12 09:30。');
    if (type === 'datetime-local') {
      const local = new Date(parsed.value);
      if (!Number.isFinite(local.getTime()) || localPickerValue(type, local) !== parsed.value) return t('这个本机时间不存在，请检查日期、时间或夏令时切换。');
    }
    if (input.min && parsed.value < input.min) return t('不能早于 {value}。',{value:formatText(input.min)});
    if (input.max && parsed.value > input.max) return t('不能晚于 {value}。',{value:formatText(input.max)});
    return '';
  };
  const markValidity = message => {
    textInput.setCustomValidity(message); input.setCustomValidity(message);
    textInput.toggleAttribute('aria-invalid', Boolean(message));
    if (message) textInput.setAttribute('aria-invalid', 'true');
  };
  const commitText = () => {
    const message = validity(textInput.value);
    markValidity(message);
    if (message) return false;
    const value = textInput.value.trim() ? parsePickerValue(textInput.value, type).value : '';
    const changed = input.value !== value;
    input.value = value;
    textInput.value = formatText(value);
    if (changed) {
      committing = true;
      input.dispatchEvent(new Event('input', {bubbles:true}));
      input.dispatchEvent(new Event('change', {bubbles:true}));
      committing = false;
    }
    return true;
  };
  function close(restoreFocus = true) {
    if (!panel) return;
    listeners?.abort(); listeners = null;
    cancelAnimationFrame(frame);
    const oldPanel = panel; panel = null;
    try { if (oldPanel.matches(':popover-open')) oldPanel.hidePopover(); } catch {}
    oldPanel.remove();
    trigger.setAttribute('aria-expanded', 'false');
    host.classList.remove('is-open');
    if (active === controller) active = null;
    if (restoreFocus && trigger.isConnected) trigger.focus({preventScroll:true});
    document.dispatchEvent(new CustomEvent('tide-date-picker-close'));
  }
  function position() {
    if (!panel) return;
    const bounds = host.getBoundingClientRect();
    const width = Math.min(type === 'month' ? 308 : 328, innerWidth - 24);
    panel.style.width = `${width}px`;
    panel.style.maxHeight = `${innerHeight - 24}px`;
    const height = panel.getBoundingClientRect().height;
    panel.style.left = `${Math.max(12, Math.min(bounds.left, innerWidth - width - 12))}px`;
    const below = bounds.bottom + 8;
    const top = below + height <= innerHeight - 12 ? below : bounds.top - height - 8 >= 12 ? bounds.top - height - 8 : Math.max(12, Math.min(below, innerHeight - height - 12));
    panel.style.top = `${top}px`;
  }
  const validDay = value => {
    const min = input.min?.slice(0, 10), max = input.max?.slice(0, 10);
    return Boolean(parsePickerValue(value, 'date')) && (!min || value >= min) && (!max || value <= max);
  };
  const validMonth = value => (!input.min || value >= input.min.slice(0, 7)) && (!input.max || value <= input.max.slice(0, 7));
  function renderPanel(focusSelector) {
    if (!panel) return;
    const parsed = parsePickerValue(draft, type), today = localPickerValue('date');
    panel.innerHTML = html`<div class="date-picker-heading"><span>${type === 'month' ? t('选择月份') : t('选择日期')}</span><small>${type === 'datetime-local' ? t('本机时间') : t('轻点选择')}</small></div>
      <div class="date-picker-navigation"><button type="button" data-picker-action="previous" aria-label="${type === 'month' ? t('上一年') : t('上个月')}">${arrow('prev')}</button><strong aria-live="polite">${new Intl.DateTimeFormat(getLocale(),{year:'numeric',...(type === 'month'?{}:{month:'long'}),timeZone:'UTC'}).format(civilDate(viewedYear,viewedMonth,1))}</strong><button type="button" data-picker-action="next" aria-label="${type === 'month' ? t('下一年') : t('下个月')}">${arrow('next')}</button></div>
      ${type === 'month' ? html`<div class="date-picker-months" role="group" aria-label="月份">${Array.from({length:12}, (_, index) => { const value = `${String(viewedYear).padStart(4, '0')}-${pad(index + 1)}`; return html`<button type="button" data-picker-month="${value}" aria-pressed="${draft === value}" ${validMonth(value) ? '' : 'disabled'}>${new Intl.DateTimeFormat(getLocale(),{month:'short',timeZone:'UTC'}).format(civilDate(viewedYear,index+1,1))}</button>`; }).join('')}</div>` : html`<div class="date-picker-weekdays" aria-hidden="true">${Array.from({length:7},(_,index)=>new Intl.DateTimeFormat(getLocale(),{weekday:'short',timeZone:'UTC'}).format(civilDate(2026,1,5+index))).map(day => `<span>${day}</span>`).join('')}</div><div class="date-picker-days" role="group" aria-label="日期，使用方向键移动">${pickerMonthCells(viewedYear, viewedMonth).map(value => `<button type="button" data-picker-day="${value}" class="${Number(value.slice(5,7)) !== viewedMonth ? 'is-adjacent' : ''} ${value === today ? 'is-today' : ''}" aria-label="${value}${value === today ? t('，今天') : ''}" aria-pressed="${draft.slice(0,10) === value}" tabindex="${value === focusedDay ? 0 : -1}" ${validDay(value) ? '' : 'disabled'}>${Number(value.slice(-2))}</button>`).join('')}</div>`}
      ${type === 'datetime-local' ? html`<div class="date-picker-time"><span><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3 2"/></svg>使用时间</span><label><input type="number" min="0" max="23" step="1" value="${pad(parsed.hour)}" data-picker-hour aria-label="小时"><small>时</small></label><b>:</b><label><input type="number" min="0" max="59" step="1" value="${pad(parsed.minute)}" data-picker-minute aria-label="分钟"><small>分</small></label></div>` : ''}
      <p class="date-picker-error" role="alert" hidden></p><div class="date-picker-footer"><button type="button" data-picker-action="now" class="date-picker-now">${type === 'month' ? t('本月') : type === 'date' ? t('今天') : t('现在')}</button><span></span><button type="button" data-picker-action="cancel">取消</button><button type="button" data-picker-action="confirm" class="date-picker-confirm">确定</button></div>`;
    position();
    if (focusSelector) panel.querySelector(focusSelector)?.focus({preventScroll:true});
  }
  function readTime() {
    if (type !== 'datetime-local') return true;
    const hour = panel.querySelector('[data-picker-hour]'), minute = panel.querySelector('[data-picker-minute]');
    const valid = /^\d{1,2}$/.test(hour.value) && /^\d{1,2}$/.test(minute.value) && Number(hour.value) <= 23 && Number(minute.value) <= 59;
    if (!valid) {
      const error = panel.querySelector('.date-picker-error'); error.textContent = t('小时为 0–23，分钟为 0–59。'); error.hidden = false;
      return false;
    }
    draft = `${draft.slice(0,10)}T${pad(Number(hour.value))}:${pad(Number(minute.value))}`;
    panel.querySelector('.date-picker-error').hidden = true;
    return true;
  }
  function moveMonth(delta) {
    if (!readTime()) return;
    if (type === 'month') viewedYear = Math.max(1, Math.min(9999, viewedYear + delta));
    else {
      const date = civilDate(viewedYear, viewedMonth + delta, 1);
      if (date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999) return;
      viewedYear = date.getUTCFullYear(); viewedMonth = date.getUTCMonth() + 1;
      focusedDay = pickerMonthCells(viewedYear, viewedMonth).find(value => Number(value.slice(5,7)) === viewedMonth && validDay(value)) || '';
    }
    renderPanel(`[data-picker-action="${delta > 0 ? 'next' : 'previous'}"]`);
  }
  function open() {
    if (input.disabled) return;
    active?.close(false);
    let parsed = parsePickerValue(textInput.value, type) || parsePickerValue(input.value, type) || parsePickerValue(localPickerValue(type), type);
    draft = parsed.value; viewedYear = parsed.year; viewedMonth = parsed.month; focusedDay = draft.slice(0,10);
    panel = document.createElement('div'); panel.id = `${id}-popover`; panel.className = 'date-picker-popover';
    panel.setAttribute('popover', 'manual'); panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', labelFor(input));
    (input.closest('dialog') || document.body).append(panel);
    active = controller; host.classList.add('is-open'); trigger.setAttribute('aria-expanded', 'true');
    panel.showPopover(); renderPanel(type === 'month' ? `[data-picker-month="${draft}"]` : `[data-picker-day="${focusedDay}"]`);
    listeners = new AbortController(); const signal = listeners.signal;
    panel.addEventListener('click', event => {
      const button = event.target.closest('button'); if (!button || button.disabled) return;
      event.preventDefault(); event.stopPropagation();
      if (button.dataset.pickerDay) {
        if (!readTime()) return;
        focusedDay = button.dataset.pickerDay; draft = focusedDay + (type === 'datetime-local' ? draft.slice(10) : '');
        const selected = parsePickerValue(focusedDay, 'date'); viewedYear = selected.year; viewedMonth = selected.month;
        renderPanel(`[data-picker-day="${focusedDay}"]`); return;
      }
      if (button.dataset.pickerMonth) { draft = button.dataset.pickerMonth; renderPanel(`[data-picker-month="${draft}"]`); return; }
      const action = button.dataset.pickerAction;
      if (action === 'previous' || action === 'next') { moveMonth(action === 'next' ? 1 : -1); return; }
      if (action === 'cancel') { close(); return; }
      if (action === 'now') {
        const now = parsePickerValue(localPickerValue(type), type); draft = now.value; viewedYear = now.year; viewedMonth = now.month; focusedDay = draft.slice(0,10);
        renderPanel('[data-picker-action="now"]'); return;
      }
      if (action === 'confirm') {
        if (!readTime()) return;
        const message = validity(draft);
        if (message) { const error = panel.querySelector('.date-picker-error'); error.textContent = message; error.hidden = false; return; }
        textInput.value = formatText(draft);
        // Keep active until change handlers finish; background state renders may be deferred.
        commitText(); close();
      }
    }, {signal});
    panel.addEventListener('keydown', event => {
      const day = event.target.closest('[data-picker-day]'), month = event.target.closest('[data-picker-month]');
      if (day && ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown'].includes(event.key)) {
        event.preventDefault(); if (!readTime()) return;
        const value = day.dataset.pickerDay, parsedDay = parsePickerValue(value, 'date');
        let target;
        if (event.key === 'PageUp' || event.key === 'PageDown') {
          const moved = civilDate(parsedDay.year, parsedDay.month + (event.key === 'PageDown' ? 1 : -1), 1);
          const last = civilDate(moved.getUTCFullYear(), moved.getUTCMonth() + 2, 0).getUTCDate();
          moved.setUTCDate(Math.min(parsedDay.day, last)); target = dateKey(moved);
        } else {
          const weekday = (civilDate(parsedDay.year, parsedDay.month, parsedDay.day).getUTCDay() + 6) % 7;
          const delta = {ArrowLeft:-1,ArrowRight:1,ArrowUp:-7,ArrowDown:7,Home:-weekday,End:6-weekday}[event.key];
          target = shiftedDate(value, delta);
        }
        if (!validDay(target)) return;
        const parsedTarget = parsePickerValue(target, 'date'); viewedYear = parsedTarget.year; viewedMonth = parsedTarget.month; focusedDay = target;
        renderPanel(`[data-picker-day="${target}"]`);
      } else if (month && ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(event.key)) {
        event.preventDefault();
        const current = Number(month.dataset.pickerMonth.slice(-2));
        const next = Math.max(1, Math.min(12, event.key === 'Home' ? 1 : event.key === 'End' ? 12 : current + ({ArrowLeft:-1,ArrowRight:1,ArrowUp:-3,ArrowDown:3}[event.key])));
        panel.querySelector(`[data-picker-month="${String(viewedYear).padStart(4,'0')}-${pad(next)}"]`)?.focus();
      } else if (event.key === 'Enter' && event.target.matches('input')) {
        event.preventDefault(); panel.querySelector('[data-picker-action="confirm"]').click();
      }
    }, {signal});
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close(); }
      if (event.key === 'Tab') {
        const focusable = [...panel.querySelectorAll('button:not(:disabled),input:not(:disabled)')].filter(element => element.tabIndex !== -1);
        const first = focusable[0], last = focusable.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }, {capture:true,signal});
    document.addEventListener('pointerdown', event => { if (panel && !panel.contains(event.target) && !host.contains(event.target)) close(false); }, {capture:true,signal});
    window.addEventListener('resize', position, {signal});
    document.addEventListener('scroll', () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(position); }, {capture:true,signal});
  }
  trigger.addEventListener('click', event => { event.preventDefault(); active === controller ? close() : open(); });
  textInput.addEventListener('focus', () => { manual = controller; });
  textInput.addEventListener('blur', () => {
    // Let the destination click run first; a deferred background render must not
    // replace the clicked button between pointerdown and click.
    setTimeout(() => {
      if (manual !== controller || document.activeElement === textInput) return;
      manual = null;
      document.dispatchEvent(new CustomEvent('tide-date-picker-close'));
    }, 0);
  });
  textInput.addEventListener('input', () => markValidity(validity(textInput.value)));
  textInput.addEventListener('change', commitText);
  textInput.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown' && event.altKey) { event.preventDefault(); open(); }
    if (event.key === 'Enter') {
      event.preventDefault(); manual = null;
      if (!commitText()) { manual = controller; textInput.reportValidity(); }
      else document.dispatchEvent(new CustomEvent('tide-date-picker-close'));
    }
  });
  const nativeInvalid = event => { event.preventDefault(); if (!textInput.validationMessage) markValidity(input.validationMessage || t('请填写有效日期。')); textInput.focus(); textInput.reportValidity(); };
  input.addEventListener('invalid', nativeInvalid);
  input.addEventListener('change', sync); input.addEventListener('input', sync);
  const reset = () => queueMicrotask(() => { if (input.isConnected) { close(false); sync(); } });
  input.form?.addEventListener('reset', reset);
  sync();
  const controller = {input, sync, open, close, destroy() {
    if (manual === controller) manual = null;
    close(false);
    input.removeEventListener('invalid', nativeInvalid); input.removeEventListener('change', sync); input.removeEventListener('input', sync);
    input.form?.removeEventListener('reset', reset);
    host.before(input); host.remove(); input.classList.remove('date-picker-native'); input.setCustomValidity('');
    for (const [key, value] of [['tabindex',original.tabIndex],['aria-hidden',original.ariaHidden]]) value === null ? input.removeAttribute(key) : input.setAttribute(key,value);
    for (const {label,htmlFor} of labels) htmlFor === null ? label.removeAttribute('for') : label.setAttribute('for',htmlFor);
    mounted.delete(input);
  }};
  mounted.set(input, controller);
  return controller;
}
