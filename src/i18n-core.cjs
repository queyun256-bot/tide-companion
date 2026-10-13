// Node/Electron's synchronous ESM loader shares the browser's pure locale core.
require('./i18n-core.js');
module.exports = globalThis.TideI18nCore;
