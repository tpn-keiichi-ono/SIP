#!/usr/bin/env node
// tools/build_single.mjs — JS・CSS・画像・設定をすべて埋め込んだ単一 HTML（dist/forest-buffer-simulator.html）を作る。
// file:// で直接開いても動き、メールなどで 1 ファイルとして配布できる。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const MIME = { '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };
const dataUri = (p) => `data:${MIME[path.extname(p)] || 'application/octet-stream'};base64,${fs.readFileSync(path.join(root, p)).toString('base64')}`;

// 設定: 画像パスを data URI に置き換える
let config = read('data/config.js').replace(/file: '([^']+)'/g, (m, p) => `file: '${dataUri(p)}'`);

// モジュールを 1 つのスクリプトに束ねる（import/export を外す。名前は衝突しない前提）
const order = ['js/morph.js', 'js/classify.js', 'js/timeline.js', 'js/render.js', 'js/chart.js', 'js/main.js'];
const declared = new Map();
let bundle = '';
for (const f of order) {
  let src = read(f);
  src = src.replace(/^import\s[\s\S]*?from\s+'[^']+';\s*$/gm, '');
  src = src.replace(/^export\s+(const|let|function|class)\s/gm, '$1 ');
  for (const m of src.matchAll(/^(?:const|let|function|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    if (declared.has(m[1])) throw new Error(`名前が重複しています: ${m[1]} (${declared.get(m[1])} と ${f})`);
    declared.set(m[1], f);
  }
  bundle += `\n// ===== ${f} =====\n${src}`;
}

// 現地写真: 一覧 JSON とサムネイル・中サイズ画像を data URI で埋め込む
let photosScript = '';
try {
  
} catch {}
const m = config.match(/list: '([^']+photos\.json)'/);
if (m && fs.existsSync(path.join(root, m[1]))) {
  const pj = JSON.parse(fs.readFileSync(path.join(root, m[1]), 'utf8'));
  const dir = pj.dir || path.dirname(m[1]);
  for (const p of pj.photos) {
    const base = p.file.replace(/\.[^.]+$/, '');
    const th = path.join(dir, 'thumbs', base + '.jpg'), md = path.join(dir, 'mid', base + '.jpg');
    if (fs.existsSync(path.join(root, th))) p.thumbData = dataUri(th);
  }
  photosScript = `<script>window.SIP_PHOTOS = ${JSON.stringify(pj)};</script>\n`;
}
let html = read('index.html');
html = html.replace(/<link rel="stylesheet" href="css\/style.css[^"]*">/, `<style>\n${read('css/style.css')}\n</style>`);
html = html.replace(/<script src="data\/config.js[^"]*"><\/script>/, `<script>\n${config}\n</script>\n${photosScript}`);
html = html.replace(/<script type="module" src="js\/main.js[^"]*"><\/script>/, `<script>\n(() => {${bundle}\n})();\n</script>`);
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
const out = path.join(root, 'dist', 'forest-buffer-simulator.html');
fs.writeFileSync(out, html);
console.log(`${path.relative(root, out)} (${(fs.statSync(out).size / 1024 / 1024).toFixed(2)} MB)`);
