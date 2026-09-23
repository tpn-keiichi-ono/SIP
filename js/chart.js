// chart.js — 緩衝帯面積の推移グラフ（観測点・補間線・予測線・消失判定線・現在年カーソル）。Canvas 2D。

const C = {
  surface: '#fcfcfb', grid: '#e7e6e2', axis: '#c9c8c2', text: '#52514e', textStrong: '#0b0b0b',
  series: '#e34948', seriesWash: 'rgba(227,73,72,0.10)', cursor: '#0b0b0b', threshold: '#8a8983', marker: '#e34948',
};

export class AreaChart {
  constructor(canvas, tooltipEl) {
    this.canvas = canvas; this.ctx = canvas.getContext('2d'); this.tip = tooltipEl;
    this.data = null; this.hoverX = null; this.onSeek = null;
    this.pad = { l: 56, r: 18, t: 18, b: 34 };
    canvas.style.touchAction = 'pan-y';
    canvas.addEventListener('pointermove', (e) => this._hover(e));
    canvas.addEventListener('pointerdown', (e) => { this._hover(e); const y = this._yearAt(e); if (y != null && this.onSeek) this.onSeek(y); });
    canvas.addEventListener('pointerleave', () => { this.hoverX = null; if (this.tip) this.tip.hidden = true; this.draw(); });
    canvas.addEventListener('pointerup', (e) => { if (e.pointerType !== 'mouse') { this.hoverX = null; if (this.tip) this.tip.hidden = true; this.draw(); } });
  }

  /**
   * @param {object} d {observed:[{year,area,label}], projection:{from,to,areaAt}|null, thresholdHa, xMin, xMax, currentYear, disappearYear, startYear}
   */
  setData(d) { this.data = d; this.draw(); }
  setCurrentYear(y) { if (this.data) { this.data.currentYear = y; this.draw(); } }

  _dims() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth || 600, h = this.canvas.clientHeight || 200;
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr); this.canvas.height = Math.round(h * dpr);
    }
    return { w, h, dpr };
  }

  _scales(w, h) {
    const d = this.data, p = this.pad;
    let yMax = 1;
    for (const o of d.observed) yMax = Math.max(yMax, o.area);
    yMax = niceCeil(yMax * 1.08);
    const x = (yr) => p.l + (yr - d.xMin) / Math.max(1e-9, d.xMax - d.xMin) * (w - p.l - p.r);
    const y = (a) => h - p.b - a / yMax * (h - p.t - p.b);
    const xInv = (px) => d.xMin + (px - p.l) / (w - p.l - p.r) * (d.xMax - d.xMin);
    return { x, y, xInv, yMax };
  }

  _yearAt(e) {
    if (!this.data) return null;
    const r = this.canvas.getBoundingClientRect();
    const { x, xInv } = this._scales(r.width, r.height);
    const px = e.clientX - r.left;
    if (px < this.pad.l - 4 || px > r.width - this.pad.r + 4) return null;
    return Math.min(this.data.xMax, Math.max(this.data.xMin, xInv(px)));
  }

  _hover(e) {
    const yr = this._yearAt(e);
    this.hoverX = yr;
    this.draw();
    if (!this.tip) return;
    if (yr == null || !this.data) { this.tip.hidden = true; return; }
    const d = this.data;
    const a = d.areaFn ? d.areaFn(yr) : null;
    const near = d.observed.find(o => Math.abs(o.year - yr) < (d.xMax - d.xMin) / 120);
    let html = `<b>${yr.toFixed(1)} 年</b>`;
    if (near) html = `<b>${near.year} 年</b> 観測 ${near.label ? '（' + near.label + '）' : ''}<br>緩衝帯 ${near.area.toFixed(1)} ha`;
    else if (a != null) html += `<br>緩衝帯 ${a.toFixed(1)} ha ${yr > d.lastObservedYear ? '（予測）' : '（補間）'}`;
    this.tip.innerHTML = html;
    const r = this.canvas.getBoundingClientRect();
    this.tip.hidden = false;
    const tx = Math.min(r.width - this.tip.offsetWidth - 8, e.clientX - r.left + 12);
    this.tip.style.left = tx + 'px'; this.tip.style.top = (e.clientY - r.top - 10) + 'px';
  }

  draw() {
    const { w, h, dpr } = this._dims();
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = C.surface; ctx.fillRect(0, 0, w, h);
    const d = this.data; if (!d || !d.observed.length) return;
    const { x, y, yMax } = this._scales(w, h);
    const p = this.pad;
    ctx.font = '11px system-ui, sans-serif'; ctx.fillStyle = C.text; ctx.textBaseline = 'middle';
    // y grid
    const yStep = niceStep(yMax / 4);
    ctx.strokeStyle = C.grid; ctx.lineWidth = 1; ctx.textAlign = 'right';
    for (let v = 0; v <= yMax + 1e-9; v += yStep) {
      const yy = Math.round(y(v)) + 0.5;
      ctx.beginPath(); ctx.moveTo(p.l, yy); ctx.lineTo(w - p.r, yy); ctx.stroke();
      ctx.fillText(v.toLocaleString('ja-JP', { maximumFractionDigits: 1 }), p.l - 8, yy);
    }
    ctx.save(); ctx.translate(14, (p.t + h - p.b) / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center'; ctx.fillText('緩衝帯面積 (ha)', 0, 0); ctx.restore();
    // x axis
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    const span = d.xMax - d.xMin; const xStep = span > 160 ? 40 : span > 80 ? 20 : span > 40 ? 10 : 5;
    ctx.strokeStyle = C.axis;
    ctx.beginPath(); ctx.moveTo(p.l, Math.round(y(0)) + 0.5); ctx.lineTo(w - p.r, Math.round(y(0)) + 0.5); ctx.stroke();
    for (let yr = Math.ceil(d.xMin / xStep) * xStep; yr <= d.xMax; yr += xStep) ctx.fillText(String(yr), x(yr), h - p.b + 6);
    // threshold
    if (d.thresholdHa != null) {
      const ty = Math.round(y(d.thresholdHa)) + 0.5;
      ctx.strokeStyle = C.threshold; ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(p.l, ty); ctx.lineTo(w - p.r, ty); ctx.stroke(); ctx.setLineDash([]);
      ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'; ctx.fillStyle = C.text;
      ctx.fillText(`消失判定 ${d.thresholdHa.toFixed(1)} ha`, p.l + 6, ty - 2);
    }
    // observed polyline + wash
    const obs = d.observed;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    if (obs.length > 1) {
      ctx.beginPath(); obs.forEach((o, i) => i ? ctx.lineTo(x(o.year), y(o.area)) : ctx.moveTo(x(o.year), y(o.area)));
      ctx.lineTo(x(obs[obs.length - 1].year), y(0)); ctx.lineTo(x(obs[0].year), y(0)); ctx.closePath();
      ctx.fillStyle = C.seriesWash; ctx.fill();
      ctx.beginPath(); obs.forEach((o, i) => i ? ctx.lineTo(x(o.year), y(o.area)) : ctx.moveTo(x(o.year), y(o.area)));
      ctx.strokeStyle = C.series; ctx.lineWidth = 2; ctx.stroke();
    }
    // projection (dashed)
    if (d.projection) {
      const pr = d.projection;
      ctx.beginPath();
      const steps = 120;
      for (let i = 0; i <= steps; i++) {
        const yr = pr.from + (pr.to - pr.from) * i / steps;
        const a = pr.areaAt(yr);
        if (i === 0) ctx.moveTo(x(yr), y(a)); else ctx.lineTo(x(yr), y(a));
      }
      ctx.setLineDash([6, 5]); ctx.strokeStyle = C.series; ctx.lineWidth = 2; ctx.stroke(); ctx.setLineDash([]);
    }
    // observed markers with surface ring
    for (const o of obs) {
      ctx.beginPath(); ctx.arc(x(o.year), y(o.area), 6, 0, Math.PI * 2); ctx.fillStyle = C.surface; ctx.fill();
      ctx.beginPath(); ctx.arc(x(o.year), y(o.area), 4, 0, Math.PI * 2); ctx.fillStyle = C.marker; ctx.fill();
    }
    // disappearance marker
    if (d.disappearYear != null && d.disappearYear <= d.xMax) {
      const dx = Math.round(x(d.disappearYear)) + 0.5;
      ctx.strokeStyle = C.threshold; ctx.beginPath(); ctx.moveTo(dx, p.t); ctx.lineTo(dx, y(0)); ctx.stroke();
      ctx.fillStyle = C.textStrong; ctx.textAlign = dx > w - 90 ? 'right' : 'left'; ctx.textBaseline = 'top';
      ctx.fillText(`消失 ${d.disappearYear.toFixed(0)} 年`, dx + (dx > w - 90 ? -6 : 6), p.t);
    }
    // current cursor
    if (d.currentYear != null) {
      const cx = Math.round(x(d.currentYear)) + 0.5;
      ctx.strokeStyle = C.cursor; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(cx, p.t); ctx.lineTo(cx, y(0)); ctx.stroke();
      if (d.areaFn) {
        const a = d.areaFn(d.currentYear);
        ctx.beginPath(); ctx.arc(cx, y(a), 7, 0, Math.PI * 2); ctx.fillStyle = C.surface; ctx.fill();
        ctx.beginPath(); ctx.arc(cx, y(a), 5, 0, Math.PI * 2); ctx.fillStyle = C.cursor; ctx.fill();
      }
    }
    // hover crosshair
    if (this.hoverX != null) {
      const hx = Math.round(x(this.hoverX)) + 0.5;
      ctx.strokeStyle = C.axis; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(hx, p.t); ctx.lineTo(hx, y(0)); ctx.stroke(); ctx.setLineDash([]);
    }
  }
}

function niceStep(raw) {
  if (raw <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
}
function niceCeil(v) { const s = niceStep(v / 4); return Math.ceil(v / s) * s; }
