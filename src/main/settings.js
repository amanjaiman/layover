// App settings. Plain JSON, atomic writes, defaults that keep the app quiet.
import fs from 'node:fs';
import path from 'node:path';
import { settingsFile } from './paths.js';

export const DEFAULTS = {
  version: 2,
  onboarded: false,
  theme: 'system',                 // system | light | dark
  layout: 'full',                  // full: workspaces with Now · Next · Notes · Break | tracker: every agent across projects, as a to-do list
  accent: 'teal',                  // teal | ink | mulberry | ember | oxblood | umber (foundations v0.7)
  style: 'default',                // default | flight: airport words and a departures-board look; copy and styling only, never behaviour
  openOnRunStart: 'focus',         // focus: bring Layover forward | open: show it behind your work | reveal: only if already open | never
  notifyOnComplete: true,          // Windows toast when a run finishes
  closeToTray: true,               // closing the window keeps Layover in the tray
  trayPopover: process.platform === 'darwin', // tray / menu-bar click opens the compact companion as a popover
  hookContext: true,               // hooks print one short line so the agent knows the run id
  breakReminder: { enabled: false, minutes: 30, mode: 'suggest' }, // suggest | auto
  updates: { check: true, skip: '' }, // check: ask GitHub for the latest release every few hours (the only outbound request); skip: a version the user chose to ignore
  window: { mode: 'expanded' },
};

export function loadSettings(file = settingsFile) {
  let s = {};
  try { if (fs.existsSync(file)) s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { s = {}; }
  if (!s.version || s.version < 2) { if (s.openOnRunStart === 'reveal' || s.openOnRunStart === 'open') s.openOnRunStart = 'focus'; s.version = 2; } // v1 had no "bring forward" option
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
  if (patch.layout !== undefined) { if (!['full', 'tracker'].includes(patch.layout)) throw Error('Invalid layout'); out.layout = patch.layout; }
  if (patch.accent !== undefined) { if (!['teal', 'ink', 'mulberry', 'ember', 'oxblood', 'umber'].includes(patch.accent)) throw Error('Invalid accent'); out.accent = patch.accent; }
  if (patch.style !== undefined) { if (!['default', 'flight'].includes(patch.style)) throw Error('Invalid style'); out.style = patch.style; }
  if (patch.openOnRunStart !== undefined) { if (!['focus', 'open', 'reveal', 'never'].includes(patch.openOnRunStart)) throw Error('Invalid openOnRunStart'); out.openOnRunStart = patch.openOnRunStart; }
  for (const k of ['notifyOnComplete', 'closeToTray', 'hookContext', 'onboarded', 'trayPopover']) if (patch[k] !== undefined) out[k] = !!patch[k];
  if (patch.breakReminder !== undefined) {
    const b = patch.breakReminder || {};
    out.breakReminder = {};
    if (b.enabled !== undefined) out.breakReminder.enabled = !!b.enabled;
    if (b.minutes !== undefined) { if (![15, 30, 45, 60, 90].includes(Number(b.minutes))) throw Error('Invalid interval'); out.breakReminder.minutes = Number(b.minutes); }
    if (b.mode !== undefined) { if (!['suggest', 'auto'].includes(b.mode)) throw Error('Invalid reminder mode'); out.breakReminder.mode = b.mode; }
  }
  if (patch.updates !== undefined) {
    const u = patch.updates || {};
    out.updates = {};
    if (u.check !== undefined) out.updates.check = !!u.check;
    if (u.skip !== undefined) { if (typeof u.skip !== 'string' || u.skip.length > 40) throw Error('Invalid skip version'); out.updates.skip = u.skip; }
  }
  if (patch.window !== undefined) { const w = patch.window || {}; out.window = {}; if (w.mode !== undefined) { if (!['expanded', 'compact'].includes(w.mode)) throw Error('Invalid window mode'); out.window.mode = w.mode; } if (w.railCollapsed !== undefined) out.window.railCollapsed = !!w.railCollapsed; if (w.trackerSort !== undefined) { if (!['status', 'project'].includes(w.trackerSort)) throw Error('Invalid tracker sort'); out.window.trackerSort = w.trackerSort; } if (w.trackerFolded !== undefined) { if (!Array.isArray(w.trackerFolded) || w.trackerFolded.length > 200 || !w.trackerFolded.every(k => typeof k === 'string' && /^[\w.:-]{1,180}$/.test(k))) throw Error('Invalid tracker folded groups'); out.window.trackerFolded = [...new Set(w.trackerFolded)]; } }
  return out;
}

export function applySettings(current, patch) { return merge(current, validateSettings(patch)); }
