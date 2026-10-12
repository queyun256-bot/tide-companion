import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { BUILTIN_SHARKS, getBuiltinShark } from '../src/shark-variants.js';
import { PetBehavior } from '../src/pet-behavior.js';
const require = createRequire(import.meta.url);
const { createSkinStore } = require('../electron/skins.cjs');
const { defaultState, createStateStore, validateState } = require('../electron/state.cjs');
const { clampDragPosition, validateVisual, setupPetDesktop } = require('../electron/pet-desktop.cjs');

test('all five builtin skins have distinct accessible artwork and survive state reload; none can be removed', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-variants-'));
  const skins = createSkinStore(directory), store = createStateStore(directory);
  assert.equal(new Set(BUILTIN_SHARKS.map(item => item.thumbnail)).size, 5);
  for (const variant of BUILTIN_SHARKS) {
    assert.ok(skins.has(variant.id)); assert.throws(() => skins.remove(variant.id), /不能删除/);
    const svg = fs.readFileSync(new URL(`../${variant.thumbnail}`, import.meta.url), 'utf8');
    assert.match(svg, /跨性别旗帜/); assert.match(svg, /<title/);
    assert.doesNotMatch(svg, /<script|<image|(?:href|src)=["']https?:/);
    const state = defaultState(); state.settings.activeSkin = variant.id; state.settings.name = '小团子';
    store.save(state);
    const next = createStateStore(directory).load().state;
    assert.equal(next.settings.activeSkin, variant.id); assert.equal(next.settings.name, '小团子');
  }
  assert.throws(() => validateState({ ...defaultState(), settings: { ...defaultState().settings, activeSkin: 'builtin-fake' } }), /皮肤/);
  assert.equal(getBuiltinShark('untrusted').id, 'builtin');
});

test('personalities have distinct timing and varied kind replies; a low day quiets every companion', () => {
  const replies = new Set(), timings = new Set();
  for (const variant of BUILTIN_SHARKS) {
    const pet = new PetBehavior({ variant: variant.id, now: 0, random: () => .4 });
    timings.add(pet.nextActionAt);
    const lines = Array.from({ length: 6 }, (_, index) => pet.line('pet', index).message);
    assert.ok(new Set(lines).size >= 4);
    replies.add(lines[0]);
    const interval = pet.profile.action[0];
    pet.setMood('low', 1);
    assert.ok(pet.profile.action[0] > interval);
    assert.ok(!pet.profile.actions.includes('wiggle'));
    for (const category of ['mood','pet','nuzzle','stroke','reward','idle','sleep','wake','touchWake']) {
      const message = pet.line(category, 2).message;
      assert.ok(message.length < 30);
      assert.doesNotMatch(message, /只有我|不要离开|不理我|必须|主人|治疗|激素|药量/);
    }
  }
  assert.equal(replies.size, 5); assert.equal(timings.size, 5);
});

test('changing skin keeps mood and an ongoing nap intact without managing currency', () => {
  const pet = new PetBehavior({ now: 0, random: () => .5 });
  pet.setMood('low', 0); pet.startSleep(2);
  const until = pet.wakeAt;
  pet.setVariant('builtin-peach', 100);
  assert.equal(pet.state, 'drowsy'); assert.equal(pet.wakeAt, until);
  assert.equal(pet.mood, 'low'); assert.equal(pet.stars, undefined);
  pet.tick(pet.transitionAt); assert.equal(pet.state, 'sleeping');
  pet.tick(pet.wakeAt); assert.equal(pet.state, 'waking');
});

test('drag uses finite DIP coordinates and keeps the whole pet on positive or negative monitor origins', () => {
  const bounds = { width: 320, height: 370 }, offset = { x: 160, y: 90 };
  assert.deepEqual(clampDragPosition(bounds, { x: -1800, y: -1000 }, offset, { x: -1920, y: -1080, width: 1920, height: 1080 }), { x: -1920, y: -1080 });
  assert.deepEqual(clampDragPosition(bounds, { x: 1919, y: 1079 }, offset, { x: 0, y: 0, width: 1920, height: 1040 }), { x: 1600, y: 670 });
  assert.deepEqual(clampDragPosition(bounds, { x: 2000.5, y: 600.5 }, offset, { x: 1920, y: 0, width: 1280, height: 720 }), { x: 1920, y: 350 });
  assert.throws(() => clampDragPosition(bounds, { x: Infinity, y: 0 }, offset, { x: 0, y: 0, width: 1920, height: 1080 }), /坐标/);
});

function visualFixture() { return { version:1, at:1, behavior:'awake', mood:'okay', variant:'builtin', classes:[], variables:{'--gaze-x':'0px','--gaze-y':'0px','--fin-duration':'4.2s','--breath-duration':'5.8s'}, pose:{bodyTransform:'none',eyesTransform:'none',faceTransform:'none',gazeTransform:'matrix(1, 0, 0, 1, 0, 0)',finLeftTransform:'none',finRightTransform:'none',smileOpacity:'1',yawnOpacity:'0'}, transitioning:[], stars:0, animations:[] }; }
test('visual relay only accepts pet publishers and numeric bounded visuals, never arbitrary selectors or styles', async () => {
  const handlers = new Map(), messages = [], webContents = {}, pet = { webContents, isDestroyed:()=>false };
  setupPetDesktop({ ipcMain:{handle:(name,fn)=>handlers.set(name,fn)}, screen:{}, getPet:()=>pet, trustedSender:()=>true, broadcast:(...args)=>messages.push(args) });
  const event = { sender:webContents }, badEvent = { sender:{} }, value = visualFixture();
  assert.equal(handlers.get('pet:visual-publish')(event,value),true);
  assert.equal(handlers.get('pet:visual-get')(event).variant,'builtin');
  assert.throws(()=>handlers.get('pet:visual-publish')(badEvent,value),/仅桌宠/);
  assert.throws(()=>handlers.get('pet:drag-start')(badEvent),/仅桌宠/);
  assert.throws(()=>validateVisual({...value,classes:['user-code']}),/状态/);
  assert.throws(()=>validateVisual({...value,variables:{...value.variables,'--gaze-x':'url(file:///private)'}}),/姿态/);
  assert.throws(()=>validateVisual({...value,pose:{...value.pose,bodyTransform:'url(file:///private)'}}),/矩阵/);
  assert.equal(messages.length,1);
});
