import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const source = readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');
const appData = 'C:\\Users\\Fixture\\AppData\\Roaming';

function setup(oldName, customUserData) {
  let name = oldName;
  let userData = customUserData || path.win32.join(appData, oldName);
  const app = {
    getName: () => name, setName: value => { name = value; },
    getPath: key => key === 'appData' ? appData : userData,
    setPath: (key, value) => { assert.equal(key, 'userData'); userData = value; },
    setAppUserModelId() {}, requestSingleInstanceLock: () => false, quit() {},
  };
  const context = vm.createContext({
    require: id => id === 'electron' ? { app, protocol: { registerSchemesAsPrivileged() {} } }
      : id === 'node:path' ? path.win32 : id.startsWith('node:') ? require(id)
      : id === './platform.cjs' ? require('../electron/platform.cjs') : {},
    process: { platform: 'win32', execPath: 'C:\\Fixture\\Tide-Companion.exe' },
    __dirname: 'C:\\Fixture\\electron', console,
  });
  vm.runInContext(source, context);
  return { name, userData };
}

test('the formal name changes while all historical default launches continue using the original data directory', () => {
  for (const oldName of ['潮汐', 'Tide Companion', 'tide-companion', '小浪桌宠']) {
    assert.deepEqual(setup(oldName), { name: '潮汐', userData: path.win32.join(appData, '小浪桌宠') });
  }
});

test('renaming does not redirect custom or isolated data directories into real health records', () => {
  for (const custom of ['D:\\Isolated Test\\data', 'E:\\Personal\\Tide', 'C:\\Users\\Fixture\\AppData\\Roaming\\小浪桌宠']) {
    assert.deepEqual(setup('潮汐', custom), { name: '潮汐', userData: custom });
  }
});
