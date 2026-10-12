import test from 'node:test';
import assert from 'node:assert/strict';
import { PetBehavior, moodFromDailyRecords, PROFILES, IDLE_ACTIONS } from '../src/pet-behavior.js';

test('companion mood uses the local calendar day and resets at midnight, never a rolling 24 hours', () => {
  const beforeMidnight = new Date(2026, 9, 12, 23, 59, 59).getTime();
  const records = [{ date: '2026-10-12', mood: 'low', at: new Date(beforeMidnight - 1000).toISOString() }];
  assert.equal(moodFromDailyRecords(records, beforeMidnight), 'low');
  assert.equal(moodFromDailyRecords(records, beforeMidnight + 1000), 'okay');
  assert.equal(moodFromDailyRecords([], beforeMidnight), 'okay');
  assert.equal(moodFromDailyRecords(null, beforeMidnight), 'okay');
});

test('companion reads the first valid daily report and ignores future, invalid and interaction entries', () => {
  const now = new Date(2026, 9, 12, 13).getTime();
  const today = '2026-10-12';
  const records = [
    { date: today, mood: 'low', at: new Date(now + 1000).toISOString() },
    { date: today, mood: 'feed', at: new Date(now - 1000).toISOString() },
    { date: today, mood: 'good', at: 'invalid' },
    { action: 'mood-good', at: new Date(now).toISOString() }
  ];
  assert.equal(moodFromDailyRecords(records, now), 'okay');
  records.push({ date: today, mood: 'good', at: new Date(now - 1000).toISOString() });
  records.push({ date: today, mood: 'low', at: new Date(now - 2000).toISOString() });
  assert.equal(moodFromDailyRecords(records, now), 'low');
  assert.equal(moodFromDailyRecords(records, NaN), 'okay');
});

test('a saved diary date stays authoritative after a time-zone change', () => {
  const now = new Date(2026, 9, 12, 18).getTime();
  const records = [{ date: '2026-10-12', mood: 'good', at: new Date(2026, 9, 11, 23).toISOString() }];
  assert.equal(moodFromDailyRecords(records, now), 'good');
});

test('stored daily mood stays effective after ordinary interaction history rotates away', () => {
  const now = new Date(2026, 9, 12, 18).getTime();
  const records = [{ date: '2026-10-12', mood: 'good', at: new Date(2026, 9, 12, 8).toISOString() }];
  assert.equal(moodFromDailyRecords(records, now), 'good');
  assert.equal(moodFromDailyRecords([{ ...records[0], mood: 'okay' }], now), 'okay');
});

test('mood changes movement frequency and repertoire, while sleep onset is independent of mood', () => {
  const lively = new PetBehavior({ random: () => .5, now: 0 });
  const quiet = new PetBehavior({ random: () => .5, now: 0 });
  lively.setMood('good', 0); quiet.setMood('low', 0);
  assert.ok(lively.nextActionAt < quiet.nextActionAt);
  assert.ok(PROFILES.low.quietFor > PROFILES.good.quietFor);
  assert.ok(!PROFILES.low.actions.includes('wiggle'));
  assert.equal(lively.sleepAt, quiet.sleepAt);
  assert.notEqual(lively.interact('pet', 1).find(e => e.type === 'speech').message, quiet.interact('pet', 1).find(e => e.type === 'speech').message);
});

test('idle naps close the eyes gradually, sleep for a bounded random time, and wake gradually', () => {
  const pet = new PetBehavior({ random: () => .5, now: 0 });
  assert.ok(pet.sleepAt >= 150000 && pet.sleepAt <= 330000);
  pet.tick(pet.sleepAt);
  assert.equal(pet.state, 'drowsy');
  assert.ok(pet.transitionAt - pet.sleepAt >= 1800);
  pet.tick(pet.transitionAt - 1);
  assert.equal(pet.state, 'drowsy');
  pet.tick(pet.transitionAt);
  assert.equal(pet.state, 'sleeping');
  assert.ok(pet.wakeAt - pet.transitionAt >= 45000 && pet.wakeAt - pet.transitionAt <= 85000);
  pet.tick(pet.wakeAt);
  assert.equal(pet.state, 'waking');
  pet.tick(pet.transitionAt);
  assert.equal(pet.state, 'awake');
});

test('manual sleep and touching wake follow the same transition path and reset idle deadlines', () => {
  const pet = new PetBehavior({ random: () => .25, now: 0 });
  pet.interact('sleep', 1000);
  assert.equal(pet.state, 'drowsy');
  pet.tick(2800);
  assert.equal(pet.state, 'sleeping');
  const effects = pet.interact('nuzzle', 3000);
  assert.equal(pet.state, 'waking');
  assert.ok(effects.some(effect => effect.type === 'action' && effect.action === 'nuzzle'));
  assert.ok(pet.sleepAt > 153000);
  pet.tick(4200);
  assert.equal(pet.state, 'awake');
});

test('repeated gestures rotate their dialogue instead of echoing the same line', () => {
  const pet = new PetBehavior({ random: () => .1, now: 0 });
  const spoken = Array.from({ length: 16 }, (_, index) => pet.interact('pet', index * 13000).find(effect => effect.type === 'speech').message);
  assert.ok(new Set(spoken).size >= 5);
  for (let index = 1; index < spoken.length; index += 1) assert.notEqual(spoken[index], spoken[index - 1]);
});

test('legacy feeding cannot create any local currency or reward effect', () => {
  const pet = new PetBehavior({ random: () => .4, now: 0 });
  const effects = [1, 2, 3, 4].map(index => pet.interact('feed', index));
  assert.deepEqual(effects, [[],[],[],[]]);
  assert.equal(pet.stars, undefined);
});

test('background windows do not produce idle chatter or begin visible actions', () => {
  const pet = new PetBehavior({ random: () => .5, now: 0 });
  assert.deepEqual(pet.tick(999999, { hidden: true }), []);
  assert.equal(pet.state, 'awake');
  pet.tick(999999);
  assert.equal(pet.state, 'drowsy');
});

test('successive idle movements vary and never request moving the desktop window', () => {
  const pet = new PetBehavior({ random: () => .4, now: 0 });
  const first = pet.tick(pet.nextActionAt).find(effect => effect.type === 'action').action;
  const second = pet.tick(pet.nextActionAt).find(effect => effect.type === 'action').action;
  assert.notEqual(first, second);
  assert.ok(['nuzzle', 'tilt', 'blink', 'nod', 'stretch', 'wiggle', ...IDLE_ACTIONS].includes(first));
});

test('all companions can choose six new idle gestures, with no consecutive repeats and quieter low moods', () => {
  for (const variant of ['builtin', 'builtin-rose', 'builtin-mint', 'builtin-peach', 'builtin-lilac']) {
    let seed = 27;
    const pet = new PetBehavior({ variant, now: 0, random: () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296) });
    for (const action of IDLE_ACTIONS) assert.ok(pet.profile.actions.includes(action), `${variant}: ${action}`);
    const ordinaryMinimum = pet.profile.action[0];
    pet.setMood('low', 0); assert.ok(pet.profile.action[0] > ordinaryMinimum);
    assert.ok(!pet.profile.actions.includes('wiggle'));
    pet.sleepAt = Infinity;
    let previous = ''; const seen = new Set();
    for (let index = 0; index < 180; index++) {
      const effects = pet.tick(pet.nextActionAt), action = effects.find(effect => effect.type === 'action')?.action;
      assert.ok(action); assert.notEqual(action, previous); seen.add(action); previous = action;
    }
    for (const action of IDLE_ACTIONS) assert.ok(seen.has(action), `${variant} can pick ${action}`);
    pet.startSleep(pet.nextActionAt);
    assert.ok(!pet.tick(pet.transitionAt).some(effect => effect.type === 'action'));
  }
});

test('repeated touch keeps moving but allows silence; low mood replies less often', () => {
  for (const mood of ['good', 'okay', 'low']) {
    const pet = new PetBehavior({ random: () => .2, now: 0 });
    pet.setMood(mood, 0);
    assert.ok(pet.interact('pet', 0).some(effect => effect.type === 'speech'));
    const quietResponse = pet.interact('stroke', 3000);
    assert.ok(!quietResponse.some(effect => effect.type === 'speech'));
    assert.ok(quietResponse.some(effect => effect.type === 'action' && effect.action === 'stroke'));
    assert.equal(pet.interact('nuzzle', 13000).some(effect => effect.type === 'speech'), mood !== 'low');
    assert.ok(pet.interact('pet', 26000).some(effect => effect.type === 'speech'));
  }
});

test('waking from an idle nap is silent, while an explicit wake has a short response', () => {
  const pet = new PetBehavior({ random: () => .5, now: 0 });
  pet.startSleep(0);
  pet.tick(1800);
  assert.ok(!pet.tick(pet.wakeAt).some(effect => effect.type === 'speech'));
  pet.tick(pet.transitionAt);
  pet.startSleep(100000);
  assert.ok(pet.interact('wake', 100100).some(effect => effect.type === 'speech'));
});

test('touch and mood lines stay short and companion-like rather than narrating database acknowledgements', () => {
  for (const mood of ['good', 'okay', 'low']) {
    const pet = new PetBehavior({ random: () => .3, now: 0 });
    pet.setMood(mood, 0);
    for (const category of ['mood', 'pet', 'stroke', 'nuzzle']) {
      for (let index = 0; index < 8; index += 1) {
        const { message } = pet.line(category, index * 30000);
        assert.ok(message.length <= 20);
        assert.doesNotMatch(message, /记下|存好|这一笔|摸到了|血药|激素|治疗/);
      }
    }
  }
});
