// Shared locations. No Electron imports: the CLI, hooks and tests use this too.
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export const APP_ID = 'layover';
export const APP_NAME = 'Layover';
export const PROTOCOL_VERSION = 2;

function defaultDataRoot() {
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || os.homedir(), 'Layover');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Layover');
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'Layover');
}
export const dataRoot = path.resolve(process.env.LAYOVER_DATA || defaultDataRoot());
export const dataDir = path.join(dataRoot, 'data');
export const tokenFile = path.join(dataRoot, 'token');
export const settingsFile = path.join(dataRoot, 'settings.json');
export const logFile = path.join(dataRoot, 'layover.log');
export const port = Number(process.env.LAYOVER_PORT || 43137);
export const origin = `http://127.0.0.1:${port}`;

export const ID = /^[\w.:-]{1,180}$/;
export const isId = (v) => typeof v === 'string' && ID.test(v);

/** Canonical form of a folder path used to identify a project across agents. */
export function canonicalPath(p) {
  let r = path.resolve(String(p)).replace(/\\/g, '/');
  if (r.length > 1) r = r.replace(/\/+$/, '');
  if (process.platform === 'win32') r = r.toLowerCase();
  return r;
}

/** Stable project id derived from a folder path. Same folder → same workspace, for every agent. */
export function projectIdFromPath(p) {
  return 'p_' + crypto.createHash('sha1').update(canonicalPath(p)).digest('hex').slice(0, 16);
}

export function projectNameFromPath(p) {
  const base = path.basename(path.resolve(String(p)));
  return base || String(p);
}

export function homeDir() {
  return process.env.LAYOVER_HOME || os.homedir();
}
