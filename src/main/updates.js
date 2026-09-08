// Update check against the GitHub releases of this repo, and the hand-off that installs a newer
// release. Layover never downloads or replaces itself: "install" runs the same install script users
// installed with, pinned to the new release's tag, and that script quits, replaces and reopens the app.
// This is the only place Layover talks to anything but 127.0.0.1, and the check can be switched off.
import fs from 'node:fs';
import { spawn } from 'node:child_process';

export const REPO = 'amanjaiman/layover';

function parseVersion(v) {
  const m = String(v || '').trim().replace(/^v/i, '').match(/^(\d+(?:\.\d+)*)(?:-([\w.]+))?/);
  return m ? { nums: m[1].split('.').map(Number), pre: m[2] || '' } : { nums: [0], pre: '' };
}

/** Compare two dotted versions: -1, 0 or 1. A pre-release (1.2.0-beta) sorts below its release. */
export function compareVersions(a, b) {
  const A = parseVersion(a), B = parseVersion(b);
  for (let i = 0; i < Math.max(A.nums.length, B.nums.length); i++) {
    const x = A.nums[i] || 0, y = B.nums[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  if (A.pre === B.pre) return 0;
  if (!A.pre) return 1;
  if (!B.pre) return -1;
  return A.pre < B.pre ? -1 : 1;
}

/** The release as {version, url, notes, publishedAt} when it is newer than `current`, else null. */
export function parseRelease(rel, current, repo = REPO) {
  if (!rel || typeof rel !== 'object' || rel.draft || rel.prerelease) return null;
  const version = String(rel.tag_name || rel.name || '').trim().replace(/^v/i, '');
  if (!/^\d+\.\d+\.\d+/.test(version)) return null;
  if (compareVersions(version, current) <= 0) return null;
  return { version, url: rel.html_url || `https://github.com/${repo}/releases/tag/v${version}`, notes: String(rel.body || '').slice(0, 4000).trim(), publishedAt: rel.published_at || null };
}

export async function fetchLatest({ repo = REPO, fetchImpl = globalThis.fetch, userAgent = 'Layover', timeoutMs = 10_000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': userAgent }, signal: ctl.signal });
    if (!r.ok) throw Error(`GitHub answered ${r.status}`);
    return await r.json();
  } finally { clearTimeout(timer); }
}

/** One check. Never throws: a failed check is {error} and the app stays quiet about it. */
export async function checkForUpdate({ current, repo = REPO, fetchImpl, userAgent } = {}) {
  const checkedAt = Date.now();
  try {
    const rel = await fetchLatest({ repo, fetchImpl, userAgent });
    return { checkedAt, current, latest: parseRelease(rel, current, repo), latestVersion: String(rel?.tag_name || '').replace(/^v/i, ''), error: null };
  } catch (e) {
    return { checkedAt, current, latest: null, latestVersion: null, error: e?.name === 'AbortError' ? 'timed out' : (e?.message || String(e)) };
  }
}

/**
 * The command that installs a release: the install script at that release's tag, told which version
 * to fetch. Everything the script prints goes to `logPath` so a silent failure can still be read.
 * Windows returns a full command line for Win32_Process.Create (see installUpdate); macOS a sh argv.
 */
export function installCommand(version, { platform = process.platform, repo = REPO, logPath = '' } = {}) {
  if (!/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(String(version))) throw Error('Not a release version: ' + version);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw Error('Bad repo');
  const raw = `https://raw.githubusercontent.com/${repo}/v${version}/scripts`;
  if (platform === 'win32') {
    // Single quotes only inside: the whole thing sits in -Command "…" on a command line. Windows
    // PowerShell 5.1 runs it (always present); Out-File keeps the log UTF-8 instead of 5.1's UTF-16.
    const log = logPath ? ` *>&1 | Out-File -FilePath '${logPath.replace(/'/g, "''")}' -Append -Encoding utf8` : '';
    const ps = `& { try { $env:LAYOVER_VERSION='${version}'; $env:LAYOVER_REPO='${repo}'; irm ${raw}/install.ps1 | iex } catch { 'update failed: ' + $_ } }${log}`;
    return { kind: 'wmi', commandLine: `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -Command "${ps}"` };
  }
  return { kind: 'sh', cmd: '/bin/sh', args: ['-c', `LAYOVER_VERSION='${version}' LAYOVER_REPO='${repo}' curl -fsSL ${raw}/install.sh | /bin/sh`] };
}

/**
 * Start the installer for `version` and resolve once it is running on its own. On Windows every
 * child of Layover dies with it (Chromium keeps its tree in a job object) and the installer must stop
 * Layover, so the worker is created through WMI, which parents it to the WMI host instead of us.
 */
export function installUpdate(version, { platform = process.platform, repo = REPO, logPath = '' } = {}) {
  const c = installCommand(version, { platform, repo, logPath });
  if (logPath) { try { fs.appendFileSync(logPath, `\n=== ${new Date().toISOString()} installing ${version} ===\n`); } catch { /* the log is a courtesy */ } }
  if (c.kind === 'wmi') {
    const wrapper = `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${c.commandLine.replace(/'/g, "''")}' }; if ($r.ReturnValue -ne 0) { exit $r.ReturnValue }; 'pid=' + $r.ProcessId`;
    return new Promise((resolve, reject) => {
      let out = '';
      const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-Command', wrapper], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { out += d; });
      p.on('error', reject);
      p.on('close', code => code === 0 ? resolve({ ok: true, detail: out.trim() }) : reject(Error(`Could not start the installer (${out.trim() || 'code ' + code})`)));
    });
  }
  return new Promise((resolve, reject) => {
    let fd = 'ignore';
    if (logPath) { try { fd = fs.openSync(logPath, 'a'); } catch { fd = 'ignore'; } }
    try {
      const p = spawn(c.cmd, c.args, { detached: true, stdio: ['ignore', fd, fd] });
      p.on('error', reject);
      p.unref();
      resolve({ ok: true, detail: 'pid=' + p.pid });
    } catch (e) { reject(e); }
    finally { if (typeof fd === 'number') { try { fs.closeSync(fd); } catch { /* already closed */ } } }
  });
}
