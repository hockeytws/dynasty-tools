#!/bin/bash
# start-services.sh — called by dynasty-startup.ps1 at boot

LOG_DIR="/home/tyler/dynasty-calc"

# Kill any stale instances
pkill -f ktc-proxy 2>/dev/null
pkill -f "serve " 2>/dev/null
sleep 1

# Start KTC proxy on port 3001
setsid nohup node /home/tyler/dynasty-calc/ktc-proxy.js > "$LOG_DIR/proxy.log" 2>&1 &
echo "[$(date)] KTC proxy started, PID: $!" >> "$LOG_DIR/startup.log"

sleep 2

# Start file server on port 3000
setsid nohup /home/tyler/.npm-global/bin/serve /home/tyler/dynasty-calc -p 3000 > "$LOG_DIR/serve.log" 2>&1 &
echo "[$(date)] File server started, PID: $!" >> "$LOG_DIR/startup.log"

echo "[$(date)] start-services.sh complete" >> "$LOG_DIR/startup.log"
