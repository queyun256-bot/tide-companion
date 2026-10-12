import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { LEVEL_STEPS, MAX_EXPERIENCE, growthFromFeeds, deriveGrowth, chooseIdleAmount, feedStar, claimIdleStars } = require('../electron/pet-growth.cjs');
const { defaultState, validateState, createStateStore } = require('../electron/state.cjs');
const { validateStarWallet, mergeStarWallet, balance, localDay, rewardNewDoses } = require('../electron/star-wallet.cjs');
const now = new Date(2026, 9, 12, 12, 30).getTime(), iso = value => new Date(value).toISOString();
function funded(stars = 7) {
  const entries = []; let remaining = stars;
  while (remaining > 0) {
    const amount = Math.min(7, remaining), n = entries.length, planId = `fund-${n}`, earnedAt = iso(now - 60000 + n);
    const scheduledAt = iso(now - 120000 + n);
    entries.push({ id: `${planId}@${scheduledAt}`, planId, doseId: `dose-${n}`, scheduledAt, earnedAt, day: localDay(now), kind: amount === 1 ? 'regular' : 'long', amount, intervalHours: amount === 1 ? 24 : amount * 24, routeId: 'e2-oral', doseAmount: n + 1, doseAt: earnedAt });
    remaining -= amount;
  }
  return { ...defaultState(), starWallet: validateStarWallet({ version: 1, entries }) };
}
function feedTimes(state, count, { start = now, prefix = 'feed', sharkId = 'builtin' } = {}) {
  let result = state;
  for (let n = 0; n < count; n++) result = { ...result, starWallet: feedStar(result, { requestId: `${prefix}-${n}`, sharkId }, start + n).wallet };
  return result;
}
test('growth is shared, follows all nine thresholds, and is capped at level 10', () => {
  let experience = 0;
  assert.equal(MAX_EXPERIENCE, 295);
  assert.deepEqual(growthFromFeeds(0), { experience: 0, level: 1, intoLevel: 0, requiredForNext: 5, maxLevel: false, dailyDropMax: 0 });
  for (let n = 0; n < LEVEL_STEPS.length; n++) {
    experience += LEVEL_STEPS[n];
    assert.equal(growthFromFeeds(experience - 1).level, n + 1);
    assert.equal(growthFromFeeds(experience).level, n + 2);
    assert.equal(growthFromFeeds(experience).intoLevel, 0);
  }
  assert.deepEqual(growthFromFeeds(1000), { experience: 295, level: 10, intoLevel: 0, requiredForNext: 0, maxLevel: true, dailyDropMax: 10 });
  let state = feedTimes(funded(7), 4);
  const last = feedStar(state, { requestId: 'rose-feed', sharkId: 'builtin-rose' }, now + 5);
  assert.equal(last.growth.level, 2); assert.equal(last.growth.experience, 5);
});
test('feeding spends exactly one star and grants one XP once per request without modifying the prior snapshot', () => {
  const state = funded(7), original = JSON.stringify(state);
  const first = feedStar(state, { requestId: 'retry-safe', sharkId: 'builtin' }, now);
  assert.equal(balance(first.wallet), 6); assert.equal(first.growth.experience, 1);
  assert.equal(JSON.stringify(state), original);
  const second = feedStar({ ...state, starWallet: first.wallet }, { requestId: 'retry-safe', sharkId: 'builtin-rose' }, now + 100);
  assert.equal(second.duplicate, true); assert.deepEqual(second.wallet, first.wallet); assert.equal(second.feed.sharkId, 'builtin');
  assert.throws(() => feedStar(defaultState(), { requestId: 'no-money', sharkId: 'builtin' }, now), /星星还不够/);
  assert.throws(() => feedStar(state, { requestId: '../file', sharkId: 'builtin' }, now), /请求/);
  assert.throws(() => feedStar(state, { requestId: 'valid', sharkId: 'other-model' }, now), /内置/);
});
test('feeding after level 10 still consumes the star while XP stays capped', () => {
  const state = feedTimes(funded(301), 295);
  const result = feedStar(state, { requestId: 'full-level-snack', sharkId: 'builtin-lilac' }, now + 400);
  assert.equal(result.feed.amount, -1); assert.equal(balance(result.wallet), 5);
  assert.equal(result.growth.experience, 295); assert.equal(result.growth.level, 10);
});
test('geometric reward probabilities have exact decreasing bucket widths and bounded rare rewards', () => {
  for (let level = 2; level <= 10; level++) {
    const maximum = Math.min(10, level + 1), total = 2 * (1 - 2 ** -maximum);
    let cumulative = 0, previousWidth = Infinity;
    for (let amount = 1; amount <= maximum; amount++) {
      const width = 2 ** -(amount - 1) / total;
      assert.ok(width < previousWidth); previousWidth = width;
      assert.equal(chooseIdleAmount(level, () => cumulative + width / 2), amount);
      if (amount > 1) assert.equal(chooseIdleAmount(level, () => cumulative - 1e-12), amount - 1);
      assert.equal(chooseIdleAmount(level, () => cumulative + 1e-12), amount);
      cumulative += width;
    }
    assert.equal(chooseIdleAmount(level, () => 0), 1);
    assert.equal(chooseIdleAmount(level, () => 1 - Number.EPSILON), maximum);
  }
  for (const invalid of [-1, 1, Infinity, NaN]) assert.throws(() => chooseIdleAmount(2, () => invalid), /随机/);
  assert.throws(() => chooseIdleAmount(1), /2 级/);
});
test('all five skins share one natural-day drop, random is sampled once, and offline days are not backfilled', () => {
  let state = feedTimes(funded(7), 5), samples = 0;
  const first = claimIdleStars(state, { sharkId: 'builtin' }, now + 100, () => { samples++; return .99; });
  assert.equal(first.drop.amount, 3); assert.equal(balance(first.wallet), 5); assert.equal(first.drop.id, `idle@${localDay(now)}`);
  state = { ...state, starWallet: first.wallet };
  for (const sharkId of ['builtin-rose', 'builtin-mint', 'builtin-peach', 'builtin-lilac', 'builtin']) {
    const result = claimIdleStars(state, { sharkId }, now + 1000, () => { samples++; return .5; });
    assert.equal(result.duplicate, true); assert.deepEqual(result.wallet, first.wallet);
  }
  assert.equal(samples, 1);
  const next = claimIdleStars(state, { sharkId: 'builtin-peach' }, now + 30 * 86400000, () => 0);
  assert.equal(next.wallet.entries.filter(entry => entry.kind === 'idle').length, 2);
  assert.equal(next.drop.amount, 1); assert.equal(deriveGrowth(next.wallet).experience, 5, 'dropping stars never awards XP');
  assert.throws(() => claimIdleStars(funded(), { sharkId: 'builtin' }, now), /2 级/);
});
test('validation rejects negative balances, unpaid XP, fake reward levels and duplicate shared days', () => {
  const state = feedTimes(funded(7), 5), drop = claimIdleStars(state, { sharkId: 'builtin' }, now + 50, () => 0).drop;
  const feed = state.starWallet.entries.find(entry => entry.kind === 'feed');
  assert.throws(() => validateStarWallet({ version: 1, entries: [feed] }), /余额不足/);
  assert.throws(() => validateStarWallet({ version: 1, entries: [drop] }), /等级/);
  assert.throws(() => validateStarWallet({ version: 1, entries: [...state.starWallet.entries, { ...drop, level: 10, amount: 10 }] }), /等级/);
  for (const bad of [{ amount: 0 }, { amount: -2 }, { sharkId: 'fake' }, { day: '2026-02-30' }]) assert.throws(() => validateStarWallet({ version: 1, entries: [...funded().starWallet.entries, { ...feed, ...bad }] }), /星星/);
  const wallet = { version: 1, entries: [...state.starWallet.entries, drop] };
  assert.throws(() => validateStarWallet({ version: 1, entries: [...wallet.entries, { ...drop, sharkId: 'builtin-rose' }] }), /重复/);
  const normalized = validateState({ ...state, petGrowth: { experience: 99999, level: 10 } });
  assert.equal(normalized.petGrowth.experience, 5); assert.equal(normalized.petGrowth.level, 2);
});
test('old backup merge never refunds spent stars or duplicates XP, and divergent spends cannot overdraw', () => {
  const before = funded(7), local = feedTimes(before, 5);
  assert.deepEqual(mergeStarWallet(before.starWallet, local.starWallet), local.starWallet);
  const twice = mergeStarWallet(local.starWallet, local.starWallet);
  assert.equal(deriveGrowth(twice).experience, 5); assert.equal(balance(twice), 2);
  const fork = feedTimes(before, 5, { prefix: 'other', sharkId: 'builtin-mint' });
  const merged = mergeStarWallet(fork.starWallet, local.starWallet);
  assert.equal(balance(merged), 0); assert.equal(deriveGrowth(merged).experience, 7);
  assert.ok(local.starWallet.entries.every(entry => merged.entries.some(candidate => candidate.id === entry.id)), 'every local debit remains');
  assert.deepEqual(mergeStarWallet(fork.starWallet, merged), merged, 'repeated divergent backup is stable');
});
test('a newer complete backup restores its exact paid history and repeated restore does not spend again', () => {
  const old = feedTimes(funded(301), 5), newer = feedTimes(old, 296, { prefix: 'later', start: now + 1000 });
  const merged = mergeStarWallet(newer.starWallet, old.starWallet);
  assert.deepEqual(merged, newer.starWallet); assert.equal(balance(merged), 0); assert.equal(deriveGrowth(merged).experience, 295);
  assert.deepEqual(mergeStarWallet(newer.starWallet, merged), merged);
});
test('backup restoring a same-day drop keeps the local claim and cannot collect from another shark', () => {
  const common = feedTimes(funded(7), 5);
  const local = claimIdleStars(common, { sharkId: 'builtin' }, now + 30, () => 0).wallet;
  const imported = claimIdleStars(common, { sharkId: 'builtin-rose' }, now + 30, () => .99).wallet;
  const merged = mergeStarWallet(imported, local);
  assert.deepEqual(merged, local);
  const repeated = claimIdleStars({ ...common, starWallet: merged }, { sharkId: 'builtin-lilac' }, now + 60, () => .99);
  assert.equal(repeated.duplicate, true); assert.equal(repeated.drop.amount, 1);
});
test('state save and restart preserve the deduction and derived shared growth together; old state preserves funds', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-growth-test-'));
  try {
    const old = funded(7); delete old.petGrowth;
    fs.writeFileSync(path.join(directory, 'state.json'), JSON.stringify(old));
    const store = createStateStore(directory), loaded = store.load();
    assert.equal(balance(loaded.state.starWallet), 7); assert.equal(loaded.state.petGrowth.level, 1);
    const next = feedStar(loaded.state, { requestId: 'persisted-once', sharkId: 'builtin' }, now);
    store.save({ ...loaded.state, starWallet: next.wallet });
    const restarted = createStateStore(directory).load().state;
    assert.equal(balance(restarted.starWallet), 6); assert.equal(restarted.petGrowth.experience, 1);
    const replay = feedStar(restarted, { requestId: 'persisted-once', sharkId: 'builtin' }, now + 1);
    assert.equal(replay.duplicate, true); assert.equal(replay.growth.experience, 1);
  } finally {
    assert.equal(path.dirname(directory), os.tmpdir()); assert.match(path.basename(directory), /^tide-growth-test-/);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
test('pet debit and idle records never interfere with prescription fingerprints or regular daily caps', () => {
  const state = feedTimes(funded(7), 5), idle = claimIdleStars(state, { sharkId: 'builtin' }, now + 20, () => 0);
  const scheduledAt = iso(now + 60000), record = { id: `new-plan@${scheduledAt}`, planId: 'new-plan', scheduledAt, at: scheduledAt, status: 'notified', routeId: 'cpa-oral', amount: 12.5, intervalHours: 24 };
  const before = { ...state, starWallet: idle.wallet, reminderLog: [record] };
  const dose = { id: 'new-cpa', planId: 'new-plan', routeId: 'cpa-oral', amount: 12.5, at: iso(now + 70000) };
  const result = rewardNewDoses(before, { ...before, doses: [dose] }, now + 70000);
  assert.equal(result.rewards.length, 1); assert.equal(result.rewards[0].kind, 'regular');
  assert.equal(balance(result.wallet), balance(idle.wallet) + 1); assert.equal(deriveGrowth(result.wallet).experience, 5);
});
