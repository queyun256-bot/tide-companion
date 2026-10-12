'use strict';
const { performance } = require('node:perf_hooks');
const { feedStar, claimIdleStars, deriveGrowth } = require('./pet-growth.cjs');
const { balance, localDay } = require('./star-wallet.cjs');
const { isBuiltinShark } = require('./skins.cjs');

// The renderer describes interaction, but the main process owns transactions,
// expiry, the continuously visible idle interval and the one-per-day receipt.
function setupPetGrowthDesktop({ ipcMain, trustedSender, getState, persist, getPet, getDashboard, broadcast, desktopPet, now = Date.now, clock = () => performance.now(), random = Math.random, schedule = setInterval, unschedule = clearInterval }) {
  let session = null, due = null, idleKey = null, lastTick = null, suspended = false;
  const attached = new WeakSet();
  const visible = window => Boolean(window && !window.isDestroyed() && window.isVisible() && !window.isMinimized());
  const validToken = token => typeof token === 'string' && /^[a-f0-9-]{36}$/.test(token);
  const skin = () => isBuiltinShark(getState().settings.activeSkin) ? getState().settings.activeSkin : 'builtin';
  function verify(event) {
    if (!trustedSender(event)) throw new Error('此页面无权进行桌宠互动。');
    if (![getDashboard()?.webContents, getPet()?.webContents].includes(event.sender)) throw new Error('未知互动窗口。');
  }
  function resetIdle() { due = null; idleKey = null; }
  function cancelFeed(reason = 'cancelled', token) {
    if (!session || token && session.token !== token) return false;
    const previous = session; session = null;
    broadcast('pet:star-feed-session', { token: previous.token, active: false, reason });
    // Force a safe native default, even if the renderer lost dragend/crashed.
    const pet = getPet();
    if (pet && !pet.isDestroyed()) pet.setIgnoreMouseEvents(true, { forward: true });
    return true;
  }
  ipcMain.handle('pet:star-feed-begin', (event, input) => {
    verify(event);
    if (event.sender !== getDashboard()?.webContents || !visible(getDashboard()) || !validToken(input?.token)) throw new Error('请从手账拖出一颗星星。');
    if (balance(getState().starWallet) < 1) throw new Error('星星还不够，攒到一颗时再来吧。');
    if (session?.token === input.token) return { token: session.token };
    if (getState().starWallet.entries.some(entry => entry.id === `feed@${input.token}`)) throw new Error('这颗星星已经吃掉啦。');
    cancelFeed('superseded'); desktopPet.cancelDrag(); resetIdle();
    session = { token: input.token, owner: event.sender, startedAt: clock() };
    const pet = getPet();
    if (visible(pet)) pet.setIgnoreMouseEvents(false);
    broadcast('pet:star-feed-session', { token: session.token, active: true });
    return { token: session.token };
  });
  ipcMain.handle('pet:star-feed-commit', (event, input) => {
    verify(event);
    if (!validToken(input?.token)) throw new Error('这次拖动已经结束。');
    const previous = getState();
    const receipt = previous.starWallet.entries.find(entry => entry.id === `feed@${input.token}`);
    if (receipt) return { ok: true, duplicate: true, balance: balance(previous.starWallet), growth: deriveGrowth(previous.starWallet) };
    if (!session || session.token !== input.token || clock() - session.startedAt >= 30000) { cancelFeed('expired', input.token); throw new Error('这次拖动已经结束，再拖一颗试试。'); }
    const target = event.sender === getPet()?.webContents ? getPet() : getDashboard();
    if (!visible(target)) { cancelFeed('hidden', input.token); throw new Error('请把星星放到画面中的鲨鱼身上。'); }
    let result;
    // Synchronous save precedes both animation and reply; no parallel IPC can
    // spend the same last star or turn a failed save into experience.
    try {
      result = feedStar(previous, { requestId: input.token, sharkId: skin() }, now());
      persist({ ...previous, starWallet: result.wallet });
    }
    catch (error) { cancelFeed('save-failed', input.token); throw error; }
    cancelFeed('fed', input.token); resetIdle();
    const levelUp = result.growth.level > deriveGrowth(previous.starWallet).level;
    broadcast('pet:action', { action: 'star-feed', id: result.feed.id, at: result.feed.earnedAt, amount: 1, balance: balance(result.wallet), growth: result.growth, levelUp });
    return { ok: true, balance: balance(result.wallet), growth: result.growth, levelUp };
  });
  ipcMain.handle('pet:star-feed-cancel', (event, input) => { verify(event); return validToken(input?.token) && cancelFeed('cancelled', input.token); });

  function tick() {
    const monotonic = clock(), time = now();
    if (lastTick !== null && (monotonic - lastTick > 5000 || monotonic < lastTick)) resetIdle();
    lastTick = monotonic;
    if (session && (monotonic - session.startedAt >= 30000 || session.owner.isDestroyed() || !visible(getDashboard()))) cancelFeed('expired');
    const state = getState(), visual = desktopPet.getVisual?.(), day = localDay(time);
    const eligible = !suspended && !session && visible(getPet()) && !desktopPet.isDragging() &&
      visual?.idleEligible === true && visual.behavior === 'awake' && !visual.hidden && !visual.live2d &&
      Number.isFinite(visual.at) && Math.abs(time - visual.at) <= 2500 && Number.isFinite(visual.idleSince) && time - visual.idleSince >= 60000 &&
      deriveGrowth(state.starWallet).level >= 2 && !state.starWallet.entries.some(entry => entry.id === `idle@${day}`);
    if (!eligible) { resetIdle(); return; }
    const key = `${day}:${visual.idleSince}`;
    if (key !== idleKey) { idleKey = key; due = monotonic + 30000 + random() * 60000; }
    if (monotonic < due) return;
    try {
      const result = claimIdleStars(state, { sharkId: skin() }, time, random);
      if (!result.duplicate) {
        persist({ ...state, starWallet: result.wallet });
        broadcast('pet:action', { action: 'star-produced', id: result.drop.id, at: result.drop.earnedAt, amount: result.drop.amount, balance: balance(result.wallet), growth: result.growth });
      }
      resetIdle();
    } catch { due = monotonic + 60000; /* Failed storage leaves the daily receipt unclaimed. */ }
  }
  const timer = schedule(tick, 1000); timer?.unref?.();
  function attachWindow(window) {
    if (!window || attached.has(window)) return;
    attached.add(window);
    const stop = () => { cancelFeed('window-unavailable'); resetIdle(); };
    for (const event of ['hide', 'closed']) window.on(event, stop);
    for (const event of ['render-process-gone', 'did-start-navigation']) window.webContents.on(event, stop);
  }
  return { tick, cancelFeed, attachWindow, isFeeding: () => Boolean(session), setSuspended(value) { suspended = Boolean(value); resetIdle(); if (suspended) cancelFeed('suspended'); }, dispose() { cancelFeed('shutdown'); unschedule(timer); } };
}
module.exports = { setupPetGrowthDesktop };
