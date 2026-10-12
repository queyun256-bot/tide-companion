import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { setupPetGrowthDesktop } = require('../electron/pet-growth-desktop.cjs');
const { defaultState, validateState } = require('../electron/state.cjs');
const { feedStar } = require('../electron/pet-growth.cjs');
const { balance, localDay } = require('../electron/star-wallet.cjs');
const origin = new Date(2026, 9, 12, 12, 30).getTime();
function funded(feeds = 0) {
  const at = new Date(origin - 120000).toISOString();
  let state = validateState({ ...defaultState(), starWallet: { version: 1, entries: [{ id: `plan@${at}`, planId: 'plan', doseId: 'dose', scheduledAt: at, earnedAt: at, day: localDay(origin), kind: 'long', amount: 7, intervalHours: 168, routeId: 'e2-oral', doseAmount: 1, doseAt: at }] } });
  for (let n = 0; n < feeds; n++) state = validateState({ ...state, starWallet: feedStar(state, { requestId: `initial-${n}`, sharkId: 'builtin' }, origin - 100000 + n).wallet });
  return state;
}
function harness(feeds = 0) {
  let state = funded(feeds), wall = origin, mono = 0, failSave = false, visual;
  const handlers = new Map(), events = [];
  const makeWindow = () => ({ shown: true, dead: false, ignored: false, webContents: { isDestroyed: () => false }, isVisible() { return this.shown; }, isMinimized: () => false, isDestroyed() { return this.dead; }, setIgnoreMouseEvents(value) { this.ignored = value; } });
  const pet = makeWindow(), dashboard = makeWindow();
  visual = { at: wall, idleSince: wall - 60001, idleEligible: true, behavior: 'awake', hidden: false, live2d: false };
  const desktop = { dragging: false, isDragging() { return this.dragging; }, getVisual: () => visual, cancelDrag() { this.dragging = false; } };
  const controller = setupPetGrowthDesktop({ ipcMain: { handle: (key, handler) => handlers.set(key, handler) }, trustedSender: e => [pet.webContents, dashboard.webContents].includes(e.sender), getState: () => state,
    persist(next) { if (failSave) throw new Error('disk full'); state = validateState(next); }, getPet: () => pet, getDashboard: () => dashboard, broadcast: (channel, value) => events.push({ channel, value }), desktopPet: desktop,
    now: () => wall, clock: () => mono, random: () => 0, schedule: () => 1, unschedule() {} });
  const call = (method, input, sender = dashboard.webContents) => handlers.get(`pet:star-feed-${method}`)({ sender }, input);
  function tick(ms = 1000, fresh = true) { mono += ms; wall += ms; if (fresh) visual.at = wall; controller.tick(); }
  return { call, controller, pet, dashboard, desktop, events, visual, tick, get state() { return state; }, failSave: value => { failSave = value; }, setSkin: id => { state.settings.activeSkin = id; } };
}
const token = '11111111-1111-4111-8111-111111111111';
const token2 = '22222222-2222-4222-8222-222222222222';

test('drag session is trusted, commits once across windows and cannot mint a star', () => {
  const h = harness(4);
  assert.throws(() => h.call('begin', { token }, {}), /无权/);
  assert.throws(() => h.call('begin', { token }, h.pet.webContents), /手账/);
  h.call('begin', { token }); assert.equal(h.controller.isFeeding(), true);
  assert.equal(h.pet.ignored, false);
  const result = h.call('commit', { token }, h.pet.webContents);
  assert.equal(result.ok, true); assert.equal(result.balance, 2); assert.equal(result.growth.level, 2); assert.equal(result.levelUp, true);
  const duplicate = h.call('commit', { token }); assert.equal(duplicate.duplicate, true); assert.equal(duplicate.balance, 2);
  assert.equal(h.events.filter(e => e.value.action === 'star-feed').length, 1);
  assert.equal(h.controller.isFeeding(), false); assert.equal(h.pet.ignored, true);
});

test('cancel, hidden target, expiry and persistence failure never deduct currency or award experience', () => {
  const h = harness();
  h.call('begin', { token }); h.call('cancel', { token }); assert.throws(() => h.call('commit', { token }), /结束/);
  h.call('begin', { token }); h.pet.shown = false; assert.throws(() => h.call('commit', { token }, h.pet.webContents), /画面/); h.pet.shown = true;
  h.call('begin', { token }); h.tick(30000); assert.equal(h.pet.ignored, true); assert.throws(() => h.call('commit', { token }), /结束/);
  h.call('begin', { token }); h.failSave(true); assert.throws(() => h.call('commit', { token }), /disk full/);
  assert.equal(balance(h.state.starWallet), 7); assert.equal(h.state.petGrowth.experience, 0);
  assert.equal(h.events.filter(e => e.value.action === 'star-feed').length, 0);
});

test('superseded sessions cannot cancel or commit a newer session, and hidden journal expires drag', () => {
  const h = harness(); h.call('begin', { token }); h.call('begin', { token: token2 });
  assert.equal(h.call('cancel', { token }), false); assert.throws(() => h.call('commit', { token }), /结束/); assert.equal(h.controller.isFeeding(), true);
  h.dashboard.shown = false; h.tick(); assert.equal(h.controller.isFeeding(), false); assert.equal(balance(h.state.starWallet), 7);
});

test('idle reward needs uninterrupted visible eligible time and uses one shared daily receipt', () => {
  const h = harness(5); h.tick();
  for (let n = 0; n < 20; n++) h.tick();
  h.pet.shown = false; h.tick(); h.pet.shown = true; h.tick();
  for (let n = 0; n < 29; n++) h.tick();
  assert.equal(h.state.starWallet.entries.filter(e => e.kind === 'idle').length, 0);
  h.tick(); assert.equal(h.state.starWallet.entries.filter(e => e.kind === 'idle').length, 1);
  assert.equal(h.events.filter(e => e.value.action === 'star-produced').length, 1);
  for (const id of ['builtin-rose', 'builtin-mint', 'builtin-peach', 'builtin-lilac']) { h.setSkin(id); for (let n = 0; n < 40; n++) h.tick(); }
  assert.equal(h.state.starWallet.entries.filter(e => e.kind === 'idle').length, 1);
});

test('sleep, dragging, stale renderer, suspend and offline gaps cannot generate catch-up rewards', () => {
  const h = harness(5);
  for (const condition of ['sleep', 'drag', 'stale', 'suspended']) {
    h.visual.behavior = condition === 'sleep' ? 'sleeping' : 'awake'; h.desktop.dragging = condition === 'drag'; h.controller.setSuspended(condition === 'suspended');
    for (let n = 0; n < 40; n++) h.tick(1000, condition !== 'stale');
    assert.equal(h.state.starWallet.entries.filter(e => e.kind === 'idle').length, 0);
  }
  h.controller.setSuspended(false); h.tick(); h.tick(86400000);
  assert.equal(h.state.starWallet.entries.filter(e => e.kind === 'idle').length, 0);
  for (let n = 0; n < 30; n++) h.tick();
  assert.equal(h.state.starWallet.entries.filter(e => e.kind === 'idle').length, 1);
});

test('failed automatic save leaves today unclaimed and retries without broadcasting a false award', () => {
  const h = harness(5); h.failSave(true); for (let n = 0; n < 32; n++) h.tick();
  assert.equal(h.state.starWallet.entries.filter(e => e.kind === 'idle').length, 0);
  assert.equal(h.events.filter(e => e.value.action === 'star-produced').length, 0);
  h.failSave(false); for (let n = 0; n < 60; n++) h.tick();
  assert.equal(h.state.starWallet.entries.filter(e => e.kind === 'idle').length, 1);
});
