import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readZip, writeZip, makeIcns, stageMacSource, MAC_SOURCE_FILES } from '../scripts/package-macos.mjs';
import { machoSignature } from '../scripts/verify-macos.mjs';
const require = createRequire(import.meta.url);
const asar = createRequire(require.resolve('@electron/packager'))('@electron/asar');

test('macOS ZIP preserves executable permissions, UTF-8 paths and POSIX link bytes', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tide-mac-zip-'));
  try {
    const filename = path.join(dir, 'app.zip');
    const input = new Map([
      ['潮汐.app/Contents/MacOS/Electron', { mode: 0o100755, data: () => Buffer.from('executable') }],
      ['潮汐.app/Contents/Frameworks/A.framework/Versions/Current', { mode: 0o120777, data: () => Buffer.from('A') }],
      ['macOS使用说明.txt', { mode: 0o100644, data: () => Buffer.from('使用说明') }],
    ]);
    await writeZip(filename, input);
    const output = readZip(await fs.readFile(filename));
    assert.equal(output.size, 3);
    for (const [name, entry] of input) {
      assert.equal(output.get(name).mode, entry.mode);
      assert.deepEqual(output.get(name).data(), entry.data());
    }
    const damaged = await fs.readFile(filename);
    const first = output.keys().next().value;
    const central = damaged.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    damaged.writeUInt32LE((damaged.readUInt32LE(central + 16) ^ 1) >>> 0, central + 16);
    assert.throws(() => readZip(damaged).get(first).data(), /CRC/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('ZIP parser rejects absent directory and traversal', async () => {
  assert.throws(() => readZip(Buffer.alloc(5)), /end record/);
  assert.throws(() => readZip(Buffer.alloc(70000)), /end record/);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tide-mac-zip-'));
  try {
    const filename = path.join(dir, 'unsafe.zip');
    await writeZip(filename, new Map([['../outside', { mode: 0o100644, data: () => Buffer.from('no') }]]));
    const unsafe = await fs.readFile(filename);
    assert.throws(() => readZip(unsafe), /Unsafe/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('Mac icon wraps original 256px PNG and source whitelist excludes workstation files', async () => {
  const png = await fs.readFile(new URL('../assets/app.png', import.meta.url));
  const icon = makeIcns(png);
  assert.equal(icon.subarray(0, 4).toString(), 'icns');
  assert.equal(icon.readUInt32BE(4), icon.length);
  assert.equal(icon.subarray(8, 12).toString(), 'ic08');
  assert.deepEqual(icon.subarray(16), png);
  assert.deepEqual(MAC_SOURCE_FILES, ['electron', 'src', 'assets', 'index.html', 'pet.html', 'package.json', 'LICENSE']);
});

test('Mac source ASAR excludes separately obtained Core, preserves its source, and includes the root license', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tide-mac-source-'));
  const source = path.join(dir, 'source'), stage = path.join(dir, 'stage');
  const core = Buffer.from('local-only proprietary runtime fixture');
  const license = await fs.readFile(new URL('../LICENSE', import.meta.url));
  try {
    for (const name of ['electron', 'src', 'assets/vendor']) await fs.mkdir(path.join(source, name), { recursive: true });
    await fs.mkdir(stage);
    for (const name of ['index.html', 'pet.html']) await fs.writeFile(path.join(source, name), '<!doctype html>');
    await fs.writeFile(path.join(source, 'package.json'), '{"name":"mac-package-fixture","version":"1.0.0"}');
    await fs.writeFile(path.join(source, 'electron/main.cjs'), '// application fixture');
    await fs.writeFile(path.join(source, 'LICENSE'), license);
    await fs.writeFile(path.join(source, 'assets/vendor/live2dcubismcore.min.js'), core);
    await fs.writeFile(path.join(source, 'assets/vendor/PIXI-LICENSE.txt'), 'third-party license fixture');
    await stageMacSource(source, stage);
    const archive = path.join(dir, 'app.asar');
    await asar.createPackage(stage, archive);
    const files = asar.listPackage(archive).map(name => name.replaceAll('\\', '/').replace(/^\/+/, ''));
    assert.ok(!files.includes('assets/vendor/live2dcubismcore.min.js'));
    assert.deepEqual(asar.extractFile(archive, 'LICENSE'), license);
    assert.equal(asar.extractFile(archive, path.normalize('assets/vendor/PIXI-LICENSE.txt')).toString(), 'third-party license fixture');
    assert.deepEqual(await fs.readFile(path.join(source, 'assets/vendor/live2dcubismcore.min.js')), core, 'Source Core must remain untouched');
  } finally {
    // Only this test's freshly created, resolved temporary directory is removed.
    assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(dir, { recursive: true, force: true });
  }
});

function signedMachFixture() {
  const body = Buffer.alloc(48);
  body.writeUInt32LE(0xfeedfacf); body.writeUInt32LE(0x0100000c, 4); body.writeUInt32LE(1, 16);
  body.writeUInt32LE(0x1d, 32); body.writeUInt32LE(16, 36); body.writeUInt32LE(48, 40); body.writeUInt32LE(96, 44);
  const directory = Buffer.alloc(76);
  directory.writeUInt32BE(0xfade0c02); directory.writeUInt32BE(76, 4); directory.writeUInt32BE(0x20100, 8); directory.writeUInt32BE(2, 12);
  directory.writeUInt32BE(44, 16); directory.writeUInt32BE(1, 28); directory.writeUInt32BE(48, 32); directory[36] = 32; directory[37] = 2; directory[39] = 12;
  createHash('sha256').update(body).digest().copy(directory, 44);
  const superblob = Buffer.alloc(20);
  superblob.writeUInt32BE(0xfade0cc0); superblob.writeUInt32BE(96, 4); superblob.writeUInt32BE(1, 8); superblob.writeUInt32BE(20, 16);
  return Buffer.concat([body, superblob, directory]);
}

test('Mach-O verifier detects post-signing code changes, wrong CPU and missing ad-hoc flag', () => {
  const fixture = signedMachFixture();
  assert.ok(machoSignature(fixture, 0x0100000c));
  assert.throws(() => machoSignature(fixture, 0x01000007), /architecture/);
  const mutated = Buffer.from(fixture); mutated[24] ^= 1;
  assert.throws(() => machoSignature(mutated, 0x0100000c), /Code page/);
  const certified = Buffer.from(fixture); certified.writeUInt32BE(0, 48 + 20 + 12);
  assert.throws(() => machoSignature(certified, 0x0100000c), /ad-hoc/);
});
