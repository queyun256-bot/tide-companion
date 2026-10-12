'use strict';

const BUILTIN_IDS = new Set(require('../assets/sharks/catalog.json').map(item => item.id));
const LEVEL_STEPS = Object.freeze([5, 8, 12, 18, 26, 36, 48, 62, 80]);
const MAX_EXPERIENCE = LEVEL_STEPS.reduce((sum, amount) => sum + amount, 0);

function growthFromFeeds(feeds) {
  const experience = Math.min(MAX_EXPERIENCE, Math.max(0, Math.floor(feeds)));
  let level = 1, intoLevel = experience;
  while (level < 10 && intoLevel >= LEVEL_STEPS[level - 1]) { intoLevel -= LEVEL_STEPS[level - 1]; level++; }
  return { experience, level, intoLevel, requiredForNext: level === 10 ? 0 : LEVEL_STEPS[level - 1], maxLevel: level === 10, dailyDropMax: level === 1 ? 0 : Math.min(10, level + 1) };
}
function deriveGrowth(wallet) {
  return growthFromFeeds((wallet?.entries || []).filter(entry => entry.kind === 'feed' && entry.amount === -1).length);
}
function chooseIdleAmount(level, random = Math.random) {
  if (!Number.isInteger(level) || level < 2 || level > 10) throw new Error('到达 2 级后会有偶尔捡到的星星。');
  const sample = random();
  if (!Number.isFinite(sample) || sample < 0 || sample >= 1) throw new Error('星星随机数无效。');
  const maximum = Math.min(10, level + 1), total = 2 * (1 - 2 ** -maximum);
  let target = sample * total;
  for (let amount = 1; amount <= maximum; amount++) {
    const weight = 2 ** -(amount - 1);
    if (target < weight || amount === maximum) return amount;
    target -= weight;
  }
}
function checkRequest(sharkId, now) {
  if (!BUILTIN_IDS.has(sharkId)) throw new Error('请选择一只内置鲨鱼。');
  if (!Number.isFinite(now) || !Number.isFinite(new Date(now).getTime())) throw new Error('互动时间无效。');
}
function ledger(previous) {
  // Loading the wallet helpers only when an operation is invoked keeps the
  // shared growth calculation usable by the wallet's validation pass.
  const helpers = require('./star-wallet.cjs');
  return { ...helpers, wallet: helpers.validateStarWallet(previous.starWallet) };
}
function feedStar(previous, { requestId, sharkId }, now = Date.now()) {
  checkRequest(sharkId, now);
  if (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(requestId)) throw new Error('喂食请求无效。');
  const { wallet, balance, localDay, validateStarWallet, MAX_ENTRIES } = ledger(previous);
  const id = `feed@${requestId}`, existing = wallet.entries.find(entry => entry.id === id);
  if (existing) return { wallet, growth: deriveGrowth(wallet), feed: existing, duplicate: true };
  if (balance(wallet) < 1) throw new Error('星星还不够，攒到一颗时再来吧。');
  if (wallet.entries.length >= MAX_ENTRIES) throw new Error('星星账本已满，暂时不能喂食。');
  const feed = { id, kind: 'feed', amount: -1, earnedAt: new Date(now).toISOString(), day: localDay(now), sharkId };
  const next = validateStarWallet({ version: 1, entries: [...wallet.entries, feed] });
  return { wallet: next, growth: deriveGrowth(next), feed, duplicate: false };
}
function claimIdleStars(previous, { sharkId }, now = Date.now(), random = Math.random) {
  checkRequest(sharkId, now);
  const { wallet, localDay, validateStarWallet, MAX_ENTRIES } = ledger(previous), day = localDay(now), id = `idle@${day}`;
  const growth = deriveGrowth(wallet), existing = wallet.entries.find(entry => entry.id === id);
  if (existing) return { wallet, growth, drop: existing, duplicate: true };
  if (growth.level < 2) throw new Error('到达 2 级后会有偶尔捡到的星星。');
  if (wallet.entries.length >= MAX_ENTRIES) throw new Error('星星账本已满，暂时不能收下星星。');
  const drop = { id, kind: 'idle', amount: chooseIdleAmount(growth.level, random), earnedAt: new Date(now).toISOString(), day, sharkId, level: growth.level };
  const next = validateStarWallet({ version: 1, entries: [...wallet.entries, drop] });
  return { wallet: next, growth, drop, duplicate: false };
}

module.exports = { LEVEL_STEPS, MAX_EXPERIENCE, growthFromFeeds, deriveGrowth, chooseIdleAmount, feedStar, claimIdleStars };
