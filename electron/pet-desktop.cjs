'use strict';

const { isBuiltinShark } = require('./skins.cjs');
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { PET_WINDOW_SIZE, movePetWindow } = require('./pet-window.cjs');
const DRAG_IDLE_MS = 2500, DRAG_MAX_MS = 30000;
const VISUAL_CLASSES = new Set(['is-drowsy', 'is-sleeping', 'is-waking', 'is-blinking', 'is-enjoying-touch', 'is-dragging', 'is-drag-preparing', 'is-drag-releasing', 'action-pat', 'action-stroke', 'action-feed', 'action-nuzzle', 'action-tilt', 'action-blink', 'action-nod', 'action-stretch', 'action-wiggle', 'action-wave', 'action-scarf', 'action-sway', 'action-peek', 'action-tailcurl', 'action-bob', 'action-star-eat', 'action-star-produce']);
const VISUAL_TARGETS = new Set(['float', 'body', 'fin-left', 'fin-right', 'tail', 'eyes', 'eye-left', 'eye-right', 'face', 'gaze', 'smile', 'yawn', 'stars', 'sleep', 'mouth-star', 'born-stars']);
function clampDragPosition(bounds, cursor, offset, area) {
  for (const item of [bounds, cursor, offset, area]) if (!item || typeof item !== 'object') throw new Error('拖动坐标无效。');
  const values = [bounds.width, bounds.height, cursor.x, cursor.y, offset.x, offset.y, area.x, area.y, area.width, area.height];
  if (!values.every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0 || area.width <= 0 || area.height <= 0) throw new Error('拖动坐标无效。');
  // Electron screen coordinates are DIPs, including negative monitor origins.
  return { x: Math.round(Math.max(area.x, Math.min(cursor.x - offset.x, area.x + Math.max(0, area.width - bounds.width)))), y: Math.round(Math.max(area.y, Math.min(cursor.y - offset.y, area.y + Math.max(0, area.height - bounds.height)))) };
}
function validateVisual(value) {
  if (!value || value.version !== 1 || !['awake', 'drowsy', 'sleeping', 'waking'].includes(value.behavior) || !['good', 'okay', 'low'].includes(value.mood) || !isBuiltinShark(value.variant) || !Array.isArray(value.classes) || value.classes.length > 24 || !value.classes.every(item => VISUAL_CLASSES.has(item)) || !Number.isFinite(value.at)) throw new Error('桌宠画面状态无效。');
  const variables = {};
  for (const key of ['--gaze-x', '--gaze-y', '--fin-duration', '--breath-duration']) {
    const field = value.variables?.[key];
    if (typeof field !== 'string' || !/^-?\d+(?:\.\d+)?(?:px|s)$/.test(field) || Math.abs(parseFloat(field)) > 60) throw new Error('桌宠姿态无效。');
    variables[key] = field;
  }
  if (!Array.isArray(value.animations) || value.animations.length > 30) throw new Error('桌宠动作无效。');
  const animations = value.animations.map(item => {
    if (!VISUAL_TARGETS.has(item?.target) || typeof item.name !== 'string' || !/^[a-z-]{1,40}$/.test(item.name) || !Number.isFinite(item.time) || Math.abs(item.time) > 1e12 || !Number.isFinite(item.rate) || item.rate < 0 || item.rate > 3) throw new Error('桌宠动作无效。');
    return { target: item.target, name: item.name, time: item.time, rate: item.rate };
  });
  const pose = {};
  for (const key of ['bodyTransform','eyesTransform','faceTransform','gazeTransform','finLeftTransform','finRightTransform','smileOpacity','yawnOpacity']) {
    const field = value.pose?.[key];
    if (typeof field !== 'string' || field.length > 240 || !(field === 'none' || /^matrix(?:3d)?\([-\d.e+, ]+\)$/.test(field) || /^0(?:\.\d+)?$|^1(?:\.0+)?$/.test(field))) throw new Error('桌宠姿态矩阵无效。');
    pose[key] = field;
  }
  if (!Array.isArray(value.transitioning) || value.transitioning.length > 16 || !value.transitioning.every(key => VISUAL_TARGETS.has(key))) throw new Error('桌宠过渡状态无效。');
  if(value.stars!==undefined&&(!Number.isSafeInteger(value.stars)||value.stars<0))throw new Error('星星余额画面无效。');
  for(const key of ['starEpoch','starPausedAt'])if(value[key]!==undefined&&(!Number.isFinite(value[key])||Math.abs(value[key])>8.64e15))throw new Error('星光时间无效。');
  if (value.idleSince !== undefined && (!Number.isFinite(value.idleSince) || Math.abs(value.idleSince) > 8.64e15)) throw new Error('桌宠待机时间无效。');
  if (value.starProducedAmount !== undefined && (!Number.isInteger(value.starProducedAmount) || value.starProducedAmount < 0 || value.starProducedAmount > 10)) throw new Error('桌宠产星画面无效。');
  return { version: 1, at: value.at, behavior: value.behavior, mood: value.mood, variant: value.variant, classes: [...new Set(value.classes)], variables, pose, transitioning: value.transitioning, stars: value.stars||0, starsVisible: value.starsVisible === true, starEpoch:value.starEpoch||0,starPaused:value.starPaused===true,starPausedAt:value.starPausedAt||0,starCelebrating:value.starCelebrating===true, reducedMotion: value.reducedMotion === true, hidden: value.hidden === true, live2d: value.live2d === true, idleEligible: value.idleEligible === true, idleSince: value.idleSince || 0, starProducedAmount: value.starProducedAmount || 0, animations };
}
function setupPetDesktop({ ipcMain, screen, getPet, trustedSender, broadcast, clock = () => performance.now(), schedule = setTimeout, unschedule = clearTimeout }) {
  let drag = null, visual = null, idleTimer, hardTimer;
  const attached = new WeakSet(), buttonState = new WeakMap();
  const onlyPet = event => {
    const pet = getPet();
    if (!trustedSender(event) || !pet || pet.isDestroyed() || event.sender !== pet.webContents) throw new Error('仅桌宠窗口可以执行此操作。');
    return pet;
  };
  function cancelDrag(reason = 'cancelled', expectedToken) {
    if (expectedToken && drag?.token !== expectedToken) return false;
    const pet = getPet();
    // A crashed/hidden renderer cannot restore desktop hit testing itself.
    // Ordinary release lets the live renderer immediately recheck the pointer.
    if (!['ended', 'button-released', 'superseded'].includes(reason) && pet && !pet.isDestroyed()) pet.setIgnoreMouseEvents?.(true, { forward: true });
    if (!drag) return false;
    const previous = drag; drag = null;
    unschedule(idleTimer); unschedule(hardTimer);
    if (pet && !pet.isDestroyed() && !pet.webContents.isDestroyed?.()) pet.webContents.send?.('pet:drag-cancelled', { token: previous.token, requestId: previous.requestId, reason });
    return true;
  }
  function attachPet(pet) {
    if (!pet || attached.has(pet)) return;
    attached.add(pet);
    pet.webContents.on?.('before-mouse-event', (_event, mouse) => {
      if (getPet() !== pet) return;
      if (mouse.type === 'mouseDown' && mouse.button === 'left') buttonState.set(pet, true);
      // Electron 44's WebMouseEvent converter omits modifiers on output. Do
      // not mistake an absent array for released buttons; renderer pointermove
      // supplies that guard. If a future converter exposes them, accept case.
      const explicitlyReleased = Array.isArray(mouse.modifiers) && !mouse.modifiers.some(value => typeof value === 'string' && value.toLowerCase() === 'leftbuttondown');
      if (mouse.type === 'mouseUp' && mouse.button === 'left' || mouse.type === 'mouseMove' && explicitlyReleased) {
        buttonState.set(pet, false); cancelDrag('button-released');
      }
    });
    pet.webContents.on?.('render-process-gone', () => { if (getPet() === pet) cancelDrag('renderer-gone'); });
    pet.webContents.on?.('did-start-navigation', () => { if (getPet() === pet) cancelDrag('navigation'); });
  }
  const validPointer = value => Number.isSafeInteger(value) && value >= 0;
  const validToken = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
  function armIdle(session) {
    unschedule(idleTimer);
    idleTimer = schedule(() => cancelDrag('idle-timeout', session.token), DRAG_IDLE_MS);
    idleTimer?.unref?.();
  }
  ipcMain.handle('pet:drag-start', (event, input) => {
    const pet = onlyPet(event);
    attachPet(pet);
    if (!input || !validPointer(input.pointerId) || !validPointer(input.requestId) || input.buttons !== 1 || buttonState.get(pet) === false) throw new Error('请保持按住鱼鳍后拖动。');
    const cursor = screen.getCursorScreenPoint(), bounds = pet.getBounds();
    if (!Number.isFinite(cursor.x) || !Number.isFinite(cursor.y) || !pet.isVisible() || cursor.x < bounds.x || cursor.x > bounds.x + bounds.width || cursor.y < bounds.y || cursor.y > bounds.y + bounds.height) throw new Error('请在鱼鳍上按住后拖动。');
    pet.setIgnoreMouseEvents?.(false);
    cancelDrag('superseded');
    const now = clock();
    drag = { token: randomUUID(), requestId: input.requestId, pointerId: input.pointerId, sequence: 0, offset: { x: cursor.x - bounds.x, y: cursor.y - bounds.y }, cursor: { ...cursor }, touchedAt: now, startedAt: now };
    const session = drag;
    armIdle(session); hardTimer = schedule(() => cancelDrag('maximum-duration', session.token), DRAG_MAX_MS); hardTimer?.unref?.();
    return { token: session.token, requestId: session.requestId };
  });
  ipcMain.handle('pet:drag-move', (event, input) => {
    const pet = onlyPet(event);
    if (!drag || !validToken(input?.token) || input.token !== drag.token) return false;
    if (!Number.isSafeInteger(input.sequence) || input.sequence <= drag.sequence || input.pointerId !== drag.pointerId) return false;
    const now = clock();
    if (!pet.isVisible() || input.buttons !== 1 || buttonState.get(pet) === false || now - drag.touchedAt >= DRAG_IDLE_MS || now - drag.startedAt >= DRAG_MAX_MS) { cancelDrag('expired-or-released', drag.token); return false; }
    drag.sequence = input.sequence;
    const cursor = screen.getCursorScreenPoint();
    if (!Number.isFinite(cursor.x) || !Number.isFinite(cursor.y)) { cancelDrag('invalid-coordinates'); return false; }
    if (cursor.x === drag.cursor.x && cursor.y === drag.cursor.y) return true;
    drag.cursor = { ...cursor };
    const next = clampDragPosition(PET_WINDOW_SIZE, cursor, drag.offset, screen.getDisplayNearestPoint(cursor).workArea);
    const current = pet.getBounds();
    if (next.x !== current.x || next.y !== current.y) movePetWindow(pet, next);
    drag.touchedAt = now; armIdle(drag);
    return true;
  });
  ipcMain.handle('pet:drag-end', (event, input) => { onlyPet(event); return validToken(input?.token) && cancelDrag('ended', input.token); });
  ipcMain.handle('pet:visual-publish', (event, value) => {
    onlyPet(event);
    visual = validateVisual(value);
    broadcast('pet:visual-state', visual);
    return true;
  });
  ipcMain.handle('pet:visual-get', event => {
    if (!trustedSender(event)) throw new Error('此页面无权访问桌宠画面。');
    return visual;
  });
  return { cancelDrag, attachPet, isDragging: () => Boolean(drag), getVisual: () => visual };
}
module.exports = { setupPetDesktop, clampDragPosition, validateVisual, DRAG_IDLE_MS, DRAG_MAX_MS };
