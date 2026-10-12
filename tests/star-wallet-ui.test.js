import test from 'node:test';
import assert from 'node:assert/strict';
import { localDateKey } from '../src/journal.js';
import { starWalletSummary, renderStarWallet, renderStarWalletSummary } from '../src/star-wallet-ui.js';

const now = new Date(2026, 9, 12, 0, 15);
const today = localDateKey(now), yesterday = localDateKey(new Date(2026, 9, 11, 23, 45));
const entry = (id, kind, amount, day, at) => ({ id, kind, amount, day, earnedAt: at.toISOString(), planId: id, routeId: 'e2-oral' });
const entries = [
  entry('long-week', 'long', 7, today, new Date(+now - 60000)),
  entry('daily-a', 'regular', 1, today, new Date(+now - 120000)),
  entry('daily-b', 'regular', 1, today, new Date(+now - 180000)),
  entry('long-pair', 'long', 2, today, new Date(+now - 240000)),
  entry('older-a', 'regular', 1, yesterday, new Date(+now - 3600000)),
  entry('older-b', 'regular', 1, yesterday, new Date(+now - 3700000)),
];

test('wallet display keeps lifetime balance separate from today and regular daily quota', () => {
  const state = { starWallet: { version: 1, entries }, plans: [] };
  const before = JSON.stringify(state);
  const result = starWalletSummary(state, now);
  assert.equal(result.balance, 13); assert.equal(result.today, 11); assert.equal(result.regular, 2);
  assert.equal(result.recent.length, 5); assert.equal(result.recent[0].id, 'long-week');
  assert.equal(result.recent.at(-1).id, 'older-a');
  assert.equal(JSON.stringify(state), before);
});

test('wallet renders an accessible ledger, a bounded feeding source and a summary navigation button', () => {
  const state = { starWallet: { version: 1, entries }, plans: [{ id: 'long-week', name: '<img src=x onerror=alert(1)>' }] };
  const card = renderStarWallet(state);
  assert.match(card, /id="star-wallet-card" tabindex="-1"/);
  assert.equal((card.match(/<li>/g) || []).length, 5);
  assert.doesNotMatch(card, /<input|<form|<img/);
  assert.match(card, /data-star-feed-source draggable="true"/);
  assert.match(card, /data-star-feed-target/);
  assert.match(card, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(card, /2 小时内/); assert.match(card, /48 小时及以上/);
  assert.match(card, /不占当天普通额度/); assert.match(card, /不会因为漏记而扣除星星/);
  const summary = renderStarWalletSummary(state);
  assert.match(summary, /data-action="stars"/); assert.match(summary, /已攒下 <b>13<\/b> 颗/);
});

test('an old installation without a wallet has a calm empty state and zero balance', () => {
  const state = { plans: [] };
  assert.equal(starWalletSummary(state, now).balance, 0);
  assert.match(renderStarWallet(state), /还没有星星/);
  assert.match(renderStarWalletSummary(state), /已攒下 <b>0<\/b> 颗/);
  assert.match(renderStarWallet(state), /draggable="false" disabled aria-disabled="true"/);
});

test('feeding and idle drops use signed balance, positive daily gains and the shared level display', () => {
  const history = [...entries, entry('feed-one', 'feed', -1, today, now), entry('idle-today', 'idle', 2, today, new Date(+now + 1))];
  const state = {starWallet:{version:1,entries:history},petGrowth:{experience:6,level:2,intoLevel:1,requiredForNext:8,maxLevel:false,dailyDropMax:3},settings:{name:'鲨鲨'}};
  const summary = starWalletSummary(state,now);
  assert.equal(summary.balance,14); assert.equal(summary.today,13); assert.equal(summary.regular,2);
  const card = renderStarWallet(state);
  assert.match(card,/data-pet-level>Lv\.2/); assert.match(card,/data-pet-experience>1 \/ 8/);
  assert.match(card,/喂给鲨鲨的小星星/); assert.match(card,/wallet-spent">−1/);
  assert.match(card,/鲨鲨留下的星光/); assert.match(card,/＋2<small> 颗/);
  assert.doesNotMatch(card,/1 · 满级/);
  state.petGrowth={experience:295,level:10,intoLevel:0,requiredForNext:0,maxLevel:true,dailyDropMax:10};
  assert.match(renderStarWallet(state),/295 · 满级/);
  assert.match(renderStarWallet(state),/经验已满，也可以喂着玩/);
});
