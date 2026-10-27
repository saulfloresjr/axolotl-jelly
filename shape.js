// ─────────────────────────────────────────────────────────────────────────────
// shape.js — the axolotl, built from distance functions at load time.
//
// It is built in *parts*: one body and four legs, each with
// its own skin (surface nets) and its own tetrahedral lattice. The legs are
// held on by "glue" constraints, which is what lets one tear off cleanly.
// The feathery gills are not lattice at all: they are chains of particles
// (stalks with fronds) pinned to the head.
// ─────────────────────────────────────────────────────────────────────────────
const Axolotl = (() => {
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const mix = (a, b, t) => a + (b - a) * t;
  const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
  const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
  function smin(a, b, k) {
    const h = clamp(0.5 + 0.5 * (b - a) / k, 0, 1);
    return [mix(b, a, h) - k * h * (1 - h), h];
  }
  // Catmull–Rom through [x, v1, v2, …] control points, evaluated at x
  function spline(P, x, c) {
    let i = 0;
    while (i < P.length - 2 && x > P[i + 1][0]) i++;
    const p0 = P[Math.max(i - 1, 0)][c], p1 = P[i][c], p2 = P[i + 1][c], p3 = P[Math.min(i + 2, P.length - 1)][c];
    const t = clamp((x - P[i][0]) / (P[i + 1][0] - P[i][0]), 0, 1);
    return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);
  }
  const extrude = (d2, dh) => Math.min(Math.max(d2, dh), 0) + Math.hypot(Math.max(d2, 0), Math.max(dh, 0));
  function capsule(px, py, pz, a, b, ra, rb) {
    const bx = b[0]-a[0], by = b[1]-a[1], bz = b[2]-a[2];
    const qx = px-a[0], qy = py-a[1], qz = pz-a[2];
    const t = clamp((qx*bx + qy*by + qz*bz) / (bx*bx + by*by + bz*bz), 0, 1);
    return Math.hypot(qx - bx*t, qy - by*t, qz - bz*t) - mix(ra, rb, t);
  }

  // ── Core: a lofted ellipse, broad flat head, round trunk, thin tail ────────
  const XT = -1.62, XN = 1.15;
  //            x      half-width  half-height
  const CORE = [[-1.62, 0.012, 0.03], [-1.25, 0.045, 0.075], [-0.8, 0.12, 0.13], [-0.45, 0.205, 0.17],
                [-0.1, 0.25, 0.185], [0.32, 0.245, 0.182], [0.5, 0.25, 0.172], [0.7, 0.34, 0.168],
                [0.88, 0.35, 0.16], [1.03, 0.29, 0.14], [1.15, 0, 0]];
  function section(x) {
    const xc = clamp(x, XT, XN);
    let rz, ry;
    if (xc >= 1.03) { const t = (xc - 1.03) / (XN - 1.03), f = Math.sqrt(Math.max(0, 1 - t * t)); rz = 0.29 * f; ry = 0.14 * f; }
    else { rz = spline(CORE, xc, 1); ry = spline(CORE, xc, 2); }
    rz = Math.max(rz, 0) + 0.004; ry = Math.max(ry, 0) + 0.004;
    // keep the snout's centre line up off the table as the head narrows
    const ryC = xc > 0.88 ? Math.max(ry, 0.164 - (xc - 0.88) * 0.3) : ry;
    return { rz, ry, yc: 0.86 * ryC + 0.012 };
  }
  function sdCore(px, py, pz, out) {
    const s = section(px);
    const dy = py - s.yc, ryE = dy < 0 ? s.ry * 0.86 : s.ry;
    const q = Math.hypot(dy / ryE, pz / s.rz);
    let d = (q - 1) * Math.min(ryE, s.rz);
    if (px > 1.03) {   // the snout is the front half of an ellipsoid
      const s0 = section(1.03), dy0 = py - s0.yc, ry0 = dy0 < 0 ? s0.ry * 0.86 : s0.ry;
      d = (Math.hypot((px - 1.03) / (XN - 1.03 + 0.006), dy0 / ry0, pz / s0.rz) - 1) * Math.min(ry0, XN - 1.03);
    }
    if (px < XT) d = Math.max(d, XT - px);
    if (out) { out.rel = dy / ryE; out.ryE = ryE; out.s = s; }
    return d;
  }

  // ── Fin: one thin blade from mid-back round the tail tip ───────────────────
  const FIN = [[-1.8, -0.02], [-1.7, 0.1], [-1.35, 0.19], [-0.85, 0.23], [-0.4, 0.205], [-0.05, 0.19], [0.3, 0.08]];
  function sdFin(px, py, pz) {
    if (px < -1.86 || px > 0.34) return 1;
    const ryF = spline(FIN, clamp(px, -1.8, 0.3), 1);
    const s = section(px);
    const ycF = Math.max(s.yc + 0.3 * (ryF - s.ry), ryF + 0.014);
    const off = Math.abs(py - ycF);
    const d2 = Math.max(off - ryF, -1.8 - px, px - 0.3) - 0.01;
    const tt = clamp(off / Math.max(ryF, 0.01), 0, 1);
    const rzF = 0.02 * (1 - 0.55 * tt * tt) + 0.004;
    return extrude(d2, Math.abs(pz) - rzF) - 0.004;
  }

  // ── Legs: upper arm, forearm, a hand pad and splayed fingers ───────────────
  const LEG_NAMES = ['left forelimb', 'right forelimb', 'left hind limb', 'right hind limb'];
  const LEGS = [['front', 1], ['front', -1], ['back', 1], ['back', -1]].map(([kind, side], i) => {
    const f = kind === 'front';
    const S = f ? [0.32, 0.12, 0.19 * side] : [-0.36, 0.12, 0.2 * side];
    const E = f ? [0.43, 0.075, 0.42 * side] : [-0.43, 0.08, 0.44 * side];
    const W = f ? [0.56, 0.035, 0.5 * side] : [-0.57, 0.035, 0.52 * side];
    const nt = f ? 4 : 5, len = f ? 0.085 : 0.09;
    const base = norm([W[0] - E[0], 0, W[2] - E[2]]);
    const toes = [];
    for (let k = 0; k < nt; k++) {
      const a = mix(-0.8, 0.8, k / (nt - 1)), c = Math.cos(a), s = Math.sin(a);
      const d = [base[0] * c - base[2] * s, 0, base[0] * s + base[2] * c];
      const a0 = [W[0] + d[0] * 0.02, 0.03, W[2] + d[2] * 0.02];
      toes.push([a0, [a0[0] + d[0] * len, 0.022, a0[2] + d[2] * len]]);
    }
    const pts = [S, E, W, ...toes.map(t => t[1])];
    const lo = [0, 1, 2].map(c => Math.min(...pts.map(p => p[c])) - 0.1);
    const hi = [0, 1, 2].map(c => Math.max(...pts.map(p => p[c])) + 0.1);
    lo[1] = -0.03;
    return { i, kind, side, S, E, W, toes, bounds: { min: lo, max: hi }, name: LEG_NAMES[i] };
  });
  function sdLegRaw(px, py, pz, L) {
    let d = capsule(px, py, pz, L.S, L.E, 0.058, 0.047);
    d = smin(d, capsule(px, py, pz, L.E, L.W, 0.047, 0.038), 0.03)[0];
    const q = Math.hypot((px - L.W[0]) / 0.055, (py - L.W[1]) / 0.024, (pz - L.W[2]) / 0.055);
    d = smin(d, (q - 1) * 0.024, 0.025)[0];
    for (const [a, b] of L.toes) d = smin(d, capsule(px, py, pz, a, b, 0.017, 0.012), 0.016)[0];
    return d;
  }
  // a leg stops just inside the body, so its skin is a closed shape of its own
  const sdLeg = (px, py, pz, L) => Math.max(sdLegRaw(px, py, pz, L), -(sdCore(px, py, pz) + 0.03));

  // eyes on top of the head, a socket mound where each leg comes out
  const EYES = [1, -1].map(side => {
    const x = 0.9, s = section(x), rel = 0.42;
    return [x, s.yc + s.ry * rel, side * (s.rz * Math.sqrt(1 - rel * rel) - 0.012)];
  });
  const milkLine = x => mix(-1.3, -0.4, smoothstep(-0.9, -0.4, x));
  const mouthLine = x => -0.34 + 0.24 * smoothstep(0.99, 0.76, x);   // a smile: up at the corners

  const tmp = {};
  function sdBody(px, py, pz, mat) {
    let d = sdCore(px, py, pz, mat ? tmp : null);
    let sB = 0, sM = 1, fin = 0;
    if (mat) {
      sB = (tmp.rel - milkLine(px)) * tmp.ryE;
      sM = px > 0.7 ? (tmp.rel - mouthLine(px)) * tmp.ryE + smoothstep(0.76, 0.71, px) : 1;
    }
    let r = smin(d, sdFin(px, py, pz), 0.05); d = r[0];
    if (mat) { sB = mix(0.06, sB, r[1]); sM = mix(1, sM, r[1]); fin = 1 - r[1]; }
    for (const L of LEGS) {
      const ds = Math.hypot(px - L.S[0], py - L.S[1] + 0.01, pz - L.S[2] * 1.05) - 0.07;
      if (ds < 0.08) d = smin(d, ds, 0.06)[0];
    }
    if (px > 0.8 && px < 1.0 && py > 0.15) for (const e of EYES) {
      const de = Math.hypot(px - e[0], py - e[1], pz - e[2]) - 0.032;
      if (de < 0.04) d = smin(d, de, 0.012)[0];
    }
    if (mat) { mat[0] = sB; mat[1] = sM; mat[2] = fin; mat[3] = 0; }
    return d;
  }
  const BODY_BOUNDS = { min: [-1.92, -0.03, -0.48], max: [1.24, 0.6, 0.48] };

  // ── Generic mesh builders ───────────────────────────────────────────────────
  function gradient(f, x, y, z, out) {
    const e = 0.002;
    out[0] = f(x + e, y, z) - f(x - e, y, z); out[1] = f(x, y + e, z) - f(x, y - e, z); out[2] = f(x, y, z + e) - f(x, y, z - e);
    const l = Math.hypot(out[0], out[1], out[2]) || 1; out[0] /= l; out[1] /= l; out[2] /= l;
  }
  function surfaceNets(f, matFn, B, g) {
    const o = B.min;
    const nx = Math.ceil((B.max[0] - o[0]) / g) + 1, ny = Math.ceil((B.max[1] - o[1]) / g) + 1, nz = Math.ceil((B.max[2] - o[2]) / g) + 1;
    const F = new Float32Array(nx * ny * nz), id = (i, j, k) => (k * ny + j) * nx + i;
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) F[id(i, j, k)] = f(o[0] + i * g, o[1] + j * g, o[2] + k * g);
    const cellVert = new Int32Array((nx - 1) * (ny - 1) * (nz - 1)).fill(-1), cid = (i, j, k) => (k * (ny - 1) + j) * (nx - 1) + i;
    const pos = [], C = [[0,0,0],[1,0,0],[0,1,0],[1,1,0],[0,0,1],[1,0,1],[0,1,1],[1,1,1]];
    const EDG = [[0,1],[2,3],[4,5],[6,7],[0,2],[1,3],[4,6],[5,7],[0,4],[1,5],[2,6],[3,7]], v = new Float32Array(8);
    for (let k = 0; k < nz - 1; k++) for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
      let mask = 0;
      for (let c = 0; c < 8; c++) { v[c] = F[id(i + C[c][0], j + C[c][1], k + C[c][2])]; if (v[c] < 0) mask |= 1 << c; }
      if (mask === 0 || mask === 255) continue;
      let sx = 0, sy = 0, sz = 0, n = 0;
      for (const [a, b] of EDG) {
        if ((v[a] < 0) === (v[b] < 0)) continue;
        const t = v[a] / (v[a] - v[b]);
        sx += C[a][0] + (C[b][0] - C[a][0]) * t; sy += C[a][1] + (C[b][1] - C[a][1]) * t; sz += C[a][2] + (C[b][2] - C[a][2]) * t; n++;
      }
      cellVert[cid(i, j, k)] = pos.length / 3;
      pos.push(o[0] + (i + sx / n) * g, o[1] + (j + sy / n) * g, o[2] + (k + sz / n) * g);
    }
    const idx = [], quad = (a, b, c, d) => { if (a >= 0 && b >= 0 && c >= 0 && d >= 0) idx.push(a, b, c, a, c, d); };
    for (let k = 1; k < nz - 1; k++) for (let j = 1; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++)
      if ((F[id(i, j, k)] < 0) !== (F[id(i + 1, j, k)] < 0)) quad(cellVert[cid(i, j-1, k-1)], cellVert[cid(i, j, k-1)], cellVert[cid(i, j, k)], cellVert[cid(i, j-1, k)]);
    for (let k = 1; k < nz - 1; k++) for (let j = 0; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++)
      if ((F[id(i, j, k)] < 0) !== (F[id(i, j + 1, k)] < 0)) quad(cellVert[cid(i-1, j, k-1)], cellVert[cid(i-1, j, k)], cellVert[cid(i, j, k)], cellVert[cid(i, j, k-1)]);
    for (let k = 0; k < nz - 1; k++) for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++)
      if ((F[id(i, j, k)] < 0) !== (F[id(i, j, k + 1)] < 0)) quad(cellVert[cid(i-1, j-1, k)], cellVert[cid(i, j-1, k)], cellVert[cid(i, j, k)], cellVert[cid(i-1, j, k)]);

    const nv = pos.length / 3, P = new Float32Array(pos), N = new Float32Array(nv * 3), M = new Float32Array(nv * 4);
    const gr = [0, 0, 0], mat = [0, 0, 0, 0];
    for (let i = 0; i < nv; i++) {
      let x = P[3*i], y = P[3*i+1], z = P[3*i+2];
      for (let it = 0; it < 3; it++) { const d = f(x, y, z); gradient(f, x, y, z, gr); x -= d * gr[0]; y -= d * gr[1]; z -= d * gr[2]; }
      P[3*i] = x; P[3*i+1] = y; P[3*i+2] = z;
      gradient(f, x, y, z, gr); N.set(gr, 3 * i);
      matFn(x, y, z, mat); M.set(mat, 4 * i);
    }
    const I = new Uint32Array(idx);
    for (let t = 0; t < I.length; t += 3) {   // wind CCW as seen from outside
      const a = I[t], b = I[t+1], c = I[t+2];
      const ux = P[3*b]-P[3*a], uy = P[3*b+1]-P[3*a+1], uz = P[3*b+2]-P[3*a+2], vx = P[3*c]-P[3*a], vy = P[3*c+1]-P[3*a+1], vz = P[3*c+2]-P[3*a+2];
      const s = (uy*vz-uz*vy)*(N[3*a]+N[3*b]+N[3*c]) + (uz*vx-ux*vz)*(N[3*a+1]+N[3*b+1]+N[3*c+1]) + (ux*vy-uy*vx)*(N[3*a+2]+N[3*b+2]+N[3*c+2]);
      if (s < 0) { I[t+1] = c; I[t+2] = b; }
    }
    return { pos: P, nrm: N, mat: M, idx: I };
  }

  const TET_EVEN = [[1,2,4,7],[0,1,2,4],[3,1,2,7],[5,1,4,7],[6,2,4,7]];
  const TET_ODD  = [[0,3,5,6],[1,0,3,5],[2,0,3,6],[4,0,5,6],[7,3,5,6]];
  function tetVolume(P, T, t) {
    const a = 3*T[t], b = 3*T[t+1], c = 3*T[t+2], d = 3*T[t+3];
    const ux = P[b]-P[a], uy = P[b+1]-P[a+1], uz = P[b+2]-P[a+2], vx = P[c]-P[a], vy = P[c+1]-P[a+1], vz = P[c+2]-P[a+2], wx = P[d]-P[a], wy = P[d+1]-P[a+1], wz = P[d+2]-P[a+2];
    return ((uy*vz-uz*vy)*wx + (uz*vx-ux*vz)*wy + (ux*vy-uy*vx)*wz) / 6;
  }
  function invert3(m, out, o) {
    const [a,b,c,d,e,f,g,h,i] = m, A = e*i-f*h, B = -(d*i-f*g), C = d*h-e*g, r = 1 / (a*A + b*B + c*C);
    out[o] = A*r; out[o+1] = -(b*i-c*h)*r; out[o+2] = (b*f-c*e)*r; out[o+3] = B*r; out[o+4] = (a*i-c*g)*r; out[o+5] = -(a*f-c*d)*r; out[o+6] = C*r; out[o+7] = -(a*h-b*g)*r; out[o+8] = (a*e-b*d)*r;
  }
  function tetLattice(f, B, h) {
    const o = [B.min[0], 0, B.min[2]];
    const nx = Math.ceil((B.max[0] - o[0]) / h), ny = Math.ceil((B.max[1] - o[1]) / h), nz = Math.ceil((B.max[2] - o[2]) / h);
    const nodeId = new Map(), pos = [], tets = [], cellTets = new Map();
    const node = (i, j, k) => {
      const key = (k * (ny + 1) + j) * (nx + 1) + i;
      let n = nodeId.get(key);
      if (n === undefined) { n = pos.length / 3; nodeId.set(key, n); pos.push(o[0] + i * h, o[1] + j * h, o[2] + k * h); }
      return n;
    };
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      if (f(o[0] + (i + 0.5) * h, o[1] + (j + 0.5) * h, o[2] + (k + 0.5) * h) > h * 0.6) continue;
      const c = [];
      for (let b = 0; b < 8; b++) c.push(node(i + (b & 1), j + ((b >> 1) & 1), k + ((b >> 2) & 1)));
      const list = [];
      for (const t of ((i + j + k) & 1) ? TET_ODD : TET_EVEN) { list.push(tets.length / 4); tets.push(c[t[0]], c[t[1]], c[t[2]], c[t[3]]); }
      cellTets.set((k * ny + j) * nx + i, list);
    }
    const P = new Float32Array(pos), T = new Uint32Array(tets);
    for (let t = 0; t < T.length; t += 4) if (tetVolume(P, T, t) < 0) { const s = T[t+2]; T[t+2] = T[t+3]; T[t+3] = s; }
    return { pos: P, tets: T, cellTets, o, h, nx, ny, nz };
  }
  // bind each point to the tetrahedron that contains it (or the nearest one)
  function embedPoints(points, lat, DmInv) {
    const nv = points.length / 3, tetOf = new Uint32Array(nv), bary = new Float32Array(nv * 3);
    const { o, h, nx, ny, cellTets, pos: X, tets: T } = lat;
    for (let v = 0; v < nv; v++) {
      const px = points[3*v], py = points[3*v+1], pz = points[3*v+2];
      const ci = Math.floor((px - o[0]) / h), cj = Math.floor((py - o[1]) / h), ck = Math.floor((pz - o[2]) / h);
      let best = 0, bestScore = -Infinity, bb = [0, 0, 0];
      for (let r = 0; r <= 3 && bestScore < -1e-4; r++)
        for (let dk = -r; dk <= r; dk++) for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
          if (Math.max(Math.abs(di), Math.abs(dj), Math.abs(dk)) !== r) continue;
          const list = cellTets.get(((ck + dk) * ny + (cj + dj)) * nx + (ci + di));
          if (!list) continue;
          for (const t of list) {
            const a = 3 * T[4*t], m = 9 * t, rx = px - X[a], ry = py - X[a+1], rz = pz - X[a+2];
            const b1 = DmInv[m]*rx + DmInv[m+3]*ry + DmInv[m+6]*rz, b2 = DmInv[m+1]*rx + DmInv[m+4]*ry + DmInv[m+7]*rz, b3 = DmInv[m+2]*rx + DmInv[m+5]*ry + DmInv[m+8]*rz;
            const score = Math.min(1 - b1 - b2 - b3, b1, b2, b3);
            if (score > bestScore) { bestScore = score; best = t; bb = [b1, b2, b3]; }
          }
        }
      tetOf[v] = best; bary.set(bb, 3 * v);
    }
    return { tetOf, bary };
  }

  // One soft part: skin + lattice + everything the solver and renderer need
  function buildPart(f, matFn, B, skinStep, h, partId) {
    const surf = surfaceNets(f, matFn, B, skinStep);
    for (let i = 0; i < surf.mat.length / 4; i++) surf.mat[4 * i + 3] = partId;
    const lat = tetLattice(f, B, h);
    const nT = lat.tets.length / 4, nN = lat.pos.length / 3;
    const DmInv = new Float32Array(nT * 9), restVol = new Float32Array(nT), edgeSet = new Map(), faces = new Map();
    for (let t = 0; t < nT; t++) {
      const T = lat.tets, P = lat.pos, a = 3 * T[4*t], m = [];
      for (let c = 1; c <= 3; c++) { const b = 3 * T[4*t+c]; m.push(P[b]-P[a], P[b+1]-P[a+1], P[b+2]-P[a+2]); }
      invert3(m, DmInv, 9 * t);
      restVol[t] = tetVolume(P, T, 4 * t);
      const q = [T[4*t], T[4*t+1], T[4*t+2], T[4*t+3]];
      for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) { const lo = Math.min(q[i], q[j]), hi = Math.max(q[i], q[j]); edgeSet.set(lo * nN + hi, [lo, hi]); }
      for (const fc of [[0,2,1],[0,1,3],[0,3,2],[1,2,3]]) {
        const tri = [q[fc[0]], q[fc[1]], q[fc[2]]], key = [...tri].sort((x, y) => x - y).join(',');
        const e = faces.get(key); if (e) e.n++; else faces.set(key, { n: 1, tri });
      }
    }
    const edges = new Uint32Array(edgeSet.size * 2); let ei = 0;
    for (const [, [a, b]] of edgeSet) { edges[ei++] = a; edges[ei++] = b; }
    const boundary = [];
    for (const [, fc] of faces) if (fc.n === 1) boundary.push(...fc.tri);
    const radius = new Float32Array(nN);
    for (let i = 0; i < nN; i++) radius[i] = clamp(0.35 * h - f(lat.pos[3*i], lat.pos[3*i+1], lat.pos[3*i+2]), 0, h * 1.1);
    const emb = embedPoints(surf.pos, lat, DmInv);
    return { surf, emb, lat, nodes: lat.pos, tets: lat.tets, edges, boundary: new Uint32Array(boundary), DmInv, restVol, radius, h };
  }

  function nearest(P, p, filter) {
    let best = -1, bd = Infinity;
    for (let i = 0; i < P.length / 3; i++) {
      if (filter && !filter(i)) continue;
      const d = (P[3*i]-p[0])**2 + (P[3*i+1]-p[1])**2 + (P[3*i+2]-p[2])**2;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  // ── Gills: three stalks a side, each a particle chain feathered with fronds ─
  function buildGills(body) {
    const pos = [], parent = [], anchor = [], stiff = [], rad = [], segR = [];
    const roots = [];
    for (const side of [1, -1]) for (let j = 0; j < 3; j++) {
      const root = [0.6 - 0.035 * j, 0.31 - 0.07 * j, side * (0.27 + 0.025 * j)];
      const dir = norm([-0.45 - 0.12 * j, 0.78 - 0.42 * j, side * 0.62]);
      const len = [0.42, 0.4, 0.34][j];
      const n1 = norm(cross(dir, [1, 0, 0])), n2 = cross(dir, n1);
      const stalk = [];
      for (let i = 0; i <= 5; i++) {
        const t = i / 5;
        const p = [root[0] + dir[0] * len * t - 0.13 * t * t, root[1] + dir[1] * len * t - 0.05 * t * t, root[2] + dir[2] * len * t];
        const id = pos.length / 3;
        pos.push(...p); rad.push(mix(0.034, 0.013, t));
        parent.push(i === 0 ? -1 : id - 1); anchor.push(i === 0 ? -1 : stalk[0]);
        stiff.push(i === 0 ? 0 : 0.22 * (1 - 0.55 * t));
        segR.push(i === 0 ? 0 : rad[id - 1]);
        if (i === 0) roots.push(id);
        stalk.push(id);
      }
      for (let i = 1; i <= 5; i++) {
        const t = i / 5, fl = 0.1 * (1 - 0.35 * t) + 0.02;
        for (let a = 0; a < 4; a++) {
          const ang = a * Math.PI / 2 + 0.4 * i;
          const fd = norm([n1[0]*Math.cos(ang) + n2[0]*Math.sin(ang) + dir[0]*0.5, n1[1]*Math.cos(ang) + n2[1]*Math.sin(ang) + dir[1]*0.5, n1[2]*Math.cos(ang) + n2[2]*Math.sin(ang) + dir[2]*0.5]);
          const sp = stalk[i];
          let prev = sp;
          for (let k = 1; k <= 3; k++) {
            const id = pos.length / 3;
            pos.push(pos[3*sp] + fd[0] * fl * k / 3, pos[3*sp+1] + fd[1] * fl * k / 3, pos[3*sp+2] + fd[2] * fl * k / 3);
            rad.push(mix(0.011, 0.005, k / 3));
            parent.push(prev); anchor.push(sp); stiff.push(0.12);
            segR.push(k === 1 ? 0.012 : rad[id - 1]);
            prev = id;
          }
        }
      }
    }
    const P = new Float32Array(pos);
    const rootPts = new Float32Array(roots.flatMap(r => [P[3*r], P[3*r+1], P[3*r+2]]));
    const rootEmb = embedPoints(rootPts, body.lat, body.DmInv);
    return { rest: P, parent: Int32Array.from(parent), anchor: Int32Array.from(anchor), stiff: Float32Array.from(stiff),
             radius: Float32Array.from(rad), segRadius: Float32Array.from(segR), roots: Int32Array.from(roots), rootEmb };
  }

  function surfaceVolume(surf) {
    let V = 0; const P = surf.pos, I = surf.idx;
    for (let t = 0; t < I.length; t += 3) {
      const a = 3*I[t], b = 3*I[t+1], c = 3*I[t+2];
      V += (P[a]*(P[b+1]*P[c+2]-P[b+2]*P[c+1]) - P[a+1]*(P[b]*P[c+2]-P[b+2]*P[c]) + P[a+2]*(P[b]*P[c+1]-P[b+1]*P[c])) / 6;
    }
    return V;
  }

  function build() {
    const t0 = performance.now();
    const bodyF = (x, y, z) => sdBody(x, y, z);
    const body = buildPart(bodyF, (x, y, z, m) => sdBody(x, y, z, m), BODY_BOUNDS, 0.017, 0.08, 0);
    const legs = LEGS.map(L => {
      const f = (x, y, z) => sdLeg(x, y, z, L);
      const part = buildPart(f, (x, y, z, m) => { m[0] = 0.06; m[1] = 1; m[2] = 0; }, L.bounds, 0.0105, 0.042, 1 + L.i);
      // glue: leg nodes at or inside the body skin hold on to nearby body nodes
      const legIdx = [], bodyIdx = [];
      const P = part.nodes, BP = body.nodes;
      for (let i = 0; i < P.length / 3; i++) {
        if (sdCore(P[3*i], P[3*i+1], P[3*i+2]) > 0.025) continue;
        const near = [];
        for (let j = 0; j < BP.length / 3; j++) {
          const d = Math.hypot(P[3*i]-BP[3*j], P[3*i+1]-BP[3*j+1], P[3*i+2]-BP[3*j+2]);
          if (d < 0.13) near.push([d, j]);
        }
        near.sort((a, b) => a[0] - b[0]);
        for (const [, j] of near.slice(0, 3)) { legIdx.push(i); bodyIdx.push(j); }
      }
      let pivot = [0, 0, 0]; const uniq = [...new Set(legIdx)];
      for (const i of uniq) for (let c = 0; c < 3; c++) pivot[c] += P[3*i+c] / uniq.length;
      const anchor = nearest(BP, pivot);
      return { ...part, def: L, glue: { leg: Uint32Array.from(legIdx), body: Uint32Array.from(bodyIdx) }, pivot, anchor };
    });
    const gills = buildGills(body);
    const BN = body.nodes;
    const s1 = section(XN - 0.02);
    const landmarks = {
      snout: nearest(BN, [XN, s1.yc, 0]),
      tail: nearest(BN, [-1.78, 0.12, 0]),
      head: [nearest(BN, [0.74, 0.16, 0]), nearest(BN, [0.96, 0.16, 0]), nearest(BN, [0.74, 0.16, 0.18])],
      eyes: EYES,
    };
    const visualVolume = surfaceVolume(body.surf) + legs.reduce((a, l) => a + surfaceVolume(l.surf), 0);
    return { body, legs, gills, landmarks, visualVolume, buildMs: performance.now() - t0 };
  }

  return { build, LEGS };
})();
