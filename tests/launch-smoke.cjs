// Isolated Electron entry: never opens or overwrites the user's health records.
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
if (!process.env.TIDE_TEST_DATA) throw new Error('TIDE_TEST_DATA must identify an isolated test directory.');
fs.mkdirSync(process.env.TIDE_TEST_DATA, { recursive: true });
app.setPath('userData', process.env.TIDE_TEST_DATA);
// Only this isolated fixture can override OS language for locale regression tests.
if (process.env.TIDE_TEST_SYSTEM_LOCALE) app.getPreferredSystemLanguages = () => [process.env.TIDE_TEST_SYSTEM_LOCALE];
const appRoot = process.env.TIDE_TEST_APP_ROOT || path.resolve(__dirname, '..');
// Existing interaction suites start after setup. The onboarding suite uses the
// same production entry with a genuinely fresh or legacy store instead.
if (process.env.TIDE_TEST_ONBOARDING !== '1') {
  const file = path.join(process.env.TIDE_TEST_DATA, 'state.json');
  const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : require(path.join(appRoot, 'electron/state.cjs')).defaultState();
  state.settings.onboardingCompleted = true;
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
}
require(path.join(appRoot, 'electron/main.cjs'));
