'use strict';

const PET_WINDOW_SIZE = Object.freeze({ width: 320, height: 370 });

function movePetWindow(pet, position) {
  if (!Number.isFinite(position?.x) || !Number.isFinite(position?.y)) throw new Error('桌宠位置无效。');
  // On Windows with fractional scaling, setPosition() round-trips the current
  // native size through DIPs and can enlarge the HWND on every move. Always
  // write the designed logical size, never a size read back from getBounds().
  pet.setBounds({ x: Math.round(position.x), y: Math.round(position.y), ...PET_WINDOW_SIZE }, false);
}

module.exports = { PET_WINDOW_SIZE, movePetWindow };
