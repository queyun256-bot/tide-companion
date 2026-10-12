// Inspect a Windows installer without installing it or accessing user health data.
// Optional --onboarding runs the isolated first-run suite against its actual ASAR.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const asar = createRequire(require.resolve('@electron/packager'))('@electron/asar');
const { NtExecutable, NtExecutableResource, Resource } = createRequire(require.resolve('@electron/packager'))('resedit');
const execute = promisify(execFile);
const normalize = name => name.replaceAll('\\', '/').replace(/^\/+/, '');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const argumentsList = process.argv.slice(2);
assert.ok(argumentsList.every(arg => !arg.startsWith('--') || arg === '--onboarding'), 'Unknown option');
const paths = argumentsList.filter(arg => !arg.startsWith('--'));
assert.ok(paths.length <= 1, 'Usage: node tests/installer-smoke.mjs [installer.exe] [--onboarding]');
const installer = paths.length ? path.resolve(paths[0]) : path.join(root, 'dist', 'installers', `潮汐-Setup-${pkg.version}-x64.exe`);
const stage = path.join(root, 'dist', 'installer-stage', 'Tide-Companion-win32-x64');
const checks = [];

async function findSevenZip() {
  if (process.env.TIDE_7ZIP) {
    const explicit = path.resolve(process.env.TIDE_7ZIP);
    assert.ok((await stat(explicit)).isFile(), 'TIDE_7ZIP must point to a 7za executable');
    return explicit;
  }
  assert.ok(process.env.LOCALAPPDATA, 'Set TIDE_7ZIP when LOCALAPPDATA is unavailable');
  const cache = path.join(process.env.LOCALAPPDATA, 'electron-builder', 'Cache', '7zip@1.0.0');
  let entries;
  try { entries = await readdir(cache, { withFileTypes: true }); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    throw new Error('Cached 7-Zip was not found; build the installer first or set TIDE_7ZIP');
  }
  for (const entry of entries.filter(item => item.isDirectory() && item.name.startsWith('7zip-win-x64-')).sort((a, b) => a.name.localeCompare(b.name))) {
    const candidate = path.join(cache, entry.name, 'bin', '7za.exe');
    try { if ((await stat(candidate)).isFile()) return candidate; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  throw new Error('Cached 7-Zip executable was not found; build the installer first or set TIDE_7ZIP');
}

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function filesIn(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    assert.ok(!entry.isSymbolicLink(), `Unexpected symbolic link: ${prefix}${entry.name}`);
    const relative = `${prefix}${entry.name}`;
    if (entry.isDirectory()) files.push(...await filesIn(path.join(directory, entry.name), `${relative}/`));
    else {
      assert.ok(entry.isFile(), `Unexpected non-file payload entry: ${relative}`);
      files.push(relative);
    }
  }
  return files.sort();
}

function safeArchivePath(entry) {
  assert.ok(entry && !path.win32.isAbsolute(entry) && !path.posix.isAbsolute(entry), 'Archive contains an absolute path');
  assert.ok(!entry.includes(':') && !entry.includes('\0') && !entry.split(/[\\/]/).includes('..'), 'Archive contains an unsafe path');
}

async function run() {
  assert.equal(process.platform, 'win32', 'This verifier uses the cached Windows 7-Zip tool');
  const sevenZip = await findSevenZip();
  await Promise.all([stat(installer), stat(sevenZip), stat(path.join(stage, 'resources', 'app.asar'))]);
  const installerHash = await sha256(installer);
  const recordedHash = (await readFile(`${installer}.sha256`, 'utf8')).trim().split(/\s+/)[0];
  assert.equal(installerHash, recordedHash, 'Installer checksum sidecar is stale');
  checks.push('installer SHA-256 matches its sidecar');

  // 7-Zip reads the embedded payload without executing the NSIS installer.
  const { stdout: listing } = await execute(sevenZip, ['l', '-slt', '-sccUTF-8', installer], { windowsHide: true, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 60000 });
  const listingStart = listing.indexOf('----------');
  assert.ok(listingStart >= 0, '7-Zip did not expose an embedded payload listing');
  const archiveEntries = [...listing.slice(listingStart).matchAll(/^Path = (.+)$/gm)].map(match => match[1].trim());
  assert.ok(archiveEntries.length > 0, 'Installer payload is empty');
  archiveEntries.forEach(safeArchivePath);
  const payloadPath = await mkdtemp(path.join(tmpdir(), `tide-installer-${pkg.version}-`));
  await execute(sevenZip, ['x', installer, `-o${payloadPath}`, '-y', '-bd', '-bb0', '-bso0', '-bsp0'], { windowsHide: true, maxBuffer: 4 * 1024 * 1024, timeout: 180000 });
  const [payloadFiles, stageFiles] = await Promise.all([filesIn(payloadPath), filesIn(stage)]);
  assert.deepEqual(payloadFiles, stageFiles, 'Installer file set differs from the prepared release');
  const manifestHash = createHash('sha256');
  for (const relative of payloadFiles) {
    const [installedHash, stagedHash] = await Promise.all([sha256(path.join(payloadPath, relative)), sha256(path.join(stage, relative))]);
    assert.equal(installedHash, stagedHash, `Installer changed a staged file: ${relative}`);
    manifestHash.update(`${relative}\0${installedHash}\n`);
  }
  checks.push('every extracted payload file matches the staged release');

  for(const binary of [installer,path.join(payloadPath,'Tide-Companion.exe')]){
    const pe=NtExecutable.from(await readFile(binary));
    const versions=Resource.VersionInfo.fromEntries(NtExecutableResource.from(pe).entries);
    assert.ok(versions.length>0,'Windows product metadata is missing');
    for(const version of versions)for(const language of version.getAllLanguagesForStringValues()){
      const info=version.getStringValues(language);
      assert.equal(info.ProductName,'潮汐','Windows product name is stale');
      assert.ok(!info.CompanyName,'Windows company information must be empty');
    }
  }
  const icon=await readFile(path.join(root,'assets/app.ico'));
  const iconName=`tide-app-${createHash('sha256').update(icon).digest('hex').slice(0,12)}.ico`;
  assert.deepEqual(await readFile(path.join(payloadPath,'resources',iconName)),icon);
  checks.push('application and installer are named 潮汐, company fields are empty, external taskbar icon matches');

  const archive = path.join(payloadPath, 'resources', 'app.asar');
  const archiveFiles = [];
  const allowedRootFiles = new Set(['LICENSE', 'README.md', 'index.html', 'pet.html', 'package.json']);
  const allowedJson = new Set(['package.json', 'src/medication-catalog.json', 'src/reference-presets.json', 'assets/vendor/SHA256.json', 'assets/sharks/catalog.json']);
  const devOrPrivatePath = /(?:^|\/)(?:tests?|screenshots|raw|node_modules|dist|build|scripts|\.git|\.vscode|userdata|backups?)(?:\/|$)|(?:^|\/)state(?:[.-][^/]*)?\.json$|\.(?:sqlite3?|db|csv|xlsx?|log|bak|tmp)$/i;
  for (const rawPath of asar.listPackage(archive)) {
    const relative = normalize(rawPath);
    safeArchivePath(relative);
    assert.ok(!devOrPrivatePath.test(relative), `Development or private data path in ASAR: ${relative}`);
    const entry = asar.statFile(archive, path.normalize(relative), false);
    assert.ok(!entry.link, `Unexpected ASAR link: ${relative}`);
    if (entry.files) continue;
    assert.ok(allowedRootFiles.has(relative) || /^(?:assets|electron|src)\//.test(relative), `Non-release file in ASAR: ${relative}`);
    if (relative.endsWith('.json')) assert.ok(allowedJson.has(relative), `Unexpected data JSON in ASAR: ${relative}`);
    await stat(path.join(root, relative));
    archiveFiles.push(relative);
  }
  assert.ok(!archiveFiles.includes('assets/vendor/live2dcubismcore.min.js'), 'Public installer must not include proprietary Live2D Core');
  const bundledPackage = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'));
  assert.equal(bundledPackage.version, pkg.version, 'Installer bundles a different app version');
  assert.equal(bundledPackage.main, pkg.main, 'Installer entry point differs from the current project');
  checks.push('ASAR contains release files without saved state, exports, tests, or screenshots');

  const criticalFiles = [
    'LICENSE',
    'index.html', 'pet.html', 'src/app.js', 'src/app.css', 'src/medication-icons.js', 'src/medication-icons.css',
    'src/administration-picker.js', 'src/administration-picker.css',
    'src/journal.js', 'src/calendar.js', 'src/calendar.css', 'electron/daily-moods.cjs',
    'src/date-picker.js', 'src/date-picker.css', 'src/gaht-reference.js', 'src/gaht-reference.css',
    'src/shark-variants.js', 'src/shark-personalities.js', 'src/skin-gallery.js', 'src/skin-gallery.css', 'assets/sharks/catalog.json',
    'assets/sharks/rose.svg', 'assets/sharks/mint.svg', 'assets/sharks/peach.svg', 'assets/sharks/lilac.svg',
    'src/chart.js', 'src/pet-drag.js', 'src/pet-input.js', 'src/skin-features.js', 'src/pet-visual.js', 'src/pet-preview.js', 'src/pet-preview.css',
    'src/pet.css', 'src/live2d.js', 'electron/skins.cjs', 'electron/pet-desktop.cjs', 'electron/pet-window.cjs',
    'src/star-effects.js', 'src/star-effects.css', 'src/star-wallet-ui.js', 'src/star-wallet-ui.css',
    'electron/star-wallet.cjs', 'electron/pet-growth.cjs', 'electron/pet-growth-desktop.cjs', 'src/reminders.js',
    'src/star-feeding.js', 'src/star-feeding.css', 'src/pet-star-animation.js',
    'src/pet.js', 'src/pet-behavior.js', 'electron/main.cjs', 'electron/preload.cjs', 'electron/state.cjs', 'electron/platform.cjs',
  ];
  for (const relative of criticalFiles) {
    assert.ok(archiveFiles.includes(relative), `Missing current app file: ${relative}`);
    assert.deepEqual(asar.extractFile(archive, path.normalize(relative)), await readFile(path.join(root, relative)), `Installer source is stale: ${relative}`);
  }
  checks.push('critical UI, icons, pet, onboarding, and desktop code match the workspace');

  let onboarding = 'not requested';
  if (argumentsList.includes('--onboarding')) {
    const env = { ...process.env, TIDE_TEST_APP_ROOT: archive };
    delete env.ELECTRON_RUN_AS_NODE;
    const { stdout } = await execute(process.execPath, [path.join(root, 'tests', 'onboarding-smoke.mjs')], { cwd: root, env, windowsHide: true, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 180000 });
    const result = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
    assert.equal(result.ok, true, 'Packaged onboarding suite did not report success');
    onboarding = { ok: true, checks: result.checks?.length ?? 0 };
    checks.push('real installer ASAR passes isolated first-run and restart interactions');
  }
  console.log(JSON.stringify({ ok: true, version: pkg.version, fileCount: payloadFiles.length, asarFileCount: archiveFiles.length,
    sha256: installerHash, payloadManifestSha256: manifestHash.digest('hex'), payloadPath, appAsarPath: archive, checks, onboarding }));
}

await run();
