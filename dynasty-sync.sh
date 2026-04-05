#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════════
# dynasty-sync.sh — Full sync, backup, and deploy for Dynasty Tools
#
# What it does:
#   1. Validates git is set up
#   2. Ensures .gitignore is current
#   3. Builds app.html from index.html (build_app.py)
#   4. Commits and pushes all trackable changed files to GitHub
#   5. Creates a timestamped full backup (including secrets/data)
#   6. Moves backups older than 7 days to a "buffer" folder
#   7. Permanently deletes buffer backups older than 30 days
#   8. Prints a summary of what to upload to Claude project files
#
# Usage:
#   chmod +x dynasty-sync.sh   (first time only)
#   ./dynasty-sync.sh
#   ./dynasty-sync.sh --no-push    (backup only, skip git push)
#   ./dynasty-sync.sh --no-backup  (git push only, skip backup)
# ═══════════════════════════════════════════════════════════════════════════════

set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────────────
REPO_DIR="$HOME/dynasty-calc"
# Backup destination — OneDrive if available, otherwise ~/dynasty-backups
if [ -d "/mnt/c/Users/tyler/OneDrive" ]; then
  BACKUP_ROOT="/mnt/c/Users/tyler/OneDrive/dynasty-calc-backups"
else
  BACKUP_ROOT="$HOME/dynasty-backups"
fi
BACKUP_ACTIVE="$BACKUP_ROOT/active"    # recent backups (≤7 days)
BACKUP_BUFFER="$BACKUP_ROOT/buffer"    # aging backups (7–30 days)
KEEP_ACTIVE_DAYS=7
KEEP_BUFFER_DAYS=30

# ── Flags ─────────────────────────────────────────────────────────────────────
DO_PUSH=true
DO_BACKUP=true
for arg in "$@"; do
  case $arg in
    --no-push)   DO_PUSH=false ;;
    --no-backup) DO_BACKUP=false ;;
  esac
done

# ── Colors ────────────────────────────────────────────────────────────────────
GRN='\033[0;32m'; YLW='\033[1;33m'; RED='\033[0;31m'; BLU='\033[0;34m'; RST='\033[0m'
ok()   { echo -e "${GRN}  ✓ $*${RST}"; }
info() { echo -e "${BLU}  → $*${RST}"; }
warn() { echo -e "${YLW}  ⚠ $*${RST}"; }
fail() { echo -e "${RED}  ✗ $*${RST}"; exit 1; }
hdr()  { echo -e "\n${BLU}═══ $* ═══${RST}"; }

cd "$REPO_DIR" || fail "Cannot cd to $REPO_DIR"

# ═══════════════════════════════════════════════════════════════════════════════
hdr "DYNASTY TOOLS SYNC — $(date '+%Y-%m-%d %H:%M')"
# ═══════════════════════════════════════════════════════════════════════════════

# ── Step 1: Validate git ──────────────────────────────────────────────────────
hdr "1. Git setup"
if [ ! -d ".git" ]; then
  warn "No git repo found. Initializing..."
  git init
  git remote add origin https://github.com/hockeytws/dynasty-tools.git
  git branch -M main
  ok "Git initialized"
else
  # Ensure we're on main
  BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null | tr -d '\n\r' || echo "none")
  if [ "$BRANCH" = "main" ] || [ "$BRANCH" = "master" ]; then
    ok "Git repo on branch: $BRANCH"
  else
    warn "On branch '$BRANCH' — switching to main"
    git checkout -B main
    ok "Switched to main"
  fi
fi

# ── Step 2: Ensure .gitignore is current ─────────────────────────────────────
hdr "2. .gitignore"
cat > .gitignore << 'IGNORE'
# ── Credentials & secrets ──────────────────────────────────────────────────────
ffpc-config.json
dynasty-cert.pem
dynasty-key.pem
dynasty-cert.mobileconfig
*.pem
*.mobileconfig
*.bak
*.bakLATEST

# ── Large / regenerated data ───────────────────────────────────────────────────
ktc-cache.json
ktc-redraft-cache.json
ktc-history.json
ktc-redraft-history.json
ktc-post-filtered.txt
ffpc-cache.json
ffpc-player-map.json
ffpc-league-index.json
ffpc-league-owners.json
ffpc-owners-debug.js
ffpc-seed-owners.js
ffpc-build-index.js
team-history.json
player-stats.json
leaguemates.json

# ── Game log CSVs (large raw data) ────────────────────────────────────────────
*-Advanced-Gamelog.csv
Game-Logs/

# ── Debug / probe / utility scripts ───────────────────────────────────────────
ktc-debug.js
ktc-debug2.js
ktc-proxy-probe.js
ktc-proxy-dnjwt.js
ktc-proxy-hybrid.js
ffpc-debug.html
leagues.html
dn-jwt-from-edge.js

# ── Local-only (app.html is the deployable PWA version) ───────────────────────
index.html

# ── Node / logs ───────────────────────────────────────────────────────────────
node_modules/
*.log
proxy.log
serve.log
startup.log
.env

# ── Windows / macOS ───────────────────────────────────────────────────────────
Thumbs.db
.DS_Store
desktop.ini
*:Zone.Identifier
IGNORE
ok ".gitignore written"

# ── Step 3: Build app.html ────────────────────────────────────────────────────
hdr "3. Build app.html"
if [ ! -f "index.html" ]; then
  warn "index.html not found — skipping build"
elif [ ! -f "build_app.py" ]; then
  warn "build_app.py not found — skipping build"
else
  python3 build_app.py
  ok "app.html built"
fi

# ── Step 4: Git add, commit, push ─────────────────────────────────────────────
hdr "4. Git commit & push"

# Files we want tracked (add only if they exist)
TRACK=(
  ".gitignore"
  "app.html"
  "sw-app.js"
  "sw.js"
  "build_app.py"
  "manifest.json"
  "icon-192.png"
  "icon-512.png"
  "package.json"
  "package-lock.json"
  "start-services.sh"
  "dynasty-startup.ps1"
  "dynasty-sync.sh"
  "ktc-proxy.js"
  "build-player-stats.js"
  "ktc-history-post.js"
  "ktc-find-player-url.js"
  "PROJECT_CONTEXT.md"
)

ADDED=0
for f in "${TRACK[@]}"; do
  if [ -f "$f" ]; then
    git add "$f"
    ADDED=$((ADDED + 1))
  fi
done
ok "Staged $ADDED files"

# Check if there's anything to commit
if git diff --cached --quiet; then
  ok "Nothing changed — no commit needed"
else
  STAMP=$(date '+%Y-%m-%d %H:%M')
  # Build a smart commit message listing changed files
  CHANGED=$(git diff --cached --name-only | tr '\n' ' ')
  git commit -m "sync $STAMP | $CHANGED"
  ok "Committed: $CHANGED"

  if $DO_PUSH; then
    # Use token from ~/.git-credentials if available, otherwise fall back to remote as-is
    CREDS_FILE="$HOME/.git-credentials"
    if [ -f "$CREDS_FILE" ]; then
      TOKEN=$(grep 'github.com' "$CREDS_FILE" | head -1 | sed 's|https://[^:]*:||' | sed 's|@.*||' | tr -d '\n\r')
      if [ -n "$TOKEN" ]; then
        PUSH_URL="https://hockeytws:${TOKEN}@github.com/hockeytws/dynasty-tools.git"
      else
        PUSH_URL=$(git remote get-url origin)
      fi
    else
      PUSH_URL=$(git remote get-url origin)
    fi
    git push "$PUSH_URL" main --force-with-lease 2>/dev/null || \
    git push "$PUSH_URL" main --force
    ok "Pushed to GitHub"
  else
    warn "Skipped push (--no-push)"
  fi
fi

# ── Step 5: Full backup ───────────────────────────────────────────────────────
hdr "5. Backup"

if ! $DO_BACKUP; then
  warn "Skipped backup (--no-backup)"
else
  mkdir -p "$BACKUP_ACTIVE" "$BACKUP_BUFFER"
  STAMP=$(date '+%Y-%m-%d_%H%M')
  ARCHIVE="$BACKUP_ACTIVE/dynasty-calc-$STAMP.tar.gz"

  tar -czf "$ARCHIVE" \
    --exclude='node_modules' \
    --exclude='*.Zone.Identifier' \
    --exclude='*.bak' \
    --exclude='*.bakLATEST' \
    --exclude='proxy.log' \
    --exclude='serve.log' \
    --exclude='startup.log' \
    --exclude='.git' \
    -C "$HOME" dynasty-calc/

  SIZE=$(du -sh "$ARCHIVE" | cut -f1)
  ok "Backup created: dynasty-calc-$STAMP.tar.gz ($SIZE)"

  # Move active backups older than KEEP_ACTIVE_DAYS to buffer
  MOVED=0
  while IFS= read -r -d '' f; do
    mv "$f" "$BACKUP_BUFFER/"
    MOVED=$((MOVED + 1))
  done < <(find "$BACKUP_ACTIVE" -name "dynasty-calc-*.tar.gz" \
             -mtime +$KEEP_ACTIVE_DAYS -print0 2>/dev/null)
  [ $MOVED -gt 0 ] && info "Moved $MOVED old backup(s) to buffer"

  # Delete buffer backups older than KEEP_BUFFER_DAYS
  DELETED=0
  while IFS= read -r -d '' f; do
    rm "$f"
    DELETED=$((DELETED + 1))
  done < <(find "$BACKUP_BUFFER" -name "dynasty-calc-*.tar.gz" \
             -mtime +$KEEP_BUFFER_DAYS -print0 2>/dev/null)
  [ $DELETED -gt 0 ] && info "Purged $DELETED expired buffer backup(s)"

  # Summary
  ACTIVE_COUNT=$(find "$BACKUP_ACTIVE" -name "*.tar.gz" 2>/dev/null | wc -l)
  BUFFER_COUNT=$(find "$BACKUP_BUFFER" -name "*.tar.gz" 2>/dev/null | wc -l)
  ok "Backup store: $ACTIVE_COUNT active, $BUFFER_COUNT in buffer"
  info "Active: $BACKUP_ACTIVE"
  info "Buffer: $BACKUP_BUFFER"
fi

# ── Step 6: Claude project file reminder ──────────────────────────────────────
hdr "6. Claude project files to update"
echo -e "${YLW}"
echo "  Upload these to the Claude project if changed this session:"
echo "  (Delete the old version first, then drag in the new one)"
echo ""
for f in "index.html" "ktc-proxy.js" "PROJECT_CONTEXT.md"; do
  if [ -f "$f" ]; then
    MTIME=$(stat -c '%y' "$f" 2>/dev/null | cut -d' ' -f1)
    echo "  • $f  (modified: $MTIME)"
  fi
done
echo -e "${RST}"

hdr "DONE ✓"
