import { LIVE2D_ENABLED } from './skin-features.js';

(() => {
  'use strict';
  const canvas = document.getElementById('live2d-canvas');
  const motionPreference = matchMedia('(prefers-reduced-motion: reduce)');
  let runtime, app, model;
  let revision = 0, selected = 'builtin', reduced = false, sleeping = false, scale = 1, loadingId = null;
  let lastOptions = {};
  const width = 296, height = 264;
  const builtinIds = new Set(['builtin', 'builtin-rose', 'builtin-mint', 'builtin-peach', 'builtin-lilac']);
  function status(state, message = '') {
    canvas.dataset.status = state;
    document.dispatchEvent(new CustomEvent('live2d-status', { detail: { state, message } }));
  }
  function script(file) {
    return new Promise((resolve, reject) => {
      const element = document.createElement('script');
      element.src = new URL(`assets/vendor/${file}`, document.baseURI).href;
      element.onload = resolve;
      element.onerror = () => { element.remove(); reject(new Error('本地 Live2D 运行库缺失。')); };
      document.head.append(element);
    });
  }
  function loadRuntime() {
    if (!runtime) runtime = (async () => {
      await script('live2dcubismcore.min.js');
      await script('pixi.min.js');
      await script('pixi-csp.min.js');
      await script('cubism4.min.js');
      if (!window.PIXI?.live2d?.Live2DModel) throw new Error('Live2D 运行库未能初始化。');
      window.PIXI.live2d.config.sound = false;
      window.PIXI.live2d.config.logLevel = window.PIXI.live2d.config.LOG_LEVEL_ERROR;
    })().catch(error => { runtime = null; throw error; });
    return runtime;
  }
  function clearModel() {
    app?.stop();
    if (model) { app?.stage.removeChild(model); model.destroy({ children: true, texture: true, baseTexture: true }); model = undefined; }
    if (app) app.renderer.clear();
    canvas.hidden = true;
  }
  function fit() {
    if (!model) return;
    model.scale.set(1);
    const factor = Math.min((width - 20) / model.width, (height - 12) / model.height) * scale;
    if (!Number.isFinite(factor) || factor <= 0) throw new Error('模型尺寸无效。');
    model.anchor.set(.5, .5);
    model.scale.set(factor);
    model.position.set(width / 2, height / 2 + 3);
    app.render();
  }
  function playback() {
    if (!app || !model) return;
    if (reduced || motionPreference.matches || sleeping || document.hidden) {
      app.stop();
      model.internalModel.motionManager.stopAllMotions();
      // Freeze the frame already on screen. Cubism update(0) can still change
      // physics/expressions; repeated visual snapshots must not advance it.
    } else app.start();
  }
  async function switchSkin(settings = {}) {
    if (!LIVE2D_ENABLED) {
      revision += 1; loadingId = null; selected = 'builtin'; clearModel();
      status('disabled');
      return;
    }
    lastOptions = settings;
    reduced = Boolean(settings.reducedMotion);
    scale = Math.min(2, Math.max(.5, Number(settings.skinScale) || 1));
    const id = settings.activeSkin || 'builtin';
    if (id === selected && loadingId === id) return;
    if (id === selected && (model || builtinIds.has(id))) { fit(); playback(); return; }
    selected = id;
    const currentRevision = ++revision;
    clearModel();
    if (builtinIds.has(id)) { loadingId = null; status('builtin'); return; }
    loadingId = id;
    status('loading');
    try {
      const library = await window.petAPI.listSkins();
      const skin = library.skins.find(item => item.id === id);
      if (!skin?.modelUrl || new URL(skin.modelUrl).protocol !== 'tide-skin:') throw new Error('找不到已导入的模型。');
      await loadRuntime();
      if (currentRevision !== revision) return;
      if (!app) {
        app = new window.PIXI.Application({ view: canvas, width, height, backgroundAlpha: 0, antialias: true, autoStart: false, sharedTicker: false, resolution: Math.min(2, devicePixelRatio || 1), autoDensity: true });
        app.ticker.maxFPS = 30;
        app.ticker.add(() => { if (model) model.update(app.ticker.deltaMS); });
      }
      let expired = false, timeout;
      const pending = window.PIXI.live2d.Live2DModel.from(skin.modelUrl, { autoUpdate: false, autoInteract: false, motionPreload: 'IDLE' });
      pending.then(value => { if (expired || currentRevision !== revision) value.destroy({ texture: true, baseTexture: true }); }).catch(() => {});
      let loaded;
      try { loaded = await Promise.race([pending, new Promise((_, reject) => { timeout = setTimeout(() => { expired = true; reject(new Error('模型加载超时，请检查模型文件。')); }, 20000); })]); }
      finally { clearTimeout(timeout); }
      if (currentRevision !== revision) return;
      model = loaded;
      app.stage.addChild(model);
      fit();
      canvas.hidden = false;
      model.update(0);
      app.render();
      playback();
      status('ready');
    } catch (error) {
      if (currentRevision !== revision) return;
      clearModel();
      status('error', `模型暂时无法显示，已换回鲨鱼。${error?.message || '请重新导入模型。'}`);
    } finally {
      if (currentRevision === revision) loadingId = null;
    }
  }
  function interact(action) {
    if (!model || reduced || motionPreference.matches || sleeping) return;
    const manager = model.internalModel.motionManager;
    const groups = Object.keys(manager.definitions).filter(key => manager.definitions[key]?.length);
    const preference = action === 'feed' ? /eat|feed|happy|tapbody|tap_body|tap/i : /tap|touch|happy|flick/i;
    const group = groups.find(key => preference.test(key)) || groups.find(key => key !== manager.groups.idle);
    if (group) model.motion(group, undefined, 3).catch(() => {});
    else model.expression().catch(() => {});
  }
  canvas.addEventListener('webglcontextlost', event => { event.preventDefault(); revision += 1; clearModel(); status('error', '绘图连接暂时中断，已换回鲨鱼。'); });
  canvas.addEventListener('webglcontextrestored', () => { app?.destroy(false); app = undefined; selected = ''; switchSkin(lastOptions); });
  document.addEventListener('visibilitychange', playback);
  motionPreference.addEventListener('change', playback);
  window.TideLive2D = Object.freeze({
    switchSkin, interact,
    setSleeping(value) { if (sleeping === Boolean(value)) return; sleeping = Boolean(value); playback(); },
    focus(clientX, clientY) {
      if (!model || reduced || motionPreference.matches || sleeping) return;
      const rect = canvas.getBoundingClientRect();
      model.focus((clientX - rect.left) * width / rect.width, (clientY - rect.top) * height / rect.height);
    },
    get active() { return Boolean(model); },
    dispose() { revision += 1; clearModel(); app?.destroy(false); app = undefined; motionPreference.removeEventListener('change', playback); document.removeEventListener('visibilitychange', playback); }
  });
  window.addEventListener('beforeunload', () => window.TideLive2D.dispose());
})();
