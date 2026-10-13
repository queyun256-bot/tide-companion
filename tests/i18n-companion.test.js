import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {setLanguage, getLocale, t} from '../src/i18n.js';
import messages from '../src/locales/companion.json' with {type: 'json'};
import {PetBehavior} from '../src/pet-behavior.js';
import {BUILTIN_SHARKS} from '../src/shark-variants.js';
import {renderSkinGallery} from '../src/skin-gallery.js';
import {renderStarWallet, renderStarWalletSummary} from '../src/star-wallet-ui.js';

const translatedLocales = ['en', 'zh-TW', 'ja', 'ko', 'es'];
const placeholders = text => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();

test('every companion line and appearance description has all five translations with matching placeholders', () => {
  const dialogue = ['pet-behavior.js', 'shark-personalities.js'].flatMap(file =>
    [...readFileSync(new URL('../src/' + file, import.meta.url), 'utf8').matchAll(/'([^'\n]*[\u3400-\u9fff][^'\n]*)'/g)].map(match => match[1]));
  for (const item of BUILTIN_SHARKS) dialogue.push(item.name, item.personality, item.description);
  for (const source of dialogue) assert.ok(messages[source], source);
  for (const [source, translations] of Object.entries(messages)) {
    assert.equal(translations.length, 5, source);
    for (const translated of translations) {
      assert.ok(translated.trim(), source);
      assert.deepEqual(placeholders(translated), placeholders(source), source);
    }
  }
});

test('all moods and personalities keep varied localized speech while a live language change preserves behavior', () => {
  try {
    for (const locale of translatedLocales) {
      setLanguage(locale);
      for (const variant of BUILTIN_SHARKS) for (const mood of ['good', 'okay', 'low']) {
        const pet = new PetBehavior({variant: variant.id, random: () => .1, now: 0});
        pet.setMood(mood, 0);
        const lines = Array.from({length: 10}, (_, index) => pet.line('pet', index).message);
        assert.ok(new Set(lines).size >= (mood === 'low' && variant.id !== 'builtin' ? 4 : 5), `${locale}/${variant.id}/${mood}`);
        if (['en', 'ko', 'es'].includes(locale)) for (const line of lines) assert.doesNotMatch(line, /[\u3400-\u9fff]/);
      }
    }
    const pet = new PetBehavior({variant: 'builtin-rose', random: () => .1, now: 0});
    pet.setMood('low', 0); pet.startSleep(10);
    const before = {state: pet.state, mood: pet.mood, wake: pet.wakeAt, variant: pet.variant.id};
    setLanguage('en'); const english = pet.line('sleep', 20).message;
    setLanguage('ja'); const japanese = pet.line('sleep', 30).message;
    assert.notEqual(english, japanese);
    assert.deepEqual({state: pet.state, mood: pet.mood, wake: pet.wakeAt, variant: pet.variant.id}, before);
  } finally {setLanguage('zh-CN');}
});

test('wallet and skins translate again after each switch while keeping custom names, IDs, amounts and escaping intact', () => {
  const state = {settings: {name: '小浪 <friend>'}, plans: [{id: 'keep-plan', name: '药物日程 <plan>'}],
    starWallet: {entries: [{id: 'keep-entry', planId: 'keep-plan', routeId: 'e2-oral', kind: 'regular', amount: 1234, day: '2026-10-13', earnedAt: '2026-10-13T04:00:00.000Z'}]}};
  const before = JSON.stringify(state);
  try {
    for (const locale of ['zh-CN', ...translatedLocales]) {
      setLanguage(locale);
      const wallet = renderStarWallet(state);
      assert.ok(wallet.includes(t('攒下的小星星')));
      assert.ok(wallet.includes('药物日程 &lt;plan&gt;'));
      assert.ok(wallet.includes('name="小浪 &lt;friend&gt;"'));
      assert.ok(renderStarWalletSummary(state).includes(new Intl.NumberFormat(getLocale()).format(1234)));
      const gallery = renderSkinGallery({skins: BUILTIN_SHARKS, activeSkin: 'builtin-rose'}, {petName: state.settings.name});
      assert.ok(gallery.includes('data-id="builtin-rose"'));
      assert.ok(gallery.includes(t('绒绒粉')));
      assert.ok(gallery.includes('小浪 &lt;friend&gt;'));
      assert.doesNotMatch(gallery, /<friend>|<plan>/);
    }
    assert.equal(JSON.stringify(state), before);
    setLanguage('en');
    const plain = renderStarWallet({settings: {name: 'Friend'}, starWallet: {entries: []}});
    assert.doesNotMatch(plain.replace(/<[^>]*>/g, ''), /[\u3400-\u9fff]/);
  } finally {setLanguage('zh-CN');}
});
