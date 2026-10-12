'use strict';
const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  if (typeof callback !== 'function') throw new TypeError('Expected a callback');
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('petAPI', Object.freeze({
  getPlatform: () => ipcRenderer.invoke('app:platform'),
  loadState: () => ipcRenderer.invoke('state:load'),
  saveState: (state) => ipcRenderer.invoke('state:save', state),
  onState: (callback) => subscribe('state:changed', callback),
  onPetAction: (callback) => subscribe('pet:action', callback),
  openDashboard: () => ipcRenderer.invoke('window:dashboard'),
  toggleDashboard: () => ipcRenderer.invoke('window:dashboard-toggle'),
  dashboardVisible: () => ipcRenderer.invoke('window:dashboard-visible'),
  onDashboardVisibility: (callback) => subscribe('window:dashboard-visibility', callback),
  showPet: () => ipcRenderer.invoke('window:pet-show'),
  hidePet: () => ipcRenderer.invoke('window:pet-hide'),
  petAction: (action) => ipcRenderer.invoke('pet:interact', action),
  startPetDrag: (input) => ipcRenderer.invoke('pet:drag-start', input),
  movePetDrag: (input) => ipcRenderer.invoke('pet:drag-move', input),
  endPetDrag: (input) => ipcRenderer.invoke('pet:drag-end', input),
  onPetDragCancelled: (callback) => subscribe('pet:drag-cancelled', callback),
  setPetPointerPassthrough: (ignore) => ipcRenderer.send('pet:pointer-passthrough', ignore),
  beginStarFeed: (input) => ipcRenderer.invoke('pet:star-feed-begin', input),
  commitStarFeed: (input) => ipcRenderer.invoke('pet:star-feed-commit', input),
  cancelStarFeed: (input) => ipcRenderer.invoke('pet:star-feed-cancel', input),
  onStarFeedSession: (callback) => subscribe('pet:star-feed-session', callback),
  publishPetVisual: (snapshot) => ipcRenderer.invoke('pet:visual-publish', snapshot),
  getPetVisual: () => ipcRenderer.invoke('pet:visual-get'),
  onPetVisual: (callback) => subscribe('pet:visual-state', callback),
  notifyTest: () => ipcRenderer.invoke('notification:test'),
  exportData: () => ipcRenderer.invoke('data:export'),
  importData: () => ipcRenderer.invoke('data:import'),
  listSkins: () => ipcRenderer.invoke('skins:list'),
  importSkin: () => ipcRenderer.invoke('skins:import'),
  selectSkin: (id, scale) => ipcRenderer.invoke('skins:select', id, scale),
  removeSkin: (id) => ipcRenderer.invoke('skins:remove', id),
  quit: () => ipcRenderer.invoke('app:quit'),
  openExternal: (url) => ipcRenderer.invoke('link:open', url),
}));
