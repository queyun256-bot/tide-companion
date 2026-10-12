const CLASSES = /^(?:is-(?:drowsy|sleeping|waking|blinking|enjoying-touch|dragging|drag-preparing|drag-releasing)|action-(?:pat|stroke|feed|nuzzle|tilt|blink|nod|stretch|wiggle|wave|scarf|sway|peek|tailcurl|bob|star-eat|star-produce))$/;
export function publishCompanionVisual(stage, api, motionPreference, idleSignal = () => ({})) {
  if (!api?.publishPetVisual) return () => {};
  const keys = { float: '.float-wrap', body: '#builtin-pet', 'fin-left': '.fin-left', 'fin-right': '.fin-right', tail: '.tail', eyes: '.eyes', 'eye-left': '.eye-left', 'eye-right': '.eye-right', face: '.face', gaze: '.eye-gaze', smile: '.smile', yawn: '.yawn', stars: '.star-lights', sleep: '.sleep-sign', 'mouth-star': '.mouth-star', 'born-stars': '.born-stars' };
  for (const [key, selector] of Object.entries(keys)) stage.querySelector(selector)?.setAttribute('data-visual-key', key);
  let scheduled = false, stopped = false, transitionTimer;
  function publish() {
    scheduled = false;
    if (stopped || !stage.dataset.behavior) return;
    const computed = getComputedStyle(stage), variables = {};
    for (const key of ['--gaze-x', '--gaze-y', '--fin-duration', '--breath-duration']) variables[key] = computed.getPropertyValue(key).trim();
    const animations = [], transitioning = [];
    for (const element of stage.querySelectorAll('[data-visual-key]')) for (const animation of element.getAnimations()) {
      if (animation instanceof CSSTransition && animation.playState === 'running') transitioning.push(element.dataset.visualKey);
      if (!animation.animationName || !Number.isFinite(animation.currentTime)) continue;
      animations.push({ target: element.dataset.visualKey, name: animation.animationName, time: animation.currentTime, rate: animation.playState === 'paused' ? 0 : animation.playbackRate });
    }
    const stars = stage.querySelector('.star-lights');
    const pose = {};
    for (const [key, target, property] of [['bodyTransform','body','transform'],['eyesTransform','eyes','transform'],['faceTransform','face','transform'],['gazeTransform','gaze','transform'],['finLeftTransform','fin-left','transform'],['finRightTransform','fin-right','transform'],['smileOpacity','smile','opacity'],['yawnOpacity','yawn','opacity']]) pose[key] = getComputedStyle(stage.querySelector(`[data-visual-key="${target}"]`))[property];
    api.publishPetVisual({ ...idleSignal(), starProducedAmount: Number(stage.dataset.starProducedAmount) || 0, version: 1, at: Date.now(), behavior: stage.dataset.behavior, mood: stage.dataset.mood || 'okay', variant: stage.dataset.variant || 'builtin', classes: [...stage.classList].filter(item => CLASSES.test(item)), variables, pose, transitioning: [...new Set(transitioning)], stars: Number(stars.dataset.count) || 0, starsVisible: stars.classList.contains('is-visible'), starEpoch:Number(stars.dataset.starEpoch)||0, starPaused:stars.dataset.starPaused==='true', starPausedAt:Number(stars.dataset.starPausedAt)||0, starCelebrating:stars.classList.contains('is-star-celebrating'), reducedMotion: document.documentElement.classList.contains('reduced-motion') || motionPreference.matches, hidden: document.hidden, live2d: stage.classList.contains('live2d-active'), animations }).catch(() => {});
    clearTimeout(transitionTimer);
    if (transitioning.length && !document.hidden) transitionTimer = setTimeout(schedule, 40);
  }
  function schedule() { if (!scheduled) { scheduled = true; requestAnimationFrame(publish); } }
  const observer = new MutationObserver(schedule);
  observer.observe(stage, { attributes: true, subtree: true, attributeFilter: ['class', 'style', 'data-behavior', 'data-mood', 'data-variant', 'data-count'] });
  const heartbeat = setInterval(publish, 400);
  document.addEventListener('visibilitychange', schedule);
  schedule();
  return () => { stopped = true; observer.disconnect(); clearInterval(heartbeat); clearTimeout(transitionTimer); document.removeEventListener('visibilitychange', schedule); };
}
