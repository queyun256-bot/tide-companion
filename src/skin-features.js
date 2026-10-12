import { isBuiltinShark } from './shark-variants.js';

// Presentation/runtime switch only: imported files and the saved activeSkin
// remain intact so hiding the feature never rewrites an existing library.
export const LIVE2D_ENABLED = false;
export const visibleSkinId = id => LIVE2D_ENABLED || isBuiltinShark(id) ? (id || 'builtin') : 'builtin';
