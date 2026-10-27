// story.js — the pour (scroll-scrubbed illustration) and the radar steps that follow.
// Everything reads from data/build/*.json; rebuild the data and the page follows.
/* global d3 */

const TAU = Math.PI * 2;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const clamp = (x, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));
const lerp = (a, b, t) => a + (b - a) * t;
const ease = d3.easeCubicInOut;
const BED_R = 150;
const SCENE_R = 240; // scene units that map to the radar radius, so the whole V60 fits the stage

let bags, facts;
try {
  [bags, facts] = await Promise.all([d3.json('data/build/bags.json'), d3.json('data/build/facts.json')]);
} catch (e) {
  document.body.innerHTML = `<div class="error"><h2>Data not found</h2>
    <p>Run <code>npm run update</code> to fetch the sheet and build <code>data/build/</code>, then serve this folder (for example <code>npx serve .</code>) instead of opening the file directly.</p></div>`;
  throw e;
}

// ---------- prose: numbers from facts.json, stale claims flagged ----------
const getPath = (o, p) => p.split('.').reduce((a, k) => a?.[k], o);
const fmtFact = (v, f) => f === 'month' ? d3.utcFormat('%B %Y')(new Date(v))
  : typeof v !== 'number' ? v : f != null ? v.toFixed(+f) : d3.format(',~f')(v);
document.querySelectorAll('[data-fact]').forEach(el => {
  const v = getPath(facts, el.dataset.fact);
  el.textContent = v == null ? '—' : fmtFact(v, el.dataset.fmt);
});
document.querySelectorAll('[data-claim]').forEach(el => {
  const c = facts.claims.find(c => c.id === el.dataset.claim);
  if (c && !c.holds) {
    el.classList.add('stale');
    el.insertAdjacentHTML('beforeend', '<span class="stale-note">New data no longer supports this sentence. Rewrite it.</span>');
  }
});
document.getElementById('footer').textContent =
  `Data: my coffee log, ${facts.n_bags} bags from ${facts.n_roasters} roasters, opened ${fmtFact(facts.first_opened, 'month')} – ${fmtFact(facts.last_opened, 'month')}. Built ${d3.utcFormat('%b %-d, %Y')(new Date(facts.generated_at))}.`;

// ---------- facets ----------
const niceMax = k => d3.nice(0, d3.max(bags, b => b[k]) ?? 1, 4)[1];
const dec = d3.format('.2~f');
const AXES = [
  { key: 'rating', label: 'Rating', short: 'Rating', max: 10, fmt: dec },
  { key: 'funk', label: 'Clean → funk', short: 'Funk', max: 10, fmt: dec },
  { key: 'development', label: 'Development', short: 'Develop.', max: 10, fmt: dec },
  { key: 'altitude_m', label: 'Altitude', short: 'Altitude', max: niceMax('altitude_m'), fmt: v => `${d3.format(',.0f')(v)} m` },
  { key: 'price_per_cup', label: 'Price per cup', short: 'Price/cup', max: niceMax('price_per_cup'), fmt: d3.format('$.2f') },
];
AXES.forEach(a => { a.scale ??= v => v / a.max; a.end ??= a.fmt(a.max); });
const val = (b, k) => b[k] ?? null;

// ---------- series ----------
const rated = bags.filter(b => b.rating != null);
const bagName = b => `${b.name ?? 'Unnamed bag'} (${b.roaster})`;
const bagSeries = (b, slot) => ({ id: b.bag_id, slot, name: bagName(b), sub: `${b.rating ?? '–'} / 10`,
  values: Object.fromEntries(AXES.map(a => [a.key, val(b, a.key)])) });
const groupSeries = (id, slot, name, rows) => ({ id, slot, name, sub: `n=${rows.length}`,
  values: Object.fromEntries(AXES.map(a => [a.key, d3.mean(rows, b => val(b, a.key)) ?? null])) });

const avg = groupSeries('avg', 'avg', 'Average bag', rated);
const ghost = { ...avg, ghost: true, name: 'Average bag' };

const complete = rated.filter(b => AXES.every(a => val(b, a.key) != null));
const top3 = [...complete].sort((a, b) => b.rating - a.rating || (b.opened_date ?? '').localeCompare(a.opened_date ?? '')).slice(0, 3);
document.getElementById('top3-text').innerHTML = 'Among bags with all five facets logged, the three highest rated are ' +
  top3.map(b => `<strong>${b.name ?? 'Unnamed bag'}</strong> (${b.roaster}), rated <span class="num">${b.rating}</span>`)
    .reduce((s, x, i, arr) => s + (i === 0 ? '' : i === arr.length - 1 ? ', and ' : ', ') + x, '') + '.';

const byProcess = ['Washed', 'Natural', 'Experimental']
  .map(g => [g, rated.filter(b => b.process_group === g)]).filter(([, rows]) => rows.length >= 3);
const funkLow = rated.filter(b => b.funk != null && b.funk <= 6);
const funkHigh = rated.filter(b => b.funk != null && b.funk >= 8);

const STEP_SERIES = {
  4: [avg],
  5: [ghost, ...top3.map((b, i) => bagSeries(b, i + 1))],
  6: [ghost, ...byProcess.map(([g, rows], i) => groupSeries(`p-${g}`, i + 1, g, rows))],
  7: [ghost, groupSeries('funk-low', 1, 'Clean/funk 6 or below', funkLow), groupSeries('funk-high', 2, 'Clean/funk 8 and up', funkHigh)],
};

// ---------- radar ----------
const SEG = 16; // points per edge, so every shape has the same number of points and morphs cleanly
const ang = i => -Math.PI / 2 + i * TAU / AXES.length;
const radius = (a, v) => v == null ? 0 : clamp(a.scale(v));

// Closed cardinal spline through the vertices (tension 0, like Plot's "cardinal-closed"),
// sampled at fixed steps instead of drawn with a d3 curve, so shapes can still morph point-for-point.
function shapeUnits(s) { // [x, y, cos, sin] in unit radius, plus the matching circle direction
  const n = AXES.length;
  const v = AXES.map((a, i) => { const r = radius(a, s.values[a.key]); return [r * Math.cos(ang(i)), r * Math.sin(ang(i))]; });
  const out = [];
  for (let i = 0; i < n; i++) {
    const p0 = v[(i - 1 + n) % n], p1 = v[i], p2 = v[(i + 1) % n], p3 = v[(i + 2) % n];
    for (let t = 0; t < SEG; t++) {
      const u = t / SEG, u2 = u * u, u3 = u2 * u, ca = ang(i) + u * TAU / n;
      const h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
      const at = k => h00 * p1[k] + h10 * (p2[k] - p0[k]) / 2 + h01 * p2[k] + h11 * (p3[k] - p1[k]) / 2;
      // The spline can bulge past the rim between two high vertices; keep it inside the top of the scale.
      let x = at(0), y = at(1);
      const r = Math.hypot(x, y);
      if (r > 1) { x /= r; y /= r; }
      out.push([x, y, Math.cos(ca), Math.sin(ca)]);
    }
  }
  return out;
}
const pathOf = (pts, R) => 'M' + pts.map(p => `${(p[0] * R).toFixed(2)},${(p[1] * R).toFixed(2)}`).join('L') + 'Z';

function Radar(svg, tipEl, { morphFrom = BED_R / SCENE_R } = {}) {
  const root = svg.append('g');
  const grid = root.append('g');
  const shapes = root.append('g');
  const dots = root.append('g');
  let R = 100, series = [], morph = 1, narrow = false;

  function drawGrid() {
    grid.selectAll('*').remove();
    [0.25, 0.5, 0.75, 1].forEach(f => grid.append('circle').attr('class', f === 1 ? 'ring outer' : 'ring').attr('r', R * f));
    AXES.forEach((a, i) => {
      const c = Math.cos(ang(i)), s = Math.sin(ang(i));
      grid.append('line').attr('class', 'spoke').attr('x2', R * c).attr('y2', R * s);
      const lx = (R + 12) * c, ly = (R + 12) * s;
      const anchor = c > 0.3 ? 'start' : c < -0.3 ? 'end' : 'middle';
      const t = grid.append('text').attr('x', lx).attr('y', ly).attr('text-anchor', anchor)
        .attr('dy', s < -0.5 ? '-1.3em' : s > 0.5 ? '0.9em' : '-0.2em');
      t.append('tspan').attr('class', 'axis-label').text(narrow ? a.short : a.label);
      t.append('tspan').attr('class', 'axis-end').attr('x', lx).attr('dy', '1.25em').text(a.end);
    });
  }

  function target(s) {
    return shapeUnits(s).map(p => [lerp(morphFrom * p[2], p[0], morph), lerp(morphFrom * p[3], p[1], morph)]);
  }

  function render(duration) {
    const d = reduceMotion ? 0 : duration;
    const sel = shapes.selectAll('path.shape').data(series, s => s.id);
    sel.exit().interrupt().transition().duration(d / 2).style('opacity', 0).remove();
    const all = sel.enter().append('path').each(function (s) {
      this.__pts = shapeUnits({ values: {} }).map(() => [0, 0]);
      if (s.id === 'avg' && morph < 1) this.__pts = target(s);
    }).merge(sel)
      .attr('class', s => `shape ${s.ghost ? 'ghost' : 's-' + s.slot}`)
      .style('fill-opacity', s => (s.id === 'avg' && morph < 1) ? lerp(0.9, 0.22, morph) : null)
      .style('opacity', s => (s.id === 'avg' && morph < 1) ? clamp(morph * 2.5) : null);
    all.interrupt().each(function (s) {
      const from = this.__pts, to = target(s), el = this;
      if (!d) { el.__pts = to; d3.select(el).attr('d', pathOf(to, R)); return; }
      d3.select(el).transition().duration(d).ease(ease).attrTween('d', () => t => {
        el.__pts = from.map((p, i) => [lerp(p[0], to[i][0], t), lerp(p[1], to[i][1], t)]);
        return pathOf(el.__pts, R);
      });
    });

    const pts = series.filter(s => !s.ghost).flatMap(s => AXES.map((a, i) => ({ s, a, i, v: s.values[a.key], key: `${s.id}|${a.key}` })));
    const pos = p => { const r = radius(p.a, p.v) * R; return `translate(${r * Math.cos(ang(p.i))},${r * Math.sin(ang(p.i))})`; };
    const dsel = dots.selectAll('g.vtx').data(pts, p => p.key);
    dsel.exit().interrupt().remove();
    const denter = dsel.enter().append('g').attr('class', 'vtx').attr('transform', 'translate(0,0)');
    denter.append('circle').attr('class', 'hit').attr('r', 14);
    denter.append('circle').attr('class', 'dot').attr('r', 4.5);
    const dall = denter.merge(dsel).style('opacity', morph < 1 ? 0 : 1).style('pointer-events', morph < 1 ? 'none' : null);
    dall.select('.dot').attr('class', p => `dot s-${p.s.slot}${p.v == null ? ' missing' : ''}`);
    (d ? dall.interrupt().transition().duration(d).ease(ease) : dall.interrupt()).attr('transform', pos);
    dall.on('pointerenter pointerdown', (ev, p) => showTip(ev, p)).on('pointerleave', hideTip);
  }

  function showTip(ev, p) {
    const [x, y] = d3.pointer(ev, tipEl.parentElement);
    tipEl.innerHTML = `<div class="tip-name"><span class="swatch s-${p.s.slot}"></span><strong>${p.s.name}</strong></div>` +
      `<div class="tip-row"><span>${p.a.label}</span><span class="v">${p.v == null ? 'not logged' : p.a.fmt(p.v)}</span></div>`;
    tipEl.style.left = `${x}px`; tipEl.style.top = `${y}px`;
    tipEl.hidden = false;
  }
  const hideTip = () => { tipEl.hidden = true; };

  return {
    resize(cx, cy, r, isNarrow) {
      R = r; narrow = isNarrow;
      root.attr('transform', `translate(${cx},${cy})`);
      drawGrid(); render(0);
    },
    set(next, { duration = 0, morph: m = 1 } = {}) { series = next; morph = m; render(duration); },
    gridOpacity(o) { grid.style('opacity', o); },
    hideTip,
  };
}

// ---------- the pour illustration (scene units; V60 rim radius ≈ 255) ----------
function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const BLOOM_TURNS = 1.5, MAIN_TURNS = 4;
const KETTLE_OFFSET = [16, -16]; // spout tip sits a little up-right of where the stream lands

function pourPos(g) {
  let r, th;
  if (g <= 2) { const p = clamp(g - 1); r = 60 * Math.sin(Math.PI * p); th = p * BLOOM_TURNS * TAU; }
  else { const p = clamp(g - 2); r = 140 * Math.pow(Math.sin(Math.PI * p), 0.7); th = (BLOOM_TURNS + p * MAIN_TURNS) * TAU; }
  return [r * Math.cos(th - Math.PI / 2), r * Math.sin(th - Math.PI / 2)];
}

function Scene(svg) {
  const defs = svg.append('defs');
  const grad = (id, stops, attrs = {}) => {
    const gEl = defs.append('radialGradient').attr('id', id);
    Object.entries(attrs).forEach(([k, v]) => gEl.attr(k, v));
    stops.forEach(([o, c, op = 1]) => gEl.append('stop').attr('offset', o).attr('style', `stop-color: var(${c}); stop-opacity: ${op}`));
  };
  grad('steel', [[0, '--steel-hi'], [0.6, '--steel'], [1, '--steel-lo']], { cx: '35%', cy: '35%', r: '75%' });
  grad('cone', [[0, '--ceramic-deep'], [1, '--ceramic-in']]);
  grad('wetGrad', [[0, '--wet', 0.92], [0.82, '--wet', 0.85], [1, '--wet', 0]]);
  defs.append('filter').attr('id', 'soft').attr('x', '-50%').attr('y', '-50%').attr('width', '200%').attr('height', '200%')
    .append('feGaussianBlur').attr('stdDeviation', 12);

  const root = svg.insert('g', ':first-child');
  const v60 = root.append('g');
  const r1 = rng(7);

  // dripper: shadow, handle tab, flange, cone wall, ribs, filter paper
  v60.append('circle').attr('class', 'shadow').attr('r', 258).attr('cx', 14).attr('cy', 18).attr('filter', 'url(#soft)');
  v60.append('rect').attr('class', 'ceramic').attr('x', -335).attr('y', -34).attr('width', 110).attr('height', 68).attr('rx', 34);
  v60.append('circle').attr('class', 'ceramic').attr('r', 255);
  v60.append('circle').attr('r', 228).attr('fill', 'url(#cone)').attr('stroke', 'var(--ceramic-edge)').attr('stroke-width', 1.5);
  v60.append('circle').attr('class', 'paper').attr('r', 216);
  const rib = d3.line().curve(d3.curveBasis);
  for (let i = 0; i < 18; i++) {
    const th0 = i * TAU / 18;
    v60.append('path').attr('class', 'rib').attr('opacity', 0.35)
      .attr('d', rib(d3.range(160, 216, 8).map(r => { const th = th0 + (r - 70) / 152 * 0.7; return [r * Math.cos(th), r * Math.sin(th)]; })));
  }
  for (let i = 0; i < 9; i++) {
    const th = i * TAU / 9 + 0.3;
    v60.append('line').attr('class', 'crease').attr('opacity', i === 0 ? 1 : 0.5)
      .attr('x1', 150 * Math.cos(th)).attr('y1', 150 * Math.sin(th)).attr('x2', 214 * Math.cos(th)).attr('y2', 214 * Math.sin(th));
  }

  // coffee bed
  const bed = root.append('g');
  bed.append('circle').attr('class', 'grounds').attr('r', BED_R);
  const grains = d3.range(650).map(() => { const r = Math.sqrt(r1()) * (BED_R - 3), th = r1() * TAU; return [r * Math.cos(th), r * Math.sin(th), 0.9 + r1() * 1.8, r1() < 0.55]; });
  bed.append('g').selectAll('circle').data(grains).join('circle')
    .attr('cx', d => d[0]).attr('cy', d => d[1]).attr('r', d => d[2]).attr('class', d => d[3] ? 'grain-a' : 'grain-b');
  const wet = bed.append('circle').attr('fill', 'url(#wetGrad)').attr('r', 0);
  const trail = bed.append('path').attr('class', 'trail').attr('opacity', 0.5);
  const bubbles = d3.range(46).map(() => { const r = Math.sqrt(r1()) * 105, th = r1() * TAU; return { x: r * Math.cos(th), y: r * Math.sin(th), r: 2 + r1() * 5, at: 0.12 + r1() * 0.6, rr: r }; });
  const bubbleSel = bed.append('g').selectAll('circle').data(bubbles).join('circle').attr('class', 'bubble')
    .attr('cx', d => d.x).attr('cy', d => d.y).attr('r', d => d.r).attr('opacity', 0);
  const slurry = bed.append('circle').attr('class', 'slurry').attr('opacity', 0);

  // stream + kettle (top view, origin = spout tip)
  const pour = root.append('g');
  const ripples = pour.append('g');
  const rippleSel = ripples.selectAll('circle').data([0, 1, 2]).join('circle').attr('class', 'ripple');
  const stream = pour.append('circle').attr('class', 'stream').attr('r', 7);
  const kettle = root.append('g');
  const body = [215, -185];
  kettle.append('circle').attr('class', 'shadow').attr('cx', body[0] + 24).attr('cy', body[1] + 30).attr('r', 104).attr('filter', 'url(#soft)');
  const spout = 'M0,0 C18,-4 30,-22 44,-46 S80,-118 128,-128';
  kettle.append('path').attr('class', 'steel-line').attr('stroke-width', 15).attr('d', spout);
  kettle.append('path').attr('class', 'steel-hl').attr('stroke-width', 4).attr('opacity', 0.85).attr('transform', 'translate(-3,-2)').attr('d', spout);
  kettle.append('circle').attr('class', 'steel-dark').attr('r', 5);
  const hx = body[0] + 128 * 0.76, hy = body[1] - 128 * 0.65;
  kettle.append('rect').attr('class', 'handle').attr('x', -15).attr('y', -64).attr('width', 30).attr('height', 128).attr('rx', 15)
    .attr('transform', `translate(${hx},${hy}) rotate(49)`);
  kettle.append('circle').attr('class', 'steel-body').attr('cx', body[0]).attr('cy', body[1]).attr('r', 100).attr('fill', 'url(#steel)');
  kettle.append('circle').attr('cx', body[0]).attr('cy', body[1]).attr('r', 70).attr('fill', 'none').attr('stroke', 'var(--steel-lo)').attr('stroke-width', 1.5);
  kettle.append('circle').attr('class', 'steel-body').attr('cx', body[0]).attr('cy', body[1]).attr('r', 62).attr('fill', 'url(#steel)');
  kettle.append('circle').attr('class', 'handle').attr('cx', body[0]).attr('cy', body[1]).attr('r', 17);

  let streamOn = false, streamAt = [0, 0];
  const trailLine = d3.line().curve(d3.curveCatmullRom);

  function update(g) {
    let tip, kOpacity = 1;
    streamOn = g > 1.01 && g < 3;
    if (g < 1) tip = [lerp(70, 0, ease(clamp((g - 0.2) / 0.8))), lerp(-110, 0, ease(clamp((g - 0.2) / 0.8)))];
    else if (g < 3) tip = pourPos(g);
    else { const p = clamp((g - 3) / 0.35); tip = [lerp(0, 330, ease(p)), lerp(0, -400, ease(p))]; kOpacity = 1 - p; }
    streamAt = tip;
    kettle.attr('transform', `translate(${tip[0] + KETTLE_OFFSET[0]},${tip[1] + KETTLE_OFFSET[1]})`).style('opacity', kOpacity);
    stream.attr('cx', tip[0]).attr('cy', tip[1]).style('opacity', streamOn ? 1 : 0);
    ripples.attr('transform', `translate(${tip[0]},${tip[1]})`).style('opacity', streamOn ? 1 : 0);

    const rWet = g < 1 ? 0 : g < 2 ? 125 * d3.easeQuadOut(clamp((g - 1) * 1.4)) : lerp(125, BED_R, clamp((g - 2) * 3));
    wet.attr('r', rWet * 1.12);
    const gEnd = clamp(g, 1, 3);
    trail.attr('d', g > 1.01 ? trailLine(d3.range(1, gEnd, 0.004).concat(gEnd).map(pourPos)) : null)
      .style('opacity', g < 3 ? null : 1 - clamp((g - 3) / 0.3));
    bubbleSel.attr('opacity', d => {
      const p = g - 1;
      const on = clamp((p - d.at) / 0.12) * (d.rr < rWet ? 1 : 0);
      return on * (1 - clamp((g - 2) / 0.25));
    });
    const sp = clamp(g - 2);
    slurry.attr('r', BED_R + 45 * ease(sp))
      .attr('opacity', g < 2 ? 0 : g < 3 ? 0.55 * clamp(sp * 3) : 0.55 * (1 - clamp((g - 3) / 0.4)));

    const m = clamp((g - 3.4) / 0.5);
    v60.style('opacity', 1 - m).attr('transform', `scale(${1 - 0.06 * m})`);
    bed.style('opacity', 1 - clamp(m * 1.6));
    root.style('display', m >= 1 ? 'none' : null);
    return m;
  }

  function tick(time) {
    if (streamOn && !reduceMotion) rippleSel.attr('r', i => 8 + ((time / 900 + i / 3) % 1) * 30).attr('opacity', i => 1 - ((time / 900 + i / 3) % 1));
    else rippleSel.attr('r', i => 10 + i * 9).attr('opacity', i => 0.7 - i * 0.2);
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  return { root, update };
}

// ---------- brew timer (15 g coffee, 250 g water) ----------
const mmss = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const WATER_G = 250;
const PHASES = [['Bloom', 0, 45], ['Main pour', 45, 120], ['Drawdown', 120, 180]]; // seconds, matches brewAt
document.querySelectorAll('[data-phase]').forEach(el => {
  const [name, from, to] = PHASES[+el.dataset.phase];
  el.textContent = `${mmss(from)}–${mmss(to)} · ${name}`;
});
function brewAt(g) {
  if (g < 1) return [0, 0];
  if (g < 2) { const p = g - 1; return [45 * p, 45 * clamp(p / 0.5)]; }
  if (g < 3) { const p = g - 2; return [45 + 75 * p, 45 + (WATER_G - 45) * p]; }
  return [120 + 60 * clamp((g - 3) / 0.4), WATER_G];
}

// ---------- legend ----------
function renderLegend(el, series) {
  d3.select(el).selectAll('.legend-item').data(series, s => s.id + (s.ghost ? 'g' : ''))
    .join(enter => {
      const item = enter.append('div').attr('class', 'legend-item');
      item.append('span');
      item.append('span').attr('class', 'label');
      item.append('span').attr('class', 'sub');
      return item;
    })
    .call(item => {
      item.select('span').attr('class', s => `swatch ${s.ghost ? 'ghost' : 's-' + s.slot}`);
      item.select('.label').text(s => s.name).attr('title', s => s.name);
      item.select('.sub').text(s => s.sub);
    });
}

// ---------- scrolly wiring ----------
const stageEl = document.getElementById('stage');
const readout = document.getElementById('readout');
const svg = d3.select('#viz');
const scene = Scene(svg);
const radar = Radar(svg, document.getElementById('tip'));

let layout = { cx: 0, cy: 0, k: 1 };
function computeLayout(el) {
  const { width: W, height: H } = el.getBoundingClientRect();
  const narrow = W < 560;
  const R = Math.max(60, Math.min(W / 2 - (narrow ? 72 : 112), H / 2 - 46));
  return { W, H, cx: W / 2, cy: H / 2, R, narrow };
}

let g = 0, mode = null;
function draw() {
  const m = scene.update(g);
  radar.gridOpacity(m);
  if (g < 4) {
    radar.set([avg], { duration: 0, morph: m });
    if (mode !== 'pour') { mode = 'pour'; radar.hideTip(); }
    if (m < 0.5) {
      const [t, w] = brewAt(g);
      readout.innerHTML = `<div class="timer"><span>Time<b>${mmss(t)}</b></span><span>Water<b>${Math.round(w)} g</b></span><span>Coffee<b>${facts.dose_g} g</b></span></div>`;
    } else if (readout.dataset.legend !== 'avg') {
      readout.innerHTML = '<div class="legend"></div>';
      renderLegend(readout.firstChild, [avg]);
    }
    readout.dataset.legend = m < 0.5 ? '' : 'avg';
  } else {
    const idx = Math.min(7, Math.floor(g));
    if (mode !== idx) {
      mode = idx;
      radar.set(STEP_SERIES[idx], { duration: 900 });
      if (!readout.querySelector('.legend')) readout.innerHTML = '<div class="legend"></div>';
      renderLegend(readout.querySelector('.legend'), STEP_SERIES[idx]);
      readout.dataset.legend = String(idx);
    }
  }
}

function resize() {
  const L = computeLayout(stageEl);
  svg.attr('viewBox', `0 0 ${L.W} ${L.H}`);
  scene.root.attr('transform', `translate(${L.cx},${L.cy}) scale(${L.R / SCENE_R})`);
  radar.resize(L.cx, L.cy, L.R, L.narrow);
  layout = L;
  mode = null; draw();
}
new ResizeObserver(resize).observe(stageEl);

// Scroll position -> g = step index + progress through that step, measured at 60% down the viewport.
// Computed from layout on every frame rather than from step events, so fast jumps can't leave a stale state.
const stepEls = [...document.querySelectorAll('.step')];
function scrollG() {
  const line = innerHeight * 0.6;
  for (let i = stepEls.length - 1; i >= 0; i--) {
    const r = stepEls[i].getBoundingClientRect();
    if (r.top <= line) return i + clamp((line - r.top) / r.height);
  }
  return 0;
}
let queued = false;
addEventListener('scroll', () => {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => { queued = false; const next = scrollG(); if (next !== g) { g = next; draw(); } });
}, { passive: true });
g = scrollG(); draw();

// ---------- tasting notes ----------
// Roasters word notes differently ("strawberries", "strawberry jam"), so compare bags by flavor family.
const FAMILIES = [
  ['Berry', /berr|fruits? rouge|red fruit|currant|jam/i],
  ['Stone fruit', /peach|apricot|plum|nectarine|cherr|stone ?fruit|prune/i],
  ['Citrus', /lemon|lime|orange|tangerine|mandarin|grapefruit|citrus|bergamot|yuzu|clementine|kumquat/i],
  ['Tropical', /mango|pineapple|passion|guava|lychee|papaya|tropical|starfruit|banana|coconut|melon|cantaloupe|kiwi/i],
  ['Floral', /floral|flower|blossom|jasmine|rose\b|lavender|lily|violet|hibiscus|honeysuckle|perfum|chamomile|elderflower/i],
  ['Grape & wine', /grape|wine|raisin|pomegranate|fig/i],
  ['Apple & pear', /apple|pear/i],
  ['Sugar & caramel', /honey|caramel|toffee|sugar|candy|vanilla|syrup|molasses|maple|sherbe|marshmallow|butterscotch/i],
  ['Chocolate & nut', /chocola|cocoa|cacao|nut|almond|peanut|praline|marzipan/i],
  ['Tea & spice', /\btea\b|lemongrass|herb|mint|spic|cinnamon|clove|ginger|cardamom/i],
];
const families = note => FAMILIES.filter(([, re]) => re.test(note)).map(([f]) => f);
const splitNotes = s => (s ?? '').split(/\s*(?:,|;|\n|&|\band\b)\s*/i)
  .map(t => t.trim().replace(/[.!]+$/, '')).filter(Boolean)
  .map(t => t[0].toUpperCase() + t.slice(1));

// ---------- explore ----------
const exploreStage = document.getElementById('explore-stage');
const exploreSvg = d3.select('#explore-viz');
const exploreRadar = Radar(exploreSvg, document.getElementById('explore-tip'));
const byRating = [...bags].sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1) || bagName(a).localeCompare(bagName(b)));

// Origins with fewer than 3 bags share an "Other" button, same rule as the charts.
const originCounts = d3.rollups(bags.filter(b => b.country_primary), v => v.length, b => b.country_primary)
  .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
const bigOrigins = new Set(originCounts.filter(([, n]) => n >= 3).map(([c]) => c));
const originOf = b => !b.country_primary ? null : bigOrigins.has(b.country_primary) ? b.country_primary : 'Other';
const otherList = originCounts.filter(([c]) => !bigOrigins.has(c)).map(([c]) => c);
const origins = [
  { id: 'all', label: 'All origins', n: bags.length },
  ...originCounts.filter(([c]) => bigOrigins.has(c)).map(([c, n]) => ({ id: c, label: c, n })),
  ...(otherList.length ? [{ id: 'Other', label: 'Other', n: bags.filter(b => originOf(b) === 'Other').length, title: otherList.join(', ') }] : []),
];
let origin = 'all';
const pool = () => origin === 'all' ? byRating : byRating.filter(b => originOf(b) === origin);
const poolAverage = () => {
  if (origin === 'all') return ghost;
  const rows = pool().filter(b => b.rating != null);
  return { ...groupSeries('avg', 'avg', `${origin === 'Other' ? 'Other origins' : origin} average`, rows), ghost: true };
};

const originBar = d3.select('#origins').selectAll('button').data(origins).join('button')
  .attr('type', 'button').attr('class', 'chip').attr('title', o => o.title ?? null)
  .html(o => `${o.label} <span class="num">${o.n}</span>`)
  .on('click', (ev, o) => { origin = o.id; fillPickers(); updateExplore(600); });

const pickers = d3.select('#pickers').selectAll('.picker').data([1, 2, 3]).join('div').attr('class', 'picker');
pickers.append('label').attr('for', i => `pick-${i}`).html(i => `<span class="swatch s-${i}"></span>Bag ${i}`);
pickers.append('select').attr('id', i => `pick-${i}`).on('change', () => updateExplore(600));

function fillPickers() {
  const list = pool();
  const top = list.filter(b => b.rating != null).slice(0, 3).map(b => b.bag_id);
  originBar.attr('aria-pressed', o => String(o.id === origin));
  pickers.select('select')
    .call(sel => sel.selectAll('option').data([null, ...list], b => b?.bag_id ?? '').join('option')
      .attr('value', b => b?.bag_id ?? '').text(b => b ? `${b.rating ?? '–'} · ${bagName(b)}` : 'None').order())
    .property('value', i => top[i - 1] ?? '');
}
fillPickers();

const byId = new Map(bags.map(b => [b.bag_id, b]));
function updateExplore(duration) {
  const picks = [1, 2, 3].map(i => byId.get(document.getElementById(`pick-${i}`).value)).map((b, i) => b && { b, s: bagSeries(b, i + 1) }).filter(Boolean);
  const ref = poolAverage();
  const series = [ref, ...picks.map(p => p.s)];
  exploreRadar.set(series, { duration });
  renderLegend(document.getElementById('explore-legend'), series);

  renderCards(picks);

  const cols = [
    ['Bag', null], ...AXES.map(a => [a.label, a]),
    ['Variety', 'variety'], ['Roast', 'roast_level'], ['Process', 'process'], ['Origin', 'country_primary'], ['Opened', 'opened_date'],
  ];
  const rows = [...picks.map(p => ({ slot: p.s.slot, name: p.s.name, values: p.s.values, b: p.b })), { slot: 'avg', name: `${ref.name} (${ref.sub})`, values: ref.values }];
  const table = d3.select('#explore-table');
  table.selectAll('thead').data([0]).join('thead').selectAll('tr').data([0]).join('tr')
    .selectAll('th').data(cols).join('th').attr('class', c => c[1] && typeof c[1] === 'object' ? 'n' : null).text(c => c[0]);
  table.selectAll('tbody').data([0]).join('tbody').selectAll('tr').data(rows).join('tr')
    .selectAll('td').data(r => cols.map(c => ({ r, c }))).join('td')
    .attr('class', ({ c }) => c[1] && typeof c[1] === 'object' ? 'n' : null)
    .html(({ r, c }) => {
      if (!c[1]) return `<span class="swatch ${r.slot === 'avg' ? 'ghost' : 's-' + r.slot}"></span>${r.name}`;
      if (typeof c[1] === 'object') { const v = r.values[c[1].key]; return v == null ? '—' : c[1].fmt(v); }
      if (c[1] === 'variety') return r.b?.varieties?.length ? r.b.varieties.join(', ') : '—';
      return r.b?.[c[1]] ?? '—';
    });
}

function renderCards(picks) {
  const cards = picks.map(p => {
    const notes = splitNotes(p.b.roaster_notes).map(text => ({ text, fams: families(text) }));
    return { ...p, notes, fams: new Set(notes.flatMap(n => n.fams)) };
  });
  // A family is "shared" when at least two of the selected bags have it.
  const shared = new Map();
  for (const [f] of FAMILIES) {
    const who = cards.filter(c => c.fams.has(f)).map(c => c.s.slot);
    if (who.length >= 2) shared.set(f, who);
  }
  const common = d3.select('#in-common');
  if (cards.length < 2) common.html('');
  else if (!shared.size) common.html('<span class="label">In common</span><span class="muted">No flavor family shows up in more than one of these bags.</span>');
  else common.html('<span class="label">In common</span>' + [...shared].map(([f, who]) =>
    `<span class="family">${f} <span class="who">${who.map(w => `<span class="swatch s-${w}"></span>`).join('')}</span></span>`).join(''));

  const line = (k, v) => v ? `<div><dt>${k}</dt><dd>${v}</dd></div>` : '';
  d3.select('#bag-cards').selectAll('.bag-card').data(cards, c => c.s.slot + c.b.bag_id).join('article')
    .attr('class', 'bag-card')
    .html(c => {
      const b = c.b;
      const origin = [b.countries.join(', '), b.region].filter(Boolean).join(' · ');
      const chips = c.notes.length
        ? `<ul class="notes">${c.notes.map(n => {
            const sharedFams = n.fams.filter(f => shared.has(f));
            return `<li class="note${sharedFams.length ? ' shared' : ''}" title="${n.fams.length ? n.fams.join(', ') : 'No flavor family'}">${n.text}</li>`;
          }).join('')}</ul>`
        : '<p class="muted">No roaster notes logged.</p>';
      return `<header><span class="swatch s-${c.s.slot}"></span><span class="slot">Bag ${c.s.slot}</span><span class="score">${b.rating ?? '–'}<small> / 10</small></span></header>
        <h3>${b.name ?? 'Unnamed bag'}</h3><p class="roaster">${b.roaster}</p>
        <p class="label">Roaster's notes</p>${chips}
        <dl>${line('Origin', origin)}${line('Variety', b.varieties.join(', '))}${line('Process', b.process)}${line('Producer', b.producer)}${line('Altitude', b.altitude_m && `${d3.format(',')(b.altitude_m)} m`)}</dl>`;
    });
}
function resizeExplore() {
  const L = computeLayout(exploreStage);
  exploreSvg.attr('viewBox', `0 0 ${L.W} ${L.H}`);
  exploreRadar.resize(L.cx, L.cy, L.R, L.narrow);
  updateExplore(0);
}
new ResizeObserver(resizeExplore).observe(exploreStage);
