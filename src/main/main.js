// Layover desktop app: hosts the store and the loopback service, owns the window and tray.
// Nothing here calls a model. Incoming events never steal focus or switch an engaged user's workspace.
import { app, BrowserWindow, Tray, Menu, nativeImage, nativeTheme, ipcMain, shell, clipboard, dialog, Notification, screen } from 'electron';
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
import { liveMacHost, macHostRecord, macProcesses } from '../cli/host.js';
import { resolveLatest } from '../cli/hook.js';
import { checkForUpdate, installUpdate as startInstall } from './updates.js';

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


// Packaged: the bin folder sits beside resources (Windows <install>/bin, macOS Layover.app/Contents/bin).
const cliCommand = () => app.isPackaged ? path.join(process.resourcesPath, '..', 'bin', process.platform === 'win32' ? 'layover.cmd' : 'layover') : path.join(repoRoot, 'bin', process.platform === 'win32' ? 'layover.cmd' : 'layover');

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
  if (app.isPackaged && process.platform === 'win32') { try { log('path', setup.ensureUserPath(path.dirname(cliCommand()))); } catch (e) { log('path setup failed', e.message); } }
  if (process.platform === 'darwin') {
    // A standard app menu so Cmd+Q / Cmd+C / Cmd+V and the app name behave as on any Mac app.
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: APP_NAME, submenu: [{ role: 'about' }, { type: 'separator' }, { label: 'Settings…', accelerator: 'Cmd+,', click: () => { reveal({ focus: true }); broadcast('open-settings', {}); } }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { type: 'separator' }, { role: 'quit' }] },
      { role: 'editMenu' }, { role: 'windowMenu' },
    ]));
  }
  createTray();
  scheduleUpdateChecks();
  if (flag('--popover') && !app.isPackaged) setTimeout(togglePopover, 800); // dev: exercise the tray popover without a click
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
    // Windows wants an ICO here (a 1024 px PNG becomes a 1024 px HICON the taskbar cannot show, so it
    // fell back to Electron's logo). Packaged, the executable's own icon is the right one; leave it unset.
    icon: process.platform === 'win32' ? (app.isPackaged ? undefined : path.join(repoRoot, 'build', 'icon.ico')) : iconPath('png'),
    // Windows: hidden title bar with the native caption buttons overlaid. macOS: inset traffic lights.
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 14, y: 13 } } : { titleBarOverlay: { color: c.overlay, symbolColor: c.symbol, height: 42 } }),
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
  win.webContents.on('did-finish-load', () => { applyTheme(); win.webContents.send('window-mode', settings.window.mode || 'expanded'); win.webContents.send('platform', { platform: process.platform }); if (update.latest) win.webContents.send('update', updateView()); });
  // Popover mode: the compact companion hides again when it loses focus, like a menu-bar app.
  win.on('blur', () => { if (settings.trayPopover && settings.window.mode === 'compact' && win && !win.webContents.isDevToolsOpened() && popoverShown) { popoverShown = false; win.hide(); } });
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
  focusHwnd(hwnd).catch(e => log('native focus failed', e.message));
}

const FOCUS_DEFS = '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr p); [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId(); [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n); [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h); [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h); [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h); [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, System.Text.StringBuilder s, int n); [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e); [DllImport("user32.dll", EntryPoint="GetWindowThreadProcessId")] public static extern uint WindowPid(IntPtr h, out uint p);';

/**
 * Bring any top-level window forward by handle. Resolves {ok, reason}. The helper is a child of
 * Layover, so while Layover is in front (the user just clicked) Windows lets it hand focus over;
 * if that is refused, the Alt-nudge releases the foreground lock the way AutoHotkey does.
 * Success means the window really is in front afterwards: SetForegroundWindow can return true and
 * only flash the taskbar. Windows Terminal hides a window when it closes and keeps the handle alive,
 * so a hidden terminal window counts as gone rather than being shown again. Windows reuses handles,
 * so with `owner` (the process name recorded with the handle) a window now owned by another app
 * counts as gone too, rather than bringing that app forward.
 */
function focusHwnd(hwnd, owner = '') {
  if (!/^\d{1,20}$/.test(String(hwnd))) return Promise.resolve({ ok: false, reason: 'bad handle' });
  const check = /^[\w .-]{1,80}$/.test(owner) && owner !== 'window' ? `$wp=[uint32]0; [void][L.W]::WindowPid($h,[ref]$wp); $gp=Get-Process -Id $wp -ErrorAction SilentlyContinue; if(-not $gp -or $gp.ProcessName -ne '${owner}'){ 'gone'; exit 0 };` : '';
  const script = `Add-Type -Namespace L -Name W -MemberDefinition '${FOCUS_DEFS}'; $h=[IntPtr]::new([Int64]${hwnd}); if(-not [L.W]::IsWindow($h)){ 'gone'; exit 0 }; ${check} $cls=New-Object System.Text.StringBuilder 64; [void][L.W]::GetClassName($h,$cls,64); if(-not [L.W]::IsWindowVisible($h) -and -not [L.W]::IsIconic($h) -and $cls.ToString() -eq 'CASCADIA_HOSTING_WINDOW_CLASS'){ 'gone'; exit 0 }; if([L.W]::IsIconic($h)){ [void][L.W]::ShowWindow($h,9) } else { [void][L.W]::ShowWindow($h,5) }; if([L.W]::GetForegroundWindow() -eq $h){ 'ok'; exit 0 }; $fg=[L.W]::GetForegroundWindow(); $ft=[L.W]::GetWindowThreadProcessId($fg,[IntPtr]::Zero); $ct=[L.W]::GetCurrentThreadId(); $a=[L.W]::AttachThreadInput($ft,$ct,$true); [void][L.W]::BringWindowToTop($h); $ok=[L.W]::SetForegroundWindow($h); if($a){ [void][L.W]::AttachThreadInput($ft,$ct,$false) }; if(-not $ok){ [L.W]::keybd_event(0x12,0,0,[UIntPtr]::Zero); [L.W]::keybd_event(0x12,0,2,[UIntPtr]::Zero); [void][L.W]::BringWindowToTop($h); $ok=[L.W]::SetForegroundWindow($h) }; Start-Sleep -Milliseconds 150; if([L.W]::GetForegroundWindow() -eq $h){ 'ok' } else { 'refused' }`;
  return new Promise((resolve) => {
    let out = '';
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    child.stdout.on('data', d => { out += d; });
    child.on('error', e => resolve({ ok: false, reason: e.message }));
    child.on('close', () => { const r = out.trim(); resolve({ ok: r === 'ok', reason: r || 'no result' }); });
  });
}

/** "Return to the agent": focus the window the session started in, if we know it and it still exists. */
async function returnToHost(taskId) {
  const t = store.tasks.get(taskId);
  if (!t?.host?.hwnd) return { ok: false, reason: 'unknown' };
  const host = process.platform === 'darwin' ? macHostNow(t.host) : t.host;
  const r = process.platform === 'darwin' ? await activateMac(host) : await focusHwnd(host.hwnd, host.name);
  log('return to host', host.name, r);
  return { ...r, host };
}

/**
 * macOS: the recorded host, corrected from the live process tree when its process still runs. Hosts
 * recorded before 0.6.3 could name the agent's own bundle (see macHostFromProcesses); walking up from
 * it now finds the terminal or app around it. The recorded tty is kept when the walk has none.
 */
function macHostNow(host) {
  if (host.via === 'frontmost') return host;
  try {
    const found = liveMacHost(host, macProcesses());
    const live = found && (found.pid !== Number(host.pid) || found.name !== host.name) ? macHostRecord(found) : null;
    return live ? { ...live, tty: live.tty || host.tty } : host;
  } catch { return host; }
}

/**
 * macOS: activate the recorded app by bundle id (stored in host.title) or pid. In Terminal and iTerm2
 * the tab whose tty the agent runs on is selected first, so Return lands on the agent rather than on
 * whichever window of that app was last in front. That needs Automation permission once; if it is
 * refused, or the tab is gone, the app alone comes forward.
 */
async function activateMac(host) {
  const bundle = String(host.title || '').replace(/[^\w.-]/g, '');
  const tty = /^\/dev\/[\w.]{1,40}$/.test(host.tty || '') ? host.tty : '';
  const tab = !tty ? '' : bundle === 'com.apple.Terminal'
    ? `tell application id "${bundle}"\nrepeat with w in windows\nrepeat with t in tabs of w\nif tty of t is "${tty}" then\nset selected of t to true\nset miniaturized of w to false\nset index of w to 1\nactivate\nreturn "tab"\nend if\nend repeat\nend repeat\nend tell`
    : bundle === 'com.googlecode.iterm2'
      ? `tell application id "${bundle}"\nrepeat with w in windows\nrepeat with t in tabs of w\nrepeat with s in sessions of t\nif tty of s is "${tty}" then\ntell w to select\ntell t to select\ntell s to select\nactivate\nreturn "tab"\nend if\nend repeat\nend repeat\nend repeat\nend tell`
      : '';
  // Telling an app that is not open to do anything launches it, and Return must never start anything.
  if (bundle) { const up = await osascript(`application id "${bundle}" is running`, 5000); if (up.out === 'false') return { ok: false, reason: 'gone' }; }
  // The tab script may wait on the one-time Automation prompt, so it gets longer than a plain activate.
  if (tab) { const r = await osascript(tab, 20000); if (r.code === 0 && r.out === 'tab') return { ok: true, reason: 'ok' }; }
  const r = await osascript(bundle ? `tell application id "${bundle}" to activate` : `tell application "System Events" to set frontmost of (first process whose unix id is ${Number(host.pid)}) to true`, 5000);
  return r.code === 0 ? { ok: true, reason: 'ok' } : { ok: false, reason: /can’t get|not running|-600|-1728/.test(r.err) ? 'gone' : 'refused' };
}

/** Run one AppleScript; a script that has not answered within `ms` is stopped and counts as failed. */
function osascript(script, ms) {
  return new Promise((resolve) => {
    const child = spawn('osascript', ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { err += 'timed out'; child.kill(); }, ms);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => { clearTimeout(timer); resolve({ code: -1, out: '', err: e.message }); });
    child.on('close', code => { clearTimeout(timer); resolve({ code: code ?? -1, out: out.trim(), err }); });
  });
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
  const name = store.tasks.get(r.task)?.threadTitle || r.title;
  const n = new Notification({ title, body: `${agent} · ${p?.displayName || p?.name || ''}${name ? ' · ' + name : ''}`, silent: true, icon: iconPath('png') });
  n.on('click', () => { reveal({ focus: true }); broadcast('open-request', { project: r.project, task: r.task, run, reason: 'notification', explicit: true, engaged: false, requestedAt: Date.now() }); });
  n.show();
}

// ---------- tray ----------
function iconPath(ext) {
  const candidates = [path.join(repoRoot, 'build', `icon.${ext}`), path.join(process.resourcesPath || '', `icon.${ext}`)];
  return candidates.find(p => fs.existsSync(p)) || candidates[0];
}

let popoverShown = false;
function createTray() {
  try {
    // macOS menu bar wants a monochrome template image; Windows gets the colour mark.
    const template = path.join(path.dirname(iconPath('png')), 'trayTemplate.png');
    const img = process.platform === 'darwin' && fs.existsSync(template) ? nativeImage.createFromPath(template) : nativeImage.createFromPath(iconPath('png')).resize({ width: 16, height: 16 });
    if (process.platform === 'darwin') img.setTemplateImage(true);
    tray = new Tray(img);
    tray.setToolTip(APP_NAME);
    tray.on('click', () => { if (settings.trayPopover) togglePopover(); else reveal({ focus: true }); });
    updateTray();
  } catch (e) { log('tray unavailable', e.message); }
}

/** The compact companion as a popover anchored to the tray / menu bar icon. */
function togglePopover() {
  if (!win) createWindow({ show: false });
  if (popoverShown && win.isVisible()) { popoverShown = false; win.hide(); return; }
  if (settings.window.mode !== 'compact') setWindowMode('compact');
  let b = tray.getBounds();
  const cb = settings.window.bounds?.compact;
  const size = [cb?.width || SIZES.compact.width, cb?.height || SIZES.compact.height]; // the resize above is still in flight
  const display = screen.getDisplayNearestPoint({ x: b.x, y: b.y });
  const area = display.workArea;
  // Windows hides new tray icons in the overflow flyout and then reports no usable bounds; anchor to the taskbar corner instead.
  const usable = b.width > 0 && b.height > 0 && b.x >= area.x - 4 && b.x <= area.x + area.width + 4 && (b.y <= area.y + 8 || b.y >= area.y + area.height - 8);
  if (!usable) b = process.platform === 'darwin' ? { x: area.x + area.width - 30, y: area.y - 22, width: 22, height: 22 } : { x: area.x + area.width - 30, y: area.y + area.height, width: 24, height: 24 };
  log('popover anchor', { tray: tray.getBounds(), used: b, area });
  let x = Math.round(b.x + b.width / 2 - size[0] / 2);
  let y = process.platform === 'darwin' ? b.y + b.height + 6 : (b.y > area.y + area.height / 2 ? b.y - size[1] - 8 : b.y + b.height + 8);
  x = Math.max(area.x + 8, Math.min(x, area.x + area.width - size[0] - 8));
  y = Math.max(area.y + 8, Math.min(y, area.y + area.height - size[1] - 8));
  // One bounds call so the resize from setWindowMode and this move cannot race each other.
  win.setBounds({ x, y, width: size[0], height: size[1] }, false);
  win.setAlwaysOnTop(true, 'pop-up-menu');
  win.show(); win.focus();
  popoverShown = true;
  log('popover shown at', win.getBounds());
}

function updateTray() {
  if (!tray) return;
  const active = store.state().runs.filter(r => r.status === 'active').length;
  tray.setToolTip(active ? `${APP_NAME} · ${active} agent${active === 1 ? '' : 's'} working` : APP_NAME);
  const u = updateView();
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Layover', click: () => reveal({ focus: true }) },
    ...(u.latest && !u.skipped ? [{ label: u.installing ? `Installing Layover ${u.latest.version}…` : `Install Layover ${u.latest.version}…`, enabled: !u.installing, click: () => installUpdate().catch(e => log('update install failed', e.message)) }] : []),
    { label: settings.window.mode === 'compact' ? 'Expanded workspace' : 'Compact companion', click: () => { setWindowMode(settings.window.mode === 'compact' ? 'expanded' : 'compact'); reveal({ focus: true }); } },
    { label: 'Tracker', type: 'checkbox', checked: settings.layout === 'tracker', click: () => { settings = applySettings(settings, { layout: settings.layout === 'tracker' ? 'full' : 'tracker' }); saveSettings(settings); broadcast('settings', settings); updateTray(); reveal({ focus: true }); } },
    { type: 'separator' },
    { label: 'Quit Layover', click: () => { quitting = true; app.quit(); } },
  ]));
}

// ---------- updates ----------
// One request to api.github.com every few hours (switchable off); nothing is downloaded by the app itself.
const UPDATE_INTERVAL = 6 * 60 * 60 * 1000;
let update = { latest: null, latestVersion: null, checkedAt: 0, error: null, installing: false };
// Dev only: pretend to be an older build so the update path can be exercised against the real releases.
const appVersion = () => (!app.isPackaged && flagValue('--pretend-version')) || app.getVersion();

function updateView() {
  return { ...update, current: appVersion(), skipped: !!(update.latest && settings.updates?.skip === update.latest.version), checkEnabled: settings.updates?.check !== false };
}

async function runUpdateCheck({ manual = false } = {}) {
  if (!manual && settings.updates?.check === false) return updateView();
  const r = await checkForUpdate({ current: appVersion(), userAgent: `Layover/${appVersion()} (${process.platform})` });
  update = { ...update, ...r };
  log('update check', r.error ? 'failed: ' + r.error : r.latest ? `${r.latest.version} available` : `up to date (${r.latestVersion || '?'})`);
  broadcast('update', updateView());
  updateTray();
  return updateView();
}

function scheduleUpdateChecks() {
  setTimeout(() => runUpdateCheck().catch(e => log('update check error', e.message)), 20_000);
  setInterval(() => runUpdateCheck().catch(e => log('update check error', e.message)), UPDATE_INTERVAL);
}

/** Hand over to the install script for the newest release; it quits Layover, replaces it, reconnects the hooks and reopens it. */
async function installUpdate() {
  const v = update.latest?.version;
  if (!v) throw Error('There is no newer release to install.');
  if (update.installing) return updateView();
  update.installing = true; broadcast('update', updateView()); updateTray();
  const logPath = path.join(dataRoot, 'update.log');
  try {
    const r = await startInstall(v, { logPath });
    log('update installer started', v, r.detail);
    return { ...updateView(), log: logPath };
  } catch (e) {
    update.installing = false; broadcast('update', updateView()); updateTray();
    log('update installer failed to start', e.message);
    throw e;
  }
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
handle('return:focus', (taskId) => returnToHost(String(taskId)));
handle('outbox:send', (m) => store.queueMessage(m));
handle('outbox:cancel', (id) => store.cancelMessage(String(id)));
handle('bridge:target', (run) => bridge.target({ run }));
handle('bridge:send', (payload) => bridge.send(payload));
handle('update:get', () => updateView());
handle('update:check', () => runUpdateCheck({ manual: true }));
handle('update:install', () => installUpdate());
handle('update:skip', (version) => { settings = applySettings(settings, { updates: { skip: String(version || '') } }); saveSettings(settings); updateTray(); broadcast('settings', settings); return updateView(); });
ipcMain.on('ui:engaged', (_e, flag) => { uiEngaged = !!flag; if (flag) lastInteraction = Date.now(); });
