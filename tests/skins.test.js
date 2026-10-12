import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createSkinStore, collectModel, relativeName, LIMITS } = require('../electron/skins.cjs');

const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8XsAAAAASUVORK5CYII=', 'base64');
const json = value => Buffer.from(JSON.stringify(value));
function fixture(run) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-skins-test-'));
  const source = path.join(folder, 'model');
  const user = path.join(folder, 'user');
  fs.mkdirSync(source);
  const definition = { Version: 3, FileReferences: { Moc: 'shark.moc3', Textures: ['textures/鲨鲨.png'], Physics: 'shark.physics3.json', Pose: 'shark.pose3.json', UserData: 'shark.userdata3.json', DisplayInfo: 'shark.cdi3.json', Expressions: [{ Name: 'smile', File: 'expressions/smile.exp3.json' }], Motions: { Idle: [{ File: 'motions/idle.motion3.json', Sound: 'do-not-copy.wav', FadeInTime: 0.2 }] } }, HitAreas: [{ Id: 'HitHead', Name: 'Head' }], Script: 'do-not-copy.js' };
  const files = {
    '鲨鲨.model3.json': json(definition),
    'shark.moc3': Buffer.from('MOC3\x01\x00\x00\x00'),
    'textures/鲨鲨.png': pixel,
    'shark.physics3.json': json({ Version: 3, PhysicsSettings: [] }),
    'shark.pose3.json': json({ Type: 'Live2D Pose', Groups: [] }),
    'shark.userdata3.json': json({ Version: 3, UserData: [] }),
    'shark.cdi3.json': json({ Version: 3, Parameters: [] }),
    'expressions/smile.exp3.json': json({ Type: 'Live2D Expression', Parameters: [] }),
    'motions/idle.motion3.json': json({ Version: 3, Curves: [] }),
    'private-health-records.json': json({ secret: 'Not a model resource' }),
    'do-not-copy.js': Buffer.from('throw new Error("Never load me");'),
    'do-not-copy.wav': Buffer.from('Unreferenced audio is not imported'),
  };
  for (const [name, bytes] of Object.entries(files)) {
    const destination = path.join(source, ...name.split('/'));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, bytes);
  }
  const model = path.join(source, '鲨鲨.model3.json');
  const writeDefinition = value => fs.writeFileSync(model, JSON.stringify(value));
  try { return run({ folder, source, user, model, definition, writeDefinition }); }
  finally {
    const resolved = path.resolve(folder);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.match(path.basename(resolved), /^tide-skins-test-/);
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

test('imports only referenced assets and sanitizes model resource definitions without modifying originals', () => fixture(({ source, user, model }) => {
  const before = fs.readFileSync(model);
  const store = createSkinStore(user);
  const result = store.importModel(model);
  assert.equal(result.name, '鲨鲨');
  assert.match(result.modelUrl, /^tide-skin:\/\/[a-f0-9-]+\/%E9/);
  const imported = JSON.parse(store.readUrl(result.modelUrl).bytes);
  assert.equal(imported.FileReferences.Motions.Idle[0].Sound, undefined);
  assert.equal(imported.Script, undefined);
  assert.deepEqual(imported.HitAreas, [{ Id: 'HitHead', Name: 'Head' }]);
  assert.deepEqual(fs.readFileSync(model), before);
  const destination = path.join(store.root, result.id);
  assert.equal(fs.existsSync(path.join(destination, 'private-health-records.json')), false);
  assert.equal(fs.existsSync(path.join(destination, 'do-not-copy.js')), false);
  assert.equal(fs.existsSync(path.join(destination, 'do-not-copy.wav')), false);
  const textureUrl = new URL('textures/%E9%B2%A8%E9%B2%A8.png', result.modelUrl).href;
  assert.deepEqual(store.readUrl(textureUrl).bytes, pixel);
  assert.equal(store.readUrl(textureUrl).mime, 'image/png');
  assert.ok(fs.existsSync(path.join(source, 'private-health-records.json')));
}));

test('skin manifests survive restart and asset reads enforce integrity', () => fixture(({ user, model }) => {
  const first = createSkinStore(user);
  const skin = first.importModel(model);
  const restarted = createSkinStore(user);
  assert.deepEqual(restarted.list(), [skin]);
  assert.equal(restarted.has(skin.id), true);
  assert.ok(restarted.readUrl(skin.modelUrl).bytes.length > 0);
  const destination = path.join(restarted.root, skin.id, 'shark.moc3');
  const changed = fs.readFileSync(destination); changed[7] = 9; fs.writeFileSync(destination, changed);
  assert.throws(() => restarted.readUrl(new URL('shark.moc3', skin.modelUrl).href), /已改变/);
}));

test('protocol access cannot read health data, manifests, parent paths, scripts, or another protocol', () => fixture(({ user, model }) => {
  const store = createSkinStore(user);
  const skin = store.importModel(model);
  fs.writeFileSync(path.join(user, 'state.json'), '{"private":true}');
  for (const suffix of ['manifest.json', 'private-health-records.json', '../../state.json', '%2e%2e/state.json', '%252e%252e/state.json', '/state.json', 'do-not-copy.js', 'shark.moc3?secret=1', 'shark.moc3#part']) {
    assert.throws(() => store.readUrl(`tide-skin://${skin.id}/${suffix}`));
  }
  for (const url of [`file://${model}`, `https://${skin.id}/shark.moc3`, `tide-skin://user@${skin.id}/shark.moc3`, `tide-skin://${skin.id}:80/shark.moc3`]) assert.throws(() => store.readUrl(url));
}));

test('model references reject traversal, absolute paths, network links and encoded escapes', () => fixture(({ user, model, definition, writeDefinition }) => {
  const store = createSkinStore(user);
  for (const invalid of ['../outside.moc3', 'sub/../../outside.moc3', 'C:\\outside.moc3', '/outside.moc3', '\\\\server\\share\\outside.moc3', 'https://example.com/model.moc3', '%2e%2e/secret.moc3', 'CON.moc3', 'dir./shark.moc3']) {
    const bad = structuredClone(definition); bad.FileReferences.Moc = invalid; writeDefinition(bad);
    assert.throws(() => store.importModel(model), /皮肤导入失败/);
    assert.deepEqual(fs.readdirSync(store.root), []);
  }
}));

test('scripts and SVG/WASM cannot be imported as model data or textures', () => fixture(({ model, definition, writeDefinition }) => {
  for (const value of ['do-not-copy.js', 'payload.wasm', 'texture.svg', 'page.html']) {
    const bad = structuredClone(definition); bad.FileReferences.Textures = [value]; writeDefinition(bad);
    assert.throws(() => collectModel(model), /类型不匹配/);
  }
  const bad = structuredClone(definition); bad.FileReferences.Script = 'do-not-copy.js'; writeDefinition(bad);
  assert.throws(() => collectModel(model), /FileReferences/);
}));

test('directory junctions or symbolic links are rejected even when their targets contain valid textures', t => fixture(({ folder, source, model, definition, writeDefinition }) => {
  const outside = path.join(folder, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'skin.png'), pixel);
  try { fs.symlinkSync(outside, path.join(source, 'linked'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('Creating links requires permissions on this host.'); return; } throw error; }
  const bad = structuredClone(definition); bad.FileReferences.Textures = ['linked/skin.png']; writeDefinition(bad);
  assert.throws(() => collectModel(model), /符号链接或目录联接/);
  assert.deepEqual(fs.readFileSync(path.join(outside, 'skin.png')), pixel);
}));

test('missing or malformed resources leave no partial imported skin', () => fixture(({ source, user, model }) => {
  const store = createSkinStore(user);
  fs.writeFileSync(path.join(source, 'shark.moc3'), 'not a valid model');
  assert.throws(() => store.importModel(model), /moc3/);
  assert.deepEqual(fs.readdirSync(store.root), []);
  fs.unlinkSync(path.join(source, 'shark.moc3'));
  assert.throws(() => store.importModel(model));
  assert.deepEqual(fs.readdirSync(store.root), []);
}));

test('oversized and excessive-dimension assets are rejected before being copied', () => fixture(({ source, user, model }) => {
  const store = createSkinStore(user);
  const texture = path.join(source, 'textures', '鲨鲨.png');
  fs.truncateSync(texture, LIMITS.fileBytes + 1);
  assert.throws(() => store.importModel(model), /64 MB/);
  const huge = Buffer.from(pixel); huge.writeUInt32BE(65536, 16); fs.writeFileSync(texture, huge);
  assert.throws(() => store.importModel(model), /纹理尺寸/);
  assert.deepEqual(fs.readdirSync(store.root), []);
}));

test('deleting an imported skin never removes original files or paths outside its UUID directory', () => fixture(({ user, model }) => {
  const store = createSkinStore(user);
  const skin = store.importModel(model);
  for (const invalid of ['builtin', '../model', path.dirname(model)]) assert.throws(() => store.remove(invalid));
  store.remove(skin.id);
  assert.deepEqual(store.list(), []);
  assert.equal(fs.existsSync(path.join(store.root, skin.id)), false);
  assert.ok(fs.existsSync(model));
  assert.throws(() => store.readUrl(skin.modelUrl));
}));

test('tampered manifests are ignored on restart without deleting evidence', () => fixture(({ user, model }) => {
  const store = createSkinStore(user);
  const skin = store.importModel(model);
  const file = path.join(store.root, skin.id, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8')); manifest.files[0].path = '../../state.json'; fs.writeFileSync(file, JSON.stringify(manifest));
  const restarted = createSkinStore(user);
  assert.deepEqual(restarted.list(), []);
  assert.ok(fs.existsSync(file));
  assert.throws(() => restarted.readUrl(skin.modelUrl));
}));

test('auxiliary JSON cannot extend the resource graph or pollute object prototypes', () => fixture(({ source, model }) => {
  fs.writeFileSync(path.join(source, 'shark.physics3.json'), '{"Version":3,"FileReferences":{"Moc":"../../private.moc3"}}');
  assert.throws(() => collectModel(model), /辅助 JSON/);
  fs.writeFileSync(path.join(source, 'shark.physics3.json'), '{"Version":3,"__proto__":{"polluted":true}}');
  assert.throws(() => collectModel(model), /对象属性/);
  assert.equal({}.polluted, undefined);
}));

test('relative file validation supports Unicode and normalized local separators', () => {
  assert.equal(relativeName('表情\\开心.exp3.json'), '表情/开心.exp3.json');
  for (const value of ['', '.', '..', 'textures//skin.png', 'skin.png ', 'C:skin.png', 'http:skin.png']) assert.throws(() => relativeName(value));
});
