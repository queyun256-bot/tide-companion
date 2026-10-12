'use strict';

const ROUTES = new Set(require('../src/medication-catalog.json').items.map(item => item.id));
const BUILTIN_IDS = new Set(require('../assets/sharks/catalog.json').map(item => item.id));
const { growthFromFeeds } = require('./pet-growth.cjs');
const REWARD_WINDOW_MS = 2 * 60 * 60 * 1000;
const MAX_ENTRIES = 20000;
const REGULAR_DAILY_LIMIT = 2;
const localDay = value => {
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};
const emptyStarWallet = () => ({ version: 1, entries: [] });
const balance = wallet => (wallet?.entries || []).reduce((sum, entry) => sum + entry.amount, 0);
const medicationEntry = entry => entry.kind === 'regular' || entry.kind === 'long';
const doseFingerprint = ({routeId,amount,at,durationHours}) => `${routeId}|${amount}|${Math.floor(Date.parse(at)/60000)}|${durationHours ?? ''}`;
const entryFingerprint = entry => doseFingerprint({routeId:entry.routeId,amount:entry.doseAmount,at:entry.doseAt,durationHours:entry.durationHours});
const fail = label => { throw new Error(`数据格式不正确：星星${label}`); };
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
const numeric = (value, min, max) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
function iso(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) fail('时间');
  return new Date(value).toISOString();
}
function validDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year,month,day] = value.split('-').map(Number);
  const date = new Date(0); date.setUTCFullYear(year, month - 1, day); date.setUTCHours(12, 0, 0, 0);
  return year >= 1 && date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day;
}

function validateStarWallet(value) {
  if (value === undefined) return emptyStarWallet();
  if (!plain(value) || value.version !== 1 || !Array.isArray(value.entries) || value.entries.length > MAX_ENTRIES) fail('账本');
  const ids = new Set(), doses = new Set(), fingerprints = new Set(), regularDays = new Map();
  const entries = value.entries.map(item => {
    if (!plain(item)) fail('记录');
    if (item.kind === 'feed' || item.kind === 'idle') {
      if (typeof item.id !== 'string' || ids.has(item.id)) fail('记录重复或标识无效');
      const earnedAt = iso(item.earnedAt);
      if (!validDay(item.day) || Math.abs(Date.parse(`${item.day}T12:00:00.000Z`) - Date.parse(earnedAt)) > 36 * 3600000 || !BUILTIN_IDS.has(item.sharkId)) fail('互动日期或鲨鱼');
      const entry = { id: item.id, kind: item.kind, amount: item.amount, earnedAt, day: item.day, sharkId: item.sharkId };
      if (item.kind === 'feed') {
        if (!/^feed@[a-zA-Z0-9_-]{1,100}$/.test(item.id) || item.amount !== -1) fail('喂食消费');
      } else {
        if (item.id !== `idle@${item.day}` || !Number.isInteger(item.level) || item.level < 2 || item.level > 10 || !Number.isInteger(item.amount) || item.amount < 1 || item.amount > Math.min(10, item.level + 1)) fail('待机奖励');
        entry.level = item.level;
      }
      ids.add(item.id);
      return entry;
    }
    if (!plain(item) || !validId(item.doseId) || !validId(item.planId)) fail('记录');
    const scheduledAt = iso(item.scheduledAt), earnedAt = iso(item.earnedAt), doseAt = iso(item.doseAt);
    if (item.id !== `${item.planId}@${scheduledAt}` || ids.has(item.id) || doses.has(item.doseId)) fail('记录重复或标识无效');
    if (!validDay(item.day) || !numeric(item.intervalHours, .25, 8760)) fail('日期或提醒间隔');
    const kind = item.intervalHours >= 48 ? 'long' : 'regular';
    const amount = kind === 'long' ? Math.min(7, Math.floor(item.intervalHours / 24)) : 1;
    if (item.kind !== kind || item.amount !== amount || !ROUTES.has(item.routeId) || !numeric(item.doseAmount, .000001, 100000)) fail('奖励参数');
    const earned = Date.parse(earnedAt), scheduled = Date.parse(scheduledAt);
    if (earned < scheduled || earned > scheduled + REWARD_WINDOW_MS) fail('获得时间');
    if (Date.parse(doseAt) < Math.floor(scheduled/60000)*60000 || Date.parse(doseAt) > earned) fail('实际使用时间');
    // Persist the civil day at earning time; changing timezone must not rewrite it.
    // Civil zones are bounded by UTC-12..UTC+14, with historical date-line changes.
    const dayStamp = Date.parse(`${item.day}T12:00:00.000Z`);
    if (Math.abs(dayStamp - earned) > 36 * 3600000) fail('获得日期');
    if (kind === 'regular') {
      regularDays.set(item.day, (regularDays.get(item.day) || 0) + amount);
      if (regularDays.get(item.day) > REGULAR_DAILY_LIMIT) fail('当日普通奖励超过上限');
    }
    ids.add(item.id); doses.add(item.doseId);
    const entry = {id:item.id,doseId:item.doseId,planId:item.planId,scheduledAt,earnedAt,day:item.day,kind,amount,intervalHours:item.intervalHours,routeId:item.routeId,doseAmount:item.doseAmount,doseAt};
    if (item.durationHours !== undefined) {
      if (!numeric(item.durationHours, .01, 8760)) fail('佩戴时长');
      entry.durationHours = item.durationHours;
    }
    const fingerprint = entryFingerprint(entry);
    if (fingerprints.has(fingerprint)) fail('同一次实际使用重复');
    fingerprints.add(fingerprint);
    return entry;
  });
  // Replay receipts in earning order. Imported experience cannot exist without
  // paid feeds, and neither a feed nor an idle reward can borrow future stars.
  let available = 0, feeds = 0;
  for (const entry of [...entries].sort((a,b) => Date.parse(a.earnedAt) - Date.parse(b.earnedAt))) {
    if (entry.kind === 'idle' && entry.level > growthFromFeeds(feeds).level) fail('待机奖励等级');
    available += entry.amount;
    if (available < 0) fail('余额不足');
    if (entry.kind === 'feed') feeds++;
  }
  return {version:1,entries};
}

const sameNumber = (a,b) => typeof a === 'number' && typeof b === 'number' && Math.abs(a-b) <= Math.max(1,Math.abs(a),Math.abs(b))*1e-10;
const sameDuration = (a,b) => a === undefined && b === undefined || sameNumber(a,b);
function matchingReceipt(dose, reminders, now) {
  const at = Date.parse(dose.at);
  if (!Number.isFinite(at) || at > now) return null;
  const eligible = reminders.filter(receipt => {
    const scheduled = Date.parse(receipt.scheduledAt), notified = Date.parse(receipt.at);
    if (receipt.status !== 'notified' || !Number.isFinite(scheduled) || !Number.isFinite(notified) || notified > now || notified < scheduled) return false;
    if (receipt.id !== `${receipt.planId}@${receipt.scheduledAt}` || !ROUTES.has(receipt.routeId) || !numeric(receipt.intervalHours,.25,8760)) return false;
    if (dose.planId && dose.planId !== receipt.planId) return false;
    // The record editor intentionally has minute precision; a reminder at 09:00:30
    // can match an honestly entered 09:00, but never 08:59 or a future record.
    if (now < scheduled || now > scheduled + REWARD_WINDOW_MS || at < Math.floor(scheduled / 60000) * 60000 || at > scheduled + REWARD_WINDOW_MS) return false;
    return dose.routeId === receipt.routeId && sameNumber(dose.amount,receipt.amount) && sameDuration(dose.durationHours,receipt.durationHours);
  }).sort((a,b) => Date.parse(b.scheduledAt)-Date.parse(a.scheduledAt));
  // Two indistinguishable latest reminders need an explicit planId; do not guess
  // or fall back to an older occurrence after the latest one has already earned.
  if (!eligible.length || eligible[1]?.scheduledAt === eligible[0].scheduledAt) return null;
  return eligible[0];
}

/** Only main-process newly-created actual doses enter this path, before one atomic save. */
function rewardNewDoses(previous, incoming, now = Date.now()) {
  if (!Number.isFinite(now)) throw new TypeError('Invalid reward time');
  const wallet = validateStarWallet(previous.starWallet);
  const entries = [...wallet.entries], rewards = [];
  const priorIds = new Set(previous.doses.map(dose => dose.id));
  const priorRewards = entries.filter(medicationEntry);
  const claimed = new Set(entries.map(entry => entry.id)), rewardedDoses = new Set(priorRewards.map(entry => entry.doseId));
  const fingerprints = new Set([...priorRewards.map(entryFingerprint),...previous.doses.map(doseFingerprint)]);
  const day = localDay(now);
  let regular = entries.filter(entry => entry.day === day && entry.kind === 'regular').reduce((sum,entry) => sum + entry.amount, 0);
  for (const dose of incoming.doses) {
    // Currency capacity must never prevent an actual medication record being saved.
    if (entries.length >= MAX_ENTRIES) break;
    const fingerprint = doseFingerprint(dose);
    if (priorIds.has(dose.id) || rewardedDoses.has(dose.id) || fingerprints.has(fingerprint)) continue;
    const receipt = matchingReceipt(dose, previous.reminderLog || [], now);
    if (!receipt || claimed.has(receipt.id)) continue;
    const kind = receipt.intervalHours >= 48 ? 'long' : 'regular';
    if (kind === 'regular' && regular >= REGULAR_DAILY_LIMIT) continue;
    const amount = kind === 'long' ? Math.min(7,Math.floor(receipt.intervalHours / 24)) : 1;
    const entry = {id:receipt.id,doseId:dose.id,planId:receipt.planId,scheduledAt:receipt.scheduledAt,earnedAt:new Date(now).toISOString(),day,kind,amount,intervalHours:receipt.intervalHours,routeId:receipt.routeId,doseAmount:receipt.amount,doseAt:dose.at};
    if (receipt.durationHours !== undefined) entry.durationHours = receipt.durationHours;
    entries.push(entry);rewards.push(entry);claimed.add(entry.id);rewardedDoses.add(dose.id);fingerprints.add(fingerprint);
    if (kind === 'regular') regular += amount;
  }
  return {wallet:validateStarWallet({version:1,entries}),rewards};
}

/** Preserve local receipts first; importing an older backup never resets earned currency. */
function mergeStarWallet(imported, local) {
  const existing = validateStarWallet(local).entries;
  const restored = validateStarWallet(imported).entries;
  // A normal newer backup already contains every local receipt. Restore that
  // validated history in one pass, instead of replay-validating each feed.
  const restoredById = new Map(restored.map(entry => [entry.id, entry]));
  if (existing.every(entry => JSON.stringify(restoredById.get(entry.id)) === JSON.stringify(entry))) return { version: 1, entries: restored };
  const entries = [...existing], ids = new Set(entries.map(entry => entry.id)), doses = new Set(entries.filter(medicationEntry).map(entry => entry.doseId));
  const fingerprints = new Set(entries.filter(medicationEntry).map(entryFingerprint));
  const regularDays = new Map();
  for (const entry of entries) if (entry.kind === 'regular') regularDays.set(entry.day,(regularDays.get(entry.day)||0)+entry.amount);
  for (const entry of [...restored].sort((a,b)=>Date.parse(a.earnedAt)-Date.parse(b.earnedAt))) {
    if (ids.has(entry.id)) continue;
    if (!medicationEntry(entry)) {
      // A divergent backup may have spent the same original stars elsewhere.
      // Keep every local debit; import only extra transactions that remain solvent.
      if (entries.length >= MAX_ENTRIES) fail('账本');
      try { validateStarWallet({version:1,entries:[...entries,entry]}); }
      catch { continue; }
      entries.push(entry); ids.add(entry.id); continue;
    }
    const fingerprint = entryFingerprint(entry);
    if (ids.has(entry.id) || doses.has(entry.doseId) || fingerprints.has(fingerprint)) continue;
    if (entry.kind === 'regular' && (regularDays.get(entry.day)||0) >= REGULAR_DAILY_LIMIT) continue;
    entries.push(entry);ids.add(entry.id);doses.add(entry.doseId);fingerprints.add(fingerprint);
    if (entry.kind === 'regular') regularDays.set(entry.day,(regularDays.get(entry.day)||0)+entry.amount);
  }
  return validateStarWallet({version:1,entries});
}

module.exports = {emptyStarWallet,validateStarWallet,rewardNewDoses,mergeStarWallet,balance,localDay,REWARD_WINDOW_MS,REGULAR_DAILY_LIMIT,MAX_ENTRIES};
