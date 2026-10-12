// Both windows attach these two small overlays to the shared SVG rig. The
// desktop publishes their animation times; the preview never starts a new event.
export function ensurePetStarEffects(stage) {
  const float = stage.querySelector('.float-wrap');
  if (!float || float.querySelector('.mouth-star')) return;
  const mouth = document.createElement('span');
  mouth.className = 'mouth-star'; mouth.dataset.visualKey = 'mouth-star';
  mouth.textContent = '✦'; mouth.setAttribute('aria-hidden', 'true');
  const born = document.createElement('span');
  born.className = 'born-stars'; born.dataset.visualKey = 'born-stars';
  born.setAttribute('aria-hidden', 'true');
  for (const name of ['left', 'middle', 'right']) {
    const point = document.createElement('i'); point.className = `born-star-${name}`; point.textContent = '✦'; born.append(point);
  }
  const amount = document.createElement('b'); amount.className = 'born-stars-amount'; born.append(amount);
  float.append(mouth, born);
}

export function setProducedAmount(stage, amount) {
  const value = Number.isInteger(amount) ? Math.max(0, Math.min(10, amount)) : 0;
  if (stage.dataset.starProducedAmount !== String(value)) stage.dataset.starProducedAmount = String(value);
  const label = stage.querySelector('.born-stars-amount');
  if (label) label.textContent = value ? `＋${value}` : '';
}
