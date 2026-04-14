#!/usr/bin/env node
// export-public-data.js
// Exports sanitized static JSON files to public-data/ for public.html to consume.
// Run after any sync: node export-public-data.js
// Called automatically by dynasty-sync.sh.

const fs   = require('fs');
const path = require('path');

const BASE = path.join(__dirname);
const OUT  = path.join(BASE, 'public-data');

if (!fs.existsSync(OUT)) fs.mkdirSync(OUT);

let exported = 0;
let skipped  = 0;

function exportFile(srcName, destName, transform) {
  const src = path.join(BASE, srcName);
  if (!fs.existsSync(src)) {
    console.log(`  SKIP  ${srcName} (not found)`);
    skipped++;
    return;
  }
  try {
    const raw  = fs.readFileSync(src, 'utf8');
    const data = JSON.parse(raw);
    const out  = transform ? transform(data) : data;
    fs.writeFileSync(path.join(OUT, destName), JSON.stringify(out));
    const kb = (fs.statSync(path.join(OUT, destName)).size / 1024).toFixed(1);
    console.log(`  OK    ${destName} (${kb} KB)`);
    exported++;
  } catch(e) {
    console.error(`  ERROR ${srcName}: ${e.message}`);
    skipped++;
  }
}

console.log(`\nExporting public data → ${OUT}\n`);

// KTC dynasty values
exportFile('ktc-cache.json', 'ktc.json');

// KTC redraft values
exportFile('ktc-redraft-cache.json', 'ktc-redraft.json');

// KTC dynasty history
exportFile('ktc-history.json', 'ktc-history.json');

// KTC redraft history
exportFile('ktc-redraft-history.json', 'ktc-redraft-history.json');

// Player stats
exportFile('player-stats.json', 'player-stats.json');

// Team history
exportFile('team-history.json', 'team-history.json');

// FFPC league data — merge all three leagues into one object keyed by leagueId
// Strip email addresses from team records for privacy
exportFile('ffpc-cache.json', 'ffpc.json', (data) => {
  const out = {};
  for (const [leagueId, league] of Object.entries(data)) {
    out[leagueId] = {
      ...league,
      teams: (league.teams || []).map(t => {
        const { email, ...rest } = t;
        return rest;
      }),
    };
  }
  return out;
});

console.log(`\nDone: ${exported} exported, ${skipped} skipped.\n`);
