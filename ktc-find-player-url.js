#!/usr/bin/env node
// ktc-find-player-url.js — finds the correct KTC player page URL format
// and tests loading a player's value history from that page

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

// Load KTC cache to get player IDs/slugs from known working data
const cacheFile = path.join(__dirname, 'ktc-cache.json');
let players = [];
try {
  const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  players = raw.data || [];
  console.log(`Loaded ${players.length} players from ktc-cache.json`);
} catch(e) {
  console.error('Could not load ktc-cache.json:', e.message);
  process.exit(1);
}

// Show first 5 players with their IDs so we can see the format
console.log('\nSample player data from cache:');
players.slice(0, 5).forEach(p => {
  console.log(JSON.stringify({ name: p.name, id: p.id, position: p.position, value: p.value }));
});

// Find Josh Allen specifically
const joshAllen = players.find(p => p.name === 'Josh Allen');
if (joshAllen) {
  console.log('\nJosh Allen full record:', JSON.stringify(joshAllen));
}

// Try multiple URL patterns with the actual ID
const testPlayer = joshAllen || players[0];
const id = testPlayer.id;
const name = testPlayer.name;
const slug = name.toLowerCase().replace(/[^a-z0-9\s-]/g,'').replace(/\s+/g,'-');

const urlsToTest = [
  `https://keeptradecut.com/dynasty-rankings/players/${id}`,
  `https://keeptradecut.com/dynasty-rankings/players/${id}/${slug}`,
  `https://keeptradecut.com/dynasty-rankings/players/${id}-${slug}`,
  `https://keeptradecut.com/player/${id}`,
  `https://keeptradecut.com/player/${id}/${slug}`,
];

console.log(`\nTesting URLs for ${name} (id: ${id}, slug: ${slug}):`);

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
  });

  for (const url of urlsToTest) {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

    const jsonHits = [];
    page.on('response', async r => {
      const ct = r.headers()['content-type'] || '';
      if (ct.includes('json') && !r.url().match(/google|gtm|cloudflare|analytics/i)) {
        try {
          const body = await r.text();
          if (body.includes('value') || body.includes('date')) {
            jsonHits.push({ url: r.url(), status: r.status(), snippet: body.slice(0, 400) });
          }
        } catch(e) {}
      }
    });

    try {
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      const status = resp ? resp.status() : '?';
      const title = await page.title();
      await new Promise(r => setTimeout(r, 1500));

      const hasValueData = await page.evaluate(() => {
        const nd = document.getElementById('__NEXT_DATA__');
        if (nd) {
          const s = nd.textContent;
          return s.includes('superflexValues') || s.includes('"value"') ? 'HAS_DATA' : 'NO_VALUE_DATA';
        }
        return 'NO_NEXT_DATA';
      });

      console.log(`\n${url}`);
      console.log(`  HTTP ${status} | "${title}" | ${hasValueData}`);
      if (jsonHits.length) {
        console.log(`  JSON responses: ${jsonHits.length}`);
        jsonHits.forEach(h => console.log(`    [${h.status}] ${h.url}\n    ${h.snippet.slice(0,200)}`));
      }
    } catch(e) {
      console.log(`\n${url}\n  ERROR: ${e.message}`);
    }
    await page.close();
  }

  // Also load the main dynasty rankings page and find any player detail link
  console.log('\n\nChecking dynasty rankings page for player URL format...');
  const page2 = await browser.newPage();
  await page2.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
  
  const apiCalls = [];
  page2.on('request', r => {
    const u = r.url();
    if (!u.match(/\.(js|css|png|jpg|gif|ico|woff|svg)(\?|$)/) && !u.match(/google|gtm|cloudflare|analytics/i)) {
      apiCalls.push(u);
    }
  });

  await page2.goto('https://keeptradecut.com/dynasty-rankings', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await new Promise(r => setTimeout(r, 2000));

  // Find any player links
  const playerLinks = await page2.evaluate(() => {
    return Array.from(document.querySelectorAll('a[href*="player"]'))
      .map(a => a.href)
      .filter((v, i, a) => a.indexOf(v) === i)
      .slice(0, 10);
  });

  console.log('Player links found on rankings page:');
  playerLinks.forEach(l => console.log(' ', l));
  console.log('\nAPI calls on rankings page:');
  apiCalls.slice(0, 20).forEach(u => console.log(' ', u));

  await browser.close();
  console.log('\nDone.');
})();
