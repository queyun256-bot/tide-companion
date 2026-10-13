// Cross-platform macOS packaging. Never extract POSIX links onto Windows.
// Framework versions are independently signable bundles (apple-bundles' layout).
// After signing canonical Versions/A, root aliases exist only during shallow
// signing; the output archive restores the upstream relative symlinks verbatim.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { inflateRawSync, deflateRawSync, crc32 } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { verifyMacArchive } from './verify-macos.mjs';
const require = createRequire(import.meta.url);
const packagerRequire = createRequire(require.resolve('@electron/packager'));
const plist = packagerRequire('plist');
const asar = packagerRequire('@electron/asar');
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PRODUCT = '潮汐';
export const BUNDLE_ID = 'org.transpet.desktop';
export const MAC_SOURCE_FILES = ['electron', 'src', 'assets', 'index.html', 'pet.html', 'package.json', 'LICENSE'];
const CACHE = path.join(ROOT, 'build/macos-toolchain');
const hash = (buffer, algorithm = 'sha256') => createHash(algorithm).update(buffer).digest();
export const sha256 = buffer => hash(buffer).toString('hex');

export function readZip(buffer) {
  if (buffer.length < 22) throw new Error('ZIP end record missing');
  let end = buffer.length - 22;
  while (end >= Math.max(0, buffer.length - 65557) && buffer.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0 || buffer.readUInt32LE(end) !== 0x06054b50) throw new Error('ZIP end record missing');
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('Invalid ZIP directory');
    const size = buffer.readUInt32LE(offset + 20), rawSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28), extra = buffer.readUInt16LE(offset + 30), comment = buffer.readUInt16LE(offset + 32);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    if (name.startsWith('/') || name.includes('\\') || name.split('/').includes('..') || entries.has(name)) throw new Error('Unsafe/duplicate ZIP path');
    const local = buffer.readUInt32LE(offset + 42), method = buffer.readUInt16LE(offset + 10);
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const compressed = buffer.subarray(start, start + size);
    const checksum = buffer.readUInt32LE(offset + 16);
    const mode = buffer.readUInt32LE(offset + 38) >>> 16;
    if (![0, 8].includes(method)) throw new Error(`Unsupported ZIP compression ${method}`);
    entries.set(name, { name, mode, method, compressed, rawSize, checksum,
      data() { const result = method === 0 ? compressed : inflateRawSync(compressed); if (result.length !== rawSize || crc32(result) !== checksum) throw new Error(`ZIP CRC mismatch: ${name}`); return result; } });
    offset += 46 + nameLength + extra + comment;
  }
  return entries;
}

export async function writeZip(filename, entries) {
  const handle = await fs.open(filename, 'w');
  let offset = 0;
  const directory = [];
  try {
    for (const [name, entry] of [...entries].sort(([a], [b]) => a.localeCompare(b, 'en'))) {
      const encoded = Buffer.from(name);
      let compressed, method, rawSize, checksum;
      if (entry.compressed) ({ compressed, method, rawSize, checksum } = entry);
      else { const bytes = await entry.data(); compressed = deflateRawSync(bytes, { level: 6 }); method = 8; rawSize = bytes.length; checksum = crc32(bytes); }
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(method, 8); local.writeUInt16LE(33, 12);
      local.writeUInt32LE(checksum, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(rawSize, 22); local.writeUInt16LE(encoded.length, 26);
      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x0314, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8); central.writeUInt16LE(method, 10); central.writeUInt16LE(33, 14);
      central.writeUInt32LE(checksum, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(rawSize, 24); central.writeUInt16LE(encoded.length, 28);
      central.writeUInt32LE(((entry.mode || 0o100644) << 16) >>> 0, 38); central.writeUInt32LE(offset, 42);
      await handle.write(local); await handle.write(encoded); await handle.write(compressed);
      offset += local.length + encoded.length + compressed.length;
      directory.push(central, encoded);
    }
    const start = offset;
    for (const buffer of directory) { await handle.write(buffer); offset += buffer.length; }
    const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.size, 8); end.writeUInt16LE(entries.size, 10); end.writeUInt32LE(offset - start, 12); end.writeUInt32LE(start, 16);
    await handle.write(end);
  } finally { await handle.close(); }
}

async function fetchJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Download HTTP ${response.status}: ${url}`);
  return response.json();
}
async function downloadAsset(asset, target) {
  // Official GitHub API redirect; ranged transfers avoid restarting large assets.
  const response = await fetch(asset.url, { headers: { Accept: 'application/octet-stream' }, redirect: 'manual', signal: AbortSignal.timeout(30000) });
  const url = response.headers.get('location');
  if (!url || !new URL(url).hostname.endsWith('githubusercontent.com')) throw new Error('Unexpected GitHub asset redirect');
  const partial = `${target}.partial`, handle = await fs.open(partial, 'w');
  let next = 0;
  try {
    await handle.truncate(asset.size);
    await Promise.all(Array.from({ length: 12 }, async () => {
      while (next < asset.size) {
        const start = next, end = Math.min(asset.size - 1, start + 1048576 - 1); next = end + 1;
        for (let attempt = 0; ; attempt++) {
          try {
            const part = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, signal: AbortSignal.timeout(120000) });
            if (part.status !== 206 || part.headers.get('content-range') !== `bytes ${start}-${end}/${asset.size}`) throw new Error('Unexpected range response');
            const bytes = Buffer.from(await part.arrayBuffer());
            if (bytes.length !== end - start + 1) throw new Error('Truncated download');
            await handle.write(bytes, 0, bytes.length, start); break;
          } catch (error) { if (attempt === 3) throw error; }
        }
      }
    }));
  } finally { await handle.close(); }
  await fs.rename(partial, target);
}
async function cachedAsset(release, name, expected, cacheName = name) {
  const filename = path.join(CACHE, cacheName);
  let bytes = await fs.readFile(filename).catch(() => null);
  if (bytes && (!expected || sha256(bytes) === expected)) return bytes;
  const asset = release.assets.find(item => item.name === name);
  if (!asset) throw new Error(`Official release missing ${name}`);
  console.log(`Downloading ${name}`);
  await downloadAsset(asset, filename);
  bytes = await fs.readFile(filename);
  if (expected && sha256(bytes) !== expected) throw new Error(`SHA-256 mismatch: ${name}`);
  return bytes;
}

async function walk(directory, relative = '') {
  const result = [];
  for (const item of await fs.readdir(path.join(directory, relative), { withFileTypes: true })) {
    const name = path.posix.join(relative, item.name);
    if (item.isSymbolicLink()) throw new Error(`Unexpected filesystem symlink: ${name}`);
    if (item.isDirectory()) result.push(...await walk(directory, name)); else result.push(name);
  }
  return result;
}
async function resetBuildDirectory(directory) {
  const allowed = path.join(ROOT, 'build') + path.sep;
  if (!path.resolve(directory).startsWith(allowed)) throw new Error('Refusing to clear outside build workspace');
  await fs.rm(directory, { recursive: true, force: true }); await fs.mkdir(directory, { recursive: true });
}
export async function stageMacSource(sourceRoot, stage) {
  for (const name of MAC_SOURCE_FILES) await fs.cp(path.join(sourceRoot, name), path.join(stage, name), {
    recursive: true,
    // Keep the developer's separately obtained Core in place, outside releases.
    filter: source => path.relative(sourceRoot, source).replaceAll('\\', '/').toLowerCase() !== 'assets/vendor/live2dcubismcore.min.js',
  });
}
export async function createMacAsar() {
  const stage = path.join(ROOT, 'build/macos-source');
  await resetBuildDirectory(stage);
  await stageMacSource(ROOT, stage);
  const destination = path.join(CACHE, 'app.asar');
  await asar.createPackage(stage, destination);
  return destination;
}
export function makeIcns(png) {
  if (png.readUInt32BE(16) !== 256 || png.readUInt32BE(20) !== 256) throw new Error('Expected 256px application PNG');
  const buffer = Buffer.alloc(16 + png.length);
  buffer.write('icns'); buffer.writeUInt32BE(buffer.length, 4); buffer.write('ic08', 8); buffer.writeUInt32BE(png.length + 8, 12); png.copy(buffer, 16);
  return buffer;
}

async function prepareSigner() {
  if (process.platform !== 'win32') throw new Error('This reproducible cross-packager currently requires the verified Windows rcodesign toolchain');
  const version = '0.29.0', name = `apple-codesign-${version}-x86_64-pc-windows-msvc.zip`;
  const release = await fetchJson(`https://api.github.com/repos/indygreg/apple-platform-rs/releases/tags/apple-codesign%2F${version}`);
  const expected = (await cachedAsset(release, `${name}.sha256`)).toString().trim().split(/\s/)[0];
  if (!/^[a-f0-9]{64}$/.test(expected)) throw new Error('Invalid upstream rcodesign SHA-256');
  const archive = await cachedAsset(release, name, expected);
  const executable = [...readZip(archive)].find(([entry]) => entry.endsWith('/rcodesign.exe'))?.[1];
  if (!executable) throw new Error('rcodesign executable not found');
  const exe = path.join(CACHE, `rcodesign-${version}.exe`); await fs.writeFile(exe, executable.data());
  return { exe, version, sha256: expected };
}
function signerCommand(signer, args, cwd, log) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('RCODESIGN_')));
  const result = spawnSync(signer.exe, ['-C', '/dev/null', ...args], { cwd, env, encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  log.push(result.stdout || '', result.stderr || '');
  if (result.error || result.status !== 0) throw new Error(`rcodesign ${args[0]} failed: ${result.error || result.stderr}`);
}

export async function packageMac(arch, runtime, signer, pkg, appAsar) {
  const stage = path.join(ROOT, `build/macos-${arch}`);
  await resetBuildDirectory(stage);
  const app = path.join(stage, `${PRODUCT}.app`), links = new Map(), originalModes = new Map();
  const prefix = 'Electron.app/';
  for (const [name, entry] of runtime) {
    if (!name.startsWith(prefix) || name.endsWith('/')) continue;
    const relative = name.slice(prefix.length);
    originalModes.set(relative, entry.mode);
    if ((entry.mode & 0o170000) === 0o120000) { links.set(relative, entry); continue; }
    const destination = path.join(app, relative); await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.writeFile(destination, entry.data());
  }
  const infoPath = path.join(app, 'Contents/Info.plist');
  const info = plist.parse(await fs.readFile(infoPath, 'utf8'));
  Object.assign(info, { CFBundleDisplayName: PRODUCT, CFBundleName: PRODUCT, CFBundleIdentifier: BUNDLE_ID, CFBundleExecutable: 'Electron', CFBundleIconFile: 'app.icns', CFBundleShortVersionString: pkg.version, CFBundleVersion: pkg.version, LSMinimumSystemVersion: '13.0', LSApplicationCategoryType: 'public.app-category.lifestyle', NSHumanReadableCopyright: PRODUCT });
  delete info.ElectronAsarIntegrity; delete info.LSUIElement;
  for (const key of Object.keys(info)) if (/UsageDescription$/.test(key)) delete info[key];
  await fs.writeFile(infoPath, plist.build(info));
  await fs.rm(path.join(app, 'Contents/Resources/default_app.asar'), { force: true });
  await fs.rm(path.join(app, 'Contents/Resources/electron.icns'), { force: true });
  await fs.copyFile(appAsar, path.join(app, 'Contents/Resources/app.asar'));
  await fs.copyFile(path.join(ROOT, 'assets/app.icns'), path.join(app, 'Contents/Resources/app.icns'));
  await fs.copyFile(path.join(ROOT, 'docs/macOS.md'), path.join(app, 'Contents/Resources/macOS.md'));
  // Keep Electron's helper filenames: the runtime resolves these before the
  // display-name fallback. Fill the executable field required by bundle sealing.
  const helperRoots = (await walk(app)).filter(name => /\.app\/Contents\/Info\.plist$/.test(name)).map(name => name.slice(0, -'/Contents/Info.plist'.length));
  for (const helper of helperRoots) {
    const filename = path.join(app, helper, 'Contents/Info.plist');
    const helperInfo = plist.parse(await fs.readFile(filename, 'utf8'));
    const executable = path.posix.basename(helper, '.app');
    Object.assign(helperInfo, { CFBundleExecutable: executable, CFBundleVersion: pkg.version, CFBundleShortVersionString: pkg.version });
    await fs.writeFile(filename, plist.build(helperInfo));
  }
  const frameworks = [...links.keys()].filter(name => name.endsWith('/Versions/Current')).map(name => name.slice(0, -'/Versions/Current'.length));
  const log = [];
  await fs.copyFile(path.join(ROOT, 'assets/mac-entitlements.plist'), path.join(stage, 'entitlements.plist'));
  // Version roots contain no links in the pinned upstream distribution. rcodesign
  // recognizes Resources/Info.plist as a framework even without a .framework suffix.
  for (const framework of frameworks) signerCommand(signer, ['sign', '--timestamp-url', 'none', path.join(app, framework, 'Versions/A')], stage, log);
  for (const helper of helperRoots) signerCommand(signer, ['sign', '--timestamp-url', 'none', '--entitlements-xml-file', 'entitlements.plist', path.join(app, helper)], stage, log);
  const temporary = [];
  for (const framework of frameworks) {
    const base = path.posix.basename(framework, '.framework');
    // These copies only let the shallow signer resolve the canonical executable
    // and bundle ID. They never become resources or entries in the final archive.
    const executableAlias = `${framework}/${base}`, infoAlias = `${framework}/Resources/Info.plist`;
    await fs.copyFile(path.join(app, framework, 'Versions/A', base), path.join(app, executableAlias));
    await fs.mkdir(path.dirname(path.join(app, infoAlias)), { recursive: true });
    await fs.copyFile(path.join(app, framework, 'Versions/A/Resources/Info.plist'), path.join(app, infoAlias));
    temporary.push(executableAlias, infoAlias);
  }
  signerCommand(signer, ['sign', '--timestamp-url', 'none', '--entitlements-xml-file', 'entitlements.plist', '--shallow', app], stage, log);
  const resources = plist.parse(await fs.readFile(path.join(app, 'Contents/_CodeSignature/CodeResources'), 'utf8'));
  for (const nested of [...frameworks, ...helperRoots]) {
    const relative = nested.replace(/^Contents\//, '');
    if (!Buffer.isBuffer(resources.files2?.[relative]?.cdhash)) throw new Error(`Nested code not sealed: ${relative}`);
    if (Object.keys(resources.files2).some(name => name.startsWith(`${relative}/`))) throw new Error(`Nested resources unexpectedly traversed: ${relative}`);
  }
  const zipEntries = new Map();
  for (const relative of await walk(app)) {
    if (temporary.includes(relative)) continue;
    const filename = path.join(app, relative);
    const first = await fs.open(filename, 'r'); const magic = Buffer.alloc(4); await first.read(magic, 0, 4, 0); await first.close();
    const macho = [0xfeedfacf, 0xfeedface, 0xcafebabe].includes(magic.readUInt32LE(0));
    zipEntries.set(`${PRODUCT}.app/${relative}`, { mode: originalModes.get(relative) || (macho ? 0o100755 : 0o100644), data: () => fs.readFile(filename) });
  }
  for (const [relative, entry] of links) zipEntries.set(`${PRODUCT}.app/${relative}`, entry);
  const readme = `${PRODUCT} ${pkg.version} · macOS ${arch === 'arm64' ? 'Apple 芯片' : 'Intel'}\n\n${await fs.readFile(path.join(ROOT, 'docs/macOS.md'), 'utf8')}`;
  zipEntries.set('macOS使用说明.txt', { mode: 0o100644, data: () => Buffer.from(readme) });
  const output = path.join(ROOT, 'dist/macos'); await fs.mkdir(output, { recursive: true });
  const destination = path.join(output, `${PRODUCT}-${pkg.version}-macOS-${arch}.zip`);
  await writeZip(destination, zipEntries);
  await fs.writeFile(path.join(stage, 'signing.log'), log.join('\n'));
  const digest = sha256(await fs.readFile(destination));
  await fs.writeFile(`${destination}.sha256`, `${digest}  ${path.basename(destination)}\n`);
  const manifest = { product: PRODUCT, version: pkg.version, architecture: arch, minimumMacOS: '13.0', bundleId: BUNDLE_ID, electronVersion: pkg.devDependencies.electron, appAsarSha256: sha256(await fs.readFile(appAsar)), signing: { type: 'ad-hoc', tool: `rcodesign ${signer.version}`, toolArchiveSha256: signer.sha256, developerId: false, notarized: false }, runtimeValidation: 'Not run on a physical Mac', zipSha256: digest, preservedSymlinks: links.size };
  await fs.writeFile(`${destination}.json`, JSON.stringify(manifest, null, 2) + '\n');
  console.log(destination);
  return destination;
}

export async function main() {
  const pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const selected = process.argv.find(arg => arg.startsWith('--arch='))?.split('=')[1];
  if (selected && !['arm64', 'x64'].includes(selected)) throw new Error('Use --arch=arm64 or --arch=x64');
  await fs.mkdir(CACHE, { recursive: true });
  await fs.writeFile(path.join(ROOT, 'assets/app.icns'), makeIcns(await fs.readFile(path.join(ROOT, 'assets/app.png'))));
  const appAsar = await createMacAsar(); console.log(`Application source: ${appAsar}`);
  const release = await fetchJson(`https://api.github.com/repos/electron/electron/releases/tags/v${pkg.devDependencies.electron}`);
  const sums = (await cachedAsset(release, 'SHASUMS256.txt', undefined, `electron-${pkg.devDependencies.electron}-SHASUMS256.txt`)).toString();
  const signer = await prepareSigner();
  for (const arch of selected ? [selected] : ['arm64', 'x64']) {
    const name = `electron-v${pkg.devDependencies.electron}-darwin-${arch}.zip`;
    const expected = sums.split(/\r?\n/).find(line => line.endsWith(` ${name}`) || line.endsWith(`*${name}`))?.slice(0, 64);
    if (!/^[a-f0-9]{64}$/.test(expected || '')) throw new Error(`Official checksum missing: ${name}`);
    const filename = await packageMac(arch, readZip(await cachedAsset(release, name, expected)), signer, pkg, appAsar);
    console.log(JSON.stringify(await verifyMacArchive(filename, { runtime: path.join(CACHE, name) })));
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
