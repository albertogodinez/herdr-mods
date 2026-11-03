#!/bin/sh
# Install (or reinstall) the launchd agent that keeps this repo in step with
# ~/.config/herdr-app. Remove it with: scripts/install-sync.sh --uninstall
set -eu

LABEL="dev.herdr-mods.sync"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
APP="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
PY="$(command -v python3)"
LOG="$HOME/Library/Logs/herdr-mods-sync.log"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
if [ "${1:-}" = "--uninstall" ]; then
  rm -f "$PLIST"
  echo "removed $LABEL"
  exit 0
fi

mkdir -p "$HOME/Library/LaunchAgents"
cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$PY</string><string>-I</string><string>$REPO/scripts/sync.py</string></array>
  <key>EnvironmentVariables</key><dict><key>HERDR_APP_HOME</key><string>$APP</string></dict>
  <!-- Fires when an entry in these changes; edits nested inside a mod folder are caught by the interval. -->
  <key>WatchPaths</key>
  <array><string>$APP/mods</string><string>$APP/layouts</string><string>$APP/keys.json</string></array>
  <key>StartInterval</key><integer>30</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "installed $LABEL -> $REPO (log: $LOG)"
