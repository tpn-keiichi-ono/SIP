// main.js — UI とデータフローの本体。
// 流れ: 画像読み込み → 特徴量 → 水域マスク → 時期ごとの分類 → 緩衝帯マスク → 補間・予測の前計算 → 描画

import { polygonMask, rleEncode, rleDecode, dilate } from './morph.js';
import { computeFeatures, buildWaterMask, classifyScene, buildBuffer, defaultParams, countMask } from './classify.js';
import { fitTrend, buildIntervals, interpolate, buildProjection } from './timeline.js';
import { composeOverlay, drawPolygon } from './render.js';
import { AreaChart } from './chart.js';

const CFG = window.SIP_CONFIG || { scenes: [] };
const STORAGE_KEY = 'sip-forest-buffer-sim-v1';
const $ = (id) => document.getElementById(id);

const state = {
  W: 0, H: 0, mPerPx: 1, pxAreaHa: 0,
  scenes: [], water: null,
  aoiPoints: [], aoiMask: null, aoiDrawing: false,
  settlement: normalizeSettlement(CFG.settlement),
  houseTool: null, houseShared: false,
  settlePoints: [], settleDrawing: false, settlePolyMask: null,
  exclusion: { polygons: (CFG.exclusion?.polygons || []).map(p => p.map(q => ({ x: q.x, y: q.y }))) }, exclPoints: [], exclDrawing: false, exclMask: null,
  display: { ...CFG.display },
  buffer: { edgeBandM: CFG.buffer?.edgeBandM ?? 0, forestNearM: CFG.buffer?.forestNearM ?? 40, coastAwayM: CFG.buffer?.coastAwayM ?? 60, minForestHa: CFG.buffer?.minForestHa ?? 1, adjacencyM: CFG.buffer?.adjacencyM ?? 12 },
  sim: { ...CFG.simulation },
  samples: normalizeSamples(CFG.samples),
  sampleTool: { mode: null, radius: 10, shared: false, show: false },
  coastBandM: CFG.coastBandM ?? 25,
  selectedId: null,
  year: 0, playing: false, lastTs: 0,
  timeline: null,
  view: { scale: 1, tx: 0, ty: 0 },
  brush: { mode: 0, size: 12, painting: false },
  recording: null,
  photos: [], photoIndex: -1, photoHover: -1,
  photoOffset: { dxM: CFG.photos?.offsetM?.dx ?? 0, dyM: CFG.photos?.offsetM?.dy ?? 0 },
};

// ---------- 現地写真（GPS 付き） ----------
function mercToImage(lat, lon) {
  const g = CFG.georef; if (!g) return null;
  const n = Math.pow(2, g.zoom) * 256;
  const x = (lon + 180) / 360 * n;
  const la = lat * Math.PI / 180;
  const y = (1 - Math.log(Math.tan(la) + 1 / Math.cos(la)) / Math.PI) / 2 * n;
  return { x: x - g.originX, y: y - g.originY };
}
async function loadPhotos() {
  if (window.SIP_PHOTOS) { state.photosRaw = window.SIP_PHOTOS; state.photos = preparePhotos(window.SIP_PHOTOS); return; }
  if (!CFG.photos?.list || !CFG.georef) return;
  try { const res = await fetch(CFG.photos.list); if (!res.ok) throw new Error(res.status); state.photosRaw = await res.json(); state.photos = preparePhotos(state.photosRaw); }
  catch (e) { console.warn('現地写真の一覧を読み込めません', e); }
}
function preparePhotos(data) {
  const dir = data.dir || 'data/photos/mauracho';
  return (data.photos || []).map((p, i) => {
    const q = mercToImage(p.lat, p.lon);
    const base = p.file.replace(/\.[^.]+$/, '');
    const ox = (state.photoOffset.dxM || 0) / state.mPerPx, oy = (state.photoOffset.dyM || 0) / state.mPerPx;
    return { ...p, i, x: q == null ? undefined : q.x + ox, y: q == null ? undefined : q.y + oy, thumb: p.thumbData || `${dir}/thumbs/${base}.jpg`, mid: p.midData || p.thumbData || `${dir}/mid/${base}.jpg`, full: `${dir}/${p.file}` };
  }).filter(p => Number.isFinite(p.x));
}
function drawPhotos(ctx) {
  if (state.display.showPhotos === false || !state.photos.length) return;
  ctx.save();
  // 穏やかな脈動（周期 3 秒、全点同じ位相でゆっくり広がる薄い輪）
  const t = performance.now() / 3000;
  state.photos.forEach((p, k) => {
    const q = toScreen(p.x, p.y); const sel = k === state.photoIndex; const hov = k === state.photoHover; const r = sel || hov ? 9 : 6;
    const ph = t % 1; const ease = ph < 0.5 ? ph * 2 : 2 - ph * 2; // 0→1→0 の緩やかな往復
    ctx.beginPath(); ctx.arc(q.x, q.y, r + 3 + ease * 4, 0, Math.PI * 2);
    ctx.strokeStyle = sel ? `rgba(255,212,0,${0.15 + (1 - ease) * 0.35})` : `rgba(40,120,255,${0.12 + (1 - ease) * 0.28})`; ctx.lineWidth = 1.5; ctx.stroke();
    if (p.dir != null && (sel || hov)) { // 撮影方向の矢印（カーソルを合わせた点と選択中の点だけ）
      const a = (p.dir - 90) * Math.PI / 180, len = r + 12, head = 5;
      const tx = q.x + Math.cos(a) * len, ty = q.y + Math.sin(a) * len;
      const col = sel ? '#ffd400' : '#ffffff';
      ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 2; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(q.x + Math.cos(a) * r, q.y + Math.sin(a) * r); ctx.lineTo(tx, ty); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(tx + Math.cos(a) * head, ty + Math.sin(a) * head);
      ctx.lineTo(tx + Math.cos(a + 2.5) * head, ty + Math.sin(a + 2.5) * head);
      ctx.lineTo(tx + Math.cos(a - 2.5) * head, ty + Math.sin(a - 2.5) * head); ctx.closePath(); ctx.fill();
    }
    drawCameraIcon(ctx, q.x, q.y, r, sel ? '#ffd400' : 'rgba(40,120,255,0.95)');
  });
  ctx.restore();
}
function photoAt(sx, sy) {
  if (state.display.showPhotos === false) return -1;
  let best = -1, bd = 13;
  state.photos.forEach((p, k) => { const q = toScreen(p.x, p.y); const d = Math.hypot(q.x - sx, q.y - sy); if (d < bd) { bd = d; best = k; } });
  return best;
}
function classAt(x, y) {
  const s = lastFrame?.base; if (!s) return '';
  const i = Math.round(y) * state.W + Math.round(x); if (i < 0 || i >= state.W * state.H) return '';
  if (lastFrame.cur[i]) return '森林緩衝帯';
  if (s.settlement && s.settlement[i]) return '住宅地（生活空間）';
  if (s.cls.open[i]) return '田畑（生活空間）';
  if (s.cls.built[i]) return '人工物・裸地';
  if (s.cls.sparse[i]) return '疎林・草地（帯の外）';
  if (s.cls.forest[i]) return '森林（密）';
  if (!s.cls.land[i]) return '水域・海岸';
  return '—';
}
function showPhoto(k) {
  const pop = $('photoPopup');
  if (k < 0 || k >= state.photos.length) { state.photoIndex = -1; pop.hidden = true; requestRender(); return; }
  state.photoIndex = k; const p = state.photos[k]; showPhotoHover(-1);
  $('photoImg').src = p.mid;
  if (!$('lightbox').hidden) openLightbox(k);
  const dirName = p.dir == null ? '' : ['北', '北東', '東', '南東', '南', '南西', '西', '北西'][Math.round(p.dir / 45) % 8];
  $('photoMeta').innerHTML = `<b>${k + 1} / ${state.photos.length}</b> ${esc(p.file)}<br>${esc(p.time || '')}${p.alt != null ? ` ／ 標高 ${p.alt} m` : ''}${p.dir != null ? ` ／ 撮影方向 ${dirName}（${p.dir}°）` : ''}<br>北緯 ${p.lat.toFixed(5)} 東経 ${p.lon.toFixed(5)}<br>この地点の判定（${lastFrame?.base?.year ?? ''} 年）: <b>${esc(classAt(p.x, p.y))}</b>`;
  pop.hidden = false; requestRender();
}
/** カーソルを合わせた写真のサムネイルをその場に表示する。 */
function showPhotoHover(k, sx, sy) {
  const el = $('photoHover');
  if (k < 0 || k === state.photoIndex) { el.hidden = true; return; }
  const p = state.photos[k];
  const img = $('photoHoverImg'); if (img.dataset.k !== String(k)) { img.src = p.thumb; img.dataset.k = String(k); }
  const dirName = p.dir == null ? '' : ['北', '北東', '東', '南東', '南', '南西', '西', '北西'][Math.round(p.dir / 45) % 8];
  $('photoHoverCap').innerHTML = `${p.alt != null ? `標高 ${p.alt} m` : ''}${p.dir != null ? `${p.alt != null ? ' ／ ' : ''}撮影方向 ${dirName}（${p.dir}°）` : ''}<br>この地点の判定（${lastFrame?.base?.year ?? ''} 年）: <b>${esc(classAt(p.x, p.y))}</b>`;
  el.hidden = false;
  const W = viewer.clientWidth, H = viewer.clientHeight, w = el.offsetWidth || 210, h = el.offsetHeight || 190;
  let x = sx + 16, y = sy - h / 2;
  if (x + w > W - 8) x = sx - w - 16; if (y < 8) y = 8; if (y + h > H - 8) y = H - h - 8;
  el.style.left = x + 'px'; el.style.top = y + 'px';
}
function openLightbox(k) {
  const p = state.photos[k]; if (!p) return;
  const lb = $('lightbox'); const img = $('lightboxImg');
  img.src = p.full; img.onerror = () => { img.onerror = null; img.src = p.mid; };
  $('lightboxCap').textContent = `${k + 1} / ${state.photos.length}  ${p.file}  ${p.time || ''}${p.alt != null ? ` ／ 標高 ${p.alt} m` : ''}`;
  lb.hidden = false;
}
function closeLightbox() { $('lightbox').hidden = true; $('lightboxImg').src = ''; }
function applyPhotoOffset(dx, dy, reset) {
  if (reset) state.photoOffset = { dxM: 0, dyM: 0 }; else { state.photoOffset.dxM += dx; state.photoOffset.dyM += dy; }
  const raw = state.photosRaw; if (raw) state.photos = preparePhotos(raw);
  $('photoOffsetVal').textContent = `${state.photoOffset.dxM >= 0 ? '+' : ''}${state.photoOffset.dxM}, ${state.photoOffset.dyM >= 0 ? '+' : ''}${state.photoOffset.dyM} m`;
  save(); requestRender();
}
function setupPhotos() {
  $('phoW').addEventListener('click', () => applyPhotoOffset(-5, 0)); $('phoE').addEventListener('click', () => applyPhotoOffset(5, 0));
  $('phoN').addEventListener('click', () => applyPhotoOffset(0, -5)); $('phoS').addEventListener('click', () => applyPhotoOffset(0, 5));
  $('phoReset').addEventListener('click', () => applyPhotoOffset(0, 0, true));
  applyPhotoOffset(0, 0);
  $('photoImgWrap').addEventListener('click', () => { if (state.photoIndex >= 0) openLightbox(state.photoIndex); });
  $('lightboxClose').addEventListener('click', closeLightbox);
  $('lightbox').addEventListener('click', (e) => { if (e.target === $('lightbox') || e.target === $('lightboxImg')) closeLightbox(); });
  $('lightboxPrev').addEventListener('click', (e) => { e.stopPropagation(); showPhoto((state.photoIndex - 1 + state.photos.length) % state.photos.length); });
  $('lightboxNext').addEventListener('click', (e) => { e.stopPropagation(); showPhoto((state.photoIndex + 1) % state.photos.length); });
  window.addEventListener('keydown', (e) => { if ($('lightbox').hidden) return; if (e.key === 'Escape') closeLightbox(); else if (e.key === 'ArrowRight') $('lightboxNext').click(); else if (e.key === 'ArrowLeft') $('lightboxPrev').click(); });
  bindCheck('showPhotos', () => state.display.showPhotos !== false, (v) => { state.display.showPhotos = v; save(); if (!v) showPhoto(-1); syncLegend(); requestRender(); });
  $('photoClose').addEventListener('click', () => showPhoto(-1));
  $('photoPrev').addEventListener('click', () => showPhoto((state.photoIndex - 1 + state.photos.length) % state.photos.length));
  $('photoNext').addEventListener('click', () => showPhoto((state.photoIndex + 1) % state.photos.length));
  if (!state.photos.length) { $('showPhotos').closest('label').hidden = true; $('photoOffsetRow').hidden = true; }
  syncLegend();
}

// ---------- 教師サンプル ----------
const SAMPLE_COLORS = { forest: '#3ddc84', sparse: '#ff9f1a', open: '#ffd400', built: '#4fd3ff' };
const SAMPLE_LABELS = { forest: '森林', sparse: '疎林・草地', open: '田畑', built: '人工物' };
const SAMPLE_CLASSES = ['forest', 'sparse', 'open', 'built'];
function normalizeSamples(src) {
  const conv = (arr) => (arr || []).map(c => Array.isArray(c) ? { x: c[0], y: c[1], r: c[2] ?? 8 } : { x: c.x, y: c.y, r: c.r ?? 8 }).filter(c => Number.isFinite(c.x) && Number.isFinite(c.y));
  const cls = (o) => ({ forest: conv(o?.forest), sparse: conv(o?.sparse), open: conv(o?.open), built: conv(o?.built) });
  const out = { shared: cls(src?.shared), byScene: {} };
  for (const [id, o] of Object.entries(src?.byScene || {})) out.byScene[id] = cls(o);
  return out;
}
function sceneSamples(id) { if (!state.samples.byScene[id]) state.samples.byScene[id] = { forest: [], sparse: [], open: [], built: [] }; return state.samples.byScene[id]; }
function samplesFor(s) {
  const own = state.samples.byScene[s.id] || {};
  const merged = {};
  for (const c of SAMPLE_CLASSES) merged[c] = [...(state.samples.shared[c] || []), ...(own[c] || [])];
  return merged;
}

function normalizeSettlement(src) {
  const pts = (a) => (a || []).map(q => ({ x: q.x, y: q.y }));
  const by = {};
  for (const [id, a] of Object.entries(src?.housesByScene || {})) by[id] = pts(a);
  return { autoM: src?.autoM ?? 0, houseRadiusM: src?.houseRadiusM ?? 20, houses: pts(src?.houses), housesByScene: by, polygons: (src?.polygons || []).map(p => pts(p)) };
}
function housesFor(s) { return [...state.settlement.houses, ...(state.settlement.housesByScene[s.id] || [])]; }

// ---------- 永続化 ----------
function loadSaved() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch { return null; }
}
function serialize() {
  return {
    version: 1,
    settingsVersion: CFG.settingsVersion || 0,
    scale: CFG.scale,
    scenes: state.scenes.filter(s => s.file).map(s => ({
      id: s.id, file: s.file, year: s.year, label: s.label, estimated: !!s.estimated, params: s.params,
      correction: s.correction ? rleEncode(s.correction) : null,
    })),
    display: state.display, buffer: { edgeBandM: state.buffer.edgeBandM, forestNearM: state.buffer.forestNearM, coastAwayM: state.buffer.coastAwayM, minForestHa: state.buffer.minForestHa, adjacencyM: state.buffer.adjacencyM, aoi: state.aoiPoints }, sim: state.sim,
    samples: state.samples, coastBandM: state.coastBandM, settlement: state.settlement, exclusion: state.exclusion, photoOffset: state.photoOffset,
  };
}
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(serialize())); } catch (e) { console.warn('保存に失敗', e); } }, 300);
}
function applySaved(saved) {
  if (!saved) return;
  // 既定パラメータの版が変わっていたら、保存済みのパラメータ類は捨てて既定値を使う（利用者の描いた要素は残す）
  if ((saved.settingsVersion || 0) !== (CFG.settingsVersion || 0)) {
    delete saved.display; delete saved.buffer; delete saved.sim; delete saved.coastBandM;
    if (saved.scenes) for (const ss of saved.scenes) { delete ss.params; delete ss.year; delete ss.label; delete ss.estimated; }
    if (saved.settlement) { delete saved.settlement.autoM; delete saved.settlement.houseRadiusM; }
    state.settingsMigrated = true;
  }
  if (saved.display) Object.assign(state.display, saved.display);
  if (saved.buffer) { state.buffer.edgeBandM = saved.buffer.edgeBandM ?? state.buffer.edgeBandM; state.buffer.forestNearM = saved.buffer.forestNearM ?? state.buffer.forestNearM; state.buffer.coastAwayM = saved.buffer.coastAwayM ?? state.buffer.coastAwayM; state.buffer.minForestHa = saved.buffer.minForestHa ?? state.buffer.minForestHa; state.buffer.adjacencyM = saved.buffer.adjacencyM ?? state.buffer.adjacencyM; state.aoiPoints = saved.buffer.aoi || []; }
  if (saved.sim) Object.assign(state.sim, saved.sim);
  if (saved.samples) state.samples = normalizeSamples(saved.samples);
  if (saved.coastBandM != null) state.coastBandM = saved.coastBandM;
  if (saved.photoOffset) state.photoOffset = { dxM: +saved.photoOffset.dxM || 0, dyM: +saved.photoOffset.dyM || 0 };
  if (saved.exclusion) state.exclusion = { polygons: (saved.exclusion.polygons || []).map(p => p.map(q => ({ x: q.x, y: q.y }))) };
  if (saved.settlement) state.settlement = normalizeSettlement({ ...state.settlement, ...saved.settlement, housesByScene: saved.settlement.housesByScene || state.settlement.housesByScene });
  if (saved.scenes) {
    for (const ss of saved.scenes) {
      const s = state.scenes.find(x => x.id === ss.id);
      if (!s) continue;
      if (ss.year != null) s.year = ss.year;
      if (ss.label != null) s.label = ss.label;
      if (ss.estimated != null) s.estimated = ss.estimated;
      if (ss.params) s.params = { ...ss.params };
      if (ss.correction) s._pendingCorrection = ss.correction;
    }
  }
}

// ---------- 画像読み込み ----------
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('画像を読み込めません: ' + src));
    img.src = src;
  });
}
function rasterize(img, W, H) {
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, W, H);
  let rgba;
  try { rgba = ctx.getImageData(0, 0, W, H).data; }
  catch (e) { throw new Error('画像の画素を読めません。file:// ではなく http サーバー経由で開いてください（README 参照）。'); }
  return { canvas: c, rgba };
}
async function prepareScene(s, img) {
  const { canvas, rgba } = rasterize(img, state.W, state.H);
  s.canvas = canvas; s.rgba = rgba;
  s.feat = computeFeatures(rgba, state.W, state.H);
  if (s._pendingCorrection) { s.correction = rleDecode(s._pendingCorrection, Int8Array, state.W * state.H); delete s._pendingCorrection; }
}

// ---------- 計算 ----------
function computeWater() {
  const refIds = CFG.waterReference || [];
  let refs = state.scenes.filter(s => refIds.includes(s.id) && s.rgba);
  if (!refs.length) refs = state.scenes.filter(s => s.rgba && !s.feat.grayscale);
  state.water = refs.length ? buildWaterMask(refs.map(s => s.feat), state.W, state.H, { grow: Math.round((state.coastBandM || 0) / state.mPerPx) }) : null;
}
function recomputeScene(s) {
  s.cls = classifyScene(s.feat, state.W, state.H, s.params, state.water, samplesFor(s));
  recomputeBuffer(s);
}
function recomputeBuffer(s) {
  const bandPx = state.buffer.edgeBandM > 0 ? state.buffer.edgeBandM / state.mPerPx : 0;
  s.settlement = settlementMask(s);
  const r = buildBuffer(s.cls, state.W, state.H, { aoi: state.aoiMask, correction: s.correction, bandPx, human: s.settlement, forestNearPx: (state.buffer.forestNearM || 0) / state.mPerPx, coastAwayPx: (state.buffer.coastAwayM || 0) / state.mPerPx, water: state.water, minForestRegionPx: (state.buffer.minForestHa ?? 1) * 10000 / (state.mPerPx * state.mPerPx), adjacencyPx: (state.buffer.adjacencyM ?? 12) / state.mPerPx, exclude: exclusionMask() });
  s.buffer = r.buffer; s.band = r.band; s.human = r.human;
  s.stats = {
    settlement: countMask(s.settlement, state.aoiMask) * state.pxAreaHa,
    field: countMask(s.cls.open, state.aoiMask) * state.pxAreaHa,
    sparse: countMask(s.cls.sparse, state.aoiMask) * state.pxAreaHa,
    land: countMask(s.cls.land, state.aoiMask) * state.pxAreaHa,
    buffer: countMask(s.buffer) * state.pxAreaHa,
    forest: countMask(s.cls.forest, state.aoiMask) * state.pxAreaHa,
    built: countMask(s.cls.built, state.aoiMask) * state.pxAreaHa,
  };
}
/** 棚田跡などの除外範囲マスク（全時期共通）。 */
function exclusionMask() {
  if (!state.exclusion.polygons.length) return null;
  if (!state.exclMask) {
    const n = state.W * state.H; state.exclMask = new Uint8Array(n);
    for (const poly of state.exclusion.polygons) { const m = polygonMask(poly, state.W, state.H); for (let i = 0; i < n; i++) if (m[i]) state.exclMask[i] = 1; }
  }
  return state.exclMask;
}
/** 生活空間マスク = 描いた多角形 ∪ 人工物の周囲 autoM (m)。 */
function settlementMask(s) {
  const n = state.W * state.H;
  if (!state.settlePolyMask) {
    state.settlePolyMask = new Uint8Array(n);
    for (const poly of state.settlement.polygons) { const m = polygonMask(poly, state.W, state.H); for (let i = 0; i < n; i++) if (m[i]) state.settlePolyMask[i] = 1; }
  }
  const out = Uint8Array.from(state.settlePolyMask);
  const hr = (state.settlement.houseRadiusM || 0) / state.mPerPx;
  for (const h of housesFor(s)) {
    const x0 = Math.max(0, Math.floor(h.x - hr)), x1 = Math.min(state.W - 1, Math.ceil(h.x + hr)), y0 = Math.max(0, Math.floor(h.y - hr)), y1 = Math.min(state.H - 1, Math.ceil(h.y + hr));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if ((x - h.x) ** 2 + (y - h.y) ** 2 <= hr * hr) out[y * state.W + x] = 1;
  }
  const r = Math.round((state.settlement.autoM || 0) / state.mPerPx);
  if (r > 0 && s.cls?.built) { const d = dilate(s.cls.built, state.W, state.H, r); for (let i = 0; i < n; i++) if (d[i] && s.cls.land[i]) out[i] = 1; }
  return out;
}
function sortedScenes() { return state.scenes.filter(s => s.buffer).slice().sort((a, b) => a.year - b.year); }

function rebuildTimeline() {
  const scenes = sortedScenes();
  if (!scenes.length) { state.timeline = null; return; }
  const sim = state.sim;
  const jitterPx = (sim.jitterM || 0) / state.mPerPx;
  const intervals = buildIntervals(scenes.map(s => ({ year: s.year, buffer: s.buffer, forest: s.cls.forest })), state.W, state.H, { seed: sim.seed | 0, jitterPx });
  let startIdx = scenes.length - 1;
  if (sim.startId) { const k = scenes.findIndex(s => s.id === sim.startId); if (k >= 0) startIdx = k; }
  const start = scenes[startIdx];
  const pts = scenes.slice(0, startIdx + 1).map(s => ({ x: s.year, y: s.stats.buffer }));
  const trend = fitTrend(pts, sim.model, Number(sim.manualRatePct));
  const initialArea = scenes[0].stats.buffer;
  const thresholdHa = initialArea * (sim.thresholdPct || 0) / 100;
  const projection = buildProjection({ year: start.year, buffer: start.buffer, forest: start.cls.forest, built: start.cls.built }, trend, state.W, state.H, {
    pxAreaHa: state.pxAreaHa, thresholdHa, seed: sim.seed | 0, jitterPx, protectPx: (sim.protectM || 0) / state.mPerPx,
  });
  const xMin = scenes[0].year;
  const lastObs = scenes[scenes.length - 1].year;
  let xMax, note = '';
  if (projection.disappearYear != null && projection.disappearYear > start.year) {
    xMax = Math.max(lastObs, Math.ceil((projection.disappearYear + 2) / 5) * 5);
  } else if (projection.disappearYear != null) { xMax = Math.max(lastObs, start.year + 10); note = '起点の時点で既に消失判定面積を下回っています'; }
  else { xMax = Math.max(lastObs, start.year + 100); note = trend.ok ? '減少傾向ではないため 100 年以内に消失しません' : (trend.note || '傾向線を求められません'); }
  if (xMax - xMin < 10) xMax = xMin + 10;
  state.timeline = { scenes, intervals, start, startIdx, trend, projection, xMin, xMax, thresholdHa, initialArea, note, lastObs };
  if (!Number.isFinite(state.year) || state.year < xMin || state.year > xMax) state.year = xMin;
  updateTimelineUI();
  updateChart();
  updateStats();
  updateSimReadout();
}

/** 年 t のフレーム（マスク・比較対象など）を求める。 */
const frameBuf = { cur: null, lost: null, forest: null };
function computeFrame(t) {
  const tl = state.timeline; if (!tl) return null;
  const n = state.W * state.H;
  if (!frameBuf.cur) { frameBuf.cur = new Uint8Array(n); frameBuf.lost = new Uint8Array(n); frameBuf.forest = new Uint8Array(n); }
  let base, next, frac, mode, compare;
  let compareScene = null;
  if (t > tl.start.year + 1e-9) {
    tl.projection.maskAt(t, frameBuf.cur);
    base = tl.start; next = null; frac = 0; mode = 'pred'; compareScene = tl.start;
  } else {
    const r = interpolate(tl.scenes, tl.intervals, t, frameBuf.cur);
    base = tl.scenes[r.base]; next = tl.scenes[r.next]; frac = r.frac;
    const exact = tl.scenes.find(s => Math.abs(s.year - t) < 1e-6);
    mode = exact ? 'obs' : 'interp';
    if (exact) { base = exact; const k = tl.scenes.indexOf(exact); compareScene = k > 0 ? tl.scenes[k - 1] : null; frac = 0; next = null; }
    else compareScene = base;
  }
  // 消失の基準: 直前の観測時期（prev）／最初の観測時期に固定（first）／指定した観測時期（id）
  const lb = state.display.lostBase || 'all';
  let compareYear = compareScene ? compareScene.year : null;
  if (lb === 'all') {
    // それ以前のすべての観測時期で一度でも緩衝帯だった画素の和集合
    const past = tl.scenes.filter(s => s.year < t - 1e-9);
    if (past.length) {
      const key = past.map(s => s.id).join(',');
      if (!tl.unionCache || tl.unionCache.key !== key) {
        const u = new Uint8Array(n); for (const s of past) for (let i = 0; i < n; i++) if (s.buffer[i]) u[i] = 1;
        tl.unionCache = { key, mask: u };
      }
      compare = tl.unionCache.mask; compareYear = past[0].year; compareScene = null;
    } else { compare = null; compareYear = null; }
  } else {
    if (lb === 'first') compareScene = tl.scenes[0].year < t - 1e-9 ? tl.scenes[0] : null;
    else if (lb !== 'prev') { const s = tl.scenes.find(x => x.id === lb); compareScene = s && s.year < t - 1e-9 ? s : null; }
    compare = compareScene ? compareScene.buffer : null; compareYear = compareScene ? compareScene.year : null;
  }
  const cur = frameBuf.cur, lost = frameBuf.lost, forest = frameBuf.forest;
  const bf = base.cls.forest;
  let lostCount = 0, curCount = 0;
  for (let i = 0; i < n; i++) {
    const l = compare && compare[i] && !cur[i] ? 1 : 0;
    lost[i] = l; if (l) lostCount++;
    if (cur[i]) curCount++;
    forest[i] = bf[i] || l ? 1 : 0;
  }
  return { t, cur, lost, forest, base, next, frac, mode, areaHa: curCount * state.pxAreaHa, lostHa: lostCount * state.pxAreaHa, compareYear, compareAll: lb === 'all' };
}

// ---------- 描画 ----------
const viewer = $('viewer');
const vctx = viewer.getContext('2d');
let overlayCanvas = null, overlayCtx = null, overlayData = null;
let renderQueued = false;
let sceneDirty = true; // 写真＋オーバーレイの再合成が必要か（アイコン層だけの更新では不要）
function requestRender() { sceneDirty = true; if (!renderQueued) { renderQueued = true; requestAnimationFrame(() => { renderQueued = false; render(); }); } }
let sceneCanvas = null, sceneCtx = null;
// カメラアイコンの脈動アニメーション用ループ（写真の点が表示されている間だけ軽い再描画を続ける）
function animLoop() {
  if (state.timeline && state.photos.length && state.display.showPhotos !== false && !document.hidden) render();
  requestAnimationFrame(animLoop);
}

function fitView(rect) {
  const cw = viewer.clientWidth, ch = viewer.clientHeight;
  if (!state.W || !cw) return;
  const r = rect || { x0: 0, y0: 0, x1: state.W, y1: state.H };
  const rw = r.x1 - r.x0, rh = r.y1 - r.y0;
  const scale = Math.min(cw / rw, ch / rh);
  state.view = { scale, tx: (cw - rw * scale) / 2 - r.x0 * scale, ty: (ch - rh * scale) / 2 - r.y0 * scale };
  requestRender();
}
/** 初期表示（設定の initialView があればその範囲、無ければ全体）。 */
function initialView() { fitView(CFG.initialView || null); }
function toScreen(x, y) { const v = state.view; return { x: x * v.scale + v.tx, y: y * v.scale + v.ty }; }
function toImage(sx, sy) { const v = state.view; return { x: (sx - v.tx) / v.scale, y: (sy - v.ty) / v.scale }; }

function drawBase(ctx, frame, W, H) {
  const tl = state.timeline;
  const d = state.display;
  let a = frame.base, b = frame.next, f = frame.frac;
  if (d.fixLatest) { a = tl.scenes[tl.scenes.length - 1]; b = null; }
  if (frame.mode === 'pred') { a = tl.scenes[tl.scenes.length - 1]; b = null; if (!d.fixLatest) { a = frame.base; } }
  ctx.drawImage(a.canvas, 0, 0, W, H);
  if (b && d.crossfade && f > 0) { ctx.globalAlpha = f; ctx.drawImage(b.canvas, 0, 0, W, H); ctx.globalAlpha = 1; }
  else if (b && !d.crossfade && f >= 0.5) ctx.drawImage(b.canvas, 0, 0, W, H);
}

function buildOverlay(frame) {
  if (!overlayCanvas) {
    overlayCanvas = document.createElement('canvas'); overlayCanvas.width = state.W; overlayCanvas.height = state.H;
    overlayCtx = overlayCanvas.getContext('2d'); overlayData = overlayCtx.createImageData(state.W, state.H);
  }
  const d = state.display;
  composeOverlay(overlayData, {
    buffer: frame.cur, lost: frame.lost, forest: frame.forest, built: frame.base.cls.built, water: waterWithCoast(frame.base), aoi: state.aoiMask, settlement: frame.base.settlement, field: frame.base.cls.open, band: frame.base.band, sparse: frame.base.cls.sparse, excl: exclusionMask(),
  }, { opacity: d.opacity, showLost: d.showLost, showForest: d.showForest, showBuilt: d.showBuilt, showWater: d.showWater, showSettlement: d.showSettlement !== false, showField: !!d.showField, showBandLost: !!d.showBandLost, showSparse: !!d.showSparse, showExcl: d.showExcl !== false });
  overlayCtx.putImageData(overlayData, 0, 0);
  return overlayCanvas;
}

let coastCache = { scene: null, mask: null };
function waterWithCoast(scene) {
  if (!state.water) return scene.cls.coast || null;
  if (!scene.cls.coast) return state.water;
  if (coastCache.scene !== scene || coastCache.cls !== scene.cls) {
    const m = new Uint8Array(state.water.length);
    for (let i = 0; i < m.length; i++) m[i] = state.water[i] || scene.cls.coast[i] ? 1 : 0;
    coastCache = { scene, cls: scene.cls, mask: m };
  }
  return coastCache.mask;
}
/** カメラの形のアイコン（本体＋レンズ＋ファインダー）。r は目安の半径（画素）。 */
function drawCameraIcon(ctx, x, y, r, fill) {
  const w = r * 1.9, h = r * 1.4;           // 本体
  const rx = r * 0.3;
  ctx.save();
  ctx.fillStyle = fill; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.roundRect(x - w / 2, y - h / 2, w, h, rx);
  ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.rect(x - w * 0.22, y - h / 2 - r * 0.35, w * 0.44, r * 0.4); ctx.fill(); ctx.stroke(); // ファインダーの出っ張り
  ctx.beginPath(); ctx.arc(x, y + h * 0.05, r * 0.5, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill(); // レンズ（白）
  ctx.beginPath(); ctx.arc(x, y + h * 0.05, r * 0.25, 0, Math.PI * 2); ctx.fillStyle = fill; ctx.fill();
  ctx.restore();
}
/** 家の形のアイコン（屋根＋壁）。s は半幅（画素）。 */
function drawHouseIcon(ctx, x, y, s, fill) {
  ctx.beginPath();
  ctx.moveTo(x - s, y);            // 屋根左端
  ctx.lineTo(x, y - s * 1.1);      // 屋根の頂点
  ctx.lineTo(x + s, y);            // 屋根右端
  ctx.lineTo(x + s * 0.7, y);
  ctx.lineTo(x + s * 0.7, y + s);  // 壁
  ctx.lineTo(x - s * 0.7, y + s);
  ctx.lineTo(x - s * 0.7, y);
  ctx.closePath();
  ctx.fillStyle = fill; ctx.fill(); ctx.lineWidth = 1.2; ctx.strokeStyle = '#333'; ctx.stroke();
  // 扉
  ctx.fillStyle = '#333'; ctx.fillRect(x - s * 0.18, y + s * 0.35, s * 0.36, s * 0.65);
}
function drawHouses(ctx) {
  // 表示中の写真（フレームの基準時期）の住居を描く
  const base = lastFrame?.base || selectedScene(); if (!base) return;
  ctx.save();
  const draw = (list, fill) => { for (const h of list) { const q = toScreen(h.x, h.y); drawHouseIcon(ctx, q.x, q.y, 6, fill); } };
  draw(state.settlement.houses, '#ffffff');
  draw(state.settlement.housesByScene[base.id] || [], '#ffe9a8');
  ctx.restore();
}
function drawSamples(ctx) {
  const s = selectedScene(); if (!s) return;
  ctx.save();
  ctx.lineWidth = 2; ctx.font = '11px system-ui, sans-serif'; ctx.textBaseline = 'bottom';
  const draw = (list, cls, dashed) => {
    for (const c of list) {
      const q = toScreen(c.x, c.y); const r = Math.max(3, c.r * state.view.scale);
      ctx.strokeStyle = SAMPLE_COLORS[cls]; ctx.setLineDash(dashed ? [4, 3] : []);
      ctx.beginPath(); ctx.arc(q.x, q.y, r, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]); ctx.fillStyle = SAMPLE_COLORS[cls]; ctx.beginPath(); ctx.arc(q.x, q.y, 2, 0, Math.PI * 2); ctx.fill();
    }
  };
  for (const cls of SAMPLE_CLASSES) { draw(state.samples.shared[cls] || [], cls, false); draw((state.samples.byScene[s.id] || {})[cls] || [], cls, true); }
  ctx.restore();
}
let lastFrame = null;
function render() {
  const dpr = window.devicePixelRatio || 1;
  const cw = viewer.clientWidth, ch = viewer.clientHeight;
  if (viewer.width !== Math.round(cw * dpr) || viewer.height !== Math.round(ch * dpr)) { viewer.width = Math.round(cw * dpr); viewer.height = Math.round(ch * dpr); }
  vctx.setTransform(1, 0, 0, 1, 0, 0);
  vctx.fillStyle = '#111'; vctx.fillRect(0, 0, viewer.width, viewer.height);
  if (!state.timeline) return;
  const frame = sceneDirty || !lastFrame ? computeFrame(state.year) : lastFrame;
  lastFrame = frame;
  const v = state.view;
  if (!sceneCanvas) { sceneCanvas = document.createElement('canvas'); sceneCanvas.width = state.W; sceneCanvas.height = state.H; sceneCtx = sceneCanvas.getContext('2d'); }
  if (sceneDirty) {
    sceneCtx.setTransform(1, 0, 0, 1, 0, 0);
    drawBase(sceneCtx, frame, state.W, state.H);
    if (state.display.showOverlay !== false) sceneCtx.drawImage(buildOverlay(frame), 0, 0);
    sceneDirty = false;
  }
  vctx.setTransform(dpr * v.scale, 0, 0, dpr * v.scale, dpr * v.tx, dpr * v.ty);
  vctx.imageSmoothingEnabled = true;
  vctx.drawImage(sceneCanvas, 0, 0);
  vctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (state.aoiPoints.length) drawPolygon(vctx, state.aoiPoints, toScreen, { closed: !state.aoiDrawing });
  if (state.display.showSettlement !== false || state.settleDrawing) for (const poly of state.settlement.polygons) drawPolygon(vctx, poly, toScreen, { color: 'rgba(255,255,255,0.9)', vertexRadius: 0, dash: [3, 3] });
  if (state.settlePoints.length) drawPolygon(vctx, state.settlePoints, toScreen, { closed: false, color: '#ffffff' });
  if (state.display.showExcl !== false || state.exclDrawing) for (const poly of state.exclusion.polygons) drawPolygon(vctx, poly, toScreen, { color: 'rgba(120,220,120,0.95)', vertexRadius: 0, dash: [5, 4] });
  if (state.exclPoints.length) drawPolygon(vctx, state.exclPoints, toScreen, { closed: false, color: '#7be07b' });
  if (state.display.showSettlement !== false || state.houseTool) drawHouses(vctx);
  drawPhotos(vctx);
  if (state.sampleTool.mode || state.sampleTool.show) drawSamples(vctx);
  updateHud(frame);
  chart.setCurrentYear(state.year);
  updateSliderThumb();
  const yn = $('yearNow'); if (yn) yn.textContent = `${Math.floor(state.year)} 年`;
}

function updateHud(frame) {
  const tl = state.timeline;
  $('hudYear').textContent = `${Math.floor(frame.t)} 年${frame.t % 1 >= 0.5 ? '（後半）' : ''}`;
  const modeEl = $('hudMode');
  modeEl.classList.toggle('pred', frame.mode === 'pred');
  modeEl.textContent = frame.mode === 'obs' ? `観測: ${frame.base.label || frame.base.id}` : frame.mode === 'interp' ? `補間（${frame.base.year} → ${frame.next?.year} 年）` : `予測（${tl.start.year} 年を起点・${modelName(state.sim.model)}）`;
  const pct = tl.initialArea > 0 ? frame.areaHa / tl.initialArea * 100 : 0;
  let s = `森林緩衝帯 ${frame.areaHa.toFixed(1)} ha（${tl.scenes[0].year} 年比 ${pct.toFixed(0)}%）`;
  if (state.display.showLost && frame.compareYear != null) s += `<br>${frame.compareAll ? `${frame.compareYear} 年以降のいずれかの時期に緩衝帯だった場所の消失` : `${frame.compareYear} 年以降の消失`} ${frame.lostHa.toFixed(1)} ha（紫）`;
  if (tl.projection.disappearYear != null && frame.mode === 'pred') s += `<br>予測消失年 ${tl.projection.disappearYear.toFixed(0)} 年`;
  $('hudStats').innerHTML = s;
}
function modelName(m) { return { linear: '線形', exp: '指数', last: '最終区間', manual: '手動年率' }[m] || m; }

// ---------- タイムライン UI ----------
const chart = new AreaChart($('chart'), $('chartTip'));
chart.onSeek = (y) => { setYear(Math.round(y * 2) / 2); };

function setYear(y) {
  const tl = state.timeline; if (!tl) return;
  state.year = Math.min(tl.xMax, Math.max(tl.xMin, y));
  requestRender();
}
function updateTimelineUI() {
  const tl = state.timeline;
  updateSliderThumb();
  const ticks = $('ticks'); ticks.innerHTML = '';
  // 目盛りとつまみは同じ座標系（左右の余白 = つまみ半径）で配置する
  // 目盛り = 線（.mark）とラベル（.lbl）を別要素にし、線を年の位置に正確に置く
  const setPos = (el, yr) => { el.dataset.year = String(yr); const mk = document.createElement('i'); mk.className = 'mark'; el.prepend(mk); };
  let prevYear = -Infinity; const span = tl.xMax - tl.xMin;
  for (const s of tl.scenes) {
    const el = document.createElement('div'); el.className = 'tick'; setPos(el, s.year);
    prevYear = s.year;
    el.classList.add('obs');
    const lb = document.createElement('span'); lb.className = 'lbl'; lb.textContent = `${s.year}${s.estimated ? '?' : ''}`; el.appendChild(lb); el.title = s.label || s.id;
    el.addEventListener('click', () => setYear(s.year)); ticks.appendChild(el);
  }
  // 軸の右端（予測期間の終わり）
  if (tl.xMax > tl.start.year + 1e-9) {
    const el = document.createElement('div'); el.className = 'tick end'; setPos(el, tl.xMax);
    const lb = document.createElement('span'); lb.className = 'lbl'; lb.textContent = `${Math.round(tl.xMax)} 予測`; el.appendChild(lb); el.title = `${tl.start.year} 年以降は予測期間`;
    el.addEventListener('click', () => setYear(tl.xMax)); ticks.appendChild(el);
  }
  const dy = tl.projection.disappearYear;
  if (dy != null && dy > tl.start.year && dy <= tl.xMax) {
    const el = document.createElement('div'); el.className = 'tick disappear'; setPos(el, dy); const lb = document.createElement('span'); lb.className = 'lbl'; lb.textContent = `消失 ${dy.toFixed(0)}`; el.appendChild(lb);
    el.addEventListener('click', () => setYear(Math.ceil(dy * 2) / 2)); ticks.appendChild(el);
  }
}
/** スライダーの余白（つまみ半径）を px で返す。 */
function sliderHalf() { return parseFloat(getComputedStyle($('yearSlider')).getPropertyValue('--thumb-half')) || 9; }
/** 年 → スライダー内の x 座標（px）。目盛りもつまみもこの関数だけで位置を決める。 */
function yearToPx(yr) {
  const tl = state.timeline; const sl = $('yearSlider'); const w = sl.clientWidth; const half = sliderHalf();
  const f = Math.min(1, Math.max(0, (yr - tl.xMin) / (tl.xMax - tl.xMin)));
  return half + f * (w - 2 * half);
}
function updateSliderThumb() {
  const tl = state.timeline; if (!tl) return;
  const sl = $('yearSlider'); const x = yearToPx(state.year);
  sl.querySelector('.thumb').style.left = x + 'px';
  sl.querySelector('.fill').style.width = Math.max(0, x - sliderHalf()) + 'px';
  const pred = sl.querySelector('.pred'); const px0 = yearToPx(tl.start.year); const px1 = yearToPx(tl.xMax);
  pred.style.left = px0 + 'px'; pred.style.width = Math.max(0, px1 - px0) + 'px'; pred.style.display = px1 - px0 > 1 ? '' : 'none';
  sl.setAttribute('aria-valuemin', tl.xMin); sl.setAttribute('aria-valuemax', tl.xMax); sl.setAttribute('aria-valuenow', state.year);
  const ticks = [...$('ticks').querySelectorAll('.tick')];
  for (const el of ticks) { el.style.left = yearToPx(Number(el.dataset.year)) + 'px'; el.querySelector('.lbl').style.transform = 'translateX(-50%)'; }
  // ラベルが重なるときは、線は動かさずラベルだけを左右に押し分ける（同じ段に揃えたまま）
  const items = ticks.map(el => { const lb = el.querySelector('.lbl'); const x = parseFloat(el.style.left); const w = lb.offsetWidth || 28; return { lb, x, w, cx: x }; }).sort((a, b) => a.x - b.x);
  for (let pass = 0; pass < 4; pass++) for (let k = 0; k + 1 < items.length; k++) {
    const a = items[k], b = items[k + 1]; const gap = 4; const overlap = (a.cx + a.w / 2 + gap) - (b.cx - b.w / 2);
    if (overlap > 0) { a.cx -= overlap / 2; b.cx += overlap / 2; }
  }
  for (const it of items) it.lb.style.transform = `translateX(calc(-50% + ${(it.cx - it.x).toFixed(1)}px))`;
}
function setupSlider() {
  const sl = $('yearSlider');
  const yearFromEvent = (e) => {
    const tl = state.timeline; if (!tl) return null;
    const r = sl.getBoundingClientRect(); const half = parseFloat(getComputedStyle(sl).getPropertyValue('--thumb-half')) || 9;
    const f = Math.min(1, Math.max(0, (e.clientX - r.left - half) / (r.width - 2 * half)));
    return Math.round((tl.xMin + f * (tl.xMax - tl.xMin)) * 2) / 2;
  };
  let dragging = false;
  sl.addEventListener('pointerdown', (e) => { dragging = true; try { sl.setPointerCapture(e.pointerId); } catch {} if (state.playing) togglePlay(false); const y = yearFromEvent(e); if (y != null) setYear(y); });
  sl.addEventListener('pointermove', (e) => { if (!dragging) return; const y = yearFromEvent(e); if (y != null) setYear(y); });
  const up = () => { dragging = false; };
  sl.addEventListener('pointerup', up); sl.addEventListener('pointercancel', up);
  sl.addEventListener('keydown', (e) => { if (e.key === 'ArrowRight') setYear(state.year + (e.shiftKey ? 5 : 0.5)); else if (e.key === 'ArrowLeft') setYear(state.year - (e.shiftKey ? 5 : 0.5)); else return; e.preventDefault(); });
}
function observedAreaAt(t) {
  const sc = state.timeline.scenes;
  if (t <= sc[0].year) return sc[0].stats.buffer;
  for (let k = 0; k + 1 < sc.length; k++) {
    if (t <= sc[k + 1].year) { const f = (t - sc[k].year) / Math.max(1e-9, sc[k + 1].year - sc[k].year); return sc[k].stats.buffer + f * (sc[k + 1].stats.buffer - sc[k].stats.buffer); }
  }
  return sc[sc.length - 1].stats.buffer;
}
function updateChart() {
  const tl = state.timeline;
  chart.setData({
    observed: tl.scenes.map(s => ({ year: s.year, area: s.stats.buffer, label: s.label })),
    projection: tl.trend.ok ? { from: tl.start.year, to: tl.xMax, areaAt: (t) => tl.projection.areaAt(t) } : null,
    thresholdHa: tl.thresholdHa, xMin: tl.xMin, xMax: tl.xMax, currentYear: state.year,
    disappearYear: tl.projection.disappearYear != null && tl.projection.disappearYear > tl.start.year ? tl.projection.disappearYear : null,
    lastObservedYear: tl.start.year,
    areaFn: (t) => (t > tl.start.year ? tl.projection.areaAt(t) : observedAreaAt(t)),
  });
}

// 再生
function tick(ts) {
  if (!state.playing) return;
  const dt = state.lastTs ? (ts - state.lastTs) / 1000 : 0; state.lastTs = ts;
  const speed = Number($('speed').value);
  let y = state.year + dt * speed;
  const tl = state.timeline;
  if (y >= tl.xMax) {
    if (state.recording) { y = tl.xMax; state.year = y; render(); stopRecording(); return; }
    if ($('loop').checked) y = tl.xMin; else { y = tl.xMax; state.year = y; render(); togglePlay(false); return; }
  }
  state.year = y; render();
  requestAnimationFrame(tick);
}
function togglePlay(on) {
  state.playing = on == null ? !state.playing : on;
  $('btnPlay').textContent = state.playing ? '❚❚ 一時停止' : '▶ 再生';
  if (state.playing) { if (state.year >= state.timeline.xMax - 1e-9) state.year = state.timeline.xMin; state.lastTs = 0; requestAnimationFrame(tick); }
}

// ---------- サイドパネル ----------
function bindRange(id, valId, get, set, fmt = (v) => v) {
  const el = $(id), val = $(valId);
  const refresh = () => { el.value = get(); if (val) val.textContent = fmt(Number(el.value)); };
  el.addEventListener('input', () => { set(Number(el.value)); if (val) val.textContent = fmt(Number(el.value)); });
  refresh(); return refresh;
}
function bindCheck(id, get, set) { const el = $(id); el.checked = !!get(); el.addEventListener('change', () => set(el.checked)); }

function setupDisplayPanel() {
  const d = state.display;
  bindRange('opacity', 'opacityVal', () => d.opacity, (v) => { d.opacity = v; save(); requestRender(); }, (v) => v.toFixed(2));
  const lb = $('lostBase');
  const fillLostBase = () => { const cur = d.lostBase || 'all'; lb.innerHTML = '<option value="all">過去のすべての時期（和集合）</option><option value="prev">直前の観測時期</option><option value="first">最初の観測時期</option>' + sortedScenes().map(s => `<option value="${esc(s.id)}">${s.year} 年に固定</option>`).join(''); lb.value = [...lb.options].some(o => o.value === cur) ? cur : 'all'; };
  fillLostBase(); state.refreshLostBase = fillLostBase;
  lb.addEventListener('change', () => { d.lostBase = lb.value; save(); requestRender(); });
  bindCheck('showLost', () => d.showLost, (v) => { d.showLost = v; save(); syncLegend(); requestRender(); });
  bindCheck('showExcl', () => d.showExcl !== false, (v) => { d.showExcl = v; save(); syncLegend(); requestRender(); });
  bindCheck('showSettlement', () => d.showSettlement !== false, (v) => { d.showSettlement = v; save(); syncLegend(); requestRender(); });
  bindCheck('showSparse', () => !!d.showSparse, (v) => { d.showSparse = v; save(); syncLegend(); requestRender(); });
  bindCheck('showField', () => !!d.showField, (v) => { d.showField = v; save(); syncLegend(); requestRender(); });
  bindCheck('showBandLost', () => !!d.showBandLost, (v) => { d.showBandLost = v; save(); syncLegend(); requestRender(); });
  bindCheck('showForest', () => d.showForest, (v) => { d.showForest = v; save(); syncLegend(); requestRender(); });
  bindCheck('showBuilt', () => d.showBuilt, (v) => { d.showBuilt = v; save(); syncLegend(); requestRender(); });
  bindCheck('showWater', () => d.showWater, (v) => { d.showWater = v; save(); syncLegend(); requestRender(); });
  bindCheck('crossfade', () => d.crossfade, (v) => { d.crossfade = v; save(); requestRender(); });
  bindCheck('fixLatest', () => d.fixLatest, (v) => { d.fixLatest = v; save(); requestRender(); });
  bindCheck('showOverlay', () => d.showOverlay !== false, (v) => { d.showOverlay = v; requestRender(); });
  $('btnHome').addEventListener('click', initialView);
  const zoomStep = (f) => { const cw = viewer.clientWidth, ch = viewer.clientHeight; zoomAt(cw / 2, ch / 2, f); };
  $('zoomIn').addEventListener('click', () => zoomStep(1.5));
  $('zoomOut').addEventListener('click', () => zoomStep(1 / 1.5));
  syncLegend();
}
function syncLegend() {
  const d = state.display;
  $('legLost').hidden = !d.showLost; $('legSet').hidden = d.showSettlement === false; $('legField').hidden = !d.showField; $('legSparse').hidden = !d.showSparse; $('legHouse').hidden = d.showSettlement === false; $('legExcl').hidden = d.showExcl === false || !state.exclusion.polygons.length; $('legPhoto').hidden = d.showPhotos === false || !state.photos.length; $('legBandLost').hidden = !d.showBandLost; $('legFor').hidden = !d.showForest; $('legBuilt').hidden = !d.showBuilt; $('legWater').hidden = !d.showWater;
}

function renderSceneTable() {
  const tb = $('sceneRows'); tb.innerHTML = '';
  for (const s of state.scenes.slice().sort((a, b) => a.year - b.year)) {
    const tr = document.createElement('tr'); if (s.id === state.selectedId) tr.className = 'selected';
    tr.innerHTML = `<td><input type="radio" name="sel" ${s.id === state.selectedId ? 'checked' : ''}></td><td>${esc(s.id)}</td><td><input type="number" class="yr" value="${s.year}" step="1"></td><td><input type="text" class="lb" value="${esc(s.label || '')}"></td><td><button class="del" title="この時期を除外">×</button></td>`;
    tr.querySelector('input[type=radio]').addEventListener('change', () => { state.selectedId = s.id; renderSceneTable(); refreshParamPanel(); updateSettleInfo(); });
    tr.querySelector('.yr').addEventListener('change', (e) => { const y = Number(e.target.value); if (Number.isFinite(y)) { s.year = y; s.estimated = false; save(); afterScenesChanged(); } });
    tr.querySelector('.lb').addEventListener('change', (e) => { s.label = e.target.value; save(); rebuildTimeline(); requestRender(); });
    tr.querySelector('.del').addEventListener('click', () => {
      if (state.scenes.length <= 1) return alert('最後の 1 時期は削除できません');
      if (!confirm(`${s.year} 年（${s.label || s.id}）を除外しますか？`)) return;
      state.scenes = state.scenes.filter(x => x !== s);
      if (state.selectedId === s.id) state.selectedId = state.scenes[0].id;
      save(); afterScenesChanged(); renderSceneTable(); refreshParamPanel();
    });
    tb.appendChild(tr);
  }
  const est = state.scenes.filter(s => s.estimated);
  $('yearNote').innerHTML = est.length ? `<span class="warn">※ 「?」付きの撮影年は画像の見た目からの推定値です（${est.map(s => s.id).join(', ')}）。実際の撮影年に修正してください。</span>` : '';
}
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function afterScenesChanged() { rebuildStartOptions(); if (state.refreshLostBase) state.refreshLostBase(); rebuildTimeline(); renderSceneTable(); requestRender(); }

function selectedScene() { return state.scenes.find(s => s.id === state.selectedId) || state.scenes[0]; }
let paramRefreshers = [];
function setupParamPanel() {
  const set = (key) => (v) => { const s = selectedScene(); if (!s) return; s.params = { ...s.params, [key]: v }; save(); scheduleSceneRecompute(s); };
  paramRefreshers = [
    bindRange('pStrict', 'pStrictVal', () => selectedScene()?.cls?.resolved.strictness ?? 4, set('strictness'), (v) => v.toFixed(1)),
    bindRange('pMajority', 'pMajorityVal', () => selectedScene()?.cls?.resolved.majority ?? 2, set('majority'), (v) => (v > 0 ? v.toFixed(0) : 'なし')),
    bindRange('pBias', 'pBiasVal', () => selectedScene()?.cls?.resolved.bias ?? 0, set('bias'), (v) => (v > 0 ? '+' : '') + v.toFixed(2)),
    bindRange('pTex', 'pTexVal', () => selectedScene()?.cls?.resolved.texRadius ?? 2, set('texRadius'), (v) => v.toFixed(0)),
    bindRange('pForest', 'pForestVal', () => selectedScene()?.cls?.resolved.forestMax ?? 100, set('forestMax'), (v) => v.toFixed(0)),
    bindRange('pBuilt', 'pBuiltVal', () => selectedScene()?.cls?.resolved.builtMin ?? 170, set('builtMin'), (v) => (v >= 256 ? 'なし' : v.toFixed(0))),
    bindRange('pChroma', 'pChromaVal', () => selectedScene()?.cls?.resolved.builtChromaMax ?? 24, set('builtChromaMax'), (v) => v.toFixed(0)),
    bindRange('pSmooth', 'pSmoothVal', () => selectedScene()?.cls?.resolved.smooth ?? 3, set('smooth'), (v) => v.toFixed(0)),
    bindRange('pClean', 'pCleanVal', () => selectedScene()?.cls?.resolved.clean ?? 2, set('clean'), (v) => v.toFixed(0)),
    bindRange('pMin', 'pMinVal', () => selectedScene()?.cls?.resolved.minRegionPx ?? 80, set('minRegionPx'), (v) => v.toFixed(0)),
  ];
  const coast = $('pCoast');
  coast.addEventListener('change', () => { const s = selectedScene(); s.params = { ...s.params, coastExclude: coast.checked }; save(); scheduleSceneRecompute(s); });
  paramRefreshers.push(() => { coast.checked = selectedScene()?.cls?.resolved.coastExclude !== false; });
  setupSampleTools();
  $('btnAuto').addEventListener('click', () => { const s = selectedScene(); s.params = { ...s.params, forestMax: null }; save(); recomputeScene(s); rebuildTimeline(); refreshParamPanel(); requestRender(); });
  $('btnParamsReset').addEventListener('click', () => { for (const s of state.scenes) { s.params = {}; recomputeScene(s); } save(); rebuildTimeline(); refreshParamPanel(); requestRender(); });
  $('btnAutoAll').addEventListener('click', () => { for (const s of state.scenes) { s.params = { ...s.params, forestMax: null }; recomputeScene(s); } save(); rebuildTimeline(); refreshParamPanel(); requestRender(); });
}
function refreshParamPanel() {
  const s = selectedScene(); if (!s) return;
  $('paramTarget').innerHTML = `対象: <b>${s.year} 年 ${esc(s.label || s.id)}</b>${s.feat?.grayscale ? '（モノクロ画像）' : ''} ／ 分類方式: ${s.cls?.useGauss ? 'サンプルによる最近傍プロトタイプ判定' : '<span class="warn">輝度しきい値（森林・田畑のサンプルが不足）</span>'}${s.cls && !s.cls.hasSparse ? ' <span class="warn">／ 疎林・草地のサンプルが無いため緩衝帯を判定できません</span>' : ''}`;
  for (const r of paramRefreshers) r();
  const sh = state.samples.shared, own = state.samples.byScene[s.id] || {};
  const fmt = (o) => SAMPLE_CLASSES.map(c => `${SAMPLE_LABELS[c]} ${(o[c] || []).length}`).join('・');
  $('sampleInfo').textContent = `共通サンプル: ${fmt(sh)} ／ この時期のサンプル: ${fmt(own)}`;
  const ov = state.scenes.filter(x => Object.keys(x.params || {}).some(k => x.params[k] != null && !(k === 'forestMax' && x.params[k] === null))).map(x => `${x.year}: ${Object.entries(x.params).filter(([k, v]) => v != null).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  $('overrideInfo').innerHTML = ov.length ? `<span class="warn">時期別に上書きされたパラメータ: ${esc(ov.join(' ／ '))}</span>（年ごとの偏りを避けるには解除して全時期同じ設定にしてください）` : '時期別のパラメータ上書きはありません（全時期同じ判定設定）。';
}
function setupSampleTools() {
  const tools = $('sampleTools');
  tools.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
    const cls = b.dataset.cls;
    state.sampleTool.mode = state.sampleTool.mode === cls ? null : cls;
    tools.querySelectorAll('button').forEach(x => x.classList.toggle('active', x.dataset.cls === state.sampleTool.mode));
    viewer.classList.toggle('drawing', !!state.sampleTool.mode);
    if (state.sampleTool.mode) { if (state.settleDrawing) finishSettle(); state.aoiDrawing = false; $('btnAoi').classList.remove('active'); $('brushMode').value = '0'; state.brush.mode = 0; viewer.classList.remove('brush'); }
    requestRender();
  }));
  bindRange('sampleRadius', 'sampleRadiusVal', () => state.sampleTool.radius, (v) => { state.sampleTool.radius = v; }, (v) => v.toFixed(0));
  bindCheck('sampleShared', () => state.sampleTool.shared, (v) => { state.sampleTool.shared = v; });
  bindCheck('sampleShow', () => state.sampleTool.show, (v) => { state.sampleTool.show = v; requestRender(); });
  $('btnSampleClearScene').addEventListener('click', () => { const s = selectedScene(); if (!confirm(`${s.year} 年のサンプルをすべて削除しますか？`)) return; delete state.samples.byScene[s.id]; save(); recomputeScene(s); rebuildTimeline(); refreshParamPanel(); requestRender(); });
  $('btnSampleClearShared').addEventListener('click', () => { if (!confirm('全時期に共通のサンプルをすべて削除しますか？（各時期は個別サンプルかしきい値ルールで判定されます）')) return; state.samples.shared = { forest: [], sparse: [], open: [], built: [] }; save(); recomputeAllScenes(); });
}
function recomputeAllScenes() { for (const s of state.scenes) recomputeScene(s); rebuildTimeline(); refreshParamPanel(); requestRender(); }
function sampleClick(p) {
  const s = selectedScene(); if (!s) return;
  const mode = state.sampleTool.mode;
  if (Math.abs(state.year - s.year) > 1e-6 && !state.sampleTool.shared) state.year = s.year;
  let touchedShared = false;
  if (mode === 'delete') {
    const lists = [['shared', state.samples.shared], ['own', state.samples.byScene[s.id] || {}]];
    let best = null;
    for (const [kind, o] of lists) for (const cls of SAMPLE_CLASSES) (o[cls] || []).forEach((c, idx) => {
      const d = Math.hypot(c.x - p.x, c.y - p.y); if (d <= Math.max(c.r, 6) && (!best || d < best.d)) best = { d, kind, cls, idx, o };
    });
    if (!best) return;
    best.o[best.cls].splice(best.idx, 1); touchedShared = best.kind === 'shared';
  } else {
    const c = { x: Math.round(p.x), y: Math.round(p.y), r: state.sampleTool.radius };
    if (state.sampleTool.shared) { (state.samples.shared[mode] ||= []).push(c); touchedShared = true; }
    else (sceneSamples(s.id)[mode] ||= []).push(c);
  }
  save();
  if (touchedShared) recomputeAllScenes(); else { recomputeScene(s); rebuildTimeline(); refreshParamPanel(); requestRender(); }
}
let recomputeTimer = null;
function scheduleSceneRecompute(s) {
  clearTimeout(recomputeTimer);
  recomputeTimer = setTimeout(() => { recomputeScene(s); rebuildTimeline(); refreshParamPanel(); requestRender(); }, 120);
}

function setupBufferPanel() {
  bindRange('forestNear', 'forestNearVal', () => state.buffer.forestNearM, (v) => { state.buffer.forestNearM = v; save(); scheduleBufferRecompute(); }, (v) => (v > 0 ? `${v} m` : '条件なし'));
  bindRange('minForest', 'minForestVal', () => state.buffer.minForestHa, (v) => { state.buffer.minForestHa = v; save(); scheduleBufferRecompute(); }, (v) => (v > 0 ? `${v} ha 以上` : '制限なし'));
  bindRange('adjacency', 'adjacencyVal', () => state.buffer.adjacencyM, (v) => { state.buffer.adjacencyM = v; save(); scheduleBufferRecompute(); }, (v) => (v > 0 ? `${v} m 以内で接する塊` : '条件なし（帯の中ならよい）'));
  bindRange('coastAway', 'coastAwayVal', () => state.buffer.coastAwayM, (v) => { state.buffer.coastAwayM = v; save(); scheduleBufferRecompute(); }, (v) => (v > 0 ? `${v} m` : '条件なし'));
  bindRange('edgeBand', 'edgeBandVal', () => state.buffer.edgeBandM, (v) => { state.buffer.edgeBandM = v; save(); scheduleBufferRecompute(); }, (v) => (v > 0 ? `${v} m` : 'なし（疎林・草地すべて）'));
  $('btnAoi').addEventListener('click', () => { state.aoiDrawing = !state.aoiDrawing; if (state.aoiDrawing) { state.aoiPoints = []; state.aoiMask = null; } $('btnAoi').classList.toggle('active', state.aoiDrawing); $('btnAoiDone').hidden = !state.aoiDrawing; viewer.classList.toggle('drawing', state.aoiDrawing); requestRender(); });
  $('btnAoiDone').addEventListener('click', finishAoi);
  bindRange('settleM', 'settleMVal', () => state.settlement.autoM, (v) => { state.settlement.autoM = v; save(); scheduleBufferRecompute(); }, (v) => (v > 0 ? `${v} m` : 'なし'));
  $('btnSettle').addEventListener('click', () => {
    state.settleDrawing = !state.settleDrawing; state.settlePoints = [];
    if (state.settleDrawing && state.aoiDrawing) finishAoi();
    $('btnSettle').classList.toggle('active', state.settleDrawing); $('btnSettleDone').hidden = !state.settleDrawing; viewer.classList.toggle('drawing', state.settleDrawing); requestRender();
  });
  $('btnSettleDone').addEventListener('click', finishSettle);
  $('btnExcl').addEventListener('click', () => {
    state.exclDrawing = !state.exclDrawing; state.exclPoints = [];
    if (state.exclDrawing) { if (state.settleDrawing) finishSettle(); if (state.aoiDrawing) finishAoi(); }
    $('btnExcl').classList.toggle('active', state.exclDrawing); $('btnExclDone').hidden = !state.exclDrawing; viewer.classList.toggle('drawing', state.exclDrawing); requestRender();
  });
  $('btnExclDone').addEventListener('click', finishExcl);
  $('btnExclUndo').addEventListener('click', () => { state.exclusion.polygons.pop(); exclusionChanged(); });
  $('btnExclClear').addEventListener('click', () => { if (!state.exclusion.polygons.length || confirm('棚田跡の除外範囲をすべて削除しますか？')) { state.exclusion.polygons = []; exclusionChanged(); } });
  updateExclInfo();
  bindRange('houseRadius', 'houseRadiusVal', () => state.settlement.houseRadiusM, (v) => { state.settlement.houseRadiusM = v; settlementChanged(); }, (v) => `${v} m`);
  const houseBtns = $('houseTools').querySelectorAll('button');
  houseBtns.forEach(b => b.addEventListener('click', () => {
    state.houseTool = state.houseTool === b.dataset.mode ? null : b.dataset.mode;
    houseBtns.forEach(x => x.classList.toggle('active', x.dataset.mode === state.houseTool));
    viewer.classList.toggle('drawing', !!state.houseTool);
    if (state.houseTool) { if (state.settleDrawing) finishSettle(); if (state.aoiDrawing) finishAoi(); state.sampleTool.mode = null; $('sampleTools').querySelectorAll('button').forEach(x => x.classList.remove('active')); }
    requestRender();
  }));
  bindCheck('houseShared', () => state.houseShared, (v) => { state.houseShared = v; });
  $('btnHousesClear').addEventListener('click', () => { const s = selectedScene(); if (confirm(`${s.year} 年の住居の点をすべて削除しますか？（全時期共通の点は残ります）`)) { delete state.settlement.housesByScene[s.id]; settlementChanged(); } });
  $('btnSettleUndo').addEventListener('click', () => { state.settlement.polygons.pop(); settlementChanged(); });
  $('btnSettleClear').addEventListener('click', () => { if (!state.settlement.polygons.length || confirm('描いた生活空間の範囲をすべて削除しますか？')) { state.settlement.polygons = []; settlementChanged(); } });
  updateSettleInfo();
  $('btnAoiClear').addEventListener('click', () => { state.aoiPoints = []; state.aoiMask = null; state.aoiDrawing = false; $('btnAoi').classList.remove('active'); viewer.classList.remove('drawing'); save(); recomputeAllBuffers(); });
  const bm = $('brushMode'); bm.addEventListener('change', () => { state.brush.mode = Number(bm.value); viewer.classList.toggle('brush', state.brush.mode !== 0); });
  bindRange('brushSize', 'brushSizeVal', () => state.brush.size, (v) => { state.brush.size = v; }, (v) => v.toFixed(0));
  $('btnCorrClear').addEventListener('click', () => { const s = selectedScene(); s.correction = null; save(); recomputeBuffer(s); rebuildTimeline(); requestRender(); });
}
let bufferTimer = null;
function scheduleBufferRecompute() { clearTimeout(bufferTimer); bufferTimer = setTimeout(recomputeAllBuffers, 120); }
function recomputeAllBuffers() { for (const s of state.scenes) if (s.cls) recomputeBuffer(s); rebuildTimeline(); requestRender(); }
function finishExcl() {
  state.exclDrawing = false; $('btnExcl').classList.remove('active'); $('btnExclDone').hidden = true; viewer.classList.remove('drawing');
  const pts = state.exclPoints.filter((p, i, arr) => i === 0 || Math.hypot(p.x - arr[i - 1].x, p.y - arr[i - 1].y) > 3);
  state.exclPoints = [];
  if (pts.length >= 3) state.exclusion.polygons.push(pts);
  exclusionChanged();
}
function exclusionChanged() { state.exclMask = null; save(); updateExclInfo(); syncLegend(); recomputeAllBuffers(); }
function updateExclInfo() { const ha = state.exclusion.polygons.length ? countMask(exclusionMask()) * state.pxAreaHa : 0; $('exclInfo').textContent = `棚田跡の除外範囲: ${state.exclusion.polygons.length} か所（${ha.toFixed(1)} ha）`; }
function finishSettle() {
  state.settleDrawing = false; $('btnSettle').classList.remove('active'); $('btnSettleDone').hidden = true; viewer.classList.remove('drawing');
  const pts = state.settlePoints.filter((p, i, arr) => i === 0 || Math.hypot(p.x - arr[i - 1].x, p.y - arr[i - 1].y) > 3);
  state.settlePoints = [];
  if (pts.length >= 3) state.settlement.polygons.push(pts);
  settlementChanged();
}
function settlementChanged() { state.settlePolyMask = null; save(); updateSettleInfo(); recomputeAllBuffers(); }
function updateSettleInfo() { const s = selectedScene(); const own = s ? (state.settlement.housesByScene[s.id] || []).length : 0; $('settleInfo').textContent = `住居の点: 共通 ${state.settlement.houses.length} 棟 ／ ${s ? s.year + ' 年' : 'この時期'} ${own} 棟 ／ 描いた範囲: ${state.settlement.polygons.length} か所`; }
function finishAoi() {
  state.aoiDrawing = false; $('btnAoi').classList.remove('active'); $('btnAoiDone').hidden = true; viewer.classList.remove('drawing');
  // ダブルクリックで重複した頂点を除く
  state.aoiPoints = state.aoiPoints.filter((p, i, arr) => i === 0 || Math.hypot(p.x - arr[i - 1].x, p.y - arr[i - 1].y) > 3);
  state.aoiMask = state.aoiPoints.length >= 3 ? polygonMask(state.aoiPoints, state.W, state.H) : null;
  if (!state.aoiMask) state.aoiPoints = [];
  save(); recomputeAllBuffers();
}

function setupSimPanel() {
  const sim = state.sim;
  const model = $('model'); model.value = sim.model || 'linear';
  const syncManual = () => { $('manualRow').hidden = model.value !== 'manual'; };
  model.addEventListener('change', () => { sim.model = model.value; syncManual(); save(); rebuildTimeline(); requestRender(); }); syncManual();
  const mr = $('manualRate'); mr.value = sim.manualRatePct ?? -2; mr.addEventListener('change', () => { sim.manualRatePct = Number(mr.value); save(); rebuildTimeline(); requestRender(); });
  $('startScene').addEventListener('change', (e) => { sim.startId = e.target.value === 'latest' ? null : e.target.value; save(); rebuildTimeline(); requestRender(); });
  bindRange('threshold', 'thresholdVal', () => sim.thresholdPct, (v) => { sim.thresholdPct = v; save(); rebuildTimeline(); requestRender(); }, (v) => `${v}%`);
  bindRange('jitter', 'jitterVal', () => sim.jitterM, (v) => { sim.jitterM = v; save(); scheduleTimelineRebuild(); }, (v) => v.toFixed(0));
  bindRange('protect', 'protectVal', () => sim.protectM, (v) => { sim.protectM = v; save(); scheduleTimelineRebuild(); }, (v) => v.toFixed(0));
  const seed = $('seed'); seed.value = sim.seed ?? 1; seed.addEventListener('change', () => { sim.seed = Number(seed.value) | 0; save(); rebuildTimeline(); requestRender(); });
}
let tlTimer = null;
function scheduleTimelineRebuild() { clearTimeout(tlTimer); tlTimer = setTimeout(() => { rebuildTimeline(); requestRender(); }, 150); }
function rebuildStartOptions() {
  const sel = $('startScene'); const cur = state.sim.startId || 'latest';
  sel.innerHTML = '<option value="latest">最新の観測時期</option>' + sortedScenes().map(s => `<option value="${esc(s.id)}">${s.year} 年 ${esc(s.label || s.id)}</option>`).join('');
  sel.value = [...sel.options].some(o => o.value === cur) ? cur : 'latest';
}
function updateSimReadout() {
  const tl = state.timeline; const el = $('simReadout');
  const pr = tl.projection, tr = tl.trend, sc = pr.sched;
  const rows = [];
  rows.push(['起点', `${tl.start.year} 年（${tl.start.stats.buffer.toFixed(1)} ha）`]);
  rows.push(['傾向線の点数', `${tr.points ?? '-'} 時期`]);
  rows.push(['変化率（起点）', tr.ok ? `${sc.rateHa >= 0 ? '+' : ''}${sc.rateHa.toFixed(2)} ha/年（${sc.ratePct.toFixed(2)} %/年）` : '—']);
  rows.push(['決定係数 R²', tr.r2 != null ? tr.r2.toFixed(3) : '—']);
  rows.push(['消失判定面積', `${tl.thresholdHa.toFixed(1)} ha（${tl.scenes[0].year} 年の ${state.sim.thresholdPct}%）`]);
  const dy = pr.disappearYear;
  rows.push(['予測消失年', dy != null && dy > tl.start.year ? `<span class="big">${dy.toFixed(0)} 年</span>（起点から ${(dy - tl.start.year).toFixed(0)} 年後）` : `<span class="warn">${tl.note || '—'}</span>`]);
  el.innerHTML = rows.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('');
}
function updateStats() {
  const tl = state.timeline; const tb = $('statRows'); tb.innerHTML = '';
  let prev = null;
  for (const s of tl.scenes) {
    const rate = prev && s.year !== prev.year ? (s.stats.buffer - prev.stats.buffer) / (s.year - prev.year) : null;
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${s.year}${s.estimated ? '?' : ''}</td><td class="num">${s.stats.buffer.toFixed(1)}</td><td class="num">${s.stats.land > 0 ? (s.stats.buffer / s.stats.land * 100).toFixed(1) : '-'}</td><td class="num">${s.stats.forest.toFixed(1)}</td><td class="num">${s.stats.field.toFixed(1)}</td><td class="num">${s.stats.settlement.toFixed(1)}</td><td class="num">${rate == null ? '—' : (rate >= 0 ? '+' : '') + rate.toFixed(2)}</td>`;
    tb.appendChild(tr); prev = s;
  }
  $('scaleNote').textContent = `縮尺 ${state.mPerPx.toFixed(3)} m/px（スケールバー ${CFG.scale?.barMeters} m = ${CFG.scale?.barPx} px）、1 画素 = ${(state.pxAreaHa * 10000).toFixed(2)} m²、陸域 ${tl.scenes[0].stats.land.toFixed(1)} ha${state.aoiMask ? '（解析範囲内）' : ''}`;
}

// ---------- ビューア操作 ----------
function zoomAt(sx, sy, factor) {
  const v = state.view;
  const ns = Math.min(40, Math.max(0.2, v.scale * factor)); const k = ns / v.scale;
  v.tx = sx - (sx - v.tx) * k; v.ty = sy - (sy - v.ty) * k; v.scale = ns; requestRender();
}
function setupViewer() {
  let dragging = false, lastX = 0, lastY = 0, moved = false;
  const pointers = new Map(); // タッチのピンチ操作用
  let pinch = null;
  const rectOf = () => viewer.getBoundingClientRect();
  viewer.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    try { viewer.setPointerCapture(e.pointerId); } catch {}
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      // 2 本指: ブラシや描画を中断してピンチに切り替える
      if (state.brush.painting) { state.brush.painting = false; }
      dragging = false; moved = true;
      const [a, b] = [...pointers.values()];
      pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
      return;
    }
    lastX = e.clientX; lastY = e.clientY; moved = false;
    if (state.aoiDrawing || state.settleDrawing || state.exclDrawing || state.sampleTool.mode || state.houseTool) return;
    if (state.brush.mode !== 0 && !e.shiftKey) { state.brush.painting = true; paintAt(e); return; }
    dragging = true; viewer.style.cursor = 'grabbing';
  });
  viewer.addEventListener('pointermove', (e) => {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (e.pointerType === 'mouse' && !dragging && !state.brush.painting) {
      const rr = rectOf(); const k = photoAt(e.clientX - rr.left, e.clientY - rr.top);
      if (k !== state.photoHover) { state.photoHover = k; viewer.style.cursor = k >= 0 ? 'pointer' : ''; requestRender(); }
      showPhotoHover(k, e.clientX - rr.left, e.clientY - rr.top);
    }
    if (pinch && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y), cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      const r = rectOf();
      state.view.tx += cx - pinch.cx; state.view.ty += cy - pinch.cy;
      if (pinch.dist > 0) zoomAt(cx - r.left, cy - r.top, dist / pinch.dist);
      pinch = { dist, cx, cy }; requestRender();
      return;
    }
    if (state.brush.painting) { paintAt(e); return; }
    if (!dragging) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY; lastX = e.clientX; lastY = e.clientY;
    if (Math.abs(dx) + Math.abs(dy) > 0) moved = true;
    state.view.tx += dx; state.view.ty += dy; requestRender();
  });
  const up = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (pointers.size === 1) { const p = [...pointers.values()][0]; lastX = p.x; lastY = p.y; moved = true; }
    if (state.brush.painting) { state.brush.painting = false; const s = selectedScene(); save(); recomputeBuffer(s); rebuildTimeline(); requestRender(); }
    dragging = false; viewer.style.cursor = '';
  };
  viewer.addEventListener('pointerup', up); viewer.addEventListener('pointercancel', up);
  viewer.addEventListener('pointerleave', () => { if (state.photoHover >= 0) { state.photoHover = -1; requestRender(); } showPhotoHover(-1); });
  viewer.addEventListener('click', (e) => {
    if (moved) return;
    const r = viewer.getBoundingClientRect(); const p = toImage(e.clientX - r.left, e.clientY - r.top);
    if (p.x < 0 || p.y < 0 || p.x >= state.W || p.y >= state.H) return;
    if (!state.sampleTool.mode && !state.houseTool && !state.settleDrawing && !state.exclDrawing && !state.aoiDrawing && state.brush.mode === 0) { const k = photoAt(e.clientX - r.left, e.clientY - r.top); if (k >= 0) { showPhoto(k); return; } }
    if (state.sampleTool.mode) { sampleClick(p); return; }
    if (state.houseTool === 'add') {
      const s = selectedScene();
      if (!state.houseShared && Math.abs(state.year - s.year) > 1e-6) state.year = s.year;
      const list = state.houseShared ? state.settlement.houses : (state.settlement.housesByScene[s.id] ||= []);
      list.push({ x: Math.round(p.x), y: Math.round(p.y) }); settlementChanged(); return;
    }
    if (state.houseTool === 'delete') {
      const s = selectedScene();
      let best = null, bd = 8 / state.view.scale + 4;
      for (const list of [state.settlement.houses, state.settlement.housesByScene[s.id] || []]) list.forEach((h, i) => { const d = Math.hypot(h.x - p.x, h.y - p.y); if (d < bd) { bd = d; best = { list, i }; } });
      if (best) { best.list.splice(best.i, 1); settlementChanged(); }
      return;
    }
    if (state.settleDrawing) { state.settlePoints.push({ x: Math.round(p.x), y: Math.round(p.y) }); requestRender(); return; }
    if (state.exclDrawing) { state.exclPoints.push({ x: Math.round(p.x), y: Math.round(p.y) }); requestRender(); return; }
    if (!state.aoiDrawing) return;
    state.aoiPoints.push({ x: Math.round(p.x), y: Math.round(p.y) }); requestRender();
  });
  viewer.addEventListener('dblclick', (e) => { if (state.aoiDrawing) { e.preventDefault(); finishAoi(); } else if (state.settleDrawing) { e.preventDefault(); finishSettle(); } else if (state.exclDrawing) { e.preventDefault(); finishExcl(); } });
  viewer.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = viewer.getBoundingClientRect();
    zoomAt(e.clientX - r.left, e.clientY - r.top, Math.pow(1.0015, -e.deltaY));
  }, { passive: false });
  window.addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea')) return;
    if (!$('lightbox').hidden) return;
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    else if (e.key === 'ArrowRight') setYear(state.year + (e.shiftKey ? 5 : 0.5));
    else if (e.key === 'ArrowLeft') setYear(state.year - (e.shiftKey ? 5 : 0.5));
    else if (e.key === 'Escape') { if (state.aoiDrawing) finishAoi(); if (state.settleDrawing) finishSettle(); if (state.exclDrawing) finishExcl(); if (state.sampleTool.mode) { state.sampleTool.mode = null; $('sampleTools').querySelectorAll('button').forEach(x => x.classList.remove('active')); viewer.classList.remove('drawing'); requestRender(); } }
  });
  new ResizeObserver(() => updateSliderThumb()).observe($('yearSlider'));
  let firstResize = true;
  new ResizeObserver(() => { if (firstResize) { firstResize = false; initialView(); } else fitView(); chart.draw(); }).observe($('viewerWrap'));
}
function paintAt(e) {
  const s = selectedScene(); if (!s || !s.buffer) return;
  // 観測時期の表示中でなければ、その時期へ移動して塗る
  if (Math.abs(state.year - s.year) > 1e-6) state.year = s.year;
  if (!s.correction) s.correction = new Int8Array(state.W * state.H);
  const r = viewer.getBoundingClientRect(); const p = toImage(e.clientX - r.left, e.clientY - r.top);
  const rad = state.brush.size, v = state.brush.mode;
  const x0 = Math.max(0, Math.floor(p.x - rad)), x1 = Math.min(state.W - 1, Math.ceil(p.x + rad));
  const y0 = Math.max(0, Math.floor(p.y - rad)), y1 = Math.min(state.H - 1, Math.ceil(p.y + rad));
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    if ((x - p.x) ** 2 + (y - p.y) ** 2 > rad * rad) continue;
    const i = y * state.W + x; s.correction[i] = v;
    s.buffer[i] = v > 0 ? (s.cls.land[i] && (!state.aoiMask || state.aoiMask[i]) && !(s.human && s.human[i]) ? 1 : 0) : 0;
  }
  requestRender();
}

// ---------- 追加画像 / 入出力 ----------
function setupIO() {
  const hint = $('dropHint');
  hint.addEventListener('dragover', (e) => { e.preventDefault(); hint.classList.add('over'); });
  hint.addEventListener('dragleave', () => hint.classList.remove('over'));
  hint.addEventListener('drop', (e) => { e.preventDefault(); hint.classList.remove('over'); addFiles(e.dataTransfer.files); });
  $('fileInput').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
  $('btnPng').addEventListener('click', exportPng);
  $('btnCsv').addEventListener('click', exportCsv);
  $('btnJson').addEventListener('click', () => download(new Blob([JSON.stringify(serialize(), null, 2)], { type: 'application/json' }), 'forest-buffer-settings.json'));
  $('jsonInput').addEventListener('change', async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try { const saved = JSON.parse(await f.text()); applySaved(saved); for (const s of state.scenes) { if (s._pendingCorrection) { s.correction = rleDecode(s._pendingCorrection, Int8Array, state.W * state.H); delete s._pendingCorrection; } } state.aoiMask = state.aoiPoints.length >= 3 ? polygonMask(state.aoiPoints, state.W, state.H) : null; state.settlePolyMask = null; state.exclMask = null; updateSettleInfo(); updateExclInfo(); save(); recomputeAll(); }
    catch (err) { alert('設定を読み込めませんでした: ' + err.message); }
    e.target.value = '';
  });
  $('btnVideo').addEventListener('click', startRecording);
  $('btnReset').addEventListener('click', () => { if (confirm('保存した設定・手動修正をすべて消去して初期状態に戻しますか？')) { localStorage.removeItem(STORAGE_KEY); location.reload(); } });
}
async function addFiles(files) {
  const list = [...files].filter(f => f.type.startsWith('image/'));
  if (!list.length) return;
  const maxYear = Math.max(...state.scenes.map(s => s.year));
  let k = 0;
  for (const f of list) {
    const url = URL.createObjectURL(f);
    try {
      const img = await loadImage(url);
      const yr = prompt(`「${f.name}」の撮影年を入力してください`, String(maxYear + 10 * (++k)));
      if (yr === null) continue;
      const id = f.name.replace(/\.[^.]+$/, '');
      const s = { id: state.scenes.some(s => s.id === id) ? id + '_' + Date.now() : id, file: null, year: Number(yr) || maxYear + 10 * k, label: f.name, estimated: false, params: {} };
      await prepareScene(s, img);
      if (!state.water) computeWater();
      recomputeScene(s);
      state.scenes.push(s);
    } catch (err) { alert(err.message); }
    finally { URL.revokeObjectURL(url); }
  }
  afterScenesChanged(); refreshParamPanel();
  $('exportNote').textContent = '追加した画像はこのセッション中だけ有効です（再読み込みで消えます）。恒久的に使う場合は data/images に置き、data/config.js に登録してください。';
}
function recomputeAll() {
  for (const s of state.scenes) recomputeScene(s);
  afterScenesChanged(); refreshParamPanel();
  for (const r of paramRefreshers) r();
}
function download(blob, name) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
function renderToCanvas(W, H) {
  const c = document.createElement('canvas'); c.width = W; c.height = H; const ctx = c.getContext('2d');
  const frame = computeFrame(state.year);
  drawBase(ctx, frame, W, H);
  if (state.display.showOverlay !== false) ctx.drawImage(buildOverlay(frame), 0, 0);
  ctx.font = 'bold 34px system-ui, sans-serif'; ctx.fillStyle = '#fff'; ctx.shadowColor = 'rgba(0,0,0,.8)'; ctx.shadowBlur = 6; ctx.textBaseline = 'top';
  ctx.fillText(`${Math.floor(frame.t)} 年`, 14, 12);
  ctx.font = '16px system-ui, sans-serif';
  ctx.fillText(`森林緩衝帯 ${frame.areaHa.toFixed(1)} ha  ${frame.mode === 'pred' ? '［予測］' : frame.mode === 'interp' ? '［補間］' : '［観測］'}`, 14, 54);
  return c;
}
function exportPng() {
  renderToCanvas(state.W, state.H).toBlob((b) => download(b, `forest-buffer_${Math.floor(state.year)}.png`), 'image/png');
}
function exportCsv() {
  const tl = state.timeline; if (!tl) return;
  const lines = ['﻿区分,ID,年,ラベル,陸域_ha,緩衝帯_ha,緩衝帯_陸域比_pct,森林_ha,疎林草地_ha,田畑_ha,人工物_ha,住宅地_ha,増減_ha_per_年'];
  let prev = null;
  for (const s of tl.scenes) {
    const rate = prev && s.year !== prev.year ? (s.stats.buffer - prev.stats.buffer) / (s.year - prev.year) : '';
    lines.push(['観測', s.id, s.year, (s.label || '').replace(/,/g, ' '), s.stats.land.toFixed(2), s.stats.buffer.toFixed(2), s.stats.land > 0 ? (s.stats.buffer / s.stats.land * 100).toFixed(1) : '', s.stats.forest.toFixed(2), s.stats.sparse.toFixed(2), s.stats.field.toFixed(2), s.stats.built.toFixed(2), s.stats.settlement.toFixed(2), rate === '' ? '' : rate.toFixed(3)].join(','));
    prev = s;
  }
  if (tl.trend.ok) {
    for (let y = Math.ceil(tl.start.year / 5) * 5; y <= tl.xMax; y += 5) {
      if (y <= tl.start.year) continue;
      lines.push(['予測', '', y, modelName(state.sim.model), '', tl.projection.areaAt(y).toFixed(2), tl.scenes[0].stats.land > 0 ? (tl.projection.areaAt(y) / tl.scenes[0].stats.land * 100).toFixed(1) : '', '', '', '', '', '', tl.projection.sched.rateHa.toFixed(3)].join(','));
    }
    if (tl.projection.disappearYear != null) lines.push(['予測消失年', '', tl.projection.disappearYear.toFixed(1), `消失判定 ${tl.thresholdHa.toFixed(2)} ha`, '', '', '', '', '', '', '', '', ''].join(','));
  }
  download(new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' }), 'forest-buffer-areas.csv');
}
function startRecording() {
  if (state.recording) return;
  if (!window.MediaRecorder || !viewer.captureStream) return alert('このブラウザは動画の書き出しに対応していません（Chrome / Edge / Firefox をお使いください）');
  const stream = viewer.captureStream(30);
  const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find(m => MediaRecorder.isTypeSupported(m)) || '';
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 6_000_000 } : undefined);
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  rec.onstop = () => { download(new Blob(chunks, { type: 'video/webm' }), 'forest-buffer-simulation.webm'); state.recording = null; $('btnVideo').disabled = false; $('exportNote').textContent = '動画を保存しました。'; };
  state.recording = rec; $('btnVideo').disabled = true; $('exportNote').textContent = '録画中… 再生が終わると自動的に保存されます。';
  $('loop').checked = false; state.year = state.timeline.xMin; render();
  rec.start(200);
  togglePlay(true);
}
function stopRecording() { togglePlay(false); if (state.recording) setTimeout(() => state.recording && state.recording.stop(), 300); }

// ---------- 初期化 ----------
async function init() {
  const status = $('status');
  $('loading').firstElementChild.firstChild.textContent = 'スクリプトを開始しました。画像を読み込んでいます…';
  const watchdog = setTimeout(() => { const h = $('loadingHint'); if (h) h.textContent = '処理に時間がかかっています。画像が大きい、または端末の処理能力が低い可能性があります。しばらくお待ちください。'; }, 20000);
  try {
    state.scenes = (CFG.scenes || []).map(s => ({ ...s, params: { ...(s.params || {}) } }));
    applySaved(loadSaved());
    if (!state.scenes.length) throw new Error('data/config.js に画像が登録されていません');
    const imgs = await Promise.all(state.scenes.map(s => loadImage(s.file)));
    state.W = imgs[0].naturalWidth; state.H = imgs[0].naturalHeight;
    const sc = CFG.scale || { barPx: 1, barMeters: 1 };
    state.mPerPx = sc.barMeters / sc.barPx; state.pxAreaHa = state.mPerPx * state.mPerPx / 10000;
    status.textContent = '分類中…';
    await new Promise(r => setTimeout(r, 0));
    const loading = { set textContent(v) { $('loading').firstElementChild.firstChild.textContent = v; } };
    for (let i = 0; i < state.scenes.length; i++) { loading.textContent = `画像を準備しています… (${i + 1}/${state.scenes.length})`; await new Promise(r => setTimeout(r, 0)); await prepareScene(state.scenes[i], imgs[i]); }
    loading.textContent = '水域を判定しています…'; await new Promise(r => setTimeout(r, 0));
    computeWater();
    for (let i = 0; i < state.scenes.length; i++) { const s = state.scenes[i]; loading.textContent = `土地被覆を分類しています… (${i + 1}/${state.scenes.length})`; await new Promise(r => setTimeout(r, 0)); if (s.params.forestMax === undefined) s.params.forestMax = null; recomputeScene(s); }
    state.selectedId = state.scenes[state.scenes.length - 1].id;
    state.aoiMask = state.aoiPoints.length >= 3 ? polygonMask(state.aoiPoints, state.W, state.H) : null;
    if (state.aoiMask) for (const s of state.scenes) recomputeBuffer(s);
    document.title = CFG.title || document.title; $('title').textContent = CFG.title || $('title').textContent;
    await loadPhotos();
    setupDisplayPanel(); setupParamPanel(); setupBufferPanel(); setupSimPanel(); setupIO(); setupViewer(); setupPhotos();
    $('btnPlay').addEventListener('click', () => togglePlay());
    $('btnPrev').addEventListener('click', () => { const ys = state.timeline.scenes.map(s => s.year).filter(y => y < state.year - 1e-6); setYear(ys.length ? ys[ys.length - 1] : state.timeline.xMin); });
    $('btnNext').addEventListener('click', () => { const ys = state.timeline.scenes.map(s => s.year).filter(y => y > state.year + 1e-6); setYear(ys.length ? ys[0] : state.timeline.xMax); });
    setupSlider();
    rebuildStartOptions();
    state.year = Math.min(...state.scenes.map(s => s.year));
    rebuildTimeline(); renderSceneTable(); refreshParamPanel();
    initialView(); render(); requestAnimationFrame(animLoop);
    status.textContent = `${state.W}×${state.H} px · ${state.mPerPx.toFixed(2)} m/px · ${state.scenes.length} 時期`;
    if (state.settingsMigrated) { save(); $('exportNote').textContent = '判定パラメータの既定値が更新されたため、保存されていた古いパラメータを既定値に置き換えました（サンプル・住居・多角形は引き継いでいます）。'; }
    clearTimeout(watchdog);
    $('loading').hidden = true;
  } catch (err) {
    clearTimeout(watchdog);
    console.error(err);
    $('loading').innerHTML = `<div style="max-width:560px;text-align:center;line-height:1.6">読み込みに失敗しました。<br>${esc(err.message)}<br><small>このツールは http サーバー経由で開く必要があります（例: <code>npx serve</code> または <code>python3 -m http.server</code>）。</small></div>`;
    status.textContent = 'エラー';
  }
}

// 自動化・テスト用の小さな API
window.SIP = {
  state,
  setYear: (y) => { setYear(y); render(); },
  getFrame: () => lastFrame && { year: lastFrame.t, mode: lastFrame.mode, areaHa: lastFrame.areaHa, lostHa: lastFrame.lostHa },
  photos: () => state.photos.map(p => ({ file: p.file, x: Math.round(p.x), y: Math.round(p.y), cls: classAt(p.x, p.y) })),
  showPhoto,
  getStats: () => state.timeline && state.timeline.scenes.map(s => ({ id: s.id, year: s.year, label: s.label, ...s.stats, useGauss: s.cls.useGauss, hasSparse: s.cls.hasSparse, bias: s.cls.resolved.bias })),
  getProjection: () => state.timeline && { start: state.timeline.start.year, disappearYear: state.timeline.projection.disappearYear, rateHa: state.timeline.projection.sched.rateHa, ratePct: state.timeline.projection.sched.ratePct, r2: state.timeline.trend.r2, thresholdHa: state.timeline.thresholdHa, xMax: state.timeline.xMax },
  renderFrame: (W, H) => renderToCanvas(W || state.W, H || state.H).toDataURL('image/png'),
  ready: init(),
};
