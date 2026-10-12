import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { platformInfo, userDataFolder, loginItemOptions, startupHidden } = createRequire(import.meta.url)('../electron/platform.cjs');

test('release capabilities distinguish Windows support from unavailable macOS integrations', () => {
  assert.deepEqual(platformInfo('win32'), { id: 'win32', label: 'Windows', fullscreenDetection: true, automaticLoginSettings: true });
  assert.deepEqual(platformInfo('darwin'), { id: 'darwin', label: 'macOS', fullscreenDetection: false, automaticLoginSettings: false });
  assert.deepEqual(platformInfo('linux'), { id: 'linux', label: '桌面', fullscreenDetection: false, automaticLoginSettings: false });
});

test('macOS receives a native product directory while existing desktop records keep their legacy location', () => {
  assert.equal(userDataFolder('darwin'), '潮汐');
  assert.equal(userDataFolder('win32'), '小浪桌宠');
  assert.equal(userDataFolder('linux'), '小浪桌宠');
});

test('login item options preserve the exact Windows executable and hidden argument without leaking them to macOS', () => {
  const executable = 'C:\\用户资料\\潮汐 app\\Tide-Companion.exe', appId = 'org.transpet.desktop';
  assert.deepEqual(loginItemOptions(true, 'win32', executable, appId), { openAtLogin: true, name: appId, path: executable, args: ['--hidden'] });
  assert.deepEqual(loginItemOptions(false, 'win32', executable, appId), { openAtLogin: false, name: appId, path: executable, args: ['--hidden'] });
  assert.deepEqual(loginItemOptions(true, 'darwin', '/Applications/潮汐.app/Contents/MacOS/潮汐', appId), { openAtLogin: true });
  assert.deepEqual(loginItemOptions(false, 'darwin', executable, appId), { openAtLogin: false });
});

test('hidden startup accepts the explicit switch or confirmed macOS login launch, never another platform or a similar string', () => {
  assert.equal(startupHidden({ platform: 'win32', argv: ['app.exe', '--hidden'] }), true);
  assert.equal(startupHidden({ platform: 'darwin', argv: ['app'], loginSettings: { wasOpenedAtLogin: true } }), true);
  assert.equal(startupHidden({ platform: 'darwin', argv: ['app'], loginSettings: { wasOpenedAtLogin: false } }), false);
  assert.equal(startupHidden({ platform: 'darwin', argv: ['app'], loginSettings: { wasOpenedAtLogin: 'true' } }), false);
  assert.equal(startupHidden({ platform: 'win32', argv: ['app'], loginSettings: { wasOpenedAtLogin: true } }), false);
  assert.equal(startupHidden({ platform: 'darwin', argv: ['--hidden=false', 'file--hidden.txt'] }), false);
  assert.equal(startupHidden({ platform: 'darwin', argv: [] }), false);
});
