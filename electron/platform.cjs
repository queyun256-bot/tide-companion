'use strict';

// These are capabilities of this release, not claims about every OS API.
// macOS has no verified fullscreen watcher in this build, and automatic login
// management stays unavailable in the ad-hoc-signed, unnotarized distribution.
function platformInfo(platform = process.platform) {
  return {
    id: platform,
    label: platform === 'win32' ? 'Windows' : platform === 'darwin' ? 'macOS' : '桌面',
    fullscreenDetection: platform === 'win32',
    automaticLoginSettings: platform === 'win32',
  };
}

function userDataFolder(platform = process.platform) {
  // Preserve the existing Windows data directory across the product rename.
  return platform === 'darwin' ? '潮汐' : '小浪桌宠';
}

function loginItemOptions(enabled, platform = process.platform, execPath = process.execPath, appId) {
  const openAtLogin = enabled === true;
  if (platform === 'win32') return { openAtLogin, name: appId, path: execPath, args: ['--hidden'] };
  // path/name/args are Windows options. macOS uses its application bundle.
  return { openAtLogin };
}

function startupHidden({ platform = process.platform, argv = [], loginSettings = {} } = {}) {
  return argv.includes('--hidden') || (platform === 'darwin' && loginSettings?.wasOpenedAtLogin === true);
}

module.exports = { platformInfo, userDataFolder, loginItemOptions, startupHidden };
