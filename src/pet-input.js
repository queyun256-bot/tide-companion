// Transparent pixels are not automatically click-through on Windows. Keep
// native mouse handling enabled only over the visible companion and its UI.
const SHAPES = 'path,ellipse,circle,rect,line,polygon,polyline';
const DECORATION = '.shark-shadow,.little-stars,.star-lights,.starfield,.sparkles,.sleep-sign,defs';

function visible(element, stage, styles) {
  for (let node = element; node && node !== stage.parentElement; node = node.parentElement) {
    if (node.hidden || node.getAttribute('aria-hidden') === 'true' && node.matches('.speech')) return false;
    let style = styles.get(node);
    if (!style) { style = getComputedStyle(node); styles.set(node, style); }
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) < .015) return false;
  }
  return true;
}
const within = (bounds,x,y,padding=0) => bounds.width > 0 && bounds.height > 0 && x >= bounds.left-padding && x <= bounds.right+padding && y >= bounds.top-padding && y <= bounds.bottom+padding;
function insideShape(shape,x,y,styles,includeTransparentFill=false) {
  if (!within(shape.getBoundingClientRect(),x,y,4)) return false;
  const matrix = shape.getScreenCTM();
  if (!matrix) return false;
  const point = new DOMPoint(x,y).matrixTransform(matrix.inverse());
  const style = styles.get(shape) || getComputedStyle(shape);
  const fill = includeTransparentFill || style.fill !== 'none' && style.fill !== 'rgba(0, 0, 0, 0)' && style.fillOpacity !== '0';
  const stroke = style.stroke !== 'none' && style.stroke !== 'rgba(0, 0, 0, 0)' && style.strokeOpacity !== '0' && parseFloat(style.strokeWidth) > 0;
  return Boolean(fill && shape.isPointInFill?.(point) || stroke && shape.isPointInStroke?.(point));
}

/** CSS client coordinates only; SVG screen CTM includes CSS transforms and viewBox scale. */
export function petPointIsInteractive(stage, x, y, {includeUi=true}={}) {
  if (!stage?.isConnected || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > innerWidth || y > innerHeight) return false;
  const styles = new Map();
  for (const element of includeUi ? stage.querySelectorAll('.pet-controls,.speech') : []) {
    if (visible(element,stage,styles) && getComputedStyle(element).pointerEvents !== 'none' && within(element.getBoundingClientRect(),x,y)) return true;
  }
  // The draggable fin has a deliberately transparent fill but a visible fin
  // beneath it. Its path, not the overlay SVG rectangle, is the target.
  for (const shape of stage.querySelectorAll('.drag-handle path')) {
    try { if (visible(shape,stage,styles) && insideShape(shape,x,y,styles,true)) return true; } catch { /* Detached/transient transforms are not hit regions. */ }
  }
  if (stage.classList.contains('live2d-active')) {
    // Imported models expose a canvas, not SVG geometry. Use that visible model
    // viewport as a conservative fallback; the surrounding window still passes through.
    const canvas = stage.querySelector('#live2d-canvas');
    return Boolean(canvas && visible(canvas,stage,styles) && within(canvas.getBoundingClientRect(),x,y));
  }
  for (const shape of stage.querySelectorAll(`#builtin-pet svg ${SHAPES.split(',').join(',#builtin-pet svg ')}`)) {
    if (shape.closest(DECORATION)) continue;
    try { if (visible(shape,stage,styles) && insideShape(shape,x,y,styles)) return true; } catch { /* A removed shape cannot capture the desktop. */ }
  }
  return false;
}

export function installPetInput({stage,api}) {
  if (!stage || !api?.setPetPointerPassthrough) return {recheck(){},dispose(){}};
  const listeners = new AbortController(), signal = listeners.signal;
  const pointers = new Set();
  let point = null, requested = null, frame = 0, forceNextCheck = false, disposed = false;
  function setIgnore(ignore, force=false) {
    if (disposed || !force && requested === ignore) return;
    requested = ignore;
    try { Promise.resolve(api.setPetPointerPassthrough(ignore)).catch(() => { requested = null; }); }
    catch { requested = null; }
  }
  function recheck(force=false) {
    if (disposed) return;
    if (document.visibilityState === 'hidden' || !stage.isConnected) { setIgnore(true,force); return; }
    // Ignore+forward on Windows forwards mousemove only (with buttons=0), not
    // mouseup. Never enable it during a press or an active carry gesture.
    if (pointers.size || stage.classList.contains('is-dragging') || stage.classList.contains('is-drag-preparing') || stage.classList.contains('is-star-feed-drag')) { setIgnore(false,force); return; }
    setIgnore(!point || !petPointIsInteractive(stage,point.x,point.y),force);
  }
  function queueCheck(force=false) {
    forceNextCheck ||= force === true;
    if (frame || disposed) return;
    frame = requestAnimationFrame(() => { frame = 0; const force = forceNextCheck; forceNextCheck = false; recheck(force); });
  }
  function releasePointer(event) {
    if (event?.pointerId !== undefined) pointers.delete(event.pointerId); else pointers.clear();
    if (event?.type === 'pointerup') point = {x:event.clientX,y:event.clientY};
    if (event?.type === 'blur' || event?.type === 'pointercancel') point = null;
    // Leave the native target intact through mouseup/click. Gesture handlers
    // also get time to release capture and clear their active classes.
    queueCheck(true);
  }
  document.addEventListener('mousemove',event => {
    point = {x:event.clientX,y:event.clientY};
    if (pointers.size && event.buttons === 0) pointers.clear();
    recheck();
  },{capture:true,signal});
  document.addEventListener('pointerdown',event => {
    if (!stage.contains(event.target)) return;
    point = {x:event.clientX,y:event.clientY}; pointers.add(event.pointerId);setIgnore(false,true);
  },{capture:true,signal});
  for (const event of ['pointerup','pointercancel','lostpointercapture']) document.addEventListener(event,releasePointer,{capture:true,signal});
  document.addEventListener('mouseleave',() => { point = null; if (!pointers.size) recheck(); },{signal});
  window.addEventListener('blur',releasePointer,{signal});
  window.addEventListener('resize',queueCheck,{signal});
  const hide = () => { pointers.clear();point = null;setIgnore(true,true); };
  window.addEventListener('pagehide',hide,{signal});
  document.addEventListener('visibilitychange',() => { if (document.visibilityState === 'hidden') hide(); else queueCheck(); },{signal});
  document.addEventListener('tide-star-feed-session-end',() => { pointers.clear();point = null;queueCheck(true); },{signal});
  const stopDragCancelled = api.onPetDragCancelled?.(() => { pointers.clear();point = null;queueCheck(true); });
  const observer = new MutationObserver(queueCheck);
  observer.observe(stage,{attributes:true,subtree:true,childList:true,attributeFilter:['class','hidden','aria-hidden','style']});
  // Continuous SVG animation can move an edge even while the pointer is still.
  const timer = setInterval(() => { if (point && !pointers.size) queueCheck(); },120);
  recheck();
  return {recheck,dispose() {
    if (disposed) return;
    pointers.clear();point = null;setIgnore(true,true);disposed = true;
    listeners.abort();observer.disconnect();stopDragCancelled?.();clearInterval(timer);cancelAnimationFrame(frame);
  }};
}
