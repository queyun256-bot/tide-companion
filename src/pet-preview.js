import { applySharkPalette, getBuiltinShark, isBuiltinShark } from './shark-variants.js';
import { renderStarfield } from './star-effects.js';
import { visibleSkinId } from './skin-features.js';
import { ensurePetStarEffects, setProducedAmount } from './pet-star-animation.js';

const PET_DOCUMENT = new URL('../pet.html', import.meta.url);
const PET_STYLE = new URL('./pet.css', import.meta.url);
const STAR_STYLE = new URL('./star-effects.css', import.meta.url);
const PREVIEW_STYLE = new URL('./pet-preview.css', import.meta.url);
const POSE = {
  bodyTransform: ['body', 'transform'], eyesTransform: ['eyes', 'transform'],
  faceTransform: ['face', 'transform'], gazeTransform: ['gaze', 'transform'],
  finLeftTransform: ['fin-left', 'transform'], finRightTransform: ['fin-right', 'transform'],
  smileOpacity: ['smile', 'opacity'], yawnOpacity: ['yawn', 'opacity'],
};
const CLASS_NAME = /^(?:is-(?:drowsy|sleeping|waking|blinking|enjoying-touch|dragging|drag-preparing|drag-releasing)|action-(?:pat|stroke|feed|nuzzle|tilt|blink|nod|stretch|wiggle|wave|scarf|sway|peek|tailcurl|bob|star-eat|star-produce))$/;
const listeners = new Set();
let lastSnapshot = null, unsubscribe = null, templatePromise = null;

function deliver(snapshot) {
  if (!snapshot || snapshot.version !== 1 || !Number.isFinite(snapshot.at)) return;
  if (lastSnapshot && snapshot.at < lastSnapshot.at) return;
  lastSnapshot = snapshot;
  for (const listener of listeners) listener(snapshot);
}

function subscribe(listener) {
  const first = listeners.size === 0;
  listeners.add(listener);
  if (lastSnapshot) listener(lastSnapshot);
  if (first) {
    unsubscribe = window.petAPI?.onPetVisual?.(deliver) || null;
    Promise.resolve(window.petAPI?.getPetVisual?.()).then(deliver).catch(() => {});
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) { unsubscribe?.(); unsubscribe = null; }
  };
}

async function petTemplate() {
  if (!templatePromise) {
    templatePromise = (async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      try {
        const response = await fetch(PET_DOCUMENT, { signal: controller.signal });
        if (!response.ok) throw new Error('Pet preview template unavailable');
        const document = new DOMParser().parseFromString(await response.text(), 'text/html');
        const stage = document.querySelector('.pet-stage');
        if (!stage?.querySelector('#builtin-pet svg')) throw new Error('Pet preview rig unavailable');
        // This is the shipped desktop rig. No script, Live2D runtime, controls,
        // drag regions, or independently scheduled behavior enter the preview.
        stage.querySelectorAll('.speech,.pet-controls,.drag-handle,#live2d-canvas,script').forEach(node => node.remove());
        const touch = stage.querySelector('.shark-touch');
        const shell = document.createElement('div'); shell.className = 'shark-touch';
        shell.append(...touch.childNodes); touch.replaceWith(shell);
        stage.className = 'pet-stage'; stage.setAttribute('aria-hidden', 'true');
        return stage;
      } finally { clearTimeout(timeout); }
    })().catch(error => { templatePromise = null; throw error; });
  }
  return templatePromise;
}

function loadStyles(root) {
  return Promise.all([PET_STYLE, STAR_STYLE, PREVIEW_STYLE].map(url => new Promise((resolve, reject) => {
    const link = document.createElement('link'); link.rel = 'stylesheet';
    const timer = setTimeout(() => { link.remove(); reject(new Error('Pet preview style unavailable')); }, 8000);
    link.onload = () => { clearTimeout(timer); resolve(); };
    link.onerror = () => { clearTimeout(timer); link.remove(); reject(new Error('Pet preview style unavailable')); };
    link.href = url.href; root.append(link);
  })));
}

class TidePetPreview extends HTMLElement {
  static observedAttributes = ['name', 'skin', 'mode', 'reduced-motion', 'data-action'];

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._stage = null; this._loading = false; this._latest = null;
    this._snapshot = snapshot => { this._latest = snapshot; this._applySnapshot(); };
    this._motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    this._preference = () => this._applySnapshot();
    this._key = event => {
      if (!this.hasAttribute('data-action') || event.repeat || !['Enter', ' '].includes(event.key)) return;
      event.preventDefault(); this.click();
    };
    const fallback = document.createElement('div'); fallback.className = 'preview-fallback';
    const image = document.createElement('img'); image.alt = ''; image.setAttribute('aria-hidden', 'true');
    const note = document.createElement('small'); note.className = 'preview-note';
    fallback.append(image, note); this.shadowRoot.append(fallback); this._fallback = fallback;
    const placeholder = document.createElement('div'); placeholder.className = 'preview-placeholder'; placeholder.hidden = true;
    const symbol = document.createElement('span'); symbol.textContent = '∿'; symbol.setAttribute('aria-hidden', 'true');
    const title = document.createElement('span'); title.textContent = '正在使用本机 Live2D';
    const description = document.createElement('small'); description.textContent = '请在桌面查看';
    placeholder.append(symbol, title, description); this.shadowRoot.append(placeholder); this._placeholder = placeholder;
  }

  connectedCallback() {
    this._updateAttributes();
    this._stop = subscribe(this._snapshot);
    this._motion.addEventListener('change', this._preference);
    this.addEventListener('keydown', this._key);
    this._resize = new ResizeObserver(() => this._scale()); this._resize.observe(this);
    if (this._stage) this._applySnapshot(); else this._load();
  }

  disconnectedCallback() {
    this._stop?.(); this._stop = null;
    this._resize?.disconnect(); this._resize = null;
    this._motion.removeEventListener('change', this._preference);
    this.removeEventListener('keydown', this._key);
    for (const animation of this._stage?.getAnimations({ subtree: true }) || []) animation.pause();
  }

  attributeChangedCallback() {
    this._updateAttributes();
    if (this.isConnected) this._applySnapshot();
  }

  _updateAttributes() {
    const name = this.getAttribute('name')?.trim() || '鲨鲨';
    this._fallback.querySelector('img').src = new URL(`../${getBuiltinShark(this.getAttribute('skin') || 'builtin').thumbnail}`, import.meta.url).href;
    if (this.hasAttribute('data-action')) {
      this.setAttribute('role', 'button'); this.tabIndex = 0;
      this.setAttribute('aria-label', `摸摸${name}`);
    } else { this.setAttribute('role', 'img'); this.removeAttribute('tabindex'); this.setAttribute('aria-label', `${name}的桌宠预览`); }
    this._setVisibility();
  }

  _setVisibility() {
    const live2d = !isBuiltinShark(visibleSkinId(this.getAttribute('skin')));
    this._placeholder.hidden = !live2d;
    this._fallback.hidden = live2d || Boolean(this._stage);
    if (this._scene) this._scene.hidden = live2d;
    if (live2d) this.dataset.previewState = 'live2d';
    else this.dataset.previewState = this._stage ? (this._latest ? 'ready' : 'waiting') : (this._failed ? 'fallback' : 'loading');
  }

  async _load() {
    if (this._loading) return;
    this._loading = true;
    try {
      const [template] = await Promise.all([petTemplate(), this._styles || (this._styles = loadStyles(this.shadowRoot))]);
      if (!this.isConnected) return;
      this._stage = template.cloneNode(true);
      ensurePetStarEffects(this._stage);
      this._scene = document.createElement('div'); this._scene.className = 'preview-scene preview-waiting';
      this._scene.append(this._stage); this.shadowRoot.append(this._scene);
      this._scale(); this._applySnapshot();
    } catch {
      this._failed = true;
      this._fallback.querySelector('.preview-note').textContent = '暂时显示静态外观';
      this._setVisibility();
    } finally { this._loading = false; }
  }

  _scale() {
    if (this._scene && this.clientWidth > 0) this._scene.style.setProperty('--preview-scale', String(this.clientWidth / 296));
  }

  _applySnapshot() {
    this._setVisibility();
    if (!this._stage || !this.isConnected) return;
    const snapshot = this._latest;
    const skin = visibleSkinId(this.getAttribute('skin'));
    const reduced = this._motion.matches || this.hasAttribute('reduced-motion') && this.getAttribute('reduced-motion') !== 'false' || Boolean(snapshot?.reducedMotion);
    const live2d = !isBuiltinShark(skin);
    const matches = snapshot && snapshot.variant === skin && !snapshot.live2d;
    const stage = this._stage;
    this._scene.classList.toggle('reduced-motion', reduced);
    this._scene.classList.toggle('preview-waiting', !matches || live2d);
    stage.className = `pet-stage ${(matches ? snapshot.classes : []).filter(name => CLASS_NAME.test(name)).join(' ')}`;
    stage.dataset.mood = matches ? snapshot.mood : 'okay';
    stage.dataset.behavior = matches ? snapshot.behavior : 'awake';
    stage.dataset.variant = skin;
    setProducedAmount(stage, matches ? snapshot.starProducedAmount : 0);
    if (this._palette !== skin) { applySharkPalette(stage.querySelector('#builtin-pet svg'), skin); this._palette = skin; }
    const title = stage.querySelector('svg title'); if (title) title.textContent = this.getAttribute('name') || '鲨鲨';
    const variables = matches ? snapshot.variables : {};
    for (const key of ['--gaze-x', '--gaze-y', '--fin-duration', '--breath-duration']) {
      if (typeof variables?.[key] === 'string') stage.style.setProperty(key, variables[key]);
      else stage.style.removeProperty(key);
    }
    for (const [key, [target, property]] of Object.entries(POSE)) {
      const element = stage.querySelector(`[data-visual-key="${target}"]`);
      if (!element) continue;
      const value = matches ? snapshot.pose?.[key] : null;
      if (typeof value === 'string' && !(reduced && target === 'gaze')) element.style.setProperty(property, value, snapshot.transitioning?.includes(target) ? 'important' : '');
      else element.style.removeProperty(property);
    }
    const stars = stage.querySelector('.star-lights');
    renderStarfield(stars, {
      balance: matches ? snapshot.stars || 0 : 0,
      epoch: matches ? snapshot.starEpoch : 0,
      now: Date.now(),
      reducedMotion: reduced,
      paused: !matches || live2d || Boolean(snapshot.starPaused),
      pausedAt: matches ? snapshot.starPausedAt : null,
      variant: skin,
    });
    stars.classList.toggle('is-star-celebrating', Boolean(matches && snapshot.starCelebrating));
    if (matches) {
      this.dataset.visualAt = String(snapshot.at); this.dataset.visualBehavior = snapshot.behavior; this.dataset.visualVariant = snapshot.variant; this.dataset.visualStars = String(snapshot.stars || 0);
      if (!live2d) this.dataset.previewState = 'ready';
    } else if (!live2d) this.dataset.previewState = 'waiting';
    const animations = stage.getAnimations({ subtree: true });
    const elapsed = matches ? Math.max(0, Date.now() - snapshot.at) : 0;
    for (const animation of animations) {
      if (!animation.animationName) continue;
      // Star particles use the same deterministic balance/epoch renderer in
      // both windows; no per-particle IPC frame or second random timeline.
      if (animation.effect?.target?.closest('.star-lights')) continue;
      const key = animation.effect?.target?.dataset.visualKey;
      const frame = matches && snapshot.animations?.find(item => item.target === key && item.name === animation.animationName);
      if (!frame || reduced || live2d) { animation.pause(); continue; }
      const end = animation.effect.getComputedTiming().endTime;
      const time = frame.time + (frame.rate > 0 ? elapsed * frame.rate : 0);
      if (frame.rate === 0 || Number.isFinite(end) && time >= end) animation.pause();
      else { animation.playbackRate = frame.rate; if (animation.playState !== 'running') animation.play(); }
      animation.currentTime = Number.isFinite(end) ? Math.min(time, end) : time;
    }
  }
}

if (!customElements.get('tide-pet-preview')) customElements.define('tide-pet-preview', TidePetPreview);
