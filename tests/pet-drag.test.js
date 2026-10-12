import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { installFinDrag } from '../src/pet-drag.js';
const require = createRequire(import.meta.url);
const { setupPetDesktop, DRAG_IDLE_MS, DRAG_MAX_MS } = require('../electron/pet-desktop.cjs');

function timers() {
  let now = 0, sequence = 0;
  const pending = new Map();
  return {
    now: () => now,
    set: (callback, delay) => { const id = ++sequence; pending.set(id, { at: now + delay, callback }); return id; },
    clear: id => pending.delete(id),
    tick(duration) {
      const until = now + duration;
      while (true) {
        const next = [...pending].filter(([, item]) => item.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at; pending.delete(next[0]); next[1].callback();
      }
      now = until;
    },
    callbacks: () => [...pending.values()].map(item => item.callback),
  };
}
function desktop() {
  const timer = timers(), handlers = new Map(), messages = [], positions = [], ignored = [];
  const webContents = new EventEmitter(); webContents.isDestroyed = () => false;
  webContents.send = (...args) => messages.push(args);
  let cursor = { x: -750, y: 130 }, bounds = { x: -900, y: 40, width: 320, height: 370 }, visible = true;
  const pet = { webContents, isDestroyed: () => false, isVisible: () => visible, getBounds: () => ({ ...bounds }), setBounds(next) { positions.push({ x: next.x, y: next.y }); bounds = { ...next }; }, setIgnoreMouseEvents: (...args) => ignored.push(args) };
  const controller = setupPetDesktop({ ipcMain: { handle: (name, callback) => handlers.set(name, callback) }, getPet: () => pet, trustedSender: event => event.trusted !== false, broadcast() {}, clock: timer.now, schedule: timer.set, unschedule: timer.clear,
    screen: { getCursorScreenPoint: () => ({ ...cursor }), getDisplayNearestPoint: () => ({ workArea: { x: -1920, y: 0, width: 1920, height: 1040 } }) } });
  controller.attachPet(pet);
  const event = { sender: webContents };
  const call = (name, input) => handlers.get(`pet:drag-${name}`)(event, input);
  const start = requestId => { webContents.emit('before-mouse-event', {}, { type: 'mouseDown', button: 'left', modifiers: ['leftbuttondown'] }); return call('start', { pointerId: 1, requestId, buttons: 1 }); };
  return { timer, controller, handlers, event, pet, messages, positions, ignored, call, start, cursor: value => { cursor = value; }, visible: value => { visible = value; }, native: mouse => webContents.emit('before-mouse-event', {}, mouse) };
}

test('drag expires without receiving input, releases OS interception, and never moves on timers', () => {
  const h = desktop(), session = h.start(1);
  assert.equal(h.controller.isDragging(), true);
  h.timer.tick(DRAG_IDLE_MS);
  assert.equal(h.controller.isDragging(), false);
  assert.deepEqual(h.positions, []);
  assert.deepEqual(h.ignored.at(-1), [true, { forward: true }]);
  assert.deepEqual(h.messages.at(-1), ['pet:drag-cancelled', { ...session, reason: 'idle-timeout' }]);
  assert.equal(h.call('move', { ...session, pointerId: 1, buttons: 1, sequence: 1 }), false);
});

test('stationary cursor feedback does not reposition the window or renew the deadline', () => {
  const h = desktop(), session = h.start(1);
  for (let sequence = 1; sequence <= 4; sequence++) {
    h.timer.tick(500);
    assert.equal(h.call('move', { ...session, pointerId: 1, buttons: 1, sequence }), true);
  }
  assert.deepEqual(h.positions, []);
  h.timer.tick(500);
  assert.equal(h.controller.isDragging(), false);
  assert.equal(h.messages.at(-1)[1].reason, 'idle-timeout');
});

test('DIP movement handles negative monitor origins and skips repeated clamped destination writes', () => {
  const h = desktop(), session = h.start(1);
  const move = sequence => h.call('move', { ...session, pointerId: 1, buttons: 1, sequence });
  h.cursor({ x: -660.25, y: 175.25 }); move(1);
  assert.deepEqual(h.positions.at(-1), { x: -810, y: 85 });
  h.cursor({ x: -2200, y: -50 }); move(2);
  assert.deepEqual(h.positions.at(-1), { x: -1920, y: 0 });
  h.cursor({ x: -2300, y: -70 }); move(3);
  assert.equal(h.positions.length, 2, 'further cursor motion beyond the same clamped corner has no native write');
  h.cursor({ x: Number.NaN, y: 0 });
  assert.equal(move(4), false); assert.equal(h.controller.isDragging(), false);
});

test('fractional-DPI size readback cannot shrink right/down travel across repeated drag sessions', () => {
  const h = desktop(), writes = [];
  let native = { x: -900, y: 40, width: 864, height: 916 };
  h.pet.getBounds = () => ({ ...native });
  h.pet.setBounds = (next, animate) => {
    assert.equal(animate, false);
    assert.equal(next.width, 320); assert.equal(next.height, 370);
    writes.push(next);
    // Native/DIP rounding can report a slightly larger rectangle. It must
    // never become the requested size on the next move or the next session.
    native = { ...next, width: next.width + 1, height: next.height + 2 };
  };
  const destinations = [
    { cursor: { x: -20, y: 1030 }, position: { x: -320, y: 670 } },
    { cursor: { x: -1910, y: 1030 }, position: { x: -1920, y: 670 } },
    { cursor: { x: -1910, y: 5 }, position: { x: -1920, y: 0 } },
    { cursor: { x: -20, y: 5 }, position: { x: -320, y: 0 } },
  ];
  for (let round = 0; round < 50; round++) {
    h.cursor({ x: native.x + 150, y: native.y + 90 });
    const session = h.start(round);
    for (const [index, target] of destinations.entries()) {
      h.cursor(target.cursor);
      assert.equal(h.call('move', { ...session, pointerId: 1, buttons: 1, sequence: index + 1 }), true);
      assert.deepEqual({ x: native.x, y: native.y }, target.position);
    }
    assert.equal(h.call('end', session), true);
  }
  assert.equal(writes.length, 200);
  assert.deepEqual({ width: native.width, height: native.height }, { width: 321, height: 372 });
});

test('stale tokens, old watchdog callbacks and reordered moves cannot control a newer drag', () => {
  const h = desktop(), first = h.start(1), oldTimers = h.timer.callbacks(), second = h.start(2);
  assert.notEqual(first.token, second.token);
  const count = h.ignored.length;
  assert.equal(h.call('end', first), false);
  assert.equal(h.call('move', { ...first, pointerId: 1, buttons: 1, sequence: 99 }), false);
  oldTimers.forEach(callback => callback());
  assert.equal(h.controller.isDragging(), true); assert.equal(h.ignored.length, count);
  h.cursor({ x: -740, y: 130 });
  assert.equal(h.call('move', { ...second, pointerId: 1, buttons: 1, sequence: 2 }), true);
  h.cursor({ x: -730, y: 130 });
  assert.equal(h.call('move', { ...second, pointerId: 1, buttons: 1, sequence: 1 }), false);
  assert.equal(h.positions.length, 1);
  assert.equal(h.call('end', second), true);
});

test('renderer buttons zero and native mouse release independently cancel dragging', () => {
  for (const method of ['renderer', 'native-up', 'native-move']) {
    const h = desktop(), session = h.start(1);
    if (method === 'renderer') assert.equal(h.call('move', { ...session, pointerId: 1, sequence: 1, buttons: 0 }), false);
    if (method === 'native-up') h.native({ type: 'mouseUp', button: 'left', modifiers: [] });
    if (method === 'native-move') h.native({ type: 'mouseMove', modifiers: [] });
    assert.equal(h.controller.isDragging(), false, method);
    assert.equal(h.messages.length, 1);
  }
});
test('Electron mouse events without modifier output keep the drag; explicit modifiers are case-insensitive', () => {
  const h = desktop(); h.start(1);
  h.native({ type: 'mouseMove', button: 'left', x: 55, y: 55 });
  assert.equal(h.controller.isDragging(), true, 'Electron 44 before-mouse-event omits modifiers');
  for (const modifier of ['leftButtonDown', 'leftbuttondown']) {
    h.native({ type: 'mouseMove', button: 'left', modifiers: [modifier] });
    assert.equal(h.controller.isDragging(), true);
  }
  h.native({ type: 'mouseUp', button: 'left' });
  assert.equal(h.controller.isDragging(), false, 'native mouseUp remains an independent release signal');
});

test('held input cannot extend a session beyond its hard maximum', () => {
  const h = desktop(), session = h.start(1);
  for (let sequence = 1; sequence < DRAG_MAX_MS / 1000; sequence++) {
    h.timer.tick(1000); h.cursor({ x: -750 + sequence, y: 130 });
    assert.equal(h.call('move', { ...session, pointerId: 1, buttons: 1, sequence }), true);
  }
  h.timer.tick(1000);
  assert.equal(h.controller.isDragging(), false);
  assert.equal(h.messages.at(-1)[1].reason, 'maximum-duration');
});

test('crashed or navigating renderer always relinquishes interception; invalid senders cannot drag', () => {
  const h = desktop();
  h.pet.webContents.emit('render-process-gone');
  assert.deepEqual(h.ignored.at(-1), [true, { forward: true }]);
  h.start(1); h.pet.webContents.emit('did-start-navigation');
  assert.equal(h.controller.isDragging(), false);
  assert.equal(h.messages.at(-1)[1].reason, 'navigation');
  assert.throws(() => h.handlers.get('pet:drag-start')({ sender: {}, trusted: true }, { pointerId: 1, requestId: 2, buttons: 1 }), /仅桌宠/);
  h.cursor({ x: Infinity, y: 130 }); assert.throws(() => h.start(3), /鱼鳍/);
});

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function renderer(t, overrides = {}) {
  const timer = timers(), win = new EventTarget(), doc = new EventTarget(), handle = new EventTarget(), capture = new Set(), classes = new Set(), calls = { starts: [], moves: [], ends: [] };
  doc.hidden = false;
  t.mock.method(globalThis, 'setTimeout', timer.set); t.mock.method(globalThis, 'clearTimeout', timer.clear);
  const originals = { window: globalThis.window, document: globalThis.document };
  globalThis.window = win; globalThis.document = doc;
  t.after(() => { globalThis.window = originals.window; globalThis.document = originals.document; });
  handle.setPointerCapture = id => capture.add(id); handle.hasPointerCapture = id => capture.has(id); handle.releasePointerCapture = id => capture.delete(id);
  const stage = { classList: { add: (...items) => items.forEach(item => classes.add(item)), remove: (...items) => items.forEach(item => classes.delete(item)) } };
  let cancel;
  const api = { startPetDrag: async input => { calls.starts.push(input); return { token: `token-${input.requestId}`, requestId: input.requestId }; }, movePetDrag: async input => { calls.moves.push(input); return true; }, endPetDrag: async input => { calls.ends.push(input); return true; }, onPetDragCancelled: callback => { cancel = callback; return () => { cancel = null; }; }, ...overrides };
  const controller = installFinDrag({ stage, handle, api }); t.after(() => controller.dispose());
  const dispatch = (target, type, values = {}) => { const event = new Event(type, { cancelable: true }); Object.assign(event, { pointerId: 1, button: 0, buttons: 1, isPrimary: true, screenX: 100, screenY: 90, ...values }); target.dispatchEvent(event); };
  return { timer, win, doc, handle, capture, classes, calls, controller, cancel: event => cancel?.(event), dispatch,
    down: () => dispatch(handle, 'pointerdown'),
    async start() { dispatch(handle, 'pointerdown'); timer.tick(450); await flush(); assert.equal(controller.active, true); } };
}

test('renderer requires fresh held motion; a lost mouseup expires and releases real pointer capture', async t => {
  const h = renderer(t); await h.start();
  assert.equal(h.capture.size, 1); assert.deepEqual(h.calls.moves, []);
  for (let i = 0; i < 4; i++) { h.timer.tick(500); h.dispatch(h.win, 'pointermove'); }
  await flush(); assert.deepEqual(h.calls.moves, [], 'same screen point cannot act as a movement heartbeat');
  h.timer.tick(500); await flush();
  assert.equal(h.controller.active, false); assert.equal(h.capture.size, 0);
  assert.equal(h.calls.ends.length, 1); assert.equal(h.classes.has('is-dragging'), false);
});

test('global releases, buttons zero, blur, hidden and Escape clear pointer capture', async t => {
  const h = renderer(t);
  for (const method of ['pointerup', 'pointercancel', 'lostpointercapture', 'mouseup', 'buttons-zero', 'blur', 'hidden', 'escape']) {
    h.doc.hidden = false; await h.start();
    if (method === 'buttons-zero') h.dispatch(h.win, 'pointermove', { buttons: 0 });
    else if (method === 'hidden') { h.doc.hidden = true; h.dispatch(h.doc, 'visibilitychange'); }
    else if (method === 'escape') h.dispatch(h.doc, 'keydown', { key: 'Escape' });
    else h.dispatch(h.win, method);
    assert.equal(h.controller.active, false, method); assert.equal(h.capture.size, 0, method);
  }
});

test('late start and move responses never resurrect or cancel a newer gesture', async t => {
  let resolveStart, resolveMove;
  const h = renderer(t, { startPetDrag: input => input.requestId === 1 ? new Promise(resolve => { resolveStart = resolve; }) : Promise.resolve({ token: 'second', requestId: input.requestId }), movePetDrag: () => new Promise(resolve => { resolveMove = resolve; }) });
  h.down(); h.timer.tick(450); h.dispatch(h.win, 'pointerup');
  await h.start(); resolveStart({ token: 'first', requestId: 1 }); await flush();
  assert.equal(h.controller.active, true); assert.deepEqual(h.calls.ends, [{ token: 'first' }]);
  h.dispatch(h.win, 'pointermove', { screenX: 110 }); await flush();
  h.dispatch(h.win, 'pointerup'); await h.start();
  resolveMove(false); await flush();
  assert.equal(h.controller.active, true); assert.equal(h.capture.size, 1);
  h.cancel({ token: 'first', requestId: 1 }); assert.equal(h.controller.active, true);
  h.cancel({ token: 'third', requestId: 3 }); assert.equal(h.controller.active, false);
});

test('preparation cancels on movement and an active gesture coalesces only fresh input', async t => {
  const h = renderer(t);
  h.down(); h.dispatch(h.win, 'pointermove', { screenX: 112 }); h.timer.tick(500); await flush();
  assert.equal(h.calls.starts.length, 0); assert.equal(h.capture.size, 0);
  await h.start();
  h.dispatch(h.win, 'pointermove', { screenX: 105 });
  h.dispatch(h.win, 'pointermove', { screenX: 110 });
  h.dispatch(h.win, 'pointermove', { screenX: 120 });
  await flush();
  assert.equal(h.calls.moves.length, 2); assert.deepEqual(h.calls.moves.map(item => item.sequence), [1, 2]);
  h.timer.tick(1000); await flush(); assert.equal(h.calls.moves.length, 2, 'no timer ever sends another move');
});
