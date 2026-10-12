'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const BUILTIN_SHARKS = Object.freeze(require('../assets/sharks/catalog.json').map(item => Object.freeze({ ...item, modelUrl: null, importedAt: null })));
const isBuiltinShark = id => BUILTIN_SHARKS.some(item => item.id === id);

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const LIMITS = Object.freeze({ files: 512, fileBytes: 64 * 1024 * 1024, totalBytes: 300 * 1024 * 1024, jsonBytes: 4 * 1024 * 1024, pixels: 64 * 1024 * 1024, skins: 30 });
const MIME = Object.freeze({ '.json': 'application/json', '.moc3': 'application/octet-stream', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' });
const JSON_SUFFIXES = ['.model3.json', '.physics3.json', '.pose3.json', '.exp3.json', '.motion3.json', '.userdata3.json', '.cdi3.json', '.displayinfo3.json'];
function reject(message) { throw new Error(`皮肤导入失败：${message}`); }
function plain(value) { return value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function validId(id) { if (typeof id !== 'string' || !UUID.test(id)) throw new Error('无效的皮肤 ID。'); return id; }
function relativeName(value) {
  if (typeof value !== 'string' || !value || value.length > 500 || /[\u0000-\u001f\u007f<>:"|?*#%]/.test(value) || /^[\\/]/.test(value)) reject('模型引用必须是普通相对文件路径。');
  const normalized = value.replaceAll('\\', '/');
  if (normalized.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) reject('模型引用包含目录穿越或不支持的文件名。');
  return normalized;
}
function inside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}
function assertNoLinks(target) {
  let current = path.resolve(target);
  while (true) {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) reject('不支持符号链接或目录联接。');
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
function assetPath(root, relative) {
  const target = path.resolve(root, ...relativeName(relative).split('/'));
  if (!inside(root, target)) reject('文件超出了所选模型目录。');
  assertNoLinks(target);
  const stat = fs.statSync(target);
  if (!stat.isFile()) reject('模型引用不是普通文件。');
  if (!inside(fs.realpathSync(root), fs.realpathSync(target))) reject('文件超出了所选模型目录。');
  return { target, stat };
}
function kindOf(name) {
  const lower = name.toLowerCase();
  if (JSON_SUFFIXES.some(suffix => lower.endsWith(suffix))) return 'json';
  const ext = path.extname(lower);
  if (ext === '.moc3') return 'moc';
  if (['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) return 'texture';
  reject('仅支持 Cubism 3/4/5 模型数据、JSON 与图片，不接收脚本、网页、声音或程序。');
}
function boundedJson(bytes, label) {
  if (bytes.length > LIMITS.jsonBytes) reject(`${label} JSON 文件过大。`);
  let value;
  try { value = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')); } catch { reject(`${label} 不是有效 JSON。`); }
  if (!plain(value)) reject(`${label} 顶层必须是 JSON 对象。`);
  let nodes = 0;
  function visit(item, depth) {
    if (++nodes > 200000 || depth > 40) reject(`${label} JSON 结构过于复杂。`);
    if (Array.isArray(item)) item.forEach(v => visit(v, depth + 1));
    else if (item && typeof item === 'object') {
      for (const [key, child] of Object.entries(item)) {
        if (['__proto__', 'prototype', 'constructor'].includes(key)) reject(`${label} 含不支持的对象属性。`);
        visit(child, depth + 1);
      }
    } else if (typeof item === 'number' && !Number.isFinite(item)) reject(`${label} 包含无效数值。`);
  }
  visit(value, 0);
  return value;
}
function imageDimensions(buffer, extension) {
  if (extension === '.png') {
    if (buffer.length < 33 || !buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || buffer.toString('ascii', 12, 16) !== 'IHDR') reject('PNG 纹理格式无效。');
    return [buffer.readUInt32BE(16), buffer.readUInt32BE(20)];
  }
  if (extension === '.jpg' || extension === '.jpeg') {
    if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) reject('JPEG 纹理格式无效。');
    let offset = 2;
    while (offset + 8 < buffer.length) {
      if (buffer[offset++] !== 0xff) reject('JPEG 纹理格式无效。');
      while (buffer[offset] === 0xff) offset++;
      const marker = buffer[offset++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
      if (offset + 2 > buffer.length) break;
      const length = buffer.readUInt16BE(offset);
      if (length < 2 || offset + length > buffer.length) break;
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker) && length >= 7) return [buffer.readUInt16BE(offset + 5), buffer.readUInt16BE(offset + 3)];
      offset += length;
    }
    reject('无法读取 JPEG 纹理尺寸。');
  }
  if (buffer.length < 30 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') reject('WebP 纹理格式无效。');
  const subtype = buffer.toString('ascii', 12, 16);
  if (subtype === 'VP8X') return [1 + buffer.readUIntLE(24, 3), 1 + buffer.readUIntLE(27, 3)];
  if (subtype === 'VP8L' && buffer[20] === 0x2f) {
    const bits = buffer.readUInt32LE(21);
    return [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1];
  }
  if (subtype === 'VP8 ' && buffer[23] === 0x9d && buffer[24] === 0x01 && buffer[25] === 0x2a) return [buffer.readUInt16LE(26) & 0x3fff, buffer.readUInt16LE(28) & 0x3fff];
  reject('不支持此 WebP 纹理格式。');
}
function checkContent(name, bytes) {
  const kind = kindOf(name);
  if (!bytes.length || bytes.length > LIMITS.fileBytes) reject('单个模型文件为空或超过 64 MB。');
  if (kind === 'moc' && (bytes.length < 8 || bytes.toString('ascii', 0, 4) !== 'MOC3')) reject('仅支持有效的 Cubism .moc3 模型。');
  if (kind === 'texture') {
    const [width, height] = imageDimensions(bytes, path.extname(name).toLowerCase());
    if (width < 1 || height < 1 || width > 16384 || height > 16384 || width * height > LIMITS.pixels) reject('纹理尺寸过大或无效。');
  }
  return kind === 'json' ? boundedJson(bytes, name) : null;
}
function modelUrl(id, relative) { return `tide-skin://${validId(id)}/${relativeName(relative).split('/').map(encodeURIComponent).join('/')}`; }

/** Copies only explicitly referenced model assets, never the selected parent tree. */
function collectModel(selected) {
  const modelFile = path.resolve(selected);
  assertNoLinks(modelFile);
  if (!modelFile.toLowerCase().endsWith('.model3.json')) reject('请选择以 .model3.json 结尾的模型文件。');
  const root = path.dirname(modelFile);
  const model = relativeName(path.basename(modelFile));
  const assets = new Map();
  const caseNames = new Map();
  let totalBytes = 0;
  function add(name, expected) {
    const relative = relativeName(name);
    const lower = relative.toLowerCase();
    if (caseNames.has(lower) && caseNames.get(lower) !== relative) reject('文件名仅大小写不同，无法安全导入。');
    caseNames.set(lower, relative);
    if (expected && !expected(relative.toLowerCase())) reject(`引用文件类型不匹配：${relative}`);
    if (assets.has(relative)) return assets.get(relative);
    if (assets.size >= LIMITS.files) reject('模型引用超过 512 个文件。');
    const { target, stat } = assetPath(root, relative);
    if (stat.size > LIMITS.fileBytes || stat.size <= 0) reject('模型文件为空或超过 64 MB。');
    if (totalBytes + stat.size > LIMITS.totalBytes) reject('模型引用文件总量超过 300 MB。');
    const bytes = fs.readFileSync(target);
    if (bytes.length !== stat.size) reject('源模型正在变更，请完成编辑后重试。');
    const json = checkContent(relative, bytes);
    const asset = { bytes, json };
    assets.set(relative, asset);
    totalBytes += bytes.length;
    return asset;
  }
  const top = add(model, name => name.endsWith('.model3.json'));
  const original = top.json;
  if (original.Version !== 3 || !plain(original.FileReferences)) reject('仅支持 Version 3 的 Cubism model3.json。');
  const refs = original.FileReferences;
  const keys = new Set(['Moc','Textures','Physics','Pose','Expressions','Motions','UserData','DisplayInfo']);
  if (Object.keys(refs).some(key => !keys.has(key))) reject('模型包含不支持的 FileReferences 类型。');
  const references = {};
  const copyReference = (value, suffix) => {
    const name = relativeName(value);
    add(name, typeof suffix === 'function' ? suffix : relative => relative.endsWith(suffix));
    return name;
  };
  references.Moc = copyReference(refs.Moc, '.moc3');
  if (!Array.isArray(refs.Textures) || !refs.Textures.length || refs.Textures.length > 64) reject('模型需要 1–64 张纹理。');
  references.Textures = refs.Textures.map(value => copyReference(value, name => ['.png','.jpg','.jpeg','.webp'].includes(path.extname(name))));
  for (const [key, suffix] of [['Physics','.physics3.json'],['Pose','.pose3.json'],['UserData','.userdata3.json'],['DisplayInfo', name => name.endsWith('.cdi3.json') || name.endsWith('.displayinfo3.json')]]) {
    if (refs[key] !== undefined && refs[key] !== '') references[key] = copyReference(refs[key], suffix);
  }
  if (refs.Expressions !== undefined) {
    if (!Array.isArray(refs.Expressions) || refs.Expressions.length > 200) reject('表情列表无效。');
    references.Expressions = refs.Expressions.map(item => {
      if (!plain(item) || typeof item.Name !== 'string' || item.Name.length > 200) reject('表情定义无效。');
      return { Name: item.Name, File: copyReference(item.File, '.exp3.json') };
    });
  }
  if (refs.Motions !== undefined) {
    if (!plain(refs.Motions) || Object.keys(refs.Motions).length > 100) reject('动作列表无效。');
    references.Motions = {};
    for (const [group, motions] of Object.entries(refs.Motions)) {
      if (group.length > 200 || !Array.isArray(motions) || motions.length > 200) reject('动作分组无效。');
      references.Motions[group] = motions.map(item => {
        if (!plain(item)) reject('动作定义无效。');
        const motion = { File: copyReference(item.File, '.motion3.json') };
        for (const property of ['FadeInTime','FadeOutTime']) {
          if (item[property] !== undefined) {
            if (typeof item[property] !== 'number' || !Number.isFinite(item[property]) || item[property] < -1 || item[property] > 3600) reject('动作淡入淡出时间无效。');
            motion[property] = item[property];
          }
        }
        // Sound is intentionally removed; imported skins never play local audio.
        return motion;
      });
    }
  }
  const sanitized = { Version: 3, FileReferences: references };
  for (const key of ['Groups','HitAreas','Layout']) if (original[key] !== undefined) sanitized[key] = original[key];
  top.bytes = Buffer.from(JSON.stringify(sanitized, null, 2));
  // Auxiliary Cubism data files cannot introduce another resource graph.
  for (const [name, item] of assets) {
    if (name !== model && item.json && Object.hasOwn(item.json, 'FileReferences')) reject('辅助 JSON 不能引用其他模型资源。');
  }
  return { model, assets, name: path.basename(model, '.model3.json').slice(0, 60) || '我的桌宠' };
}

function createSkinStore(userDirectory) {
  const root = path.resolve(userDirectory, 'skins');
  fs.mkdirSync(root, { recursive: true });
  assertNoLinks(root);
  const manifests = new Map();
  function location(id) {
    const directory = path.resolve(root, validId(id));
    if (!inside(root, directory)) throw new Error('无效的皮肤目录。');
    return directory;
  }
  function validateManifest(value, id) {
    if (!plain(value) || value.formatVersion !== 1 || value.id !== id || typeof value.name !== 'string' || !value.name || value.name.length > 60 || !Number.isFinite(Date.parse(value.importedAt))) reject('皮肤清单无效。');
    const model = relativeName(value.model);
    if (!model.toLowerCase().endsWith('.model3.json') || !Array.isArray(value.files) || !value.files.length || value.files.length > LIMITS.files) reject('皮肤文件清单无效。');
    const seen = new Set();
    let total = 0;
    const files = value.files.map(file => {
      if (!plain(file)) reject('皮肤文件清单无效。');
      const name = relativeName(file.path);
      kindOf(name);
      const mime = MIME[path.extname(name).toLowerCase()];
      if (seen.has(name.toLowerCase()) || file.mime !== mime || !Number.isInteger(file.size) || file.size < 1 || file.size > LIMITS.fileBytes || !/^[a-f0-9]{64}$/.test(file.sha256)) reject('皮肤文件清单无效。');
      seen.add(name.toLowerCase());
      total += file.size;
      return { path: name, mime, size: file.size, sha256: file.sha256 };
    });
    if (total > LIMITS.totalBytes || !files.some(file => file.path === model)) reject('皮肤文件清单无效。');
    return { formatVersion: 1, id, name: value.name, importedAt: new Date(value.importedAt).toISOString(), model, files };
  }
  function descriptor(manifest) { return { id: manifest.id, name: manifest.name, isBuiltin: false, modelUrl: modelUrl(manifest.id, manifest.model), importedAt: manifest.importedAt }; }
  function load() {
    manifests.clear();
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !UUID.test(entry.name)) continue;
      try {
        const { target, stat } = assetPath(location(entry.name), 'manifest.json');
        if (stat.size > 512000) continue;
        const manifest = validateManifest(JSON.parse(fs.readFileSync(target, 'utf8')), entry.name);
        for (const file of manifest.files) {
          const { stat: assetStat } = assetPath(location(entry.name), file.path);
          if (assetStat.size !== file.size) reject('皮肤文件大小已改变。');
        }
        manifests.set(entry.name, manifest);
      } catch { /* Keep invalid folders intact, but do not expose their contents. */ }
    }
  }
  load();
  function list() { return [...manifests.values()].map(descriptor).sort((a, b) => a.importedAt.localeCompare(b.importedAt)); }
  function has(id) { return isBuiltinShark(id) || manifests.has(id); }
  function removeDirectory(directory) {
    // Resolve and verify the exact target before any recursive deletion.
    const resolved = path.resolve(directory);
    if (!inside(root, resolved) || path.dirname(resolved) !== root || !/^(?:[a-f0-9-]{36}|\.import-[a-f0-9-]{36})$/.test(path.basename(resolved))) throw new Error('拒绝删除皮肤库以外的目录。');
    if (!fs.existsSync(resolved)) return;
    assertNoLinks(resolved);
    const real = fs.realpathSync(resolved);
    if (!inside(fs.realpathSync(root), real)) throw new Error('拒绝删除皮肤库以外的目录。');
    // fs.rm removes child links themselves, never recursively follows them.
    fs.rmSync(resolved, { recursive: true, force: true });
  }
  function importModel(selected) {
    if (manifests.size >= LIMITS.skins) reject('最多保存 30 个模型，请先移除不再使用的皮肤。');
    const model = collectModel(selected);
    const id = crypto.randomUUID();
    const staging = path.join(root, `.import-${id}`);
    const final = location(id);
    fs.mkdirSync(staging, { recursive: false });
    try {
      const files = [];
      for (const [name, asset] of model.assets) {
        const target = path.resolve(staging, ...name.split('/'));
        if (!inside(staging, target)) reject('资源路径无效。');
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, asset.bytes, { flag: 'wx', mode: 0o600 });
        files.push({ path: name, mime: MIME[path.extname(name).toLowerCase()], size: asset.bytes.length, sha256: crypto.createHash('sha256').update(asset.bytes).digest('hex') });
      }
      const manifest = validateManifest({ formatVersion: 1, id, name: model.name, importedAt: new Date().toISOString(), model: model.model, files }, id);
      fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600 });
      fs.renameSync(staging, final);
      manifests.set(id, manifest);
      return descriptor(manifest);
    } catch (error) {
      removeDirectory(staging);
      throw error;
    }
  }
  function remove(id) {
    if (isBuiltinShark(id)) throw new Error('内置桌宠不能删除。');
    validId(id);
    if (!manifests.has(id)) throw new Error('皮肤不存在。');
    removeDirectory(location(id));
    manifests.delete(id);
  }
  function readUrl(input) {
    if (typeof input !== 'string' || input.length > 2000 || /[\\\u0000-\u0020]/.test(input)) throw new Error('无效的皮肤资源。');
    const raw = /^tide-skin:\/\/([^/]+)\/(.+)$/.exec(input);
    if (!raw || !UUID.test(raw[1]) || /[?#]/.test(raw[2])) throw new Error('无效的皮肤资源。');
    let relative;
    try { relative = relativeName(decodeURIComponent(raw[2])); } catch { throw new Error('无效的皮肤资源。'); }
    const manifest = manifests.get(raw[1]);
    const file = manifest?.files.find(item => item.path === relative);
    if (!file) throw new Error('皮肤资源不存在。');
    const { target, stat } = assetPath(location(raw[1]), file.path);
    if (stat.size !== file.size) throw new Error('皮肤资源已改变，请重新导入。');
    const bytes = fs.readFileSync(target);
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error('皮肤资源已改变，请重新导入。');
    return { bytes, mime: file.mime };
  }
  return { root, list, has, importModel, remove, readUrl };
}

module.exports = { createSkinStore, collectModel, relativeName, modelUrl, LIMITS, UUID, BUILTIN_SHARKS, isBuiltinShark };
