// Finds the window the agent is running in, so "Return" can bring it forward: on Windows the terminal
// window hosting the agent's console, else the first ancestor with a top-level window (VS Code, the
// Claude desktop app); on macOS the app the agent runs under.
import { spawnSync } from 'node:child_process';

/** `guess`: on macOS, may the frontmost app stand in when the process tree names no app? */
export function findHostWindow(pid = process.pid, { guess = true } = {}) {
  if (process.platform === 'darwin') return findHostMac(pid, guess);
  if (process.platform !== 'win32') return null;
  // Windows Terminal runs every window in one process, so that process's MainWindowHandle is just
  // whichever window it picked, often not the agent's. The agent's console knows better: a
  // pseudoconsole window is owned by the terminal window hosting that tab, so attaching to each
  // ancestor's console and taking its root owner finds the right window. Processes without a
  // visible console owner (VS Code, the Claude desktop app) fall back to the first ancestor that
  // owns a top-level window.
  const script = `
Add-Type -Namespace L -Name C -MemberDefinition '[DllImport("kernel32.dll")] public static extern bool FreeConsole(); [DllImport("kernel32.dll")] public static extern bool AttachConsole(uint p); [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow(); [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint f); [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p); [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);'
$procs = @{}; Get-CimInstance Win32_Process | ForEach-Object { $procs[[int]$_.ProcessId] = [int]$_.ParentProcessId }
function Say($h) {
  $wp = [uint32]0; [void][L.C]::GetWindowThreadProcessId($h, [ref]$wp); $gp = Get-Process -Id $wp -ErrorAction SilentlyContinue
  $sb = New-Object System.Text.StringBuilder 256; [void][L.C]::GetWindowText($h, $sb, 256)
  Write-Output ("{0}|{1}|{2}|{3}" -f $wp, $h, $(if ($gp) { $gp.ProcessName } else { 'window' }), ($sb.ToString() -replace '[|\\r\\n]', ' '))
}
$id = ${pid}; $hops = 0
while ($id -gt 4 -and $hops -lt 14) {
  [void][L.C]::FreeConsole()
  if ([L.C]::AttachConsole([uint32]$id)) {
    $cw = [L.C]::GetConsoleWindow(); [void][L.C]::FreeConsole()
    if ($cw -ne [IntPtr]::Zero) { $root = [L.C]::GetAncestor($cw, 3); if ($root -ne [IntPtr]::Zero -and [L.C]::IsWindowVisible($root)) { Say $root; exit 0 } }
  }
  $gp = Get-Process -Id $id -ErrorAction SilentlyContinue
  if ($gp -and $gp.MainWindowHandle -ne 0 -and $gp.ProcessName -notin @('cmd','conhost','OpenConsole','node','Layover','electron')) { Say $gp.MainWindowHandle; exit 0 }
  if (-not $procs.ContainsKey($id)) { break }
  $id = $procs[$id]; $hops++
}`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
  const line = (r.stdout || '').trim().split(/\r?\n/).find(l => /^\d+\|\d+\|/.test(l));
  if (!line) return null;
  const [p, hwnd, name, title] = line.split('|');
  return { pid: Number(p), hwnd: String(hwnd), name: String(name).slice(0, 80), title: String(title || '').trim().slice(0, 200) };
}


/**
 * macOS: walk up the process tree to the first app bundle the agent runs under (Terminal, iTerm,
 * VS Code, the Claude or Codex desktop app) and record its bundle id so Return can activate it,
 * plus the terminal tab's tty so Return can pick that tab. `hwnd` carries the pid.
 * iTerm2 runs shells under a detached iTermServer (its parent is launchd, not iTerm2), so that
 * server stands for iTerm2. `ps` lines are `pid ppid tty comm`.
 */
export function macHostFromProcesses(pid, psOutput) {
  const parent = new Map(), exe = new Map(), ttys = new Map();
  for (const line of String(psOutput).split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/);
    if (m) { parent.set(Number(m[1]), Number(m[2])); ttys.set(Number(m[1]), m[3]); exe.set(Number(m[1]), m[4]); }
  }
  let tty = '';
  for (let id = pid, hops = 0; id > 1 && hops < 20; id = parent.get(id), hops++) {
    const t = ttys.get(id) || '';
    if (!tty && /^(tty)?s?\d+$/.test(t)) tty = '/dev/' + (t.startsWith('tty') ? t : 'tty' + t); // ttys003, or s003 in short form
    const cmd = exe.get(id) || '';
    const app = cmd.match(/^(.*?\/([^/]+)\.app)\/Contents\//);
    if (app && app[2] !== 'Layover') return { pid: id, app: app[1], name: app[2], tty };
    if (/\/iTerm2\/iTermServer[^/]*$/.test(cmd)) return { pid: id, app: '', bundle: 'com.googlecode.iterm2', name: 'iTerm2', tty };
    if (!parent.has(id)) break;
  }
  return null;
}

/** Inside tmux the agent's ancestors end at the tmux server (a launchd child); the client sits in the terminal. */
function tmuxClientPid() {
  if (!process.env.TMUX) return 0;
  for (const args of [['display-message', '-p', '#{client_pid}'], ['list-clients', '-F', '#{client_pid}']]) {
    const r = spawnSync('tmux', args, { encoding: 'utf8', timeout: 2000 });
    const p = Number((r.stdout || '').trim().split('\n')[0]);
    if (r.status === 0 && Number.isSafeInteger(p) && p > 1) return p;
  }
  return 0;
}

function findHostMac(pid, guess) {
  const ps = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,tty=,comm='], { encoding: 'utf8', timeout: 3000 });
  const found = ps.status === 0 ? macHostFromProcesses(tmuxClientPid() || pid, ps.stdout) : null;
  if (found) {
    let bundle = found.bundle || '';
    if (!bundle) { const r = spawnSync('defaults', ['read', `${found.app}/Contents/Info`, 'CFBundleIdentifier'], { encoding: 'utf8', timeout: 3000 }); bundle = r.status === 0 ? r.stdout.trim() : ''; }
    if (bundle) return { pid: found.pid, hwnd: String(found.pid), name: found.name.slice(0, 80), title: bundle.slice(0, 200), via: 'process', ...(found.tty ? { tty: found.tty } : {}) };
  }
  // No app in the tree (ssh, screen, a launchd job): the frontmost app is only a guess, and a fair one
  // only while the user is starting the agent. On a resume or clear it may be anything (Slack).
  return guess ? findFrontmostMac() : null;
}

function findFrontmostMac() {
  const script = 'tell application "System Events" to set p to first application process whose frontmost is true\n' +
    'tell application "System Events" to return (unix id of p as text) & "|" & (bundle identifier of p) & "|" & (name of p)';
  const r = spawnSync('osascript', ['-e', script], { encoding: 'utf8', timeout: 5000 });
  const line = (r.stdout || '').trim();
  if (!line || r.status !== 0) return null;
  const [pid, bundle, name] = line.split('|');
  if (!/^\d+$/.test(pid || '') || /^com\.layover\./.test(bundle || '') || name === 'Layover') return null; // Layover itself is never where the agent lives
  return { pid: Number(pid), hwnd: String(pid), name: String(name || bundle || '').slice(0, 80), title: String(bundle || '').slice(0, 200), via: 'frontmost' };
}
