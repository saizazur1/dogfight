// powerupfx.js -- the look of powerups.js (lane CHAOS, README "Hooks contract"). It only READS pu.items and the fighters; it never
// writes the sim.
//
//   const pfx = createPowerupFx(scene, world);
//   pfx.update(frameDt, pu, fighters, camera)   // every display frame; pu null = everything hidden (and the DOM layer removed)
//   pfx.warmUp(camera)                          // one of everything in front of the camera, for the engine's shader warm-up render
//
// A pick-up: an extruded icon in its kind's colour (repair: a plus, missiles: two missiles, boost: a bolt, shield: a crest) that
// spins and bobs inside a spinning ring, a soft additive halo that never gets smaller than a few pixels (readable from 3+ km), and
// a faint light beam from the ground. A supply drop: a crate under a striped parachute (the canopy goes once it lands), a tall
// gold light pillar, a flashing light, and a DOM marker "SUPPLY DROP · 2.3 km" (clamped to the screen edge when off-screen).
// A shield: a violet fresnel bubble round each shielded jet (blinking in its last 1.5 s). A collected pick-up: a quick ring flash.
// Pooled meshes, one instanced draw for every glow / beam / ring, no allocation per frame; logdepth chunks in both custom shaders.
import * as THREE from 'three';

/** Every look number in one place (m, s, px). */
export const PFX = Object.freeze({
  COL: { repair: [0.22, 1, 0.45], missiles: [1, 0.5, 0.1], boost: [0.15, 0.75, 1], shield: [0.65, 0.4, 1], drop: [1, 0.75, 0.22] },
  CSS: { repair: '#3ddc84', missiles: '#ff9a2e', boost: '#35d0ff', shield: '#b07cff', drop: '#ffd84a' },
  ICON: 14, ICON_MIN_PX: 7, ICON_MAX_SCALE: 4,      // the icon's size (m); it grows with distance to stay this many px tall (capped)
  HALO_R: 24, HALO_PX: 14, HALO_GAIN: 2.4,           // the halo: world radius, the least on-screen radius, brightness
  HALO_NEAR: [150, 900],                              // m: closer than this the halo dims (to 35 %) so the icon reads
  CORE_R: 7, CORE_PX: 3,
  BEAM_W: 3, BEAM_PX: 2, BEAM_A: 0.6, BEAM_UP: 150,   // the beam: half width, the least px, alpha, m above the icon
  PILLAR_W: 7, PILLAR_PX: 2.6, PILLAR_H: 3500, PILLAR_A: 0.55,
  FLASH_HZ: 1.4, FLASH_PX: 16,
  SHIELD_R: 12, SHIELD_BLINK: 1.5,
  POP_S: 0.45,                                        // the collect flash
  SLOTS: 24, DROPS: 3, SHIELDS: 8, GLOWS: 160, MAXF: 64,
  EDGE: 56, EDGE_LOW: 120,                            // px: the drop marker's margin from the screen edge (bottom: clear of the HUD's bars)
});

const GLOW_VS = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec3 iPos; attribute vec4 iP; attribute vec3 iCol;
uniform float uPxAng;
varying vec2 vUv; varying vec3 vCol; varying float vA; varying float vMode;
void main() {
  vUv = position.xy; vCol = iCol; vA = iP.z > 0.5 && iP.z < 1.5 ? 1.0 : iP.w; vMode = iP.z;
  vec4 mv;
  if (iP.z < 0.5 || iP.z > 1.5) {   // 0 glow / 2 ring: camera-facing, never under iP.y px in radius
    mv = viewMatrix * vec4(iPos, 1.0);
    float r = max(iP.x, -mv.z * uPxAng * iP.y);
    mv.xy += position.xy * r;
  } else {                            // 1 beam: a vertical billboard, iP.x half wide (never under 1.5 px), iP.y tall, base at iPos
    vec3 toCam = cameraPosition - iPos; toCam.y = 0.0;
    float d = length(toCam);
    vec3 side = d > 1e-3 ? vec3(-toCam.z, 0.0, toCam.x) / d : vec3(1.0, 0.0, 0.0);
    float w = max(iP.x, d * uPxAng * iP.w);   // iP.w: the beam's least half width in px (its alpha is in iCol)
    vec3 p = iPos + side * position.x * w + vec3(0.0, (position.y * 0.5 + 0.5) * iP.y, 0.0);
    mv = viewMatrix * vec4(p, 1.0);
  }
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}`;
const GLOW_FS = /* glsl */`
#include <logdepthbuf_pars_fragment>
varying vec2 vUv; varying vec3 vCol; varying float vA; varying float vMode;
void main() {
  #include <logdepthbuf_fragment>
  vec3 col = vCol; float a;
  if (vMode < 0.5) {
    float r = length(vUv);
    if (r > 1.0) discard;
    a = exp(-r * r * 4.5) * (1.0 - r) + 0.6 * exp(-r * r * 40.0);
    col = mix(vCol, vec3(max(vCol.r, max(vCol.g, vCol.b))), exp(-r * r * 30.0) * 0.6);   // a whiter centre
  } else if (vMode < 1.5) {
    float x = abs(vUv.x), h = vUv.y * 0.5 + 0.5;
    a = (1.0 - x) * (1.0 - x) * pow(max(1.0 - h, 0.0), 1.6) * smoothstep(0.0, 0.03, h);
  } else {
    float r = length(vUv);
    if (r > 1.0) discard;
    a = smoothstep(0.72, 0.9, r) * smoothstep(1.0, 0.92, r);
  }
  gl_FragColor = vec4(col, clamp(a * vA, 0.0, 1.0));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const SHIELD_VS = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vN; varying vec3 vV; varying vec3 vP;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalMatrix * normal; vV = -mv.xyz; vP = position;
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}`;
const SHIELD_FS = /* glsl */`
#include <logdepthbuf_pars_fragment>
uniform vec3 uCol; uniform float uA; uniform float uT;
varying vec3 vN; varying vec3 vV; varying vec3 vP;
void main() {
  #include <logdepthbuf_fragment>
  vec3 n = vN * inversesqrt(max(dot(vN, vN), 1e-8)), v = vV * inversesqrt(max(dot(vV, vV), 1e-8));
  float f = pow(max(1.0 - abs(dot(n, v)), 0.0), 2.4);
  float bands = 0.5 + 0.5 * sin(vP.y * 18.0 - uT * 5.0);
  float hex = 0.5 + 0.5 * sin(vP.x * 25.0 + uT) * sin(vP.z * 25.0 - uT);
  float a = (0.004 + 0.9 * f + 0.35 * f * bands + 0.03 * hex * f) * uA;
  gl_FragColor = vec4(uCol, clamp(a, 0.0, 1.0));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// ------------------------------------------------------------------ the icons (extruded 2-D shapes, ~14 m tall, centred)
function poly(pts, s = 1) { const sh = new THREE.Shape(); sh.moveTo(pts[0][0] * s, pts[0][1] * s); for (let i = 1; i < pts.length; i++) sh.lineTo(pts[i][0] * s, pts[i][1] * s); sh.closePath(); return sh; }
function iconShapes(kind) {
  if (kind === 'repair') { const a = 2.3, l = 7; return [poly([[-a, l], [a, l], [a, a], [l, a], [l, -a], [a, -a], [a, -l], [-a, -l], [-a, -a], [-l, -a], [-l, a], [-a, a]])]; }
  if (kind === 'boost') return [poly([[-1.2, 7.5], [4.4, 7.5], [1.2, 1.6], [4.8, 1.6], [-3.2, -7.5], [-0.6, -0.9], [-4.4, -0.9]])];
  if (kind === 'shield') {
    const sh = new THREE.Shape();
    sh.moveTo(-5.5, 6.5); sh.lineTo(5.5, 6.5); sh.lineTo(5.5, 1); sh.quadraticCurveTo(5.5, -4.8, 0, -7.5); sh.quadraticCurveTo(-5.5, -4.8, -5.5, 1); sh.closePath();
    return [sh];
  }
  const m = (dx) => poly([[0, 7.5], [1.2, 4.6], [1.2, -3], [3.2, -6.4], [1.2, -5.6], [1.2, -7], [-1.2, -7], [-1.2, -5.6], [-3.2, -6.4], [-1.2, -3], [-1.2, 4.6]].map(([x, y]) => [x + dx, y]));
  return [m(-2.6), m(2.6)];   // missiles: two of them
}

/**
 * @param {THREE.Scene} scene
 * @param {{terrainHeightAt?:(x:number,z:number)=>number, applyEnv?:(o:THREE.Object3D,k?:number)=>void}} [world]
 */
export function createPowerupFx(scene, world = {}) {
  const th = world.terrainHeightAt || (() => 0);
  const root = new THREE.Group(); root.name = 'powerupfx'; root.visible = false;
  scene.add(root);
  const KINDS = ['repair', 'missiles', 'boost', 'shield'];
  const color = (k, g = 1) => new THREE.Color(PFX.COL[k][0] * g, PFX.COL[k][1] * g, PFX.COL[k][2] * g);

  // ---- icons: one geometry and two materials (icon, ring) per kind, shared by every slot
  const geo = {}, mat = {}, ringMat = {};
  for (const k of KINDS) {
    geo[k] = new THREE.ExtrudeGeometry(iconShapes(k), { depth: 2, bevelEnabled: true, bevelThickness: 0.5, bevelSize: 0.45, bevelSegments: 2, curveSegments: 10 });
    geo[k].center();
    mat[k] = new THREE.MeshStandardMaterial({ color: color(k), emissive: color(k), emissiveIntensity: 0.9, metalness: 0.25, roughness: 0.35 });
    ringMat[k] = new THREE.MeshStandardMaterial({ color: color(k), emissive: color(k), emissiveIntensity: 1.8, metalness: 0.1, roughness: 0.5 });
  }
  const ringGeo = new THREE.TorusGeometry(11, 0.55, 8, 56);
  const slots = [];
  for (let i = 0; i < PFX.SLOTS; i++) {
    const g = new THREE.Group(), icon = new THREE.Mesh(geo.repair, mat.repair), ring = new THREE.Mesh(ringGeo, ringMat.repair);
    ring.rotation.x = Math.PI / 2 - 0.35;
    g.add(icon, ring); g.visible = false; root.add(g);
    slots.push({ g, icon, ring, kind: 'repair', id: -1, ground: 0, wasAlive: false, popT: 99, pop: [0, 0, 0], popKind: 'repair' });
  }

  // ---- supply drops: crate, striped canopy, risers
  const crateGeo = new THREE.BoxGeometry(7, 7, 7);
  const crateMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.55, 0.36, 0.12), emissive: color('drop', 0.35), metalness: 0.2, roughness: 0.6 });
  const canopyGeo = new THREE.SphereGeometry(17, 16, 6, 0, Math.PI * 2, 0, Math.PI * 0.42);
  {
    const p = canopyGeo.getAttribute('position'), c = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) {
      const a = Math.atan2(p.getZ(i), p.getX(i)), gore = Math.floor(((a / (Math.PI * 2)) + 1) * 8 + 0.5) % 2;
      c[i * 3] = gore ? 1 : 0.95; c[i * 3 + 1] = gore ? 1 : 0.42; c[i * 3 + 2] = gore ? 1 : 0.1;
    }
    canopyGeo.setAttribute('color', new THREE.BufferAttribute(c, 3));
  }
  const canopyMat = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.8, metalness: 0, emissive: new THREE.Color(0.12, 0.08, 0.04) });
  const riserGeo = new THREE.BufferGeometry();
  {
    const v = [], rim = 17 * Math.sin(Math.PI * 0.42), rimY = 17 * Math.cos(Math.PI * 0.42) * 0.75 + 9;
    for (let k = 0; k < 8; k++) { const a = k * Math.PI / 4; v.push(0, 3.5, 0, Math.cos(a) * rim, rimY, Math.sin(a) * rim); }
    riserGeo.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  }
  const riserMat = new THREE.LineBasicMaterial({ color: 0xdddddd, transparent: true, opacity: 0.7 });
  const drops = [];
  for (let i = 0; i < PFX.DROPS; i++) {
    const g = new THREE.Group(), sway = new THREE.Group(), crate = new THREE.Mesh(crateGeo, crateMat), canopy = new THREE.Mesh(canopyGeo, canopyMat), risers = new THREE.LineSegments(riserGeo, riserMat);
    canopy.position.y = 9; canopy.scale.y = 0.75;
    sway.add(crate, canopy, risers); g.add(sway); g.visible = false; root.add(g);
    drops.push({ g, sway, canopy, risers });
  }
  if (world.applyEnv) { try { world.applyEnv(root, 1); } catch { /* the plain look */ } }

  // ---- shield bubbles
  const shieldGeo = new THREE.SphereGeometry(1, 32, 20);
  const shields = [];
  for (let i = 0; i < PFX.SHIELDS; i++) {
    const m = new THREE.ShaderMaterial({
      vertexShader: SHIELD_VS, fragmentShader: SHIELD_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uCol: { value: color('shield', 1.8) }, uA: { value: 1 }, uT: { value: 0 } },
    });
    const mesh = new THREE.Mesh(shieldGeo, m);
    mesh.visible = false; mesh.renderOrder = 11; root.add(mesh);
    shields.push(mesh);
  }
  const shieldOn = new Float32Array(PFX.MAXF);   // s each fighter has had its shield (for the pop-in)

  // ---- glows: one instanced draw of camera-facing glows (mode 0), vertical beams (1) and rings (2)
  const base = new THREE.PlaneGeometry(2, 2), gg = new THREE.InstancedBufferGeometry();
  gg.index = base.index; gg.setAttribute('position', base.getAttribute('position'));
  const aPos = new THREE.InstancedBufferAttribute(new Float32Array(PFX.GLOWS * 3), 3), aP = new THREE.InstancedBufferAttribute(new Float32Array(PFX.GLOWS * 4), 4);
  const aCol = new THREE.InstancedBufferAttribute(new Float32Array(PFX.GLOWS * 3), 3);
  for (const a of [aPos, aP, aCol]) a.setUsage(THREE.DynamicDrawUsage);
  gg.setAttribute('iPos', aPos); gg.setAttribute('iP', aP); gg.setAttribute('iCol', aCol);
  gg.instanceCount = 0;
  const glowMat = new THREE.ShaderMaterial({ vertexShader: GLOW_VS, fragmentShader: GLOW_FS, uniforms: { uPxAng: { value: 0.002 } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  const glows = new THREE.Mesh(gg, glowMat);
  glows.frustumCulled = false; glows.renderOrder = 12; root.add(glows);
  let nG = 0;
  /** stages one glow; c = a PFX.COL entry, g its gain. Mode 0 glow / 2 ring: sizeA m, sizeB least px, alpha. Mode 1 beam: sizeA half
   *  width m, sizeB height m, alpha = the least half width in px (a beam's strength is in its gain). */
  function glow(x, y, z, sizeA, sizeB, mode, alpha, c, g) {
    if (nG >= PFX.GLOWS || !(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z))) return;
    const i = nG++;
    aPos.array[i * 3] = x; aPos.array[i * 3 + 1] = y; aPos.array[i * 3 + 2] = z;
    aP.array[i * 4] = sizeA; aP.array[i * 4 + 1] = sizeB; aP.array[i * 4 + 2] = mode; aP.array[i * 4 + 3] = alpha;
    aCol.array[i * 3] = c[0] * g; aCol.array[i * 3 + 1] = c[1] * g; aCol.array[i * 3 + 2] = c[2] * g;
  }
  function flushGlows() {
    gg.instanceCount = nG;
    aPos.needsUpdate = true; aP.needsUpdate = true; aCol.needsUpdate = true;
  }
  const WHITE = [1, 1, 1];

  // ---- the DOM marker for drops
  const layer = typeof document !== 'undefined' ? document.createElement('div') : null;
  const marks = [];
  if (layer) {
    if (!document.getElementById('pfx-css')) {
      const st = document.createElement('style'); st.id = 'pfx-css';
      st.textContent = `.pfx{position:fixed;inset:0;pointer-events:none;z-index:12;overflow:hidden;font-family:Rubik,system-ui,sans-serif}
.pfx .dm{position:absolute;left:0;top:0;display:none;align-items:center;gap:7px;padding:5px 11px 5px 9px;border-radius:999px;white-space:nowrap;
  background:rgba(12,10,4,.55);color:#ffd84a;font-weight:800;font-size:13px;letter-spacing:.08em;box-shadow:0 0 0 1.5px rgba(255,216,74,.75),0 0 18px rgba(255,190,40,.35);
  -webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);will-change:transform}
.pfx .dm i{width:10px;height:10px;background:#ffd84a;transform:rotate(45deg);box-shadow:0 0 10px #ffd84a;animation:pfxP 0.9s ease-in-out infinite}
.pfx .dm.edge{opacity:.85;font-size:12px}
@keyframes pfxP{50%{transform:rotate(45deg) scale(.6)}}`;
      document.head.appendChild(st);
    }
    layer.className = 'pfx';
    for (let i = 0; i < PFX.DROPS; i++) {
      const el = document.createElement('div'); el.className = 'dm';
      const dot = document.createElement('i'), txt = document.createElement('span');
      el.append(dot, txt); layer.appendChild(el);
      marks.push({ el, txt, shown: false, edge: false, km: -1, px: -1, py: -1, hw: 90 });
    }
  }
  const V = new THREE.Vector3();
  /** the marker of drop slot k at world (x, y, z); writes the DOM only when something it shows changes */
  function mark(k, x, y, z, camera) {
    const m = marks[k];
    if (!m) return;
    const W = innerWidth, H = innerHeight, E = PFX.EDGE;
    V.set(x, y, z).applyMatrix4(camera.matrixWorldInverse);
    const behind = V.z > 0, km = Math.round(V.length() / 100) / 10;
    V.applyMatrix4(camera.projectionMatrix);
    let nx = behind ? -V.x : V.x, ny = behind ? -V.y : V.y;
    if (!Number.isFinite(nx) || !Number.isFinite(ny)) { nx = 0; ny = -1; }
    const ex = 1 - 2 * Math.max(E, m.hw + 10) / W, ey = 1 - 2 * (ny < 0 ? PFX.EDGE_LOW : E) / H, over = Math.max(Math.abs(nx) / Math.max(ex, 0.05), Math.abs(ny) / ey);   // the whole pill stays on screen
    const edge = behind || over > 1;
    if (edge) { const s = 1 / Math.max(over, 1e-6); nx *= s; ny *= s; }
    const px = Math.round((nx * 0.5 + 0.5) * W), py = Math.round((0.5 - ny * 0.5) * H);
    if (px !== m.px || py !== m.py) { m.px = px; m.py = py; m.el.style.transform = `translate(${px}px,${py}px) translate(-50%,-50%)`; }
    if (!m.shown) { m.shown = true; m.el.style.display = 'flex'; }
    if (edge !== m.edge) { m.edge = edge; m.el.classList.toggle('edge', edge); }
    if (km !== m.km) { m.km = km; m.txt.textContent = `SUPPLY DROP · ${km < 10 ? km.toFixed(1) : km.toFixed(0)} km`; m.hw = (m.el.offsetWidth || 180) / 2; }
  }
  function hideMark(k) { const m = marks[k]; if (m && m.shown) { m.shown = false; m.el.style.display = 'none'; } }

  let t = 0, attached = false;
  function hideAll() {
    for (const s of slots) { s.g.visible = false; s.wasAlive = false; s.popT = 99; s.id = -1; }
    for (const d of drops) d.g.visible = false;
    for (const m of shields) m.visible = false;
    for (let k = 0; k < marks.length; k++) hideMark(k);
    shieldOn.fill(0);
    nG = 0; flushGlows();
  }

  function setKind(s, kind) {
    if (s.kind === kind || !geo[kind]) return;
    s.kind = kind; s.icon.geometry = geo[kind]; s.icon.material = mat[kind]; s.ring.material = ringMat[kind];
  }
  const pxAng = (camera) => 2 * Math.tan((camera.fov || 68) * Math.PI / 360) / Math.max(1, typeof innerHeight === 'number' ? innerHeight : 720);

  /** one floating pick-up in slot s at (x, y, z) (y: its resting height), age in s, i the slot's phase */
  function drawItem(s, x, y, z, age, i, camera, pa) {
    const grow = Math.min(1, age / 0.6), e = grow * grow * (3 - 2 * grow);
    const by = y + Math.sin(t * 1.4 + i * 1.7) * 2.5;
    const cp = camera.position, d = Math.hypot(x - cp.x, by - cp.y, z - cp.z);
    const sc = e * Math.min(PFX.ICON_MAX_SCALE, Math.max(1, d * pa * PFX.ICON_MIN_PX / PFX.ICON));
    s.g.position.set(x, by, z); s.g.scale.setScalar(Math.max(sc, 1e-3)); s.g.visible = true;
    s.icon.rotation.y = t * 1.3 + i;
    s.ring.rotation.z = t * 0.8 + i;
    const c = PFX.COL[s.kind];
    const near = Math.max(0, Math.min(1, (d - PFX.HALO_NEAR[0]) / (PFX.HALO_NEAR[1] - PFX.HALO_NEAR[0])));
    glow(x, by, z, PFX.HALO_R * e, PFX.HALO_PX, 0, 0.85 * e * (0.35 + 0.65 * near), c, PFX.HALO_GAIN);
    glow(x, by, z, PFX.CORE_R * e, PFX.CORE_PX, 0, 0.7 * e, c, 3.2);
    glow(x, s.ground, z, PFX.BEAM_W, by - s.ground + PFX.BEAM_UP, 1, PFX.BEAM_PX, c, 2 * PFX.BEAM_A * e);
  }

  function update(frameDt, pu, fighters, camera) {
    if (!pu || !pu.items) {
      if (root.visible) { root.visible = false; hideAll(); }
      if (attached && layer) { layer.remove(); attached = false; }
      return;
    }
    if (!attached && layer) { document.body.appendChild(layer); attached = true; }
    root.visible = true;
    t += frameDt || 0;
    camera.updateMatrixWorld();
    const pa = pxAng(camera);
    glowMat.uniforms.uPxAng.value = pa;
    nG = 0;
    // pick-ups and drops
    const items = pu.items;
    let nd = 0;
    for (let i = 0; i < items.length && i < PFX.SLOTS; i++) {
      const it = items[i], s = slots[i];
      if (s.wasAlive && !it.alive) { s.popT = 0; s.pop[0] = it.pos[0]; s.pop[1] = it.pos[1]; s.pop[2] = it.pos[2]; s.popKind = it.kind; }
      s.wasAlive = it.alive;
      if (s.popT < PFX.POP_S) {   // collect flash: an expanding ring and a fading glow
        const u = s.popT / PFX.POP_S, c = PFX.COL[s.popKind] || WHITE;
        glow(s.pop[0], s.pop[1], s.pop[2], 20 + 130 * u, 12 + 60 * u, 2, (1 - u) * 1.2, c, 3);
        glow(s.pop[0], s.pop[1], s.pop[2], 40 * (1 - u), 20, 0, (1 - u), c, 3);
        s.popT += frameDt || 0;
      }
      if (!it.alive) { s.g.visible = false; continue; }
      if (it.drop) s.g.visible = false;
      const x = it.pos[0], y = it.pos[1], z = it.pos[2];
      if (!(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z))) { s.g.visible = false; continue; }
      if (it.drop) {
        if (nd >= drops.length) continue;
        const D = drops[nd], k = nd++;
        D.g.position.set(x, y, z); D.g.visible = true;
        D.canopy.visible = D.risers.visible = !!it.chute;
        D.sway.rotation.z = it.chute ? Math.sin(t * 0.9 + k) * 0.07 : 0; D.sway.rotation.x = it.chute ? Math.sin(t * 0.7 + k * 2) * 0.05 : 0;
        D.sway.rotation.y = t * 0.15;
        const c = PFX.COL.drop, flash = (t * PFX.FLASH_HZ + k * 0.33) % 1 < 0.22 ? 1 : 0.15;
        glow(x, y - 2.5, z, PFX.PILLAR_W, PFX.PILLAR_H, 1, PFX.PILLAR_PX, c, 2.2 * PFX.PILLAR_A);
        glow(x, y + 4.5, z, 8, PFX.FLASH_PX, 0, 1.1 * flash, c, 6);
        glow(x, y, z, 34, 12, 0, 0.7, c, 2.6);
        mark(k, x, y, z, camera);
        continue;
      }
      if (s.id !== it.id) { s.id = it.id; s.ground = th(x, z); if (!Number.isFinite(s.ground)) s.ground = y - 500; }
      setKind(s, it.kind);
      drawItem(s, x, y, z, it.age || 0, i, camera, pa);
    }
    for (let i = items.length; i < PFX.SLOTS; i++) slots[i].g.visible = false;
    for (let k = nd; k < drops.length; k++) { drops[k].g.visible = false; hideMark(k); }
    // shields
    let ns = 0;
    for (let i = 0; fighters && i < fighters.length; i++) {
      const f = fighters[i], id = f.id >= 0 && f.id < PFX.MAXF ? f.id : 0;
      const on = f.shield > 0 && f.alive !== false && (!f.jet || f.jet.group.visible);
      shieldOn[id] = on ? shieldOn[id] + (frameDt || 0) : 0;
      if (!on || ns >= shields.length) continue;
      const p = (f.pose && f.pose.pos) || f.s.pos;
      if (!(Number.isFinite(p[0]) && Number.isFinite(p[1]) && Number.isFinite(p[2]))) continue;
      const m = shields[ns++], u = Math.min(1, shieldOn[id] / 0.25), pop = u * u * (3 - 2 * u);
      m.position.set(p[0], p[1], p[2]); m.scale.setScalar(PFX.SHIELD_R * (0.4 + 0.6 * pop) + 1e-3); m.visible = true;
      const blink = f.shield < PFX.SHIELD_BLINK ? ((t * 7) % 1 < 0.5 ? 1 : 0.35) : 1;
      m.material.uniforms.uA.value = blink * (0.5 + 0.5 * pop);
      m.material.uniforms.uT.value = t;
    }
    for (let k = ns; k < shields.length; k++) shields[k].visible = false;
    flushGlows();
  }

  /** One of everything 60-140 m in front of the camera (the engine renders it once to compile the shaders). The next update hides it. */
  function warmUp(camera) {
    if (!camera) return;
    camera.updateMatrixWorld();
    const e = camera.matrixWorld.elements, fx = -e[8], fy = -e[9], fz = -e[10], rx = e[0], ry = e[1], rz = e[2];
    const at = (d, side, o) => { o[0] = e[12] + fx * d + rx * side; o[1] = e[13] + fy * d + ry * side; o[2] = e[14] + fz * d + rz * side; return o; };
    const P = [0, 0, 0], pa = pxAng(camera);
    root.visible = true; nG = 0;
    KINDS.forEach((k, i) => { const s = slots[i]; setKind(s, k); at(120, (i - 1.5) * 30, P); s.ground = P[1] - 200; drawItem(s, P[0], P[1], P[2], 1, i, camera, pa); });
    at(140, 0, P); const D = drops[0];
    D.g.position.set(P[0], P[1] + 25, P[2]); D.g.visible = true; D.canopy.visible = D.risers.visible = true;
    glow(P[0], P[1], P[2], PFX.PILLAR_W, 300, 1, PFX.PILLAR_PX, PFX.COL.drop, 1); glow(P[0], P[1], P[2], 30, 9, 2, 0.5, PFX.COL.drop, 2);
    at(70, 20, P); shields[0].position.set(P[0], P[1], P[2]); shields[0].scale.setScalar(PFX.SHIELD_R); shields[0].visible = true;
    glowMat.uniforms.uPxAng.value = pa;
    flushGlows();
  }

  return { update, warmUp, root };
}
