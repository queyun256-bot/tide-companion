import { t } from './i18n.js';
// Clinical monitoring context only. These references never enter the PK engine,
// set a personal target, or classify an estimated point as safe/unsafe.
const SOURCES = Object.freeze({
  endocrine: Object.freeze({ label: 'Endocrine Society · 2017', url: 'https://academic.oup.com/jcem/article/102/11/3869/4157558' }),
  wpath: Object.freeze({ label: 'WPATH SOC8 · 2022', url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC9553112/' }),
  review: Object.freeze({ label: 'E2 范围证据综述 · 2025', url: 'https://pubmed.ncbi.nlm.nih.gov/40552461/' }),
});

const REFERENCES = Object.freeze({
  'mtf:estradiol': Object.freeze({
    label: '指南监测参考', value: '100–200 pg/mL',
    context: '约 367–734 pmol/L · 用于临床采血解读',
    paragraphs: [
      'WPATH SOC8 附录 C 表 5 与 Endocrine Society 2017 表 15 列出女性化 GAHT 的这一监测参考。实际解读需结合给药途径及采血距上次用药的时间。',
      '这里的当前数值是模型估计，不能直接当作采血结果；参考范围也不是每一时刻的安全阈值。2025 年系统综述未找到证据证明这一范围能带来最佳女性化效果或减少不良事件。',
    ],
    sources: [SOURCES.endocrine, SOURCES.wpath, SOURCES.review],
  }),
  'ftm:testosterone': Object.freeze({
    label: '指南监测参考', value: '400–700 ng/dL',
    context: '仅指庚酸 / 环戊丙酸睾酮注射间隔中点采血',
    paragraphs: [
      'Endocrine Society 2017 表 14 与 WPATH SOC8 附录 C 表 5 的针剂监测建议需结合采血时点。上述数值不适用于整条估算曲线或所有睾酮给药方式。',
      '长效十一酸睾酮针剂通常在下一次注射前采血；经皮睾酮在每日使用至少一周后、距涂药至少两小时采血。其他情形需按对应制剂、男性生理参考范围及个人治疗目标解读。',
    ],
    sources: [SOURCES.endocrine, SOURCES.wpath],
  }),
  'ftm:estradiol': Object.freeze({
    label: '指南监测参考', value: '未设统一 E2 目标',
    context: 'FTM 模式不套用女性化治疗的 100–200 pg/mL',
    paragraphs: [
      '这两份指南的男性化 GAHT 监测表未给出统一的雌二醇目标范围。显示 E2 可帮助回顾自己的记录和实测变化，但应结合个人情况解读，不能据此判定睾酮治疗是否达标。',
    ],
    sources: [SOURCES.endocrine, SOURCES.wpath],
  }),
});

export function gahtReference(analyte, mode) {
  const source = REFERENCES[`${mode}:${analyte}`];
  return source ? {...source, label:t(source.label),value:t(source.value),context:t(source.context), paragraphs:source.paragraphs.map(text=>t(text)),sources:source.sources.map(item=>({...item,label:t(item.label)}))} : null;
}

const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function gahtReferenceMarkup(analyte, mode) {
  const reference = gahtReference(analyte, mode);
  if (!reference) return '';
  return `<aside class="gaht-reference" data-gaht-reference="${escape(analyte)}" aria-label="${escape(reference.label)}"><div class="gaht-reference-line"><span>${escape(reference.label)}</span><b>${escape(reference.value)}</b></div><p class="gaht-reference-context">${escape(reference.context)}</p><details class="gaht-reference-details"><summary>${t('适用条件与文献')}</summary><div class="gaht-reference-body">${reference.paragraphs.map(paragraph => `<p>${escape(paragraph)}</p>`).join('')}<div class="gaht-reference-sources">${reference.sources.map(source => `<button type="button" data-source="${escape(source.url)}">${escape(source.label)} <span aria-hidden="true">↗</span></button>`).join('')}</div></div></details></aside>`;
}
