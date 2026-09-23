// timeline.js — 観測時期どうしの補間と、最終観測以降の「消失までのシミュレーション」。
//
// 補間（観測 k → k+1）
//   2 時期の緩衝帯マスクの差分（消失画素・出現画素）を求め、消失画素は「森林境界に近いものから順に」
//   区間内で等速に反転させる。これにより任意の年（小数可）のマスクを再現できる。
//
// 予測（シミュレーション）
//   観測された緩衝帯面積の推移に傾向線（線形 / 指数 / 最終区間の変化率 / 手動）を当て、
//   起点となる観測時期の面積に接続した面積スケジュール A(t) を作る。
//   空間パターンは「森林境界からの距離が近い開放地ほど早く森林化する」距離ベースの侵入モデルで、
//   ランダムなゆらぎ（jitter）と、集落・人工物近傍の維持効果（protect）を加えられる。
//   A(t) が消失判定面積を下回った年を「消失年」とする。

import { distanceTransform, mulberry32, sortByPriority } from './morph.js';

/** 面積の傾向線を当てる。points: [{x: 年, y: 面積}] を年の昇順で。 */
export function fitTrend(points, model = 'linear', manualRatePct = -2) {
  const pts = points.filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
  const res = { model, slope: 0, r2: null, points: pts.length, ok: false, note: '' };
  if (model === 'manual') {
    // 手動: 現在面積に対する年率（%/年）。負で減少。
    res.slope = manualRatePct / 100; res.ok = true; res.kind = 'exp';
    return res;
  }
  if (pts.length < 2) { res.note = '傾向線には 2 時期以上の観測が必要です'; return res; }
  if (model === 'last') {
    const a = pts[pts.length - 2], b = pts[pts.length - 1];
    res.slope = b.x === a.x ? 0 : (b.y - a.y) / (b.x - a.x); res.ok = true; res.kind = 'linear';
    return res;
  }
  const useLog = model === 'exp';
  const xs = [], ys = [];
  for (const p of pts) { if (useLog && p.y <= 0) continue; xs.push(p.x); ys.push(useLog ? Math.log(p.y) : p.y); }
  if (xs.length < 2) { res.note = '指数モデルには正の面積が 2 時期以上必要です'; return res; }
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxx += (xs[i] - mx) ** 2; sxy += (xs[i] - mx) * (ys[i] - my); syy += (ys[i] - my) ** 2; }
  const slope = sxx > 0 ? sxy / sxx : 0;
  const intercept = my - slope * mx;
  let ssRes = 0;
  for (let i = 0; i < n; i++) ssRes += (ys[i] - (intercept + slope * xs[i])) ** 2;
  res.slope = slope; res.intercept = intercept; res.r2 = syy > 0 ? 1 - ssRes / syy : 1; res.ok = true;
  res.kind = useLog ? 'exp' : 'linear';
  return res;
}

/**
 * 起点面積 A0（年 y0）に接続した面積スケジュール。
 * linear: A(t) = A0 + slope*(t-y0),  exp: A(t) = A0 * exp(slope*(t-y0))
 */
export function makeSchedule(trend, y0, A0) {
  const kind = trend.kind || 'linear';
  const s = trend.slope;
  const areaAt = (t) => {
    if (!trend.ok) return A0;
    const v = kind === 'exp' ? A0 * Math.exp(s * (t - y0)) : A0 + s * (t - y0);
    return Math.max(0, Math.min(A0, v));
  };
  const solveYear = (target) => {
    if (!trend.ok || s >= 0 || A0 <= target) return A0 <= target ? y0 : null;
    if (kind === 'exp') return target <= 0 ? null : y0 + Math.log(target / A0) / s;
    return y0 + (target - A0) / s;
  };
  // 起点での年あたり減少量（ha/年）と年率（%/年）
  const rateHa = kind === 'exp' ? A0 * s : s;
  const ratePct = A0 > 0 ? rateHa / A0 * 100 : 0;
  return { areaAt, solveYear, rateHa, ratePct, kind, y0, A0 };
}

/**
 * 観測区間ごとの反転順序を前計算する。
 * scenes: 年の昇順に並んだ [{year, buffer, forest}]
 */
export function buildIntervals(scenes, W, H, { seed = 1, jitterPx = 0 } = {}) {
  const n = W * H;
  const intervals = [];
  for (let k = 0; k + 1 < scenes.length; k++) {
    const A = scenes[k].buffer, B = scenes[k + 1].buffer;
    let nl = 0, ng = 0;
    for (let i = 0; i < n; i++) { if (A[i] && !B[i]) nl++; else if (!A[i] && B[i]) ng++; }
    const lostIdx = new Uint32Array(nl), gainIdx = new Uint32Array(ng);
    nl = 0; ng = 0;
    for (let i = 0; i < n; i++) { if (A[i] && !B[i]) lostIdx[nl++] = i; else if (!A[i] && B[i]) gainIdx[ng++] = i; }
    const rng = mulberry32(seed + k * 7919);
    // 消失: 森林境界に近い画素から順に
    const dF = distanceTransform(scenes[k].forest, W, H);
    if (jitterPx > 0) for (let j = 0; j < lostIdx.length; j++) dF[lostIdx[j]] += rng() * jitterPx;
    const lost = sortByPriority(lostIdx, dF);
    // 出現（開墾など）: 既存の緩衝帯に近い画素から順に
    let gained = gainIdx;
    if (gainIdx.length) {
      const dA = distanceTransform(A, W, H);
      if (jitterPx > 0) for (let j = 0; j < gainIdx.length; j++) dA[gainIdx[j]] += rng() * jitterPx;
      gained = sortByPriority(gainIdx, dA);
    }
    intervals.push({ y0: scenes[k].year, y1: scenes[k + 1].year, lost, gained, k });
  }
  return intervals;
}

/** 観測期間内の任意の年のマスク。戻り値の base は補間の基準にした観測時期の添字。 */
export function interpolate(scenes, intervals, year, out) {
  const buf = out || new Uint8Array(scenes[0].buffer.length);
  if (year <= scenes[0].year || scenes.length === 1) { buf.set(scenes[0].buffer); return { buffer: buf, base: 0, next: 0, frac: 0 }; }
  const last = scenes.length - 1;
  if (year >= scenes[last].year) { buf.set(scenes[last].buffer); return { buffer: buf, base: last, next: last, frac: 0 }; }
  let k = 0;
  while (k < intervals.length - 1 && year >= intervals[k].y1) k++;
  const iv = intervals[k];
  const span = iv.y1 - iv.y0;
  const f = span > 0 ? Math.min(1, Math.max(0, (year - iv.y0) / span)) : 1;
  buf.set(scenes[iv.k].buffer);
  const nl = Math.round(f * iv.lost.length), ng = Math.round(f * iv.gained.length);
  for (let j = 0; j < nl; j++) buf[iv.lost[j]] = 0;
  for (let j = 0; j < ng; j++) buf[iv.gained[j]] = 1;
  return { buffer: buf, base: iv.k, next: iv.k + 1, frac: f };
}

/**
 * 予測（シミュレーション）の前計算。
 * start: 起点となる観測時期 {year, buffer, forest, built}
 * opts.pxAreaHa: 1 画素の面積 (ha)、opts.thresholdHa: 消失判定面積 (ha)
 */
export function buildProjection(start, trend, W, H, opts) {
  const { pxAreaHa, thresholdHa, seed = 1, jitterPx = 0, protectPx = 0, protectWeight = 1 } = opts;
  const n = W * H;
  let m = 0;
  for (let i = 0; i < n; i++) if (start.buffer[i]) m++;
  const idx = new Uint32Array(m);
  m = 0;
  for (let i = 0; i < n; i++) if (start.buffer[i]) idx[m++] = i;
  const pr = distanceTransform(start.forest, W, H);
  const rng = mulberry32(seed + 104729);
  if (jitterPx > 0) for (let j = 0; j < idx.length; j++) pr[idx[j]] += rng() * jitterPx;
  if (protectPx > 0 && start.built) {
    const dB = distanceTransform(start.built, W, H);
    for (let j = 0; j < idx.length; j++) { const i = idx[j]; if (dB[i] < protectPx) pr[i] += protectWeight * (protectPx - dB[i]); }
  }
  const order = sortByPriority(idx, pr);
  const A0 = idx.length * pxAreaHa;
  const sched = makeSchedule(trend, start.year, A0);
  const disappearYear = sched.solveYear(thresholdHa);
  return {
    startYear: start.year, A0, order, sched, disappearYear, thresholdHa,
    areaAt: (t) => (t <= start.year ? A0 : sched.areaAt(t)),
    /** 年 t の予測マスク（起点マスクから距離順に森林化）。 */
    maskAt(t, out) {
      const buf = out || new Uint8Array(n);
      buf.set(start.buffer);
      const target = this.areaAt(t);
      const remove = Math.min(order.length, Math.max(0, Math.round((A0 - target) / pxAreaHa)));
      for (let j = 0; j < remove; j++) buf[order[j]] = 0;
      return buf;
    },
  };
}
