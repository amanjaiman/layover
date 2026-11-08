// Shared locations. No Electron imports: the CLI, hooks and tests use this too.
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

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

/** Resolve linked worktrees through Git metadata, never through folder-name guesses. */
export function projectPathFromPath(p) {
  const original = path.resolve(String(p));
  for (let dir = original; ; dir = path.dirname(dir)) {
    const marker = path.join(dir, '.git');
    let stat = null;
    try { stat = fs.statSync(marker); } catch { /* no marker here: keep walking up */ }
    if (stat?.isDirectory()) return original;
    if (stat) {
      try {
        const match = /^gitdir:\s*(.+)\s*$/m.exec(fs.readFileSync(marker, 'utf8'));
        if (!match) return original;
        const gitDir = path.resolve(dir, match[1].trim());
        const common = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim());
        // Submodules have a gitdir file too, but no linked-worktree commondir.
        if (path.basename(common) === '.git' && fs.statSync(common).isDirectory()) return path.dirname(common);
      } catch { /* missing or unreadable metadata: retain the existing identity */ }
      return original;
    }
    if (path.dirname(dir) === dir) return original;
  }
}

/** no-mistakes keeps disposable checkouts next to its configured receive repository. */
export function managedWorktreeRoot(p) {
  try {
    const config = path.join(p, '.git', 'config');
    if (!fs.existsSync(config)) return null;
    const remote = execFileSync('git', ['config', '--file', config, '--get', 'remote.no-mistakes.url'], { encoding: 'utf8', windowsHide: true, timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (!path.isAbsolute(remote) || path.basename(path.dirname(remote)) !== 'repos' || !remote.endsWith('.git')) return null;
    return path.join(path.dirname(path.dirname(remote)), 'worktrees', path.basename(remote, '.git'));
  } catch { return null; }
}

/** Stable project id derived from a folder path. Same folder → same workspace, for every agent. */
export function projectIdFromPath(p) {
  return folderId(projectPathFromPath(p));
}

/** Id of exactly this folder, without worktree resolution. Older releases derived every id this way. */
export function folderId(p) {
  return 'p_' + crypto.createHash('sha1').update(canonicalPath(p)).digest('hex').slice(0, 16);
}

export function projectNameFromPath(p) {
  const base = path.basename(projectPathFromPath(p));
  return base || String(p);
}

export function homeDir() {
  return process.env.LAYOVER_HOME || os.homedir();
}

/**
 * The entry of `list` that covers `folder`, or '' when none does. A folder is covered when it is an
 * entry or sits inside one, and so is a linked worktree whose main checkout is covered (`resolve:
 * false` skips that Git lookup, for paths that are already a workspace's own folder).
 */
export function ignoredFolder(folder, list, { resolve = true } = {}) {
  if (!folder || !Array.isArray(list) || !list.length) return '';
  const under = (p, root) => p === root || p.startsWith(root.endsWith('/') ? root : root + '/');
  const here = [canonicalPath(folder)];
  for (const entry of list) {
    if (typeof entry !== 'string' || !entry) continue;
    const root = canonicalPath(entry);
    if (under(here[0], root)) return entry;
    if (!resolve) continue;
    if (here.length === 1) here.push(canonicalPath(projectPathFromPath(folder))); // resolved only when needed: it reads Git metadata
    if (under(here[1], root)) return entry;
  }
  return '';
}
