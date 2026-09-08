# Layover installer for Windows. Usage (PowerShell):
#   irm https://raw.githubusercontent.com/amanjaiman/layover/main/scripts/install.ps1 | iex
# Downloads the latest installer, installs per-user (no admin), connects Claude Code and Codex, opens the app.
# The app's own "Install and restart" runs this same script pinned to the new release (LAYOVER_VERSION).
# Keep this file ASCII: Windows PowerShell 5.1 fetches it without a charset and would mangle anything else.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # the 5.1 progress bar makes a 100 MB download several times slower
$repo = if ($env:LAYOVER_REPO) { $env:LAYOVER_REPO } else { 'amanjaiman/layover' }
$version = if ($env:LAYOVER_VERSION) { $env:LAYOVER_VERSION } else { 'latest' }
$url = if ($version -eq 'latest') { "https://github.com/$repo/releases/latest/download/Layover-Setup.exe" } else { "https://github.com/$repo/releases/download/v$version/Layover-Setup-$version.exe" }
$tmp = Join-Path $env:TEMP "Layover-Setup.exe"
Write-Host "Downloading Layover ($version)..."
Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing
if ((Get-Item $tmp).Length -lt 10MB) { throw "The download is too small to be the installer ($((Get-Item $tmp).Length) bytes)" }
Write-Host "Installing..."
Get-Process Layover -ErrorAction SilentlyContinue | Stop-Process -Force
$p = Start-Process -FilePath $tmp -ArgumentList '/S' -PassThru -Wait
if ($p.ExitCode -ne 0) { throw "Installer exited with $($p.ExitCode)" }
$app = Join-Path $env:LOCALAPPDATA 'Programs\layover'
$cli = Join-Path $app 'bin\layover.cmd'
Write-Host "Connecting Claude Code and Codex..."
& $cli setup --agent all
Start-Process -FilePath (Join-Path $app 'Layover.exe')
Write-Host "Layover is installed. Open a new terminal to use 'layover' on PATH. Codex asks you to trust its hooks once: type /hooks inside Codex and approve the Layover entries."
