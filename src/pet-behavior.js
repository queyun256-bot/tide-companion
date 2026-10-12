import { getBuiltinShark } from './shark-variants.js';
import { PERSONALITIES } from './shark-personalities.js';
export const IDLE_ACTIONS = Object.freeze(['wave', 'scarf', 'sway', 'peek', 'tailcurl', 'bob']);
export const IDLE_DURATIONS = Object.freeze({ wave: 2600, scarf: 2900, sway: 3400, peek: 3100, tailcurl: 2800, bob: 3000 });
const IDLE_PREFERENCES = Object.freeze({
  builtin: ['peek', 'wave'], 'builtin-rose': ['scarf', 'sway'],
  'builtin-mint': ['tailcurl', 'sway'], 'builtin-peach': ['wave', 'bob'],
  'builtin-lilac': ['peek', 'tailcurl'],
});
// Pure, clock-driven companion behavior. No medical inference, storage, or window movement.
export const PROFILES = Object.freeze({
  good: Object.freeze({ action: [7000, 14000], nap: [35000, 65000], quietFor: 180000, actions: ['nuzzle', 'tilt', 'nod', 'stretch', 'wiggle', 'blink'] }),
  okay: Object.freeze({ action: [12000, 22000], nap: [45000, 85000], quietFor: 240000, actions: ['blink', 'tilt', 'nod', 'nuzzle', 'stretch', 'blink'] }),
  low: Object.freeze({ action: [21000, 35000], nap: [50000, 90000], quietFor: 320000, actions: ['blink', 'nuzzle', 'blink', 'nod', 'tilt'] })
});
const WORDS = {
  good: {
    mood: ['嘿嘿，和你一起开心。', '小鳍摆起来啦。', '想蹭蹭你的手。'],
    pet: ['嘿嘿，有点痒。', '这边也软软的。', '唔，舒服。', '再来一下？', '脑袋借你摸一会儿。'],
    stroke: ['这样刚刚好。', '嗯，很舒服。', '慢一点，围巾要歪了。', '摸到尾巴了。'],
    nuzzle: ['挨一小会儿。', '蹭蹭，轻轻的。', '围巾分你一个小角。', '就这样靠着。'],
    feed: ['嗷呜，接住啦。', '亮晶晶的，谢谢你。', '这一颗亮亮的。', '藏进围巾里。'],
    idle: ['伸个懒腰。', '围巾有点歪了。', '窗外好像有动静。', '换个姿势。']
  },
  okay: {
    mood: ['嗯，就这样待一会儿。', '一起发会儿呆呀。', '围巾分你一个小角。'],
    pet: ['唔？是你呀。', '手心暖暖的。', '脑袋往这边靠靠。', '有点舒服。', '摸得想眯眼啦。'],
    stroke: ['嗯，这样就好。', '围巾也顺好了。', '慢慢摸吧。', '这边也可以。'],
    nuzzle: ['借个位置靠一下。', '轻轻碰一下。', '嗯，挨近一点。', '就靠一小会儿。'],
    feed: ['啊呜，谢谢你。', '小星星藏在这里。', '鼻尖也亮啦。', '暖乎乎的一颗。'],
    idle: ['伸个懒腰。', '整理一下围巾。', '在这儿待一会儿。', '有点想打盹。']
  },
  low: {
    mood: ['嗯，我在旁边。', '不说话也可以，靠一会儿。', '给你留个软软的位置。'],
    pet: ['唔。', '软软的，慢慢摸。', '在这儿呢。', '轻轻的。', '小鳍也靠过来。'],
    stroke: ['这样就好。', '嗯，很轻。', '慢慢摸吧。', '围巾顺好了。'],
    nuzzle: ['靠一下。', '轻轻蹭蹭。', '围巾这边还有空。', '嗯，待一会儿。'],
    feed: ['藏好这点亮光。', '谢谢这颗星星。', '放在小鳍旁边。', '轻轻接住啦。'],
    idle: ['换个姿势。', '伸一下小鳍。', '围巾整理好了。', '眯一会儿。']
  },
  shared: {
    reward: ['又攒下一点星光。', '这点亮光，替你收好了。', '小星星慢慢多起来了。', '把这一点光放在身边。'],
    sleep: ['先眯一会儿。', '有点困了。', '打个小盹。', '嗯，休息一下。'],
    wake: ['醒了。', '伸个懒腰。', '睡了个小觉。', '唔，几点了。'],
    touchWake: ['嗯？醒了。', '唔，是你呀。', '刚刚打了个盹。', '让我伸个懒腰。']
  }
};

export function moodFromDailyRecords(records, now = Date.now()) {
  const today = new Date(now);
  if (!Number.isFinite(today.getTime())) return 'okay';
  const localDay = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const date = localDay(today);
  let first = null;
  for (const entry of Array.isArray(records) ? records : []) {
    const time = Date.parse(entry?.at);
    // The saved diary date remains authoritative if the user changes time zone.
    if (entry?.date === date && Object.hasOwn(PROFILES, entry?.mood) && Number.isFinite(time) && time <= now && (!first || time < first.time)) first = { mood: entry.mood, time };
  }
  return first?.mood || 'okay';
}

export class PetBehavior {
  constructor({ random = Math.random, now = Date.now(), variant = 'builtin' } = {}) {
    this.random = random;
    this.mood = 'okay';
    this.variant = getBuiltinShark(variant);
    this.state = 'awake';
    this.lastInteractionAt = now;
    this.lastSpeechAt = now;
    this.lastGestureSpeechAt = -Infinity;
    this.lastAction = '';
    this.recentLines = [];
    this.scheduleAwake(now);
  }
  between(min, max) { return min + this.random() * (max - min); }
  get profile() {
    const mood = PROFILES[this.mood], variant = this.variant;
    const actions = [...(PERSONALITIES[variant.id]?.actions || mood.actions), ...IDLE_ACTIONS, ...(IDLE_PREFERENCES[variant.id] || [])];
    // A lively companion still settles down on a low day; it never bounces over it.
    return { action: mood.action.map(value => value * (this.mood === 'low' ? Math.max(1, variant.actionScale) : variant.actionScale)), nap: mood.nap.map(value => value * variant.napScale), quietFor: mood.quietFor * Math.max(this.mood === 'low' ? 1 : 0, variant.speechScale), actions: this.mood === 'low' ? actions.filter(action => action !== 'wiggle') : actions };
  }
  setVariant(id, now = Date.now()) {
    const variant = getBuiltinShark(id);
    if (variant.id === this.variant.id) return false;
    this.variant = variant;
    this.recentLines = [];
    this.lastAction = '';
    this.nextActionAt = now + this.between(...this.profile.action);
    return true;
  }
  scheduleAwake(now) {
    this.nextActionAt = now + this.between(...this.profile.action);
    // Mood changes companion energy, not assumptions about the user's need for sleep.
    this.sleepAt = now + this.between(150000, 330000);
  }
  setMood(mood, now) {
    if (!Object.hasOwn(PROFILES, mood) || mood === this.mood) return;
    this.mood = mood;
    this.nextActionAt = now + this.between(...this.profile.action);
  }
  line(category, now) {
    const personality = PERSONALITIES[this.variant.id]?.words;
    const bank = personality?.[this.mood]?.[category] || personality?.[category] || WORDS[this.mood][category] || WORDS.shared[category] || WORDS[this.mood].pet;
    let options = bank.filter(line => !this.recentLines.slice(-6).includes(line));
    if (!options.length) options = bank.filter(line => line !== this.recentLines.at(-1));
    const message = options[Math.floor(this.random() * options.length)] || bank[0];
    this.recentLines.push(message);
    this.recentLines = this.recentLines.slice(-10);
    this.lastSpeechAt = now;
    return { type: 'speech', message };
  }
  startSleep(now, manual = false) {
    if (this.state === 'drowsy' || this.state === 'sleeping') return [];
    this.state = 'drowsy';
    this.transitionAt = now + 1800;
    this.wakeAt = this.transitionAt + this.between(...this.profile.nap);
    return [{ type: 'state', state: this.state }, ...(manual ? [this.line('sleep', now)] : [])];
  }
  wake(now, touched = false, manual = false) {
    if (this.state === 'awake' || this.state === 'waking') return [];
    this.state = 'waking';
    this.transitionAt = now + 1200;
    this.lastInteractionAt = now;
    this.scheduleAwake(now);
    return [{ type: 'state', state: this.state }, ...(touched || manual ? [this.line(touched ? 'touchWake' : 'wake', now)] : [])];
  }
  interact(action, now) {
    // Wallet credits are earned and persisted by the main process only.
    if (action === 'feed') return [];
    this.lastInteractionAt = now;
    if (action === 'sleep') return this.startSleep(now, true);
    if (action === 'wake') return this.wake(now, false, true);
    const woke = this.state === 'drowsy' || this.state === 'sleeping';
    const effects = woke ? this.wake(now, true) : [];
    this.scheduleAwake(now);
    if (action.startsWith('mood-')) {
      this.setMood(action.slice(5), now);
      effects.push(this.line('mood', now));
      effects.push({ type: 'action', action: this.mood === 'good' ? 'wiggle' : 'nuzzle' });
      return effects;
    }
    if (!woke && now - this.lastGestureSpeechAt >= (this.mood === 'low' ? 24000 : 12000)) {
      // A short reply now and then leaves room for gestures to speak for themselves.
      effects.push(this.line(action, now));
      this.lastGestureSpeechAt = now;
    }
    effects.push({ type: 'action', action: action === 'pet' ? 'pat' : action });
    return effects;
  }
  tick(now, { hidden = false } = {}) {
    if (hidden) return [];
    if (this.state === 'drowsy' && now >= this.transitionAt) {
      this.state = 'sleeping';
      return [{ type: 'state', state: this.state }];
    }
    if (this.state === 'sleeping' && now >= this.wakeAt) return this.wake(now);
    if (this.state === 'waking' && now >= this.transitionAt) {
      this.state = 'awake';
      return [{ type: 'state', state: this.state }, { type: 'action', action: 'stretch' }];
    }
    if (this.state !== 'awake') return [];
    if (now >= this.sleepAt && now - this.lastInteractionAt >= 120000) return this.startSleep(now);
    if (now < this.nextActionAt) return [];
    const options = this.profile.actions.filter(action => action !== this.lastAction);
    const action = options[Math.floor(this.random() * options.length)];
    this.lastAction = action;
    this.nextActionAt = now + this.between(...this.profile.action);
    const effects = [{ type: 'action', action }];
    if (now - this.lastSpeechAt >= this.profile.quietFor && this.random() < .35) effects.push(this.line('idle', now));
    return effects;
  }
}
