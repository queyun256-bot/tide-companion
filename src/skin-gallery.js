import { getBuiltinShark, isBuiltinShark } from './shark-variants.js';
import { LIVE2D_ENABLED, visibleSkinId } from './skin-features.js';
import { t } from './i18n.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));

export function renderSkinGallery(data, {petName = '鲨鲨'} = {}) {
  const builtin = data.skins.filter(skin => isBuiltinShark(skin.id));
  const imported = data.skins.filter(skin => !isBuiltinShark(skin.id));
  return `<div class="shark-collection" aria-label="${t('内置鲨鱼皮肤')}">${builtin.map(skin => {
    const shark = getBuiltinShark(skin.id), active = skin.id === visibleSkinId(data.activeSkin);
    return `<article class="shark-skin ${active ? 'is-selected' : ''}" data-skin-id="${esc(skin.id)}">
      <div class="shark-skin-art"><img src="${esc(shark.thumbnail)}" alt="${esc(t('{name}鲨鱼', {name: t(shark.name)}))}" loading="lazy">${active ? `<span class="shark-selected">${t('当前陪伴')}</span>` : ''}</div>
      <div class="shark-skin-copy"><div class="shark-skin-title"><h3>${esc(t(shark.name))}</h3><span>${esc(t(shark.personality))}</span></div><p>${esc(t(shark.description))}</p></div>
      <button type="button" class="btn ${active ? '' : 'secondary'} small" data-action="select-skin" data-id="${esc(skin.id)}" aria-label="${esc(t(active ? '正在使用{name}' : '换成{name}', {name: t(shark.name)}))}" ${active ? 'disabled' : ''}>${t(active ? '使用中' : '换上这一身')}</button>
    </article>`;
  }).join('')}</div><p class="shark-collection-note">${esc(t('换肤会改变{name}的颜色、动作节奏和说话方式，名字保持不变。当天的心情也会影响陪伴节奏。', {name: petName}))}</p>
    ${LIVE2D_ENABLED ? `<section class="imported-skins" aria-label="${t('本机 Live2D 模型')}"><div class="card-head"><h3>${t('自己的 Live2D')}</h3><button type="button" class="btn secondary small" data-action="import-skin">＋ ${t('导入模型')}</button></div>
    ${imported.length ? `<div class="skin-list">${imported.map(skin => `<div class="skin-row"><span class="live2d-skin-icon" aria-hidden="true">◇</span><div class="imported-skin-copy"><strong>${esc(skin.name)}</strong><small>${t('本机 Live2D')}</small></div><div class="button-row"><button type="button" class="btn secondary small" data-action="select-skin" data-id="${esc(skin.id)}" ${skin.id === data.activeSkin ? 'disabled' : ''}>${t(skin.id === data.activeSkin ? '使用中' : '使用')}</button><button type="button" class="btn ghost small" data-action="remove-skin" data-id="${esc(skin.id)}">${t('移除')}</button></div></div>`).join('')}</div>` : `<p class="muted">${t('也可以让你自己的模型住进来。选择 .model3.json，相关素材会一起保存在本机。')}</p>`}</section>` : ''}`;
}
