#!/usr/bin/env python3
"""
build_app.py — Generates app.html from index.html for the Dynasty Tools iOS PWA.

Usage:
  python3 build_app.py

Input:  index.html (must be in the same directory)
Output: app.html   (ready to upload to GitHub Pages)

The script:
  - Extracts CSS, HTML views, and JS verbatim from index.html
  - Stubs out proxy-dependent functions (sync, scrape, scout)
  - Redirects loadPlayers/loadRedraftPlayers to localStorage
  - Adds doSync(), offline detection, and switchPageTab override
  - Hardcodes the Tailscale proxy URL (update PROXY_URL below if your IP changes)
"""

import re
import os
import sys

# ── Config ────────────────────────────────────────────────────────────────────
PROXY_URL    = 'https://100.85.44.43:3001'   # Update if your Tailscale IP changes
INPUT_FILE   = 'index.html'
OUTPUT_FILE  = 'app.html'
SW_FILE      = 'sw-app.js'                   # Bumps cache version on each build
# ─────────────────────────────────────────────────────────────────────────────

script_dir = os.path.dirname(os.path.abspath(__file__))
input_path  = os.path.join(script_dir, INPUT_FILE)
output_path = os.path.join(script_dir, OUTPUT_FILE)
sw_path     = os.path.join(script_dir, SW_FILE)

if not os.path.exists(input_path):
    print(f"ERROR: {INPUT_FILE} not found in {script_dir}")
    sys.exit(1)

with open(input_path, 'r', encoding='utf-8') as f:
    src = f.read()

print(f"Read {INPUT_FILE} ({len(src.splitlines())} lines)")

# ── Extract CSS ───────────────────────────────────────────────────────────────
css = re.search(r'<style>(.*?)</style>', src, re.DOTALL).group(1)

# ── Extract HTML views verbatim ───────────────────────────────────────────────
config_html  = re.search(r'<!-- CONFIG VIEW -->(.*?)<!-- TRADE CALC VIEW -->', src, re.DOTALL).group(1).strip()
# config is the default active view in app.html — keep its active class
# Rename to DYNASTY TOOLS OFFLINE
config_html  = config_html.replace('DYNASTY TOOLS', 'DYNASTY TOOLS OFFLINE', 1)
# Remove Scout section (not applicable in app.html)
config_html  = re.sub(r'<!-- ── SCOUT ── -->.*?</div>\s*</div>\s*</div>', '</div>\n</div>', config_html, flags=re.DOTALL)
# Hide player map card
config_html  = config_html.replace('<div class="config-card" id="cfg-playermap-card">',
    '<div class="config-card" id="cfg-playermap-card" style="display:none">')
# Add SW update section at the bottom of config page (before closing divs)
sw_update_section = '''
    <!-- ── APP UPDATE ── -->
    <div class="config-section">
      <div class="config-section-title">APP UPDATE</div>
      <div class="config-card wide">
        <div class="config-label">Check for New Version</div>
        <div class="config-hint">Forces the service worker to check GitHub for an updated version of the app. If a new version is found it will install and reload automatically. Requires an internet connection.</div>
        <div class="sync-league-row" style="margin-top:10px;">
          <button class="btn-ghost" id="sw-update-btn" onclick="swCheckUpdate()">
            <span id="sw-update-icon">\\u2191</span> CHECK FOR UPDATE
          </button>
          <span class="sync-status-txt" id="sw-update-status">\\u2014</span>
        </div>
        <div style="font-family:\\'DM Mono\\',monospace;font-size:9px;color:var(--muted);margin-top:8px;" id="sw-version-lbl"></div>
      </div>
    </div>
'''
# Inject the APP UPDATE section before the end of .config-page
# The closing sequence after LEAGUE SETTINGS is: \n    </div>\n</div>\n  </div>
config_html = config_html.replace(
    '\n    </div>\n</div>\n  </div>\n</div>\n</div>',
    '\n' + sw_update_section + '  </div>\n</div>\n  </div>\n</div>\n</div>',
    1
)
calc_html    = re.search(r'<!-- TRADE CALC VIEW -->(.*?)<!-- MY LEAGUES VIEW -->', src, re.DOTALL).group(1).strip()
# In app.html Trade Calc is NOT the default — remove active if present
calc_html    = calc_html.replace('<div class="page-view active" id="view-calc">', '<div class="page-view" id="view-calc">', 1)
calc_html    = calc_html.replace('<div class="page-view" id="view-calc">', '<div class="page-view" id="view-calc">', 1)
leagues_html  = re.search(r'<!-- MY LEAGUES VIEW -->(.*?)<!-- PROFILES VIEW -->', src, re.DOTALL).group(1).strip()
profiles_raw  = re.search(r'<!-- PROFILES VIEW -->(.*?)<!-- SCOUT VIEW -->', src, re.DOTALL).group(1).strip()
rankings_raw  = re.search(r'<!-- RANKINGS VIEW -->(.*?)\n<script>', src, re.DOTALL).group(1).strip()

# ── Extract JS ────────────────────────────────────────────────────────────────
js = re.search(r'<script>(.*?)</script>\s*</body>', src, re.DOTALL).group(1).strip()

# ── Helper: replace entire function body ─────────────────────────────────────
def replace_fn_body(js, fn_decl, stub_body):
    idx = js.find(fn_decl)
    if idx < 0:
        print(f"  WARNING: function not found: {fn_decl}")
        return js
    brace_start = js.index('{', idx)
    depth, i = 0, brace_start
    while i < len(js):
        if js[i] == '{': depth += 1
        elif js[i] == '}':
            depth -= 1
            if depth == 0: break
        i += 1
    return js[:idx] + fn_decl + ' {\n' + stub_body + '\n}' + js[i+1:]

# ── Patches ───────────────────────────────────────────────────────────────────

# 1. PROXY constant — source uses https
js = js.replace(
    "const PROXY = `https://${window.location.hostname}:3001`;",
    f"const PROXY = '{PROXY_URL}';"
)

# 2. Stub proxy-only functions
js = replace_fn_body(js, 'async function triggerScrape()',
    '  alert("Use SYNC button to refresh KTC."); return;')
js = replace_fn_body(js, 'async function triggerRedraftScrape()',
    '  alert("Use SYNC button to refresh data."); return;')
js = replace_fn_body(js, 'async function lSyncLeagues()',
    '  alert("Use SYNC button to refresh leagues."); return;')
js = replace_fn_body(js, 'async function scoutLookup()',
    '  alert("Scouting not available in offline app."); return;')

js = replace_fn_body(js, 'async function triggerBackfill()',
    '  alert("Backfill requires proxy connection. Connect Tailscale and use the local app."); return;')

js = replace_fn_body(js, 'async function updateBackfillBanner()',
    '''  const banner = document.getElementById('prof-backfill-banner');
  if (banner) {
    const days = Object.keys(ktcHistory).length;
    banner.style.display = days < 3 ? 'flex' : 'none';
    const txt = document.getElementById('prof-backfill-txt');
    if (txt) txt.textContent = days + ' day(s) of history (sync via Tailscale to update)';
  }''')

# loadTeamHistory — read from localStorage only in app.html
js = replace_fn_body(js, 'async function loadTeamHistory()',
    '''  try {
    const raw = localStorage.getItem('dynastyCalc_teamHistory_v1');
    if (raw) { teamHistory = JSON.parse(raw); teamHistoryLoaded = true; }
  } catch(e) {}''')

# 3. Redirect loadPlayers to localStorage
js = replace_fn_body(js, 'async function loadPlayers()',
    '''  const raw = localStorage.getItem('dynastyCalc_ktcData_v1');
  if (!raw) { setKtcStatus('No cache — tap SYNC'); return; }
  try {
    const cached = JSON.parse(raw);
    if (!cached.data || !cached.data.length) { setKtcStatus('No cache — tap SYNC'); return; }
    allPlayers = cached.data.filter(p => p.value > 0).sort((a,b) => b.value - a.value);
    ktcPlayers = allPlayers; ktcMap = {};
    allPlayers.forEach(p => { if (p.name) ktcMap[p.name.toLowerCase()] = p; });
    invalidateKTCNormMap();
    const saved = cached.savedAt ? new Date(cached.savedAt) : null;
    const ageStr = saved ? 'cached ' + saved.toLocaleDateString() : 'cached';
    setKtcStatus(allPlayers.length + ' players · ' + ageStr);
  } catch(e) { setKtcStatus('Cache error'); }''')

# 4. Redirect loadRedraftPlayers to localStorage
js = replace_fn_body(js, 'async function loadRedraftPlayers()',
    '''  const raw = localStorage.getItem('dynastyCalc_ktcRedraftData_v1');
  if (!raw) { setRedraftStatus('No cache — tap SYNC'); return; }
  try {
    const cached = JSON.parse(raw);
    if (!cached.data || !cached.data.length) { setRedraftStatus('No cache'); return; }
    redraftPlayers = cached.data.filter(p => (p.sf||0) > 0 || (p.oneqb||0) > 0);
    redraftMap = {};
    redraftPlayers.forEach(p => { if (p.name) redraftMap[p.name.toLowerCase()] = p; });
    setRedraftStatus(redraftPlayers.length + ' players (cached)');
  } catch(e) {}''')

# 5. lFetchAllLeagues — no proxy, cache only
js = replace_fn_body(js, 'async function lFetchAllLeagues()',
    '  return false;')

# 5b. loadKtcHistory — read from localStorage only in app.html
js = replace_fn_body(js, 'async function loadKtcHistory()',
    '''  try {
    const raw = localStorage.getItem('dynastyCalc_ktcHistory_v1');
    if (raw) { ktcHistory = JSON.parse(raw); historyLoaded = true; }
  } catch(e) {}''')

# 5b2. loadKtcRedraftHistory — read from localStorage only in app.html
js = replace_fn_body(js, 'async function loadKtcRedraftHistory()',
    '''  try {
    const raw = localStorage.getItem('dynastyCalc_ktcRedraftHistory_v1');
    if (raw) { ktcRedraftHistory = JSON.parse(raw); redraftHistoryLoaded = true; }
  } catch(e) {}''')

# 5c. loadPlayerStats — read from localStorage only in app.html
js = replace_fn_body(js, 'async function loadPlayerStats()',
    '''  try {
    const raw = localStorage.getItem('dynastyCalc_playerStats_v1');
    if (raw) { playerStats = JSON.parse(raw); statsLoaded = true; }
  } catch(e) {}''')

# 6. buildCalcUI — always render immediately; no spinner loop (empty allPlayers = search just returns nothing)
# No patch needed — use the native function as-is

# 7. Replace init()
js = replace_fn_body(js, 'async function init()',
    '''  loadLeagueOverrides();
  try { await loadPlayers(); } catch(e) {}
  try { await loadRedraftPlayers(); } catch(e) {}
  await lLoadAllLeagues();
  renderConfigOverrides();
  renderValueSourceSelector();
  lUpdateCfgSyncStatus();
  syncConfigInputs();
  const hasKTC = allPlayers.length > 0;
  const hasLeagues = L_LEAGUES.some(l => leagueData[l.id]);
  if (hasKTC || hasLeagues) {
    const parts = [];
    if (hasKTC) parts.push(allPlayers.length + ' players');
    if (hasLeagues) parts.push(L_LEAGUES.filter(l => leagueData[l.id]).length + '/' + L_LEAGUES.length + ' leagues');
    setSyncBannerStatus(parts.join(' \u00b7 '), 'ok');
  } else {
    setSyncBannerStatus('No data \u2014 tap SYNC ALL to fetch', '');
  }
  setSyncBannerAge();''')

# 9. Append app-specific additions
js = js.rstrip()
if js.endswith('init();'):
    js = js[:-7].rstrip()

js += '''

// ── App-specific additions ────────────────────────────────────────────────────

// setSyncBannerStatus / setSyncBannerAge are no-ops in app.html (no sync bar)
function setSyncBannerStatus(msg, cls) {}
function setSyncBannerAge() {}

async function swCheckUpdate() {
  const btn    = document.getElementById('sw-update-btn');
  const icon   = document.getElementById('sw-update-icon');
  const status = document.getElementById('sw-update-status');
  const verLbl = document.getElementById('sw-version-lbl');
  if (btn) btn.disabled = true;
  if (icon) { icon.className = 'spin-anim'; icon.textContent = '\u21bb'; }
  if (status) status.textContent = 'Checking\u2026';

  if (!('serviceWorker' in navigator)) {
    if (status) { status.textContent = 'Service worker not supported'; status.className = 'sync-status-txt err'; }
    if (btn) btn.disabled = false;
    if (icon) { icon.className = ''; icon.textContent = '\u2191'; }
    return;
  }

  try {
    const reg = await navigator.serviceWorker.getRegistration('./sw-app.js');
    if (!reg) {
      if (status) { status.textContent = 'No SW registered — open in Safari first'; status.className = 'sync-status-txt err'; }
      if (btn) btn.disabled = false;
      if (icon) { icon.className = ''; icon.textContent = '\u2191'; }
      return;
    }

    // Show current cache version from the active SW script URL or just the known constant
    if (verLbl) verLbl.textContent = 'Current SW scope: ' + reg.scope;

    // Listen for a new SW installing
    let updateFound = false;
    reg.addEventListener('updatefound', () => {
      updateFound = true;
      const newWorker = reg.installing;
      if (status) { status.textContent = 'New version found \u2014 installing\u2026'; status.className = 'sync-status-txt'; }
      newWorker.addEventListener('statechange', () => {
        if (newWorker.state === 'installed') {
          if (status) { status.textContent = 'New version ready \u2014 reloading\u2026'; status.className = 'sync-status-txt ok'; }
          // skipWaiting is already called in SW install handler — just reload
          setTimeout(() => window.location.reload(), 800);
        }
      });
    });

    // Trigger the update check (network request to compare SW byte-for-byte)
    await reg.update();

    // If no update event fired within 3s, we're already on latest
    await new Promise(r => setTimeout(r, 3000));
    if (!updateFound) {
      if (status) { status.textContent = 'Already up to date'; status.className = 'sync-status-txt ok'; }
      if (btn) btn.disabled = false;
      if (icon) { icon.className = ''; icon.textContent = '\u2713'; }
    }
  } catch(e) {
    if (status) { status.textContent = 'Error: ' + e.message; status.className = 'sync-status-txt err'; }
    if (btn) btn.disabled = false;
    if (icon) { icon.className = ''; icon.textContent = '\u2191'; }
  }
}

function switchPageTab(tab) {
  document.querySelectorAll('.page-tab').forEach(el =>
    el.classList.toggle('active', el.id === 'ptab-' + tab));
  document.querySelectorAll('.page-view').forEach(el =>
    el.classList.toggle('active', el.id === 'view-' + tab));
  if (tab === 'calc') {
    buildCalcUI();
    updateSubtitle();
  } else if (tab === 'leagues') {
    if (!leaguesReady) { leaguesReady = true; leaguesInit(); }
    else { lRenderLeagueTabs(); lUpdateSyncStatus(); renderLeagues(); }
  } else if (tab === 'rankings') {
    renderRankingsTab();
  } else if (tab === 'profiles') {
    initProfilesTab();
  } else if (tab === 'config') {
    renderConfigOverrides();
    renderValueSourceSelector();
    lUpdateCfgSyncStatus();
  }
}

// syncAll for app.html — same as doSync but also updates the cfg-sync-all-status element
async function syncAll() {
  const btn    = document.getElementById('cfg-sync-all-btn');
  const icon   = document.getElementById('cfg-sync-all-icon');
  const status = document.getElementById('cfg-sync-all-status');
  if (btn) btn.disabled = true;
  if (icon) { icon.className = 'spin-anim'; icon.textContent = '\u21bb'; }
  const setS = msg => { if (status) status.textContent = msg; };
  setS('Connecting\u2026');

  // Reachability check
  try {
    await fetch(PROXY + '/ktc', { method: 'HEAD', signal: AbortSignal.timeout(5000) });
  } catch(e) {
    if (btn) btn.disabled = false;
    if (icon) { icon.className = ''; icon.textContent = '\u21c5'; }
    setS('Cannot reach proxy \u2014 connect Tailscale first');
    return;
  }

  const steps = [];
  setS('Syncing KTC\u2026');

  try {
    const r = await fetch(PROXY + '/ktc', { signal: AbortSignal.timeout(30000) });
    if (r.ok) {
      const json = await r.json();
      if (json.data && json.data.length) {
        localStorage.setItem('dynastyCalc_ktcData_v1', JSON.stringify({ data: json.data, savedAt: Date.now() }));
        await loadPlayers();
        steps.push('KTC \u2713');
      }
    } else { steps.push('KTC \u2717'); }
  } catch(e) { steps.push('KTC \u2717'); }

  setS('Syncing redraft\u2026');
  try {
    const r = await fetch(PROXY + '/ktc-redraft', { signal: AbortSignal.timeout(30000) });
    if (r.ok) {
      const json = await r.json();
      if (json.data && json.data.length) {
        localStorage.setItem('dynastyCalc_ktcRedraftData_v1', JSON.stringify({ data: json.data, savedAt: Date.now() }));
        await loadRedraftPlayers();
        steps.push('Redraft \u2713');
      }
    } else { steps.push('Redraft \u2717'); }
  } catch(e) { steps.push('Redraft \u2717'); }

  setS('Syncing leagues\u2026');
  let leaguesOk = 0;
  for (const league of L_LEAGUES) {
    try {
      const r = await fetch(PROXY + '/ffpc/' + league.id, { signal: AbortSignal.timeout(15000) });
      if (r.ok) {
        const d = await r.json();
        if (d.teams && d.teams.length) {
          const stored = JSON.parse(localStorage.getItem(FFPC_LS_KEY) || '{}');
          stored[league.id] = d;
          if (d.leagueName && d.leagueName !== 'League Rosters') league.name = d.leagueName;
          localStorage.setItem(FFPC_LS_KEY, JSON.stringify(stored));
          leagueData[league.id] = d;
          leaguesOk++;
        }
      }
    } catch(e) {}
  }
  if (leaguesOk) steps.push(leaguesOk + '/' + L_LEAGUES.length + ' leagues \u2713');
  else steps.push('Leagues \u2717');

  setS('Syncing history\u2026');
  try {
    const rh = await fetch(PROXY + '/ktc-history', { signal: AbortSignal.timeout(60000) });
    if (rh.ok) {
      const hist = await rh.json();
      ktcHistory = hist; historyLoaded = true;
      try { localStorage.setItem('dynastyCalc_ktcHistory_v1', JSON.stringify(hist)); }
      catch(lse) { console.warn('History too large for localStorage:', lse.message); }
      steps.push('History \u2713');
    } else { steps.push('History \u2717'); }
  } catch(e) { steps.push('History \u2717 ' + e.message); }

  try {
    const rrh = await fetch(PROXY + '/ktc-redraft-history', { signal: AbortSignal.timeout(60000) });
    if (rrh.ok) {
      const rdHist = await rrh.json();
      ktcRedraftHistory = rdHist; redraftHistoryLoaded = true;
      try { localStorage.setItem('dynastyCalc_ktcRedraftHistory_v1', JSON.stringify(rdHist)); }
      catch(lse) { console.warn('Redraft history too large for localStorage:', lse.message); }
      steps.push('RD Hist \u2713');
    } else { steps.push('RD Hist \u2717'); }
  } catch(e) { steps.push('RD Hist \u2717 ' + e.message); }

  try {
    const rp = await fetch(PROXY + '/player-stats', { signal: AbortSignal.timeout(30000) });
    if (rp.ok) {
      const stats = await rp.json();
      localStorage.setItem('dynastyCalc_playerStats_v1', JSON.stringify(stats));
      playerStats = stats; statsLoaded = true;
      steps.push('Stats \u2713');
    } else { steps.push('Stats \u2717'); }
  } catch(e) { steps.push('Stats \u2717'); }

  try {
    const rt = await fetch(PROXY + '/team-history', { signal: AbortSignal.timeout(15000) });
    if (rt.ok) {
      const th = await rt.json();
      localStorage.setItem('dynastyCalc_teamHistory_v1', JSON.stringify(th));
      teamHistory = th; teamHistoryLoaded = true;
      steps.push('Teams \u2713');
    } else { steps.push('Teams \u2717'); }
  } catch(e) { steps.push('Teams \u2717'); }

  if (btn) btn.disabled = false;
  if (icon) { icon.className = ''; icon.textContent = '\u21c5'; }
  setS(steps.join(' \u00b7 '));
  setSyncBannerStatus(steps.join(' \u00b7 '), steps.some(s => s.includes('\u2713')) ? 'ok' : 'err');
  setSyncBannerAge();
  renderConfigOverrides();
  lUpdateCfgSyncStatus();
}
'''

# ── Verify brace balance ──────────────────────────────────────────────────────
delta = js.count('{') - js.count('}')
if delta != 0:
    print(f"  WARNING: brace imbalance: {delta}")
else:
    print("  Brace balance: OK")

# ── Bump SW cache version ─────────────────────────────────────────────────────
sw_bumped = False
if os.path.exists(sw_path):
    with open(sw_path, 'r') as f:
        sw = f.read()
    m = re.search(r"dynasty-app-v(\d+)", sw)
    if m:
        old_v = int(m.group(1))
        new_v = old_v + 1
        sw = sw.replace(f'dynasty-app-v{old_v}', f'dynasty-app-v{new_v}')
        with open(sw_path, 'w') as f:
            f.write(sw)
        print(f"  SW cache: v{old_v} → v{new_v}")
        sw_bumped = True
if not sw_bumped:
    print("  SW file not found — skipping version bump")

# ── Build final HTML ──────────────────────────────────────────────────────────
html = f'''<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
<title>Dynasty Tools</title>
<link rel="manifest" href="./manifest.json">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Dynasty Tools">
<link rel="apple-touch-icon" href="./icon-192.png">
<style>
{css}
/* ── iOS PWA safe-area fix (viewport-fit=cover means viewport starts behind notch).
   Make .page-tabs fixed and push it down by the safe area inset so it clears the
   status bar. The sync bar sticks below it. Body gets matching top padding so
   content never hides under the fixed headers. ── */
.page-tabs{{
  position: fixed;
  top: 0; left: 0; right: 0;
  padding-top: env(safe-area-inset-top, 0px);
  z-index: 200;
}}
.sync-bar{{
  position: sticky;
  top: calc(env(safe-area-inset-top, 0px) + 46px);
  z-index: 100;
}}
body{{
  /* safe area + tab bar (46px) only — sync bar removed */
  padding-top: calc(env(safe-area-inset-top, 0px) + 46px) !important;
}}
</style>
</head>
<body>

<div class="page-tabs">
  <button class="page-tab active" id="ptab-config" onclick="switchPageTab('config')">⚙ CONFIG</button>
  <button class="page-tab" id="ptab-calc" onclick="switchPageTab('calc')">TRADE CALC</button>
  <button class="page-tab" id="ptab-leagues" onclick="switchPageTab('leagues')">MY LEAGUES</button>
  <button class="page-tab" id="ptab-rankings" onclick="switchPageTab('rankings')">RANKINGS</button>
  <button class="page-tab" id="ptab-profiles" onclick="switchPageTab('profiles')">PROFILES</button>
</div>

{config_html}

{calc_html}

{leagues_html}

{profiles_raw}

{rankings_raw}

<script>
{js}

if ('serviceWorker' in navigator) {{
  navigator.serviceWorker.register('./sw-app.js').catch(() => {{}});
}}

init();
</script>
</body>
</html>'''

with open(output_path, 'w', encoding='utf-8') as f:
    f.write(html)

print(f"\nDone! {OUTPUT_FILE} written ({len(html.splitlines())} lines)")
print(f"Upload {OUTPUT_FILE} and {SW_FILE} to GitHub Pages.")
