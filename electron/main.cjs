'use strict';
const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, Notification, dialog, shell, powerMonitor, screen, session, protocol } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { createStateStore, validateState, parseState, MAX_BYTES, ACTIONS } = require('./state.cjs');
const { appendDailyMood, restoreDailyMoods } = require('./daily-moods.cjs');
const { rewardNewDoses, mergeStarWallet, balance: starBalance } = require('./star-wallet.cjs');
const createTrayPng = require('./tray-icon.cjs');
const { createSkinStore, BUILTIN_SHARKS, isBuiltinShark } = require('./skins.cjs');
const { watchFullscreen } = require('./fullscreen.cjs');
const { setupPetDesktop } = require('./pet-desktop.cjs');
const { PET_WINDOW_SIZE, movePetWindow } = require('./pet-window.cjs');
const { setupPetGrowthDesktop } = require('./pet-growth-desktop.cjs');
const { platformInfo, userDataFolder, loginItemOptions, startupHidden } = require('./platform.cjs');
const PLATFORM = platformInfo(process.platform);
let desktopPet, growthDesktop;

// Rename the application without moving existing records or overriding an
// explicitly supplied userData directory (including isolated native tests).
const initialUserData = app.getPath('userData');
const initialDefaultUserData = path.join(app.getPath('appData'), app.getName());
app.setName('潮汐');
app.setPath('userData', path.resolve(initialUserData) === path.resolve(initialDefaultUserData)
  ? path.join(app.getPath('appData'), userDataFolder(process.platform)) : initialUserData);
const APP_USER_MODEL_ID = 'org.transpet.desktop';
if (process.platform === 'win32') app.setAppUserModelId(APP_USER_MODEL_ID);
protocol.registerSchemesAsPrivileged([{ scheme: 'tide-skin', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
const ROOT = path.resolve(__dirname, '..');
function appIcon() {
  try { return nativeImage.createFromBuffer(fs.readFileSync(path.join(ROOT, 'assets/app.png'))); }
  catch { return nativeImage.createFromBuffer(createTrayPng()); }
}
function trayIcon() {
  const icon = appIcon();
  return process.platform === 'darwin' ? icon.resize({ width: 18, height: 18 }) : icon;
}

function configureApplicationMenu() {
  if (process.platform !== 'darwin') return;
  app.setAboutPanelOptions({ applicationName: '潮汐', applicationVersion: app.getVersion(), copyright: '潮汐', iconPath: path.join(ROOT, 'assets/app.png') });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '潮汐', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
    { label: '手账', submenu: [{ label: '打开手账', accelerator: 'Cmd+1', click: openDashboard }, { role: 'close' }] },
    { role: 'editMenu' },
    { role: 'windowMenu' },
  ]));
}

function shouldStartHidden() {
  let loginSettings;
  if (process.platform === 'darwin' && app.isPackaged) {
    try { loginSettings = app.getLoginItemSettings(); } catch { /* Manual launch stays visible. */ }
  }
  return startupHidden({ platform: process.platform, argv: process.argv, loginSettings });
}
function taskbarIconPath() {
  // The Windows shell cannot read assets inside app.asar. The packager copies
  // this ICO beside it with a content-derived name, so an icon update also gets
  // a fresh shell-cache key without clearing any system cache.
  const source = path.join(ROOT, 'assets/app.ico');
  if (!app.isPackaged) return source;
  try {
    const digest = crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex').slice(0, 12);
    const external = path.join(process.resourcesPath, `tide-app-${digest}.ico`);
    if (fs.existsSync(external)) return external;
  } catch { /* The executable still contains the same application icon. */ }
  return process.execPath;
}

function configureWindowIdentity(window) {
  if (process.platform !== 'win32') return;
  window.setAppDetails({
    appId: APP_USER_MODEL_ID,
    appIconPath: taskbarIconPath(),
    appIconIndex: 0,
    relaunchCommand: app.isPackaged ? `"${process.execPath}"` : `"${process.execPath}" "${ROOT}"`,
    relaunchDisplayName: '潮汐',
  });
}
const PAGES = new Set([path.join(ROOT, 'index.html').toLowerCase(), path.join(ROOT, 'pet.html').toLowerCase()]);
const DOC_HOSTS = new Set(['dailymed.nlm.nih.gov', 'www.accessdata.fda.gov', 'accessdata.fda.gov', 'transcare.ucsf.edu', 'pubmed.ncbi.nlm.nih.gov', 'pmc.ncbi.nlm.nih.gov', 'academic.oup.com', 'www.fda.gov', 'www.medicines.org.uk', 'medlineplus.gov', 'hrt.mahiro.uk', 'github.com']);
let dashboard = null;
let pet = null;
let tray = null;
let quitting = false;
let state;
let store;
let skinStore;
let fullscreenSuppressed = false;
let stopFullscreenWatch;
let timer;
let reminders;
let tickRunning = false;
let failureShown = false;
let desktopReady = false;
let dashboardOpenRequested = false;
const activeNotifications = new Set();
const petName = () => state?.settings?.name ?? '鲨鲨';
const effectivePetVisible = () => state.settings.petVisible && !(state.settings.autoHideFullscreen && fullscreenSuppressed);

function trustedSender(event) {
  if (event.senderFrame !== event.sender.mainFrame) return false;
  if (![dashboard?.webContents, pet?.webContents].includes(event.sender)) return false;
  try {
    const url = new URL(event.senderFrame.url);
    return url.protocol === 'file:' && PAGES.has(path.resolve(fileURLToPath(url)).toLowerCase());
  } catch { return false; }
}

function handle(channel, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!trustedSender(event)) throw new Error('此页面无权访问桌面功能。');
    return handler(...args);
  });
}

function broadcast(channel, value) {
  for (const window of [dashboard, pet]) {
    if (window && !window.isDestroyed()) window.webContents.send(channel, value);
  }
}

function lockWindow(window) {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.on('will-redirect', (event) => event.preventDefault());
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
}

function webPreferences() {
  return { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, allowRunningInsecureContent: false, spellcheck: false };
}

function openDashboard() {
  // A second launch can arrive while startup is still loading local modules.
  // Queue it until state and IPC are ready instead of creating an early window.
  if (!desktopReady) { dashboardOpenRequested = true; return; }
  if (!dashboard || dashboard.isDestroyed()) createDashboard();
  if (dashboard.isMinimized()) dashboard.restore();
  dashboard.show();
  dashboard.focus();
}

function dashboardVisibility() {
  return Boolean(dashboard && !dashboard.isDestroyed() && dashboard.isVisible() && !dashboard.isMinimized());
}

function broadcastDashboardVisibility() {
  broadcast('window:dashboard-visibility', dashboardVisibility());
}

function toggleDashboard() {
  // A minimized window is treated as tucked away, so the first click restores it.
  if (dashboardVisibility()) dashboard.hide();
  else openDashboard();
  return dashboardVisibility();
}

function createDashboard() {
  const area = screen.getPrimaryDisplay().workArea;
  dashboard = new BrowserWindow({
    title: '潮汐 · 手账', width: Math.min(1220, area.width), height: Math.min(860, area.height), minWidth: 860, minHeight: 620,
    show: false, backgroundColor: '#fffafb', autoHideMenuBar: true, icon: appIcon(), webPreferences: webPreferences(),
  });
  configureWindowIdentity(dashboard);
  dashboard.on('page-title-updated', event => event.preventDefault());
  lockWindow(dashboard);
  growthDesktop?.attachWindow(dashboard);
  for (const event of ['show', 'hide', 'minimize', 'restore']) dashboard.on(event, broadcastDashboardVisibility);
  dashboard.on('close', (event) => { if (!quitting) { event.preventDefault(); dashboard.hide(); } });
  dashboard.on('closed', () => { dashboard = null; broadcastDashboardVisibility(); });
  dashboard.once('ready-to-show', () => {
    // Login startup may request a hidden journal. Until initial setup has been
    // completed, that would also conceal the only mode/weight welcome dialog.
    if (!shouldStartHidden() || !state.settings.onboardingCompleted || dashboardOpenRequested) dashboard?.show();
    dashboardOpenRequested = false;
  });
  dashboard.loadFile(path.join(ROOT, 'index.html')).catch(() => dialog.showErrorBox(`无法打开${petName()}`, '应用界面文件缺失，请重新安装或在完整项目目录中启动。'));
}

function petPosition() {
  const { x, y, width, height } = screen.getPrimaryDisplay().workArea;
  return { x: x + Math.max(0, width - PET_WINDOW_SIZE.width - 20), y: y + Math.max(0, height - PET_WINDOW_SIZE.height - 20) };
}

function createPet() {
  const position = petPosition();
  pet = new BrowserWindow({
    title: `${petName()}桌宠`, ...PET_WINDOW_SIZE, ...position, show: false, frame: false, transparent: true, backgroundColor: '#00000000',
    resizable: false, maximizable: false, fullscreenable: false, hasShadow: false, skipTaskbar: true, alwaysOnTop: state.settings.alwaysOnTop,
    ...(process.platform === 'darwin' ? { acceptFirstMouse: true } : {}),
    icon: appIcon(), webPreferences: webPreferences(),
  });
  configureWindowIdentity(pet);
  lockWindow(pet);
  growthDesktop?.attachWindow(pet);
  // Transparent pixels are still part of a native HWND. Pass them through until
  // the renderer reports a visible interactive shape under the pointer.
  pet.setIgnoreMouseEvents(true, { forward: true });
  desktopPet?.attachPet(pet);
  pet.on('close', (event) => { if (!quitting) { event.preventDefault(); runDesktopAction(() => setPetVisible(false)); } });
  pet.on('closed', () => { pet = null; });
  pet.on('hide', () => desktopPet?.cancelDrag());
  pet.on('blur', () => desktopPet?.cancelDrag());
  pet.on('closed', () => desktopPet?.cancelDrag());
  pet.once('ready-to-show', () => { if (effectivePetVisible()) pet?.showInactive(); });
  pet.loadFile(path.join(ROOT, 'pet.html')).catch(() => dialog.showErrorBox('无法打开桌宠', '桌宠界面文件缺失，请重新安装或在完整项目目录中启动。'));
}

function keepPetOnScreen() {
  if (!pet || pet.isDestroyed()) return;
  const bounds = pet.getBounds();
  const area = screen.getDisplayMatching({ ...bounds, ...PET_WINDOW_SIZE }).workArea;
  const x = Math.max(area.x, Math.min(bounds.x, area.x + Math.max(0, area.width - PET_WINDOW_SIZE.width)));
  const y = Math.max(area.y, Math.min(bounds.y, area.y + Math.max(0, area.height - PET_WINDOW_SIZE.height)));
  movePetWindow(pet, { x, y });
}

function runDesktopAction(action) {
  try { return action(); }
  catch {
    dialog.showErrorBox(`${petName()} · 操作未保存`, '本次设置未能保存。请检查本机存储空间与用户目录的写入权限后再试，原有数据仍会保留。');
    return false;
  }
}

function registerNotificationShortcut() {
  if (process.platform !== 'win32' || !app.isPackaged) return;
  try {
    const directory = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
    fs.mkdirSync(directory, { recursive: true });
    const shortcut = path.join(directory, '潮汐.lnk');
    const saved = shell.writeShortcutLink(shortcut, fs.existsSync(shortcut) ? 'replace' : 'create', {
      target: process.execPath,
      cwd: path.dirname(process.execPath),
      args: '',
      icon: taskbarIconPath(),
      iconIndex: 0,
      appUserModelId: APP_USER_MODEL_ID,
      description: '潮汐 · 桌面陪伴与提醒',
    });
    if (!saved) throw new Error('Shortcut registration failed');
    // Remove only legacy shortcuts pointing at this exact installed copy.
    // Unrelated portable copies and user-pinned taskbar items remain untouched.
    for (const name of ['Tide Companion.lnk', '潮汐 · Tide Companion.lnk']) {
      const legacy = path.join(directory, name);
      if (!fs.existsSync(legacy)) continue;
      try {
        const details = shell.readShortcutLink(legacy);
        if (path.resolve(details.target).toLowerCase() === path.resolve(process.execPath).toLowerCase()) fs.unlinkSync(legacy);
      } catch { /* A manually edited shortcut is safe to retain. */ }
    }
  } catch {
    dialog.showMessageBox({
      type: 'warning', title: `${petName()} · Windows 通知`,
      message: 'Windows 通知入口暂时未能创建，系统通知可能不可用。',
      detail: '桌宠和本机记录仍可使用。请检查当前用户开始菜单目录的写入权限后重新启动；无需管理员权限。',
      buttons: ['知道了'],
    }).catch(() => {});
  }
}

function updateTray() {
  if (!tray) return;
  tray.setToolTip(`${petName()}桌宠 · 本机陪伴与提醒`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开陪伴面板', click: openDashboard },
    { label: `${state.settings.petVisible ? '隐藏' : '显示'}${petName()}`, click: () => runDesktopAction(() => setPetVisible(!state.settings.petVisible)) },
    { label: `让${petName()}回到屏幕右下角`, click: () => runDesktopAction(() => { setPetVisible(true); movePetWindow(pet, petPosition()); }) },
    { type: 'separator' },
    { label: '面板关闭后，提醒仍会运行', enabled: false },
    { label: `退出${petName()}（停止提醒）`, click: () => app.quit() },
  ]));
}

function applySettings(previous) {
  if (dashboard && !dashboard.isDestroyed()) dashboard.setTitle('潮汐 · 手账');
  if (pet && !pet.isDestroyed()) {
    pet.setTitle(`${petName()}桌宠`);
    pet.setAlwaysOnTop(state.settings.alwaysOnTop);
    if (effectivePetVisible()) pet.showInactive(); else pet.hide();
  }
  updateTray();
}

function loginItemSettings(openAtLogin) {
  return loginItemOptions(openAtLogin, process.platform, process.execPath, APP_USER_MODEL_ID);
}

function syncLoginItemAtStartup() {
  // Installing a formerly portable app changes its executable path. Keep the
  // existing opt-in, but leave a disabled preference and development runs alone.
  if (process.platform !== 'win32' || !app.isPackaged || !state.settings.launchAtLogin) return;
  try {
    const options = { path: process.execPath, args: ['--hidden'] };
    // A matching Run entry may be disabled in Windows Task Manager. Do not
    // rewrite it on every launch, which would undo that operating-system choice.
    if (app.getLoginItemSettings(options).openAtLogin) return;
    app.setLoginItemSettings(loginItemSettings(true));
    if (!app.getLoginItemSettings(options).openAtLogin) throw new Error('Login item registration was not saved');
  } catch {
    // Registry access is optional; failure must not prevent access to records.
    console.warn('开机启动路径暂时未能更新，可在设置中重新切换开机启动。');
  }
}

function persist(next) {
  state = store.save(next);
  broadcast('state:changed', state);
  return state;
}

function setPetVisible(visible) {
  const previous = state.settings;
  persist({ ...state, settings: { ...state.settings, petVisible: visible } });
  if (visible && (!pet || pet.isDestroyed())) createPet();
  applySettings(previous);
  return state;
}

function showNotification(body, title = `${petName()} · 用药提醒`, onFailure) {
  if (!state.settings.notifications || !Notification.isSupported()) return false;
  let notification;
  try {
    notification = new Notification({ title, body, silent: false, timeoutType: 'default', icon: appIcon() });
    activeNotifications.add(notification);
    notification.on('click', openDashboard);
    notification.once('close', () => activeNotifications.delete(notification));
    notification.once('failed', () => { activeNotifications.delete(notification); onFailure?.(); });
    notification.show();
    return true;
  } catch {
    if (notification) activeNotifications.delete(notification);
    return false;
  }
}

function reminderTick() {
  if (!state || !reminders || tickRunning || quitting) return;
  tickRunning = true;
  try {
    const due = reminders.collectDueReminders(state, Date.now());
    if (!due.length) return;
    // Save first. An interrupted notification cannot duplicate a confirmed event.
    persist({ ...state, reminderLog: reminders.appendReminderLog(state.reminderLog, due) });
    const hasMissed = due.some((record) => record.status === 'missed');
    const message = hasMissed
      ? `有 ${due.length} 项提醒已到时间，其中包含较早的事项。打开计划可查看详情；提醒不会自动记录使用。`
      : `你设置的 ${due.length} 项提醒到时间了，可以打开计划查看。`;
    const detail = state.settings.privateNotifications ? message : `${due.slice(0, 3).map((record) => record.name).join('、')}${due.length > 3 ? '等' : ''}。${message}`;
    broadcast('pet:action', { action: 'reminder', at: new Date().toISOString(), message });
    showNotification(detail);
    failureShown = false;
  } catch {
    if (!failureShown) {
      failureShown = true;
      const message = '提醒记录暂时无法保存，请检查本机存储空间与用户目录的写入权限。此事项尚未记为已提醒，恢复后会重试。';
      broadcast('pet:action', { action: 'reminder', at: new Date().toISOString(), message });
      let errorDialogShown = false;
      const showError = () => {
        if (!errorDialogShown) {
          errorDialogShown = true;
          dialog.showErrorBox(`${petName()} · 提醒需要留意`, message);
        }
      };
      // A hidden pet must not hide a failed reminder. Keep the notice generic;
      // fall back to a visible error if system notifications are unavailable.
      if (!showNotification(message, `${petName()} · 提醒需要留意`, showError)) showError();
    }
  } finally { tickRunning = false; }
}

function setupIpc() {
  desktopPet = setupPetDesktop({ ipcMain, screen, getPet: () => pet, trustedSender, broadcast });
  growthDesktop = setupPetGrowthDesktop({ ipcMain, trustedSender, getState: () => state, persist, getPet: () => pet, getDashboard: () => dashboard, broadcast, desktopPet });
  ipcMain.on('pet:pointer-passthrough', (event, ignore) => {
    if (typeof ignore !== 'boolean' || !pet || pet.isDestroyed() || event.sender !== pet.webContents || !trustedSender(event)) return;
    if (ignore && (desktopPet.isDragging() || growthDesktop.isFeeding())) return;
    pet.setIgnoreMouseEvents(ignore, ignore ? { forward: true } : undefined);
  });
  handle('state:load', () => state);
  handle('app:platform', () => PLATFORM);
  handle('state:save', (incoming) => {
    const next = validateState({ ...incoming, settings: { ...incoming?.settings, nameCustomized: incoming?.settings?.name !== state.settings.name ? true : state.settings.nameCustomized, activeSkin: state.settings.activeSkin, skinScale: state.settings.skinScale }, reminderLog: state.reminderLog, moods: state.moods, dailyMoods: state.dailyMoods, starWallet:state.starWallet });
    let {wallet,rewards} = rewardNewDoses(state,next,Date.now());
    next.starWallet = wallet;
    // Optional currency must not push an otherwise valid clinical save over the
    // shared storage-size limit. Preserve prior stars and still save the dose.
    if (rewards.length && Buffer.byteLength(JSON.stringify(next,null,2),'utf8') > MAX_BYTES) {
      next.starWallet = state.starWallet;
      rewards = [];
    }
    const previous = state.settings;
    if (next.settings.launchAtLogin !== previous.launchAtLogin) {
      if (!PLATFORM.automaticLoginSettings) throw new Error('请在系统设置的“通用 → 登录项”中添加或移除潮汐。');
      if (!app.isPackaged) throw new Error('开机启动仅支持已安装的软件版本；开发模式请使用 npm start。');
      app.setLoginItemSettings(loginItemSettings(next.settings.launchAtLogin));
    }
    try { persist(next); }
    catch (error) {
      if (next.settings.launchAtLogin !== previous.launchAtLogin) app.setLoginItemSettings(loginItemSettings(previous.launchAtLogin));
      throw error;
    }
    applySettings(previous);
    if (rewards.length) broadcast('pet:action', {action:'star-reward',id:crypto.randomUUID(),at:new Date().toISOString(),amount:rewards.reduce((sum,entry)=>sum+entry.amount,0),balance:starBalance(state.starWallet),rewards});
    reminderTick();
    return state;
  });
  handle('window:dashboard', () => { openDashboard(); return true; });
  handle('window:dashboard-toggle', toggleDashboard);
  handle('window:dashboard-visible', dashboardVisibility);
  handle('window:pet-show', () => setPetVisible(true));
  handle('window:pet-hide', () => setPetVisible(false));
  handle('pet:interact', (action) => {
    if (!ACTIONS.has(action)) throw new Error('未知互动动作。');
    if (action === 'feed') throw new Error('星星会在提醒后按时确认实际使用时自动获得。');
    const event = { id: crypto.randomUUID(), action, at: new Date().toISOString() };
    // This handler stays synchronous through save. Two queued IPC calls cannot
    // both pass the daily check; failed persistence never changes the day lock.
    const dailyMoods = appendDailyMood(state.dailyMoods, event);
    persist({ ...state, moods: [...state.moods, event].slice(-200), dailyMoods });
    broadcast('pet:action', event);
    return event;
  });
  handle('notification:test', () => {
    broadcast('pet:action', { action: 'reminder', at: new Date().toISOString(), message: '这是一条测试提醒。你可以随时调整提醒偏好。' });
    return { supported: Notification.isSupported(), enabled: state.settings.notifications, shown: showNotification(`这是一条测试提醒。${petName()}会在你设置的时间提醒你。`) };
  });
  handle('data:export', async () => {
    const result = await dialog.showSaveDialog(dashboard ?? undefined, { title: `导出${petName()}本机数据`, defaultPath: `tide-backup-${new Date().toISOString().slice(0, 10)}.json`, filters: [{ name: 'JSON 备份', extensions: ['json'] }] });
    if (result.canceled || !result.filePath) return { canceled: true };
    fs.writeFileSync(result.filePath, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
    return { canceled: false, filePath: result.filePath };
  });
  handle('data:import', async () => {
    const result = await dialog.showOpenDialog(dashboard ?? undefined, { title: `导入${petName()} JSON 备份`, filters: [{ name: 'JSON 备份', extensions: ['json'] }], properties: ['openFile'] });
    if (result.canceled || !result.filePaths.length) return null;
    const selected = result.filePaths[0];
    if (fs.statSync(selected).size > MAX_BYTES) throw new Error('备份文件超过 5 MB，请检查所选文件。');
    const imported = parseState(fs.readFileSync(selected, 'utf8'));
    const resultConfirm = await dialog.showMessageBox(dashboard ?? undefined, {
      type: 'question', title: '导入备份', message: `将替换为备份中的 ${imported.plans.length} 项计划、${imported.doses.length} 条使用记录、${imported.labs.length} 条化验记录和 ${imported.dailyMoods.length} 天心情。`,
      detail: '现有数据会保存为本机恢复备份。今天已经选择的心情保留；历史心情按备份恢复。星星账本合并，保留本机已获奖励与已消费记录，恢复旧备份不会返还已吃掉的星星；等级、经验和每日产星机会共享。开机启动、通知隐私和本机皮肤保留当前设置；健康备份不导入模型文件。', buttons: ['取消', '导入并替换'], defaultId: 0, cancelId: 0, noLink: true,
    });
    if (resultConfirm.response !== 1) return null;
    // Builtin companions travel with every installation, so backups can restore
    // their selection. Imported Live2D files stay local and retain the current skin.
    imported.settings = { ...imported.settings, launchAtLogin: state.settings.launchAtLogin, notifications: state.settings.notifications, privateNotifications: state.settings.privateNotifications, petVisible: state.settings.petVisible, alwaysOnTop: state.settings.alwaysOnTop, activeSkin: isBuiltinShark(imported.settings.activeSkin) ? imported.settings.activeSkin : state.settings.activeSkin, skinScale: state.settings.skinScale };
    imported.dailyMoods = restoreDailyMoods(imported.dailyMoods, state.dailyMoods, Date.now());
    imported.starWallet = mergeStarWallet(imported.starWallet,state.starWallet);
    // Separate recovery snapshot survives subsequent automatic reminder writes.
    fs.writeFileSync(path.join(path.dirname(store.file), `before-import-${Date.now()}.json`), JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
    persist(imported);
    applySettings();
    reminderTick();
    return state;
  });
  handle('skins:list', listSkins);
  handle('skins:import', async () => {
    const result = await dialog.showOpenDialog(dashboard ?? undefined, { title: '选择 Live2D 的 model3.json 文件', filters: [{ name: 'Cubism model3.json', extensions: ['json'] }], properties: ['openFile'] });
    if (result.canceled || !result.filePaths.length) return null;
    return skinStore.importModel(result.filePaths[0]);
  });
  handle('skins:select', (id, scale) => {
    if (typeof id !== 'string' || !skinStore.has(id)) throw new Error('皮肤不存在，请重新导入或选择内置鲨鲨。');
    desktopPet?.cancelDrag();
    const settings = { ...state.settings, activeSkin: id, skinScale: scale === undefined ? state.settings.skinScale : scale };
    persist({ ...state, settings });
    return state;
  });
  handle('skins:remove', (id) => {
    if (isBuiltinShark(id)) throw new Error('内置桌宠不能删除。');
    if (typeof id !== 'string' || !skinStore.has(id)) throw new Error('皮肤不存在。');
    if (state.settings.activeSkin === id) persist({ ...state, settings: { ...state.settings, activeSkin: 'builtin', skinScale: 1 } });
    skinStore.remove(id);
    return listSkins();
  });
  handle('link:open', async (value) => {
    if (typeof value !== 'string' || value.length > 2048) throw new Error('链接无效。');
    let url;
    try { url = new URL(value); } catch { throw new Error('链接无效。'); }
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !DOC_HOSTS.has(url.hostname)) throw new Error('仅支持打开内置来源列表中的 HTTPS 资料链接。');
    await shell.openExternal(url.href);
    return true;
  });
  handle('app:quit', () => { app.quit(); return true; });
}

function listSkins() {
  return { activeSkin: state.settings.activeSkin, skinScale: state.settings.skinScale, skins: [...BUILTIN_SHARKS, ...skinStore.list()] };
}

function setupSkinProtocol() {
  protocol.handle('tide-skin', (request) => {
    const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Cross-Origin-Resource-Policy': 'cross-origin' };
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return new Response(null, { status: 405, headers });
    const origin = request.initiatorOrigin;
    if (origin && origin !== 'null' && origin !== 'file://' && !/^tide-skin:\/\/[a-f0-9-]{36}$/.test(origin)) return new Response(null, { status: 403, headers });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    try {
      const asset = skinStore.readUrl(request.url);
      return new Response(request.method === 'HEAD' ? null : asset.bytes, { status: 200, headers: { ...headers, 'Content-Type': asset.mime, 'Content-Length': String(asset.bytes.length) } });
    } catch { return new Response(null, { status: 404, headers }); }
  });
}

function startFullscreenWatch() {
  const restoreVisibility = () => {
    fullscreenSuppressed = false;
    if (pet && !pet.isDestroyed() && effectivePetVisible()) pet.showInactive();
  };
  try {
    stopFullscreenWatch = watchFullscreen((fullscreen) => {
      fullscreenSuppressed = fullscreen;
      if (pet && !pet.isDestroyed()) { if (effectivePetVisible()) pet.showInactive(); else pet.hide(); }
    }, restoreVisibility);
  } catch { restoreVisibility(); }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', openDashboard);
  app.on('before-quit', () => {
    quitting = true;
    if (timer) clearInterval(timer);
    stopFullscreenWatch?.();
    growthDesktop?.dispose();
    for (const notification of activeNotifications) notification.close();
    tray?.destroy();
    tray = null;
  });
  app.on('window-all-closed', () => { /* Tray owns the reminder process. */ });
  app.on('activate', () => { if (state) openDashboard(); });
  app.whenReady().then(async () => {
    configureApplicationMenu();
    registerNotificationShortcut();
    store = createStateStore(app.getPath('userData'));
    const loaded = store.load();
    state = loaded.state;
    syncLoginItemAtStartup();
    skinStore = createSkinStore(app.getPath('userData'));
    if (!skinStore.has(state.settings.activeSkin)) state = { ...state, settings: { ...state.settings, activeSkin: 'builtin', skinScale: 1 } };
    setupSkinProtocol();
    reminders = await import(pathToFileURL(path.join(ROOT, 'src/reminders.js')).href);
    // No in-app network requests, permissions, remote pages, or telemetry.
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_details, callback) => callback({ cancel: true }));
    if (loaded.fresh || loaded.recovered || loaded.migrated || state.settings.activeSkin !== loaded.state.settings.activeSkin) state = store.save(state);
    setupIpc();
    desktopReady = true;
    createDashboard();
    createPet();
    tray = new Tray(trayIcon());
    tray.on('double-click', openDashboard);
    updateTray();
    startFullscreenWatch();
    powerMonitor.on('resume', reminderTick);
    powerMonitor.on('unlock-screen', reminderTick);
    let systemSuspended = false, screenLocked = false;
    powerMonitor.on('suspend', () => { systemSuspended = true; growthDesktop.setSuspended(true); });
    powerMonitor.on('lock-screen', () => { screenLocked = true; growthDesktop.setSuspended(true); });
    powerMonitor.on('resume', () => { systemSuspended = false; growthDesktop.setSuspended(screenLocked); });
    powerMonitor.on('unlock-screen', () => { screenLocked = false; growthDesktop.setSuspended(systemSuspended); });
    screen.on('display-removed', keepPetOnScreen);
    screen.on('display-metrics-changed', keepPetOnScreen);
    timer = setInterval(reminderTick, 30000);
    // Wait for local UI to receive recovery reminder events.
    dashboard.webContents.once('did-finish-load', reminderTick);
    if (loaded.recovered) {
      dialog.showMessageBox({ type: 'warning', title: '本机数据恢复', message: loaded.fresh ? '原数据无法读取，已保留原文件并使用空白数据启动。' : '已从本机备份恢复数据。', detail: `原文件已保留在 ${app.getPath('userData')}。请检查计划、使用记录和化验记录。` });
    }
  }).catch(() => {
    dialog.showErrorBox(`${petName()}启动失败`, '无法读取或保存本机数据。请检查用户目录的存储空间与写入权限后重新启动。');
    app.quit();
  });
}
