// render.js — マスク群を半透明オーバーレイ（ImageData）に合成する。
// 緩衝帯は赤の半透明で塗る。消失部分（比較対象の時期には緩衝帯だったが現在は失われた画素）は濃い赤。

function pack(r, g, b, a) { return ((a & 255) << 24) | ((b & 255) << 16) | ((g & 255) << 8) | (r & 255); }

export const DEFAULT_STYLE = {
  opacity: 0.45,
  bufferColor: [230, 40, 40],
  lostColor: [120, 10, 40],
  lostOpacity: 0.45,
  forestColor: [40, 150, 70],
  forestOpacity: 0.25,
  builtColor: [235, 235, 235],
  builtOpacity: 0.35,
  waterColor: [60, 120, 220],
  waterOpacity: 0.3,
  showForest: false,
  showLost: true,
  showBuilt: false,
  showWater: false,
  dimOutsideAoi: true,
};

/**
 * @param {ImageData} imgData 出力先（幅W×高さH）
 * @param {object} layers {buffer, lost, forest, built, water, aoi} 各 Uint8Array または null
 * @param {object} style DEFAULT_STYLE と同じキー
 */
export function composeOverlay(imgData, layers, style) {
  const s = { ...DEFAULT_STYLE, ...style };
  const px = new Uint32Array(imgData.data.buffer);
  const n = px.length;
  const cBuf = pack(s.bufferColor[0], s.bufferColor[1], s.bufferColor[2], Math.round(255 * s.opacity));
  const cLost = pack(s.lostColor[0], s.lostColor[1], s.lostColor[2], Math.round(255 * Math.min(1, s.lostOpacity * (0.5 + s.opacity))));
  const cFor = pack(s.forestColor[0], s.forestColor[1], s.forestColor[2], Math.round(255 * s.forestOpacity));
  const cBuilt = pack(s.builtColor[0], s.builtColor[1], s.builtColor[2], Math.round(255 * s.builtOpacity));
  const cWater = pack(s.waterColor[0], s.waterColor[1], s.waterColor[2], Math.round(255 * s.waterOpacity));
  const cDim = pack(20, 20, 20, 110);
  const { buffer, lost, forest, built, water, aoi } = layers;
  const showLost = s.showLost && lost, showForest = s.showForest && forest, showBuilt = s.showBuilt && built, showWater = s.showWater && water;
  const dim = s.dimOutsideAoi && aoi;
  for (let i = 0; i < n; i++) {
    let v = 0;
    if (buffer && buffer[i]) v = cBuf;
    else if (showLost && lost[i]) v = cLost;
    else if (showWater && water[i]) v = cWater;
    else if (showBuilt && built[i]) v = cBuilt;
    else if (showForest && forest[i]) v = cFor;
    if (dim && !aoi[i] && !(showWater && water[i])) v = cDim;
    px[i] = v;
  }
  return imgData;
}

/** 多角形を画面座標系で描く（AOI の輪郭・頂点）。 */
export function drawPolygon(ctx, pts, toScreen, { closed = true, color = '#ffd400', vertexRadius = 4 } = {}) {
  if (!pts || !pts.length) return;
  ctx.save();
  ctx.lineWidth = 2; ctx.strokeStyle = color; ctx.fillStyle = color;
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  pts.forEach((p, i) => { const q = toScreen(p.x, p.y); if (i === 0) ctx.moveTo(q.x, q.y); else ctx.lineTo(q.x, q.y); });
  if (closed && pts.length > 2) ctx.closePath();
  ctx.stroke();
  ctx.setLineDash([]);
  for (const p of pts) { const q = toScreen(p.x, p.y); ctx.beginPath(); ctx.arc(q.x, q.y, vertexRadius, 0, Math.PI * 2); ctx.fill(); }
  ctx.restore();
}
