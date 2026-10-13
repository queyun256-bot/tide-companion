'use strict';

const { createI18n } = require('../src/i18n-core.cjs');
const catalog = require('../src/locales/native.json');

// Electron's UI locale can differ from the operating system's preferred UI
// language. Query only after app.whenReady; stubbed/headless environments keep
// the original Chinese default without consulting the host running the tests.
function readSystemLocale(app) {
  for (const get of [
    () => app.getPreferredSystemLanguages?.()?.[0],
    () => app.getSystemLocale?.(),
    () => app.getLocale?.(),
  ]) {
    try {
      const value = get();
      if (typeof value === 'string' && value.trim()) return value;
    } catch { /* An older Electron API can be unavailable. */ }
  }
  return 'zh-CN';
}

function createNativeI18n(app) {
  const i18n = createI18n([catalog]);
  let systemLocale = 'zh-CN', preference = 'system';
  i18n.setLanguage(preference, systemLocale);
  return {
    t: (source, params) => i18n.t(source, params),
    setLanguage(nextPreference = 'system') {
      systemLocale = readSystemLocale(app);
      i18n.setLanguage(nextPreference, systemLocale);
      preference = nextPreference;
    },
    getInfo: () => ({ systemLocale, locale: i18n.getLocale(), preference }),
  };
}

module.exports = { readSystemLocale, createNativeI18n };
