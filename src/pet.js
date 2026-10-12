import { PetBehavior, moodFromDailyRecords, IDLE_ACTIONS, IDLE_DURATIONS } from './pet-behavior.js';
import { applySharkPalette, isBuiltinShark } from './shark-variants.js';
import { visibleSkinId } from './skin-features.js';
import { installFinDrag } from './pet-drag.js';
import { installPetInput } from './pet-input.js';
import { installStarFeeding } from './star-feeding.js';
import { publishCompanionVisual } from './pet-visual.js';
import { walletBalance, renderStarfield } from './star-effects.js';
import { ensurePetStarEffects, setProducedAmount } from './pet-star-animation.js';

const api = window.petAPI;
const stage = document.querySelector('.pet-stage'), speech = document.getElementById('speech'), text = document.getElementById('speech-text');
const sleepButton = document.getElementById('sleep-pet'), sparkles = document.getElementById('sparkles'), touch = document.getElementById('shark-touch');
const starLights = document.getElementById('star-lights');
const speechOpen = document.getElementById('speech-open');
const dashboardButton = document.getElementById('open-dashboard');
const companion = new PetBehavior();
const gestureClasses = ['pat', 'stroke', 'feed', 'nuzzle', 'tilt', 'blink', 'nod', 'stretch', 'wiggle', 'star-eat', 'star-produce', ...IDLE_ACTIONS].map(action => `action-${action}`);
ensurePetStarEffects(stage);
const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
const petInput = installPetInput({ stage, api });
const starFeeding = installStarFeeding({ root: document, api, desktopStage: stage });
const finDrag = installFinDrag({ stage, handle: document.getElementById('fin-drag-handle'), api,
  onStart() { clearGesture(); resetSmallMotion(); clearTimeout(touchRelaxTimer); stage.classList.remove('is-enjoying-touch'); },
  onEnd(duration) {
    // Pausing while carried preserves a nap instead of making drag a wake action.
    for (const key of ['nextActionAt', 'sleepAt', 'wakeAt', 'transitionAt']) if (Number.isFinite(companion[key])) companion[key] += duration;
    companion.lastInteractionAt = Date.now();
  }
});
let name = '鲨鲨', initialized = false, moodRecords = [], activeSkin = 'builtin';
let starBalance = 0, starEpoch = Date.now(), starPausedAt = null;
const celebratedRewards = new Set();
let speechTimer, actionTimer, sparkleTimer, clickTimer, controlsTimer, starTimer, holdTimer, blinkTimer, touchRelaxTimer;
let activeGesture = '', queuedGesture = null;
let lastReceivedAction = '', lastReceivedAt = 0, reminderUntil = 0, swallowClickUntil = 0, contact = null;
let nextBlinkAt = Date.now() + 2500 + Math.random() * 3000, nextLookAt = Date.now() + 9000, lastPointerAt = 0, gazeResetAt = 0;

function permitsSmallMotion() {
  return companion.state === 'awake' && !activeGesture.startsWith('star-') && !finDrag.active && !document.hidden && !motionPreference.matches && !document.documentElement.classList.contains('reduced-motion') && !window.TideLive2D?.active;
}

function lookAt(x = 0, y = 0) {
  stage.style.setProperty('--gaze-x', `${x.toFixed(2)}px`);
  stage.style.setProperty('--gaze-y', `${y.toFixed(2)}px`);
}

function resetSmallMotion() {
  clearTimeout(blinkTimer);
  stage.classList.remove('is-blinking');
  lookAt();
  nextBlinkAt = Date.now() + 2500 + Math.random() * 4000;
}

function smallMotion(now) {
  if (!permitsSmallMotion()) return;
  if (now >= nextBlinkAt) {
    stage.classList.add('is-blinking');
    clearTimeout(blinkTimer);
    blinkTimer = setTimeout(() => stage.classList.remove('is-blinking'), 330);
    nextBlinkAt = now + 2800 + Math.random() * 5100;
  }
  if (gazeResetAt && now >= gazeResetAt) { lookAt(); gazeResetAt = 0; }
  if (now >= nextLookAt && now - lastPointerAt > 2400) {
    lookAt((Math.random() - .5) * 4.5, (Math.random() - .5) * 2.5);
    gazeResetAt = now + 1100 + Math.random() * 1200;
    nextLookAt = now + 8500 + Math.random() * 10000;
  }
}

function say(message, duration = 6500, reminder = false) {
  if (!reminder && (Date.now() < reminderUntil || (speech.classList.contains('is-reminder') && speech.contains(document.activeElement)))) return;
  clearTimeout(speechTimer);
  duration = Math.max(duration, Math.min(reminder ? 45000 : 15000, message.length * (reminder ? 250 : 160)));
  text.textContent = message;
  text.tabIndex = reminder ? 0 : -1;
  speechOpen.hidden = !reminder;
  speech.classList.remove('is-hidden');
  speech.inert = false;
  speech.setAttribute('aria-hidden', 'false');
  speech.classList.toggle('is-reminder', reminder);
  const scrollable = text.scrollHeight > text.clientHeight + 1;
  speech.classList.toggle('is-scrollable', scrollable);
  text.tabIndex = reminder || scrollable ? 0 : -1;
  if (reminder) reminderUntil = Date.now() + duration;
  const hide = () => {
    if (speech.contains(document.activeElement)) { speechTimer = setTimeout(hide, 1500); return; }
    speech.classList.add('is-hidden');
    speech.inert = true;
    speech.setAttribute('aria-hidden', 'true');
  };
  speechTimer = setTimeout(hide, duration);
}

function updateLabels() {
  const sleeping = ['drowsy', 'sleeping'].includes(companion.state);
  document.title = `${name} · 桌面伙伴`;
  touch.title = `摸摸${name} · 按住轻蹭 · 滑动抚摸 · 双击打开手账`;
  touch.setAttribute('aria-label', `摸摸${name}；按住轻蹭，滑动抚摸；双击打开手账`);
  document.querySelector('.drag-handle title').textContent = `长按${name}头顶鱼鳍后，轻轻拖动`;
  document.querySelector('.drag-handle').setAttribute('aria-label', `长按${name}头顶鱼鳍后拖动`);
  const labels = { 'pat-pet': `摸摸${name}的脑袋`, 'nuzzle-pet': `和${name}轻轻蹭蹭`, 'wallet-pet': `查看星星余额：${starBalance} 颗`, 'sleep-pet': sleeping ? `轻轻叫醒${name}` : `让${name}打个短盹` };
  for (const [id, label] of Object.entries(labels)) { const element = document.getElementById(id); element.title = label; element.setAttribute('aria-label', label); }
  sleepButton.setAttribute('aria-pressed', String(sleeping));
  stage.setAttribute('aria-label', `${name}，桌面伙伴`);
  document.querySelector('#builtin-pet svg title').textContent = `${name}，戴着跨性别旗帜围巾的小鲨鱼`;
  document.getElementById('live2d-canvas').setAttribute('aria-label', `${name}，Live2D 桌宠`);
}

function updateStarfield() {
  const now=Date.now(), reducedMotion=motionPreference.matches||document.documentElement.classList.contains('reduced-motion');
  const paused=document.hidden||reducedMotion;
  if(paused&&starPausedAt===null)starPausedAt=now;
  else if(!paused&&starPausedAt!==null){starEpoch+=Math.max(0,now-starPausedAt);starPausedAt=null;}
  renderStarfield(starLights,{balance:starBalance,epoch:starEpoch,now,reducedMotion,paused,pausedAt:starPausedAt,variant:companion.variant.id});
}
function showWallet() {
  say(`身边还有 ${starBalance} 颗星星。可以在手账里拖一颗给我，慢慢长大。`,8500);
  showControls();
}
function companionStarEvent(event) {
  if (!['star-feed', 'star-produced'].includes(event?.action) || typeof event.id !== 'string' || celebratedRewards.has(event.id)) return;
  celebratedRewards.add(event.id);
  if (celebratedRewards.size > 100) celebratedRewards.delete(celebratedRewards.values().next().value);
  const feeding = event.action === 'star-feed';
  if (feeding) {
    companion.lastInteractionAt = Date.now();
    processEffects(companion.wake(Date.now()));
    companion.scheduleAwake(Date.now());
  }
  clearGesture(); resetSmallMotion();
  setProducedAmount(stage, feeding ? 0 : event.amount);
  animate(feeding ? 'star-eat' : 'star-produce', true);
  if (feeding) say(companion.line('feed', Date.now()).message);
  else {
    const lines = { builtin: '咦，围巾里亮了一点。', 'builtin-rose': '围巾里藏了点暖暖的星光。', 'builtin-mint': '小鳍边，慢慢亮起来了。', 'builtin-peach': '尾巴一晃，掉出小星星啦。', 'builtin-lilac': '刚刚的小梦，留下一点光。' };
    say(lines[companion.variant.id] || lines.builtin, 7500);
  }
}
function celebrateReward(event) {
  if(!Number.isSafeInteger(event?.amount)||event.amount<=0||!Number.isSafeInteger(event?.balance))return;
  const key=JSON.stringify([event.balance,event.amount,event.rewards?.map(item=>item.id)]);
  if(celebratedRewards.has(key))return;
  celebratedRewards.add(key);if(celebratedRewards.size>100)celebratedRewards.delete(celebratedRewards.values().next().value);
  clearTimeout(starTimer);starLights.classList.add('is-star-celebrating');
  starTimer=setTimeout(()=>starLights.classList.remove('is-star-celebrating'),4500);
  if(companion.state==='awake'&&!finDrag.active&&!document.hidden)animate(companion.mood==='low'?'nod':'nuzzle');
  say(`${companion.line('reward',Date.now()).message} ＋${event.amount} ✦`);
}

function renderState() {
  stage.dataset.behavior = companion.state;
  stage.dataset.mood = companion.mood;
  stage.dataset.variant = companion.variant.id;
  const motionScale = companion.mood === 'low' ? Math.max(1, companion.variant.motionScale) : companion.variant.motionScale;
  stage.style.setProperty('--fin-duration', `${({ good: 2.8, okay: 4.2, low: 6.8 })[companion.mood] * motionScale}s`);
  stage.style.setProperty('--breath-duration', `${({ good: 4.5, okay: 5.8, low: 7.5 })[companion.mood] * motionScale}s`);
  for (const state of ['drowsy', 'sleeping', 'waking']) stage.classList.toggle(`is-${state}`, companion.state === state);
  window.TideLive2D?.setSleeping(companion.state === 'sleeping');
  if (!permitsSmallMotion()) resetSmallMotion();
  updateLabels();
  updateStarfield();
}

function applyState(value) {
  const state = value?.state || value || {};
  const settings = state.settings || {};
  starBalance = walletBalance(state.starWallet);
  const nextName = typeof settings.name === 'string' && settings.name.trim() ? settings.name.trim().slice(0, 40) : '鲨鲨';
  const renamed = nextName !== name;
  name = nextName;
  const changedSkin = activeSkin !== visibleSkinId(settings.activeSkin);
  if (changedSkin) finDrag.cancel();
  activeSkin = visibleSkinId(settings.activeSkin);
  companion.setVariant(activeSkin, Date.now());
  applySharkPalette(document.querySelector('#builtin-pet svg'), activeSkin);
  moodRecords = state.dailyMoods || [];
  companion.setMood(moodFromDailyRecords(moodRecords), Date.now());
  document.documentElement.classList.toggle('reduced-motion', Boolean(settings.reducedMotion));
  document.documentElement.dataset.mode = settings.mode === 'ftm' ? 'ftm' : 'mtf';
  renderState();
  window.TideLive2D?.switchSkin(settings);
  if (!initialized || renamed) say(renamed && initialized ? `嗯，以后叫我${name}。` : `嗨，我是${name}。`);
  else if (changedSkin && isBuiltinShark(activeSkin)) say(companion.line('greeting', Date.now()).message);
  initialized = true;
}

function showControls(duration = 2300) {
  clearTimeout(controlsTimer);
  stage.classList.add('controls-visible');
  controlsTimer = setTimeout(() => { if (!document.querySelector('.pet-controls button:focus-visible')) stage.classList.remove('controls-visible'); }, duration);
}

function clearGesture() {
  clearTimeout(actionTimer);
  stage.classList.remove(...gestureClasses);
  activeGesture = ''; queuedGesture = null;
}

function animate(action, interactive = false) {
  // The actual Live2D model supplies its idle motions; imported models keep their own rig.
  if (window.TideLive2D?.active && !interactive) return;
  if (finDrag.active || (!interactive && (contact || stage.classList.contains('is-enjoying-touch')))) return;
  // A hand reaching over takes priority over a longer idle flourish.
  if (interactive && IDLE_ACTIONS.includes(activeGesture)) clearGesture();
  if (interactive && ['pat', 'stroke', 'nuzzle'].includes(action)) {
    // Holding this relaxed pose uses a transition, so repeated touch extends the
    // same soft expression rather than snapping the eyelids back to frame zero.
    clearTimeout(touchRelaxTimer);
    stage.classList.add('is-enjoying-touch');
    touchRelaxTimer = setTimeout(() => stage.classList.remove('is-enjoying-touch'), 1900);
  }
  if (activeGesture) {
    // Finish the current movement in place; coalesce a burst to the latest
    // different gesture, never accumulating a long queue of delayed reactions.
    if (interactive) queuedGesture = action === activeGesture ? null : { action, interactive };
    return;
  }
  activeGesture = action;
  stage.classList.add(`action-${action}`);
  actionTimer = setTimeout(() => {
    stage.classList.remove(`action-${action}`);
    activeGesture = '';
    const next = queuedGesture; queuedGesture = null;
    if (next) animate(next.action, next.interactive);
  }, IDLE_DURATIONS[action] || (action === 'star-eat' ? 2800 : action === 'star-produce' ? 3200 : action === 'stretch' ? 1900 : action === 'pat' ? 1650 : 1400));
  if (!interactive || action === 'blink') return;
  clearTimeout(sparkleTimer);
  sparkles.replaceChildren();
  // Feeding has a tiny visual reward; touch is expressed by the pose itself.
  const amount = action === 'feed' ? 3 : 0;
  for (let index = 0; index < amount; index += 1) { const spark = document.createElement('span'); spark.className = 'spark'; spark.textContent = '✦'; sparkles.append(spark); }
  sparkleTimer = setTimeout(() => sparkles.replaceChildren(), 1500);
  if (!action.startsWith('star-')) window.TideLive2D?.interact(action === 'feed' ? 'feed' : 'pet');
}

function processEffects(effects, interactive = false) {
  for (const effect of effects) {
    if (effect.type === 'state') {
      clearGesture();
      clearTimeout(touchRelaxTimer);
      stage.classList.remove('is-enjoying-touch');
      renderState();
    } else if (effect.type === 'speech') say(effect.message);
    else if (effect.type === 'action') animate(effect.action, interactive);
  }
  renderState();
}

function showAction(action, message, localGesture = action) {
  if(action==='feed'){showWallet();return;}
  if (action === 'reminder') { say(message || '有一条用药提醒，打开手账查看吧。', 20000, true); return; }
  if (finDrag.active) return;
  const allowed = ['pet', 'pat', 'feed', 'sleep', 'wake', 'nuzzle', 'mood-good', 'mood-okay', 'mood-low'];
  if (!allowed.includes(action)) return;
  processEffects(companion.interact(localGesture === 'pat' ? 'pet' : localGesture, Date.now()), true);
}

async function act(action, gesture = action) {
  lastReceivedAction = action; lastReceivedAt = Date.now();
  showAction(action, undefined, gesture); showControls();
  try { await api?.petAction?.(action); } catch { /* Local interaction remains available. */ }
}

function openDashboard() {
  if (api?.openDashboard) Promise.resolve(api.openDashboard()).catch(() => say('手账暂时没有打开，请从托盘再试一次。'));
  else window.location.href = 'index.html';
}

function setDashboardVisibility(visible) {
  const label = visible ? '收起手账' : '打开手账';
  dashboardButton.title = label;
  dashboardButton.setAttribute('aria-label', label);
  dashboardButton.setAttribute('aria-expanded', String(Boolean(visible)));
}

function toggleDashboard() {
  if (api?.toggleDashboard) Promise.resolve(api.toggleDashboard()).then(setDashboardVisibility).catch(() => say('手账暂时没有响应，请从托盘再试一次。'));
  else openDashboard();
}

dashboardButton.addEventListener('click', toggleDashboard);
speechOpen.addEventListener('click', openDashboard);
document.getElementById('pat-pet').addEventListener('click', () => act('pet'));
document.getElementById('nuzzle-pet').addEventListener('click', () => act('nuzzle'));
document.getElementById('wallet-pet').addEventListener('click', showWallet);
sleepButton.addEventListener('click', () => act(['drowsy', 'sleeping'].includes(companion.state) ? 'wake' : 'sleep'));

touch.addEventListener('pointerdown', event => {
  if (event.button !== 0) return;
  clearTimeout(holdTimer);
  contact = { id: event.pointerId, x: event.clientX, y: event.clientY, distance: 0, fired: false, lastStrokeAt: 0 };
  touch.setPointerCapture(event.pointerId);
  holdTimer = setTimeout(() => {
    if (!contact || contact.fired || contact.distance > 12) return;
    contact.fired = true;
    swallowClickUntil = Date.now() + 1000;
    act('nuzzle');
  }, 550);
});
touch.addEventListener('pointermove', event => {
  if (!contact || contact.id !== event.pointerId || !(event.buttons & 1)) return;
  contact.distance += Math.hypot(event.clientX - contact.x, event.clientY - contact.y);
  contact.x = event.clientX; contact.y = event.clientY;
  if (contact.distance < 35 || Date.now() - contact.lastStrokeAt < 1300) return;
  clearTimeout(holdTimer);
  if (!contact.fired) act('pet', 'stroke');
  else animate('stroke');
  contact.fired = true; contact.distance = 0; contact.lastStrokeAt = Date.now();
  swallowClickUntil = Date.now() + 1000;
});
function releaseContact(event) {
  clearTimeout(holdTimer);
  if (contact?.fired) swallowClickUntil = Date.now() + 400;
  const pointerId = contact?.id ?? event?.pointerId;
  contact = null;
  if (pointerId !== undefined && touch.hasPointerCapture(pointerId)) touch.releasePointerCapture(pointerId);
}
touch.addEventListener('pointerup', releaseContact);
touch.addEventListener('pointercancel', releaseContact);
touch.addEventListener('lostpointercapture', releaseContact);
window.addEventListener('pointerup', releaseContact, true);
window.addEventListener('blur', releaseContact);
document.addEventListener('visibilitychange', () => { if (document.hidden) releaseContact(); });
touch.addEventListener('click', event => {
  if (Date.now() < swallowClickUntil) return;
  clearTimeout(clickTimer);
  if (event.detail === 0) act('pet');
  else clickTimer = setTimeout(() => act('pet'), 240);
});
touch.addEventListener('dblclick', () => { clearTimeout(clickTimer); if (Date.now() >= swallowClickUntil) openDashboard(); });
document.addEventListener('pointermove', event => {
  showControls();
  window.TideLive2D?.focus(event.clientX, event.clientY);
  lastPointerAt = Date.now();
  nextLookAt = lastPointerAt + 8500 + Math.random() * 10000;
  if (!permitsSmallMotion()) return;
  const bounds = touch.getBoundingClientRect();
  lookAt(Math.max(-3.1, Math.min(3.1, (event.clientX - bounds.left - bounds.width / 2) / 40)), Math.max(-1.9, Math.min(1.9, (event.clientY - bounds.top - bounds.height * .46) / 55)));
  gazeResetAt = lastPointerAt + 2000;
});
document.addEventListener('pointerleave', () => { showControls(700); lookAt(); });
document.addEventListener('visibilitychange', resetSmallMotion);
document.addEventListener('visibilitychange', updateStarfield);
motionPreference.addEventListener('change', resetSmallMotion);
motionPreference.addEventListener('change', updateStarfield);
document.addEventListener('focusin', () => showControls());
document.addEventListener('focusout', () => showControls());
document.addEventListener('keydown', event => { showControls(); if (event.key === 'Escape' && api?.hidePet) api.hidePet(); });
document.addEventListener('live2d-status', event => {
  const ready = event.detail.state === 'ready';
  document.getElementById('builtin-pet').hidden = ready;
  stage.classList.toggle('live2d-active', ready);
  if (event.detail.state === 'loading') say('正在准备新的外观……', 20000);
  if (ready) { resetSmallMotion(); window.TideLive2D?.setSleeping(companion.state === 'sleeping'); say('新外观准备好了。'); }
  if (event.detail.state === 'error') say(event.detail.message, 12000);
});
const heartbeat = setInterval(() => {
  const now = Date.now();
  const previousMood = companion.mood;
  companion.setMood(moodFromDailyRecords(moodRecords, now), now);
  if (previousMood !== companion.mood) renderState();
  processEffects(companion.tick(now, { hidden: document.hidden || finDrag.active || activeGesture.startsWith('star-') }));
  smallMotion(now);
}, 500);
api?.onState?.(applyState);
const stopVisualPublisher = publishCompanionVisual(stage, api, motionPreference, () => ({
  idleSince: companion.lastInteractionAt,
  idleEligible: companion.state === 'awake' && !document.hidden && !finDrag.active && !contact && !stage.classList.contains('is-star-feed-drag') && !activeGesture.startsWith('star-') && Date.now() - companion.lastInteractionAt >= 60000,
}));
const unsubscribeDashboard = api?.onDashboardVisibility?.(setDashboardVisibility);
if (api?.dashboardVisible) Promise.resolve(api.dashboardVisible()).then(setDashboardVisibility).catch(() => {});
api?.onPetAction?.(event => {
  const action = typeof event === 'string' ? event : event?.action;
  if (action === 'star-feed' || action === 'star-produced') { companionStarEvent(event); return; }
  if(action==='star-reward'){celebrateReward(event);return;}
  if (!action || (action === lastReceivedAction && Date.now() - lastReceivedAt < 700)) return;
  showAction(action, event?.message);
});
if (api?.loadState) Promise.resolve(api.loadState()).then(applyState).catch(() => applyState({ settings: {} }));
else applyState({ settings: {} });
window.addEventListener('beforeunload', () => {
  finDrag.dispose(); petInput.dispose(); starFeeding.dispose(); stopVisualPublisher();
  clearInterval(heartbeat);
  for (const timer of [speechTimer, actionTimer, sparkleTimer, clickTimer, controlsTimer, starTimer, holdTimer, blinkTimer, touchRelaxTimer]) clearTimeout(timer);
  unsubscribeDashboard?.();
  motionPreference.removeEventListener('change', resetSmallMotion);
  motionPreference.removeEventListener('change', updateStarfield);
  document.removeEventListener('visibilitychange', updateStarfield);
});
showControls();
