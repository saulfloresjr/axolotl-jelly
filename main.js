// ─────────────────────────────────────────────────────────────────────────────
// main.js — camera, pointer handling, the frame loop and the panel.
// ─────────────────────────────────────────────────────────────────────────────
const M4 = {
  mul(a, b) {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o[4*c+r] = a[r]*b[4*c] + a[4+r]*b[4*c+1] + a[8+r]*b[4*c+2] + a[12+r]*b[4*c+3];
    return o;
  },
  perspective(fovy, aspect, n, f) { const t = 1 / Math.tan(fovy / 2); return new Float32Array([t/aspect,0,0,0, 0,t,0,0, 0,0,f/(n-f),-1, 0,0,n*f/(n-f),0]); },
  ortho(l, r, b, t, n, f) { return new Float32Array([2/(r-l),0,0,0, 0,2/(t-b),0,0, 0,0,1/(n-f),0, -(r+l)/(r-l),-(t+b)/(t-b),n/(n-f),1]); },
  lookAt(e, c, up) {
    let z = [e[0]-c[0], e[1]-c[1], e[2]-c[2]]; const zl = Math.hypot(...z); z = z.map(v => v / zl);
    let x = [up[1]*z[2]-up[2]*z[1], up[2]*z[0]-up[0]*z[2], up[0]*z[1]-up[1]*z[0]]; const xl = Math.hypot(...x); x = x.map(v => v / xl);
    const y = [z[1]*x[2]-z[2]*x[1], z[2]*x[0]-z[0]*x[2], z[0]*x[1]-z[1]*x[0]], d = (a) => -(a[0]*e[0] + a[1]*e[1] + a[2]*e[2]);
    return new Float32Array([x[0],y[0],z[0],0, x[1],y[1],z[1],0, x[2],y[2],z[2],0, d(x),d(y),d(z),1]);
  },
  invert(m) {
    const o = new Float32Array(16);
    const [a00,a01,a02,a03,a10,a11,a12,a13,a20,a21,a22,a23,a30,a31,a32,a33] = m;
    const b00=a00*a11-a01*a10, b01=a00*a12-a02*a10, b02=a00*a13-a03*a10, b03=a01*a12-a02*a11, b04=a01*a13-a03*a11, b05=a02*a13-a03*a12;
    const b06=a20*a31-a21*a30, b07=a20*a32-a22*a30, b08=a20*a33-a23*a30, b09=a21*a32-a22*a31, b10=a21*a33-a23*a31, b11=a22*a33-a23*a32;
    const det = 1 / (b00*b11 - b01*b10 + b02*b09 + b03*b08 - b04*b07 + b05*b06);
    o[0]=(a11*b11-a12*b10+a13*b09)*det; o[1]=(a02*b10-a01*b11-a03*b09)*det; o[2]=(a31*b05-a32*b04+a33*b03)*det; o[3]=(a22*b04-a21*b05-a23*b03)*det;
    o[4]=(a12*b08-a10*b11-a13*b07)*det; o[5]=(a00*b11-a02*b08+a03*b07)*det; o[6]=(a32*b02-a30*b05-a33*b01)*det; o[7]=(a20*b05-a22*b02+a23*b01)*det;
    o[8]=(a10*b10-a11*b08+a13*b06)*det; o[9]=(a01*b08-a00*b10-a03*b06)*det; o[10]=(a30*b04-a31*b02+a33*b00)*det; o[11]=(a21*b02-a20*b04-a23*b00)*det;
    o[12]=(a11*b07-a10*b09-a12*b06)*det; o[13]=(a00*b09-a01*b07+a02*b06)*det; o[14]=(a31*b01-a30*b03-a32*b00)*det; o[15]=(a20*b03-a21*b01+a22*b00)*det;
    return o;
  },
  apply(m, p) {
    const [x, y, z] = p, w = p[3] ?? 1;
    return [m[0]*x+m[4]*y+m[8]*z+m[12]*w, m[1]*x+m[5]*y+m[9]*z+m[13]*w, m[2]*x+m[6]*y+m[10]*z+m[14]*w, m[3]*x+m[7]*y+m[11]*z+m[15]*w];
  },
};
// The visible stage as four inward-facing planes (nx, ny, nz, d), from the
// view-projection matrix: a point is on stage when left ≤ x/w ≤ right and
// bottom ≤ y/w ≤ top in clip space. `margin` pulls each wall in (world units).
function stageWalls(m, left, right, bottom, top, margin) {
  const row = (r) => [m[r], m[4 + r], m[8 + r], m[12 + r]];
  const r0 = row(0), r1 = row(1), r3 = row(3);
  const planes = [
    r0.map((v, i) => v - left * r3[i]), r0.map((v, i) => right * r3[i] - v),
    r1.map((v, i) => v - bottom * r3[i]), r1.map((v, i) => top * r3[i] - v),
  ];
  const out = new Float32Array(16);
  planes.forEach((p, k) => { const l = Math.hypot(p[0], p[1], p[2]); out.set([p[0] / l, p[1] / l, p[2] / l, p[3] / l - margin], 4 * k); });
  return out;
}
function keepOnStage(p, W) {
  for (let k = 0; W && k < W.length; k += 4) {
    const s = W[k] * p[0] + W[k + 1] * p[1] + W[k + 2] * p[2] + W[k + 3];
    if (s < 0) for (let c = 0; c < 3; c++) p[c] -= W[k + c] * s;
  }
  return p;
}

const srgbToLinear = (hex) => [0, 2, 4].map(i => { const c = parseInt(hex.slice(1 + i, 3 + i), 16) / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); });

// Morphs: body tint (+ depth scale), shadow colour, belly, gill tint (+ density), flags (speckles, dark eyes)
const LOOKS = {
  leucistic: { tint: [0.97, 0.5, 0.6, 4.2], deep: [0.8, 0.52, 0.6, 0.8], milk: [1.0, 0.9, 0.9], gill: [0.88, 0.12, 0.3, 26], flags: [0, 1, 0, 0] },
  golden:    { tint: [0.98, 0.76, 0.3, 4.0], deep: [0.82, 0.64, 0.42, 0.8], milk: [1.0, 0.96, 0.86], gill: [0.95, 0.32, 0.34, 24], flags: [0, 0, 0, 0] },
  wild:      { tint: [0.52, 0.58, 0.36, 3.6], deep: [0.46, 0.5, 0.4, 0.85], milk: [0.86, 0.86, 0.76], gill: [0.46, 0.32, 0.4, 20], flags: [1, 1, 0, 0] },
  // lagoon: the whale's teal, over a mint-white belly with deep teal gills
  lagoon:    { tint: [0.1, 0.82, 0.72, 3.8], deep: [0.24, 0.52, 0.52, 0.8], milk: [0.93, 0.98, 0.96], gill: [0.04, 0.48, 0.52, 22], flags: [0, 1, 0, 0] },
  // rainbow: the shader sets the colour along the body; these are its depth and shadow
  rainbow:   { tint: [0.95, 0.6, 0.5, 3.8], deep: [0.6, 0.5, 0.62, 0.8], milk: [1.0, 0.96, 0.9], gill: [0.9, 0.3, 0.4, 24], flags: [0, 1, 0, 0], rainbow: true },
};
// Coatings: a finish id for the shader and how much sugar it carries
const FINISHES = { glossy: [0, 0], sour: [1, 0.85], frosted: [2, 0] };

(async function main() {
  const $ = (id) => document.getElementById(id);
  const canvas = $('gl');
  const geo = Axolotl.build();
  const sim = new AxoSim(geo);

  let R;
  try { R = await createRenderer(canvas, geo, sim); }
  catch (e) {
    console.error(e);
    $('nogpu').hidden = false; $('badge').classList.add('off'); $('badge-text').textContent = 'WebGPU · unavailable';
    return;
  }

  // Tables: the floor pattern (shader) and the page theme (CSS) change together
  const TABLES = ['paper', 'mat', 'marble', 'night'];
  let paper = [0.78, 0.76, 0.72];
  const readPaper = () => { paper = srgbToLinear(getComputedStyle(document.documentElement).getPropertyValue('--paper').trim()); };
  // How the specimen starts, and what Reset puts back (sound is the visitor's own choice, so it stays)
  const DEFAULTS = { look: 'leucistic', finish: 'glossy', table: 'paper', firmness: 0.5, damping: 0.4, regrow: 0.5 };
  const state = { look: DEFAULTS.look, finish: DEFAULTS.finish, paused: false, slow: false, showMesh: false, table: DEFAULTS.table };
  function setTable(name) {
    state.table = name;
    document.documentElement.dataset.table = name;
    document.querySelectorAll('.table').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.table === name)));
    readPaper();
  }
  // remember a table only when someone picks one; Paper is the default
  document.querySelectorAll('.table').forEach(b => b.addEventListener('click', () => {
    setTable(b.dataset.table);
    try { localStorage.setItem('axolotl-table-choice', b.dataset.table); } catch (_) {}
  }));
  let savedTable = DEFAULTS.table;
  try { savedTable = localStorage.getItem('axolotl-table-choice') || DEFAULTS.table; } catch (_) {}
  setTable(TABLES.includes(savedTable) ? savedTable : DEFAULTS.table);

  const cam = { yaw: 0.55, pitch: 0.62, target: [-0.1, 0.15, 0.0], fov: 30 * Math.PI / 180, zoom: 1 };
  const lightDir = (() => { const d = [-0.42, 1.0, -0.55]; const l = Math.hypot(...d); return d.map(v => v / l); })();
  function frameCamera() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const W = canvas.clientWidth, H = canvas.clientHeight;
    canvas.width = Math.max(1, Math.round(W * dpr)); canvas.height = Math.max(1, Math.round(H * dpr));
    const panel = $('panel').getBoundingClientRect(), wide = W > 860;
    const docked = wide && panel.width > 0;   // the panel is hidden in ?cover mode
    const embedded = document.documentElement.classList.contains('embed');   // no title column to avoid
    const freeL = docked && !embedded ? Math.min(W * 0.3, 430) : 0, freeR = docked ? panel.left - 24 : W;
    const aspect = W / H, span = Math.max(200, wide ? freeR : W);
    const fitW = (wide ? (embedded ? 3.2 : 2.7) : 3.2) / (2 * Math.tan(cam.fov / 2) * aspect * ((wide ? freeR - freeL : W) / W));
    const dist = Math.max(fitW, 1.7 / (2 * Math.tan(cam.fov / 2)), 3.6) * cam.zoom;
    const eye = [cam.target[0] + dist * Math.sin(cam.yaw) * Math.cos(cam.pitch), cam.target[1] + dist * Math.sin(cam.pitch), cam.target[2] + dist * Math.cos(cam.yaw) * Math.cos(cam.pitch)];
    const view = M4.lookAt(eye, cam.target, [0, 1, 0]);
    const proj = M4.perspective(cam.fov, aspect, 0.1, 40);
    proj[8] = -(((freeL + freeR) / 2) / W * 2 - 1);
    proj[9] = wide ? 0.1 : -0.05;
    const viewProj = M4.mul(proj, view);
    const lc = [0, 0.2, 0.1], lightRange = 9.5;
    const lightView = M4.lookAt([lc[0] + lightDir[0] * 5, lc[1] + lightDir[1] * 5, lc[2] + lightDir[2] * 5], lc, [0, 0, -1]);
    const lightVP = M4.mul(M4.ortho(-2.4, 2.4, -2.4, 2.4, 0.5, 0.5 + lightRange), lightView);
    // walls where the screen ends (and where the panel starts, when it's docked)
    sim.walls = stageWalls(viewProj, -0.97, docked ? (freeR + 8) / W * 2 - 1 : 0.97, -0.96, 0.95, 0.03);
    Object.assign(cam, { eye, view, viewProj, invViewProj: M4.invert(viewProj), lightVP, lightDir, lightRange, forward: [-view[2], -view[6], -view[10]] });
  }
  function rayFrom(ev) {
    const r = canvas.getBoundingClientRect();
    const nx = (ev.clientX - r.left) / r.width * 2 - 1, ny = 1 - (ev.clientY - r.top) / r.height * 2;
    const a = M4.apply(cam.invViewProj, [nx, ny, 0, 1]), b = M4.apply(cam.invViewProj, [nx, ny, 1, 1]);
    const o = [a[0]/a[3], a[1]/a[3], a[2]/a[3]], f = [b[0]/b[3], b[1]/b[3], b[2]/b[3]];
    const d = [f[0]-o[0], f[1]-o[1], f[2]-o[2]], l = Math.hypot(...d);
    return { o, d: d.map(v => v / l) };
  }
  function onPlane(ray, p, n) {
    const t = ((p[0]-ray.o[0])*n[0] + (p[1]-ray.o[1])*n[1] + (p[2]-ray.o[2])*n[2]) / (ray.d[0]*n[0] + ray.d[1]*n[1] + ray.d[2]*n[2]);
    return [ray.o[0]+ray.d[0]*t, ray.o[1]+ray.d[1]*t, ray.o[2]+ray.d[2]*t];
  }

  // ── pointer: grab a part, grab a drop, or orbit ──
  const pointers = new Map();
  let drag = null;
  canvas.addEventListener('pointerdown', (ev) => {
    try { canvas.setPointerCapture(ev.pointerId); } catch (_) {}
    pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (pointers.size === 2 && drag && drag.kind === 'part') {
      const [a, b] = [...pointers.values()];
      drag.twist0 = Math.atan2(b.y - a.y, b.x - a.x); drag.angle0 = sim.grab ? sim.grab.angle : 0;
      return;
    }
    if (pointers.size > 1) return;
    const ray = rayFrom(ev), hit = sim.raycast(ray.o, ray.d);
    if (hit.kind === 'part') {
      sim.startGrab(hit.point, hit.block);
      sim.grab.axis = cam.forward.slice();
      JellySound.squish(hit.block === sim.body ? 1 : 0.7);
      drag = { kind: 'part', plane: hit.point, id: ev.pointerId };
    } else if (hit.kind === 'drop') {
      const i = hit.index;
      sim.dropGrab = { index: i, target: [sim.dp[3*i], sim.dp[3*i+1], sim.dp[3*i+2]] };
      JellySound.squish(0.35);
      drag = { kind: 'drop', plane: sim.dropGrab.target.slice(), id: ev.pointerId };
    } else {
      drag = { kind: 'orbit', x: ev.clientX, y: ev.clientY, yaw: cam.yaw, pitch: cam.pitch, id: ev.pointerId };
    }
    canvas.classList.add('dragging');
    $('hint').classList.add('gone');
  });
  canvas.addEventListener('pointermove', (ev) => {
    if (pointers.has(ev.pointerId)) pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (!drag) {
      if (ev.pointerType === 'mouse') { const ray = rayFrom(ev); canvas.style.cursor = sim.raycast(ray.o, ray.d).kind ? 'grab' : 'default'; }
      return;
    }
    if (drag.kind === 'part' && pointers.size === 2 && drag.twist0 !== undefined) {
      const [a, b] = [...pointers.values()];
      if (sim.grab) sim.grab.angle = drag.angle0 - (Math.atan2(b.y - a.y, b.x - a.x) - drag.twist0);
      return;
    }
    if (ev.pointerId !== drag.id) return;
    if (drag.kind === 'orbit') {
      cam.yaw = drag.yaw - (ev.clientX - drag.x) * 0.005;
      cam.pitch = Math.min(1.3, Math.max(0.12, drag.pitch + (ev.clientY - drag.y) * 0.004));
      return;
    }
    const p = keepOnStage(onPlane(rayFrom(ev), drag.plane, cam.forward), sim.walls);
    p[1] = Math.max(p[1], drag.kind === 'drop' ? 0.03 : -0.05);
    if (drag.kind === 'part' && sim.grab) sim.grab.target = p;
    if (drag.kind === 'drop' && sim.dropGrab) sim.dropGrab.target = p;
  });
  const release = (ev) => {
    pointers.delete(ev.pointerId);
    if (!drag) return;
    if (drag.kind === 'part' && pointers.size === 1 && drag.twist0 !== undefined) { drag.twist0 = undefined; return; }
    if (pointers.size > 0) return;
    if (drag.kind === 'part') { sim.grab = null; JellySound.release(1); }
    if (drag.kind === 'drop' && sim.dropGrab) {
      const i = sim.dropGrab.index;
      JellySound.fwip(Math.hypot(sim.dv[3*i], sim.dv[3*i+1], sim.dv[3*i+2]));
      sim.dropGrab = null;
    }
    drag = null;
    canvas.classList.remove('dragging');
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    if (drag && drag.kind === 'part' && sim.grab) sim.grab.angle += ev.deltaY * 0.004;
    else cam.zoom = Math.min(1.5, Math.max(0.55, cam.zoom * Math.exp(ev.deltaY * 0.001)));
  }, { passive: false });

  // ── panel ──
  const setLook = (name) => {
    state.look = name;
    document.querySelectorAll('.swatch').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.look === name)));
  };
  document.querySelectorAll('.swatch').forEach(b => b.addEventListener('click', () => setLook(b.dataset.look)));
  // ?look=lagoon starts on another morph, so a link can match the card it came from (Reset still goes back to the default)
  const askedLook = new URLSearchParams(location.search).get('look');
  if (askedLook && LOOKS[askedLook]) setLook(askedLook);
  const setFinish = (name) => {
    state.finish = name;
    document.querySelectorAll('.finish').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.finish === name)));
    JellySound.setGrit(name === 'sour' ? 1 : name === 'frosted' ? 0.3 : 0);
  };
  document.querySelectorAll('.finish').forEach(b => b.addEventListener('click', () => { setFinish(b.dataset.finish); JellySound.squish(0.5); }));
  setLook(state.look); setFinish(state.finish);
  const bindSlider = (id, key) => {
    const el = $(id), out = $(id + '-out');
    const upd = () => { sim.params[key] = +el.value; out.textContent = (+el.value).toFixed(2); };
    el.addEventListener('input', upd); upd();
  };
  bindSlider('firmness', 'firmness'); bindSlider('damping', 'damping'); bindSlider('regrow', 'regrow');
  $('startle').addEventListener('click', () => { sim.flick(); JellySound.startle(); });
  const camHome = { yaw: cam.yaw, pitch: cam.pitch, zoom: cam.zoom };
  $('reset').addEventListener('click', () => {
    sim.reset();
    setLook(DEFAULTS.look); setFinish(DEFAULTS.finish); setTable(DEFAULTS.table);
    try { localStorage.removeItem('axolotl-table-choice'); } catch (_) {}
    for (const id of ['firmness', 'damping', 'regrow']) { $(id).value = DEFAULTS[id]; $(id).dispatchEvent(new Event('input')); }
    $('slow').checked = false; state.slow = false; JellySound.setSlow(false);
    $('mesh').checked = false; state.showMesh = false;
    state.paused = false; $('pause').textContent = 'Pause';
    Object.assign(cam, camHome);
    JellySound.slurp();
    say('Reset. Everything is back the way it started.');
  });
  $('slow').addEventListener('change', (e) => { state.slow = e.target.checked; JellySound.setSlow(state.slow); });
  // audio may only start after a click or tap, so wake it on the first one
  const wake = () => JellySound.unlock();
  document.addEventListener('pointerdown', wake, true);
  document.addEventListener('keydown', wake, true);
  $('sound').checked = JellySound.enabled;
  $('sound').addEventListener('change', (e) => { JellySound.setEnabled(e.target.checked); if (e.target.checked) JellySound.squish(0.6); });
  $('mesh').addEventListener('change', (e) => { state.showMesh = e.target.checked; });
  $('pause').addEventListener('click', () => { state.paused = !state.paused; $('pause').textContent = state.paused ? 'Resume' : 'Pause'; });

  const status = $('status');
  function say(text) { status.textContent = text; }
  const tornAt = {};
  function handleEvents() {
    for (const e of sim.events) {
      if (e.type === 'plip') { JellySound.plip(e.r, e.speed); continue; }
      if (e.type === 'plop') { JellySound.plop(e.r, e.speed); continue; }
      if (e.type === 'tick') { JellySound.tick(e.speed); continue; }
      const name = geo.legs[e.leg].def.name;
      if (e.type === 'tear') { tornAt[e.leg] = sim.time; JellySound.tear(); say(`The ${name} came away. A bud is forming at the stump.`); }
      if (e.type === 'regrown') { JellySound.regrown(); say(`The ${name} grew back in ${(sim.time - (tornAt[e.leg] ?? sim.time)).toFixed(1)} s.`); }
    }
    sim.events.length = 0;
  }

  // numbers for the explainer
  const legNodes = geo.legs.reduce((a, l) => a + l.nodes.length / 3, 0);
  $('x-body').textContent = `${(geo.body.nodes.length / 3).toLocaleString()} nodes · ${(geo.body.tets.length / 4).toLocaleString()} tets`;
  $('x-legs').textContent = `${legNodes.toLocaleString()} nodes · ${geo.legs.reduce((a, l) => a + l.glue.leg.length, 0)} glue links`;
  $('x-gills').textContent = `${sim.gn} particles`;
  $('x-skin').textContent = [geo.body, ...geo.legs].reduce((a, p) => a + p.surf.idx.length / 3, 0).toLocaleString();
  $('x-build').textContent = Math.round(geo.buildMs);
  $('m-mass').textContent = (geo.visualVolume * 8 * 1.3).toFixed(1);

  // sounds that follow the simulation continuously
  const wriggleCycle = new Map();
  // the node at the top of the back: its bounce relative to the body drives the wub
  const BR = sim.bodyTopo.rest;
  let backTop = 0;
  for (let i = 0; i < sim.bodyTopo.n; i++) if (Math.abs(BR[3*i]) < 0.3 && BR[3*i+1] > BR[3*backTop+1]) backTop = i;
  let lastTarget = null, lastAngle = 0;
  function playFrameSounds(dt) {
    const G = sim.grab;
    // kneading and twisting whatever you're holding
    if (G) {
      const tg = G.target;
      const move = lastTarget ? Math.hypot(tg[0]-lastTarget[0], tg[1]-lastTarget[1], tg[2]-lastTarget[2]) / dt : 0;
      JellySound.squelch(G.block === sim.body ? move : 0, dt);   // legs have the tension wobble instead
      JellySound.setSqueak(lastTarget ? (G.angle - lastAngle) / dt : 0);
      lastTarget = tg.slice(); lastAngle = G.angle;
    } else { lastTarget = null; JellySound.squelch(0, dt); JellySound.setSqueak(0); }
    let vy = 0;
    for (let i = 0; i < sim.bodyTopo.n; i++) vy += sim.v[3*i+1];
    // while you're dragging the body the squelch leads; the wub sits underneath
    JellySound.setWobble((sim.v[3*backTop+1] - vy / sim.bodyTopo.n) * (G && G.block === sim.body ? 0.5 : 1));
    const pulling = G && G.block.leg >= 0 && G.block.slot === 0 && G.block.grow >= 1;
    JellySound.setCreak(pulling ? Math.max(0.1, (G.block.strain || 0) / 0.07) : 0);
    const growing = sim.legSlots.map(s => s[0]).filter(b => b.grow < 1);
    JellySound.setGrow(growing.length ? Math.max(...growing.map(b => b.grow)) : -1);
    JellySound.thud(sim.impact);
    // torn legs squelch in time with their wriggle (edges pulse at 17 rad/s)
    const cycle = Math.floor(sim.time * 17 / (2 * Math.PI));
    for (const b of sim.legSlots.flat()) {
      if (b.slot === 0 || !b.active || b.twitch <= 0) continue;
      if (wriggleCycle.get(b) !== cycle) { wriggleCycle.set(b, cycle); JellySound.wriggle(b.twitch); }
    }
  }

  // ── loop ──
  let last = performance.now(), statT = 0, frames = 0, simMs = 0;
  window.__jelly = { sim, cam, advance(n) { for (let i = 0; i < n; i++) frame(last + 1000 / 60, true); } };
  function frame(now, manual) {
    const realDt = Math.min(0.05, Math.max(0, (now - last) / 1000)); last = Math.max(last, now);
    frameCamera();
    if (!state.paused && realDt > 0) {
      const dt = realDt * (state.slow ? 0.25 : 1);
      sim.params.substeps = Math.max(4, Math.min(16, Math.round(dt * 720)));
      sim.step(dt);
      simMs = simMs * 0.9 + sim.stats.solveMs * 0.1;
      handleEvents();
      playFrameSounds(dt);
    } else if (state.paused) { JellySound.setCreak(0); JellySound.setGrow(-1); JellySound.setWobble(0); JellySound.setSqueak(0); }
    const L = LOOKS[state.look], F = FINISHES[state.finish];
    R.render({ cam, look: { ...L, paper, flags: [L.flags[0], L.flags[1], TABLES.indexOf(state.table), 0], finish: [F[0], F[1], L.rainbow ? 1 : 0, 0] }, showMesh: state.showMesh, time: now / 1000 });
    frames++; statT += realDt;
    if (statT > 0.2) {
      const m = sim.measure();
      $('m-vol').textContent = (m.volume * 100).toFixed(1);
      $('m-len').textContent = (m.length * 2).toFixed(1);
      $('m-legs').textContent = `${m.attached}/4`;
      $('m-legs-note').textContent = m.growing.length ? `${Math.round(m.growing[0].grow * 100)}% grown` : (m.loose ? `${m.loose} loose` : 'attached');
      $('x-ms').textContent = simMs.toFixed(1); $('x-fps').textContent = Math.round(frames / statT);
      $('x-regrown').textContent = sim.regrown;
      statT = 0; frames = 0;
    }
    if (!manual) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
