// CLI-side transport: talk to the running app, launch it when needed, spool when it cannot run.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dataRoot, dataDir, tokenFile, origin, settingsFile } from '../main/paths.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Where the desktop app lives relative to this CLI file (packaged: resources/src/cli -> Layover.exe). */
export function appLauncher() {
  if (process.env.LAYOVER_EXE) return { exe: process.env.LAYOVER_EXE, args: [] };
  const packaged = path.resolve(here, '..', '..', '..', process.platform === 'win32' ? 'Layover.exe' : 'layover');
  if (fs.existsSync(packaged)) return { exe: packaged, args: [] };
  const repo = path.resolve(here, '..', '..');
  const electron = path.join(repo, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
  if (fs.existsSync(electron)) return { exe: electron, args: [repo] };
  return null;
}

export function readSettings() {
  try { return JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch { return {}; }
}

function token() {
  try { return fs.readFileSync(tokenFile, 'utf8').trim(); } catch { return ''; }
}

export async function request(route, body, timeout = 4000) {
  const r = await fetch(origin + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  const j = await r.json();
  if (!r.ok) throw Error(j.error || JSON.stringify(j));
  return j;
}

export async function health() {
  try {
    const r = await fetch(origin + '/health', { signal: AbortSignal.timeout(1500) });
    const j = await r.json();
    return j.app === 'layover' ? j : null;
  } catch { return null; }
}

/** Start the desktop app (background or with an open request) and wait until its service answers. */
export async function launch({ background = true, open = null, waitMs = 12000 } = {}) {
  const l = appLauncher();
  if (!l) throw Error('Layover app not found. Install Layover or set LAYOVER_EXE.');
  const args = [...l.args];
  if (background) args.push('--background');
  if (open) args.push('--open', JSON.stringify(open));
  fs.mkdirSync(dataRoot, { recursive: true });
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // the shim sets it for the CLI; the app itself must not inherit it
  const child = spawn(l.exe, args, { detached: true, stdio: 'ignore', windowsHide: false, env });
  child.unref();
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 150));
    if (await health()) return { launched: true };
  }
  return { launched: false };
}

/** Make sure the app is reachable; launch it if allowed. Returns 'running' | 'launched' | 'unavailable'. */
export async function ensureApp({ open = null, background = true } = {}) {
  if (await health()) return 'running';
  const s = readSettings();
  if (s.autoStart === false && !open) return 'unavailable';
  const r = await launch({ background, open });
  return r.launched ? 'launched' : 'unavailable';
}

/** Durable fallback when the app cannot be reached: the app ingests the spool on its next start. */
export function spool(events) {
  const dir = path.join(dataDir, 'spool');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.json`);
  fs.writeFileSync(file, JSON.stringify(events));
  return file;
}

/** Deliver events, launching or spooling as needed. Returns per-event results. */
export async function deliver(events, { open = null, background = true } = {}) {
  const status = await ensureApp({ open, background });
  if (status === 'unavailable') return { status, spooled: spool(events), results: [] };
  const { results } = await request('/api/events/batch', events, 8000);
  return { status, results };
}
