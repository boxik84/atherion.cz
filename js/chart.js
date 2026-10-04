// Tiny canvas charts (no dependencies).

import { ZONES, maxHrOf, zoneColor, zoneOf, hrAtIntensity } from './metrics.js';

function setup(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

/** Sparkline of the last `windowSec` seconds, line coloured by zone. */
export function drawSparkline(canvas, samples, athlete, windowSec = 120) {
  if (!canvas.clientWidth) return;
  const { ctx, w, h } = setup(canvas);
  const now = Date.now();
  const pts = samples.filter((s) => s.hr && now - s.t <= windowSec * 1000);
  if (pts.length < 2) return;
  let min = Infinity, max = -Infinity;
  for (const p of pts) { min = Math.min(min, p.hr); max = Math.max(max, p.hr); }
  min -= 5; max += 5;
  const x = (t) => w - ((now - t) / (windowSec * 1000)) * w;
  const y = (v) => h - 2 - ((v - min) / (max - min)) * (h - 4);

  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].t - pts[i - 1].t > 5000) continue;
    ctx.strokeStyle = zoneColor(zoneOf(pts[i].hr, athlete));
    ctx.beginPath();
    ctx.moveTo(x(pts[i - 1].t), y(pts[i - 1].hr));
    ctx.lineTo(x(pts[i].t), y(pts[i].hr));
    ctx.stroke();
  }
}

/** Large HR chart with zone bands and time axis. */
export function drawHrChart(canvas, samples, athlete, windowSec, styles) {
  if (!canvas.clientWidth) return;
  const { ctx, w, h } = setup(canvas);
  const pad = { l: 36, r: 8, t: 8, b: 20 };
  const now = samples.length ? samples[samples.length - 1].t : Date.now();
  const start = now - windowSec * 1000;
  const pts = samples.filter((s) => s.t >= start);
  const maxHr = maxHrOf(athlete);
  const lo = Math.round(maxHr * 0.4);
  const hi = maxHr + 5;
  const x = (t) => pad.l + ((t - start) / (windowSec * 1000)) * (w - pad.l - pad.r);
  const y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * (h - pad.t - pad.b);

  // zone bands
  for (const z of ZONES) {
    const top = z.id === 5 ? hi : hrAtIntensity(ZONES[z.id].from, athlete);
    const bottom = Math.max(lo, hrAtIntensity(z.from, athlete));
    if (top <= bottom) continue;
    ctx.fillStyle = z.color + '1f';
    ctx.fillRect(pad.l, y(top), w - pad.l - pad.r, y(bottom) - y(top));
  }

  // y axis labels
  ctx.fillStyle = styles.muted;
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let v = Math.ceil(lo / 20) * 20; v <= hi; v += 20) {
    ctx.fillText(String(v), pad.l - 6, y(v));
    ctx.strokeStyle = styles.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad.l, y(v));
    ctx.lineTo(w - pad.r, y(v));
    ctx.stroke();
  }

  // x axis labels (minutes ago)
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const stepMin = windowSec > 1800 ? 10 : windowSec > 600 ? 5 : 1;
  for (let m = 0; m * 60 <= windowSec; m += stepMin) {
    const t = now - m * 60000;
    ctx.textAlign = m === 0 ? 'right' : 'center';
    ctx.fillText(m === 0 ? 'teraz' : `-${m}m`, x(t), h - pad.b + 5);
  }

  if (pts.length < 2) return;
  ctx.lineWidth = 2.5;
  ctx.lineJoin = 'round';
  for (let i = 1; i < pts.length; i++) {
    if (!pts[i].hr || !pts[i - 1].hr || pts[i].t - pts[i - 1].t > 5000) continue;
    ctx.strokeStyle = zoneColor(zoneOf(pts[i].hr, athlete));
    ctx.beginPath();
    ctx.moveTo(x(pts[i - 1].t), y(pts[i - 1].hr));
    ctx.lineTo(x(pts[i].t), y(pts[i].hr));
    ctx.stroke();
  }
}
