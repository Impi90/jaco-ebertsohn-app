/* Exercise figure renderer: stick figures from joint angles.
   Angles are absolute degrees in SVG space: 0 = right (the way the figure faces),
   90 = down, -90 = up, 180 = left. 1 = near-side limb (dark), 2 = far-side limb (light). */
const FIG = (() => {
  const L = { torso: 46, head: 9, neck: 15, ua: 26, fa: 24, th: 38, sh: 37, ft: 12 };
  const W = 220, H = 220, FLOOR = 206;
  const rad = d => d * Math.PI / 180;
  const step = (p, a, len) => [p[0] + Math.cos(rad(a)) * len, p[1] + Math.sin(rad(a)) * len];
  const f1 = n => Math.round(n * 10) / 10;

  function solve(q) {
    const s = q.s || {};
    const P = { hip: [0, 0] };
    P.shoulder = step(P.hip, q.t, L.torso);
    P.head = step(P.shoulder, q.n ?? q.t, L.neck);
    const hw = q.front ? 8 : 0, sw = q.front ? 14 : 0;
    P.hip1 = [hw, 0]; P.hip2 = [-hw, 0];
    P.sh1 = [P.shoulder[0] + sw, P.shoulder[1]]; P.sh2 = [P.shoulder[0] - sw, P.shoulder[1]];
    for (const i of [1, 2]) {
      P['elbow' + i] = step(P['sh' + i], q['a' + i], L.ua * (s['a' + i] ?? 1));
      P['hand' + i] = step(P['elbow' + i], q['b' + i], L.fa * (s['b' + i] ?? 1));
      P['knee' + i] = step(P['hip' + i], q['l' + i], L.th * (s['l' + i] ?? 1));
      P['ankle' + i] = step(P['knee' + i], q['k' + i], L.sh * (s['k' + i] ?? 1));
      const fa = q['f' + i] ?? (q.front ? (i === 1 ? 0 : 180) : 0);
      P['toe' + i] = step(P['ankle' + i], fa, (q.front ? 6 : L.ft) * (s['f' + i] ?? 1));
      P['heel' + i] = step(P['ankle' + i], fa + 180, q.front ? 0 : 3);
    }
    return P;
  }

  const ref = (P, r) => {
    if (typeof r === 'string') return P[r];
    const p = P[r[0]];
    return [p[0] + (r[1] || 0), p[1] + (r[2] || 0)];
  };

  function layout(q) {
    const P = solve(q);
    let bodyMax = -Infinity, minY = Infinity, minX = Infinity, maxX = -Infinity;
    const limbPts = ['elbow', 'hand', 'knee', 'ankle', 'toe', 'heel'].flatMap(k => [P[k + '1'], P[k + '2']]);
    for (const p of limbPts) { bodyMax = Math.max(bodyMax, p[1] + 3.5); minY = Math.min(minY, p[1] - 3.5); minX = Math.min(minX, p[0] - 4); maxX = Math.max(maxX, p[0] + 4); }
    for (const p of [P.hip, P.shoulder]) { bodyMax = Math.max(bodyMax, p[1] + 6); minY = Math.min(minY, p[1] - 6); minX = Math.min(minX, p[0] - 7); maxX = Math.max(maxX, p[0] + 7); }
    bodyMax = Math.max(bodyMax, P.head[1] + L.head);
    minY = Math.min(minY, P.head[1] - L.head);
    minX = Math.min(minX, P.head[0] - L.head); maxX = Math.max(maxX, P.head[0] + L.head);
    let floor = bodyMax;
    const props = (q.props || []).map(pr => ({ ...pr }));
    for (const pr of props) {
      if ((pr.t === 'box' || pr.t === 'bench') && pr.top) {
        pr._top = P[pr.top[0]][1] + (pr.top[1] || 0);
        floor = Math.max(floor, pr._top + (pr.h || 0));
      }
    }
    for (const pr of props) if (pr.t === 'air') floor += pr.h;
    for (const pr of props) {
      if (pr.t === 'box' || pr.t === 'bench') {
        if (pr._top == null) pr._top = floor - (pr.h || 30);
        pr._x1 = ref(P, pr.x1)[0];
        pr._x2 = pr.x2 ? ref(P, pr.x2)[0] : pr._x1 + pr.w;
        minX = Math.min(minX, pr._x1); maxX = Math.max(maxX, pr._x2); minY = Math.min(minY, pr._top);
      } else if (pr.t === 'wall') {
        pr._x = ref(P, pr.x)[0]; minX = Math.min(minX, pr._x - 8); maxX = Math.max(maxX, pr._x + 8);
        minY = Math.min(minY, floor - 175);
      } else if (pr.t === 'post') {
        pr._x = ref(P, pr.x)[0]; pr._top = Math.min(ref(P, pr.x)[1] - 14, floor - 40);
        minX = Math.min(minX, pr._x - 3); maxX = Math.max(maxX, pr._x + 3); minY = Math.min(minY, pr._top);
      } else if (pr.t === 'bar') {
        pr._p = ref(P, pr.at); minY = Math.min(minY, pr._p[1] - 6);
        if (pr.post != null) { minX = Math.min(minX, pr._p[0] + pr.post - 3); maxX = Math.max(maxX, pr._p[0] + pr.post + 3); }
      } else if (pr.t === 'plate') {
        pr._p = [P[pr.at][0] + (pr.dx || 0), P[pr.at][1] + (pr.dy || 0)];
        minY = Math.min(minY, pr._p[1] - pr.r);
      }
    }
    return { P, floor, minY, minX, maxX, props, q };
  }

  const pl = pts => pts.map(p => f1(p[0]) + ',' + f1(p[1])).join(' ');

  function drawFrame(F) {
    const { P, floor, props, q } = F;
    const out = [];
    // supports behind the body
    for (const pr of props) {
      if (pr.t === 'box') {
        out.push(`<rect class="fg-box" x="${f1(pr._x1)}" y="${f1(pr._top)}" width="${f1(pr._x2 - pr._x1)}" height="${f1(floor - pr._top)}" rx="2.5"/>`);
      } else if (pr.t === 'bench') {
        const h = floor - pr._top, slab = Math.min(9, h * 0.35);
        out.push(`<rect class="fg-box" x="${f1(pr._x1)}" y="${f1(pr._top)}" width="${f1(pr._x2 - pr._x1)}" height="${f1(slab)}" rx="2.5"/>`);
        out.push(`<line class="fg-leg" x1="${f1(pr._x1 + 7)}" y1="${f1(pr._top + slab)}" x2="${f1(pr._x1 + 7)}" y2="${f1(floor)}"/>`);
        out.push(`<line class="fg-leg" x1="${f1(pr._x2 - 7)}" y1="${f1(pr._top + slab)}" x2="${f1(pr._x2 - 7)}" y2="${f1(floor)}"/>`);
      } else if (pr.t === 'wall') {
        const top = floor - 175, side = pr.side === 'R' ? 1 : -1;
        out.push(`<line class="fg-wall" x1="${f1(pr._x)}" y1="${f1(top)}" x2="${f1(pr._x)}" y2="${f1(floor)}"/>`);
        for (let y = top + 8; y < floor; y += 14) out.push(`<line class="fg-hatch" x1="${f1(pr._x)}" y1="${f1(y)}" x2="${f1(pr._x + side * 7)}" y2="${f1(y + 7)}"/>`);
      } else if (pr.t === 'post') {
        out.push(`<line class="fg-post" x1="${f1(pr._x)}" y1="${f1(pr._top)}" x2="${f1(pr._x)}" y2="${f1(floor)}"/>`);
      } else if (pr.t === 'bar' && pr.post != null) {
        out.push(`<line class="fg-post" x1="${f1(pr._p[0] + pr.post)}" y1="${f1(pr._p[1] - 4)}" x2="${f1(pr._p[0] + pr.post)}" y2="${f1(floor)}"/>`);
        out.push(`<line class="fg-post" x1="${f1(pr._p[0] + pr.post)}" y1="${f1(pr._p[1])}" x2="${f1(pr._p[0])}" y2="${f1(pr._p[1])}"/>`);
      } else if (pr.t === 'air') {
        const x = (P.toe1[0] + P.toe2[0]) / 2;
        out.push(`<ellipse class="fg-shadow" cx="${f1(x)}" cy="${f1(floor - 1)}" rx="20" ry="3"/>`);
      }
    }
    const limb = (i, cls) => {
      out.push(`<polyline class="${cls}" points="${pl([P['sh' + i], P['elbow' + i], P['hand' + i]])}"/>`);
      out.push(`<polyline class="${cls}" points="${pl([P['hip' + i], P['knee' + i], P['ankle' + i], P['toe' + i]])}"/>`);
      if (!q.front) out.push(`<polyline class="${cls}" points="${pl([P['ankle' + i], P['heel' + i]])}"/>`);
    };
    const handProps = i => { for (const pr of props) if (pr.t === 'db' && pr.at === 'hand' + i) { const p = P[pr.at]; out.push(`<circle class="fg-db" cx="${f1(p[0])}" cy="${f1(p[1])}" r="${pr.r || 6.5}"/><circle class="fg-dbhole" cx="${f1(p[0])}" cy="${f1(p[1])}" r="1.8"/>`); } };
    limb(2, 'fg-far');
    handProps(2);
    if (q.front) {
      out.push(`<polygon class="fg-torso-f" points="${pl([P.sh2, P.sh1, P.hip1, P.hip2])}"/>`);
    } else {
      out.push(`<line class="fg-torso" x1="${f1(P.hip[0])}" y1="${f1(P.hip[1])}" x2="${f1(P.shoulder[0])}" y2="${f1(P.shoulder[1])}"/>`);
    }
    out.push(`<line class="fg-neck" x1="${f1(P.shoulder[0])}" y1="${f1(P.shoulder[1])}" x2="${f1(P.head[0])}" y2="${f1(P.head[1])}"/>`);
    out.push(`<circle class="fg-head" cx="${f1(P.head[0])}" cy="${f1(P.head[1])}" r="${L.head}"/>`);
    limb(1, 'fg-near');
    handProps(1);
    for (const pr of props) {
      if (pr.t === 'plate') out.push(`<circle class="fg-plate" cx="${f1(pr._p[0])}" cy="${f1(pr._p[1])}" r="${pr.r}"/><circle class="fg-dbhole" cx="${f1(pr._p[0])}" cy="${f1(pr._p[1])}" r="2.5"/>`);
      else if (pr.t === 'bar') out.push(`<circle class="fg-bar" cx="${f1(pr._p[0])}" cy="${f1(pr._p[1])}" r="4.5"/>`);
      else if (pr.t === 'band') { const a = ref(P, pr.a), b = ref(P, pr.b); out.push(`<line class="fg-band" x1="${f1(a[0])}" y1="${f1(a[1])}" x2="${f1(b[0])}" y2="${f1(b[1])}"/>`); }
      else if (pr.t === 'pad') { const p = P[pr.at]; out.push(`<rect class="fg-pad" x="${f1(p[0] - 6)}" y="${f1(p[1] - 12)}" width="12" height="7" rx="3"/>`); }
    }
    return out.join('');
  }

  function svg(fig, opts = {}) {
    if (!fig || !fig.frames) return '';
    let frames = fig.frames.map(layout);
    let labels = fig.frames.length > 1 ? (fig.labels || ['Start', 'Finish']) : (fig.labels || []);
    if (opts.only != null) { const i = Math.min(opts.only < 0 ? frames.length - 1 : opts.only, frames.length - 1); frames = [frames[i]]; labels = []; }
    const n = frames.length;
    const wide = n === 1 && opts.only == null;      // single pose shown in the same 2:1 box as a pair
    const VW = wide ? W * 2 : W * n;
    const top = opts.bare || opts.only != null ? 10 : 30;
    let maxW = 0, maxH = 0;
    for (const F of frames) { maxW = Math.max(maxW, F.maxX - F.minX); maxH = Math.max(maxH, F.floor - F.minY); }
    const sc = opts.sc ?? Math.min(1, ((wide ? VW : W) - 26) / maxW, (FLOOR - top) / maxH);
    const parts = [];
    frames.forEach((F, i) => {
      const ox = wide ? 0 : i * W, pw = wide ? VW : W;
      const cx = opts.cx ?? (F.minX + F.maxX) / 2;
      parts.push(`<line class="fg-floor" x1="${ox + 12}" y1="${FLOOR}" x2="${ox + pw - 12}" y2="${FLOOR}"/>`);
      if (labels[i] && !opts.bare) parts.push(`<text class="fg-label" x="${ox + 14}" y="19">${labels[i].toUpperCase()}</text>`);
      if (i > 0) parts.push(`<line class="fg-div" x1="${ox}" y1="12" x2="${ox}" y2="${FLOOR - 8}"/>`);
      parts.push(`<g transform="translate(${f1(ox + pw / 2)} ${FLOOR}) scale(${f1(sc * 1000) / 1000}) translate(${f1(-cx)} ${f1(-F.floor)})">${drawFrame(F)}</g>`);
    });
    const t = opts.title ? String(opts.title).replace(/[<&"]/g, '') : 'Exercise illustration';
    return `<svg class="fig" viewBox="0 0 ${VW} ${H}" role="img" aria-label="${t}" preserveAspectRatio="xMidYMid meet">${parts.join('')}</svg>`;
  }

  // In-between pose for animation: blends every joint angle from the start to the finish position (u = 0…1),
  // keeping the figure in one place and at one size so it moves rather than jumps.
  const DEF = { n: q => q.t, f1: q => (q.front ? 0 : 0), f2: q => (q.front ? 180 : 0) };
  const valOf = (q, k) => (q[k] != null ? q[k] : DEF[k] ? DEF[k](q) : undefined);
  function mixPose(a, b, u) {
    const q = { ...a };
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const va = valOf(a, k), vb = valOf(b, k);
      if (typeof va === 'number' && typeof vb === 'number') q[k] = va + (vb - va) * u;
    }
    if (a.s || b.s) { q.s = {}; for (const k of new Set([...Object.keys(a.s || {}), ...Object.keys(b.s || {})])) { const va = (a.s || {})[k] ?? 1, vb = (b.s || {})[k] ?? 1; q.s[k] = va + (vb - va) * u; } }
    return q;
  }
  const boxCache = new WeakMap();
  function tween(fig, u, title) {
    if (!fig || !fig.frames || fig.frames.length < 2) return svg(fig, { only: 0, title });
    let bx = boxCache.get(fig);
    if (!bx) {
      const Fs = fig.frames.map(layout);
      const maxW = Math.max(...Fs.map(F => F.maxX - F.minX)), maxH = Math.max(...Fs.map(F => F.floor - F.minY));
      bx = { cx: Fs.reduce((n, F) => n + (F.minX + F.maxX) / 2, 0) / Fs.length, sc: Math.min(1, (W - 26) / (maxW + 20), (FLOOR - 10) / maxH) };
      boxCache.set(fig, bx);
    }
    return svg({ frames: [mixPose(fig.frames[0], fig.frames[1], u)] }, { only: 0, cx: bx.cx, sc: bx.sc, title });
  }

  return { svg, tween, W, H };
})();

/* Built-in illustrations, keyed by name. Props: db (dumbbell in a hand), box/bench (support to floor),
   wall, post, bar (end-on bar), plate (barbell plate), band, pad, air (airborne). */
const FIGURES = {
  'goblet-squat': { frames: [
    { t: -90, a1: 80, b1: -70, a2: 85, b2: -65, l1: 90, k1: 90, l2: 92, k2: 90, props: [{ t: 'db', at: 'hand1', r: 7.5 }] },
    { t: -62, n: -55, a1: 75, b1: -80, a2: 80, b2: -75, l1: 8, k1: 115, l2: 12, k2: 113, props: [{ t: 'db', at: 'hand1', r: 7.5 }] }] },
  'bulgarian-split-squat': { frames: [
    { t: -85, a1: 90, b1: 90, a2: 92, b2: 90, l1: 70, k1: 95, l2: 120, k2: 165, f2: 180, props: [{ t: 'db', at: 'hand1' }, { t: 'bench', x1: ['toe2', -22], x2: ['ankle2', 8], top: ['ankle2', 4] }] },
    { t: -78, a1: 90, b1: 90, a2: 92, b2: 90, l1: 10, k1: 105, l2: 109, k2: 220, f2: 180, props: [{ t: 'db', at: 'hand1' }, { t: 'bench', x1: ['toe2', -22], x2: ['ankle2', 8], top: ['ankle2', 4] }] }] },
  'reverse-lunge': { frames: [
    { t: -90, a1: 95, b1: 85, a2: 85, b2: 95, l1: 90, k1: 90, l2: 91, k2: 90 },
    { t: -88, a1: 95, b1: 80, a2: 85, b2: 95, l1: 5, k1: 92, l2: 100, k2: 190, f2: 60 }] },
  'step-up': { frames: [
    { t: -75, n: -80, a1: 105, b1: 95, a2: 70, b2: 40, l1: 10, k1: 100, l2: 92, k2: 90, props: [{ t: 'box', x1: ['ankle1', -22], x2: ['toe1', 18], top: ['ankle1', 4] }] },
    { t: -88, a1: 70, b1: 30, a2: 105, b2: 100, l1: 90, k1: 90, l2: 0, k2: 95, props: [{ t: 'box', x1: ['ankle1', -22], x2: ['toe1', 18], top: ['ankle1', 4], h: 32 }] }] },
  'romanian-deadlift': { frames: [
    { t: -90, a1: 88, b1: 90, a2: 92, b2: 90, l1: 90, k1: 90, l2: 92, k2: 90, props: [{ t: 'db', at: 'hand1' }] },
    { t: -25, n: -25, a1: 90, b1: 90, a2: 92, b2: 90, l1: 55, k1: 75, l2: 57, k2: 75, props: [{ t: 'db', at: 'hand1' }] }] },
  'nordic-curl': { frames: [
    { t: -90, a1: 70, b1: -70, a2: 75, b2: -65, l1: 90, k1: 180, f1: 180, l2: 92, k2: 180, f2: 180, props: [{ t: 'pad', at: 'ankle1' }] },
    { t: -40, n: -40, a1: 60, b1: 60, a2: 65, b2: 65, l1: 140, k1: 180, f1: 180, l2: 142, k2: 180, f2: 180, props: [{ t: 'pad', at: 'ankle1' }] }] },
  'single-leg-glute-bridge': { frames: [
    { t: 180, n: 180, a1: 12, b1: 10, a2: 14, b2: 12, l1: -50, k1: 75, l2: -40, k2: -40, f2: -40 },
    { t: 155, n: 180, a1: 12, b1: 10, a2: 14, b2: 12, l1: -15, k1: 95, l2: -25, k2: -25, f2: -25 }] },
  'hip-thrust': { frames: [
    { t: -150, n: -140, a1: 30, b1: 30, a2: 32, b2: 32, l1: -30, k1: 80, l2: -28, k2: 82, props: [{ t: 'bench', x1: ['shoulder', -50], x2: ['shoulder', 6], top: ['shoulder', 6] }, { t: 'plate', at: 'hip', dy: -11, r: 13 }] },
    { t: -176, n: -176, a1: 0, b1: 0, a2: 2, b2: 2, l1: 0, k1: 90, l2: 2, k2: 90, props: [{ t: 'bench', x1: ['shoulder', -50], x2: ['shoulder', 6], top: ['shoulder', 6] }, { t: 'plate', at: 'hip', dy: -11, r: 13 }] }] },
  'single-leg-rdl': { frames: [
    { t: -90, a1: 90, b1: 90, a2: 92, b2: 90, l1: 90, k1: 90, l2: 100, k2: 125, f2: 40, props: [{ t: 'db', at: 'hand2' }] },
    { t: -3, n: -5, a1: 90, b1: 90, a2: 92, b2: 90, l1: 84, k1: 96, l2: 180, k2: 180, f2: 90, props: [{ t: 'db', at: 'hand2' }] }] },
  'lateral-band-walk': { frames: [
    { front: true, t: -90, n: -90, a1: 75, b1: 95, a2: 105, b2: 85, l1: 82, k1: 94, l2: 98, k2: 86, s: { l1: .9, l2: .9 }, props: [{ t: 'band', a: ['knee1', 0, -5], b: ['knee2', 0, -5] }] },
    { front: true, t: -90, n: -90, a1: 75, b1: 95, a2: 105, b2: 85, l1: 64, k1: 76, l2: 98, k2: 86, s: { l1: .9, l2: .9 }, props: [{ t: 'band', a: ['knee1', 0, -5], b: ['knee2', 0, -5] }] }] },
  'side-lying-hip-abduction': { frames: [
    { t: 180, n: 175, a1: -8, b1: 8, a2: 180, b2: 180, l1: -2, k1: -2, f1: -10, l2: 0, k2: 0, f2: 0 },
    { t: 180, n: 175, a1: -8, b1: 8, a2: 180, b2: 180, l1: -30, k1: -30, f1: -40, l2: 0, k2: 0, f2: 0 }] },
  'single-leg-calf-raise': { frames: [
    { t: -90, a1: 15, b1: -5, a2: 80, b2: 95, l1: 90, k1: 90, f1: -18, l2: 95, k2: 175, f2: 180, props: [{ t: 'box', x1: ['toe1', -6], x2: ['toe1', 34], top: ['toe1', 3.5], h: 22 }, { t: 'wall', x: ['hand1', 4], side: 'R' }] },
    { t: -90, a1: 15, b1: -5, a2: 80, b2: 95, l1: 90, k1: 90, f1: 55, l2: 95, k2: 175, f2: 180, props: [{ t: 'box', x1: ['toe1', -6], x2: ['toe1', 34], top: ['toe1', 3.5], h: 22 }, { t: 'wall', x: ['hand1', 4], side: 'R' }] }] },
  'bent-knee-calf-raise': { frames: [
    { t: -86, a1: 15, b1: -5, a2: 80, b2: 95, l1: 70, k1: 110, f1: -15, l2: 92, k2: 175, f2: 180, props: [{ t: 'box', x1: ['toe1', -6], x2: ['toe1', 34], top: ['toe1', 3.5], h: 22 }, { t: 'wall', x: ['hand1', 4], side: 'R' }] },
    { t: -86, a1: 15, b1: -5, a2: 80, b2: 95, l1: 70, k1: 110, f1: 52, l2: 92, k2: 175, f2: 180, props: [{ t: 'box', x1: ['toe1', -6], x2: ['toe1', 34], top: ['toe1', 3.5], h: 22 }, { t: 'wall', x: ['hand1', 4], side: 'R' }] }] },
  'tibialis-raise': { frames: [
    { t: -100, n: -95, a1: 95, b1: 95, a2: 97, b2: 95, l1: 78, k1: 78, f1: 0, l2: 80, k2: 80, f2: 0, props: [{ t: 'wall', x: ['shoulder', -8] }] },
    { t: -100, n: -95, a1: 95, b1: 95, a2: 97, b2: 95, l1: 78, k1: 78, f1: -35, l2: 80, k2: 80, f2: -35, props: [{ t: 'wall', x: ['shoulder', -8] }] }] },
  'front-plank': { labels: ['Hold'], frames: [
    { t: -7, n: -7, a1: 90, b1: 0, a2: 92, b2: 2, l1: 173, k1: 173, f1: 95, l2: 174, k2: 174, f2: 95 }] },
  'side-plank': { labels: ['Hold'], frames: [
    { t: -12, n: -12, a1: -88, b1: -88, a2: 90, b2: 0, l1: 168, k1: 168, f1: 100, l2: 169, k2: 169, f2: 100, s: { f1: .45, f2: .45 } }] },
  'dead-bug': { frames: [
    { t: 180, n: 180, a1: -90, b1: -90, a2: -88, b2: -88, l1: -90, k1: 0, f1: -90, l2: -88, k2: 2, f2: -88 },
    { t: 180, n: 180, a1: 185, b1: 185, a2: -88, b2: -88, l1: -90, k1: 0, f1: -90, l2: -4, k2: -4, f2: -60 }] },
  'bird-dog': { frames: [
    { t: -10, n: -5, a1: 90, b1: 90, a2: 92, b2: 90, l1: 90, k1: 180, f1: 180, l2: 92, k2: 180, f2: 180 },
    { t: -8, n: -10, a1: -5, b1: -5, a2: 90, b2: 90, l1: 90, k1: 180, f1: 180, l2: 180, k2: 180, f2: 90 }] },
  'suitcase-carry': { labels: ['Walk'], frames: [
    { t: -90, n: -88, a1: 90, b1: 90, a2: 100, b2: 80, l1: 72, k1: 95, f1: -15, l2: 108, k2: 112, f2: 40, props: [{ t: 'db', at: 'hand1', r: 8 }] }] },
  'push-up': { frames: [
    { t: -18, n: -18, a1: 90, b1: 90, a2: 92, b2: 90, l1: 162, k1: 162, f1: 95, l2: 163, k2: 163, f2: 95 },
    { t: -7, n: -7, a1: 175, b1: 90, a2: 177, b2: 90, l1: 173, k1: 173, f1: 95, l2: 174, k2: 174, f2: 95 }] },
  'db-bench-press': { frames: [
    { t: 180, n: 180, a1: -88, b1: -90, a2: -86, b2: -90, l1: 15, k1: 95, l2: 18, k2: 95, props: [{ t: 'bench', x1: ['shoulder', -16], x2: ['hip', 14], top: ['hip', 6.5] }, { t: 'db', at: 'hand1' }, { t: 'db', at: 'hand2' }] },
    { t: 180, n: 180, a1: 60, b1: -95, a2: 62, b2: -93, l1: 15, k1: 95, l2: 18, k2: 95, props: [{ t: 'bench', x1: ['shoulder', -16], x2: ['hip', 14], top: ['hip', 6.5] }, { t: 'db', at: 'hand1' }, { t: 'db', at: 'hand2' }] }] },
  'single-arm-db-row': { frames: [
    { t: -15, n: -12, a1: 92, b1: 90, a2: 90, b2: 90, l1: 95, k1: 90, l2: 90, k2: 180, f2: 180, props: [{ t: 'bench', x1: ['toe2', -6], x2: ['hand2', 10], top: ['knee2', 3.5] }, { t: 'db', at: 'hand1' }] },
    { t: -15, n: -12, a1: 200, b1: 95, a2: 90, b2: 90, l1: 95, k1: 90, l2: 90, k2: 180, f2: 180, props: [{ t: 'bench', x1: ['toe2', -6], x2: ['hand2', 10], top: ['knee2', 3.5] }, { t: 'db', at: 'hand1' }] }] },
  'inverted-row': { frames: [
    { t: -155, n: -150, a1: -90, b1: -90, a2: -92, b2: -90, l1: 25, k1: 25, f1: -65, l2: 27, k2: 27, f2: -65, props: [{ t: 'bar', at: 'hand1', post: -30 }] },
    { t: -128, n: -120, a1: 115, b1: -75, a2: 117, b2: -73, l1: 52, k1: 52, f1: -40, l2: 54, k2: 54, f2: -40, props: [{ t: 'bar', at: 'hand1', post: -30 }] }] },
  'db-overhead-press': { frames: [
    { t: -90, a1: 70, b1: -85, a2: 72, b2: -83, l1: 90, k1: 90, l2: 92, k2: 90, props: [{ t: 'db', at: 'hand1' }, { t: 'db', at: 'hand2' }] },
    { t: -90, a1: -86, b1: -88, a2: -84, b2: -86, l1: 90, k1: 90, l2: 92, k2: 90, props: [{ t: 'db', at: 'hand1' }, { t: 'db', at: 'hand2' }] }] },
  'db-lateral-raise': { frames: [
    { front: true, t: -90, n: -90, a1: 82, b1: 88, a2: 98, b2: 92, l1: 85, k1: 90, l2: 95, k2: 90, props: [{ t: 'db', at: 'hand1' }, { t: 'db', at: 'hand2' }] },
    { front: true, t: -90, n: -90, a1: -2, b1: 2, a2: 182, b2: 178, l1: 85, k1: 90, l2: 95, k2: 90, props: [{ t: 'db', at: 'hand1' }, { t: 'db', at: 'hand2' }] }] },
  'db-bicep-curl': { frames: [
    { t: -90, a1: 92, b1: 90, a2: 88, b2: 90, l1: 90, k1: 90, l2: 92, k2: 90, props: [{ t: 'db', at: 'hand1' }] },
    { t: -90, a1: 95, b1: -60, a2: 88, b2: 90, l1: 90, k1: 90, l2: 92, k2: 90, props: [{ t: 'db', at: 'hand1' }] }] },
  'bench-dip': { frames: [
    { t: -90, n: -90, a1: 100, b1: 100, a2: 98, b2: 98, l1: 10, k1: 75, f1: -10, l2: 12, k2: 75, f2: -10, props: [{ t: 'bench', x1: ['hand1', -42], x2: ['hand1', 5], top: ['hand1', 3.5] }] },
    { t: -90, n: -90, a1: 150, b1: 95, a2: 148, b2: 95, l1: -10, k1: 100, f1: -10, l2: -8, k2: 100, f2: -10, props: [{ t: 'bench', x1: ['hand1', -42], x2: ['hand1', 5], top: ['hand1', 3.5] }] }] },
  'pogo-hops': { labels: ['Contact', 'Air'], frames: [
    { t: -88, a1: 100, b1: 50, a2: 95, b2: 55, l1: 88, k1: 93, f1: 55, l2: 90, k2: 92, f2: 55 },
    { t: -88, a1: 100, b1: 50, a2: 95, b2: 55, l1: 88, k1: 92, f1: 68, l2: 90, k2: 91, f2: 68, props: [{ t: 'air', h: 16 }] }] },
  'box-jump': { frames: [
    { t: -45, n: -35, a1: 150, b1: 160, a2: 148, b2: 158, l1: 35, k1: 115, l2: 37, k2: 113, props: [{ t: 'box', x1: ['toe1', 14], w: 46, h: 44 }] },
    { t: -60, n: -50, a1: -10, b1: 0, a2: -12, b2: -2, l1: 25, k1: 110, l2: 27, k2: 108, props: [{ t: 'box', x1: ['ankle1', -20], w: 46, top: ['toe1', 3.5], h: 44 }] }] },
  'a-skip': { frames: [
    { t: -88, n: -88, a1: 55, b1: -50, a2: 115, b2: 80, l1: 88, k1: 92, f1: 25, l2: 100, k2: 120, f2: 50 },
    { t: -88, n: -88, a1: 125, b1: 70, a2: 50, b2: -60, l1: -5, k1: 95, f1: -10, l2: 90, k2: 90, f2: 30 }] },
  'hip-flexor-stretch': { labels: ['Hold'], frames: [
    { t: -92, n: -90, a1: 70, b1: 45, a2: -80, b2: -82, l1: -2, k1: 90, l2: 105, k2: 180, f2: 180 }] },
  'worlds-greatest-stretch': { frames: [
    { t: -15, n: -10, a1: 115, b1: 70, a2: 85, b2: 88, l1: 5, k1: 100, l2: 155, k2: 155, f2: 40 },
    { t: -15, n: -25, a1: -95, b1: -95, a2: 85, b2: 88, l1: 5, k1: 100, l2: 155, k2: 155, f2: 40 }] },
  'leg-swings': { labels: ['Forward', 'Back'], frames: [
    { t: -90, n: -90, a1: 95, b1: 85, a2: 25, b2: 10, l1: 30, k1: 35, f1: -10, l2: 90, k2: 90, props: [{ t: 'post', x: ['hand2', 2] }] },
    { t: -90, n: -90, a1: 95, b1: 85, a2: 25, b2: 10, l1: 135, k1: 140, f1: 70, l2: 90, k2: 90, props: [{ t: 'post', x: ['hand2', 2] }] }] },
};
