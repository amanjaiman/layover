#!/bin/sh
# Layover installer for macOS. Usage:
#   curl -fsSL https://raw.githubusercontent.com/amanjaiman/layover/main/scripts/install.sh | sh
# Installs Layover.app into /Applications (or ~/Applications), links the `layover` CLI, connects
# Claude Code and Codex, and opens the app. Override the release with LAYOVER_VERSION=0.5.0.
set -eu
REPO="${LAYOVER_REPO:-amanjaiman/layover}"
VERSION="${LAYOVER_VERSION:-latest}"
case "$(uname -m)" in arm64|aarch64) ARCH=arm64 ;; *) ARCH=x64 ;; esac
if [ "$VERSION" = "latest" ]; then
  URL="https://github.com/$REPO/releases/latest/download/Layover-mac-$ARCH.zip"
else
  URL="https://github.com/$REPO/releases/download/v$VERSION/Layover-$VERSION-mac-$ARCH.zip"
fi
DEST="/Applications"; [ -w "$DEST" ] || { DEST="$HOME/Applications"; mkdir -p "$DEST"; }
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
echo "Downloading Layover ($ARCH)…"
curl -fsSL "$URL" -o "$TMP/layover.zip"
echo "Installing to $DEST…"
if [ -d "$DEST/Layover.app" ]; then osascript -e 'tell application "Layover" to quit' >/dev/null 2>&1 || true; sleep 1; rm -rf "$DEST/Layover.app"; fi
ditto -x -k "$TMP/layover.zip" "$DEST"
# The build is not notarized; clear the quarantine flag so Gatekeeper lets it run.
xattr -dr com.apple.quarantine "$DEST/Layover.app" 2>/dev/null || true
CLI="$DEST/Layover.app/Contents/bin/layover"
chmod +x "$CLI" "$DEST/Layover.app/Contents/bin/layover-fast"
BIN="/usr/local/bin"; [ -w "$BIN" ] || BIN="$HOME/.local/bin"; mkdir -p "$BIN"
ln -sf "$CLI" "$BIN/layover"
case ":$PATH:" in *":$BIN:"*) ;; *) echo "Add $BIN to your PATH to use \`layover\` from a terminal (the hooks use the full path and do not need it)." ;; esac
echo "Connecting Claude Code and Codex…"
"$CLI" setup --agent all
open -a "$DEST/Layover.app"
echo "Layover is installed. Codex asks you to trust its hooks once: type /hooks inside Codex and approve the Layover entries."
