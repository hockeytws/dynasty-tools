// ktc-proxy.js — serves KTC + FFPC data (HTTPS for iOS PWA compatibility)
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// ── TLS cert ──────────────────────────────────────────────────────────────────
let tlsOptions = null;
try {
  tlsOptions = {
    key:  fs.readFileSync(path.join(__dirname, 'dynasty-key.pem')),
    cert: fs.readFileSync(path.join(__dirname, 'dynasty-cert.pem')),
  };
  console.log('TLS cert loaded — serving HTTPS on port 3001');
} catch(e) {
  console.warn('No TLS cert found — serving HTTP (iOS sync from GitHub Pages will not work).');
}

let puppeteer;
try { puppeteer = require('puppeteer'); } catch(e) {
  console.warn('Puppeteer not found. Run: npm install puppeteer');
  puppeteer = null;
}

const PORT = 3001;
const CACHE_FILE          = path.join(__dirname, 'ktc-cache.json');
const REDRAFT_CACHE_FILE  = path.join(__dirname, 'ktc-redraft-cache.json');
const FFPC_CACHE_FILE     = path.join(__dirname, 'ffpc-cache.json');
const LEAGUEMATES_FILE    = path.join(__dirname, 'leaguemates.json');
const HISTORY_FILE        = path.join(__dirname, 'ktc-history.json');
const PLAYER_STATS_FILE   = path.join(__dirname, 'player-stats.json');
const TEAM_HISTORY_FILE   = path.join(__dirname, 'team-history.json');

// ── KTC value history ─────────────────────────────────────────────────────────
// Structure: { "2025-04-01": { "Player Name": { value, oneqb, pos, team }, ... }, ... }
let ktcHistory = {};
let backfillInProgress = false;
let backfillProgress = { done: 0, total: 0, status: 'idle' };

if (fs.existsSync(HISTORY_FILE)) {
  try {
    ktcHistory = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    console.log(`KTC history: ${Object.keys(ktcHistory).length} days`);
  } catch(e) { console.log('KTC history load failed:', e.message); }
}

// ── Player stats (from Player Profiler game logs) ────────────────────────────
let playerStats = {};
if (fs.existsSync(PLAYER_STATS_FILE)) {
  try {
    playerStats = JSON.parse(fs.readFileSync(PLAYER_STATS_FILE, 'utf8'));
    console.log(`Player stats: ${Object.keys(playerStats).length} players`);
  } catch(e) { console.log('Player stats load failed:', e.message); }
}

// ── Team history ─────────────────────────────────────────────────────────────
let teamHistory = {};
if (fs.existsSync(TEAM_HISTORY_FILE)) {
  try {
    teamHistory = JSON.parse(fs.readFileSync(TEAM_HISTORY_FILE, 'utf8'));
    console.log(`Team history: ${Object.keys(teamHistory).length} leagues`);
  } catch(e) { console.log('Team history load failed:', e.message); }
}
function saveTeamHistory() {
  try { fs.writeFileSync(TEAM_HISTORY_FILE, JSON.stringify(teamHistory)); }
  catch(e) { console.error('saveTeamHistory failed:', e.message); }
}

// ── Automated team value snapshot with transaction tracking ────────────────────
// Computes dynasty + redraft values per team per league and saves to team-history.json.
// Also detects roster changes (adds/drops) by comparing to the previous snapshot.
function snapshotTeamValues(dateStr) {
  if (!cachedData || !cachedData.length) { console.log('snapshotTeamValues: no KTC data'); return; }
  if (!Object.keys(ffpcCache).length) { console.log('snapshotTeamValues: no FFPC data'); return; }

  const DEDUCTION = 2500, PICK_DEDUCTION = 2400, SCALE = 10000, EXP = 1.25, MAX = 10000;
  const RD_FLOOR = 4000, RD_EXP = 1.25;

  // Build KTC lookup
  const ktcLookup = {};
  cachedData.forEach(p => { if (p.name) ktcLookup[p.name.toLowerCase()] = p; });

  // Build redraft lookup
  const rdLookup = {};
  if (redraftData) redraftData.forEach(p => { if (p.name) rdLookup[p.name.toLowerCase()] = p; });

  function dynVal(name) {
    const p = ktcLookup[name.toLowerCase()];
    if (!p) return 0;
    let base = p.value || 0;
    if (p.position === 'TE' && p.tep) base = p.tep;
    const above = base - DEDUCTION;
    if (above <= 0) return 0;
    return SCALE * Math.pow(above, EXP) / Math.pow(MAX - DEDUCTION, EXP);
  }

  function rdVal(name) {
    const p = rdLookup[name.toLowerCase()];
    if (!p) return 0;
    let base = p.sf || p.value || 0;
    if (p.position === 'TE' && p.tep) base = p.tep;
    const above = base - RD_FLOOR;
    if (above <= 0) return 0;
    return SCALE * Math.pow(above, RD_EXP) / Math.pow(MAX - RD_FLOOR, RD_EXP);
  }

  function slugify(name) {
    return name.toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-');
  }

  let totalSnapshots = 0;
  for (const [leagueId, leagueCache] of Object.entries(ffpcCache)) {
    if (!leagueCache.teams || !leagueCache.teams.length) continue;
    if (!teamHistory[leagueId]) teamHistory[leagueId] = { teams: {} };

    for (const team of leagueCache.teams) {
      const slug = slugify(team.name);
      if (!teamHistory[leagueId].teams[slug]) {
        teamHistory[leagueId].teams[slug] = { names: [], dates: {}, transactions: [] };
      }
      const dest = teamHistory[leagueId].teams[slug];

      // Track team name changes
      if (!dest.names.includes(team.name)) dest.names.push(team.name);

      // Collect all player names
      const playerNames = [];
      ['QB','RB','WR','TE'].forEach(pos => {
        (team.players[pos] || []).forEach(p => { if (p.name) playerNames.push(p.name); });
      });

      // Compute values
      let dTotal = 0, rTotal = 0;
      playerNames.forEach(n => { dTotal += dynVal(n); rTotal += rdVal(n); });

      // Detect transactions by comparing to previous snapshot
      const prevDates = Object.keys(dest.dates).sort();
      if (prevDates.length > 0) {
        const prevDate = prevDates[prevDates.length - 1];
        const prevPlayers = dest.dates[prevDate].players || [];
        const prevSet = new Set(prevPlayers.map(n => n.toLowerCase()));
        const currSet = new Set(playerNames.map(n => n.toLowerCase()));

        // Find adds (on current roster but not previous)
        playerNames.forEach(n => {
          if (!prevSet.has(n.toLowerCase())) {
            dest.transactions.push({ type: 'add', player: n, date: dateStr });
          }
        });
        // Find drops (on previous roster but not current)
        prevPlayers.forEach(n => {
          if (!currSet.has(n.toLowerCase())) {
            dest.transactions.push({ type: 'drop', player: n, date: dateStr });
          }
        });
      }

      // Save snapshot (skip if same date already exists)
      if (!dest.dates[dateStr]) {
        dest.dates[dateStr] = {
          dynVal: Math.round(dTotal),
          rdVal: Math.round(rTotal),
          playerCount: playerNames.length,
          players: playerNames,
        };
        totalSnapshots++;
      }
    }
  }

  if (totalSnapshots > 0) {
    saveTeamHistory();
    console.log(`Team snapshot saved: ${dateStr} (${totalSnapshots} teams across ${Object.keys(ffpcCache).length} leagues)`);
  } else {
    console.log(`Team snapshot: ${dateStr} already exists for all teams`);
  }
}

function saveHistory() {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(ktcHistory));
}

// Return today's date string in local time: "2025-04-01"
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// Snapshot the current cachedData into history for a given dateStr.
// Skips if the date already has data (idempotent).
function snapshotDate(dateStr, players) {
  if (!players || !players.length) return false;
  if (ktcHistory[dateStr]) return false; // already have it
  const snap = {};
  players.forEach(p => {
    if (!p.name || p.position === 'RDP') return; // skip picks
    snap[p.name] = {
      value:     p.value     || 0,
      oneqb:     p.oneqb     || 0,
      tep:       p.tep       || p.value  || 0,
      tepp:      p.tepp      || p.value  || 0,
      teppp:     p.teppp     || p.value  || 0,
      tep_1qb:   p.tep_1qb   || p.oneqb || 0,
      tepp_1qb:  p.tepp_1qb  || p.oneqb || 0,
      teppp_1qb: p.teppp_1qb || p.oneqb || 0,
      pos:       p.position  || '',
      team:      p.team      || '',
      age:       p.age       || 0,
    };
  });
  ktcHistory[dateStr] = snap;
  saveHistory();
  console.log(`History snapshot saved: ${dateStr} (${Object.keys(snap).length} players)`);
  return true;
}

// Check for any missed days since the last snapshot and fill them using current data.
// Called on startup and after each daily scrape.
function fillMissedSnapshots(players) {
  if (!players || !players.length) return;
  const dates = Object.keys(ktcHistory).sort();
  if (!dates.length) {
    // No history at all — just snapshot today
    snapshotDate(todayStr(), players);
    return;
  }
  const lastDate = dates[dates.length - 1];
  const last = new Date(lastDate + 'T12:00:00Z');
  const today = new Date(todayStr() + 'T12:00:00Z');
  let cursor = new Date(last);
  cursor.setUTCDate(cursor.getUTCDate() + 1);
  let filled = 0;
  while (cursor <= today) {
    const ds = `${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth()+1).padStart(2,'0')}-${String(cursor.getUTCDate()).padStart(2,'0')}`;
    if (!ktcHistory[ds]) {
      snapshotDate(ds, players);
      filled++;
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  if (filled > 0) console.log(`Filled ${filled} missed history snapshot(s)`);
}

// ── Daily scheduler: snapshot at 2am local time ───────────────────────────────
function scheduleDailySnapshot() {
  const now = new Date();
  const next2am = new Date(now);
  next2am.setHours(2, 0, 0, 0);
  if (next2am <= now) next2am.setDate(next2am.getDate() + 1);
  const msUntil = next2am - now;
  console.log(`Daily snapshot scheduled in ${Math.round(msUntil/3600000*10)/10}h`);
  setTimeout(async () => {
    console.log('Daily KTC snapshot starting...');
    try {
      // Scrape fresh data
      const players = await scrapeKTC();
      saveKTCCache(players);
      // Fill any gaps then snapshot today
      fillMissedSnapshots(players);
      // Also scrape redraft and snapshot it
      try {
        const rdPlayers = await scrapeKTCRedraft();
        saveRedraftCache(rdPlayers);
      } catch(e) { console.warn('Daily redraft scrape failed:', e.message); }
      // Snapshot team values with transaction tracking
      try { snapshotTeamValues(todayStr()); } catch(e) { console.warn('Daily team snapshot failed:', e.message); }
    } catch(e) {
      // Scrape failed — still snapshot with cached data if available
      console.warn('Daily snapshot scrape failed:', e.message);
      if (cachedData) fillMissedSnapshots(cachedData);
      // Still try team snapshot with whatever FFPC data we have
      try { snapshotTeamValues(todayStr()); } catch(e2) {}
    }
    // Schedule next day
    scheduleDailySnapshot();
  }, msUntil);
}

// ── Leaguemates helpers ───────────────────────────────────────────────────────
function loadLeaguemates() {
  try {
    if (fs.existsSync(LEAGUEMATES_FILE)) return JSON.parse(fs.readFileSync(LEAGUEMATES_FILE, 'utf8'));
  } catch(e) {}
  return { description: 'Known leaguemate emails', myEmail: 'tylerwsterrett@gmail.com', emails: [] };
}
function addLeaguemateEmail(email) {
  if (!email) return false;
  const lo = email.trim().toLowerCase();
  const data = loadLeaguemates();
  if (lo === (data.myEmail||'').toLowerCase()) return false; // don't add own email
  if (data.emails.includes(lo)) return false; // already present
  data.emails = [...new Set([...data.emails, lo])].sort();
  try { fs.writeFileSync(LEAGUEMATES_FILE, JSON.stringify(data, null, 2)); return true; } catch(e) { return false; }
}

// ── KTC dynasty cache ─────────────────────────────────────────────────────────
let cachedData = null;
let cacheTimestamp = null;
let scrapeInProgress = false;

// ── KTC redraft cache ─────────────────────────────────────────────────────────
let redraftData = null;
let redraftTimestamp = null;
let redraftScrapeInProgress = false;

if (fs.existsSync(REDRAFT_CACHE_FILE)) {
  try {
    const parsed = JSON.parse(fs.readFileSync(REDRAFT_CACHE_FILE, 'utf8'));
    redraftData = parsed.data;
    redraftTimestamp = parsed.timestamp;
    console.log(`KTC redraft cache: ${redraftData.length} players from ${new Date(redraftTimestamp).toLocaleString()}`);
  } catch(e) { console.log('KTC redraft cache load failed:', e.message); }
}

if (fs.existsSync(CACHE_FILE)) {
  try {
    const parsed = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    cachedData = parsed.data;
    cacheTimestamp = parsed.timestamp;
    console.log(`KTC cache: ${cachedData.length} players from ${new Date(cacheTimestamp).toLocaleString()}`);
  } catch(e) { console.log('KTC cache load failed:', e.message); }
}

// ── FFPC cache ────────────────────────────────────────────────────────────────
let ffpcCache = {};  // { leagueId: { teams: [], timestamp } }

if (fs.existsSync(FFPC_CACHE_FILE)) {
  try {
    ffpcCache = JSON.parse(fs.readFileSync(FFPC_CACHE_FILE, 'utf8'));
    console.log(`FFPC cache: ${Object.keys(ffpcCache).length} leagues`);
  } catch(e) { console.log('FFPC cache load failed:', e.message); }
}

function saveFFPCCache() {
  fs.writeFileSync(FFPC_CACHE_FILE, JSON.stringify(ffpcCache));
}

// ── KTC Puppeteer scrape ──────────────────────────────────────────────────────
async function scrapeKTC() {
  if (!puppeteer) throw new Error('Puppeteer not installed.');
  if (scrapeInProgress) throw new Error('Scrape already in progress');

  scrapeInProgress = true;
  console.log('Launching Puppeteer for KTC...');

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36');

    console.log('Navigating to KTC trade calculator...');
    await page.goto('https://keeptradecut.com/trade-calculator?format=2', {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    });

    await page.waitForFunction(
      () => Array.isArray(window.playersArray) && window.playersArray.length > 100,
      { timeout: 20000 }
    );

    const debugInfo = await page.evaluate(() => {
      const first = window.playersArray[0];
      const te = window.playersArray.find(p => p.position === 'TE');
      const rdp = window.playersArray.find(p => p.position === 'RDP');
      const rdpExact = window.playersArray.find(p => p.position === 'RDP' && p.calculated);
      return {
        first: JSON.stringify(first, null, 2),
        te: JSON.stringify(te, null, 2),
        rdpTier: rdp ? JSON.stringify({name:rdp.playerName, calc:rdp.calculated, sf:rdp.superflexValues?.value, qb1:rdp.oneQBValues?.value}, null, 2) : 'none',
        rdpExact: rdpExact ? JSON.stringify({name:rdpExact.playerName, calc:rdpExact.calculated, sf:rdpExact.superflexValues?.value, qb1:rdpExact.oneQBValues?.value}, null, 2) : 'none found — exact picks may not exist yet for this year',
      };
    });
    console.log('First player:\n', debugInfo.first);
    console.log('Sample tier RDP pick:\n', debugInfo.rdpTier);
    console.log('Sample exact slot RDP pick (calculated:true):\n', debugInfo.rdpExact);

    const players = await page.evaluate(() => {
      const VALID_POS = ['QB','RB','WR','TE','RDP'];
      return window.playersArray.map(p => {
        const sf  = p.superflexValues || {};
        const qb1 = p.oneQBValues     || {};
        return {
          id:         String(p.playerID || p.slug || p.playerName),
          name:       p.playerName,
          position:   p.position || '',
          team:       p.team || '',
          age:        p.age || 0,
          calculated: p.calculated || false,
          // Superflex values
          value:    sf.value   || 0,
          tep:      sf.tep   && sf.tep.value   || sf.value || 0,
          tepp:     sf.tepp  && sf.tepp.value  || sf.value || 0,
          teppp:    sf.teppp && sf.teppp.value || sf.value || 0,
          // 1QB values
          oneqb:        qb1.value   || 0,
          tep_1qb:      qb1.tep   && qb1.tep.value   || qb1.value || 0,
          tepp_1qb:     qb1.tepp  && qb1.tepp.value  || qb1.value || 0,
          teppp_1qb:    qb1.teppp && qb1.teppp.value || qb1.value || 0,
        };
      }).filter(p => {
        if ((!p.value && !p.oneqb) || !p.name) return false;
        if (!VALID_POS.includes(p.position)) return false;
        // KTC fake/placeholder players have calculated:true — but exact slot picks (RDP) also
        // have calculated:true and are real values. Only filter calculated for non-RDP positions.
        if (p.calculated && p.position !== 'RDP') return false;
        return true;
      });
    });

    await browser.close();
    scrapeInProgress = false;

    const exactPicks = players.filter(p => p.position === 'RDP' && p.calculated);
    console.log(`KTC scraped ${players.length} players (${exactPicks.length} exact slot picks). Top 3:`);
    players.slice(0, 3).forEach(p => console.log(` ${p.name} (${p.position}) = ${p.value}`));
    if (exactPicks.length > 0) {
      console.log('Exact slot picks sample:', exactPicks.slice(0, 6).map(p => `"${p.name}" sf=${p.value} 1qb=${p.oneqb}`).join(', '));
    } else {
      console.log('WARNING: No exact slot picks found — all RDP entries may be tier-only');
    }

    if (!players || players.length === 0) throw new Error('No players found');
    return players;

  } catch(err) {
    try { await browser.close(); } catch(e) {}
    scrapeInProgress = false;
    throw err;
  }
}


// ── KTC Redraft Puppeteer scrape ──────────────────────────────────────────────
async function scrapeKTCRedraft() {
  if (!puppeteer) throw new Error('Puppeteer not installed.');
  if (redraftScrapeInProgress) throw new Error('Redraft scrape already in progress');

  redraftScrapeInProgress = true;
  console.log('Launching Puppeteer for KTC redraft (fantasy) rankings...');

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36');

    // KTC fantasy rankings — PPR superflex (format=2 is SF, format=1 is 1QB)
    // fantasy-rankings page exposes playersArray with season values
    console.log('Navigating to KTC fantasy rankings...');
    await page.goto('https://keeptradecut.com/fantasy-rankings?format=2', {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    });

    await page.waitForFunction(
      () => Array.isArray(window.playersArray) && window.playersArray.length > 50,
      { timeout: 20000 }
    );

    const debugInfo = await page.evaluate(() => {
      const first = window.playersArray[0];
      return { first: JSON.stringify(first, null, 2), keys: Object.keys(first || {}), count: window.playersArray.length };
    });
    console.log('Redraft first player:\n', debugInfo.first);
    console.log('Redraft player count:', debugInfo.count);

    const players = await page.evaluate(() => {
      return window.playersArray.map(p => {
        const sf  = p.superflexValues || p.values || {};
        const qb1 = p.oneQBValues     || {};
        return {
          id:       String(p.playerID || p.slug || p.playerName),
          name:     p.playerName,
          position: p.position || '',
          team:     p.team || '',
          // Redraft SF values (with TEP variants)
          sf:       sf.value   || p.value || 0,
          tep:      sf.tep   && sf.tep.value   || sf.value || p.value || 0,
          tepp:     sf.tepp  && sf.tepp.value  || sf.value || p.value || 0,
          teppp:    sf.teppp && sf.teppp.value || sf.value || p.value || 0,
          // Redraft 1QB values (with TEP variants)
          oneqb:      qb1.value   || p.oneqbValue || 0,
          tep_1qb:    qb1.tep   && qb1.tep.value   || qb1.value || p.oneqbValue || 0,
          tepp_1qb:   qb1.tepp  && qb1.tepp.value  || qb1.value || p.oneqbValue || 0,
          teppp_1qb:  qb1.teppp && qb1.teppp.value || qb1.value || p.oneqbValue || 0,
        };
      }).filter(p => {
        if (!p.name || (p.sf <= 0 && p.oneqb <= 0)) return false;
        // Only keep skill positions for redraft — filters out K, DEF, and KTC placeholders
        const VALID_REDRAFT = ['QB','RB','WR','TE'];
        if (!VALID_REDRAFT.includes(p.position)) return false;
        return true;
      });
    });

    await browser.close();
    redraftScrapeInProgress = false;

    console.log(`KTC redraft scraped ${players.length} players. Top 3:`);
    players.slice(0, 3).forEach(p => console.log(` ${p.name} (${p.position}) sf=${p.sf} 1qb=${p.oneqb}`));

    if (!players || players.length === 0) throw new Error('No redraft players found');
    return players;

  } catch(err) {
    try { await browser.close(); } catch(e) {}
    redraftScrapeInProgress = false;
    throw err;
  }
}

function saveRedraftCache(players) {
  redraftData = players;
  redraftTimestamp = Date.now();
  fs.writeFileSync(REDRAFT_CACHE_FILE, JSON.stringify({ data: redraftData, timestamp: redraftTimestamp }));
}


const FFPC_CONFIG_FILE = path.join(__dirname, 'ffpc-config.json');
let ffpcScrapeInProgress = false;

function loadFFPCConfig() {
  if (!fs.existsSync(FFPC_CONFIG_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(FFPC_CONFIG_FILE, 'utf8')); } catch(e) { return null; }
}

async function scrapeFFPCLeague(page, ltuid) {
  const url = `https://myffpc.com/Rosters.aspx?ltuid=${ltuid}`;
  console.log(`  Scraping: ${url}`);
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise(r => setTimeout(r, 1000));

  // Save debug HTML
  const html = await page.content();
  require('fs').writeFileSync(require('path').join(__dirname, 'ffpc-debug.html'), html);
  console.log('  Saved debug HTML, page title:', await page.title());
  console.log('  Page URL:', page.url());
  console.log('  Team links found:', (html.match(/TeamHome/g) || []).length);
  console.log('  HTML length:', html.length);

  return await page.evaluate(() => {
    const teams = [];

    // Get column headers from the table
    const headers = Array.from(document.querySelectorAll('table.leagueRosterTable th'))
      .map(th => th.textContent.trim());
    console.log('Headers:', headers);

    // Team rows use SetLineup.aspx links
    const teamRows = Array.from(document.querySelectorAll('tr[id*="trTeamNameAndRoster"]'));

    teamRows.forEach(teamRow => {
      const teamLink = teamRow.querySelector('a[href*="SetLineup"], a[href*="TeamHome"], td a');
      if (!teamLink) return;

      const teamName = teamLink.textContent.trim();
      const cells = Array.from(teamRow.querySelectorAll('td'));

      // Parse roster count and IR from first cell
      const firstCellText = cells[0] ? cells[0].innerText : '';
      const rosterMatch = firstCellText.match(/Rostered:\s*(\d+)/);
      const irMatch = firstCellText.match(/IR:\s*(\d+)/);
      const rosterCount = rosterMatch ? parseInt(rosterMatch[1]) : 0;
      const irCount = irMatch ? parseInt(irMatch[1]) : 0;

      // Extract players by position column (skip TEAM column at index 0)
      const players = {};
      cells.forEach((cell, i) => {
        if (i === 0) return; // skip team name cell
        const pos = headers[i] || `pos${i}`;
        if (!pos) return;
        const playerLinks = Array.from(cell.querySelectorAll('a'));
        players[pos] = playerLinks.map(pl => {
          const name = pl.textContent.trim();
          // NFL team abbreviation follows in parentheses as text node
          let nflTeam = '';
          let node = pl.nextSibling;
          while (node) {
            const txt = (node.textContent || '').trim();
            const m = txt.match(/\(([A-Z]{2,4})\)/);
            if (m) { nflTeam = m[1]; break; }
            node = node.nextSibling;
          }
          return { name, nflTeam };
        }).filter(p => p.name && p.name.length > 1);
      });

      // Get picks from subsequent rows until next team row
      const picksLines = [];
      let nextEl = teamRow.nextElementSibling;
      while (nextEl) {
        if (nextEl.id && nextEl.id.includes('trTeamNameAndRoster')) break;
        const txt = nextEl.textContent.trim();
        if (txt.match(/Draft Pick|20\d\d/i)) picksLines.push(txt);
        nextEl = nextEl.nextElementSibling;
      }

      teams.push({ name: teamName, players, picks: picksLines.join(' | '), rosterCount, irCount });
    });

    // League name from h1
    const h1 = document.querySelector('h1');
    const leagueName = h1 ? h1.textContent.trim() : document.title;

    return { teams, leagueName };
  });
}

async function scrapeAllFFPC() {
  if (!puppeteer) throw new Error('Puppeteer not installed.');
  if (ffpcScrapeInProgress) throw new Error('FFPC scrape already in progress');

  const config = loadFFPCConfig();
  if (!config) throw new Error('ffpc-config.json not found.');

  ffpcScrapeInProgress = true;
  console.log('Launching Puppeteer for FFPC (no login needed)...');

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36');

    // Scrape each league directly - rosters page is publicly accessible
    for (const league of config.leagues) {
      console.log(`Scraping league ${league.id} (${league.name})...`);
      const result = await scrapeFFPCLeague(page, league.ltuid);
      const leagueName = result.leagueName || league.name;
      ffpcCache[league.id] = {
        teams: result.teams,
        leagueName,
        timestamp: Date.now(),
      };
      console.log(`  League ${league.id}: ${result.teams.length} teams`);
    }

    saveFFPCCache();
    await browser.close();
    ffpcScrapeInProgress = false;
    console.log('FFPC scrape complete');
    return ffpcCache;

  } catch(err) {
    try { await browser.close(); } catch(e) {}
    ffpcScrapeInProgress = false;
    throw err;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function saveKTCCache(players) {
  cachedData = players;
  cacheTimestamp = Date.now();
  fs.writeFileSync(CACHE_FILE, JSON.stringify({ data: cachedData, timestamp: cacheTimestamp }));
}

// ── KTC per-player history backfill (API-based, all formats) ────────────────
// Uses KTC POST /dynasty-rankings/histories: [{playerID:N},...] → compressed history
// Each entry: 10-char string YYMMDDVVVV (year,month,day,value 0-9999)

function decodeKTCHistoryEntry(encoded) {
  if (typeof encoded !== 'string' || encoded.length < 10) return null;
  const year = 2000 + parseInt(encoded.slice(0,2), 10);
  const mm   = encoded.slice(2,4);
  const dd   = encoded.slice(4,6);
  const val  = parseInt(encoded.slice(6), 10);
  if (isNaN(val) || isNaN(year)) return null;
  return { dateStr: `${year}-${mm}-${dd}`, value: val };
}

function ktcHistoriesPost(playerIDs) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(playerIDs.map(id => ({ playerID: Number(id) })));
    const opts = {
      hostname: 'keeptradecut.com',
      path: '/dynasty-rankings/histories',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36',
        'Accept': 'application/json',
        'Origin': 'https://keeptradecut.com',
        'Referer': 'https://keeptradecut.com/dynasty-rankings',
      },
    };
    let raw = '';
    const req = https.request(opts, res => {
      res.on('data', c => raw += c);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${raw.slice(0,200)}`));
        try { resolve(JSON.parse(raw)); }
        catch(e) { reject(new Error('JSON parse failed: ' + raw.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.setTimeout(30000);
    req.write(body);
    req.end();
  });
}

function parseAllHistories(entry) {
  const sf  = entry.superflexValues || {};
  const qb1 = entry.oneQB           || {};
  function decodeList(arr) {
    if (!Array.isArray(arr)) return [];
    return arr.map(decodeKTCHistoryEntry).filter(Boolean);
  }
  // KTC nests TEP variants as sf.tep.valueHistory, sf.tepp.valueHistory, etc.
  // Also try alternate key names in case API shape differs
  return {
    sf:        decodeList(sf.valueHistory),
    tep:       decodeList((sf.tep   || sf.tepValues   || {}).valueHistory),
    tepp:      decodeList((sf.tepp  || sf.teppValues  || {}).valueHistory),
    teppp:     decodeList((sf.teppp || sf.tepppValues || {}).valueHistory),
    oneqb:     decodeList(qb1.valueHistory),
    tep_1qb:   decodeList((qb1.tep   || qb1.tepValues   || {}).valueHistory),
    tepp_1qb:  decodeList((qb1.tepp  || qb1.teppValues  || {}).valueHistory),
    teppp_1qb: decodeList((qb1.teppp || qb1.tepppValues || {}).valueHistory),
  };
}

async function backfillKTCHistory() {
  if (backfillInProgress) throw new Error('Backfill already in progress');
  if (!cachedData || !cachedData.length) throw new Error('No cached players to backfill');

  backfillInProgress = true;
  const players = cachedData.filter(p => p.position !== 'RDP' && p.name && p.id && !isNaN(Number(p.id)));
  backfillProgress = { done: 0, total: players.length, status: 'running' };

  const idToPlayer = {};
  for (const p of players) idToPlayer[String(p.id)] = p;

  const BATCH = 50;
  const DELAY = 1500;

  try {
    for (let i = 0; i < players.length; i += BATCH) {
      const batch = players.slice(i, i + BATCH);
      const ids   = batch.map(p => p.id);
      const bNum  = Math.floor(i/BATCH) + 1;
      console.log(`  Backfill batch ${bNum}: players ${i+1}–${Math.min(i+BATCH, players.length)} of ${players.length}`);

      let results;
      try {
        results = await ktcHistoriesPost(ids);
      } catch(e) {
        console.warn(`  Batch ${bNum} failed: ${e.message} — skipping`);
        backfillProgress.done += batch.length;
        continue;
      }

      if (!Array.isArray(results)) {
        console.warn(`  Batch ${bNum}: unexpected response shape`);
        backfillProgress.done += batch.length;
        continue;
      }

      for (const entry of results) {
        const player = idToPlayer[String(entry.playerID)];
        if (!player) continue;

        const hists = parseAllHistories(entry);
        // Build date maps for O(1) lookup
        const maps = {};
        for (const [key, arr] of Object.entries(hists)) {
          maps[key] = {};
          for (const {dateStr, value} of arr) maps[key][dateStr] = value;
        }

        const allDates = new Set([
          ...hists.sf.map(e => e.dateStr),
          ...hists.oneqb.map(e => e.dateStr),
        ]);

        for (const ds of allDates) {
          if (!ktcHistory[ds]) ktcHistory[ds] = {};
          ktcHistory[ds][player.name] = {
            value:     maps.sf[ds]        || 0,
            oneqb:     maps.oneqb[ds]     || 0,
            tep:       maps.tep[ds]       || maps.sf[ds]    || 0,
            tepp:      maps.tepp[ds]      || maps.sf[ds]    || 0,
            teppp:     maps.teppp[ds]     || maps.sf[ds]    || 0,
            tep_1qb:   maps.tep_1qb[ds]  || maps.oneqb[ds] || 0,
            tepp_1qb:  maps.tepp_1qb[ds] || maps.oneqb[ds] || 0,
            teppp_1qb: maps.teppp_1qb[ds]|| maps.oneqb[ds] || 0,
            pos:  player.position || '',
            team: player.team     || '',
            age:  player.age      || 0,
          };
        }
        if (allDates.size) console.log(`  Backfill: ${player.name} → ${allDates.size} dates`);
        backfillProgress.done++;
      }

      saveHistory();
      if (i + BATCH < players.length) await new Promise(r => setTimeout(r, DELAY));
    }

    saveHistory();
    backfillProgress.status = 'done';
    console.log(`Backfill complete: ${Object.keys(ktcHistory).length} dates in history.`);
  } catch(err) {
    backfillProgress.status = 'error: ' + err.message;
    backfillInProgress = false;
    throw err;
  }
  backfillInProgress = false;
}

// ── HTTP server ───────────────────────────────────────────────────────────────
const requestHandler = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = req.url.split('?')[0];

  // ── KTC endpoints ────────────────────────────────────────────────────────────

  if (req.method === 'GET' && url === '/ktc') {
    if (!cachedData) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No KTC data cached. Press Refresh KTC.' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: cachedData, cachedAt: cacheTimestamp, ageMinutes: Math.round((Date.now() - cacheTimestamp) / 60000) }));
    return;
  }

  if (req.method === 'POST' && url === '/scrape') {
    if (scrapeInProgress) {
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'in_progress' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'started' }));
    scrapeKTC()
      .then(players => { saveKTCCache(players); console.log(`KTC cache updated: ${players.length} players`); })
      .catch(err => console.error('KTC scrape failed:', err.message));
    return;
  }

  if (req.method === 'GET' && url === '/scrape-status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      inProgress: scrapeInProgress,
      hasCachedData: !!cachedData,
      playerCount: cachedData ? cachedData.length : 0,
      cachedAt: cacheTimestamp,
      ageMinutes: cacheTimestamp ? Math.round((Date.now() - cacheTimestamp) / 60000) : null,
    }));
    return;
  }

  if (req.method === 'POST' && url === '/ktc') {
    try {
      const players = JSON.parse(await readBody(req));
      if (!Array.isArray(players) || players.length === 0) throw new Error('Empty');
      saveKTCCache(players);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, count: players.length }));
    } catch(err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── KTC Redraft endpoints ─────────────────────────────────────────────────────

  if (req.method === 'GET' && url === '/ktc-redraft') {
    if (!redraftData) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No redraft data cached. Press Refresh Redraft.' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: redraftData, cachedAt: redraftTimestamp, ageMinutes: Math.round((Date.now() - redraftTimestamp) / 60000) }));
    return;
  }

  if (req.method === 'POST' && url === '/scrape-redraft') {
    if (redraftScrapeInProgress) {
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'in_progress' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'started' }));
    scrapeKTCRedraft()
      .then(players => { saveRedraftCache(players); console.log(`KTC redraft cache updated: ${players.length} players`); })
      .catch(err => console.error('KTC redraft scrape failed:', err.message));
    return;
  }

  if (req.method === 'GET' && url === '/scrape-redraft-status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      inProgress: redraftScrapeInProgress,
      hasCachedData: !!redraftData,
      playerCount: redraftData ? redraftData.length : 0,
      cachedAt: redraftTimestamp,
      ageMinutes: redraftTimestamp ? Math.round((Date.now() - redraftTimestamp) / 60000) : null,
    }));
    return;
  }


  // POST /ffpc-scrape — trigger Puppeteer FFPC scrape
  if (req.method === 'POST' && url === '/ffpc-scrape') {
    if (ffpcScrapeInProgress) {
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'in_progress' }));
      return;
    }
    const config = loadFFPCConfig();
    if (!config) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'ffpc-config.json not found in ~/dynasty-calc/' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'started', leagues: config.leagues.map(l => l.id) }));
    scrapeAllFFPC()
      .then(() => console.log('FFPC scrape done'))
      .catch(err => console.error('FFPC scrape failed:', err.message));
    return;
  }

  // GET /ffpc-scrape-status
  if (req.method === 'GET' && url === '/ffpc-scrape-status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      inProgress: ffpcScrapeInProgress,
      leagues: Object.entries(ffpcCache).map(([id, d]) => ({
        leagueId: id,
        leagueName: d.leagueName,
        teamCount: d.teams ? d.teams.length : 0,
        ageMinutes: d.timestamp ? Math.round((Date.now() - d.timestamp) / 60000) : null,
      })),
    }));
    return;
  }

  // ── FFPC endpoints ────────────────────────────────────────────────────────────

  // POST /ffpc/:leagueId — receive scraped roster data from bookmarklet
  if (req.method === 'POST' && url.startsWith('/ffpc/')) {
    const leagueId = url.split('/')[2];
    if (!leagueId) { res.writeHead(400); res.end('Missing leagueId'); return; }
    try {
      const body = JSON.parse(await readBody(req));
      ffpcCache[leagueId] = { teams: body.teams, leagueName: body.leagueName, timestamp: Date.now() };
      saveFFPCCache();
      console.log(`FFPC league ${leagueId} cached: ${body.teams.length} teams`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, leagueId, teamCount: body.teams.length }));
    } catch(err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // GET /ffpc/:leagueId — serve cached roster data
  if (req.method === 'GET' && url.startsWith('/ffpc/')) {
    const leagueId = url.split('/')[2];
    const cached = ffpcCache[leagueId];
    if (!cached) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `No data for league ${leagueId}. Run the FFPC bookmarklet first.` }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...cached, ageMinutes: Math.round((Date.now() - cached.timestamp) / 60000) }));
    return;
  }

  // GET /ffpc — serve all cached leagues
  if (req.method === 'GET' && url === '/ffpc') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const summary = Object.entries(ffpcCache).map(([id, d]) => ({
      leagueId: id,
      leagueName: d.leagueName,
      teamCount: d.teams ? d.teams.length : 0,
      timestamp: d.timestamp,
      ageMinutes: Math.round((Date.now() - d.timestamp) / 60000),
    }));
    res.end(JSON.stringify(summary));
    return;
  }

  // ── KTC History endpoints ────────────────────────────────────────────────────

  // GET /ktc-history — return full history object
  if (req.method === 'GET' && url === '/ktc-history') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(ktcHistory));
    return;
  }

  // POST /ktc-history/snapshot — manually trigger a snapshot for today
  if (req.method === 'POST' && url === '/ktc-history/snapshot') {
    if (!cachedData) { res.writeHead(503); res.end(JSON.stringify({ error: 'No KTC data cached' })); return; }
    fillMissedSnapshots(cachedData);
    const ds = todayStr();
    const alreadyHad = !!ktcHistory[ds];
    if (!alreadyHad) snapshotDate(ds, cachedData);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, date: ds, days: Object.keys(ktcHistory).length, alreadyExisted: alreadyHad }));
    return;
  }

  // POST /ktc-history/backfill — kick off per-player KTC history scrape
  if (req.method === 'POST' && url === '/ktc-history/backfill') {
    if (backfillInProgress) { res.writeHead(202); res.end(JSON.stringify({ status: 'in_progress', ...backfillProgress })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'started', total: cachedData ? cachedData.filter(p => p.position !== 'RDP').length : 0 }));
    backfillKTCHistory().catch(e => console.error('Backfill failed:', e.message));
    return;
  }

  // GET /ktc-history/backfill-status
  if (req.method === 'GET' && url === '/ktc-history/backfill-status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ inProgress: backfillInProgress, ...backfillProgress, historyDays: Object.keys(ktcHistory).length }));
    return;
  }

  // GET /player-stats — return player profiler stats
  if (req.method === 'GET' && url === '/player-stats') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(playerStats));
    return;
  }

  // GET /team-history — serve team-history.json
  if (req.method === 'GET' && url === '/team-history') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(teamHistory));
    return;
  }

  // POST /team-history/snapshot — trigger team value snapshot with transaction tracking
  if (req.method === 'POST' && url === '/team-history/snapshot') {
    try {
      snapshotTeamValues(todayStr());
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, date: todayStr(), leagues: Object.keys(ffpcCache).length }));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // POST /team-history — receive and save updated team history from client or snapshot
  if (req.method === 'POST' && url === '/team-history') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const incoming = JSON.parse(body);
        // Deep merge: preserve existing dates, add new ones
        for (const [lid, ldata] of Object.entries(incoming)) {
          if (!teamHistory[lid]) teamHistory[lid] = { teams: {} };
          for (const [slug, tdata] of Object.entries(ldata.teams || {})) {
            if (!teamHistory[lid].teams[slug]) teamHistory[lid].teams[slug] = { names: [], dates: {}, transactions: [] };
            const dest = teamHistory[lid].teams[slug];
            if (tdata.names) for (const n of tdata.names) { if (!dest.names.includes(n)) dest.names.push(n); }
            if (tdata.dates) Object.assign(dest.dates, tdata.dates);
            if (tdata.transactions) dest.transactions = [...(dest.transactions||[]), ...(tdata.transactions||[])];
          }
        }
        saveTeamHistory();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch(e) {
        res.writeHead(400); res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.method === 'GET' && url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      hasCachedData: !!cachedData,
      playerCount: cachedData ? cachedData.length : 0,
      cachedAt: cacheTimestamp ? new Date(cacheTimestamp).toLocaleString() : null,
      ageMinutes: cacheTimestamp ? Math.round((Date.now() - cacheTimestamp) / 60000) : null,
      scrapeInProgress,
      ffpcLeagues: Object.keys(ffpcCache),
    }));
    return;
  }

  // GET /leaguemates — return known leaguemate email list
  if (req.method === 'GET' && url === '/leaguemates') {
    const data = loadLeaguemates();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
    return;
  }

  // GET /scout-lookup?email=foo@bar.com
  if (req.method === 'GET' && url.startsWith('/scout-lookup')) {
    const qs = req.url.split('?')[1] || '';
    const email = new URLSearchParams(qs).get('email');
    if (!email) { res.writeHead(400); res.end(JSON.stringify({ error: 'email required' })); return; }
    try {
      ensureFFPCPlayerMap();
      const config = loadFFPCConfig();
      const jwt = config && config.dynJwt ? config.dynJwt : null;

      function dnRequest(method, path, body) {
        return new Promise((resolve, reject) => {
          const payload = body ? JSON.stringify(body) : null;
          const options = {
            hostname: 'gm3.dynastynerds.com',
            path: `/api/gm/${path}`,
            method,
            headers: {
              'Accept': 'application/json',
              'dyn_jwt': jwt,
              'Origin': 'https://app.dynastynerds.com',
              'Referer': 'https://app.dynastynerds.com/',
              'User-Agent': 'Mozilla/5.0',
              ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
            },
            timeout: 20000,
          };
          let raw = '';
          const r = https.request(options, res2 => {
            res2.on('data', c => raw += c);
            res2.on('end', () => { try { resolve(JSON.parse(raw)); } catch(e) { resolve(null); } });
          });
          r.on('error', reject);
          r.on('timeout', () => { r.destroy(); reject(new Error(`DN ${path} timed out`)); });
          if (payload) r.write(payload);
          r.end();
        });
      }

      // Step 1: Remove ALL linked accounts so owned:true is clean for this lookup only.
      // We remove every account including our own — the scouted user is added fresh in Step 2.
      const accounts = await dnRequest('GET', 'accounts', null) || [];
      if (accounts.length > 0) {
        console.log(`Scout: clearing ${accounts.length} accounts before lookup: ${accounts.map(a => a.name).join(', ')}`);
        await Promise.all(accounts.map(a =>
          dnRequest('POST', 'accounts/remove', { accountId: a.id }).catch(() => {})
        ));
      }

      // Step 2: Add the scouted user — newLeagues will have correct owned:true
      const dnData = await dynastyNerdsLookup(email);
      const newLeagues = dnData.newLeagues || [];
      const accountLeagues = (dnData.data?.account?.[0]?.leagues) || [];
      const dnAccountId = dnData.data?.account?.[0]?.id || null;

      console.log(`Scout: ${email} → ${newLeagues.length} newLeagues, ${accountLeagues.length} accountLeagues`);

      function resolvePicks(picks) {
        // DN reuses the same pickId for all picks of the same round (e.g. all R1s share pickId 421).
        // previousTeamId always equals the current team — no traded-from info available from DN.
        // Each array entry is a distinct pick, so just map them directly with no dedup.
        return (picks || [])
          .map(pk => ({ year: pk.year, round: pk.round, tradedFrom: null }))
          .sort((a, b) => a.year - b.year || a.round - b.round);
      }

      function resolveTeam(team, leagueId, ownedTeamId) {
        const allIds = [...(team.starters||[]), ...(team.bench||[]), ...(team.taxi||[]), ...(team.ir||[])];
        const players = allIds.map(id => {
          const name = ffpcPlayerMap[String(id)];
          return name ? { id, name } : { id, name: null };
        });
        return { id: team.id, name: team.name, owned: team.id === ownedTeamId, leagueId: team.leagueId || leagueId, players, picks: resolvePicks(team.picks) };
      }

      function buildLeague(league, meta) {
        const ownedTeamId = (league.teams || []).find(t => t.owned)?.id ?? null;
        return {
          id: league.id, name: league.name,
          extId: league.extId || null,
          scoringType: league.scoringType || meta?.scoringType,
          bestBall: league.bestBall ?? meta?.bestBall,
          status: league.status,
          teams: (league.teams || []).map(t => resolveTeam(t, league.id, ownedTeamId)),
          candidateTeams: [],
        };
      }

      let leagues = newLeagues.map(league => buildLeague(league, null));

      // Fallback: if newLeagues still empty, fetch per-league
      if (leagues.length === 0 && accountLeagues.length > 0) {
        console.log(`Scout: newLeagues empty — fetching ${accountLeagues.length} leagues individually`);
        const fetched = await Promise.all(accountLeagues.map(meta =>
          dnRequest('GET', `leagues/${meta.id}`, null).then(league => league ? buildLeague(league, meta) : null)
        ));
        leagues = fetched.filter(Boolean);
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ email, dnAccountId, leagues, playerMapSize: Object.keys(ffpcPlayerMap).length }));

      // Save this email to leaguemates.json if it's a new contact
      const wasNew = addLeaguemateEmail(email);
      if (wasNew) console.log(`Leaguemates: added ${email} (now ${loadLeaguemates().emails.length} total)`);

      // Expand player map in background — don't await, response already sent
      expandPlayerMapFromLeagues(newLeagues).catch(e => console.warn('Player map expand failed:', e.message));
    } catch(err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // POST /build-player-map — scrape FFPC Rosters pages + run DN expansion to fully populate player map
  if (req.method === 'POST' && url === '/build-player-map') {
    try {
      ensureFFPCPlayerMap();
      const config = loadFFPCConfig();
      if (!config || !config.leagues || config.leagues.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No leagues in ffpc-config.json' }));
        return;
      }
      if (!puppeteer) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Puppeteer not installed' }));
        return;
      }

      const beforeCount = Object.keys(ffpcPlayerMap).length;
      let newMappings = 0;

      // Step 1: Scrape FFPC Rosters pages — extracts playerID→name from PlayerProfile links
      // These are FFPC IDs, not DN IDs, but they populate the name lookup used by expandPlayerMapFromLeagues
      for (const league of config.leagues) {
        const ltuid = league.ltuid;
        if (!ltuid) continue;
        console.log(`BuildPlayerMap: scraping FFPC league ${league.id} (${league.name || ltuid})`);
        const ffpcTeams = await scrapeFFPCRostersByLeagueId(ltuid);
        if (!ffpcTeams || ffpcTeams.length === 0) { console.warn(`  No teams returned for ${ltuid}`); continue; }
        let leagueMappings = 0;
        for (const t of ffpcTeams) {
          for (const [pid, name] of Object.entries(t.directMappings || {})) {
            if (!ffpcPlayerMap[pid]) { ffpcPlayerMap[pid] = name; newMappings++; leagueMappings++; }
          }
        }
        console.log(`  +${leagueMappings} FFPC ID mappings from league ${league.id}`);
      }
      if (newMappings > 0) fs.writeFileSync(FFPC_PLAYER_MAP_FILE, JSON.stringify(ffpcPlayerMap, null, 2));

      // Step 2: Fetch own DN leagues and run expandPlayerMapFromLeagues to resolve DN IDs → names
      const jwt = config.dynJwt || null;
      if (jwt) {
        function dnReq2(method, path, body) {
          return new Promise((resolve, reject) => {
            const payload = body ? JSON.stringify(body) : null;
            const options = {
              hostname: 'gm3.dynastynerds.com',
              path: `/api/gm/${path}`,
              method,
              headers: {
                'Accept': 'application/json', 'dyn_jwt': jwt,
                'Origin': 'https://app.dynastynerds.com', 'Referer': 'https://app.dynastynerds.com/',
                'User-Agent': 'Mozilla/5.0',
                ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
              },
              timeout: 20000,
            };
            let raw = '';
            const r = https.request(options, res2 => {
              res2.on('data', c => raw += c);
              res2.on('end', () => { try { resolve(JSON.parse(raw)); } catch(e) { resolve(null); } });
            });
            r.on('error', reject);
            r.on('timeout', () => { r.destroy(); reject(new Error('DN timeout')); });
            if (payload) r.write(payload);
            r.end();
          });
        }

        console.log('BuildPlayerMap: fetching own DN leagues for ID resolution...');
        const accounts = await dnReq2('GET', 'accounts', null) || [];
        const myEmail = config.email || config.username || null;
        const ownAccount = accounts.find(a => !myEmail || a.name === myEmail || a.extId === myEmail) || accounts[0];
        if (ownAccount) {
          const acctData = await dnReq2('GET', `accounts/${ownAccount.id}`, null) || {};
          const acctLeagues = acctData.leagues || ownAccount.leagues || [];
          const fetched = await Promise.all(acctLeagues.map(meta =>
            dnReq2('GET', `leagues/${meta.id}`, null).then(league => {
              if (!league) return null;
              if (!league.extId && meta.extId) league.extId = meta.extId;
              return league;
            }).catch(() => null)
          ));
          const dnLeagues = fetched.filter(Boolean);
          if (dnLeagues.length > 0) {
            console.log(`BuildPlayerMap: running expand on ${dnLeagues.length} DN leagues...`);
            expandInProgress = false;
            await expandPlayerMapFromLeagues(dnLeagues);
          }
        }
      } else {
        console.log('BuildPlayerMap: no dynJwt — skipping DN ID resolution');
      }

      ensureFFPCPlayerMap(); // reload from disk after expansion
      const result = { before: beforeCount, added: Object.keys(ffpcPlayerMap).length - beforeCount, total: Object.keys(ffpcPlayerMap).length };
      console.log(`BuildPlayerMap complete: +${result.added} new (total ${result.total})`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch(err) {
      console.error('BuildPlayerMap error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }


  // GET /probe-ffpc-api?ltuid=XXX — diagnostic: intercept all FFPC API calls and return raw responses
  if (req.method === 'GET' && url === '/probe-ffpc-api') {
    const qs = req.url.split('?')[1] || '';
    const params = new URLSearchParams(qs);
    const ltuid = params.get('ltuid') || params.get('leagueId');
    if (!ltuid) { res.writeHead(400); res.end(JSON.stringify({ error: 'ltuid required' })); return; }
    if (!puppeteer) { res.writeHead(500); res.end(JSON.stringify({ error: 'Puppeteer not installed' })); return; }
    try {
      const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox','--disable-setuid-sandbox','--disable-gpu'] });
      const page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 900 });
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36');

      const captured = [];
      await page.setRequestInterception(true);
      page.on('request', req2 => req2.continue());
      page.on('response', async response => {
        const rUrl = response.url();
        const ct = response.headers()['content-type'] || '';
        if (!ct.includes('json') && !rUrl.includes('/api/') && !rUrl.includes('.aspx')) return;
        try {
          const text = await response.text();
          if (text.length < 10 || text.length > 500000) return;
          let body = null;
          try { body = JSON.parse(text); } catch(_) {}
          captured.push({ url: rUrl.replace('https://myffpc.com',''), status: response.status(), hasJson: !!body, preview: text.slice(0, 300) });
        } catch(_) {}
      });

      await page.goto(`https://myffpc.com/Rosters.aspx?ltuid=${ltuid}`, { waitUntil: 'networkidle2', timeout: 25000 });

      // Grab all hrefs on the page — look for SetLineup, TeamHome, PlayerProfile links
      const allLinks = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('a[href]'))
          .map(a => a.getAttribute('href'))
          .filter(h => h && (h.includes('SetLineup') || h.includes('TeamHome') || h.includes('PlayerProfile') || h.includes('pid=') || h.includes('playerid=')))
          .slice(0, 30);
      });

      // Also grab all anchor hrefs to find any that have numeric IDs
      const playerLinks = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('table.leagueRosterTable a'))
          .map(a => ({ text: a.textContent.trim(), href: a.getAttribute('href') }))
          .filter(x => x.href)
          .slice(0, 50);
      });

      // Load the first SetLineup link to probe for player IDs in form inputs
      let setLineupProbe = null;
      const setLineupHref = allLinks.find(h => h.includes('SetLineup'));
      if (setLineupHref) {
        const setLineupUrl = setLineupHref.startsWith('http') ? setLineupHref : `https://myffpc.com/${setLineupHref.replace(/^\//, '')}`;
        try {
          await page.goto(setLineupUrl, { waitUntil: 'networkidle2', timeout: 20000 });
          setLineupProbe = await page.evaluate(() => {
            // Look for hidden inputs with player IDs
            const inputs = Array.from(document.querySelectorAll('input[name*="player"], input[id*="player"], input[name*="Player"]'))
              .map(i => ({ name: i.name, id: i.id, value: i.value, type: i.type }))
              .slice(0, 20);
            // Look for select dropdowns with player options
            const selects = Array.from(document.querySelectorAll('select'))
              .map(s => ({
                name: s.name,
                options: Array.from(s.options).slice(0, 5).map(o => ({ value: o.value, text: o.text.trim() }))
              }))
              .slice(0, 5);
            // Grab any inline script snippets that look like player data
            const scriptSnippets = Array.from(document.querySelectorAll('script:not([src])'))
              .map(s => s.textContent.trim().slice(0, 200))
              .filter(s => s.match(/player|Player|roster/i))
              .slice(0, 3);
            return { url: window.location.href, inputs, selects, scriptSnippets };
          });
        } catch(e) {
          setLineupProbe = { error: e.message };
        }
      }

      await browser.close();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ltuid, captured, allLinks, playerLinks, setLineupProbe }));
    } catch(err) {
      res.writeHead(500); res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // GET /probe-ffpc-user?email=foo@bar.com
  // No-auth discovery probe: tries all plausible FFPC endpoints to find a user's
  // leagues by email, exactly the way DN's backend must do it. No passwords needed.
  if (req.method === 'GET' && url === '/probe-ffpc-user') {
    const qs = req.url.split('?')[1] || '';
    const targetEmail = new URLSearchParams(qs).get('email');
    if (!targetEmail) { res.writeHead(400); res.end(JSON.stringify({ error: 'email required' })); return; }

    console.log(`probe-ffpc-user: probing for ${targetEmail} (no auth)`);

    // Helper: raw HTTPS GET/POST against myffpc.com, no cookies
    function ffpcRaw(method, path, body, extraHeaders) {
      return new Promise((resolve) => {
        const payload = body ? JSON.stringify(body) : null;
        const options = {
          hostname: 'myffpc.com',
          path,
          method,
          headers: {
            'Accept': 'application/json, text/plain, */*',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36',
            'X-Requested-With': 'XMLHttpRequest',
            'Origin': 'https://myffpc.com',
            'Referer': 'https://myffpc.com/',
            ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
            ...(extraHeaders || {}),
          },
          timeout: 10000,
        };
        let raw = '';
        const r = https.request(options, res2 => {
          res2.on('data', c => raw += c);
          res2.on('end', () => {
            let body2 = null;
            try { body2 = JSON.parse(raw); } catch(_) {}
            resolve({ status: res2.statusCode, headers: res2.headers, raw: raw.slice(0, 800), json: body2 });
          });
        });
        r.on('error', e => resolve({ error: e.message }));
        r.on('timeout', () => { r.destroy(); resolve({ error: 'timeout' }); });
        if (payload) r.write(payload);
        r.end();
      });
    }

    // Helper: form-encoded POST (some FFPC endpoints use application/x-www-form-urlencoded)
    function ffpcForm(path, fields) {
      const payload = new URLSearchParams(fields).toString();
      return new Promise((resolve) => {
        const options = {
          hostname: 'myffpc.com',
          path,
          method: 'POST',
          headers: {
            'Accept': 'application/json, text/plain, */*',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36',
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(payload),
            'X-Requested-With': 'XMLHttpRequest',
          },
          timeout: 10000,
        };
        let raw = '';
        const r = https.request(options, res2 => {
          res2.on('data', c => raw += c);
          res2.on('end', () => {
            let body2 = null;
            try { body2 = JSON.parse(raw); } catch(_) {}
            resolve({ status: res2.statusCode, raw: raw.slice(0, 800), json: body2 });
          });
        });
        r.on('error', e => resolve({ error: e.message }));
        r.on('timeout', () => { r.destroy(); resolve({ error: 'timeout' }); });
        r.write(payload);
        r.end();
      });
    }

    try {
      const enc = encodeURIComponent(targetEmail);
      const results = {};

      // ── Batch 1: GET endpoints — user/account lookup by email or username ──────
      const getEndpoints = [
        // General namespace
        `/api/General/GetUserLeagues?username=${enc}`,
        `/api/General/GetUserLeagues?email=${enc}`,
        `/api/General/GetUserInfo?username=${enc}`,
        `/api/General/GetUserInfo?email=${enc}`,
        `/api/General/GetUserAccount?username=${enc}`,
        `/api/General/GetUserAccount?email=${enc}`,
        `/api/General/GetAccount?username=${enc}`,
        `/api/General/GetAccount?email=${enc}`,
        `/api/General/SearchUsers?q=${enc}`,
        `/api/General/SearchUsers?query=${enc}`,
        `/api/General/SearchUsers?email=${enc}`,
        `/api/General/GetLeaguesByEmail?email=${enc}`,
        `/api/General/GetLeaguesByUser?email=${enc}`,
        `/api/General/GetLeaguesByUser?username=${enc}`,
        // User namespace
        `/api/User/GetLeagues?email=${enc}`,
        `/api/User/GetLeagues?username=${enc}`,
        `/api/User/GetInfo?email=${enc}`,
        `/api/User/GetInfo?username=${enc}`,
        `/api/User/Search?email=${enc}`,
        // Account namespace
        `/api/Account/GetLeagues?email=${enc}`,
        `/api/Account/GetLeagues?username=${enc}`,
        `/api/Account/Lookup?email=${enc}`,
        // Handler.ashx style (older FFPC pattern)
        `/Handlers/UserHandler.ashx?action=getleagues&email=${enc}`,
        `/Handlers/UserHandler.ashx?action=lookup&email=${enc}`,
        `/Handlers/LeagueHandler.ashx?action=getbyuser&email=${enc}`,
        // Public profile page — may redirect or render league list
        `/PublicProfile.aspx?username=${enc}`,
        `/PublicProfile.aspx?email=${enc}`,
        `/UserProfile.aspx?username=${enc}`,
        `/MyLeagues.aspx?username=${enc}`,
      ];

      console.log(`probe-ffpc-user: firing ${getEndpoints.length} GET probes...`);
      await Promise.all(getEndpoints.map(async ep => {
        results[`GET ${ep.split('?')[0]}`] = await ffpcRaw('GET', ep, null);
      }));

      // ── Batch 2: POST endpoints — DN sends { username, password:'' } pattern ──
      const postCandidates = [
        { path: '/api/General/Login',            body: { username: targetEmail, password: '' } },
        { path: '/api/General/Login',            body: { email: targetEmail, password: '' } },
        { path: '/api/General/GetUser',          body: { username: targetEmail } },
        { path: '/api/General/GetUser',          body: { email: targetEmail } },
        { path: '/api/General/ValidateUser',     body: { username: targetEmail, password: '' } },
        { path: '/api/General/LookupUser',       body: { username: targetEmail } },
        { path: '/api/General/LookupUser',       body: { email: targetEmail } },
        { path: '/api/Account/Login',            body: { username: targetEmail, password: '' } },
        { path: '/api/Account/Lookup',           body: { username: targetEmail } },
        { path: '/api/User/Login',               body: { username: targetEmail, password: '' } },
        // Form-encoded versions of the above
      ];

      console.log(`probe-ffpc-user: firing ${postCandidates.length} POST JSON probes...`);
      await Promise.all(postCandidates.map(async ({ path: p, body: b }) => {
        const key = `POST ${p} body=${JSON.stringify(b).slice(0,40)}`;
        results[key] = await ffpcRaw('POST', p, b);
      }));

      // ── Batch 3: Form-encoded POSTs (classic ASP.NET pattern) ─────────────────
      const formCandidates = [
        { path: '/Login.aspx',     fields: { txtUserName: targetEmail, txtPassword: '' } },
        { path: '/api/General/Login', fields: { username: targetEmail, password: '' } },
      ];
      console.log(`probe-ffpc-user: firing ${formCandidates.length} form POST probes...`);
      await Promise.all(formCandidates.map(async ({ path: p, fields }) => {
        const key = `FORM ${p}`;
        results[key] = await ffpcForm(p, fields);
      }));

      // ── Summarize: which returned 200 with non-empty/non-error body? ──────────
      const hits = Object.entries(results)
        .filter(([, v]) => v.status === 200 && v.raw && v.raw.length > 10 && !v.raw.startsWith('<!'))
        .map(([k, v]) => ({ probe: k, status: v.status, preview: v.raw.slice(0, 300), hasJson: !!v.json }));

      const misses = Object.entries(results)
        .filter(([, v]) => v.status !== 200 || !v.raw || v.raw.startsWith('<!'))
        .map(([k, v]) => ({ probe: k, status: v.status || v.error }));

      console.log(`probe-ffpc-user: ${hits.length} hits, ${misses.length} misses`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ targetEmail, hits, misses, allResults: results }, null, 2));
    } catch(err) {
      res.writeHead(500); res.end(JSON.stringify({ error: err.message, stack: err.stack }));
    }
    return;
  }

  // POST /set-dn-jwt — manually set DN JWT (fallback if Edge LevelDB read fails)
  // Usage: curl -sk -X POST https://localhost:3001/set-dn-jwt -H 'Content-Type: application/json' -d '{"jwt":"eyJ..."}'
  if (req.method === 'POST' && url === '/set-dn-jwt') {
    try {
      const body = JSON.parse(await readBody(req));
      if (!body.jwt || !body.jwt.startsWith('ey')) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'jwt field required, must start with ey' }));
        return;
      }
      const configObj = JSON.parse(fs.readFileSync(path.join(__dirname, 'ffpc-config.json'), 'utf8'));
      configObj.dynJwt = body.jwt;
      configObj.dynJwtUpdatedAt = new Date().toISOString();
      fs.writeFileSync(path.join(__dirname, 'ffpc-config.json'), JSON.stringify(configObj, null, 2));
      console.log('DN JWT updated via /set-dn-jwt');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, length: body.jwt.length, updatedAt: configObj.dynJwtUpdatedAt }));
    } catch(err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // POST /refresh-dn-jwt — manually trigger Edge localStorage read now
  if (req.method === 'POST' && url === '/refresh-dn-jwt') {
    try {
      const config = loadFFPCConfig();
      config.dynJwtUpdatedAt = null; // force refresh regardless of age
      const jwt = await getDNJwt(config);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, length: jwt ? jwt.length : 0, updatedAt: new Date().toISOString() }));
    } catch(err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  res.writeHead(404); res.end('Not found');
};

// ── FFPC player ID → name cache ───────────────────────────────────────────────
let ffpcPlayerMap = {};
let ffpcPlayerMapTimestamp = null;

const FFPC_PLAYER_MAP_FILE = path.join(__dirname, 'ffpc-player-map.json');

function ensureFFPCPlayerMap() {
  if (fs.existsSync(FFPC_PLAYER_MAP_FILE)) {
    try {
      const fileMtime = fs.statSync(FFPC_PLAYER_MAP_FILE).mtimeMs;
      if (!ffpcPlayerMapTimestamp || fileMtime > ffpcPlayerMapTimestamp || Object.keys(ffpcPlayerMap).length === 0) {
        ffpcPlayerMap = JSON.parse(fs.readFileSync(FFPC_PLAYER_MAP_FILE, 'utf8'));
        ffpcPlayerMapTimestamp = fileMtime;
        console.log(`FFPC player map loaded: ${Object.keys(ffpcPlayerMap).length} players`);
      }
    } catch(e) { console.warn('FFPC player map load failed:', e.message); }
  } else {
    console.warn('ffpc-player-map.json not found — player IDs will not resolve');
  }
}


// ── Auto-expand FFPC player ID map from scouted league data ──────────────────
let expandInProgress = false;

async function fetchFFPCPlayerMapForLeague(ltuid, leagueId) {
  // Try FFPC's JSON API endpoints directly first (no auth needed for public leagues)
  const endpoints = [
    `https://myffpc.com/api/General/GetLeagueRosters?ltuid=${ltuid}`,
    leagueId ? `https://myffpc.com/api/General/GetLeagueRosters?leagueID=${leagueId}` : null,
    leagueId ? `https://myffpc.com/api/League/GetLeagueRosters?leagueID=${leagueId}` : null,
    leagueId ? `https://myffpc.com/api/General/GetPlayers?leagueID=${leagueId}` : null,
  ].filter(Boolean);

  for (const endpoint of endpoints) {
    try {
      const data = await new Promise((resolve, reject) => {
        const options = {
          hostname: 'myffpc.com',
          path: new URL(endpoint).pathname + new URL(endpoint).search,
          method: 'GET',
          headers: {
            'Accept': 'application/json, text/javascript, */*',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36',
            'Referer': `https://myffpc.com/Rosters.aspx?ltuid=${ltuid}`,
            'X-Requested-With': 'XMLHttpRequest',
          },
          timeout: 10000,
        };
        let raw = '';
        const r = https.request(options, res2 => {
          res2.on('data', c => raw += c);
          res2.on('end', () => {
            try { resolve({ status: res2.statusCode, body: JSON.parse(raw) }); }
            catch(e) { resolve({ status: res2.statusCode, body: null, raw: raw.slice(0, 200) }); }
          });
        });
        r.on('error', reject);
        r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
        r.end();
      });
      console.log(`  FFPC API ${endpoint.split('?')[0].split('/').pop()}: status=${data.status}, hasBody=${!!data.body}, raw=${data.raw||''}`);
      if (data.body && data.status === 200) return { endpoint, data: data.body };
    } catch(e) {
      console.log(`  FFPC API endpoint failed: ${e.message}`);
    }
  }
  return null;
}

async function scrapeFFPCRostersByLeagueId(ltuid) {
  if (!puppeteer) return null;
  const url = `https://myffpc.com/Rosters.aspx?ltuid=${ltuid}`;
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox','--disable-setuid-sandbox','--disable-gpu'] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36');

    // Intercept all JSON API responses while the page loads
    const intercepted = [];
    await page.setRequestInterception(true);
    page.on('request', req => req.continue());
    page.on('response', async response => {
      const respUrl = response.url();
      const ct = response.headers()['content-type'] || '';
      if (!ct.includes('json') && !respUrl.includes('/api/')) return;
      try {
        const body = await response.json();
        intercepted.push({ url: respUrl, body });
        console.log(`  Intercepted: ${respUrl.replace('https://myffpc.com','')}`);
      } catch(_) {}
    });

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 25000 });

    // Check intercepted responses for player ID data
    const directMappingsAll = {};
    for (const { url: iUrl, body } of intercepted) {
      const mappings = extractPlayerMappingsFromFFPCResponse(body, iUrl);
      Object.assign(directMappingsAll, mappings);
    }
    if (Object.keys(directMappingsAll).length > 0) {
      console.log(`  Found ${Object.keys(directMappingsAll).length} direct ID mappings from intercepted API calls`);
    }

    // Also check for JS variables embedded in the page that contain player data
    const jsPlayerData = await page.evaluate(() => {
      // FFPC often embeds player data in window variables or inline script JSON
      const scripts = Array.from(document.querySelectorAll('script:not([src])')).map(s => s.textContent);
      const results = {};
      for (const script of scripts) {
        // Look for patterns like playerID:12345,"playerName":"Josh Allen"
        const matches = [...script.matchAll(/playerID["\s:]+(\d+)[^}]*?playerName["\s:]+["']([^"']+)["']/gi)];
        for (const m of matches) results[m[1]] = m[2];
        // Also: "id":12345,"name":"Josh Allen"
        const matches2 = [...script.matchAll(/"id"\s*:\s*(\d+)\s*,\s*"(?:playerN|n)ame"\s*:\s*"([^"]+)"/gi)];
        for (const m of matches2) results[m[1]] = m[2];
      }
      return results;
    });
    if (Object.keys(jsPlayerData).length > 0) {
      console.log(`  Found ${Object.keys(jsPlayerData).length} mappings from inline JS`);
      Object.assign(directMappingsAll, jsPlayerData);
    }

    // Fall back to HTML scraping for team/name structure
    const teams = await page.evaluate(() => {
      const headers = Array.from(document.querySelectorAll('table.leagueRosterTable th')).map(th => th.textContent.trim());
      return Array.from(document.querySelectorAll('tr[id*="trTeamNameAndRoster"]')).map(row => {
        const link = row.querySelector('a');
        const teamName = link ? link.textContent.trim() : '';
        const names = new Set();
        const directMappings = {};
        Array.from(row.querySelectorAll('td')).forEach((cell, i) => {
          if (i === 0) return;
          Array.from(cell.querySelectorAll('a')).forEach(a => {
            const n = a.textContent.trim();
            if (!n || n.length < 2) return;
            names.add(n);
            const href = a.getAttribute('href') || '';
            // Extract playerID from PlayerProfile.aspx?playerID=XXXX
            const m = href.match(/[?&]playerID=(\d+)/i);
            if (m) directMappings[m[1]] = n;
          });
          // Also check data attributes on cells/rows for player IDs
          Array.from(cell.querySelectorAll('[data-playerid],[data-pid],[id*="player"]')).forEach(el => {
            const pid = el.dataset.playerid || el.dataset.pid || (el.id.match(/\d+/) || [])[0];
            const name = el.textContent.trim();
            if (pid && name && name.length > 2) directMappings[pid] = name;
          });
        });
        return { teamName, names: [...names], directMappings };
      }).filter(t => t.teamName);
    });

    await browser.close();

    // Merge all directMappings into each team result (global mappings apply to all)
    return teams.map(t => ({
      ...t,
      directMappings: { ...directMappingsAll, ...t.directMappings },
    }));
  } catch(e) {
    try { await browser.close(); } catch(_) {}
    console.warn(`scrapeFFPCRostersByLeagueId(${leagueId}) failed:`, e.message);
    return null;
  }
}

// Extract player ID→name mappings from any FFPC API JSON response shape
function extractPlayerMappingsFromFFPCResponse(body, url) {
  const result = {};
  if (!body || typeof body !== 'object') return result;
  function walk(obj, depth) {
    if (depth > 8 || !obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) { obj.forEach(item => walk(item, depth + 1)); return; }
    // Look for objects with a numeric ID and a name field
    const id = obj.playerID ?? obj.PlayerID ?? obj.playerId ?? obj.id ?? obj.ID;
    const name = obj.playerName ?? obj.PlayerName ?? obj.name ?? obj.Name ?? obj.fullName ?? obj.FullName;
    if (id && name && typeof name === 'string' && name.length > 1 && /^\d+$/.test(String(id))) {
      result[String(id)] = name;
    }
    Object.values(obj).forEach(v => walk(v, depth + 1));
  }
  walk(body, 0);
  return result;
}

// Normalize a name the same way the frontend does: strip suffixes, dots, apostrophes
function normPlayerName(n) {
  if (!n) return '';
  return n.toLowerCase()
    .replace(/\b(jr\.?|sr\.?|ii|iii|iv)\b/g, '')
    .replace(/\./g, '').replace(/'/g, '')
    .replace(/\s+/g, ' ').trim();
}

async function expandPlayerMapFromLeagues(dnLeagues) {
  if (expandInProgress || !puppeteer) return;
  const leaguesToProcess = (dnLeagues || []).filter(league => {
    if (!league.extId) return false;
    return (league.teams || []).some(team =>
      [...(team.starters||[]), ...(team.bench||[])].some(id => !ffpcPlayerMap[String(id)])
    );
  });
  if (leaguesToProcess.length === 0) return;
  expandInProgress = true;
  let newMappings = 0;

  // Build extId -> ltuid lookup from config
  const config = loadFFPCConfig();
  const extIdToLtuid = {};
  for (const l of (config && config.leagues) || []) {
    if (l.id && l.ltuid) extIdToLtuid[String(l.id)] = l.ltuid;
  }

  try {
    const normTeamKey = n => n.toLowerCase().replace(/[^a-z0-9]/g, '');

    // Scrape FFPC rosters for all leagues first
    const leagueFFPCData = {};  // extId -> { normTeamKey -> { normName -> origName } }
    for (const dnLeague of leaguesToProcess) {
      const ffpcLeagueId = dnLeague.extId;
      const ltuid = extIdToLtuid[String(ffpcLeagueId)] || ffpcLeagueId;
      console.log(`PlayerMap expand: scraping league ${ffpcLeagueId} ltuid=${ltuid} (${dnLeague.name})`);
      const ffpcTeams = await scrapeFFPCRostersByLeagueId(ltuid);
      if (!ffpcTeams || ffpcTeams.length === 0) continue;
      const lookup = {};
      for (const t of ffpcTeams) {
        const nameMap = {};
        for (const n of t.names) nameMap[normPlayerName(n)] = n;
        lookup[normTeamKey(t.teamName)] = nameMap;
      }
      leagueFFPCData[ffpcLeagueId] = lookup;
    }

    // Build id -> candidate set (intersection of unclaimed FFPC names across all teams this ID appears on)
    // and origName lookup across all leagues
    const idCandidates = {};  // id -> Set of norm names
    const origNameLookup = {};  // normName -> origName

    for (const dnLeague of leaguesToProcess) {
      const ffpcLookup = leagueFFPCData[dnLeague.extId];
      if (!ffpcLookup) continue;

      for (const dnTeam of dnLeague.teams || []) {
        const allIds = [...(dnTeam.starters||[]), ...(dnTeam.bench||[]), ...(dnTeam.taxi||[]), ...(dnTeam.ir||[])]
          .filter(id => typeof id === 'number');
        const ffpcTeamNames = ffpcLookup[normTeamKey(dnTeam.name)];
        if (!ffpcTeamNames) continue;

        // Collect origName lookups
        for (const [norm, orig] of Object.entries(ffpcTeamNames)) origNameLookup[norm] = orig;

        // Names claimed by already-mapped IDs on this team
        const claimed = new Set();
        for (const id of allIds) {
          const known = ffpcPlayerMap[String(id)];
          if (known) claimed.add(normPlayerName(known));
        }

        const unclaimedNorms = new Set(
          Object.keys(ffpcTeamNames).filter(norm => !claimed.has(norm))
        );

        for (const id of allIds) {
          if (ffpcPlayerMap[String(id)]) continue;
          if (!idCandidates[id]) {
            idCandidates[id] = new Set(unclaimedNorms);
          } else {
            // Intersect: keep only norms present in this team's unclaimed set
            for (const n of idCandidates[id]) {
              if (!unclaimedNorms.has(n)) idCandidates[id].delete(n);
            }
          }
        }
      }
    }

    // Iterative resolution: when a candidate set has exactly 1 entry, map it
    let changed = true;
    while (changed) {
      changed = false;
      for (const [id, candidates] of Object.entries(idCandidates)) {
        if (ffpcPlayerMap[String(id)] || candidates.size !== 1) continue;
        const normName = [...candidates][0];
        const origName = origNameLookup[normName];
        if (!origName) continue;
        ffpcPlayerMap[String(id)] = origName;
        newMappings++;
        changed = true;
        console.log(`  Mapped ${id} -> "${origName}"`);
        for (const [otherId, otherCandidates] of Object.entries(idCandidates)) {
          if (otherId !== String(id)) otherCandidates.delete(normName);
        }
      }
    }

    // Second pass: filter candidates to only KTC-known players, then re-resolve
    if (cachedData) {
      const ktcNorms = new Set(cachedData.map(p => p.name ? normPlayerName(p.name) : '').filter(Boolean));
      changed = true;
      while (changed) {
        changed = false;
        for (const [id, candidates] of Object.entries(idCandidates)) {
          if (ffpcPlayerMap[String(id)]) continue;
          const ktcFiltered = new Set([...candidates].filter(n => ktcNorms.has(n)));
          // Only narrow if KTC filter reduces candidates without eliminating all of them
          if (ktcFiltered.size > 0 && ktcFiltered.size < candidates.size) {
            idCandidates[id] = ktcFiltered;
            changed = true;
          }
          if (idCandidates[id].size === 1) {
            const normName = [...idCandidates[id]][0];
            const origName = origNameLookup[normName];
            if (origName) {
              ffpcPlayerMap[String(id)] = origName;
              newMappings++;
              changed = true;
              console.log(`  Mapped ${id} -> "${origName}" (KTC filter)`);
              for (const [otherId, otherCandidates] of Object.entries(idCandidates)) {
                if (otherId !== String(id)) otherCandidates.delete(normName);
              }
            }
          }
        }
      }
    }

    // Log any still-unresolved IDs for debugging
    const unresolved = Object.entries(idCandidates).filter(([id, c]) => !ffpcPlayerMap[String(id)] && c.size > 0);
    if (unresolved.length > 0) {
      console.log(`PlayerMap: ${unresolved.length} IDs still ambiguous (need more leagues or manual mapping):`);
      for (const [id, c] of unresolved) console.log(`  ID ${id}: candidates = ${[...c].join(', ')}`);
    }

    if (newMappings > 0) {
      fs.writeFileSync(FFPC_PLAYER_MAP_FILE, JSON.stringify(ffpcPlayerMap, null, 2));
      console.log(`PlayerMap expanded: +${newMappings} new mappings (total: ${Object.keys(ffpcPlayerMap).length})`);
    }
  } finally {
    expandInProgress = false;
  }
}


// ── DN JWT Auto-Refresh ───────────────────────────────────────────────────────
// Reads JWT from Edge's localStorage LevelDB via dn-jwt-from-edge.js.
// Called automatically before any DN lookup when JWT is 25+ days old.
let dnJwtRefreshInProgress = false;

async function getDNJwt(config) {
  const existing = config && config.dynJwt;
  const updatedAt = config && config.dynJwtUpdatedAt ? new Date(config.dynJwtUpdatedAt).getTime() : 0;
  const ageDays = (Date.now() - updatedAt) / (1000 * 60 * 60 * 24);

  if (existing && ageDays < 25) return existing;

  if (existing) console.log(`DN JWT: ${Math.round(ageDays)} days old — refreshing from Edge...`);
  else console.log('DN JWT: none found — reading from Edge...');

  if (dnJwtRefreshInProgress) {
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 1000));
      if (!dnJwtRefreshInProgress) break;
    }
    return loadFFPCConfig()?.dynJwt || existing;
  }

  dnJwtRefreshInProgress = true;
  const scriptPath = path.join(__dirname, 'dn-jwt-from-edge.js');

  if (!fs.existsSync(scriptPath)) {
    dnJwtRefreshInProgress = false;
    console.warn('dn-jwt-from-edge.js not found — using existing JWT');
    if (existing) return existing;
    throw new Error('dynJwt missing and dn-jwt-from-edge.js not found in dynasty-calc');
  }

  return new Promise((resolve, reject) => {
    execFile('node', [scriptPath], { timeout: 30000 }, (err, stdout, stderr) => {
      dnJwtRefreshInProgress = false;
      if (stdout) console.log('DN JWT refresh:', stdout.trim());
      if (err) {
        console.warn('DN JWT refresh failed:', err.message);
        if (existing) { resolve(existing); return; }
        reject(new Error('DN JWT refresh failed: ' + err.message));
        return;
      }
      const fresh = loadFFPCConfig();
      resolve(fresh?.dynJwt || existing);
    });
  });
}

async function dynastyNerdsLookup(email) {
  const config = loadFFPCConfig();
  const jwt = await getDNJwt(config);
  if (!jwt) throw new Error('dynJwt missing — ensure dn-jwt-from-edge.js is in dynasty-calc and run: npm install level');

  return new Promise((resolve, reject) => {
    console.log(`DN lookup: ${email}`);
    const payload = JSON.stringify({ type: 'FFPC', username: email, password: '' });
    const options = {
      hostname: 'gm3.dynastynerds.com',
      path: '/api/gm/add-account',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'Accept': 'application/json',
        'dyn_jwt': jwt,
        'Origin': 'https://app.dynastynerds.com',
        'Referer': 'https://app.dynastynerds.com/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
      },
      timeout: 20000,
    };
    const reqHttp = https.request(options, (r) => {
      let data = '';
      console.log(`  DN status: ${r.statusCode}`);
      r.on('data', chunk => data += chunk);
      r.on('end', () => {
        console.log(`  DN response length: ${data.length}`);
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error(`DN parse failed: ${data.slice(0,300)}`)); }
      });
    });
    reqHttp.on('timeout', () => { reqHttp.destroy(); reject(new Error('DN request timed out')); });
    reqHttp.on('error', reject);
    reqHttp.write(payload);
    reqHttp.end();
  });
}


// Add /trust endpoint — serves mobileconfig cert profile for iOS trust install
const _origHandler = requestHandler;
const finalHandler = async (req, res) => {
  const url = req.url.split('?')[0];
  if (req.method === 'GET' && url === '/trust') {
    const profilePath = path.join(__dirname, 'dynasty-cert.mobileconfig');
    if (fs.existsSync(profilePath)) {
      res.writeHead(200, {
        'Content-Type': 'application/x-apple-aspen-config',
        'Content-Disposition': 'attachment; filename="dynasty-tools.mobileconfig"',
        'Access-Control-Allow-Origin': '*',
      });
      fs.createReadStream(profilePath).pipe(res);
    } else {
      res.writeHead(404); res.end('Cert profile not found');
    }
    return;
  }
  return _origHandler(req, res);
};

// ── Startup: fill any missed history snapshots + start daily scheduler ────────
if (cachedData && cachedData.length) {
  fillMissedSnapshots(cachedData);
}
// Auto-snapshot team values on boot if we have both KTC + FFPC data
if (cachedData && cachedData.length && Object.keys(ffpcCache).length) {
  snapshotTeamValues(todayStr());
}
scheduleDailySnapshot();

const server = tlsOptions
  ? https.createServer(tlsOptions, finalHandler)
  : http.createServer(finalHandler);

const protocol = tlsOptions ? 'https' : 'http';
server.listen(3001, () => {
  console.log(`Proxy on ${protocol}://localhost:3001`);
  console.log('  KTC dynasty:  GET /ktc, POST /scrape, GET /scrape-status');
  console.log('  KTC redraft:  GET /ktc-redraft, POST /scrape-redraft, GET /scrape-redraft-status');
  console.log('  KTC history:  GET /ktc-history, POST /ktc-history/snapshot, POST /ktc-history/backfill');
  console.log('  Team history: GET /team-history, POST /team-history/snapshot');
  console.log('  Player stats: GET /player-stats');
  console.log('  FFPC: GET /ffpc, POST /ffpc/:leagueId, GET /ffpc/:leagueId');
  console.log('  Scout: GET /scout-lookup?email=...');
});
