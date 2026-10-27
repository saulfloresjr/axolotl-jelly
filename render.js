// ─────────────────────────────────────────────────────────────────────────────
// render.js — WebGPU, four passes a frame (shadow, floor, back faces
// for thickness, front faces with absorption + refraction).
//
// New here:
//   • Parts are drawn *instanced*. One leg skin is drawn once for the attached
//     leg and once for each torn-off copy; the instance index looks up which
//     slice of the particle buffer that copy reads (`inst` table).
//   • Gills are capsules, one instance per chain segment, built in the vertex
//     shader from two endpoints the CPU writes each frame.
//   • A growing bud glows pale while it fills in.
// ─────────────────────────────────────────────────────────────────────────────
const SHADER = /* wgsl */`
struct U {
  viewProj: mat4x4f, invViewProj: mat4x4f, view: mat4x4f, lightVP: mat4x4f,
  camPos: vec4f, lightDir: vec4f,
  tint: vec4f,      // rgb: light surviving one unit of jelly, a: depth scale
  deep: vec4f,      // rgb shadow colour, a strength
  milk: vec4f,      // belly layer
  screen: vec4f,
  misc: vec4f,      // time, mesh overlay, light depth range
  eyeL: vec4f, eyeR: vec4f, paper: vec4f,
  gill: vec4f,      // rgb gill transmission, a density
  flags: vec4f,     // x speckles, y dark eyes, z tabletop
  finish: vec4f,    // x 0 glossy · 1 sour · 2 frosted, y sugar, z rainbow
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> nodes: array<vec4f>;
@group(0) @binding(2) var<storage, read> nodeF: array<vec4f>;
@group(0) @binding(3) var<storage, read> tets: array<vec4u>;
@group(0) @binding(4) var<storage, read> drops: array<vec4f>;
@group(0) @binding(5) var<storage, read> edges: array<u32>;
@group(0) @binding(6) var<storage, read> inst: array<vec2u>;   // node offset, growth ‰
@group(0) @binding(7) var<storage, read> segs: array<vec4f>;   // a.xyz ra, b.xyz rb
@group(0) @binding(8) var<storage, read> segRest: array<vec4f>; // the same segment in the gills' rest pose
@group(1) @binding(0) var shadowTex: texture_depth_2d;
@group(1) @binding(1) var cmpSamp: sampler_comparison;
@group(2) @binding(0) var sceneTex: texture_2d<f32>;
@group(2) @binding(1) var backTex: texture_2d<f32>;
@group(2) @binding(2) var linSamp: sampler;

struct VIn { @location(0) rest: vec3f, @location(1) nrm: vec3f, @location(2) bary: vec3f, @location(3) tet: u32, @location(4) mat: vec4f };
struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f, @location(1) nrm: vec3f, @location(2) rest: vec3f,
  @location(3) mat: vec4f, @location(4) @interpolate(flat) kind: u32, @location(5) @interpolate(flat) glow: f32,
};

struct Skin { p: vec3f, n: vec3f };
fn skin(v: VIn, off: u32) -> Skin {
  let t = tets[v.tet] + vec4u(off);
  let b = vec4f(1.0 - v.bary.x - v.bary.y - v.bary.z, v.bary);
  let p = nodes[t.x].xyz * b.x + nodes[t.y].xyz * b.y + nodes[t.z].xyz * b.z + nodes[t.w].xyz * b.w;
  var c0 = vec3f(0.0); var c1 = vec3f(0.0); var c2 = vec3f(0.0);
  for (var k = 0u; k < 4u; k++) {
    let id = t[k] * 3u; let w = b[k];
    c0 += nodeF[id].xyz * w; c1 += nodeF[id + 1u].xyz * w; c2 += nodeF[id + 2u].xyz * w;
  }
  return Skin(p, normalize(cross(c1, c2) * v.nrm.x + cross(c2, c0) * v.nrm.y + cross(c0, c1) * v.nrm.z));
}

@vertex fn vsPart(v: VIn, @builtin(instance_index) ii: u32) -> VOut {
  let I = inst[ii]; let s = skin(v, I.x);
  var o: VOut;
  o.pos = u.viewProj * vec4f(s.p, 1.0);
  o.world = s.p; o.nrm = s.n; o.rest = v.rest; o.mat = v.mat; o.kind = 0u;
  o.glow = 1.0 - f32(I.y) / 1000.0;
  return o;
}
@vertex fn vsPartShadow(v: VIn, @builtin(instance_index) ii: u32) -> @builtin(position) vec4f {
  return u.lightVP * vec4f(skin(v, inst[ii].x).p, 1.0);
}

// capsule vertex: (cos·ring, sin·ring, t along segment, cap offset)
struct Cap { p: vec3f, n: vec3f };
fn capsuleAt(c: vec4f, A: vec4f, B: vec4f) -> Cap {
  var d = B.xyz - A.xyz; let L = max(length(d), 1e-5); d = d / L;
  let h = select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(d.y) > 0.9);
  let e1 = normalize(cross(d, h)); let e2 = cross(d, e1);
  let r = mix(A.w, B.w, c.z);
  let n = normalize(e1 * c.x + e2 * c.y + d * c.w);
  return Cap(mix(A.xyz, B.xyz, c.z) + (e1 * c.x + e2 * c.y + d * c.w) * r, n);
}
fn capsule(c: vec4f, ii: u32) -> Cap { return capsuleAt(c, segs[2u * ii], segs[2u * ii + 1u]); }
@vertex fn vsGill(@location(0) c: vec4f, @builtin(instance_index) ii: u32) -> VOut {
  let k = capsule(c, ii);
  // the same point on the resting gill, so sugar crystals stay stuck as it flutters
  let rest = capsuleAt(c, segRest[2u * ii], segRest[2u * ii + 1u]).p;
  var o: VOut;
  o.pos = u.viewProj * vec4f(k.p, 1.0);
  o.world = k.p; o.nrm = k.n; o.rest = rest; o.mat = vec4f(1.0, 1.0, 0.0, 0.0); o.kind = 2u; o.glow = 0.0;
  return o;
}
@vertex fn vsGillShadow(@location(0) c: vec4f, @builtin(instance_index) ii: u32) -> @builtin(position) vec4f {
  return u.lightVP * vec4f(capsule(c, ii).p, 1.0);
}
@vertex fn vsDrop(@location(0) sp: vec3f, @builtin(instance_index) ii: u32) -> VOut {
  var o: VOut;
  let d = drops[ii]; let p = d.xyz + sp * d.w;
  o.pos = u.viewProj * vec4f(p, 1.0);
  o.world = p; o.nrm = sp; o.rest = sp * d.w; o.mat = vec4f(1.0, 1.0, 0.0, 0.0); o.kind = 1u; o.glow = 0.0;
  return o;
}
@vertex fn vsDropShadow(@location(0) sp: vec3f, @builtin(instance_index) ii: u32) -> @builtin(position) vec4f {
  let d = drops[ii]; return u.lightVP * vec4f(d.xyz + sp * d.w, 1.0);
}

fn toSRGB(c: vec3f) -> vec3f {
  let x = clamp(c, vec3f(0.0), vec3f(1.0));
  return select(1.055 * pow(x, vec3f(1.0 / 2.4)) - 0.055, x * 12.92, x <= vec3f(0.0031308));
}
fn hash12(p: vec2f) -> f32 { return fract(sin(dot(p, vec2f(12.9898, 78.233))) * 43758.5453); }
fn hash13(p: vec3f) -> f32 { return fract(sin(dot(p, vec3f(127.1, 311.7, 74.7))) * 43758.5453); }
fn noise3(p: vec3f) -> f32 {
  let i = floor(p); let f = fract(p); let s = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash13(i), hash13(i + vec3f(1,0,0)), s.x), mix(hash13(i + vec3f(0,1,0)), hash13(i + vec3f(1,1,0)), s.x), s.y),
             mix(mix(hash13(i + vec3f(0,0,1)), hash13(i + vec3f(1,0,1)), s.x), mix(hash13(i + vec3f(0,1,1)), hash13(i + vec3f(1,1,1)), s.x), s.y), s.z);
}

struct FOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vsFull(@builtin(vertex_index) i: u32) -> FOut {
  var o: FOut;
  let xy = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  o.pos = vec4f(xy * 2.0 - 1.0, 0.0, 1.0); o.uv = vec2f(xy.x, 1.0 - xy.y);
  return o;
}

fn noise2(p: vec2f) -> f32 {
  let i = floor(p); let f = fract(p); let s = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2f(1.0, 0.0)), s.x), mix(hash12(i + vec2f(0.0, 1.0)), hash12(i + vec2f(1.0, 1.0)), s.x), s.y);
}
fn fbm(p0: vec2f) -> f32 {
  var p = p0; var a = 0.5; var v = 0.0;
  for (var i = 0; i < 5; i++) { v += a * noise2(p); p = p * 2.03 + vec2f(1.7, 9.2); a *= 0.5; }
  return v;
}
// grid lines w wide every step units, antialiased with the pixel footprint
fn grid(c: vec2f, step: f32, w: f32, fw: vec2f) -> f32 {
  let g = abs(fract(c / step - 0.5) - 0.5) * step;
  let l = vec2f(1.0) - smoothstep(vec2f(w), vec2f(w) + fw * 1.5, g);
  return max(l.x, l.y);
}
// The tabletop: 0 studio paper, 1 cutting mat, 2 marble, 3 night
fn tabletop(P: vec2f, fw: vec2f, mode: f32, paper: vec3f) -> vec3f {
  let fade = 1.0 - smoothstep(0.08, 0.3, max(fw.x, fw.y));   // drop detail where it would shimmer
  if (mode < 0.5) { return paper; }
  if (mode < 1.5) {
    let c = P + vec2f(0.13, 0.07);
    let minor = grid(c, 0.5, 0.006, fw) * 0.35;
    let major = grid(c, 2.5, 0.012, fw);
    let diag = (1.0 - smoothstep(0.008, 0.008 + fw.x * 1.5, abs(c.x - c.y + 1.0) * 0.7071)) * 0.5;
    let line = max(max(minor, major), diag) * fade;
    let mottled = paper * (0.94 + 0.12 * fbm(P * 3.0));
    return mix(mottled, vec3f(0.52, 0.72, 0.56), line * 0.75);
  }
  if (mode < 2.5) {
    let n = fbm(P * 0.8);
    let v = abs(sin(P.x * 1.4 + P.y * 0.55 + n * 6.0));
    let vein = (1.0 - smoothstep(0.0, 0.04, v)) * 0.45 + (1.0 - smoothstep(0.0, 0.3, v)) * 0.1;
    let fine = (1.0 - smoothstep(0.0, 0.03, abs(sin(P.x * 3.1 - P.y * 1.7 + fbm(P * 2.1 + 4.0) * 7.0)))) * 0.08;
    let cloud = fbm(P * 1.7 + 11.0);
    return paper * (1.0 - (vein + fine) * fade * 0.55) * (0.96 + 0.06 * cloud) * vec3f(1.0, 0.995, 0.985);
  }
  // night: a dark surface under a soft spotlight
  let d = P - vec2f(0.0, 0.1);
  return paper + vec3f(0.05, 0.052, 0.062) * exp(-dot(d, d) * 0.22) + vec3f(0.004) * fbm(P * 6.0);
}

@fragment fn fsFloor(in: FOut) -> @location(0) vec4f {
  let ndc = vec2f(in.uv.x * 2.0 - 1.0, 1.0 - in.uv.y * 2.0);
  let a = u.invViewProj * vec4f(ndc, 0.0, 1.0); let b = u.invViewProj * vec4f(ndc, 1.0, 1.0);
  let ro = a.xyz / a.w; let rd = normalize(b.xyz / b.w - ro);
  let paper = u.paper.rgb;
  // derivatives must be taken before any branch, so find the hit for every pixel first
  let hitT = select(60.0, min(-ro.y / rd.y, 60.0), rd.y < -1e-4);
  let P = ro + rd * hitT;
  let fw = fwidth(P.xz);
  if (rd.y > -1e-4) { return vec4f(paper, 1.0); }
  let base = tabletop(P.xz, fw, u.flags.z, paper);
  let lp = u.lightVP * vec4f(P, 1.0);
  let suv = vec2f(lp.x * 0.5 + 0.5, 0.5 - lp.y * 0.5);
  let z = lp.z - 0.0015;
  let dim = vec2f(textureDimensions(shadowTex));
  let rot = hash12(in.pos.xy) * 6.2831;
  var blk = 0.0; var nb = 0.0;
  for (var i = 0; i < 16; i++) {
    let r = sqrt((f32(i) + 0.5) / 16.0) * 0.045; let ang = f32(i) * 2.39996 + rot;
    let q = clamp(suv + vec2f(cos(ang), sin(ang)) * r, vec2f(0.0), vec2f(0.9999));
    let d = textureLoad(shadowTex, vec2i(q * dim), 0);
    if (d < z) { blk += d; nb += 1.0; }
  }
  var occ = 0.0; var height = 1.0;
  if (nb > 0.0) {
    height = (z - blk / nb) * u.misc.z;
    let pen = clamp(height * 0.03, 0.0015, 0.04);
    var lit = 0.0;
    for (var i = 0; i < 24; i++) {
      let r = sqrt((f32(i) + 0.5) / 24.0) * pen; let ang = f32(i) * 2.39996 + rot;
      lit += textureSampleCompareLevel(shadowTex, cmpSamp, suv + vec2f(cos(ang), sin(ang)) * r, z);
    }
    occ = 1.0 - lit / 24.0;
  }
  let strength = u.deep.a * mix(1.0, 0.5, clamp(height / 0.8, 0.0, 1.0));
  var col = base * mix(vec3f(1.0), u.deep.rgb, occ * strength);
  // light focused through the gel: a coloured glow at the shadow's soft edge
  let glow = occ * (1.0 - occ) * 4.0 * smoothstep(0.03, 0.3, height);
  col += u.tint.rgb * max(base, vec3f(0.03)) * glow * select(0.16, 0.9, u.flags.z > 2.5);
  return vec4f(col, 1.0);
}
@fragment fn fsBlit(in: FOut) -> @location(0) vec4f {
  return vec4f(toSRGB(textureSampleLevel(sceneTex, linSamp, in.uv, 0.0).rgb), 1.0);
}
@fragment fn fsBack(in: VOut) -> @location(0) vec4f {
  let vz = -(u.view * vec4f(in.world, 1.0)).z;
  let milk = select(0.0, smoothstep(0.02, -0.02, in.mat.x), in.kind == 0u);
  return vec4f(vz, milk, f32(in.kind == 2u), 1.0);
}

// ── coatings ────────────────────────────────────────────────────────────────
fn hash33(p0: vec3f) -> vec3f {
  var q = fract(p0 * vec3f(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yxz + 33.33);
  return fract((q.xxy + q.yxx) * q.zyx);
}
// nearest jittered point in a 3-D grid: x = distance, yzw = that cell's randoms
fn voronoi3(p: vec3f) -> vec4f {
  let i = floor(p); let f = fract(p);
  var best = 8.0; var id = vec3f(0.0);
  for (var z = -1; z <= 1; z++) { for (var y = -1; y <= 1; y++) { for (var x = -1; x <= 1; x++) {
    let g = vec3f(f32(x), f32(y), f32(z));
    let h = hash33(i + g);
    let d = length(g + 0.1 + h * 0.8 - f);
    if (d < best) { best = d; id = i + g; }
  } } }
  return vec4f(best, hash33(id * 1.37 + 17.0));
}
// sugar: the same search, but each cell holds a little cube turned to its own
// angle, so grains read as crystals rather than dots. x = distance to the
// nearest cube's surface measure, yzw = that crystal's randoms
fn sugar3(p: vec3f) -> vec4f {
  let i = floor(p); let f = fract(p);
  var best = 8.0; var id = vec3f(0.0);
  for (var z = -1; z <= 1; z++) { for (var y = -1; y <= 1; y++) { for (var x = -1; x <= 1; x++) {
    let g = vec3f(f32(x), f32(y), f32(z));
    let h = hash33(i + g);
    let v = g + 0.1 + h * 0.8 - f;
    let a = h.z * 6.2831; let b = h.x * 6.2831;
    let r1 = vec3f(cos(a) * v.x - sin(a) * v.z, v.y, sin(a) * v.x + cos(a) * v.z);
    let r = vec3f(r1.x, cos(b) * r1.y - sin(b) * r1.z, sin(b) * r1.y + cos(b) * r1.z);
    let d = max(max(abs(r.x), abs(r.y)), abs(r.z)) * (0.75 + 0.5 * h.y);
    if (d < best) { best = d; id = i + g; }
  } } }
  return vec4f(best, hash33(id * 1.37 + 17.0));
}

// what one unit of rainbow gummy lets through: red at the snout, round to blue past the tail
fn rainbowTint(x: f32) -> vec3f {
  let h = fract(0.985 + (1.15 - x) * 0.19);
  let c = clamp(abs(fract(h + vec3f(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0) - 1.0, vec3f(0.0), vec3f(1.0));
  return mix(vec3f(0.97), c, 0.66);
}

fn studio(R: vec3f, L: vec3f) -> vec3f {
  let sky = mix(u.paper.rgb * 0.55, vec3f(1.0), smoothstep(-0.35, 0.7, R.y));
  let box1 = smoothstep(0.88, 0.94, dot(R, L)) * 2.2;
  let box2 = smoothstep(0.93, 0.97, dot(R, normalize(vec3f(0.9, 0.45, 0.5)))) * 1.1;
  return sky + vec3f(box1 + box2);
}

@fragment fn fsJelly(in: VOut) -> @location(0) vec4f {
  let V = normalize(u.camPos.xyz - in.world);
  var N = normalize(in.nrm);
  if (dot(N, V) < 0.0) { N = normalize(N - V * dot(N, V) * 1.05); }
  let NdotV = clamp(dot(N, V), 0.0, 1.0);
  let L = normalize(u.lightDir.xyz);
  let vz = -(u.view * vec4f(in.world, 1.0)).z;
  let back = textureLoad(backTex, vec2i(in.pos.xy), 0);
  let thick = clamp(back.r - vz, 0.0, 1.5);
  let nv = (u.view * vec4f(N, 0.0)).xyz;
  let uv = in.pos.xy * u.screen.zw - nv.xy * vec2f(1.0, -1.0) * (0.02 + 0.06 * thick);
  let floorCol = textureSampleLevel(sceneTex, linSamp, uv, 0.0).rgb;
  let wrap = clamp(dot(N, L) * 0.5 + 0.5, 0.0, 1.0);

  let isGill = in.kind == 2u;
  var tint = select(u.tint, u.gill, isGill);
  if (u.finish.z > 0.5) {
    let along = select(in.world.x, in.rest.x, in.kind == 0u);
    if (!isGill) { tint = vec4f(rainbowTint(along), tint.a); }
  }
  let milkLit = u.milk.rgb * (0.72 + 0.28 * wrap);
  let behind = mix(floorCol, milkLit * 0.95, step(0.5, back.g));
  let T = pow(tint.rgb, vec3f(thick * tint.a));
  var col = behind * T + tint.rgb * tint.rgb * (1.0 - T.r) * (0.08 + 0.14 * wrap);
  // light scattered inside the gel itself: keeps the gummy its own colour
  // on a dark or coloured table instead of tinting whatever is behind it
  let darkness = 1.0 - smoothstep(0.05, 0.55, dot(floorCol, vec3f(0.2126, 0.7152, 0.0722)));
  col = mix(col, tint.rgb * (0.3 + 0.6 * wrap), mix(0.38, 0.82, darkness) * (1.0 - exp(-thick * 3.0)));
  col += tint.rgb * 0.2 * pow(1.0 - NdotV, 2.0) * wrap;

  if (in.kind == 0u) {
    // pale belly: a soft milky layer under the clear skin
    let m = smoothstep(0.02, -0.02, in.mat.x);
    let skinTint = mix(vec3f(1.0), tint.rgb, 0.15 + 0.5 * pow(1.0 - NdotV, 1.5));
    col = mix(col, milkLit * skinTint, m * 0.85);
    // wild-type speckles: melanophores scattered through the gel
    let sp = smoothstep(0.62, 0.72, noise3(in.rest * 24.0)) * u.flags.x;
    col *= 1.0 - 0.6 * sp;
    // the smile
    let ml = 1.0 - smoothstep(0.003, 0.008, abs(in.mat.y));
    col = mix(col, tint.rgb * tint.rgb * 0.25, ml * 0.8);
    // eyes
    let ed = min(distance(in.rest, u.eyeL.xyz), distance(in.rest, u.eyeR.xyz));
    let eyeCol = mix(vec3f(0.5, 0.12, 0.14), vec3f(0.006, 0.007, 0.012), u.flags.y);
    col = mix(col, eyeCol, 1.0 - smoothstep(0.026, 0.032, ed));
    // a regrowing bud: pale and glowing while it fills in
    if (in.glow > 0.0) {
      let g = in.glow;
      col = mix(col, vec3f(1.0, 0.92, 0.9), g * 0.55);
      col += vec3f(1.0, 0.75, 0.72) * pow(1.0 - NdotV, 2.0) * g * 0.9;
    }
  }
  if (isGill) {
    let sp = smoothstep(0.62, 0.72, noise3(in.world * 22.0)) * u.flags.x;
    col *= 1.0 - 0.5 * sp;
  }

  // ── finish ──
  var gloss = 1.0; var sparkle = 0.0;
  let sugar = u.finish.y;
  if (u.finish.x > 0.5 && u.finish.x < 1.5) {
    // Sour: acid dust clouds the gel, then sugar crystals about half a millimetre across.
    // They live in rest space, so they ride along as the jelly stretches.
    col = mix(col, tint.rgb * (0.42 + 0.5 * wrap) + vec3f(0.1), 0.42 * sugar);
    let grainScale = select(34.0, 85.0, isGill);   // gills are thin: finer sugar
    let vc = sugar3(in.rest * grainScale);
    let grain = (1.0 - smoothstep(0.29, 0.35, vc.x)) * step(vc.y, 0.5 + 0.5 * sugar);
    let facet = normalize(N + (vc.yzw * 2.0 - 1.0) * 0.9);   // each crystal is tilted its own way
    let lit = clamp(dot(facet, L) * 0.5 + 0.62, 0.0, 1.15);
    // crystals vary: some milky, some nearly clear, a few bright
    let crystal = mix(vec3f(0.97, 0.96, 0.94), tint.rgb, 0.12 + 0.3 * vc.w) * (0.45 + 0.55 * lit) * (0.8 + 0.35 * vc.z);
    col = mix(col, crystal, grain * (0.35 + 0.5 * sugar) * (0.6 + 0.4 * vc.y));
    // a few crystals line up with the light and flash
    sparkle = pow(max(dot(reflect(-V, facet), L), 0.0), 140.0) * grain * 5.0;
    // a finer dust of smaller crystals packed between the big ones
    let dust = sugar3(in.rest * grainScale * 2.3);
    let fine = (1.0 - smoothstep(0.2, 0.27, dust.x)) * step(dust.y, 0.6) * (1.0 - grain);
    col = mix(col, vec3f(0.95, 0.94, 0.92) * (0.6 + 0.4 * wrap), fine * 0.4 * sugar);
    sparkle += pow(max(dot(reflect(-V, normalize(N + (dust.yzw - 0.5) * 1.4)), L), 0.0), 200.0) * fine * 2.5;
    gloss = 0.18;
  } else if (u.finish.x > 1.5) {
    // Frosted: starch-dusted, satin, cloudy all the way through
    col = mix(col, tint.rgb * (0.4 + 0.55 * wrap) + vec3f(0.07), 0.5);
    let st = voronoi3(in.rest * select(85.0, 170.0, isGill));
    col += vec3f(0.07) * (1.0 - smoothstep(0.22, 0.38, st.x)) * step(st.y, 0.55) * wrap;
    gloss = 0.22;
  }

  let R = reflect(-V, N);
  let F = 0.035 + 0.965 * pow(1.0 - NdotV, 5.0);
  col = mix(col, studio(R, L), F * mix(0.35, 1.0, gloss));
  let H = normalize(L + V); let nh = max(dot(N, H), 0.0);
  col += vec3f(pow(nh, 260.0) * 3.0 * gloss + pow(nh, 48.0) * 0.04 + pow(nh, 14.0) * 0.1 * (1.0 - gloss) + sparkle);
  return vec4f(toSRGB(col), 1.0);
}

@vertex fn vsLine(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  return u.viewProj * vec4f(nodes[edges[i]].xyz, 1.0);
}
@fragment fn fsLine() -> @location(0) vec4f { return vec4f(0.25, 0.06, 0.1, 0.22); }
`;

async function createRenderer(canvas, geo, sim) {
  if (!navigator.gpu) throw new Error('no-webgpu');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('no-adapter');
  const device = await adapter.requestDevice();
  const ctx = canvas.getContext('webgpu');
  const format = navigator.gpu.getPreferredCanvasFormat();
  ctx.configure({ device, format, alphaMode: 'opaque' });
  const module = device.createShaderModule({ code: SHADER });
  for (const m of (await module.getCompilationInfo()).messages) if (m.type === 'error') throw new Error('WGSL: ' + m.message + ' @' + m.lineNum);

  const S = GPUBufferUsage.STORAGE;
  const buf = (data, usage) => {
    const b = device.createBuffer({ size: Math.max(16, Math.ceil(data.byteLength / 4) * 4), usage: usage | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(b, 0, data); return b;
  };

  // ── parts: one vertex/index buffer each, tets packed into one array ──
  const parts = [geo.body, ...geo.legs];
  const tetTotal = parts.reduce((a, p) => a + p.tets.length, 0);
  const allTets = new Uint32Array(tetTotal);
  let tetBase = 0;
  const partBufs = parts.map(p => {
    allTets.set(p.tets, tetBase);
    const base = tetBase / 4; tetBase += p.tets.length;
    const nv = p.surf.pos.length / 3, vtx = new ArrayBuffer(nv * 56), f32 = new Float32Array(vtx), u32 = new Uint32Array(vtx);
    for (let i = 0; i < nv; i++) {
      const o = 14 * i;
      f32.set(p.surf.pos.subarray(3*i, 3*i+3), o); f32.set(p.surf.nrm.subarray(3*i, 3*i+3), o + 3);
      f32.set(p.emb.bary.subarray(3*i, 3*i+3), o + 6); u32[o + 9] = base + p.emb.tetOf[i];
      f32.set(p.surf.mat.subarray(4*i, 4*i+4), o + 10);
    }
    return { vb: buf(vtx, GPUBufferUsage.VERTEX), ib: buf(p.surf.idx, GPUBufferUsage.INDEX), count: p.surf.idx.length };
  });
  const tetBuf = buf(allTets, S);

  // every block's edges, as global particle indices, for the mesh overlay
  const edgeRanges = [];
  const allEdges = new Uint32Array(sim.blocks.reduce((a, b) => a + b.topo.edges.length, 0));
  let eo = 0;
  for (const b of sim.blocks) {
    for (let k = 0; k < b.topo.edges.length; k++) allEdges[eo + k] = b.topo.edges[k] + b.off;
    edgeRanges.push([eo, b.topo.edges.length]); eo += b.topo.edges.length;
  }
  const edgeBuf = buf(allEdges, S);

  const sphere = icosphere(2);
  const sbuf = buf(sphere.pos, GPUBufferUsage.VERTEX), sibuf = buf(sphere.idx, GPUBufferUsage.INDEX);
  const cap = capsuleMesh(8, 3);
  const cbuf = buf(cap.vtx, GPUBufferUsage.VERTEX), cibuf = buf(cap.idx, GPUBufferUsage.INDEX);

  const nodeArr = new Float32Array(sim.N * 4);
  const nodeBuf = device.createBuffer({ size: nodeArr.byteLength, usage: S | GPUBufferUsage.COPY_DST });
  const nodeFBuf = device.createBuffer({ size: sim.nodeF.byteLength, usage: S | GPUBufferUsage.COPY_DST });
  const dropArr = new Float32Array(sim.maxDrops * 4);
  const dropBuf = device.createBuffer({ size: dropArr.byteLength, usage: S | GPUBufferUsage.COPY_DST });
  const instArr = new Uint32Array(40);
  const instBuf = device.createBuffer({ size: instArr.byteLength, usage: S | GPUBufferUsage.COPY_DST });
  const G = geo.gills, segCount = Array.from(G.parent).filter(p => p >= 0).length;
  const segArr = new Float32Array(segCount * 8);
  const segBuf = device.createBuffer({ size: segArr.byteLength, usage: S | GPUBufferUsage.COPY_DST });
  const segRestArr = new Float32Array(segCount * 8);
  for (let i = 0, s = 0; i < G.parent.length; i++) {
    const p = G.parent[i]; if (p < 0) continue;
    segRestArr.set([G.rest[3*p], G.rest[3*p+1], G.rest[3*p+2], G.segRadius[i], G.rest[3*i], G.rest[3*i+1], G.rest[3*i+2], G.radius[i]], 8 * s++);
  }
  const segRestBuf = buf(segRestArr, S);
  const uArr = new Float32Array(116);
  const uBuf = device.createBuffer({ size: uArr.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

  const V = GPUShaderStage.VERTEX, Fr = GPUShaderStage.FRAGMENT;
  const bgl0 = device.createBindGroupLayout({ entries: [
    { binding: 0, visibility: V | Fr, buffer: { type: 'uniform' } },
    ...[1, 2, 3, 4, 5, 6, 7, 8].map(binding => ({ binding, visibility: V, buffer: { type: 'read-only-storage' } })),
  ]});
  const bgl1 = device.createBindGroupLayout({ entries: [
    { binding: 0, visibility: Fr, texture: { sampleType: 'depth' } }, { binding: 1, visibility: Fr, sampler: { type: 'comparison' } }] });
  const bgl2 = device.createBindGroupLayout({ entries: [
    { binding: 0, visibility: Fr, texture: { sampleType: 'float' } }, { binding: 1, visibility: Fr, texture: { sampleType: 'unfilterable-float' } },
    { binding: 2, visibility: Fr, sampler: { type: 'filtering' } }] });
  const L0 = device.createPipelineLayout({ bindGroupLayouts: [bgl0] });
  const L01 = device.createPipelineLayout({ bindGroupLayouts: [bgl0, bgl1] });
  const L012 = device.createPipelineLayout({ bindGroupLayouts: [bgl0, bgl1, bgl2] });
  const bg0 = device.createBindGroup({ layout: bgl0, entries: [uBuf, nodeBuf, nodeFBuf, tetBuf, dropBuf, edgeBuf, instBuf, segBuf, segRestBuf].map((buffer, binding) => ({ binding, resource: { buffer } })) });

  const partVB = [{ arrayStride: 56, attributes: [
    { shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' },
    { shaderLocation: 2, offset: 24, format: 'float32x3' }, { shaderLocation: 3, offset: 36, format: 'uint32' },
    { shaderLocation: 4, offset: 40, format: 'float32x4' }] }];
  const sphereVB = [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] }];
  const capVB = [{ arrayStride: 16, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x4' }] }];

  const MSAA = 4, mk = (o) => device.createRenderPipeline(o);
  const shadowPipe = (vs, buffers) => mk({ layout: L0, vertex: { module, entryPoint: vs, buffers }, primitive: { cullMode: 'none' },
    depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less', depthBias: 2, depthBiasSlopeScale: 2 } });
  const backPipe = (vs, buffers) => mk({ layout: L0, vertex: { module, entryPoint: vs, buffers },
    fragment: { module, entryPoint: 'fsBack', targets: [{ format: 'rgba16float' }] }, primitive: { cullMode: 'front' },
    depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' } });
  const jellyPipe = (vs, buffers) => mk({ layout: L012, vertex: { module, entryPoint: vs, buffers },
    fragment: { module, entryPoint: 'fsJelly', targets: [{ format }] }, primitive: { cullMode: 'back' },
    depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' }, multisample: { count: MSAA } });
  const P = {
    shPart: shadowPipe('vsPartShadow', partVB), shGill: shadowPipe('vsGillShadow', capVB), shDrop: shadowPipe('vsDropShadow', sphereVB),
    floor: mk({ layout: L01, vertex: { module, entryPoint: 'vsFull' }, fragment: { module, entryPoint: 'fsFloor', targets: [{ format: 'rgba16float' }] } }),
    bkPart: backPipe('vsPart', partVB), bkGill: backPipe('vsGill', capVB), bkDrop: backPipe('vsDrop', sphereVB),
    blit: mk({ layout: L012, vertex: { module, entryPoint: 'vsFull' }, fragment: { module, entryPoint: 'fsBlit', targets: [{ format }] },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'always' }, multisample: { count: MSAA } }),
    part: jellyPipe('vsPart', partVB), gill: jellyPipe('vsGill', capVB), drop: jellyPipe('vsDrop', sphereVB),
    lines: mk({ layout: L0, vertex: { module, entryPoint: 'vsLine' },
      fragment: { module, entryPoint: 'fsLine', targets: [{ format, blend: { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } } }] },
      primitive: { topology: 'line-list' }, depthStencil: { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'always' }, multisample: { count: MSAA } }),
  };

  const shadowTex = device.createTexture({ size: [2048, 2048], format: 'depth32float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
  const bg1 = device.createBindGroup({ layout: bgl1, entries: [{ binding: 0, resource: shadowTex.createView() }, { binding: 1, resource: device.createSampler({ compare: 'less', magFilter: 'linear', minFilter: 'linear' }) }] });
  const linSamp = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });

  let T = null;
  function resize(w, h) {
    if (T && T.w === w && T.h === h) return;
    T && [T.scene, T.back, T.backDepth, T.msaa, T.depth].forEach(t => t.destroy());
    const RA = GPUTextureUsage.RENDER_ATTACHMENT, TB = GPUTextureUsage.TEXTURE_BINDING;
    T = { w, h,
      scene: device.createTexture({ size: [w, h], format: 'rgba16float', usage: RA | TB }),
      back: device.createTexture({ size: [w, h], format: 'rgba16float', usage: RA | TB }),
      backDepth: device.createTexture({ size: [w, h], format: 'depth24plus', usage: RA }),
      msaa: device.createTexture({ size: [w, h], format, sampleCount: MSAA, usage: RA }),
      depth: device.createTexture({ size: [w, h], format: 'depth24plus', sampleCount: MSAA, usage: RA }) };
    T.bg2 = device.createBindGroup({ layout: bgl2, entries: [{ binding: 0, resource: T.scene.createView() }, { binding: 1, resource: T.back.createView() }, { binding: 2, resource: linSamp }] });
  }

  function render(frame) {
    const { cam, look, showMesh } = frame;
    resize(canvas.width, canvas.height);

    const x = sim.x;
    for (let i = 0; i < sim.N; i++) { nodeArr[4*i] = x[3*i]; nodeArr[4*i+1] = x[3*i+1]; nodeArr[4*i+2] = x[3*i+2]; }
    device.queue.writeBuffer(nodeBuf, 0, nodeArr);
    device.queue.writeBuffer(nodeFBuf, 0, sim.nodeF);
    const nd = sim.dCount;
    for (let i = 0; i < nd; i++) { dropArr[4*i] = sim.dp[3*i]; dropArr[4*i+1] = sim.dp[3*i+1]; dropArr[4*i+2] = sim.dp[3*i+2]; dropArr[4*i+3] = sim.dr[i]; }
    if (nd) device.queue.writeBuffer(dropBuf, 0, dropArr, 0, nd * 4);

    // instance table: [leg i → slots 4i…], [16 → body]
    const legCounts = sim.legSlots.map((slots, i) => {
      let k = 0;
      for (const b of slots) if (b.active) { instArr[2 * (4*i + k)] = b.off; instArr[2 * (4*i + k) + 1] = Math.round(1000 * Math.min(1, b.slot ? 1 : b.grow)); k++; }
      return k;
    });
    instArr[32] = 0; instArr[33] = 1000;
    device.queue.writeBuffer(instBuf, 0, instArr);

    // gill segments from the particle chains
    let s = 0;
    for (let i = 0; i < sim.gn; i++) {
      const p = G.parent[i]; if (p < 0) continue;
      segArr.set([sim.gx[3*p], sim.gx[3*p+1], sim.gx[3*p+2], G.segRadius[i], sim.gx[3*i], sim.gx[3*i+1], sim.gx[3*i+2], G.radius[i]], 8 * s++);
    }
    device.queue.writeBuffer(segBuf, 0, segArr);

    uArr.set(cam.viewProj, 0); uArr.set(cam.invViewProj, 16); uArr.set(cam.view, 32); uArr.set(cam.lightVP, 48);
    uArr.set([...cam.eye, 1], 64); uArr.set([...cam.lightDir, 0], 68);
    uArr.set(look.tint, 72); uArr.set(look.deep, 76); uArr.set([...look.milk, 1], 80);
    uArr.set([T.w, T.h, 1 / T.w, 1 / T.h], 84); uArr.set([frame.time, showMesh ? 1 : 0, cam.lightRange, 0], 88);
    uArr.set([...geo.landmarks.eyes[0], 0], 92); uArr.set([...geo.landmarks.eyes[1], 0], 96);
    uArr.set([...look.paper, 1], 100); uArr.set(look.gill, 104); uArr.set(look.flags, 108); uArr.set(look.finish, 112);
    device.queue.writeBuffer(uBuf, 0, uArr);

    const drawParts = (p) => {
      p.setVertexBuffer(0, partBufs[0].vb); p.setIndexBuffer(partBufs[0].ib, 'uint32'); p.drawIndexed(partBufs[0].count, 1, 0, 0, 16);
      legCounts.forEach((k, i) => { if (!k) return; const b = partBufs[1 + i]; p.setVertexBuffer(0, b.vb); p.setIndexBuffer(b.ib, 'uint32'); p.drawIndexed(b.count, k, 0, 0, 4 * i); });
    };
    const drawGills = (p) => { p.setVertexBuffer(0, cbuf); p.setIndexBuffer(cibuf, 'uint32'); p.drawIndexed(cap.idx.length, segCount); };
    const drawDrops = (p) => { if (!nd) return; p.setVertexBuffer(0, sbuf); p.setIndexBuffer(sibuf, 'uint32'); p.drawIndexed(sphere.idx.length, nd); };

    const enc = device.createCommandEncoder();
    let p = enc.beginRenderPass({ colorAttachments: [], depthStencilAttachment: { view: shadowTex.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' } });
    p.setBindGroup(0, bg0);
    p.setPipeline(P.shPart); drawParts(p); p.setPipeline(P.shGill); drawGills(p); if (nd) { p.setPipeline(P.shDrop); drawDrops(p); }
    p.end();

    p = enc.beginRenderPass({ colorAttachments: [{ view: T.scene.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
    p.setBindGroup(0, bg0); p.setBindGroup(1, bg1); p.setPipeline(P.floor); p.draw(3); p.end();

    p = enc.beginRenderPass({ colorAttachments: [{ view: T.back.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [1000, 0, 0, 1] }],
      depthStencilAttachment: { view: T.backDepth.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' } });
    p.setBindGroup(0, bg0);
    p.setPipeline(P.bkPart); drawParts(p); p.setPipeline(P.bkGill); drawGills(p); if (nd) { p.setPipeline(P.bkDrop); drawDrops(p); }
    p.end();

    p = enc.beginRenderPass({ colorAttachments: [{ view: T.msaa.createView(), resolveTarget: ctx.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'discard', clearValue: [0, 0, 0, 1] }],
      depthStencilAttachment: { view: T.depth.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'discard' } });
    p.setBindGroup(0, bg0); p.setBindGroup(1, bg1); p.setBindGroup(2, T.bg2);
    p.setPipeline(P.blit); p.draw(3);
    p.setPipeline(P.part); drawParts(p);
    p.setPipeline(P.gill); drawGills(p);
    if (nd) { p.setPipeline(P.drop); drawDrops(p); }
    if (showMesh) {
      p.setPipeline(P.lines);
      sim.blocks.forEach((b, k) => { if (b.active) p.draw(edgeRanges[k][1], 1, edgeRanges[k][0]); });
    }
    p.end();
    device.queue.submit([enc.finish()]);
  }
  return { render };
}

// capsule: rings around a unit segment, with hemispherical caps at both ends
function capsuleMesh(sides, capRings) {
  const vtx = [], idx = [], rings = [];
  for (let r = capRings; r >= 1; r--) rings.push([0, -Math.sin(r / capRings * Math.PI / 2), Math.cos(r / capRings * Math.PI / 2)]);
  rings.push([0, 0, 1], [1, 0, 1]);
  for (let r = 1; r <= capRings; r++) rings.push([1, Math.sin(r / capRings * Math.PI / 2), Math.cos(r / capRings * Math.PI / 2)]);
  for (const [t, cap, rad] of rings) for (let s = 0; s < sides; s++) {
    const a = s / sides * Math.PI * 2;
    vtx.push(Math.cos(a) * rad, Math.sin(a) * rad, t, cap);
  }
  for (let r = 0; r < rings.length - 1; r++) for (let s = 0; s < sides; s++) {
    const a = r * sides + s, b = r * sides + (s + 1) % sides, c = a + sides, d = b + sides;
    idx.push(a, b, c, b, d, c);
  }
  return { vtx: new Float32Array(vtx), idx: new Uint32Array(idx) };
}

function icosphere(level) {
  const t = (1 + Math.sqrt(5)) / 2;
  let v = [[-1,t,0],[1,t,0],[-1,-t,0],[1,-t,0],[0,-1,t],[0,1,t],[0,-1,-t],[0,1,-t],[t,0,-1],[t,0,1],[-t,0,-1],[-t,0,1]].map(p => { const l = Math.hypot(...p); return p.map(c => c / l); });
  let f = [[0,11,5],[0,5,1],[0,1,7],[0,7,10],[0,10,11],[1,5,9],[5,11,4],[11,10,2],[10,7,6],[7,1,8],[3,9,4],[3,4,2],[3,2,6],[3,6,8],[3,8,9],[4,9,5],[2,4,11],[6,2,10],[8,6,7],[9,8,1]];
  for (let l = 0; l < level; l++) {
    const cache = new Map(), nf = [];
    const mid = (a, b) => {
      const k = a < b ? a + ',' + b : b + ',' + a;
      if (cache.has(k)) return cache.get(k);
      const p = v[a].map((c, i) => (c + v[b][i]) / 2), len = Math.hypot(...p);
      v.push(p.map(c => c / len)); cache.set(k, v.length - 1); return v.length - 1;
    };
    for (const [a, b, c] of f) { const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a); nf.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]); }
    f = nf;
  }
  for (const tri of f) {
    const [a, b, c] = tri.map(i => v[i]);
    const n = [(b[1]-a[1])*(c[2]-a[2])-(b[2]-a[2])*(c[1]-a[1]), (b[2]-a[2])*(c[0]-a[0])-(b[0]-a[0])*(c[2]-a[2]), (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0])];
    if (n[0]*a[0] + n[1]*a[1] + n[2]*a[2] < 0) { const s = tri[1]; tri[1] = tri[2]; tri[2] = s; }
  }
  return { pos: new Float32Array(v.flat()), idx: new Uint32Array(f.flat()) };
}
