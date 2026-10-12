// Offline structural/signature validation is not a substitute for macOS
// codesign --verify --deep --strict or a real Gatekeeper/launch test.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readZip, PRODUCT, BUNDLE_ID, ROOT, sha256 } from './package-macos.mjs';
const require = createRequire(import.meta.url);
const dependency = createRequire(require.resolve('@electron/packager'));
const plist = dependency('plist');
const asar = dependency('@electron/asar');
const digest = (bytes, algorithm) => createHash(algorithm).update(bytes).digest();
const isLink = entry => (entry.mode & 0o170000) === 0o120000;

export function machoSignature(bytes, expectedCpu) {
  if (bytes.length < 32 || bytes.readUInt32LE(0) !== 0xfeedfacf) return null;
  assert.equal(bytes.readUInt32LE(4), expectedCpu, 'Wrong Mach-O architecture');
  let offset = 32, signature;
  for (let i = 0; i < bytes.readUInt32LE(16); i++) {
    const command = bytes.readUInt32LE(offset), length = bytes.readUInt32LE(offset + 4);
    assert.ok(length >= 8 && offset + length <= bytes.length, 'Invalid Mach-O command');
    if (command === 0x1d) signature = bytes.subarray(bytes.readUInt32LE(offset + 8), bytes.readUInt32LE(offset + 8) + bytes.readUInt32LE(offset + 12));
    offset += length;
  }
  assert.ok(signature, 'Unsigned Mach-O');
  assert.equal(signature.readUInt32BE(0), 0xfade0cc0, 'Invalid signature SuperBlob');
  const blobs = new Map();
  for (let i = 0; i < signature.readUInt32BE(8); i++) {
    const kind = signature.readUInt32BE(12 + i * 8), start = signature.readUInt32BE(16 + i * 8);
    blobs.set(kind, signature.subarray(start, start + signature.readUInt32BE(start + 4)));
  }
  const directory = blobs.get(0); assert.ok(directory, 'No CodeDirectory');
  assert.equal(directory.readUInt32BE(0), 0xfade0c02);
  assert.ok(directory.readUInt32BE(12) & 2, 'Expected ad-hoc signature');
  assert.equal(directory[37], 2, 'Expected SHA-256 code signature');
  assert.equal(directory[36], 32, 'Expected SHA-256 slot length');
  const hashOffset = directory.readUInt32BE(16), special = directory.readUInt32BE(24), codeSlots = directory.readUInt32BE(28);
  const limit = directory.readUInt32BE(32), pageSize = 2 ** directory[39];
  assert.equal(codeSlots, Math.ceil(limit / pageSize), 'Wrong code slot count');
  for (let i = 0; i < codeSlots; i++) assert.deepEqual(directory.subarray(hashOffset + i * 32, hashOffset + (i + 1) * 32), digest(bytes.subarray(i * pageSize, Math.min(limit, (i + 1) * pageSize)), 'sha256'), `Code page ${i} mismatch`);
  const checkSpecial = (slot, data) => {
    assert.ok(special >= slot, `Missing special slot ${slot}`);
    assert.deepEqual(directory.subarray(hashOffset - slot * 32, hashOffset - (slot - 1) * 32), digest(data, 'sha256'), `Special slot ${slot} mismatch`);
  };
  for (const [kind, data] of blobs) if (kind > 0 && kind < 0x1000 && kind <= special) checkSpecial(kind, data);
  return { directory, blobs, checkSpecial, cdhash: digest(directory, 'sha256').subarray(0, 20), special };
}

export async function verifyMacArchive(filename, options = {}) {
  const archive = await fs.readFile(filename), entries = readZip(archive);
  const manifest = JSON.parse(await fs.readFile(`${filename}.json`, 'utf8'));
  const arch = manifest.architecture, cpu = arch === 'arm64' ? 0x0100000c : 0x01000007;
  assert.ok(['arm64', 'x64'].includes(arch));
  assert.equal(manifest.zipSha256, sha256(archive));
  assert.equal(manifest.signing.type, 'ad-hoc'); assert.equal(manifest.signing.notarized, false);
  const prefix = `${PRODUCT}.app/`;
  assert.ok(entries.has('macOS使用说明.txt'));
  assert.ok([...entries.keys()].every(name => name.startsWith(prefix) || name === 'macOS使用说明.txt'), 'Unexpected top-level artifact');
  function resolve(name, depth = 0) {
    assert.ok(depth < 20, 'Symlink cycle');
    const components = name.split('/');
    for (let i = 1; i <= components.length; i++) {
      const part = components.slice(0, i).join('/'), link = entries.get(part);
      if (link && isLink(link)) {
        const target = link.data().toString('utf8');
        assert.ok(!target.startsWith('/') && !target.includes('\\') && !target.includes(':'), 'Non-POSIX link');
        const result = path.posix.normalize(path.posix.join(path.posix.dirname(part), target, ...components.slice(i)));
        assert.ok(result.startsWith(prefix), 'Symlink escapes application');
        return resolve(result, depth + 1);
      }
    }
    return name;
  }
  const get = name => { const key = resolve(name), entry = entries.get(key); assert.ok(entry, `Missing archive entry: ${key}`); return entry.data(); };
  const info = plist.parse(get(`${prefix}Contents/Info.plist`).toString());
  assert.equal(info.CFBundleName, PRODUCT); assert.equal(info.CFBundleDisplayName, PRODUCT);
  assert.equal(info.CFBundleIdentifier, BUNDLE_ID); assert.equal(info.CFBundleVersion, manifest.version);
  assert.equal(info.LSMinimumSystemVersion, '13.0'); assert.notEqual(info.LSUIElement, true);
  assert.equal(info.CFBundleExecutable, 'Electron'); assert.equal(info.CFBundleIconFile, 'app.icns');
  const signatures = new Map();
  let linkCount = 0, machoCount = 0;
  for (const [name, entry] of entries) {
    assert.ok(entry.mode, `Missing UNIX mode: ${name}`);
    if (isLink(entry)) {
      linkCount++;
      const target = resolve(name);
      assert.ok(entries.has(target) || [...entries.keys()].some(key => key.startsWith(`${target}/`)), `Dangling symlink: ${name}`);
      continue;
    }
    const data = entry.data(), signature = machoSignature(data, cpu);
    if (signature) { assert.ok(entry.mode & 0o111, `Executable mode missing: ${name}`); signatures.set(name, signature); machoCount++; }
  }
  assert.equal(linkCount, 14); assert.equal(linkCount, manifest.preservedSymlinks);
  assert.ok(machoCount >= 12, 'Missing runtime executables');
  // Bind canonical executable paths to their Info.plist and CodeResources slots.
  const bundles = new Map();
  for (const name of entries.keys()) {
    if (!name.endsWith('/Info.plist')) continue;
    const relative = name.slice(0, -'Info.plist'.length);
    const data = get(name), metadata = plist.parse(data.toString());
    if (!metadata.CFBundleExecutable) continue;
    let base, executable;
    if (relative.endsWith('/Contents/')) { base = relative.slice(0, -1); executable = `${base}/MacOS/${metadata.CFBundleExecutable}`; }
    else if (relative.endsWith('/Resources/') && relative.includes('.framework/Versions/A/')) { base = relative.slice(0, -'/Resources/'.length); executable = `${base}/${metadata.CFBundleExecutable}`; }
    else continue;
    const signature = signatures.get(resolve(executable)); assert.ok(signature, `Missing bundle code: ${executable}`);
    signature.checkSpecial(1, data);
    const resourcePath = `${base}/_CodeSignature/CodeResources`, resourcesBytes = get(resourcePath);
    signature.checkSpecial(3, resourcesBytes);
    bundles.set(base, { executable, signature, resources: plist.parse(resourcesBytes.toString()) });
    if (relative.endsWith('/Contents/')) {
      const entitlement = signature.blobs.get(5); assert.ok(entitlement, `JIT entitlement missing: ${name}`);
      assert.equal(plist.parse(entitlement.subarray(8).toString())['com.apple.security.cs.allow-jit'], true);
    }
  }
  assert.equal(bundles.size, 9, 'Expected app, four helpers, four frameworks');
  let resourceCount = 0, nestedCount = 0;
  for (const [base, { resources }] of bundles) {
    for (const [name, seal] of Object.entries(resources.files2 || {})) {
      const full = `${base}/${name}`;
      if (seal.cdhash) {
        let nestedBase = `${full}/Contents`;
        if (name.endsWith('.framework')) nestedBase = `${full}/Versions/A`;
        const nested = bundles.get(nestedBase);
        if (nested) assert.deepEqual(seal.cdhash, nested.signature.cdhash, `Nested cdhash mismatch: ${full}`);
        else { const signature = signatures.get(resolve(full)); assert.ok(signature, `Missing nested signature: ${full}`); assert.deepEqual(seal.cdhash, signature.cdhash); }
        assert.equal(seal.requirement, `cdhash H"${seal.cdhash.toString('hex')}"`);
        nestedCount++;
      } else if (seal.symlink) { assert.ok(isLink(entries.get(full))); assert.equal(entries.get(full).data().toString(), seal.symlink); }
      else {
        assert.ok(seal.hash2, `Unrecognized resource seal: ${full}`);
        assert.deepEqual(digest(get(full), 'sha256'), seal.hash2, `Resource hash mismatch: ${full}`); resourceCount++;
      }
    }
    for (const [name, seal] of Object.entries(resources.files || {})) assert.deepEqual(digest(get(`${base}/${name}`), 'sha1'), Buffer.isBuffer(seal) ? seal : seal.hash);
  }
  const application = get(`${prefix}Contents/Resources/app.asar`);
  assert.equal(sha256(application), manifest.appAsarSha256);
  const inspect = path.join(ROOT, 'build/macos-toolchain', `verify-${arch}.asar`); await fs.writeFile(inspect, application);
  const files = asar.listPackage(inspect).map(name => name.replaceAll('\\', '/').replace(/^\/+/, ''));
  const allowedJson = new Set(['package.json', 'src/medication-catalog.json', 'src/reference-presets.json', 'assets/vendor/SHA256.json', 'assets/sharks/catalog.json']);
  const forbidden = /(?:^|\/)(?:tests?|screenshots|raw|node_modules|dist|build|scripts|\.git|\.vscode|userdata|backups?)(?:\/|$)|(?:^|\/)state(?:[.-][^/]*)?\.json$|\.(?:sqlite3?|db|csv|xlsx?|log|bak|tmp)$/i;
  for (const name of files) {
    const entry = asar.statFile(inspect, path.normalize(name), false);
    assert.ok(!entry.link, `Unexpected ASAR link: ${name}`);
    assert.ok(!forbidden.test(name), `Private/development file in ASAR: ${name}`);
    if (entry.files) continue;
    assert.match(name, /^(?:electron|src|assets)\/|^(?:index\.html|pet\.html|package\.json)$/, `Unexpected app source path: ${name}`);
    if (name.endsWith('.json')) assert.ok(allowedJson.has(name), `Unexpected data JSON: ${name}`);
    assert.deepEqual(asar.extractFile(inspect, path.normalize(name)), await fs.readFile(path.join(ROOT, name)), `Stale source: ${name}`);
  }
  for (const name of ['electron/main.cjs', 'electron/preload.cjs', 'electron/platform.cjs', 'electron/pet-window.cjs', 'electron/pet-growth-desktop.cjs', 'src/app.js', 'src/star-feeding.js', 'src/pet-input.js']) assert.ok(files.includes(name), `Missing source: ${name}`);
  if (options.runtime) {
    const official = readZip(await fs.readFile(options.runtime));
    for (const [name, entry] of official) if (isLink(entry)) {
      const actual = entries.get(name.replace(/^Electron\.app\//, prefix));
      assert.ok(actual); assert.equal(actual.mode, entry.mode); assert.deepEqual(actual.data(), entry.data());
    }
  }
  return { architecture: arch, groups: 5, machoSignatures: machoCount, sealedBundles: bundles.size, sealedResources: resourceCount, nestedCodeSeals: nestedCount, posixSymlinks: linkCount, appAsarSha256: manifest.appAsarSha256, macOSNativeTest: false };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('Usage: node scripts/verify-macos.mjs <application.zip>');
  console.log(JSON.stringify(await verifyMacArchive(path.resolve(process.argv[2])), null, 2));
}
