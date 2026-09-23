// morph.js — 画像マスク（Uint8Array, 幅W×高さH）に対する基本的なラスタ演算。
// 依存ライブラリなし。すべて O(W*H) で、1170×783 程度の画像なら数十 ms で動作します。

/** (2r+1)^2 の矩形窓の合計（画像端では窓をクリップ）。積分画像方式の分離フィルタ。 */
export function boxSum(src, W, H, r, out) {
  const tmp = new Float32Array(W * H);
  const res = out || new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const row = y * W;
    let s = 0;
    for (let x = 0; x <= r && x < W; x++) s += src[row + x];
    for (let x = 0; x < W; x++) {
      tmp[row + x] = s;
      const addX = x + r + 1, remX = x - r;
      if (addX < W) s += src[row + addX];
      if (remX >= 0) s -= src[row + remX];
    }
  }
  const col = new Float32Array(W);
  for (let y = 0; y <= r && y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) col[x] += tmp[row + x];
  }
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) res[row + x] = col[x];
    const addY = y + r + 1, remY = y - r;
    if (addY < H) { const ar = addY * W; for (let x = 0; x < W; x++) col[x] += tmp[ar + x]; }
    if (remY >= 0) { const rr = remY * W; for (let x = 0; x < W; x++) col[x] -= tmp[rr + x]; }
  }
  return res;
}

/** 窓内の有効画素数（画像端でクリップされる）。 */
export function boxCount(W, H, r) {
  const res = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const hy = Math.min(H - 1, y + r) - Math.max(0, y - r) + 1;
    for (let x = 0; x < W; x++) {
      const hx = Math.min(W - 1, x + r) - Math.max(0, x - r) + 1;
      res[y * W + x] = hx * hy;
    }
  }
  return res;
}

/** 矩形窓の平均（ぼかし）。r=0 なら入力を Float32Array にコピーして返す。 */
export function boxMean(src, W, H, r) {
  const n = W * H;
  if (r <= 0) return Float32Array.from(src);
  const s = boxSum(src, W, H, r);
  const c = boxCount(W, H, r);
  for (let i = 0; i < n; i++) s[i] /= c[i];
  return s;
}

/** 膨張（正方形カーネル、半径r）。 */
export function dilate(mask, W, H, r) {
  const n = W * H, out = new Uint8Array(n);
  if (r <= 0) { out.set(mask); return out; }
  const s = boxSum(mask, W, H, r);
  for (let i = 0; i < n; i++) out[i] = s[i] > 0.5 ? 1 : 0;
  return out;
}

/** 収縮（正方形カーネル、半径r）。画像端は「マスク外」とみなす。 */
export function erode(mask, W, H, r) {
  const n = W * H, out = new Uint8Array(n);
  if (r <= 0) { out.set(mask); return out; }
  const s = boxSum(mask, W, H, r);
  const full = (2 * r + 1) * (2 * r + 1);
  for (let i = 0; i < n; i++) out[i] = s[i] > full - 0.5 ? 1 : 0;
  return out;
}

export function morphOpen(mask, W, H, r) { return dilate(erode(mask, W, H, r), W, H, r); }
export function morphClose(mask, W, H, r) { return erode(dilate(mask, W, H, r), W, H, r); }

/**
 * 連結成分ラベリング（4近傍または8近傍）。
 * @returns {{labels:Int32Array, sizes:number[]}} labels は 1 始まり、0 は背景。
 */
export function connectedComponents(mask, W, H, conn = 8) {
  const n = W * H;
  const labels = new Int32Array(n);
  const sizes = [0];
  const queue = new Int32Array(n);
  let label = 0;
  for (let start = 0; start < n; start++) {
    if (!mask[start] || labels[start]) continue;
    label++;
    let head = 0, tail = 0, size = 0;
    queue[tail++] = start; labels[start] = label;
    while (head < tail) {
      const i = queue[head++]; size++;
      const x = i % W, y = (i - x) / W;
      const x0 = x > 0, x1 = x < W - 1, y0 = y > 0, y1 = y < H - 1;
      if (x0 && mask[i - 1] && !labels[i - 1]) { labels[i - 1] = label; queue[tail++] = i - 1; }
      if (x1 && mask[i + 1] && !labels[i + 1]) { labels[i + 1] = label; queue[tail++] = i + 1; }
      if (y0 && mask[i - W] && !labels[i - W]) { labels[i - W] = label; queue[tail++] = i - W; }
      if (y1 && mask[i + W] && !labels[i + W]) { labels[i + W] = label; queue[tail++] = i + W; }
      if (conn === 8) {
        if (x0 && y0 && mask[i - W - 1] && !labels[i - W - 1]) { labels[i - W - 1] = label; queue[tail++] = i - W - 1; }
        if (x1 && y0 && mask[i - W + 1] && !labels[i - W + 1]) { labels[i - W + 1] = label; queue[tail++] = i - W + 1; }
        if (x0 && y1 && mask[i + W - 1] && !labels[i + W - 1]) { labels[i + W - 1] = label; queue[tail++] = i + W - 1; }
        if (x1 && y1 && mask[i + W + 1] && !labels[i + W + 1]) { labels[i + W + 1] = label; queue[tail++] = i + W + 1; }
      }
    }
    sizes.push(size);
  }
  return { labels, sizes };
}

/** minSize 未満の連結成分を除去したマスクを返す。 */
export function removeSmallRegions(mask, W, H, minSize, conn = 8) {
  const out = new Uint8Array(W * H);
  if (minSize <= 1) { out.set(mask); return out; }
  const { labels, sizes } = connectedComponents(mask, W, H, conn);
  for (let i = 0; i < out.length; i++) out[i] = labels[i] && sizes[labels[i]] >= minSize ? 1 : 0;
  return out;
}

/** 画像の縁（margin 画素以内）に接する連結成分だけを残す。 */
export function keepRegionsTouchingBorder(mask, W, H, conn = 4, margin = 0) {
  const { labels, sizes } = connectedComponents(mask, W, H, conn);
  const keep = new Uint8Array(sizes.length);
  for (let m = 0; m <= margin && m < H; m++) {
    for (let x = 0; x < W; x++) { if (labels[m * W + x]) keep[labels[m * W + x]] = 1; if (labels[(H - 1 - m) * W + x]) keep[labels[(H - 1 - m) * W + x]] = 1; }
  }
  for (let m = 0; m <= margin && m < W; m++) {
    for (let y = 0; y < H; y++) { if (labels[y * W + m]) keep[labels[y * W + m]] = 1; if (labels[y * W + W - 1 - m]) keep[labels[y * W + W - 1 - m]] = 1; }
  }
  const out = new Uint8Array(W * H);
  for (let i = 0; i < out.length; i++) out[i] = labels[i] && keep[labels[i]] ? 1 : 0;
  return out;
}

/**
 * 距離変換（チャンファー 3-4 近似、単位: 画素）。mask=1 の画素で 0、それ以外は最近傍の mask=1 画素までの距離。
 * mask に 1 が 1 つもない場合は全画素 1e6 を返す。
 */
export function distanceTransform(mask, W, H) {
  const n = W * H;
  const d = new Float32Array(n);
  const INF = 1e7;
  let any = false;
  for (let i = 0; i < n; i++) { d[i] = mask[i] ? 0 : INF; if (mask[i]) any = true; }
  if (!any) { d.fill(1e6); return d; }
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      const i = row + x;
      let v = d[i];
      if (v === 0) continue;
      if (x > 0) { const c = d[i - 1] + 3; if (c < v) v = c; }
      if (y > 0) {
        const c = d[i - W] + 3; if (c < v) v = c;
        if (x > 0) { const c2 = d[i - W - 1] + 4; if (c2 < v) v = c2; }
        if (x < W - 1) { const c3 = d[i - W + 1] + 4; if (c3 < v) v = c3; }
      }
      d[i] = v;
    }
  }
  for (let y = H - 1; y >= 0; y--) {
    const row = y * W;
    for (let x = W - 1; x >= 0; x--) {
      const i = row + x;
      let v = d[i];
      if (v === 0) continue;
      if (x < W - 1) { const c = d[i + 1] + 3; if (c < v) v = c; }
      if (y < H - 1) {
        const c = d[i + W] + 3; if (c < v) v = c;
        if (x < W - 1) { const c2 = d[i + W + 1] + 4; if (c2 < v) v = c2; }
        if (x > 0) { const c3 = d[i + W - 1] + 4; if (c3 < v) v = c3; }
      }
      d[i] = v;
    }
  }
  for (let i = 0; i < n; i++) d[i] /= 3;
  return d;
}

/** 大津の二値化しきい値。values は 0..255 の範囲、mask=1 の画素だけを対象とする。 */
export function otsu(values, mask) {
  const hist = new Float64Array(256);
  let total = 0;
  for (let i = 0; i < values.length; i++) {
    if (mask && !mask[i]) continue;
    let v = Math.round(values[i]); if (v < 0) v = 0; else if (v > 255) v = 255;
    hist[v]++; total++;
  }
  if (!total) return 128;
  let sumAll = 0;
  for (let t = 0; t < 256; t++) sumAll += t * hist[t];
  let wB = 0, sumB = 0, best = 0, bestT = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (!wB) continue;
    const wF = total - wB; if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; bestT = t; }
  }
  return bestT;
}

/** 多角形（[{x,y},...] 画像座標）を塗りつぶしたマスク。偶奇規則のスキャンライン。 */
export function polygonMask(points, W, H) {
  const out = new Uint8Array(W * H);
  if (!points || points.length < 3) return out;
  const n = points.length;
  for (let y = 0; y < H; y++) {
    const yc = y + 0.5;
    const xs = [];
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const yi = points[i].y, yj = points[j].y;
      if ((yi <= yc && yj > yc) || (yj <= yc && yi > yc)) {
        xs.push(points[i].x + (yc - yi) / (yj - yi) * (points[j].x - points[i].x));
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const x0 = Math.max(0, Math.ceil(xs[k] - 0.5)), x1 = Math.min(W - 1, Math.floor(xs[k + 1] - 0.5));
      for (let x = x0; x <= x1; x++) out[y * W + x] = 1;
    }
  }
  return out;
}

/** 決定的な乱数生成器（mulberry32）。 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * インデックス配列を優先度（小さいほど先）で安定に並べ替える（基数/カウンティングソート）。
 * @param {Uint32Array|Int32Array} indices
 * @param {Float32Array} priority 画素ごとの優先度（indices の各要素で参照）
 * @param {number} quant 量子化ステップ（小さいほど精密）
 */
export function sortByPriority(indices, priority, quant = 0.25) {
  const m = indices.length;
  if (m === 0) return new Uint32Array(0);
  let maxP = 0;
  for (let k = 0; k < m; k++) { const p = priority[indices[k]]; if (p > maxP) maxP = p; }
  const nb = Math.min(1 << 20, Math.floor(maxP / quant) + 2);
  const scale = (nb - 1) / Math.max(maxP, 1e-9);
  const counts = new Int32Array(nb + 1);
  const keys = new Int32Array(m);
  for (let k = 0; k < m; k++) { const b = Math.min(nb - 1, Math.floor(priority[indices[k]] * scale)); keys[k] = b; counts[b + 1]++; }
  for (let b = 0; b < nb; b++) counts[b + 1] += counts[b];
  const out = new Uint32Array(m);
  for (let k = 0; k < m; k++) out[counts[keys[k]]++] = indices[k];
  return out;
}

/** Int8/Uint8 配列のランレングス符号化（永続化用）。[値, 長さ, 値, 長さ, ...] */
export function rleEncode(arr) {
  const out = [];
  if (!arr.length) return out;
  let cur = arr[0], len = 1;
  for (let i = 1; i < arr.length; i++) {
    if (arr[i] === cur && len < 1e9) len++;
    else { out.push(cur, len); cur = arr[i]; len = 1; }
  }
  out.push(cur, len);
  return out;
}

export function rleDecode(runs, Ctor, length) {
  const out = new Ctor(length);
  let pos = 0;
  for (let k = 0; k + 1 < runs.length && pos < length; k += 2) {
    const v = runs[k], len = Math.min(runs[k + 1], length - pos);
    if (v !== 0) out.fill(v, pos, pos + len);
    pos += len;
  }
  return out;
}
