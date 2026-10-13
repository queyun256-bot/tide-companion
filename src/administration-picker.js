import { t } from './i18n.js';
import { administrationIcon } from './medication-icons.js';
import { ADMINISTRATIONS } from './medications.js';

const mounted = new WeakMap();
const names = {get: id => ADMINISTRATIONS.find(item => item.id === id)?.name};

/** Enhance the existing form select without changing its values or change events. */
export function mountAdministrationPicker(select) {
  if (!select?.matches('select') || !select.options.length) return null;
  if (mounted.has(select)) return mounted.get(select);
  const host = select.closest('.administration-select');
  if (!host) return null;

  const oldIcon = host.querySelector('#form-administration-icon');
  const original = {
    hidden: select.hidden,
    ariaHidden: select.getAttribute('aria-hidden'),
    tabIndex: select.getAttribute('tabindex'),
    iconHidden: oldIcon?.hidden,
  };
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.id = 'form-administration-trigger';
  trigger.className = 'administration-picker-trigger';
  trigger.setAttribute('role', 'combobox');
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-controls', 'form-administration-listbox');
  if (select.getAttribute('aria-labelledby')) {
    trigger.setAttribute('aria-labelledby', select.getAttribute('aria-labelledby'));
  } else {
    trigger.setAttribute('aria-label', select.getAttribute('aria-label') || t('给药方式'));
  }
  trigger.setAttribute('aria-required', String(select.required));

  const valueIcon = document.createElement('span');
  valueIcon.className = 'administration-picker-symbol';
  valueIcon.setAttribute('aria-hidden', 'true');
  const valueLabel = document.createElement('span');
  valueLabel.id = 'form-administration-value';
  valueLabel.className = 'administration-picker-value';
  if (select.getAttribute('aria-labelledby')) trigger.setAttribute('aria-labelledby', `${select.getAttribute('aria-labelledby')} ${valueLabel.id}`);
  const chevron = document.createElement('span');
  chevron.className = 'administration-picker-chevron';
  chevron.setAttribute('aria-hidden', 'true');
  chevron.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m4 6 4 4 4-4"/></svg>';
  trigger.append(valueIcon, valueLabel, chevron);

  const listbox = document.createElement('div');
  listbox.id = 'form-administration-listbox';
  listbox.className = 'administration-picker-listbox';
  listbox.setAttribute('role', 'listbox');
  listbox.setAttribute('aria-label', t('给药方式'));
  listbox.hidden = true;

  const choices = [...select.options].map((option, index) => {
    const row = document.createElement('div');
    row.id = `form-administration-option-${index}`;
    row.className = 'administration-picker-option';
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', 'false');
    row.dataset.value = option.value;
    if (option.disabled) row.setAttribute('aria-disabled', 'true');
    const icon = document.createElement('span');
    icon.className = 'administration-picker-symbol';
    icon.innerHTML = administrationIcon(option.value, { size: 20 });
    const label = document.createElement('span');
    label.className = 'administration-picker-option-label';
    label.textContent = names.get(option.value) || option.textContent;
    const check = document.createElement('span');
    check.className = 'administration-picker-check';
    check.setAttribute('aria-hidden', 'true');
    check.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m3.5 8 3 3 6-6"/></svg>';
    row.append(icon, label, check);
    listbox.append(row);
    return { option, row };
  });

  let activeIndex = -1;
  const enabledIndexes = () => choices.flatMap(({ option }, index) => option.disabled ? [] : [index]);
  const isOpen = () => !listbox.hidden;
  const scrollActiveIntoView = () => {
    const row = choices[activeIndex]?.row;
    if (!row || !isOpen()) return;
    const itemBounds = row.getBoundingClientRect();
    const listBounds = listbox.getBoundingClientRect();
    if (itemBounds.top < listBounds.top + 5) listbox.scrollTop -= listBounds.top + 5 - itemBounds.top;
    else if (itemBounds.bottom > listBounds.bottom - 5) listbox.scrollTop += itemBounds.bottom - listBounds.bottom + 5;
  };
  const setActive = (index, scroll = true) => {
    if (!choices[index] || choices[index].option.disabled) return;
    activeIndex = index;
    choices.forEach(({ row }, i) => row.classList.toggle('is-active', i === index));
    if (isOpen()) trigger.setAttribute('aria-activedescendant', choices[index].row.id);
    if (scroll) scrollActiveIntoView();
  };
  const sync = () => {
    const selectedIndex = choices.findIndex(({ option }) => option.value === select.value);
    const selected = choices[selectedIndex]?.option;
    valueIcon.innerHTML = administrationIcon(selected?.value, { size: 20 });
    valueLabel.textContent = selected ? names.get(selected.value) || selected.textContent : '请选择给药方式';
    trigger.disabled = select.disabled;
    choices.forEach(({ option, row }, i) => {
      row.setAttribute('aria-selected', String(i === selectedIndex));
      row.setAttribute('aria-disabled', String(option.disabled));
    });
    setActive(selectedIndex >= 0 ? selectedIndex : enabledIndexes()[0], isOpen());
  };
  const close = () => {
    listbox.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    trigger.removeAttribute('aria-activedescendant');
    host.classList.remove('administration-picker-open');
  };
  const open = () => {
    if (select.disabled || !enabledIndexes().length) return;
    sync();
    listbox.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    host.classList.add('administration-picker-open');
    trigger.focus({ preventScroll: true });
    setActive(activeIndex);
    // The dialog owns scrolling: keep this short list inside its visible area,
    // including the minimum desktop window size, without adding inline styles.
    listbox.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
  };
  const choose = index => {
    const selected = choices[index]?.option;
    if (!selected || selected.disabled || select.disabled) return;
    const changed = select.value !== selected.value;
    select.value = selected.value;
    sync();
    close();
    // Re-selecting the current route must not clear an already-entered dose.
    if (changed) select.dispatchEvent(new Event('change', { bubbles: true }));
    if (trigger.isConnected) trigger.focus({ preventScroll: true });
  };

  trigger.addEventListener('click', () => isOpen() ? close() : open());
  trigger.addEventListener('blur', close);
  trigger.addEventListener('keydown', event => {
    if (event.key === 'Escape' && isOpen()) {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === 'Tab') {
      close();
      return; // Keep the normal form tab order and Shift+Tab behavior.
    }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      if (event.altKey && event.key === 'ArrowUp' && isOpen()) { close(); return; }
      const wasOpen = isOpen();
      if (!wasOpen) open();
      const enabled = enabledIndexes();
      if (!enabled.length) return;
      if (event.key === 'Home') setActive(enabled[0]);
      else if (event.key === 'End') setActive(enabled.at(-1));
      else if (wasOpen) {
        const position = enabled.indexOf(activeIndex);
        const next = Math.max(0, Math.min(enabled.length - 1, position + (event.key === 'ArrowDown' ? 1 : -1)));
        setActive(enabled[next]);
      }
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (isOpen()) choose(activeIndex);
      else open();
    }
  });
  // Options are not tab stops. Keep focus on the combobox during mouse selection;
  // mousedown (rather than touch/pointerdown) also leaves touch scrolling intact.
  listbox.addEventListener('mousedown', event => event.preventDefault());
  listbox.addEventListener('click', event => {
    const row = event.target.closest('[role="option"]');
    if (row && listbox.contains(row)) choose(choices.findIndex(choice => choice.row === row));
  });
  listbox.addEventListener('mousemove', event => {
    const row = event.target.closest('[role="option"]');
    if (row && listbox.contains(row)) setActive(choices.findIndex(choice => choice.row === row), false);
  });
  select.addEventListener('change', sync);
  const reset = () => queueMicrotask(() => { if (select.isConnected) { close(); sync(); } });
  select.form?.addEventListener('reset', reset);

  const hadFocus = document.activeElement === select;
  host.append(trigger, listbox);
  sync();
  host.classList.add('administration-picker-enhanced');
  select.hidden = true;
  select.setAttribute('aria-hidden', 'true');
  select.setAttribute('tabindex', '-1');
  if (oldIcon) oldIcon.hidden = true;
  if (hadFocus) trigger.focus({ preventScroll: true });

  const controller = { sync, close, destroy() {
    close();
    select.removeEventListener('change', sync);
    select.form?.removeEventListener('reset', reset);
    trigger.remove();
    listbox.remove();
    host.classList.remove('administration-picker-enhanced');
    select.hidden = original.hidden;
    for (const [attribute, value] of [['aria-hidden', original.ariaHidden], ['tabindex', original.tabIndex]]) {
      if (value === null) select.removeAttribute(attribute);
      else select.setAttribute(attribute, value);
    }
    if (oldIcon) oldIcon.hidden = original.iconHidden;
    mounted.delete(select);
  } };
  mounted.set(select, controller);
  return controller;
}
