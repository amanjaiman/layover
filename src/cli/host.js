// Finds the window the agent is running in: the first ancestor of this process that owns a top-level
// window (Windows Terminal, VS Code, the Claude desktop app, a console). Windows only; null elsewhere.
import { spawnSync } from 'node:child_process';

export function findHostWindow(pid = process.pid) {
  if (process.platform === 'darwin') return findFrontmostMac();
  if (process.platform !== 'win32') return null;
  const script = `
$procs = @{}; Get-CimInstance Win32_Process | ForEach-Object { $procs[[int]$_.ProcessId] = [int]$_.ParentProcessId }
$id = ${pid}; $hops = 0
while ($id -gt 4 -and $hops -lt 14) {
  $gp = Get-Process -Id $id -ErrorAction SilentlyContinue
  if ($gp -and $gp.MainWindowHandle -ne 0 -and $gp.ProcessName -notin @('cmd','conhost','OpenConsole','node','Layover','electron')) {
    Write-Output ("{0}|{1}|{2}|{3}" -f $id, $gp.MainWindowHandle, $gp.ProcessName, ($gp.MainWindowTitle -replace '[|\\r\\n]', ' '))
    break
  }
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
 * macOS: the agent's session starts in whichever app is frontmost (Terminal, iTerm, VS Code, the
 * Claude desktop app). Record its bundle id so Return can activate it. `hwnd` carries the pid.
 */
function findFrontmostMac() {
  const script = 'tell application "System Events" to set p to first application process whose frontmost is true\n' +
    'tell application "System Events" to return (unix id of p as text) & "|" & (bundle identifier of p) & "|" & (name of p)';
  const r = spawnSync('osascript', ['-e', script], { encoding: 'utf8', timeout: 5000 });
  const line = (r.stdout || '').trim();
  if (!line || r.status !== 0) return null;
  const [pid, bundle, name] = line.split('|');
  if (!/^\d+$/.test(pid || '')) return null;
  return { pid: Number(pid), hwnd: String(pid), name: String(name || bundle || '').slice(0, 80), title: String(bundle || '').slice(0, 200) };
}
