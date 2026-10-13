// Shared by Electron and the renderer; no network, DOM or health-data access.
(function (root, factory) {
  root.TideI18nCore = factory();
})(globalThis, function () {
  'use strict';
  const LOCALES = Object.freeze(['en', 'zh-CN', 'zh-TW', 'ja', 'ko', 'es']);
  const TRANSLATION_LOCALES = Object.freeze(['en', 'zh-TW', 'ja', 'ko', 'es']);
  const PREFERENCES = Object.freeze(['system', ...LOCALES]);
  function resolveLanguage(preference = 'system', systemLocale = 'en') {
    if (LOCALES.includes(preference)) return preference;
    const language = String(Array.isArray(systemLocale) ? systemLocale[0] : systemLocale || 'en').replaceAll('_', '-').toLowerCase();
    if (/^zh(?:-|$)/.test(language)) return /(?:^|-)hant(?:-|$)|(?:^|-)(?:tw|hk|mo)(?:-|$)/.test(language) ? 'zh-TW' : 'zh-CN';
    const base = language.split('-')[0];
    return LOCALES.includes(base) ? base : 'en';
  }
  function createI18n(catalogs = []) {
    const messages = Object.assign(Object.create(null), ...catalogs);
    let locale = 'zh-CN';
    const listeners = new Set();
    function t(source, parameters = {}) {
      const key = String(source ?? '');
      const index = TRANSLATION_LOCALES.indexOf(locale);
      const translated = index >= 0 && messages[key]?.[index] || key;
      return translated.replace(/\{([\w]+)\}/g, (match, name) => Object.hasOwn(parameters, name) ? String(parameters[name] ?? '') : match);
    }
    return {
      t, getLocale: () => locale,
      setLanguage(preference, systemLocale) {
        const next = resolveLanguage(preference, systemLocale);
        if (next !== locale) { locale = next; for (const listener of listeners) listener(locale); }
        return locale;
      },
      onLanguageChange(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      has: source => Object.hasOwn(messages, source),
    };
  }
  return {LOCALES, TRANSLATION_LOCALES, PREFERENCES, resolveLanguage, createI18n};
});
