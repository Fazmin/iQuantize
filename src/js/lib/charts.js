// Small SVG charts (no libraries): line, sparkline, horizontal bars and scatter.

import { h, s } from './dom.js';

function niceTicks(min, max, count = 4) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const span = max - min;
  const step = 10 ** Math.floor(Math.log10(span / count));
  const err = (count * step) / span;
  const mult = err <= 0.15 ? 10 : err <= 0.35 ? 5 : err <= 0.75 ? 2 : 1;
  const st = step * mult;
  const ticks = [];
  // Round outward so the axis always covers the data.
  for (let v = Math.floor(min / st) * st; v <= Math.ceil(max / st) * st + st * 1e-9; v += st) ticks.push(Number(v.toFixed(10)));
  return ticks;
}

const fmt = (v) => (Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(1)}k` : Math.abs(v) < 0.01 && v !== 0 ? v.toExponential(0) : Number(v.toFixed(3)).toString());

/** Line chart: series [{ name, color, points: [{x,y}] }] */
export function lineChart({ series, width = 560, height = 180, yLabel = '', xLabel = '' }) {
  const pad = { l: 44, r: 12, t: 10, b: 26 };
  const all = series.flatMap((se) => se.points);
  const svg = s('svg', { class: 'chart', viewBox: `0 0 ${width} ${height}`, width });
  if (!all.length) return svg;
  const xs = all.map((p) => p.x);
  const ys = all.map((p) => p.y);
  const yt = niceTicks(Math.min(...ys), Math.max(...ys));
  const [x0, x1] = [Math.min(...xs), Math.max(...xs) || 1];
  const [y0, y1] = [yt[0], yt[yt.length - 1]];
  const X = (x) => pad.l + ((x - x0) / (x1 - x0 || 1)) * (width - pad.l - pad.r);
  const Y = (y) => pad.t + (1 - (y - y0) / (y1 - y0 || 1)) * (height - pad.t - pad.b);
  const grid = s('g', { class: 'grid' });
  for (const t of yt) grid.append(s('line', { x1: pad.l, x2: width - pad.r, y1: Y(t), y2: Y(t) }), s('text', { x: pad.l - 6, y: Y(t) + 3, 'text-anchor': 'end' }, fmt(t)));
  svg.append(grid);
  for (const se of series) {
    if (!se.points.length) continue;
    const d = se.points.map((p, i) => `${i ? 'L' : 'M'}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join('');
    svg.append(s('path', { d, fill: 'none', stroke: se.color || 'var(--accent)', 'stroke-width': 2, 'stroke-linejoin': 'round' }));
    const last = se.points[se.points.length - 1];
    svg.append(s('circle', { cx: X(last.x), cy: Y(last.y), r: 3, fill: se.color || 'var(--accent)' }));
  }
  svg.append(s('text', { x: width - pad.r, y: height - 6, 'text-anchor': 'end' }, xLabel), s('text', { x: 4, y: 10 }, yLabel));
  return svg;
}

/** Tiny trend line for gauges. */
export function sparkline(values, { width = 160, height = 36, color = 'var(--accent)', max } = {}) {
  const svg = s('svg', { class: 'spark', viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'none' });
  if (values.length < 2) return svg;
  const m = max ?? Math.max(...values, 1e-9);
  const X = (i) => (i / (values.length - 1)) * width;
  const Y = (v) => height - 2 - (v / m) * (height - 4);
  const line = values.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join('');
  svg.append(
    s('path', { d: `${line}L${width},${height}L0,${height}Z`, fill: color, 'fill-opacity': 0.12, stroke: 'none' }),
    s('path', { d: line, fill: 'none', stroke: color, 'stroke-width': 1.5 }),
  );
  return svg;
}

/** Horizontal bars: rows [{ label, value, color?, text? }] */
export function barChart(rows, { width = 520, rowH = 26, format = fmt, max } = {}) {
  const labelW = 130;
  const height = rows.length * rowH + 4;
  const m = max ?? Math.max(...rows.map((r) => r.value), 1e-9);
  const svg = s('svg', { class: 'chart', viewBox: `0 0 ${width} ${height}`, width });
  rows.forEach((r, i) => {
    const y = i * rowH + 4;
    const w = ((width - labelW - 70) * r.value) / m;
    svg.append(
      s('text', { x: 0, y: y + rowH / 2 + 2 }, r.label),
      s('rect', { x: labelW, y: y + 4, width: Math.max(1, w), height: rowH - 10, rx: 3, fill: r.color || 'var(--accent)' }),
      s('text', { x: labelW + w + 6, y: y + rowH / 2 + 2 }, r.text ?? format(r.value)),
    );
  });
  return svg;
}

/**
 * Scatter with optional Pareto frontier: points [{ x, y, label, color, frontier? }]
 * Lower-left is better (smaller and closer to the original).
 */
export function scatter(points, { width = 880, height = 320, xLabel = '', yLabel = '', logY = false, onHover } = {}) {
  const pad = { l: 52, r: 16, t: 14, b: 34 };
  const svg = s('svg', { class: 'chart', viewBox: `0 0 ${width} ${height}`, width });
  if (!points.length) return svg;
  const ty = (v) => (logY ? Math.log10(Math.max(v, 1e-5)) : v);
  const xt = niceTicks(0, Math.max(...points.map((p) => p.x)) * 1.08);
  const yv = points.map((p) => ty(p.y));
  const yt = logY ? niceTicks(Math.min(...yv) - 0.15, Math.max(...yv) + 0.15) : niceTicks(0, Math.max(...yv) * 1.1);
  const X = (x) => pad.l + ((x - xt[0]) / (xt[xt.length - 1] - xt[0] || 1)) * (width - pad.l - pad.r);
  const Y = (y) => pad.t + (1 - (ty(y) - yt[0]) / (yt[yt.length - 1] - yt[0] || 1)) * (height - pad.t - pad.b);
  const grid = s('g', { class: 'grid' });
  for (const t of yt) grid.append(s('line', { x1: pad.l, x2: width - pad.r, y1: Y(logY ? 10 ** t : t), y2: Y(logY ? 10 ** t : t) }), s('text', { x: pad.l - 6, y: Y(logY ? 10 ** t : t) + 3, 'text-anchor': 'end' }, fmt(logY ? 10 ** t : t)));
  for (const t of xt) grid.append(s('text', { x: X(t), y: height - pad.b + 14, 'text-anchor': 'middle' }, fmt(t)));
  svg.append(grid);
  // One frontier line per group (e.g. per format), drawn in the group's colour.
  const groups = new Map();
  for (const p of points.filter((q) => q.frontier)) groups.set(p.group ?? p.color, [...(groups.get(p.group ?? p.color) || []), p]);
  for (const front of groups.values()) {
    front.sort((a, b) => a.x - b.x);
    if (front.length > 1) svg.append(s('path', { d: front.map((p, i) => `${i ? 'L' : 'M'}${X(p.x)},${Y(p.y)}`).join(''), fill: 'none', stroke: front[0].color || 'var(--accent)', 'stroke-dasharray': '4 4', 'stroke-width': 1.5, 'stroke-opacity': 0.7 }));
  }
  for (const p of points) {
    const g = s('g', { style: { cursor: 'default' } }, s('circle', { cx: X(p.x), cy: Y(p.y), r: 6, fill: p.color || 'var(--accent)', 'fill-opacity': 0.9, stroke: 'var(--panel)', 'stroke-width': 1.5 }), s('text', { x: X(p.x) + 9, y: Y(p.y) + 3 }, p.label));
    if (onHover) g.addEventListener('mouseenter', () => onHover(p));
    svg.append(g);
  }
  svg.append(s('text', { x: width - pad.r, y: height - 4, 'text-anchor': 'end' }, xLabel), s('text', { x: 4, y: 10 }, yLabel));
  return svg;
}

/** Marks Pareto-optimal points (no other point is both smaller and better). */
export function paretoFrontier(points) {
  for (const p of points) p.frontier = !points.some((q) => q !== p && q.x <= p.x && q.y <= p.y && (q.x < p.x || q.y < p.y));
  return points;
}

export function legend(items) {
  return h('div', { class: 'xray-legend' }, items.map((i) => h('span', null, h('i', { style: { background: i.color } }), i.label)));
}
