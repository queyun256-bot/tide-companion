import catalog from '../assets/sharks/catalog.json' with { type: 'json' };
import { t } from './i18n.js';

export const BUILTIN_SHARKS = Object.freeze(catalog.map(item => Object.freeze({ ...item, palette: Object.freeze(item.palette) })));
export const isBuiltinShark = id => BUILTIN_SHARKS.some(item => item.id === id);
export const getBuiltinShark = id => BUILTIN_SHARKS.find(item => item.id === id) || BUILTIN_SHARKS[0];

// Only bundled SVG attributes are recolored. Imported Live2D assets never enter this path.
export function applySharkPalette(svg, id) {
  const variant = getBuiltinShark(id);
  for (const element of svg.querySelectorAll('[fill],[stroke],[stop-color]')) {
    for (const attribute of ['fill', 'stroke', 'stop-color']) {
      if (!element.hasAttribute(attribute)) continue;
      const key = `data-original-${attribute}`;
      const original = element.getAttribute(key) ?? element.getAttribute(attribute);
      element.setAttribute(key, original);
      element.setAttribute(attribute, variant.palette[original] || original);
    }
  }
  svg.dataset.variant = variant.id;
  const desc = svg.querySelector('desc');
  if (desc) desc.textContent = t('{name}的小鲨鱼，圆肚皮、短小鳍，戴着浅蓝、粉、白相间的跨性别旗帜围巾。{description}', {name: t(variant.name), description: t(variant.description)});
  return variant;
}
