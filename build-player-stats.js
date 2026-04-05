#!/usr/bin/env node
// build-player-stats.js — builds player-stats.json from Player Profiler game log CSVs
// Usage: node build-player-stats.js
// Reads:  2020AdvancedGamelog.csv … 2025AdvancedGamelog.csv
// Writes: player-stats.json
//
// Output structure:
// {
//   "Patrick Mahomes": {
//     pos: "QB",
//     seasons: {
//       2024: { ppg: 28.4, games: 17, totalPoints: 482.8, snapPct: 99.1 },
//       2023: { ... },
//       ...
//     }
//   }, ...
// }

const fs   = require('fs');
const path = require('path');

const DIR = __dirname;
const OUT = path.join(DIR, 'player-stats.json');

// CSVs and their seasons — 2020 file has different column layout (older format)
const FILES = [
  { file: '2020-Advanced-Gamelog.csv', season: 2020, legacy: true },
  { file: '2021-Advanced-Gamelog.csv', season: 2021, legacy: false },
  { file: '2022-Advanced-Gamelog.csv', season: 2022, legacy: false },
  { file: '2023-Advanced-Gamelog.csv', season: 2023, legacy: false },
  { file: '2024-Advanced-Gamelog.csv', season: 2024, legacy: false },
  { file: '2025-Advanced-Gamelog.csv', season: 2025, legacy: false },
];

const VALID_POS = new Set(['QB', 'RB', 'WR', 'TE']);

// ── CSV parser (handles quoted fields with commas) ────────────────────────────
function parseCSV(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const headers = splitCSVLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = splitCSVLine(line);
    const obj = {};
    headers.forEach((h, j) => { obj[h.replace(/"/g,'')] = (cols[j] || '').replace(/^"|"$/g, ''); });
    rows.push(obj);
  }
  return rows;
}

function splitCSVLine(line) {
  const result = [];
  let current = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuote = !inQuote;
    } else if (ch === ',' && !inQuote) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

function num(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; }

// ── Accumulate stats per player per season ────────────────────────────────────
// playerData[name][season] = { pts: [], snaps: [], snapPct: [], pos }
const playerData = {};

for (const { file, season, legacy } of FILES) {
  const filePath = path.join(DIR, file);
  if (!fs.existsSync(filePath)) {
    console.log(`  Skipping ${file} (not found)`);
    continue;
  }

  const raw = fs.readFileSync(filePath, 'latin1'); // handles cp1252 + utf-8
  const rows = parseCSV(raw);
  console.log(`  ${file}: ${rows.length} rows`);

  for (const row of rows) {
    // Column names differ between legacy (2020) and modern formats
    const name = legacy ? row['name'] : row['name'];
    const pos  = legacy ? row['position'] : row['position'];
    if (!name || !VALID_POS.has(pos)) continue;

    const pts  = legacy ? num(row['fantasy_points']) : num(row['fantasy_points']);
    const snap = legacy ? num(row['snaps'])           : num(row['snaps']);
    const snapPct = legacy ? num(row['snap_share'])   : num(row['snap_share']);
    const week = legacy ? num(row['week'])            : num(row['week']);

    // Skip bye weeks / DNP (0 snaps AND 0 pts typically means DNP/bye)
    if (snap === 0 && pts === 0) continue;

    if (!playerData[name]) playerData[name] = { pos, seasons: {} };
    if (!playerData[name].seasons[season]) {
      playerData[name].seasons[season] = { pts: [], snaps: [], snapPct: [], weeks: [] };
    }

    const s = playerData[name].seasons[season];
    s.pts.push(pts);
    s.snaps.push(snap);
    s.snapPct.push(snapPct);
    s.weeks.push(week);
    // Keep most recent position
    playerData[name].pos = pos;
  }
}

// ── Compute aggregates ────────────────────────────────────────────────────────
const output = {};

for (const [name, data] of Object.entries(playerData)) {
  const seasons = {};
  for (const [yr, s] of Object.entries(data.seasons)) {
    const games = s.pts.length;
    if (games === 0) continue;
    const totalPoints = s.pts.reduce((a, b) => a + b, 0);
    const ppg = totalPoints / games;
    const avgSnap = s.snaps.reduce((a,b) => a+b, 0) / games;
    const avgSnapPct = s.snapPct.reduce((a,b) => a+b, 0) / games;

    // Weekly breakdown (for sparklines)
    const maxWk = Math.max(...s.weeks);
    const byWeek = {};
    s.weeks.forEach((w, i) => { byWeek[w] = +(s.pts[i] || 0).toFixed(2); });

    seasons[yr] = {
      ppg: +ppg.toFixed(2),
      games,
      totalPoints: +totalPoints.toFixed(2),
      avgSnaps: +avgSnap.toFixed(1),
      avgSnapPct: +avgSnapPct.toFixed(1),
      byWeek,
    };
  }
  if (Object.keys(seasons).length === 0) continue;
  output[name] = { pos: data.pos, seasons };
}

fs.writeFileSync(OUT, JSON.stringify(output));
console.log(`\nWrote ${OUT}`);
console.log(`  ${Object.keys(output).length} players with game log data`);
const withMultiSeason = Object.values(output).filter(p => Object.keys(p.seasons).length > 1).length;
console.log(`  ${withMultiSeason} with multi-season data`);
