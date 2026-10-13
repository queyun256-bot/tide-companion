import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import core from '../src/i18n-core.cjs';
import { html, setLanguage, t, getLocale, translateError } from '../src/i18n.js';

test('system language resolution supports regional variants and explicit overrides', () => {
  for (const [system, expected] of [['zh-Hant','zh-TW'],['zh_HK','zh-TW'],['zh-MO','zh-TW'],['zh-Hans-SG','zh-CN'],['zh-CN','zh-CN'],['en-GB','en'],['ja-JP','ja'],['ko-KR','ko'],['es-MX','es'],['fr-FR','en'],['','en']]) {
    assert.equal(core.resolveLanguage('system', system), expected);
    assert.equal(core.resolveLanguage('ko', system), 'ko');
  }
  assert.equal(core.resolveLanguage('system',['es-AR','en-US']), 'es');
});

test('all catalogs supply five translations and preserve interpolation placeholders', async () => {
  const slots = value => [...value.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
  for (const name of ['app','native','journal','companion']) {
    const catalog = JSON.parse(await readFile(new URL(`../src/locales/${name}.json`,import.meta.url),'utf8'));
    assert.ok(Object.keys(catalog).length > 0, name);
    for (const [source, translations] of Object.entries(catalog)) {
      assert.equal(translations.length,5,`${name}: ${source}`);
      for (const value of translations) {
        assert.equal(typeof value,'string',source);assert.ok(value.trim(),source);
        assert.deepEqual(slots(value),slots(source),`${name}: ${source} -> ${value}`);
        assert.doesNotMatch(value,/\uE000|\uE001|undefined/);
      }
    }
  }
});

test('language notifications occur once per effective change and can be unsubscribed', () => {
  const engine=core.createI18n([{'今天':['Today','今天','今日','오늘','Hoy']}]);
  const changes=[],unsubscribe=engine.onLanguageChange(language=>changes.push(language));
  engine.setLanguage('system','en-US');engine.setLanguage('en','ja');
  assert.equal(engine.t('今天'),'Today');
  engine.setLanguage('ja','en');unsubscribe();engine.setLanguage('ko');
  assert.deepEqual(changes,['en','ja']);
});

test('HTML translation preserves interpolated user data, markup, IDs and clinical values', () => {
  setLanguage('en');
  assert.equal(html`<h1>今天</h1><p>${'今天'}</p>`,'<h1>Today</h1><p>今天</p>');
  assert.equal(html`<p>${'A &amp; B &lt;3 {0}'}在桌面上，日常记录在这里。</p>`,'<p>A &amp; B &lt;3 {0} is on your desktop; your daily records are here.</p>');
  assert.equal(html`<input id="actual-time" value="${'2026-10-13T08:20'}" aria-label="实际使用时间">`,'<input id="actual-time" value="2026-10-13T08:20" aria-label="Actual use time">');
  const clinical=html`<span data-dose="${1.25}">${'123.45 pg/mL'}</span>`;
  assert.equal(clinical,'<span data-dose="1.25">123.45 pg/mL</span>');
  assert.equal(html`<button>保存</button>`,'<button>Save</button>');
  assert.equal(html`<p>原定 ${'08:00'} · ${'今天'}</p>`,'<p>Scheduled for 08:00 · 今天</p>');
  assert.equal(t('删除{0}',{0:'<user {0}>'}),'Delete <user {0}>');
  assert.equal(translateError(new Error("Error invoking remote method 'state:save': Error: 名字不能为空。")),'Please enter a name.');
  assert.equal(translateError('数据格式不正确：界面语言'),t('数据格式不正确：{0}',{0:t('界面语言')}));
  assert.equal(translateError('皮肤导入失败：今天.model3 不是有效 JSON。'),t('皮肤导入失败：{0}',{0:t('{0} 不是有效 JSON。',{0:'今天.model3'})}));
  assert.equal(translateError('名字存在重复 ID'),t('{0}存在重复 ID',{0:t('名字')}));
  assert.equal(translateError('引用文件类型不匹配：文件/今天.moc3'),t('引用文件类型不匹配：{0}',{0:'文件/今天.moc3'}));
  setLanguage('zh-CN');assert.equal(getLocale(),'zh-CN');assert.equal(html`<b>保存</b>`,'<b>保存</b>');
});
