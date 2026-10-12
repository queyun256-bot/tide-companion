// Original, transparent route symbols. Route names remain visible beside each
// symbol; these decorative drawings are not instructions for administering drugs.
const DRAWINGS = Object.freeze({
  oral: '<g transform="rotate(40 12 12)"><path d="M7.5 12h9v4.5a4.5 4.5 0 0 1-9 0Z" data-icon-accent=""/><rect x="7.5" y="3" width="9" height="18" rx="4.5"/><path d="M7.5 12h9M10 6.5c.4-.5.9-.8 1.5-.9"/></g>',
  sublingual: '<path d="M3.4 8.5C5.9 6 8.6 5 12 5s6.1 1 8.6 3.5c-1.3 6.3-4.2 10-8.6 10s-7.3-3.7-8.6-10Z"/><path d="M4.1 9h15.8M7.1 13.6c2.7-2.7 7.1-2.7 9.8 0"/><rect x="9.3" y="14.1" width="5.4" height="2.7" rx="1.35" data-icon-solid=""/>',
  buccal: '<path d="M3.4 8.5C5.9 6 8.6 5 12 5s6.1 1 8.6 3.5c-1.3 6.3-4.2 10-8.6 10s-7.3-3.7-8.6-10Z"/><path d="M4.1 9h10.6M7.2 14.5c1.7-1.6 4.3-2.1 6.5-1.3"/><rect x="16.5" y="9.5" width="2.7" height="5.3" rx="1.35" transform="rotate(20 17.85 12.15)" data-icon-solid=""/>',
  gel: '<path d="M12 3.2C10.8 5.4 7 9.2 7 12a5 5 0 0 0 10 0c0-2.8-3.8-6.6-5-8.8Z" data-icon-accent=""/><path d="M12 3.2C10.8 5.4 7 9.2 7 12a5 5 0 0 0 10 0c0-2.8-3.8-6.6-5-8.8ZM9.8 12.1c0 1 .6 1.9 1.5 2.2M3.5 20c2.8-1.5 5.6-1.5 8.5 0s5.7 1.5 8.5 0"/>',
  patch: '<rect x="3.7" y="5.7" width="16.6" height="12.6" rx="3.6" transform="rotate(-16 12 12)"/><g transform="rotate(-16 12 12)"><rect x="8" y="8.2" width="8" height="7.6" rx="2" data-icon-accent=""/><rect x="8" y="8.2" width="8" height="7.6" rx="2"/><path d="M5.9 9.8v.2m0 4v.2m12.2-4.4v.2m0 4v.2"/></g>',
  spray: '<path d="M7 10h6l1 2.5V20H6v-7.5L7 10ZM8 10V6.7h4V10M8 6.7V4h6v2.7M14 5.3h1.7"/><path d="M6 15h8v5H6Z" data-icon-accent=""/><path d="m18.4 5.3 2.6-.1M18 2.5l2-1M18 8l2 1"/>',
  im: '<path d="M9 2.7h6M12 2.7V6M8.4 6h7.2M9.5 6v8h5V6M10 10h2M12 14v5.1"/><path d="M9.5 11.5h5V14h-5Z" data-icon-accent=""/><path d="M3 17.5h5m8 0h5M3 21h18"/><path d="m5.5 21 2-3.5m9 3.5 2-3.5" opacity=".55"/>',
  sc: '<g transform="rotate(42 11.5 10)"><path d="M8.5 2.2h6M11.5 2.2v3.3M7.9 5.5h7.2M9 5.5v7.7h5V5.5M9.5 9h2M11.5 13.2v3.5"/><path d="M9 10.8h5v2.4H9Z" data-icon-accent=""/></g><path d="M3 18.5h18M5.2 21h.2m4.2 0h.2m4.2 0h.2m4.2 0h.2"/>',
  rectal: '<path d="M12 3.2c-2.4 2.4-5 6.1-5 10.3v4.2a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2v-4.2c0-4.2-2.6-7.9-5-10.3Z"/><path d="M7 15h10v2.7a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2Z" data-icon-accent=""/><path d="M9.7 10.7c.3-1.2.8-2.3 1.5-3.3M7 15h10"/>',
  implant: '<path d="M3 5.8c2.8-1 5.8-1 9 0s6.2 1 9 0M3 20h18"/><g transform="rotate(-12 12 13)"><rect x="5.5" y="10.8" width="13" height="4.4" rx="2.2" data-icon-accent=""/><rect x="5.5" y="10.8" width="13" height="4.4" rx="2.2"/><path d="M9 11v4M15 11v4"/></g>',
});

const fallback = '<rect x="5.5" y="5.5" width="13" height="13" rx="4"/><path d="M8.5 12h7M12 8.5v7"/>';
const escapeAttribute = value => String(value).replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));

/** Inline SVG for one catalog administration id; inherits the surrounding color. */
export function administrationIcon(administrationId, { className = '', size = 24 } = {}) {
  const dimension = typeof size === 'number' && Number.isFinite(size) ? Math.max(12, Math.min(96, size)) : 24;
  const drawing = Object.hasOwn(DRAWINGS, administrationId) ? DRAWINGS[administrationId] : fallback;
  return `<svg class="administration-icon${className ? ` ${escapeAttribute(className)}` : ''}" width="${dimension}" height="${dimension}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${drawing}</svg>`;
}
