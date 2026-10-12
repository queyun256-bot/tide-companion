// Movement comes only from fresh held-pointer events. Timers only cancel.
const IDLE_MS = 2500, MAX_DRAG_MS = 30000;
export function installFinDrag({ stage, handle, api, onStart, onEnd }) {
  let press = null, holdTimer, idleTimer, hardTimer, releaseTimer, requestSequence = 0;
  const listeners = [];
  const listen = (target, type, callback, options) => { target.addEventListener(type, callback, options); listeners.push(() => target.removeEventListener(type, callback, options)); };
  function endRemote(token) { if (token) api?.endPetDrag?.({ token }).catch(() => {}); }
  function finish(expected = press) {
    if (!expected || press !== expected) return;
    press = null;
    clearTimeout(holdTimer); clearTimeout(idleTimer); clearTimeout(hardTimer);
    // Relinquish ownership first: lostpointercapture can fire synchronously.
    try { if (handle.hasPointerCapture(expected.pointerId)) handle.releasePointerCapture(expected.pointerId); } catch { /* Pointer/window already gone. */ }
    stage.classList.remove('is-drag-preparing', 'is-dragging');
    if (expected.active) {
      stage.classList.add('is-drag-releasing'); clearTimeout(releaseTimer);
      releaseTimer = setTimeout(() => stage.classList.remove('is-drag-releasing'), 700);
      onEnd?.(Date.now() - expected.startedAt);
    }
    endRemote(expected.token);
  }
  function refreshLocalTimeout(current) { clearTimeout(idleTimer); idleTimer = setTimeout(() => finish(current), IDLE_MS); }
  async function sendMove(current) {
    if (press !== current || !current.active || current.inFlight || !current.pendingMove) return;
    const move = current.pendingMove; current.pendingMove = null; current.inFlight = true;
    try {
      const result = await api.movePetDrag({ token: current.token, pointerId: current.pointerId, buttons: move.buttons, sequence: ++current.moveSequence });
      if (press === current && !result) finish(current);
    } catch { finish(current); }
    finally {
      current.inFlight = false;
      // Coalesce real input received during IPC; never manufacture another move.
      if (press === current && current.pendingMove) sendMove(current);
    }
  }
  listen(handle, 'pointerdown', event => {
    if (event.button !== 0 || !(event.buttons & 1) || !event.isPrimary || !api?.startPetDrag) return;
    finish(); event.preventDefault(); event.stopPropagation();
    const current = { pointerId: event.pointerId, requestId: ++requestSequence, x: event.screenX, y: event.screenY, lastX: event.screenX, lastY: event.screenY, active: false, startedAt: 0, token: null, moveSequence: 0, inFlight: false, pendingMove: null };
    press = current;
    try { handle.setPointerCapture(event.pointerId); } catch { finish(current); return; }
    stage.classList.remove('is-drag-releasing'); stage.classList.add('is-drag-preparing');
    holdTimer = setTimeout(async () => {
      try {
        const result = await api.startPetDrag({ pointerId: current.pointerId, requestId: current.requestId, buttons: 1 });
        if (!result?.token) { finish(current); return; }
        if (press !== current) { endRemote(result.token); return; }
        current.token = result.token; current.active = true; current.startedAt = Date.now();
        stage.classList.remove('is-drag-preparing'); stage.classList.add('is-dragging');
        refreshLocalTimeout(current); hardTimer = setTimeout(() => finish(current), MAX_DRAG_MS); onStart?.();
      } catch { finish(current); }
    }, 450);
  });
  const pointerMove = event => {
    const current = press;
    if (!current || event.pointerId !== current.pointerId) return;
    if (!(event.buttons & 1)) { finish(current); return; }
    if (!current.active) { if (Math.hypot(event.screenX - current.x, event.screenY - current.y) > 9) finish(current); return; }
    // Moving the HWND may cause a local pointermove at the SAME screen point.
    if (event.screenX === current.lastX && event.screenY === current.lastY) return;
    current.lastX = event.screenX; current.lastY = event.screenY; refreshLocalTimeout(current);
    current.pendingMove = { buttons: event.buttons }; sendMove(current);
  };
  const release = event => { if (press && (event.pointerId === undefined || event.pointerId === press.pointerId)) finish(); };
  listen(window, 'pointermove', pointerMove, true);
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) listen(window, name, release, true);
  listen(window, 'mouseup', event => { if (event.button === 0) finish(); }, true);
  listen(handle, 'click', event => { event.preventDefault(); event.stopPropagation(); });
  listen(document, 'keydown', event => { if (event.key === 'Escape' && press) { event.preventDefault(); event.stopImmediatePropagation(); finish(); } }, true);
  listen(window, 'blur', () => finish());
  listen(document, 'visibilitychange', () => { if (document.hidden) finish(); });
  const stopCancel = api?.onPetDragCancelled?.(event => { if (press && (press.token === event?.token || press.requestId === event?.requestId)) finish(); });
  return { get active() { return Boolean(press?.active); }, cancel: () => finish(), dispose() { finish(); clearTimeout(releaseTimer); for (const remove of listeners) remove(); stopCancel?.(); } };
}
