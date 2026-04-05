#!/usr/bin/env node
// ktc-history-post.js — tests POST to /histories and intercepts lazy history loads
// Run: node ktc-history-post.js

const puppeteer = require('puppeteer');
const https = require('https');
const fs = require('fs');
const path = require('path');

const cache = JSON.parse(fs.readFileSync(path.join(__dirname, 'ktc-cache.json'), 'utf8'));
const players = cache.data || [];
const joshAllen = players.find(p => p.name === 'Josh Allen');
const slug = 'josh-allen-365';
const playerUrl = `https://keeptradecut.com/dynasty-rankings/players/${slug}`;

function postRequest(path, body, cookieStr = '') {
  return new Promise(resolve => {
    const data = JSON.stringify(body);
    const opts = {
      hostname: 'keeptradecut.com',
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36',
        'Accept': 'application/json, */*',
        'Referer': playerUrl,
        ...(cookieStr ? { 'Cookie': cookieStr } : {}),
      },
      timeout: 10000,
    };
    let raw = '';
    const r = https.request(opts, res => {
      console.log(`  POST ${path} → ${res.statusCode} CT:${res.headers['content-type']}`);
      res.on('data', c => raw += c);
      res.on('end', () => resolve({ status: res.statusCode, body: raw }));
    });
    r.on('error', e => resolve({ error: e.message }));
    r.on('timeout', () => { r.destroy(); resolve({ error: 'timeout' }); });
    r.write(data);
    r.end();
  });
}

(async () => {
  // First: load player page and capture ALL keeptradecut.com requests, 
  // including lazy ones triggered by scrolling/clicking
  console.log('=== Loading player page + scrolling to trigger lazy loads ===');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
  });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36');

  const ktcCalls = [];
  page.on('request', r => {
    const u = r.url();
    if (u.includes('keeptradecut.com') && !u.match(/\.(js|css|png|jpg|gif|ico|woff|svg)/)) {
      ktcCalls.push({ method: r.method(), url: u, postData: r.postData() });
    }
  });

  const ktcResponses = [];
  page.on('response', async r => {
    const u = r.url();
    if (u.includes('keeptradecut.com') && !u.match(/\.(js|css|png|jpg|gif|ico|woff|svg)/)) {
      try {
        const body = await r.text();
        const ct = r.headers()['content-type'] || '';
        ktcResponses.push({ url: u, status: r.status(), ct, len: body.length, body: body.slice(0, 2000) });
      } catch(e) {}
    }
  });

  await page.goto(playerUrl, { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise(r => setTimeout(r, 2000));

  // Scroll through the page to trigger lazy loads
  console.log('Scrolling page...');
  for (let y = 0; y <= 5000; y += 500) {
    await page.evaluate(y => window.scrollTo(0, y), y);
    await new Promise(r => setTimeout(r, 400));
  }
  await new Promise(r => setTimeout(r, 2000));

  // Also try clicking any "Value History" tabs or chart tabs
  const tabs = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('button, [role="tab"], .tab, .nav-item, a'))
      .filter(el => {
        const t = (el.textContent || el.getAttribute('aria-label') || '').toLowerCase();
        return t.includes('history') || t.includes('value') || t.includes('chart') || t.includes('trend');
      })
      .map(el => el.textContent?.trim() || el.getAttribute('aria-label'));
  });
  console.log('Found tabs/buttons:', tabs.slice(0, 10));

  await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('button, [role="tab"], .tab, .nav-item, a'));
    for (const el of els) {
      const t = (el.textContent || '').toLowerCase();
      if (t.includes('history') || t.includes('value') || t.includes('trend')) {
        el.click();
        return true;
      }
    }
    return false;
  });
  await new Promise(r => setTimeout(r, 3000));

  const cookies = await page.cookies();
  const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
  await browser.close();

  console.log('\n=== All KTC requests made (including lazy) ===');
  for (const r of ktcCalls) {
    console.log(`  [${r.method}] ${r.url}`);
    if (r.postData) console.log(`    POST data: ${r.postData.slice(0, 200)}`);
  }

  console.log('\n=== All KTC responses ===');
  for (const r of ktcResponses) {
    if (r.url.includes('histories') || r.url.includes('history') || r.url.includes('value')) {
      console.log(`\n** HISTORY RELATED **`);
    }
    if (r.len > 50 && !r.url.includes('adthrive') && !r.url.includes('logger')) {
      console.log(`\n[${r.status}] ${r.url}`);
      console.log(`  CT: ${r.ct}, len: ${r.len}`);
      console.log(`  Body: ${r.body.slice(0, 300)}`);
    }
  }

  // Now try POST variants with cookies
  console.log('\n\n=== Testing POST to /histories variants ===');

  const postBodies = [
    { path: '/dynasty-rankings/histories', body: { playerID: 365 } },
    { path: '/dynasty-rankings/histories', body: { playerID: '365' } },
    { path: '/dynasty-rankings/histories', body: { slug: 'josh-allen-365' } },
    { path: '/dynasty-rankings/histories', body: { playerIds: [365] } },
    { path: '/dynasty-rankings/histories', body: { id: 365, sf: true } },
    { path: '/dynasty-rankings/histories/365', body: {} },
    { path: '/dynasty-rankings/histories/365', body: { sf: true } },
  ];

  for (const { path, body } of postBodies) {
    const r = await postRequest(path, body, cookieStr);
    if (r.error) {
      console.log(`  ${path} error: ${r.error}`);
    } else if (r.status < 500 || r.body.includes('"date"') || r.body.includes('"value"')) {
      console.log(`\n*** INTERESTING RESPONSE ***`);
      console.log(`  ${path}`);
      console.log(`  Status: ${r.status}`);
      console.log(`  Body: ${r.body.slice(0, 500)}`);
    } else {
      console.log(`  ${path} → ${r.status} (body len: ${r.body.length})`);
    }
  }

  console.log('\nDone.');
})();
