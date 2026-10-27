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
  `Data: my coffee log, ${facts.n_bags} bags from ${facts.n_roasters} roasters, opened ${fmtFact(facts.first_opened, 'month')} – ${fmtFact(facts.last_opened, 'month')}. Built ${d3.utcFormat('%b %-d, %Y')(new Date(facts.generated_at))} Map outlines: Natural Earth via world-atlas.`;

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
    if (g < 0) { root.style('display', 'none'); streamOn = false; return 0; }
    let tip, kOpacity = 1;
    streamOn = g > 1.01 && g < 3;
    if (g < 1) { const p = ease(clamp((g - 0.5) / 0.5)); tip = [lerp(70, 0, p), lerp(-110, 0, p)]; kOpacity = clamp((g - 0.4) / 0.15); }
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
    v60.style('opacity', (1 - m) * clamp(g / 0.4)).attr('transform', `scale(${1 - 0.06 * m})`);
    bed.style('opacity', (1 - clamp(m * 1.6)) * clamp((g - 0.35) / 0.15));
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

// ---------- intro: roasters → varieties → ZP6 grinder → grounds → scatterplot → V60 ----------
// Five scroll steps before the pour. The pour scene runs on g - INTRO.
const INTRO = 5;

// Dots are colored by where the coffee grew (3 categories: the most the palette supports for overlapping dots).
const CONTINENT = {
  Americas: ['Colombia', 'Ecuador', 'Guatemala', 'Costa Rica', 'Nicaragua', 'Peru', 'Mexico', 'Honduras', 'El Salvador', 'Panama', 'Brazil', 'Bolivia'],
  Africa: ['Ethiopia', 'Kenya', 'Burundi', 'Rwanda', 'Uganda', 'Tanzania', 'Malawi', 'Zambia', 'Congo', 'DR Congo'],
  'Asia & Pacific': ['India', 'East Timor', 'Indonesia', 'Yemen', 'China', 'Papua New Guinea', 'Vietnam', 'Thailand', 'Myanmar', 'Laos'],
};
const CONT_ORDER = Object.keys(CONTINENT);
const contSlot = b => {
  const cs = [...new Set(b.countries.map(c => CONT_ORDER.find(k => CONTINENT[k].includes(c)) ?? 'Unknown'))];
  return cs.length === 1 && cs[0] !== 'Unknown' ? CONT_ORDER.indexOf(cs[0]) + 1 : 0; // 0 = blend/unknown, neutral gray
};
const MULTI = 'Multiple varieties';
const GRIND = '4.0–5.5'; // Scott's usual ZP6 dial range for pour-over

function lumpGroups(groups, otherLabel) { // { name: {n, mean} } → rows; n < 3 lumped into one Other row, kept last
  const rows = Object.entries(groups).map(([name, v]) => ({ name, n: v.n, mean: v.mean }));
  const big = rows.filter(r => r.n >= 3).sort((a, b) => b.n - a.n || b.mean - a.mean);
  const small = rows.filter(r => r.n < 3);
  if (small.length) {
    const n = d3.sum(small, r => r.n);
    big.push({ name: otherLabel, n, mean: d3.sum(small, r => r.n * r.mean) / n, other: small.length });
  }
  return big;
}
const roasterRows = lumpGroups(facts.by_roaster, 'Other roasters');
const varietyRows = lumpGroups(facts.by_variety, 'Other varieties');
const f2 = v => v.toFixed(2);

{ // prose built from facts, so the wording follows the data
  const regulars = roasterRows.filter(r => !r.other && r.name !== 'Home roast' && r.n >= 5);
  const best = d3.greatest(regulars, r => r.mean);
  const home = facts.by_roaster['Home roast'];
  document.getElementById('roaster-text').innerHTML =
    `I've bought from <span class="num">${facts.n_roasters}</span> roasters and gone back to <span class="num">${facts.n_repeat_roasters}</span> of them for another bag.` +
    (best ? ` ${best.name} has my best average among roasters I've bought from at least five times: <span class="num">${f2(best.mean)}</span> over ${best.n} bags.` : '') +
    (home ? ` My own home roasts average <span class="num">${f2(home.mean)}</span> (n=${home.n}). I attribute two of the poor ratings to the quality of the green beans when I received them.` : '');
  const named = varietyRows.filter(r => !r.other && r.name !== MULTI);
  const most = named[0];
  const top = d3.greatest(named.filter(r => r.n >= 4), r => r.mean);
  document.getElementById('variety-text').innerHTML =
    `The variety I've bought most is ${most.name} (${most.n} bags). It averages <span class="num">${f2(most.mean)}</span>, ${most.mean < facts.rating.mean ? 'below' : 'above'} my overall average of <span class="num">${f2(facts.rating.mean)}</span>.` +
    (top && top !== most ? ` ${top.name} has the highest average of any variety I've had at least four times: <span class="num">${f2(top.mean)}</span> (n=${top.n}).` : '');
}

function Intro(svg, tipEl) {
  const defs = svg.select('defs');
  const cyl = defs.append('linearGradient').attr('id', 'cyl');
  [[0, '--steel-lo'], [0.22, '--steel-hi'], [0.55, '--steel'], [1, '--steel-lo']]
    .forEach(([o, c]) => cyl.append('stop').attr('offset', o).attr('style', `stop-color: var(${c})`));

  const px = svg.append('g').attr('class', 'intro');
  const sceneG = svg.append('g');
  const scatterAxes = px.append('g');
  const stripGrid = px.append('g');
  const rowsR = px.append('g');
  const rowsV = px.append('g');
  const coarseG = px.append('g');
  const dotsG = px.append('g');

  // --- the ZP6, side view, scene units: upper body −150..80, catch cup 80..172
  const CUP_TOP = 80;
  const grinder = sceneG.append('g');
  const upper = grinder.append('g');
  const crankBack = upper.append('g');
  upper.append('rect').attr('x', -58).attr('y', -150).attr('width', 116).attr('height', CUP_TOP + 152).attr('rx', 4).attr('fill', 'url(#cyl)');
  upper.append('rect').attr('class', 'grip').attr('x', -59).attr('y', -64).attr('width', 118).attr('height', 120).attr('rx', 3);
  upper.append('g').selectAll('line').data(d3.range(-52, 53, 6)).join('line').attr('class', 'knurl')
    .attr('x1', d => d).attr('x2', d => d).attr('y1', -60).attr('y2', 52);
  upper.append('rect').attr('x', -64).attr('y', -172).attr('width', 128).attr('height', 22).attr('rx', 3).attr('fill', 'url(#cyl)');
  upper.append('g').selectAll('line').data(d3.range(-56, 57, 7)).join('line').attr('class', 'tick-mark')
    .attr('x1', d => d).attr('x2', d => d).attr('y1', -168).attr('y2', (d, i) => i % 2 ? -160 : -155);
  const hopper = upper.append('ellipse').attr('class', 'steel-dark').attr('cy', -172).attr('rx', 54).attr('ry', 7);
  const crankFront = upper.append('g');
  const cup = grinder.append('g');
  cup.append('rect').attr('x', -58).attr('y', CUP_TOP).attr('width', 116).attr('height', 172 - CUP_TOP).attr('rx', 6).attr('fill', 'url(#cyl)');
  cup.append('line').attr('class', 'seam').attr('x1', -58).attr('x2', 58).attr('y1', CUP_TOP + 1).attr('y2', CUP_TOP + 1);
  const crank = [crankBack, crankFront].map(gEl => {
    const arm = gEl.append('line').attr('class', 'crank-arm').attr('y1', -196).attr('y2', -196);
    const knob = gEl.append('rect').attr('class', 'knob').attr('width', 24).attr('height', 52).attr('rx', 11).attr('y', -250);
    return { gEl, arm, knob };
  });
  const shaft = upper.append('g');
  shaft.append('rect').attr('class', 'steel-dark').attr('x', -6).attr('y', -198).attr('width', 12).attr('height', 26);
  shaft.append('circle').attr('class', 'steel-dark').attr('cy', -196).attr('r', 11);

  // --- beans: one per bag
  const r1 = rng(11);
  const beans = d3.range(facts.n_bags).map(() => ({ x: (r1() - 0.5) * 80, y0: -330 - r1() * 260, u: r1(), rot: r1() * 180, spin: (r1() - 0.5) * 540 }));
  const beanSel = sceneG.append('g').selectAll('g').data(beans).join('g').style('opacity', 0);
  beanSel.append('ellipse').attr('class', 'bean').attr('rx', 7.5).attr('ry', 5.2);
  beanSel.append('path').attr('class', 'bean-crease').attr('d', 'M-6,0 C-2,-2 2,2 6,0');

  // --- grounds: coarse particles fall away; fines are one dot per rated bag
  const coarse = d3.range(150).map(() => ({ u: r1(), dx: (r1() - 0.5) * 2, r: 1.2 + r1() * 1.6 }));
  const coarseSel = coarseG.selectAll('circle').data(coarse).join('circle').attr('class', 'grain-a').attr('r', d => d.r);

  // rows: groups with ≥ 3 bags, sorted by average rating, the rest lumped into one Other row (last)
  const rowsOf = (items, key, otherLabel) => {
    const counts = d3.rollup(items, v => v.length, key);
    const rowName = it => counts.get(key(it)) >= 3 ? key(it) : otherLabel;
    const rows = d3.groups(items, rowName).map(([name, v]) => ({ name, n: v.length, mean: d3.mean(v, it => it.b.rating), other: name === otherLabel }))
      .sort((a, b) => a.other - b.other || b.mean - a.mean);
    return { rows, rowName };
  };
  const fines = rated.map(b => ({ b, u: r1(), j: r1() - 0.5, br: Math.sqrt(r1()) * 135, bth: r1() * TAU, slot: contSlot(b) }));
  const roasterRowsP = rowsOf(fines, f => f.b.roaster, 'Other roasters');
  fines.forEach(f => { f.rRow = roasterRowsP.rowName(f); });
  // a bag that lists several varieties can't be split between them; it goes in the Multiple varieties row
  const withVariety = fines.filter(f => f.b.varieties.length);
  withVariety.forEach(f => { f.v = f.b.variety_group; });
  const varietyRowsP = rowsOf(withVariety, f => f.v, 'Other varieties');
  varietyRowsP.rows.sort((a, b) => (a.other || a.name === MULTI) - (b.other || b.name === MULTI) || (a.name === MULTI) - (b.name === MULTI) || b.mean - a.mean);
  withVariety.forEach(f => { f.vRow = varietyRowsP.rowName(f); });

  const dots = fines;
  const dotSel = dotsG.selectAll('g').data(dots).join('g').style('opacity', 0);
  dotSel.append('circle').attr('class', 'hit').attr('r', 9);
  dotSel.append('circle').attr('class', d => `fine c-${d.slot}`);
  dotSel.append('circle').attr('class', 'fine-bed'); // brown copy that fades in as the dots drop into the V60
  dotSel.on('pointerenter pointerdown', (ev, d) => {
    const b = d.b;
    tip(ev, bagName(b), d.slot, [['Rating', b.rating], ['Price per cup', b.price_per_cup == null ? '—' : d3.format('$.2f')(b.price_per_cup)],
      ['Origin', b.countries.join(', ') || '—'], ['Variety', b.varieties.join(', ') || '—']]);
  }).on('pointerleave', () => { tipEl.hidden = true; });

  const priceMax = AXES.find(a => a.key === 'price_per_cup').max;
  const x = d3.scaleLinear().domain([0, priceMax]);
  const rate = d3.scaleLinear().domain(d3.extent(fines, d => d.b.rating)).nice();
  const y = rate.copy();

  function tip(ev, title, slot, rows) {
    const [tx, ty] = d3.pointer(ev, tipEl.parentElement);
    tipEl.innerHTML = `<div class="tip-name">${slot != null ? `<span class="swatch dot c-${slot}"></span>` : ''}<strong>${title}</strong></div>` +
      rows.map(([k, v]) => `<div class="tip-row"><span>${k}</span><span class="v">${v}</span></div>`).join('');
    tipEl.style.left = `${tx}px`; tipEl.style.top = `${ty}px`; tipEl.hidden = false;
  }

  let L, k = 1, P = [0, 0];
  const toPx = (sx, sy) => [L.cx + sx * k, L.cy + sy * k];

  function drawRows(gEl, rows, layout) {
    gEl.selectAll('*').remove();
    const { yOf, rowH, x0, x1, labelX, narrow } = layout;
    const row = gEl.selectAll('g').data(rows).join('g').attr('transform', r => `translate(0,${yOf(r.name)})`);
    row.append('text').attr('class', 'bar-name').attr('x', labelX).attr('text-anchor', 'end').attr('dy', '0.35em')
      .text(r => narrow && r.name.length > 15 ? r.name.slice(0, 14) + '…' : r.name).append('title').text(r => r.name);
    row.append('line').attr('class', 'row-rule').attr('x1', x0).attr('x2', x1).attr('y1', rowH / 2).attr('y2', rowH / 2);
    row.append('line').attr('class', 'mean-tick').attr('x1', r => rate(r.mean)).attr('x2', r => rate(r.mean)).attr('y1', -rowH * 0.38).attr('y2', rowH * 0.38);
    row.append('text').attr('class', 'bar-val').attr('x', x1 + 10).attr('dy', '0.35em')
      .html(r => `${f2(r.mean)} <tspan class="bar-n">· ${r.n}</tspan>`);
  }

  function resize(layout) {
    L = layout; k = L.R / SCENE_R;
    sceneG.attr('transform', `translate(${L.cx},${L.cy}) scale(${k})`);
    P = toPx(40, -40);

    // scatterplot: price per cup × rating
    const pw = Math.min(L.W - 84, 640), ph = Math.min(L.H - 80, pw * 0.8);
    const ox = L.cx - pw / 2 + 24, oy = L.cy - ph / 2 - 6;
    x.range([ox, ox + pw]); y.range([oy + ph, oy]);
    scatterAxes.selectAll('*').remove();
    scatterAxes.append('g').selectAll('line').data(y.ticks(5)).join('line').attr('class', 'ring')
      .attr('x1', ox).attr('x2', ox + pw).attr('y1', d => y(d)).attr('y2', d => y(d));
    scatterAxes.append('g').selectAll('text').data(y.ticks(5)).join('text').attr('class', 'axis-end').attr('text-anchor', 'end')
      .attr('x', ox - 8).attr('y', d => y(d)).attr('dy', '0.32em').text(d => d);
    scatterAxes.append('g').selectAll('text').data(x.ticks(L.narrow ? 4 : 6)).join('text').attr('class', 'axis-end').attr('text-anchor', 'middle')
      .attr('x', d => x(d)).attr('y', oy + ph + 18).text(d3.format('$.2f'));
    scatterAxes.append('line').attr('class', 'ring outer').attr('x1', ox).attr('x2', ox + pw).attr('y1', oy + ph).attr('y2', oy + ph);
    scatterAxes.append('text').attr('class', 'axis-label').attr('x', ox + pw).attr('y', oy + ph + 38).attr('text-anchor', 'end').text('Price per cup →');
    scatterAxes.append('text').attr('class', 'axis-label').attr('x', ox - 8).attr('y', oy - 12).attr('text-anchor', 'start').text('↑ Rating');

    // dot plots: one row per roaster / variety, rating along x, a tick at each row's average
    const cw = Math.min(L.W - 8, 700), labelW = L.narrow ? 96 : 156, rightW = L.narrow ? 74 : 84;
    const left = L.cx - cw / 2, x0 = left + labelW + 10, x1 = left + cw - rightW;
    rate.range([x0, x1]);
    const stripLayout = rows => {
      const rowH = Math.min(34, (L.H - 60) / rows.length), top = L.cy - rowH * rows.length / 2 - 10;
      const idx = new Map(rows.map((r, i) => [r.name, i]));
      return { rowH, x0, x1, labelX: x0 - 10, narrow: L.narrow, yOf: name => top + idx.get(name) * rowH + rowH / 2, bottom: top + rows.length * rowH };
    };
    const lr = stripLayout(roasterRowsP.rows), lv = stripLayout(varietyRowsP.rows);
    drawRows(rowsR, roasterRowsP.rows, lr);
    drawRows(rowsV, varietyRowsP.rows, lv);
    stripGrid.selectAll('*').remove();
    const ticks = rate.ticks(L.narrow ? 4 : 6);
    stripGrid.append('g').selectAll('line').data(ticks).join('line').attr('class', 'ring')
      .attr('x1', d => rate(d)).attr('x2', d => rate(d)).attr('y1', L.cy - (L.H - 60) / 2 - 10).attr('y2', L.cy + (L.H - 60) / 2 - 10);
    stripGrid.append('g').selectAll('text').data(ticks).join('text').attr('class', 'axis-end').attr('text-anchor', 'middle')
      .attr('x', d => rate(d)).attr('y', L.cy + (L.H - 60) / 2 + 6).text(d => d);
    stripGrid.append('text').attr('class', 'axis-label').attr('x', x1).attr('y', L.cy + (L.H - 60) / 2 + 24).attr('text-anchor', 'end').text('Rating →');

    const place = (lay, name, j) => [0, lay.yOf(name) + j * lay.rowH * 0.56];
    dots.forEach(d => {
      d.sx = d.b.price_per_cup != null ? x(d.b.price_per_cup) : null; d.sy = y(d.b.rating);
      d.rx = rate(d.b.rating); d.ry = place(lr, d.rRow, d.j)[1];
      d.vx = rate(d.b.rating); d.vy = d.vRow ? place(lv, d.vRow, d.j)[1] : null;
      [d.bx, d.by] = toPx(d.br * Math.cos(d.bth), d.br * Math.sin(d.bth));
    });
  }

  function update(g) {
    if (!L) return; // not measured yet; resize() draws again
    px.style('display', g >= INTRO + 0.6 ? 'none' : null);
    sceneG.style('display', g >= 3 ? 'none' : null);
    if (g >= INTRO + 0.6) return;

    // step 0: beans pour into the open hopper; step 1: crank goes on and turns
    beanSel.style('opacity', d => { const t = (g - 0.25 - 0.5 * d.u) / 0.2; return t > 0 && t < 1 ? 1 : 0; })
      .attr('transform', d => { const t = clamp((g - 0.25 - 0.5 * d.u) / 0.2); return `translate(${d.x * (1 - t * 0.6)},${lerp(d.y0, -168, t * t)}) rotate(${d.rot + d.spin * t})`; });
    hopper.style('opacity', 1 - clamp((g - 0.9) / 0.1));
    const crankOn = clamp((g - 0.9) / 0.15), theta = clamp(g - 1, 0, 1) * TAU * 5;
    const lx = 150 * Math.cos(theta), behind = Math.sin(theta) < 0;
    crank.forEach((c, i) => {
      c.gEl.style('opacity', ((i === 0) === behind) ? crankOn : 0);
      c.arm.attr('x1', 0).attr('x2', lx);
      c.knob.attr('x', lx - 12);
    });
    shaft.style('opacity', crankOn);

    // step 2: body lifts away, catch cup tips, coarse grounds fall; fines fly to the scatterplot
    const p = g - 2, e = ease(clamp(p / 0.2));
    upper.attr('transform', `translate(0,${-80 * e})`).style('opacity', 1 - clamp(p / 0.2));
    cup.attr('transform', `translate(${40 * e},${lerp(CUP_TOP, -40, e)}) rotate(${-135 * e}) translate(0,${-CUP_TOP})`)
      .style('opacity', 1 - clamp((p - 0.4) / 0.12));
    const ct = d => clamp((p - 0.12 - 0.15 * d.u) / 0.2);
    coarseSel.style('opacity', d => { const t = (p - 0.12 - 0.15 * d.u) / 0.2; return t > 0 && t < 1 ? 1 - t : 0; })
      .attr('cx', d => P[0] + d.dx * ct(d) * 60 * k).attr('cy', d => P[1] + ct(d) ** 2 * 420 * k);

    // steps 3–4: same dots re-sort into roaster rows, then variety rows; step 5: into the V60
    const t3 = ease(clamp((g - 3) / 0.35)), t4 = ease(clamp((g - 4) / 0.35)), q = g - INTRO, drop = ease(clamp(q / 0.35));
    const gone = 1 - clamp((q - 0.3) / 0.15);
    scatterAxes.style('opacity', clamp((p - 0.35) / 0.15) * (1 - t3));
    stripGrid.style('opacity', t3 * (1 - clamp(q / 0.15)));
    rowsR.style('opacity', t3 * (1 - t4));
    rowsV.style('opacity', t4 * (1 - clamp(q / 0.15)));

    dotSel.each(function (d) {
      const fly = clamp((p - 0.15 - 0.2 * d.u) / 0.25), flyE = d3.easeCubicOut(fly);
      const sx = d.sx ?? d.rx, sy = d.sx != null ? d.sy : d.ry;
      const ax = lerp(P[0], sx, flyE), ay = lerp(P[1], sy, flyE);
      const bx = lerp(ax, d.rx, t3), by = lerp(ay, d.ry, t3);
      const x0 = d.vy != null ? lerp(bx, d.vx, t4) : bx, y0 = d.vy != null ? lerp(by, d.vy, t4) : by;
      let op = p < 0 || fly <= 0 ? 0 : (d.sx != null ? 1 : t3);
      if (d.vy == null) op *= 1 - t4;
      d3.select(this).style('opacity', op * gone)
        .attr('transform', `translate(${lerp(x0, d.bx, drop)},${lerp(y0, d.by, drop)})`)
        .style('pointer-events', g > 2.45 && g < INTRO && op > 0.5 ? null : 'none')
        .selectAll('.fine, .fine-bed').attr('r', lerp(lerp(2, 3.5, fly), 2, drop));
      d3.select(this).select('.fine-bed').style('opacity', clamp(drop * 1.6));
    });
  }

  function readout(g) {
    if (g < 2) return `<div class="timer"><span>Coffee<b>${facts.dose_g} g</b></span><span>Grinder<b>1Zpresso ZP6</b></span><span>Dial<b>${GRIND}</b></span></div>`;
    if (g >= INTRO) return `<div class="timer"><span>Time<b>0:00</b></span><span>Water<b>0 g</b></span><span>Coffee<b>${facts.dose_g} g</b></span></div>`; // dots are brown grounds now
    const present = [...new Set(fines.map(f => f.slot))].sort((a, b) => (a || 9) - (b || 9)); // neutral gray last
    return `<div class="legend">${present.map(s => `<span class="legend-item"><span class="swatch dot c-${s}"></span><span class="label">${s ? CONT_ORDER[s - 1] : 'Blend or unknown'}</span></span>`).join('')}</div>`;
  }

  return { update, resize, readout };
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
const intro = Intro(svg, document.getElementById('tip'));

let layout = { cx: 0, cy: 0, k: 1 };
function computeLayout(el) {
  const { width: W, height: H } = el.getBoundingClientRect();
  const narrow = W < 560;
  const R = Math.max(60, Math.min(W / 2 - (narrow ? 72 : 112), H / 2 - 46));
  return { W, H, cx: W / 2, cy: H / 2, R, narrow };
}

let g = 0, mode = null;
function draw() {
  const gp = g - INTRO;
  intro.update(g);
  const m = scene.update(gp);
  radar.gridOpacity(m);
  if (gp < 0.5) {
    radar.set([avg], { duration: 0, morph: 0 });
    if (mode !== 'intro') { mode = 'intro'; radar.hideTip(); }
    const html = intro.readout(g);
    if (readout.dataset.intro !== html) { readout.innerHTML = html; readout.dataset.intro = html; readout.dataset.legend = ''; }
  } else if (gp < 4) {
    readout.dataset.intro = '';
    radar.set([avg], { duration: 0, morph: m });
    if (mode !== 'pour') { mode = 'pour'; radar.hideTip(); }
    if (m < 0.5) {
      const [t, w] = brewAt(gp);
      readout.innerHTML = `<div class="timer"><span>Time<b>${mmss(t)}</b></span><span>Water<b>${Math.round(w)} g</b></span><span>Coffee<b>${facts.dose_g} g</b></span></div>`;
    } else if (readout.dataset.legend !== 'avg') {
      readout.innerHTML = '<div class="legend"></div>';
      renderLegend(readout.firstChild, [avg]);
    }
    readout.dataset.legend = m < 0.5 ? '' : 'avg';
  } else {
    const idx = Math.min(7, Math.floor(gp));
    if (mode !== idx) {
      mode = idx;
      if (readout.dataset.intro) { readout.innerHTML = ''; readout.dataset.intro = ''; } // jumped straight from the intro
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
  intro.resize(L);
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
  // Presets: favorite, the median-rated bag, least favorite. Ties go to the bag with more facets logged.
  const facetsLogged = b => AXES.filter(a => val(b, a.key) != null).length;
  const ranked = list.filter(b => b.rating != null).sort((a, b) => b.rating - a.rating || facetsLogged(b) - facetsLogged(a));
  const n = ranked.length;
  const lowest = ranked.filter(b => b.rating === ranked[n - 1]?.rating).sort((a, b) => facetsLogged(b) - facetsLogged(a))[0];
  const top = n >= 3 ? [ranked[0], ranked[Math.floor((n - 1) / 2)], lowest] : n === 2 ? [ranked[0], null, lowest] : [ranked[0]];
  const presets = top.map(b => b?.bag_id ?? '');
  originBar.attr('aria-pressed', o => String(o.id === origin));
  pickers.select('select')
    .call(sel => sel.selectAll('option').data([null, ...list], b => b?.bag_id ?? '').join('option')
      .attr('value', b => b?.bag_id ?? '').text(b => b ? `${b.rating ?? '–'} · ${bagName(b)}` : 'None').order())
    .property('value', i => presets[i - 1] ?? '');
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

// ---------- origins map ----------
// Country bubbles at each country's centroid: size = bags rated, color = average rating.
// Countries with fewer than 3 bags show their count but no average (same n < 3 rule as the charts).
const COUNTRY_ALIASES = { 'East Timor': 'Timor-Leste' }; // log name → map name
const mapSection = document.querySelector('.origin-map');
let world;
try { world = await d3.json('data/geo/countries-110m.json'); } catch { mapSection.hidden = true; }
if (world) {
  const land = topojson.feature(world, world.objects.countries).features;
  const byName = new Map(land.map(f => [f.properties.name, f]));
  const groups = d3.groups(rated.flatMap(b => b.countries.map(c => ({ c, b }))), d => d.c)
    .map(([name, rows]) => ({ name, n: rows.length, mean: d3.mean(rows, d => d.b.rating), bags: rows.map(d => d.b),
      feature: byName.get(COUNTRY_ALIASES[name] ?? name) }))
    .sort((a, b) => b.n - a.n);
  const origins = groups.filter(o => o.feature);
  const unmapped = groups.filter(o => !o.feature).map(o => o.name);
  const originFeatures = new Set(origins.map(o => o.feature));
  const colored = origins.filter(o => o.n >= 3);
  const ratingDomain = d3.extent(colored, o => o.mean);

  // prose from the data
  const [first, second] = origins;
  const bestCountry = d3.greatest(origins.filter(o => o.n >= 5), o => o.mean);
  document.getElementById('map-text').innerHTML =
    `My rated bags came from <span class="num">${groups.length}</span> countries. ${first.name} (${first.n} bags) and ${second.name} (${second.n}) account for most of them.` +
    (bestCountry ? ` ${bestCountry.name} has my best average of any country with at least five bags: <span class="num">${f2(bestCountry.mean)}</span>.` : '') +
    ' Select a country to see its regions.';

  const mapSvg = d3.select('#map');
  const mapTip = document.getElementById('map-tip');
  const panel = d3.select('#map-panel');
  let selected = first;

  function renderPanel(o) {
    const regions = d3.groups(o.bags, b => b.region ?? 'Region not logged')
      .map(([r, bs]) => ({ r, n: bs.length, mean: d3.mean(bs, b => b.rating) }))
      .sort((a, b) => b.n - a.n || b.mean - a.mean);
    const best = d3.greatest(o.bags, b => b.rating);
    const singles = regions.filter(r => r.n === 1);
    panel.html(`<div class="panel-head"><span class="kicker">Selected</span><h3>${o.name}</h3>
      <div class="stat"><b>${o.n}</b> bags · avg <b>${o.n >= 3 ? f2(o.mean) : '—'}</b></div>
      <p class="best">Best bag: <strong>${bagName(best)}</strong>, rated <span class="num">${best.rating}</span></p></div>
      <div class="panel-body"><table><thead><tr><th>Region</th><th class="n">Bags</th><th class="n">Avg</th></tr></thead><tbody>${
        regions.filter(r => r.n >= 2).map(r => `<tr><td>${r.r}</td><td class="n">${r.n}</td><td class="n">${r.n >= 3 ? f2(r.mean) : '—'}</td></tr>`).join('')
      }${singles.length ? `<tr><td colspan="3" class="muted" title="${singles.map(r => r.r).join(', ')}">${singles.length === 1 ? singles[0].r : `${singles.length} more regions`} with 1 bag${singles.length === 1 ? '' : ' each'}</td></tr>` : ''}</tbody></table>
      ${unmapped.length ? `<p class="muted">Not on the map: ${unmapped.join(', ')}</p>` : ''}</div>`);
  }

  function select(o) {
    selected = o;
    mapSvg.selectAll('.land').classed('selected', f => f === o.feature);
    mapSvg.selectAll('.origin-dot').classed('selected', d => d === o);
    renderPanel(o);
  }

  function drawMap() {
    const W = document.getElementById('map-stage').getBoundingClientRect().width;
    if (!W) return;
    const narrow = W < 560;
    const fc = { type: 'FeatureCollection', features: [...originFeatures] };
    const projection = d3.geoEqualEarth().fitWidth(W - 60, fc);
    const path = d3.geoPath(projection);
    const [[x0, y0], [x1, y1]] = path.bounds(fc);
    const [tx, ty] = projection.translate();
    projection.translate([tx + 30 - x0, ty + 40 - y0]);
    const H = Math.round(y1 - y0 + 80);
    mapSvg.attr('viewBox', `0 0 ${W} ${H}`).attr('height', H).selectAll('*').remove();

    const css = getComputedStyle(document.documentElement);
    const color = d3.scaleLinear().domain(ratingDomain)
      .range([css.getPropertyValue('--seq-lo').trim(), css.getPropertyValue('--seq-hi').trim()]).interpolate(d3.interpolateLab);
    const size = d3.scaleSqrt().domain([0, d3.max(origins, o => o.n)]).range([0, Math.max(18, Math.min(42, W / 28))]);

    mapSvg.append('g').selectAll('path').data(land).join('path')
      .attr('class', f => `land${originFeatures.has(f) ? ' origin' : ''}`).attr('d', path)
      .on('click', (ev, f) => { const o = origins.find(o => o.feature === f); if (o) select(o); });

    // bubbles start at centroids, then get nudged apart where countries are close (Rwanda/Burundi)
    const nodes = origins.map(o => { const [cx, cy] = path.centroid(o.feature); return { o, x: cx, y: cy, cx, cy, r: Math.max(5, size(o.n)) }; });
    const sim = d3.forceSimulation(nodes).force('x', d3.forceX(d => d.cx).strength(0.4)).force('y', d3.forceY(d => d.cy).strength(0.4))
      .force('collide', d3.forceCollide(d => d.r + 2)).stop();
    for (let i = 0; i < 160; i++) sim.tick();

    mapSvg.append('g').selectAll('circle').data(nodes.sort((a, b) => b.r - a.r)).join('circle')
      .attr('class', d => `origin-dot${d.o.n < 3 ? ' few' : ''}`)
      .attr('cx', d => d.x).attr('cy', d => d.y).attr('r', d => d.r)
      .attr('fill', d => d.o.n >= 3 ? color(d.o.mean) : null)
      .attr('tabindex', 0).attr('role', 'button')
      .attr('aria-label', d => `${d.o.name}: ${d.o.n} bags${d.o.n >= 3 ? `, average ${f2(d.o.mean)}` : ''}`)
      .datum(d => d.o).each(function (o, i, els) { this.__node = nodes.find(n => n.o === o); })
      .on('click', (ev, o) => select(o))
      .on('keydown', (ev, o) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); select(o); } })
      .on('pointerenter', (ev, o) => {
        const [px, py] = d3.pointer(ev, mapTip.parentElement);
        mapTip.innerHTML = `<div class="tip-name"><strong>${o.name}</strong></div>` +
          `<div class="tip-row"><span>Bags rated</span><span class="v">${o.n}</span></div>` +
          `<div class="tip-row"><span>Average rating</span><span class="v">${o.n >= 3 ? f2(o.mean) : 'fewer than 3 bags'}</span></div>`;
        mapTip.style.left = `${px}px`; mapTip.style.top = `${py}px`; mapTip.hidden = false;
      })
      .on('pointerleave', () => { mapTip.hidden = true; });

    // direct labels for the bigger origins
    const labeled = nodes.filter(d => d.o.n >= (narrow ? 10 : 5));
    const lab = mapSvg.append('g').selectAll('text').data(labeled).join('text').attr('class', 'map-label')
      .attr('x', d => d.x + d.r + 5).attr('y', d => d.y).attr('dy', '0.35em');
    lab.append('tspan').text(d => d.o.name);
    lab.append('tspan').attr('class', 'n').attr('dx', 4).text(d => d.o.n);

    // legend: color ramp, size key, and the n < 3 marker
    const sizeKey = [5, d3.max(origins, o => o.n)];
    document.getElementById('map-legend').innerHTML =
      `<span class="ramp">Average rating ${f2(ratingDomain[0])}<span class="bar"></span>${f2(ratingDomain[1])}</span>` +
      `<span>Bags rated <svg width="${size(sizeKey[1]) * 2 + size(sizeKey[0]) * 2 + 12}" height="${size(sizeKey[1]) * 2 + 2}">` +
      sizeKey.map((v, i) => `<circle cx="${i ? size(sizeKey[0]) * 2 + 8 + size(v) : size(v) + 1}" cy="${size(sizeKey[1]) + 1}" r="${size(v)}" fill="none" stroke="currentColor"></circle>`).join('') +
      `</svg> ${sizeKey.join(' and ')}</span>` +
      `<span><span class="few-dot"></span>Fewer than 3 bags: count only, no average</span>`;
    select(selected);
  }
  new ResizeObserver(drawMap).observe(document.getElementById('map-stage'));
  // redraw when the theme flips, since the ramp colors are read from CSS
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', drawMap);
  new MutationObserver(drawMap).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}
