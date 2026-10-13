import './i18n-core.js';
import appMessages from './locales/app.json' with {type:'json'};
import nativeMessages from './locales/native.json' with {type:'json'};
import journalMessages from './locales/journal.json' with {type:'json'};
import companionMessages from './locales/companion.json' with {type:'json'};

// .js has a JavaScript MIME type under file:// in both desktop renderers.
const core = globalThis.TideI18nCore;
const engine = core.createI18n([nativeMessages, journalMessages, companionMessages, appMessages]);
export const {t, getLocale, onLanguageChange} = engine;
export const {LOCALES, PREFERENCES, TRANSLATION_LOCALES, resolveLanguage} = core;
export const LANGUAGE_NAMES = Object.freeze({'en':'English','zh-CN':'简体中文','zh-TW':'繁體中文','ja':'日本語','ko':'한국어','es':'Español'});
export function setLanguage(preference = 'system', systemLocale = globalThis.navigator?.language || 'en') {
  const locale = engine.setLanguage(preference, systemLocale);
  if (typeof document !== 'undefined') document.documentElement.lang = locale;
  return locale;
}
export const formatNumber = (value, options) => new Intl.NumberFormat(getLocale(), options).format(value);
export function translateError(error) {
  // Electron prefixes IPC exceptions; translate the original application message.
  const message = String(error?.message ?? error ?? '').replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
  if (message.startsWith('数据格式不正确：')) return t('数据格式不正确：{0}', {0:t(message.slice('数据格式不正确：'.length))});
  if (message.endsWith('存在重复 ID')) return t('{0}存在重复 ID', {0:t(message.slice(0,-'存在重复 ID'.length))});
  if (message.startsWith('皮肤导入失败：')) return t('皮肤导入失败：{0}', {0:translateError(message.slice('皮肤导入失败：'.length))});
  // These arguments are user-controlled file labels: preserve them verbatim.
  for (const suffix of [' JSON 文件过大。',' 不是有效 JSON。',' 顶层必须是 JSON 对象。',' JSON 结构过于复杂。',' 含不支持的对象属性。',' 包含无效数值。']) {
    if (message.endsWith(suffix)) return t(`{0}${suffix}`, {0:message.slice(0,-suffix.length)});
  }
  if (message.startsWith('引用文件类型不匹配：')) return t('引用文件类型不匹配：{0}', {0:message.slice('引用文件类型不匹配：'.length)});
  return t(message);
}
export function applyTranslations(root = document) {
  const elements = [...root.querySelectorAll('[data-i18n],[data-i18n-title],[data-i18n-aria-label],[data-i18n-placeholder]')];
  if (root.matches?.('[data-i18n],[data-i18n-title],[data-i18n-aria-label],[data-i18n-placeholder]')) elements.unshift(root);
  for (const element of elements) {
    if (element.hasAttribute('data-i18n')) element.textContent = t(element.getAttribute('data-i18n'));
    for (const attribute of ['title', 'aria-label', 'placeholder']) if (element.hasAttribute(`data-i18n-${attribute}`)) element.setAttribute(attribute, t(element.getAttribute(`data-i18n-${attribute}`)));
  }
}

// Translates only literal text authored in a tagged HTML template. Interpolated
// values (including user names, plan names and already-rendered components) stay
// opaque, so language changes never rewrite user input or HTML attributes/IDs.
const marker = /\uE000(\d+)\uE001/g;
const encodeText = value => value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
function fragment(source, attribute = false, markup = true) {
  if (!/[\u3400-\u9fff]/.test(source)) return source;
  const parameters = {};
  let index = 0;
  const key = source.replace(marker, value => {parameters[index] = value; return `{${index++}}`;});
  const translated = t(key, parameters);
  if (translated === source) return source;
  return attribute ? encodeText(translated).replaceAll('"','&quot;') : markup ? encodeText(translated) : translated;
}
export function html(strings, ...values) {
  const source = typeof strings === 'string' ? strings : strings.reduce((text, literal, index) => text + literal + (index < values.length ? `\uE000${index}\uE001` : ''), '');
  const markup = source.includes('<');
  const translated = source.split(/(<[^>]*>)/g).map(part => {
    const attributes = part.replace(/\b(title|aria-label|placeholder)="([^"]*)"/g, (_, attribute, value) => `${attribute}="${fragment(value, true)}"`);
    return part.startsWith('<') ? attributes : fragment(attributes, false, markup);
  }).join('');
  return translated.replace(marker, (_, index) => String(values[Number(index)] ?? ''));
}
