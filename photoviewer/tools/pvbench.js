'use strict';
// Local throughput test: hit /api/thumb or /api/full concurrently, report rps, MB/s, latency percentiles
const http = require('http');
const fs = require('fs');
const path = require('path');

const BASE = process.argv[2] || 'http://100.114.239.18:7788';
const CONC = Number(process.argv[3] || 16);
const DUR = Number(process.argv[4] || 5000);
const MODE = process.argv[5] || 'thumb';

const agent = new http.Agent({ keepAlive: true, maxSockets: CONC });
const THUMB_ROOT = '/home/mc/photoviewer/cache/thumbs';

function collect(dir, limit) {
  const out = [];
  const stack = [dir];
  while (stack.length && out.length < limit) {
    const d = stack.pop();
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name.endsWith('.jpg')) out.push(path.relative(THUMB_ROOT, p).replace(/\.jpg$/, ''));
      if (out.length >= limit) break;
    }
  }
  return out;
}

function get(url) {
  return new Promise((resolve, reject) => {
    const t0 = process.hrtime.bigint();
    const req = http.get(url, { agent }, (res) => {
      let n = 0;
      res.on('data', (c) => { n += c.length; });
      res.on('end', () => {
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        resolve({ ms, bytes: n, status: res.statusCode });
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('timeout')));
  });
}

async function main() {
  let ids;
  if (MODE === 'thumb') {
    ids = collect(THUMB_ROOT, 400);
  } else {
    const idx = JSON.parse(fs.readFileSync('/home/mc/photoviewer/cache/index.json', 'utf8'));
    ids = idx.items.filter((r) => r.t === 'img' && r.size > 2e6).slice(0, 200).map((r) => r.id);
  }
  if (!ids.length) { console.log('no ids'); return; }

  const ep = MODE === 'thumb' ? 'thumb' : 'full';
  const urls = ids.map((i) => `${BASE}/api/${ep}?id=${encodeURIComponent(i)}`);
  const lat = [];
  let count = 0, bytes = 0, errors = 0;
  const statuses = {};
  const deadline = Date.now() + DUR;

  async function worker(w) {
    let k = w;
    while (Date.now() < deadline) {
      const url = urls[k++ % urls.length];
      try {
        const r = await get(url);
        count++; bytes += r.bytes;
        statuses[r.status] = (statuses[r.status] || 0) + 1;
        if (lat.length < 300000) lat.push(r.ms);
      } catch { errors++; }
    }
  }

  const t0 = Date.now();
  await Promise.all(Array.from({ length: CONC }, (_, i) => worker(i)));
  const secs = (Date.now() - t0) / 1000;

  lat.sort((a, b) => a - b);
  const q = (p) => lat[Math.min(lat.length - 1, Math.floor(lat.length * p))] || 0;
  console.log(JSON.stringify({
    mode: MODE, conc: CONC, secs: +secs.toFixed(2),
    req: count, rps: +(count / secs).toFixed(1),
    mbps: +((bytes / 1048576) / secs).toFixed(2),
    avgKB: +(bytes / Math.max(1, count) / 1024).toFixed(1),
    p50: +q(0.5).toFixed(1), p90: +q(0.9).toFixed(1), p99: +q(0.99).toFixed(1),
    max: +(lat[lat.length - 1] || 0).toFixed(1),
    errors, statuses,
  }));
}

main();
