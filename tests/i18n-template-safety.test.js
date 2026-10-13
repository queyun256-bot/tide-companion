import test from 'node:test';
import assert from 'node:assert/strict';
import {html, setLanguage, t} from '../src/i18n.js';

const esc = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

test('HTML translation keeps escaped arbitrary user text opaque across nested templates and attribute positions', () => {
  const examples = ['今天', '<img src=x onerror="alert(1)">', '&quot; autofocus onfocus=alert(1)', 'A & B <3 {0}', '\uE0000\uE001 {name}'];
  try {
    for (const language of ['en', 'zh-CN', 'zh-TW', 'ja', 'ko', 'es']) {
      setLanguage(language);
      for (const value of examples) {
        const encoded = esc(value);
        const child = html`<span title="${encoded}">${encoded}</span>`;
        assert.equal(child, `<span title="${encoded}">${encoded}</span>`);
        const parent = html`<div><h1>今天</h1>${child}</div>`;
        assert.equal(parent, `<div><h1>${t('今天')}</h1>${child}</div>`);
        const input = html`<input name="plan-name" value="${encoded}" placeholder="今天">`;
        assert.equal(input, `<input name="plan-name" value="${encoded}" placeholder="${t('今天')}">`);
      }
    }
  } finally {setLanguage('zh-CN');}
});

test('only presentation attributes and authored prose translate; stable values and numeric placeholders remain untouched', () => {
  try {
    setLanguage('en');
    const actual = html`<input id="今天" name="今天" value="今天" data-source="今天" aria-label="今天" title="今天" placeholder="今天">`;
    assert.equal(actual, '<input id="今天" name="今天" value="今天" data-source="今天" aria-label="Today" title="Today" placeholder="Today">');
    const attrs = html('type="text" maxlength="120" placeholder="给这个提醒起个名字"');
    const full = html`<input value="${esc('今天 <custom>')}" ${attrs}>`;
    assert.ok(full.includes('value="今天 &lt;custom&gt;"'));
    assert.ok(full.includes('maxlength="120"'));
    assert.ok(full.includes(`placeholder="${t('给这个提醒起个名字')}"`));
    const multi = html`今天已记录 ${2} 次使用 · ${3} 条化验`;
    assert.equal(multi, t('今天已记录 {0} 次使用 · {1} 条化验', {0: 2, 1: 3}));
  } finally {setLanguage('zh-CN');}
});
