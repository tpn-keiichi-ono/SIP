#!/usr/bin/env node
// tools/render_frames.mjs — ブラウザを開かずに、ヘッドレス Chromium でフレーム画像と統計を書き出すバッチスクリプト。
//
//   使い方:  node tools/render_frames.mjs [--out out/frames] [--step 5] [--years 1965,1985,2020,2040] [--width 1170]
//   前提:    npm install（playwright が devDependencies に入っています）。
//            ブラウザ本体は `npx playwright install chromium`（環境変数 PLAYWRIGHT_BROWSERS_PATH がある環境ではその場所を使います）。
//
// 出力: <out>/frame_<年>.png、<out>/stats.json、<out>/areas.csv

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith('--') ? [a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true'] : []).filter(Boolean));
const outDir = path.resolve(root, args.out || 'out/frames');
const step = Number(args.step || 5);
const width = Number(args.width || 0);

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const p = path.normalize(decodeURIComponent(req.url.split('?')[0]));
  let file = path.join(root, p === '/' || p === '\\' ? 'index.html' : p);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/index.html`;

let chromium;
try { ({ chromium } = await import('playwright')); }
catch {
  // ローカルに無ければグローバルインストール（npm root -g）を探す
  try {
    const { execSync } = await import('node:child_process');
    const { pathToFileURL } = await import('node:url');
    const g = execSync('npm root -g', { encoding: 'utf8' }).trim();
    ({ chromium } = await import(pathToFileURL(path.join(g, 'playwright', 'index.mjs')).href));
  } catch { console.error('playwright が見つかりません。`npm install` を実行してください。'); server.close(); process.exit(1); }
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on('pageerror', (e) => console.error('[page error]', e.message));
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.error('[console]', m.text()); });
await page.goto(url);
await page.evaluate(() => window.SIP.ready);
if (!(await page.evaluate(() => !!window.SIP.state.timeline))) {
  console.error('初期化に失敗しました:', await page.evaluate(() => document.getElementById('loading').innerText));
  await browser.close(); server.close(); process.exit(1);
}
const stats = await page.evaluate(() => ({ observed: window.SIP.getStats(), projection: window.SIP.getProjection(), W: window.SIP.state.W, H: window.SIP.state.H, mPerPx: window.SIP.state.mPerPx }));

let years;
if (args.years) years = args.years.split(',').map(Number);
else {
  const set = new Set(stats.observed.map(s => s.year));
  const xMax = stats.projection.xMax;
  for (let y = Math.ceil(stats.projection.start / step) * step; y <= xMax; y += step) if (y > stats.projection.start) set.add(y);
  if (stats.projection.disappearYear) set.add(Math.round(stats.projection.disappearYear));
  years = [...set].sort((a, b) => a - b);
}
fs.mkdirSync(outDir, { recursive: true });
const frames = [];
for (const y of years) {
  const info = await page.evaluate((yy) => { window.SIP.setYear(yy); return { frame: window.SIP.getFrame(), png: window.SIP.renderFrame(0, 0) }; }, y);
  const buf = Buffer.from(info.png.split(',')[1], 'base64');
  let file = path.join(outDir, `frame_${String(y).replace('.', '_')}.png`);
  fs.writeFileSync(file, buf);
  frames.push({ year: y, ...info.frame, file: path.relative(root, file) });
  console.log(`${y}\t${info.frame.mode}\t${info.frame.areaHa.toFixed(1)} ha\t${path.relative(root, file)}`);
}
if (width) console.log('（--width は現在無視されます。元画像の解像度で書き出します）');
fs.writeFileSync(path.join(outDir, 'stats.json'), JSON.stringify({ ...stats, frames }, null, 2));
const csv = ['﻿年,区分,緩衝帯_ha,消失_ha', ...frames.map(f => `${f.year},${f.mode},${f.areaHa.toFixed(2)},${f.lostHa.toFixed(2)}`)].join('\n');
fs.writeFileSync(path.join(outDir, 'areas.csv'), csv);
console.log(`\n予測消失年: ${stats.projection.disappearYear ? stats.projection.disappearYear.toFixed(1) : 'なし'}  変化率 ${stats.projection.rateHa.toFixed(2)} ha/年\n出力先: ${outDir}`);
await browser.close();
server.close();
