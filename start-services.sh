#!/bin/bash
LOG_DIR="/home/tyler/dynasty-calc"

# ── Source profile to get node/nvm on PATH (critical for non-interactive shells) ──
export HOME=/home/tyler
for f in "$HOME/.profile" "$HOME/.bashrc" "$HOME/.nvm/nvm.sh"; do
  [ -f "$f" ] && source "$f" 2>/dev/null
done

# Verify node is available
if ! command -v node &>/dev/null; then
  echo "[$(date)] FATAL: node not found on PATH. PATH=$PATH" >> "$LOG_DIR/startup.log"
  exit 1
fi
echo "[$(date)] node found: $(which node) — $(node --version)" >> "$LOG_DIR/startup.log"

# Only start if not already running
if ! ss -tlnp 2>/dev/null | grep -q ':3001'; then
  pkill -f ktc-proxy 2>/dev/null; sleep 1
  cd "$LOG_DIR"
  nohup node "$LOG_DIR/ktc-proxy.js" >> "$LOG_DIR/proxy.log" 2>&1 &
  disown $!
  echo "[$(date)] KTC proxy started, PID: $!" >> "$LOG_DIR/startup.log"
  sleep 2
else
  echo "[$(date)] KTC proxy already running on :3001" >> "$LOG_DIR/startup.log"
fi

if ! ss -tlnp 2>/dev/null | grep -q ':3000'; then
  pkill -f "serve " 2>/dev/null; sleep 1
  SERVE_BIN="$HOME/.npm-global/bin/serve"
  if [ ! -f "$SERVE_BIN" ]; then
    SERVE_BIN="$(which serve 2>/dev/null)"
  fi
  if [ -z "$SERVE_BIN" ]; then
    echo "[$(date)] WARN: serve not found, skipping file server" >> "$LOG_DIR/startup.log"
  else
    nohup "$SERVE_BIN" "$LOG_DIR" -p 3000 >> "$LOG_DIR/serve.log" 2>&1 &
    disown $!
    echo "[$(date)] File server started, PID: $!" >> "$LOG_DIR/startup.log"
  fi
else
  echo "[$(date)] File server already running on :3000" >> "$LOG_DIR/startup.log"
fi

echo "[$(date)] start-services.sh complete — entering sleep to keep WSL alive" >> "$LOG_DIR/startup.log"

# CRITICAL: sleep infinity must be FOREGROUND so bash (and wsl) never exits.
# If wsl exits, WSL tears down the session and kills all child processes.
exec sleep infinity
