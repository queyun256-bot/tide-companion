import { localDateKey } from './journal.js';
import { getMedication } from './medications.js';
import { visibleSkinId } from './skin-features.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const number = value => value.toLocaleString('zh-CN');
const star = '<svg class="wallet-star-icon" data-star-feed-icon viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 2.8 5.7 6.3.9-4.5 4.4 1.1 6.2L12 17.3l-5.7 2.9 1.1-6.2-4.5-4.4 6.3-.9Z"/></svg>';

// Read-only presentation. Award eligibility and immutable entries are owned by
// the main process; the renderer never grants, consumes, or modifies currency.
export function starWalletSummary(state, now = Date.now()) {
  const entries = (state?.starWallet?.entries || []).filter(entry => Number.isSafeInteger(entry.amount) && entry.amount !== 0);
  const day = localDateKey(now);
  const today = entries.filter(entry => entry.day === day);
  return {
    balance: entries.reduce((sum, entry) => sum + entry.amount, 0),
    today: today.filter(entry => entry.amount > 0).reduce((sum, entry) => sum + entry.amount, 0),
    regular: today.filter(entry => entry.kind === 'regular').reduce((sum, entry) => sum + entry.amount, 0),
    recent: [...entries].sort((a, b) => new Date(b.earnedAt) - new Date(a.earnedAt)).slice(0, 5),
  };
}

export function renderStarWalletSummary(state) {
  const { balance } = starWalletSummary(state);
  return `<button type="button" class="star-wallet-summary" data-action="stars" aria-label="查看星星，已攒下 ${number(balance)} 颗">${star}<span>已攒下 <b>${number(balance)}</b> 颗</span><span class="wallet-summary-arrow" aria-hidden="true">↗</span></button>`;
}

export function renderStarWallet(state) {
  const summary = starWalletSummary(state), settings = state.settings || {}, name = settings.name || '鲨鲨';
  const growth = state.petGrowth || { experience: 0, level: 1, intoLevel: 0, requiredForNext: 5, maxLevel: false, dailyDropMax: 0 };
  const full = growth.maxLevel === true;
  const idleToday = (state.starWallet?.entries || []).some(entry => entry.kind === 'idle' && entry.day === localDateKey());
  const history = summary.recent.map(entry => {
    const medicine = getMedication(entry.routeId), plan = (state.plans || []).find(item => item.id === entry.planId);
    const caption = entry.kind === 'feed' ? '喂给' + name + '的小星星' : entry.kind === 'idle' ? name + '留下的星光' : plan?.name || medicine?.drugName || '用药提醒';
    const kind = ({feed:'投喂',idle:'自然产星',long:'长周期提醒',regular:'普通提醒'})[entry.kind] || '用药提醒';
    const at = new Date(entry.earnedAt), time = Number.isFinite(+at) ? at.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '已保存的记录';
    return `<li><span class="wallet-history-mark" aria-hidden="true">${entry.kind === 'feed' ? '♡' : '✦'}</span><div><span class="wallet-record-label">${escape(caption)}</span><small><time datetime="${escape(entry.earnedAt)}">${escape(time)}</time> · ${kind}</small></div><b class="${entry.amount < 0 ? 'wallet-spent' : ''}">${entry.amount < 0 ? '−' : '＋'}${number(Math.abs(entry.amount))}<small> 颗</small></b></li>`;
  }).join('');
  return `<section class="card star-wallet-card" id="star-wallet-card" tabindex="-1" aria-labelledby="star-wallet-title">
    <div class="card-head"><h2 id="star-wallet-title">攒下的小星星</h2><span class="wallet-keepsake">慢慢留下来的光</span></div>
    <div class="star-wallet-overview"><div class="star-wallet-balance">${star}<div><span>星星余额</span><p><strong data-star-balance>${number(summary.balance)}</strong><small>颗</small></p></div></div><div class="star-wallet-today"><div><span>今天获得</span><b data-star-today>＋${number(summary.today)} <small>颗</small></b></div><div><span>普通提醒 · 今日</span><b data-star-regular>${number(summary.regular)} <small>/ 2 颗</small></b></div></div></div>
    <div class="pet-growth-layout"><div class="pet-growth-copy"><div class="pet-growth-title"><h3>一起慢慢长大</h3><span class="pet-level" data-pet-level>Lv.${growth.level}</span></div><p>五种外观共用同一份成长，换肤不会从头开始。</p>
      <div class="pet-experience-label"><span>${full ? '经验已满' : '这一等级的经验'}</span><b data-pet-experience>${full ? number(growth.experience) + ' · 满级' : number(growth.intoLevel) + ' / ' + number(growth.requiredForNext)}</b></div>
      <progress class="pet-experience" max="${full ? 1 : growth.requiredForNext}" value="${full ? 1 : growth.intoLevel}" aria-label="${escape(name)}的等级经验"></progress>
      <div class="star-feed-offer"><button type="button" class="star-feed-source" data-star-feed-source draggable="${summary.balance > 0}" ${summary.balance > 0 ? '' : 'disabled aria-disabled="true"'} aria-label="拖一颗星星喂给${escape(name)}，消耗一颗星星">${star}<span>拖一颗给${escape(name)}</span></button><small>拖到旁边或桌面的鲨鱼身上<br>1 颗星星 · ${full ? '经验已满，也可以喂着玩' : '1 点经验'}</small></div>
      <p class="pet-growth-hint">${growth.level < 2 ? '到 2 级后，闲下来时偶尔会留下一点星光。' : idleToday ? '今天的星光已经留下啦，安心待着就好。' : '闲下来时，偶尔会留下 1–' + growth.dailyDropMax + ' 颗星星；小份更常见，每天最多一次。'}</p>
    </div><tide-pet-preview class="wallet-pet-preview" name="${escape(name)}" skin="${escape(visibleSkinId(settings.activeSkin))}" mode="${escape(settings.mode || 'mtf')}" reduced-motion="${Boolean(settings.reducedMotion)}" data-star-feed-target data-action="pet"></tide-pet-preview></div>
    <p class="star-wallet-note">余额与成长会留在本机，也随备份保存。喂星星只是一点互动，平时一起待着也很好。</p>
    <div class="star-wallet-history"><h3>最近的星星记录</h3>${history ? '<ol>' + history + '</ol>' : '<p class="wallet-history-empty">还没有星星。按自己的用药安排记录就好，它们会慢慢留下来。</p>'}</div>
    <details class="star-wallet-rules"><summary>星星与成长</summary><div><p>已有提醒计划时，在预定时间<b>前后各 2 小时内</b>实际用药并记录，每次可留下一颗星星，无需等提醒弹出；普通提醒每天最多 <b>2 颗</b>，按记录获星当天计算。</p><p>间隔 <b>48 小时及以上</b>的计划，按完整天数获得星星，单次最多 <b>7 颗</b>，不占当天普通额度。</p><p>可以稍后补记，按实际使用时间匹配药物、用量和时长。同一次提醒只奖励一次；修改已保存记录和测试提醒不会增加星星。没有星星的用药记录也会照常保存，不会因为漏记而扣除星星。</p><p>投喂每次消耗 <b>1 颗</b>星星，增加 <b>1 点</b>经验，最高 <b>10 级</b>。满级仍可以投喂，经验保持满格。2 级起，桌宠在清醒、可见且空闲时每天最多产星一次，数量为 1 至等级加 1、最多 10 颗；数量越多，出现概率越低。五种皮肤共享每天这一次，不会补发离线产星。</p></div></details>
  </section>`;
}
