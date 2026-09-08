// Layover desktop app: hosts the store and the loopback service, owns the window and tray.
// Nothing here calls a model. Incoming events never steal focus or switch an engaged user's workspace.
import { app, BrowserWindow, Tray, Menu, nativeImage, nativeTheme, ipcMain, shell, clipboard, dialog, Notification } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { Bridge } from './bridge.js';
import { createService } from './service.js';
import { loadSettings, saveSettings, applySettings } from './settings.js';
import { dataDir, dataRoot, logFile, APP_NAME, projectIdFromPath, projectNameFromPath, port } from './paths.js';
import * as setup from '../cli/setup.js';
import { resolveLatest } from '../cli/hook.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const argv = process.argv.slice(app.isPackaged ? 1 : 2);
const flag = (name) => argv.includes(name);
const flagValue = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

function log(...parts) {
  const line = `${new Date().toISOString()} ${parts.map(p => (p instanceof Error ? p.stack : typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}\n`;
  try { fs.mkdirSync(dataRoot, { recursive: true }); fs.appendFileSync(logFile, line); } catch { /* logging never breaks the app */ }
  if (!app.isPackaged) process.stdout.write(line);
}

function safeJson(s) { try { return JSON.parse(s || '{}') || {}; } catch { return {}; } }

let store, bridge, settings, service, tray, win;
let quitting = false;
let uiEngaged = false;          // renderer reports true while the user is typing / interacting
let lastInteraction = 0;

// ---------- single instance ----------
// Keep Electron's own files (and therefore the instance lock) inside the data root, so an isolated
// LAYOVER_DATA instance never collides with the installed app.
app.setPath('userData', path.join(dataRoot, 'electron'));
if (!app.requestSingleInstanceLock({ argv })) {
  app.exit(0);
} else {
  app.on('second-instance', (_e, _argv, _cwd, extra) => {
    const a = extra?.argv || [];
    const i = a.indexOf('--open');
    handleOpen(i >= 0 ? safeJson(a[i + 1]) : {}, { explicit: true }).catch(e => log('second-instance open failed', e));
  });
  boot().catch(e => { log('boot failed', e); dialog.showErrorBox(APP_NAME, 'Layover could not start.\n\n' + e.message); app.exit(1); });
}


const cliCommand = () => app.isPackaged ? path.join(path.dirname(process.execPath), 'bin', process.platform === 'win32' ? 'layover.cmd' : 'layover') : path.join(repoRoot, 'bin', process.platform === 'win32' ? 'layover.cmd' : 'layover');

async function boot() {
  app.setAppUserModelId('com.layover.app');
  settings = loadSettings();
  nativeTheme.themeSource = settings.theme;
  store = new Store(dataDir);
  bridge = new Bridge(store, dataDir);
  ingestSpool();
  service = await createService({ store, bridge, onOpen: (ctx) => handleOpen(ctx, { explicit: true }), onEvent, settings: () => settings, port, version: app.getVersion() });
  log(`service listening on 127.0.0.1:${port}`);
  process.on('layover:stop', () => { quitting = true; app.quit(); });
  store.onChange(change => {
    broadcast('state', store.state());
    if (change.ended) onRunEnded(change.ended);
  });
  await app.whenReady();
  if (app.isPackaged) { try { log('path', setup.ensureUserPath(path.dirname(cliCommand()))); } catch (e) { log('path setup failed', e.message); } }
  createTray();
  const openReq = flagValue('--open');
  if (!flag('--background')) createWindow({ show: true });
  if (openReq) await handleOpen(safeJson(openReq), { explicit: true });
  app.on('activate', () => { if (!win) createWindow({ show: true }); else reveal({ focus: true }); });
  app.on('before-quit', () => { quitting = true; });
  app.on('window-all-closed', () => { /* keep running in the tray */ });
  nativeTheme.on('updated', () => applyTheme());
}

function ingestSpool() {
  const dir = path.join(dataDir, 'spool');
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir).sort()) {
    const file = path.join(dir, f);
    try {
      const events = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const e of resolveLatest(Array.isArray(events) ? events : [events], store.state())) { try { store.event(e); } catch (err) { log('spool event rejected', err.message); } }
    } catch (err) { log('spool file unreadable', f, err.message); }
    fs.rmSync(file, { force: true });
  }
}

// ---------- window ----------
const SIZES = { expanded: { width: 1120, height: 740, minWidth: 720, minHeight: 520 }, compact: { width: 400, height: 580, minWidth: 340, minHeight: 440 } };

function themeColors() {
  const dark = nativeTheme.shouldUseDarkColors;
  return dark ? { bg: '#151714', overlay: '#151714', symbol: '#C0C4B9' } : { bg: '#F6F5F2', overlay: '#F6F5F2', symbol: '#43413B' };
}

function createWindow({ show }) {
  const mode = settings.window.mode || 'expanded';
  const size = SIZES[mode];
  const bounds = settings.window.bounds?.[mode] || {};
  const c = themeColors();
  win = new BrowserWindow({
    width: bounds.width || size.width, height: bounds.height || size.height, x: bounds.x, y: bounds.y,
    minWidth: size.minWidth, minHeight: size.minHeight,
    show: false, backgroundColor: c.bg, title: APP_NAME,
    icon: iconPath('png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: c.overlay, symbolColor: c.symbol, height: 42 },
    webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: true },
  });
  win.removeMenu();
  win.loadFile(path.join(repoRoot, 'src', 'renderer', 'index.html'));
  win.once('ready-to-show', () => { if (show) win.show(); });
  win.on('close', (e) => { if (!quitting && settings.closeToTray) { e.preventDefault(); rememberBounds(); win.hide(); } else rememberBounds(); });
  win.on('closed', () => { win = null; });
  win.on('focus', () => { lastInteraction = Date.now(); });
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('did-finish-load', () => { applyTheme(); win.webContents.send('window-mode', mode); });
  const shot = flagValue('--screenshot');
  if (shot && !app.isPackaged) win.webContents.once('did-finish-load', () => setTimeout(async () => { try { win.show(); win.moveTop(); await new Promise(r => setTimeout(r, 600)); const img = await win.webContents.capturePage(); fs.writeFileSync(shot, img.toPNG()); log('screenshot', shot); } catch (e) { log('screenshot failed', e.message); } }, Number(flagValue('--screenshot-delay') || 1500)));
  return win;
}

function rememberBounds() {
  if (!win || win.isMinimized()) return;
  const mode = settings.window.mode || 'expanded';
  settings.window.bounds ??= {};
  settings.window.bounds[mode] = win.getBounds();
  saveSettings(settings);
}

function setWindowMode(mode) {
  if (!['expanded', 'compact'].includes(mode)) return;
  rememberBounds();
  settings.window.mode = mode; saveSettings(settings);
  if (!win) return;
  const size = SIZES[mode], b = settings.window.bounds?.[mode];
  win.setMinimumSize(size.minWidth, size.minHeight);
  win.setSize(b?.width || size.width, b?.height || size.height, true);
  if (b?.x !== undefined) win.setPosition(b.x, b.y, true);
  win.setAlwaysOnTop(mode === 'compact', 'floating');
  win.webContents.send('window-mode', mode);
}

function applyTheme() {
  const c = themeColors();
  if (win) { try { win.setTitleBarOverlay({ color: c.overlay, symbolColor: c.symbol, height: 42 }); } catch { /* not supported on this platform */ } win.setBackgroundColor(c.bg); win.webContents.send('theme', { theme: settings.theme, dark: nativeTheme.shouldUseDarkColors }); }
}

/**
 * Bring Layover in front of everything once. Windows refuses foreground changes from background
 * processes, so the window is briefly pinned on top while it is shown and focused.
 */
function bringToFront() {
  if (!win) createWindow({ show: false });
  if (win.isMinimized()) win.restore();
  const pinned = settings.window.mode === 'compact';
  win.setAlwaysOnTop(true, 'screen-saver');
  win.show();
  win.focus();
  win.moveTop();
  setTimeout(() => { if (win && !win.isDestroyed()) win.setAlwaysOnTop(pinned, 'floating'); }, 250);
  if (!win.isFocused()) nativeFocus();
  lastInteraction = Date.now();
  return { visible: true, focused: true };
}

/**
 * Windows only grants SetForegroundWindow to the process that owns the foreground window (or one it
 * started). Attaching our thread input to that window's thread for a moment is the documented way
 * around it. Electron has no binding for it, so a short PowerShell helper does the three calls.
 */
let nativeFocusAt = 0;
function nativeFocus() {
  if (process.platform !== 'win32' || !win || Date.now() - nativeFocusAt < 1500) return;
  nativeFocusAt = Date.now();
  const buf = win.getNativeWindowHandle();
  const hwnd = buf.length >= 8 ? buf.readBigUInt64LE(0).toString() : String(buf.readUInt32LE(0));
  const script = `Add-Type -Namespace L -Name W -MemberDefinition '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr p); [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId(); [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);'; $h=[IntPtr]::new([Int64]${hwnd}); $fg=[L.W]::GetForegroundWindow(); $ft=[L.W]::GetWindowThreadProcessId($fg,[IntPtr]::Zero); $ct=[L.W]::GetCurrentThreadId(); $a=[L.W]::AttachThreadInput($ft,$ct,$true); [void][L.W]::ShowWindow($h,9); [void][L.W]::BringWindowToTop($h); [void][L.W]::SetForegroundWindow($h); if($a){ [void][L.W]::AttachThreadInput($ft,$ct,$false) }`;
  try {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, stdio: 'ignore' });
    child.on('error', e => log('native focus failed', e.message));
    child.unref();
  } catch (e) { log('native focus failed', e.message); }
}

/** Show the window without taking focus from whatever the user is doing. */
function reveal({ focus = false } = {}) {
  if (!win) createWindow({ show: false });
  if (focus) return bringToFront();
  if (win.isMinimized()) { win.flashFrame(true); return { visible: false, minimized: true }; }
  if (!win.isVisible()) { win.showInactive(); return { visible: true, focused: false }; }
  return { visible: true, focused: win.isFocused() };
}

function broadcast(channel, payload) { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); }

// ---------- routing ----------
async function handleOpen(ctx, { explicit }) {
  const clean = {};
  for (const k of ['project', 'task', 'run', 'reason']) if (typeof ctx?.[k] === 'string' && ctx[k].length <= 180) clean[k] = ctx[k];
  if (ctx?.projectPath && !store.projects.has(clean.project)) {
    try { store.createProject({ id: projectIdFromPath(ctx.projectPath), name: projectNameFromPath(ctx.projectPath), path: ctx.projectPath }); clean.project = projectIdFromPath(ctx.projectPath); } catch (e) { log('open: cannot create project', e.message); }
  }
  // An explicit open (the user asked the agent, or clicked a notification) is the one case that takes focus.
  const engaged = uiEngaged || (win?.isFocused() && Date.now() - lastInteraction < 60_000);
  const shown = explicit ? bringToFront() : reveal({ focus: false });
  broadcast('open-request', { ...clean, explicit, engaged, requestedAt: Date.now() });
  return { reused: true, ...shown, engaged, foregroundFocus: !!explicit };
}

async function onEvent(e, result) {
  if (result.started) {
    const mode = settings.openOnRunStart;
    const wasVisible = !!win?.isVisible();
    const wasFocused = !!win?.isFocused();
    let shown = null;
    // A run starting is the "first launch" moment the brief allows to be noticeable; later items never move the window.
    if (mode === 'focus') shown = wasFocused ? { visible: true, focused: true } : bringToFront();
    else if (mode === 'open') shown = reveal({ focus: false });
    else if (mode === 'reveal' && win) shown = reveal({ focus: false });
    if (shown) {
      const engaged = uiEngaged || (wasFocused && Date.now() - lastInteraction < 60_000);
      broadcast('open-request', { project: e.project, task: e.task, run: e.run, reason: 'run-start', explicit: false, engaged, wasVisible, requestedAt: Date.now() });
    }
    updateTray();
    return shown;
  }
  updateTray();
  return null;
}

function onRunEnded({ run, status }) {
  updateTray();
  const r = store.runs.get(run); if (!r) return;
  const p = store.projects.get(r.project);
  broadcast('run-ended', { run, status, project: r.project });
  if (!settings.notifyOnComplete || !Notification.isSupported()) return;
  if (win?.isFocused()) return; // the app is already in front; the in-app banner is enough
  const agent = r.agent === 'claude' ? 'Claude Code' : r.agent === 'codex' ? 'Codex' : r.agent;
  const title = status === 'completed' ? 'Ready when you are' : status === 'failed' ? 'A run stopped with an error' : status === 'cancelled' ? 'A run was interrupted' : 'A run went quiet';
  const n = new Notification({ title, body: `${agent} · ${p?.displayName || p?.name || ''}${r.title ? ' · ' + r.title : ''}`, silent: true, icon: iconPath('png') });
  n.on('click', () => { reveal({ focus: true }); broadcast('open-request', { project: r.project, task: r.task, run, reason: 'notification', explicit: true, engaged: false, requestedAt: Date.now() }); });
  n.show();
}

// ---------- tray ----------
function iconPath(ext) {
  const candidates = [path.join(repoRoot, 'build', `icon.${ext}`), path.join(process.resourcesPath || '', `icon.${ext}`)];
  return candidates.find(p => fs.existsSync(p)) || candidates[0];
}

function createTray() {
  try {
    const img = nativeImage.createFromPath(iconPath('png')).resize({ width: 16, height: 16 });
    tray = new Tray(img);
    tray.setToolTip(APP_NAME);
    tray.on('click', () => reveal({ focus: true }));
    updateTray();
  } catch (e) { log('tray unavailable', e.message); }
}

function updateTray() {
  if (!tray) return;
  const active = store.state().runs.filter(r => r.status === 'active').length;
  tray.setToolTip(active ? `${APP_NAME} · ${active} agent${active === 1 ? '' : 's'} working` : APP_NAME);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Layover', click: () => reveal({ focus: true }) },
    { label: settings.window.mode === 'compact' ? 'Expanded workspace' : 'Compact companion', click: () => { setWindowMode(settings.window.mode === 'compact' ? 'expanded' : 'compact'); reveal({ focus: true }); } },
    { type: 'separator' },
    { label: 'Quit Layover', click: () => { quitting = true; app.quit(); } },
  ]));
}

// ---------- IPC ----------
const handle = (channel, fn) => ipcMain.handle(channel, async (_e, payload) => { try { return { ok: true, value: await fn(payload) }; } catch (e) { return { ok: false, error: e.message }; } });

handle('state:get', () => store.state());
handle('user:get', (project) => store.user(project));
handle('user:notes', ({ project, body, revision }) => store.setNotes(project, body, revision));
handle('user:ticket', ({ project, ticket }) => store.upsertTicket(project, ticket));
handle('user:ticket:delete', ({ project, id }) => store.deleteTicket(project, id));
handle('user:respond', ({ project, key, body }) => store.respond(project, key, body));
handle('user:dismiss', ({ project, key, dismissed }) => store.dismiss(project, key, dismissed));
handle('user:place', ({ project, place }) => store.setPlace(project, place));
handle('project:meta', ({ project, meta }) => { const r = store.setProjectMeta(project, meta); broadcast('state', store.state()); return r; });
handle('project:create', ({ name, folder }) => { const id = folder ? projectIdFromPath(folder) : 'm_' + Date.now().toString(36); const p = store.createProject({ id, name: name || (folder ? projectNameFromPath(folder) : 'New workspace'), path: folder || '' }); broadcast('state', store.state()); return p; });
handle('dialog:folder', async () => { const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] }); return r.canceled ? null : r.filePaths[0]; });
handle('settings:get', () => ({ ...settings, cli: cliCommand(), dataDir, port, version: app.getVersion(), packaged: app.isPackaged }));
handle('settings:set', (patch) => { settings = applySettings(settings, patch); saveSettings(settings); nativeTheme.themeSource = settings.theme; applyTheme(); updateTray(); broadcast('settings', settings); return settings; });
handle('setup:status', () => { const cli = cliCommand(); return { cli, cliExists: fs.existsSync(cli), claude: setup.status('claude', cli), codex: setup.status('codex', cli) }; });
handle('setup:install', ({ agent, options }) => setup.install(agent, cliCommand(), options || {}));
handle('setup:remove', (agent) => setup.remove(agent));
handle('window:mode', (mode) => { setWindowMode(mode); return mode; });
handle('clipboard:write', (text) => { clipboard.writeText(String(text ?? '')); return true; });
handle('shell:openPath', (p) => shell.openPath(String(p)));
handle('shell:openExternal', (url) => { const u = new URL(String(url)); if (!['https:', 'http:'].includes(u.protocol)) throw Error('Only web links can be opened'); return shell.openExternal(u.href); });
handle('bridge:target', (run) => bridge.target({ run }));
handle('bridge:send', (payload) => bridge.send(payload));
ipcMain.on('ui:engaged', (_e, flag) => { uiEngaged = !!flag; if (flag) lastInteraction = Date.now(); });
