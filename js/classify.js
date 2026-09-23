// classify.js — 空中写真 1 枚を「水域 / 森林（密） / 疎林・草地（間伐地＝緩衝帯の候補） / 田畑（開放地） / 人工物・裸地」に分類する。
//
// 方式: 教師サンプル付きの単純ベイズ（対角ガウス）分類。
//   画素ごとの特徴量 = 平滑化した輝度・彩度・緑らしさ・局所テクスチャ（輝度の局所標準偏差）
//   クラスごとにサンプル円（x, y, r）から平均・分散を求め、対数尤度が最大のクラスに割り当てる。
//   サンプルが無いクラスは、しきい値ルールで代替する（森林/開放地: 大津法の輝度しきい値、人工物: 明るく彩度が低い画素）。
//   bias（開放地寄り ↔ 森林寄り）で判定の傾きを時期ごとに調整できる。
// モノクロ写真では彩度・緑らしさが 0 になるが、分散の下限を設けているため同じ手順で動く。

import { boxMean, dilate, morphOpen, morphClose, removeSmallRegions, keepRegionsTouchingBorder, connectedComponents, distanceTransform, otsu } from './morph.js';

export const CLASSES = ['forest', 'sparse', 'open', 'built'];

/** RGBA 画素配列から生の特徴量を求める（時期ごとに 1 回だけ計算してキャッシュする）。 */
export function computeFeatures(rgba, W, H) {
  const n = W * H;
  const lum = new Float32Array(n), chroma = new Float32Array(n), green = new Float32Array(n), blue = new Float32Array(n);
  let chromaSum = 0;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const r = rgba[p], g = rgba[p + 1], b = rgba[p + 2];
    lum[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    chroma[i] = mx - mn; chromaSum += mx - mn;
    green[i] = g - (r + b) / 2;
    blue[i] = b - (r + g) / 2;
  }
  return { lum, chroma, green, blue, grayscale: chromaSum / n < 3 };
}

/** 平滑化・テクスチャを含む分類用特徴量（params に依存するので分類ごとに計算）。 */
export function deriveFeatures(feat, W, H, smooth, texRadius) {
  const n = W * H;
  const m = boxMean(feat.lum, W, H, texRadius);
  const sq = new Float32Array(n);
  for (let i = 0; i < n; i++) sq[i] = feat.lum[i] * feat.lum[i];
  const m2 = boxMean(sq, W, H, texRadius);
  const tex = new Float32Array(n);
  for (let i = 0; i < n; i++) tex[i] = Math.sqrt(Math.max(0, m2[i] - m[i] * m[i]));
  const mn = localMin(feat.lum, W, H, texRadius); // 樹冠の間の影を拾う（森林で低く、田畑で高い）
  return [
    boxMean(feat.lum, W, H, smooth),
    boxMean(feat.chroma, W, H, smooth),
    boxMean(feat.green, W, H, smooth),
    boxMean(tex, W, H, smooth),
    boxMean(mn, W, H, smooth),
  ];
}
export const FEATURE_NAMES = ['輝度', '彩度', '緑らしさ', 'テクスチャ', '局所最小輝度'];

/** 分離可能な最小値フィルタ（窓 2r+1）。 */
export function localMin(src, W, H, r) {
  const tmp = new Float32Array(W * H), out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      let v = Infinity;
      for (let k = Math.max(0, x - r); k <= Math.min(W - 1, x + r); k++) if (src[row + k] < v) v = src[row + k];
      tmp[row + x] = v;
    }
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let v = Infinity;
      for (let k = Math.max(0, y - r); k <= Math.min(H - 1, y + r); k++) if (tmp[k * W + x] < v) v = tmp[k * W + x];
      out[y * W + x] = v;
    }
  }
  return out;
}

function median(arr) {
  const a = Float32Array.from(arr).sort();
  return a[a.length >> 1];
}

/**
 * 参照画像（カラー）から共通の水域マスクを作る。全画像が同じ範囲を写している前提。
 * 各参照画像で「その画像の中で相対的に青が強く、なめらかな画素」を海の候補とし、過半数の画像で候補になった画素を海とする
 * （影や霞は画像ごとに位置が変わるので多数決で消える）。候補でない領域のうち一定以上の大きさの連結成分だけを陸域とみなすので、
 * 白波・岩礁などの穴は水域側に吸収される。grow（画素）だけ膨張させると海岸線沿いの帯（砂浜・岩・護岸）を除外できる。
 */
export function buildWaterMask(featList, W, H, opt = {}) {
  const { absMin = 18, relMin = 10, texMax = 10, minLandRegion = 1500, closeRadius = 2, grow = 1 } = opt;
  const n = W * H;
  const votes = new Uint8Array(n);
  let refs = 0;
  for (const feat of featList) {
    if (feat.grayscale) continue;
    refs++;
    const med = median(feat.blue);
    const th = Math.max(absMin, med + relMin);
    const m = boxMean(feat.lum, W, H, 2);
    const sq = new Float32Array(n); for (let i = 0; i < n; i++) sq[i] = feat.lum[i] * feat.lum[i];
    const m2 = boxMean(sq, W, H, 2);
    for (let i = 0; i < n; i++) {
      const tex = Math.sqrt(Math.max(0, m2[i] - m[i] * m[i]));
      if (feat.blue[i] > th && tex < texMax) votes[i]++;
    }
  }
  if (!refs) return null;
  const need = Math.floor(refs / 2) + 1; // 過半数（参照 2 枚なら両方）
  const cand = new Uint8Array(n);
  for (let i = 0; i < n; i++) cand[i] = votes[i] >= need ? 1 : 0;
  const sea = morphClose(cand, W, H, closeRadius);
  const notSea = new Uint8Array(n);
  for (let i = 0; i < n; i++) notSea[i] = sea[i] ? 0 : 1;
  const land = removeSmallRegions(notSea, W, H, minLandRegion, 4);
  let water = new Uint8Array(n);
  for (let i = 0; i < n; i++) water[i] = land[i] ? 0 : 1;
  water = morphClose(water, W, H, closeRadius);
  // 海は画像の縁に接している。内陸に孤立した「水域」（影や霞の誤検出）は捨てる。
  water = keepRegionsTouchingBorder(water, W, H, 4, closeRadius + 1);
  if (grow > 0) water = dilate(water, W, H, grow);
  return water;
}

/**
 * 白波・砂浜・岩礁など、水域に接した「明るく彩度の低い」画素を海岸帯として取り出す（時期ごとに波の状態が違うため個別に求める）。
 */
export function coastalZone(feat, W, H, water, { lumMin = 185, chromaMax = 30 } = {}) {
  const n = W * H;
  if (!water) return null;
  const cand = new Uint8Array(n);
  const sl = boxMean(feat.lum, W, H, 1), sc = boxMean(feat.chroma, W, H, 1);
  for (let i = 0; i < n; i++) cand[i] = water[i] || (sl[i] > lumMin && sc[i] < chromaMax) ? 1 : 0;
  const { labels } = connectedComponents(cand, W, H, 4);
  let maxLabel = 0;
  for (let i = 0; i < n; i++) if (labels[i] > maxLabel) maxLabel = labels[i];
  const touches = new Uint8Array(maxLabel + 1);
  for (let i = 0; i < n; i++) if (water[i] && labels[i]) touches[labels[i]] = 1;
  const coast = new Uint8Array(n);
  for (let i = 0; i < n; i++) coast[i] = !water[i] && labels[i] && touches[labels[i]] ? 1 : 0;
  return coast;
}

/** 1 時期分の既定パラメータ。 */
export function defaultParams(grayscale) {
  return {
    smooth: 3,            // 特徴量の平滑化半径（画素）
    texRadius: 2,         // テクスチャ（局所標準偏差）の窓半径
    bias: 0,              // 正: 開放地と判定しやすく、負: 森林と判定しやすく（対数尤度に加算）
    clean: 2,             // 森林マスクのクロージング/オープニング半径
    minRegionPx: 80,      // これより小さい開放地の塊は無視
    forestMax: null,      // サンプルが無いときの森林/開放地しきい値（null = 大津法）
    builtMin: grayscale ? 200 : 190, // サンプルが無いときの人工物の輝度下限（256 で無効）
    builtChromaMax: grayscale ? 255 : 24,
    varFloor: 9,          // 分散の下限（特徴量が一定のときの 0 除算防止・過学習防止）
    coastExclude: true,   // 水域に接する白波・砂浜・岩礁を陸域から除く
  };
}

/**
 * サンプル円 [{x,y,r}] からクラスモデルを作る。
 * 円ごとに平均を持つ「多プロトタイプ」モデル（同じクラスでも常緑樹の暗い森と落葉樹の明るい森のように
 * 見え方が複数あるため）。分散はクラス内でプールした値を使い、下限 varFloor を設ける。
 */
function trainClass(F, W, H, circles, varFloor) {
  const k = F.length;
  const comps = [];
  const pooled = new Float64Array(k);
  let total = 0;
  for (const c of circles || []) {
    const r = Math.max(1, c.r | 0);
    const sum = new Float64Array(k), sq = new Float64Array(k);
    let cnt = 0;
    const x0 = Math.max(0, Math.floor(c.x - r)), x1 = Math.min(W - 1, Math.ceil(c.x + r));
    const y0 = Math.max(0, Math.floor(c.y - r)), y1 = Math.min(H - 1, Math.ceil(c.y + r));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      if ((x - c.x) ** 2 + (y - c.y) ** 2 > r * r) continue;
      const i = y * W + x;
      for (let f = 0; f < k; f++) { sum[f] += F[f][i]; sq[f] += F[f][i] * F[f][i]; }
      cnt++;
    }
    if (cnt < 4) continue;
    const mu = new Float64Array(k);
    for (let f = 0; f < k; f++) { mu[f] = sum[f] / cnt; pooled[f] += Math.max(0, sq[f] / cnt - mu[f] * mu[f]) * cnt; }
    comps.push({ mu, count: cnt });
    total += cnt;
  }
  if (!comps.length) return null;
  const va = new Float64Array(k);
  for (let f = 0; f < k; f++) va[f] = Math.max(varFloor, pooled[f] / total);
  const logDet = Array.from(va).reduce((a, v) => a + Math.log(v), 0);
  const mu = new Float64Array(k);
  for (const c of comps) for (let f = 0; f < k; f++) mu[f] += c.mu[f] * c.count / total;
  return { comps, va, logDet, count: total, mu };
}

/**
 * クラス間で分散を共通化する。クラスごとに分散を持つと、見え方が多様なクラス（森林）ほど密度が薄くなって
 * 不利になるため、プールした共通分散で「一番近いプロトタイプのクラス」を選ぶ形にする。
 */
function shareVariance(model, varFloor) {
  const classes = Object.values(model).filter(Boolean);
  const k = classes[0].va.length;
  const va = new Float64Array(k);
  let total = 0;
  for (const c of classes) { for (let f = 0; f < k; f++) va[f] += c.va[f] * c.count; total += c.count; }
  for (let f = 0; f < k; f++) va[f] = Math.max(varFloor, va[f] / total);
  for (const c of classes) { c.va = va; c.logDet = 0; }
}

/** クラスの対数尤度（プロトタイプの最大値）。 */
function logLik(F, i, cls) {
  let best = -Infinity;
  for (const c of cls.comps) {
    let d2 = 0;
    for (let f = 0; f < F.length; f++) { const d = F[f][i] - c.mu[f]; d2 += d * d / cls.va[f]; }
    const ll = -0.5 * (d2 + cls.logDet);
    if (ll > best) best = ll;
  }
  return best;
}

/**
 * 分類本体。
 * @param feat computeFeatures の結果
 * @param params defaultParams と同じキー（部分指定可）
 * @param water 共通の水域マスク（null 可）
 * @param samples {forest:[{x,y,r}], open:[...], built:[...]}（null 可）
 * @returns {{forest, open, built, land, resolved, model}}
 */
export function classifyScene(feat, W, H, params, water, samples) {
  const n = W * H;
  const p = { ...defaultParams(feat.grayscale), ...params };
  const land = new Uint8Array(n);
  const coast = p.coastExclude === false ? null : coastalZone(feat, W, H, water);
  for (let i = 0; i < n; i++) land[i] = (water && water[i]) || (coast && coast[i]) ? 0 : 1;

  const F = deriveFeatures(feat, W, H, p.smooth, p.texRadius);
  const sl = F[0], sc = F[1];
  const model = {
    forest: trainClass(F, W, H, samples?.forest, p.varFloor),
    sparse: trainClass(F, W, H, samples?.sparse, p.varFloor),
    open: trainClass(F, W, H, samples?.open, p.varFloor),
    built: trainClass(F, W, H, samples?.built, p.varFloor),
  };
  const useGauss = !!(model.forest && model.open);
  if (useGauss) shareVariance(model, p.varFloor); // 全クラス共通の分散（LDA 的な最近傍プロトタイプ判定）
  let forestMax = p.forestMax;
  if (!useGauss && forestMax == null) forestMax = otsu(sl, land);

  let forest = new Uint8Array(n);
  const built = new Uint8Array(n);
  let sparse = new Uint8Array(n);
  const builtRule = (i) => sl[i] > p.builtMin && sc[i] < p.builtChromaMax;
  for (let i = 0; i < n; i++) {
    if (!land[i]) continue;
    if (useGauss) {
      const lf = logLik(F, i, model.forest), lo = logLik(F, i, model.open) + p.bias;
      const ls = model.sparse ? logLik(F, i, model.sparse) + p.bias * 0.5 : -Infinity;
      let lb = -Infinity;
      if (model.built) lb = logLik(F, i, model.built);
      else if (builtRule(i)) lb = Infinity;
      if (lb > lf && lb > lo && lb > ls) built[i] = 1;
      else if (ls > lf && ls >= lo) sparse[i] = 1;
      else if (lf >= lo) forest[i] = 1;
    } else {
      if (sl[i] < forestMax - p.bias * 5) forest[i] = 1;
      else if (model.built ? logLik(F, i, model.built) > logLik(F, i, { comps: [{ mu: [forestMax + 40, 0, 0, 0, forestMax + 20] }], va: [400, 400, 400, 400, 400], logDet: 5 * Math.log(400) }) : builtRule(i)) built[i] = 1;
    }
  }
  if (p.clean > 0) {
    forest = morphOpen(morphClose(forest, W, H, p.clean), W, H, p.clean);
    for (let i = 0; i < n; i++) if (!land[i]) forest[i] = 0;
    for (let i = 0; i < n; i++) if (forest[i]) sparse[i] = 0;
  }
  let open = new Uint8Array(n);
  for (let i = 0; i < n; i++) open[i] = land[i] && !forest[i] && !built[i] && !sparse[i] ? 1 : 0;
  if (p.minRegionPx > 1) {
    const cleaned = removeSmallRegions(open, W, H, p.minRegionPx, 8);
    for (let i = 0; i < n; i++) if (open[i] && !cleaned[i]) sparse[i] = 1; // 小さな田畑の断片は疎林・草地に吸収
    open = cleaned;
    const cleanedS = removeSmallRegions(sparse, W, H, Math.max(1, p.minRegionPx >> 1), 8);
    for (let i = 0; i < n; i++) if (sparse[i] && !cleanedS[i]) forest[i] = 1; // 小さな疎林の断片は森林に吸収
    sparse = cleanedS;
  }
  return { forest, sparse, open, built, land, coast, model, useGauss, hasSparse: !!model.sparse, resolved: { ...p, forestMax } };
}

/**
 * 分類結果から「森林緩衝帯」マスクを作る。
 * 生活空間 H = 住宅地（多角形）∪ 田畑 ∪ 人工物。その周囲 bandPx の帯（森林側）のうち、密な森林でない部分
 * （疎林・草地）が「機能している緩衝帯」。帯の中で森林になった部分は緩衝帯が失われた場所。
 *  - human      … 生活空間マスク（住宅地多角形など。田畑・人工物は cls から加える）
 *  - bandPx     … 生活空間からの帯の幅（画素）。0 なら帯で限定せず、疎林・草地すべてを緩衝帯とする
 *  - aoi        … 解析範囲（多角形マスク）。null なら全陸域。
 *  - correction … 手動修正（Int8: +1 緩衝帯に強制, -1 除外, 0 変更なし）
 * @returns {{buffer:Uint8Array, band:Uint8Array|null, human:Uint8Array}}
 */
export function buildBuffer(cls, W, H, { aoi = null, correction = null, bandPx = 0, human = null } = {}) {
  const n = W * H;
  const humanAll = new Uint8Array(n);
  for (let i = 0; i < n; i++) humanAll[i] = cls.land[i] && ((human && human[i]) || cls.open[i] || cls.built[i]) ? 1 : 0;
  const buf = new Uint8Array(n);
  let band = null;
  if (bandPx > 0) {
    const d = distanceTransform(humanAll, W, H);
    band = new Uint8Array(n);
    for (let i = 0; i < n; i++) band[i] = cls.land[i] && !humanAll[i] && d[i] <= bandPx ? 1 : 0;
    for (let i = 0; i < n; i++) buf[i] = band[i] && cls.sparse[i] ? 1 : 0;
  } else {
    for (let i = 0; i < n; i++) buf[i] = cls.sparse[i] && !humanAll[i] ? 1 : 0;
  }
  if (correction) {
    for (let i = 0; i < n; i++) {
      if (correction[i] > 0) { if (cls.land[i]) buf[i] = 1; }
      else if (correction[i] < 0) buf[i] = 0;
    }
  }
  if (aoi) for (let i = 0; i < n; i++) if (!aoi[i]) { buf[i] = 0; if (band) band[i] = 0; }
  return { buffer: buf, band, human: humanAll };
}

/** マスク内の 1 の個数。 */
export function countMask(mask, aoi = null) {
  let c = 0;
  if (aoi) { for (let i = 0; i < mask.length; i++) if (mask[i] && aoi[i]) c++; }
  else { for (let i = 0; i < mask.length; i++) if (mask[i]) c++; }
  return c;
}
