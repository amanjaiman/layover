// App settings. Plain JSON, atomic writes, defaults that keep the app quiet.
import fs from 'node:fs';
import path from 'node:path';
import { settingsFile } from './paths.js';

export const DEFAULTS = {
  version: 1,
  onboarded: false,
  theme: 'system',                 // system | light | dark
  openOnRunStart: 'reveal',        // open: show the window (without stealing focus) | reveal: only if already running | never
  notifyOnComplete: true,          // Windows toast when a run finishes
  closeToTray: true,               // closing the window keeps Layover in the tray
  hookContext: true,               // hooks print one short line so the agent knows the run id
  breakReminder: { enabled: false, minutes: 30, mode: 'suggest' }, // suggest | auto
  window: { mode: 'expanded' },
};

export function loadSettings(file = settingsFile) {
  let s = {};
  try { if (fs.existsSync(file)) s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { s = {}; }
  return merge(structuredClone(DEFAULTS), s);
}

export function saveSettings(s, file = settingsFile) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 1));
  fs.renameSync(tmp, file);
  return s;
}

function merge(base, extra) {
  if (!extra || typeof extra !== 'object') return base;
  for (const [k, v] of Object.entries(extra)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') base[k] = merge(base[k], v);
    else base[k] = v;
  }
  return base;
}

export function validateSettings(patch) {
  const out = {};
  if (patch.theme !== undefined) { if (!['system', 'light', 'dark'].includes(patch.theme)) throw Error('Invalid theme'); out.theme = patch.theme; }
  if (patch.openOnRunStart !== undefined) { if (!['open', 'reveal', 'never'].includes(patch.openOnRunStart)) throw Error('Invalid openOnRunStart'); out.openOnRunStart = patch.openOnRunStart; }
  for (const k of ['notifyOnComplete', 'closeToTray', 'hookContext', 'onboarded']) if (patch[k] !== undefined) out[k] = !!patch[k];
  if (patch.breakReminder !== undefined) {
    const b = patch.breakReminder || {};
    out.breakReminder = {};
    if (b.enabled !== undefined) out.breakReminder.enabled = !!b.enabled;
    if (b.minutes !== undefined) { if (![15, 30, 45, 60, 90].includes(Number(b.minutes))) throw Error('Invalid interval'); out.breakReminder.minutes = Number(b.minutes); }
    if (b.mode !== undefined) { if (!['suggest', 'auto'].includes(b.mode)) throw Error('Invalid reminder mode'); out.breakReminder.mode = b.mode; }
  }
  if (patch.window !== undefined) { const w = patch.window || {}; out.window = {}; if (w.mode !== undefined) { if (!['expanded', 'compact'].includes(w.mode)) throw Error('Invalid window mode'); out.window.mode = w.mode; } }
  return out;
}

export function applySettings(current, patch) { return merge(current, validateSettings(patch)); }
