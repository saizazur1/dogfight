// weaponfx.js -- Phase 3 WEAPON EFFECTS: missiles (the real mesh, the motor flame, a lingering smoke trail), flares (a white-hot
// point, a short droopy smoke tail), gun tracers and muzzle flashes, and the warhead's burst. It only READS the combat sim's
// plain arrays each frame (combat.missiles / bullets / flares) and its events; it never writes them.
//
// Ported from the film's ~/SalesLeagueBoxingProto/web/js/jetfx.js:
//   * the puff renderer (makePuffs, L95-227): ONE instanced quad draw for every puff (smoke, flame, flare glow, tracer, spark),
//     premultiplied-alpha blending (hot puffs glow, soot occludes), the soft billowing smoke shader lit by the low sun (wrap light,
//     cool sky above, warm bounce below, a silver lining toward the sun), stretched puffs drawn as capsules so a row joins into a
//     tube, and the back-to-front order as ONE native Float64Array sort of packed (depth, index) keys (no JS comparator);
//   * fireCol (L230), hash / vnoise (L71-81), the missile flame and trail puff formulas (L612-655), the flare core/halo and smoke
//     (L673-697), the burst (L551-597: flash, dark soot, ring of fragment sparks; a closed form of its age from a point).
// What changed: the film re-read its precomputed plan at past emission times. Here every missile slot keeps a RING BUFFER of
// its own past samples (pos, vel, motor, time) recorded as it flies (at most every TRAIL_DT), and a puff is that sample plus
// wind and spread, closed-form in its age. Flare smoke uses one shared ring the same way. Everything is pooled up front.
//
// API (README "Phase 3 contract"):
//   const wfx = createWeaponFx(scene, { buildMissile, world });
//   wfx.onEvent(e)                       missileHit / missileGone / gunHit (others ignored)
//   wfx.update(frameDt, combat, camera)  once per displayed frame, before the render
//   wfx.burst(pos, vel, scale, decoy?)   a burst anywhere (vel = the velocity the cloud carries at first); Phase 4 reuses it
//   wfx.warmUp(camera?)                  one of everything in front of the camera, for the engine's shader warm-up render
//   wfx.stats()                          { puffs, trails, bursts }
//   wfx.dispose()
import * as THREE from 'three';
import { MISSILE } from './jetspec.js';

/** Every effect number in one place (metres, seconds). */
export const WFX = Object.freeze({
  WIND: [4, 0, 1.5],              // m/s: the trails drift slowly with it
  EMIT: 0.2,                      // one gain on every flame, flare, tracer and spark (matches the world's exposure / bloom)
  MAX_PUFFS: 8192,                // the one instanced draw; puffs past this are dropped (worst case ~7.5k)
  SLOTS: 8,                       // missiles in flight and trails in the sky (a trail's slot is reused once it has faded)
  TRAIL_DT: 1 / 45, TRAIL_LIFE: 12, PLUME: 3.0,
  FLARES: 48, FLARE_DT: 1 / 30, FLARE_SMOKE_LIFE: 2.6, FLARE_RING: 2048,
  BURSTS: 24, BURST: 24, BURST_R: 2.0, SPARKS: 16, BURST_LIFE: 6,
  TRACER_S: 0.03, TRACER_MAX: 30, // a tracer streak is the last 0.03 s of its flight, at most 30 m
  PX: 0.0011,                     // tracers, sparks and flares never get thinner than ~1.5 px at fov 68 / 720 p (size per metre)
  // the smoke's light (the film's numbers, the same world): sun, sky ambient above, warm bounce below
  SUN_COL: [1.05, 0.66, 0.38], SKY_AMB: [0.15, 0.17, 0.26], LOW_AMB: [0.24, 0.14, 0.09],
});
const RING = Math.ceil(WFX.TRAIL_LIFE / WFX.TRAIL_DT) + 8;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const sstep = (a, b, x) => { const u = clamp((x - a) / (b - a), 0, 1); return u * u * (3 - 2 * u); };
const lerp = (a, b, u) => a + (b - a) * u;
/** Stateless hash -> [0,1) (jetfx.js L71). */
function hash(a, b = 0) {
  let h = Math.imul((a | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((b | 0) + 0x632be5ab, 0xc2b2ae35);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}
/** Smooth 1-D value noise in [-1,1] (jetfx.js L77). */
function vnoise(x, s) { const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f); return lerp(hash(i, s), hash(i + 1, s), u) * 2 - 1; }
const U3 = [0, 0, 0];
/** A hashed unit vector into U3 (no allocation). */
function randUnit(a, b) {
  const z = hash(a, b) * 2 - 1, ph = hash(a, b + 7919) * Math.PI * 2, r = Math.sqrt(Math.max(0, 1 - z * z));
  U3[0] = r * Math.cos(ph); U3[1] = z; U3[2] = r * Math.sin(ph);
}
const FC = [0, 0, 0];
/** Fire colour, heat 1 (white-yellow) .. 0 (nothing), into FC (jetfx.js L230). */
function fireCol(h, gain) {
  const r = sstep(0.0, 0.35, h), g = sstep(0.18, 0.75, h), b = sstep(0.6, 1.0, h);
  FC[0] = gain * (0.9 * r + 0.6 * g); FC[1] = gain * (0.18 * r + 0.55 * g + 0.25 * b); FC[2] = gain * (0.03 * r + 0.08 * g + 0.45 * b);
  return FC;
}

// ------------------------------------------------------------------ the puff renderer (jetfx.js L95-227)
const PUFF_VS = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec3 iPos; attribute vec4 iSz; attribute vec3 iAlb; attribute vec3 iEm; attribute vec4 iStr;
varying vec2 vUv; varying vec3 vAlb; varying vec3 vEm; varying float vA; varying float vSeed; varying float vAge;
varying vec2 vAx; varying vec3 vWP; varying float vK; varying vec3 vFW; varying float vS;
void main() {
  vec4 mv = viewMatrix * vec4(iPos, 1.0);
  float s = iSz.x;
  vec2 sd = (viewMatrix * vec4(iStr.xyz, 0.0)).xy; float sl = length(sd);
  vec2 ax;
  if (sl > 1e-4) ax = sd / sl; else ax = vec2(cos(iSz.y), sin(iSz.y));
  vec2 ay = vec2(-ax.y, ax.x);
  vec2 off = ax * position.x * (s + 0.5 * sl) + ay * position.y * s;
  mv.xy += off;
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
  vUv = position.xy; vAlb = iAlb; vEm = iEm; vA = iSz.z; vAge = iSz.w; vSeed = iStr.w; vAx = ax; vWP = iPos;
  vK = 0.5 * sl / max(s, 1e-4); vS = s;
  vFW = iPos + (vec4(off, 0.0, 0.0) * viewMatrix).xyz;
}`;
const PUFF_FS = /* glsl */`
#include <logdepthbuf_pars_fragment>
uniform vec3 uSun; uniform vec3 uSunCol; uniform vec3 uSkyAmb; uniform vec3 uLowAmb;
varying vec2 vUv; varying vec3 vAlb; varying vec3 vEm; varying float vA; varying float vSeed; varying float vAge;
varying vec2 vAx; varying vec3 vWP; varying float vK; varying vec3 vFW; varying float vS;
float h31(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float vn3(vec3 x) { vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(h31(i), h31(i + vec3(1, 0, 0)), f.x), mix(h31(i + vec3(0, 1, 0)), h31(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(h31(i + vec3(0, 0, 1)), h31(i + vec3(1, 0, 1)), f.x), mix(h31(i + vec3(0, 1, 1)), h31(i + vec3(1, 1, 1)), f.x), f.y), f.z); }
float fbm3(vec3 p) { return 0.5 * vn3(p) + 0.3 * vn3(p * 2.03 + 7.1) + 0.2 * vn3(p * 4.1 + 3.3); }
void main() {
  #include <logdepthbuf_fragment>
  // a stretched puff is a CAPSULE, so consecutive puffs of a trail join into one tube
  float xs = vUv.x * (1.0 + vK);
  vec2 cp = vec2(sign(xs) * max(abs(xs) - vK, 0.0), vUv.y);
  float r = length(cp);
  if (r > 1.0) discard;
  float f = 1.1 / max(vS, 0.15);
  float n = fbm3(vFW * f + vec3(0.0, -vAge * 0.25, vSeed * 3.0));
  float shape = smoothstep(1.0, 0.2, r);
  float dens = clamp(shape * (0.3 + 1.2 * n) - 0.1, 0.0, 1.0);
  float a = clamp(vA * dens, 0.0, 1.0);
  vec2 ay = vec2(-vAx.y, vAx.x);
  vec3 nv = normalize(vec3(vAx * cp.x + ay * cp.y, 1.4));
  vec3 nw = normalize((vec4(nv, 0.0) * viewMatrix).xyz);
  float diff = 0.62 + 0.38 * dot(nw, uSun);
  vec3 V = vWP - cameraPosition; V *= inversesqrt(max(dot(V, V), 1e-8));   // (normalize of a zero vector is a NaN)
  float cs = max(dot(V, uSun), 0.0);
  float phase = 0.75 + 1.1 * pow(cs, 6.0) * (1.0 - 0.55 * clamp(vA, 0.0, 1.0));
  vec3 amb = mix(uLowAmb, uSkyAmb, nw.y * 0.5 + 0.5);
  vec3 lit = vAlb * (uSunCol * diff * phase * (0.75 + 0.5 * n) + amb);
  float core = pow(max(shape, 0.0), 1.6) * (0.6 + 0.8 * n);
  gl_FragColor = vec4(lit * a + vEm * core, a);   // alpha = soot (occlusion); emission adds on top
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/** One instanced draw of camera-facing puffs. emit() stages a puff; flush(camera) sorts back to front and uploads. */
function makePuffs(parent, max, sunDir, emitGain) {
  const base = new THREE.PlaneGeometry(2, 2);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = base.index; geo.setAttribute('position', base.getAttribute('position'));
  const A = {
    iPos: new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3),
    iSz: new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4),
    iAlb: new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3),
    iEm: new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3),
    iStr: new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4),
  };
  const AL = Object.values(A);
  for (const k in A) { A[k].setUsage(THREE.DynamicDrawUsage); geo.setAttribute(k, A[k]); }
  geo.instanceCount = 0;
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uSun: { value: sunDir.clone().normalize() }, uSunCol: { value: new THREE.Color(...WFX.SUN_COL) },
      uSkyAmb: { value: new THREE.Color(...WFX.SKY_AMB) }, uLowAmb: { value: new THREE.Color(...WFX.LOW_AMB) },
    },
    vertexShader: PUFF_VS, fragmentShader: PUFF_FS,
    transparent: true, depthWrite: false, depthTest: true,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false; mesh.renderOrder = 10; mesh.name = 'weaponfxPuffs';
  parent.add(mesh);

  // staging: 18 floats per puff in emission order; sorted at flush by one native sort of (depth bits * max + index) keys
  const S = new Float32Array(max * 18), key = new Float64Array(max), f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
  let n = 0, last = 0;
  const emit = (x, y, z, size, rot, alpha, age, ar, ag, ab, er, eg, eb, sx, sy, sz, seed) => {
    if (n >= max || !(size > 0) || (alpha <= 0.002 && er + eg + eb <= 0.002)) return;
    const o = n * 18;
    S[o] = x; S[o + 1] = y; S[o + 2] = z; S[o + 3] = size; S[o + 4] = rot; S[o + 5] = alpha; S[o + 6] = age;
    S[o + 7] = ar; S[o + 8] = ag; S[o + 9] = ab; S[o + 10] = er * emitGain; S[o + 11] = eg * emitGain; S[o + 12] = eb * emitGain;
    S[o + 13] = sx; S[o + 14] = sy; S[o + 15] = sz; S[o + 16] = seed; n++;
  };
  const flush = (camera) => {
    camera.updateMatrixWorld(); camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
    const e = camera.matrixWorldInverse.elements;
    for (let i = 0; i < n; i++) {
      const o = i * 18;
      f32[0] = e[2] * S[o] + e[6] * S[o + 1] + e[10] * S[o + 2] + e[14] || 0;   // view z (more negative = farther: drawn first)
      const u = u32[0];
      key[i] = (u & 0x80000000 ? ~u >>> 0 : (u | 0x80000000) >>> 0) * max + i;
    }
    const ks = key.subarray(0, n);
    ks.sort();
    const P = A.iPos.array, Z = A.iSz.array, L = A.iAlb.array, M = A.iEm.array, T = A.iStr.array;
    for (let j = 0; j < n; j++) {
      const o = (ks[j] % max) * 18;
      P[j * 3] = S[o]; P[j * 3 + 1] = S[o + 1]; P[j * 3 + 2] = S[o + 2];
      Z[j * 4] = S[o + 3]; Z[j * 4 + 1] = S[o + 4]; Z[j * 4 + 2] = S[o + 5]; Z[j * 4 + 3] = S[o + 6];
      L[j * 3] = S[o + 7]; L[j * 3 + 1] = S[o + 8]; L[j * 3 + 2] = S[o + 9];
      M[j * 3] = S[o + 10]; M[j * 3 + 1] = S[o + 11]; M[j * 3 + 2] = S[o + 12];
      T[j * 4] = S[o + 13]; T[j * 4 + 1] = S[o + 14]; T[j * 4 + 2] = S[o + 15]; T[j * 4 + 3] = S[o + 16];
    }
    for (let i = 0; i < AL.length; i++) { const a = AL[i]; a.needsUpdate = true; a.clearUpdateRanges(); a.addUpdateRange(0, Math.max(1, n) * a.itemSize); }
    geo.instanceCount = n;
    last = n; n = 0;
  };
  return { mesh, mat, emit, flush, count: () => last, dispose() { geo.dispose(); base.dispose(); mat.dispose(); parent.remove(mesh); } };
}

/**
 * Build the weapon effects. Everything is allocated here; update() allocates nothing.
 * @param {THREE.Scene} scene
 * @param {{ buildMissile?: (kind:string)=>{group:THREE.Object3D}, world?: { sunDir?: THREE.Vector3 } }} opts
 */
export function createWeaponFx(scene, { buildMissile = null, world = null } = {}) {
  const W = WFX.WIND;
  const root = new THREE.Group(); root.name = 'weaponfx'; scene.add(root);
  const sunDir = world?.sunDir?.isVector3 ? world.sunDir : new THREE.Vector3(-0.95, 0.12, -0.3);
  const puffs = makePuffs(root, WFX.MAX_PUFFS, sunDir, WFX.EMIT);
  const emit = puffs.emit;
  const ZF = new THREE.Vector3(0, 0, 1), dirV = new THREE.Vector3();
  let t = 0, camX = 0, camY = 0, camZ = 0;

  // ---- missile slots: a mesh + a ring of past samples [x y z vx vy vz motor gap] and their times
  const slots = [];
  for (let i = 0; i < WFX.SLOTS; i++) {
    let mesh;
    if (buildMissile) { const b = buildMissile('short'); mesh = b.group || b; }
    else mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.065, MISSILE.length, 10).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xd8d8d0 }));
    mesh.visible = false; mesh.matrixAutoUpdate = true; root.add(mesh);
    slots.push({ id: -1, active: false, used: false, seen: false, tEnd: 0, st: 0, k: 0, head: 0, n: 0, lastRec: -1e9,
      pos: [0, 0, 0], vel: [0, 0, 0], mesh, R: new Float32Array(RING * 8), TE: new Float64Array(RING), K: new Int32Array(RING) });
  }
  const slotOf = (id) => { for (let i = 0; i < slots.length; i++) if (slots[i].used && slots[i].id === id) return slots[i]; return null; };
  function claim(id) {
    let best = null;
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      if (!s.used) { best = s; break; }
      if (!s.active && (!best || s.tEnd < best.tEnd)) best = s;   // else steal the trail that died first
    }
    if (!best) return null;   // ponytail: >8 missiles in flight at once draw nothing extra; raise SLOTS if the game allows more
    best.id = id; best.active = true; best.used = true; best.k = 0; best.head = 0; best.n = 0; best.lastRec = -1e9;
    best.st = 1000 + ((id * 97) % 100000);
    return best;
  }

  // ---- flare smoke: one shared ring [x y z vx vy vz burn] + times + seeds
  const FR = new Float32Array(WFX.FLARE_RING * 7), FTE = new Float64Array(WFX.FLARE_RING), FK = new Int32Array(WFX.FLARE_RING);
  let fHead = 0, fN = 0, fK = 0, fAcc = 0;

  // ---- bursts: [t0, x y z, vx vy vz, scale, st, decoy]
  const B = new Float64Array(WFX.BURSTS * 10).fill(-1e9);
  let bHead = 0, bCount = 0;

  /**
   * Start a burst at pos (the warhead's: flash, dark soot, fragment sparks; jetfx.js L551). vel = the velocity the cloud carries
   * at first (it is left in the air within ~0.25 s). scale 1 = a missile hit, ~0.3 = a gun hit; decoy = the lighter self-destruct.
   */
  function burst(pos, vel, scale = 1, decoy = false) {
    const o = bHead * 10; bHead = (bHead + 1) % WFX.BURSTS;
    B[o] = t; B[o + 1] = pos[0]; B[o + 2] = pos[1]; B[o + 3] = pos[2];
    B[o + 4] = vel ? vel[0] : 0; B[o + 5] = vel ? vel[1] : 0; B[o + 6] = vel ? vel[2] : 0;
    B[o + 7] = scale; B[o + 8] = 7000 + (bCount++ % 5000) * 131; B[o + 9] = decoy ? 1 : 0;
  }
  function drawBurst(o) {
    const a = t - B[o];
    if (a < 0 || a > WFX.BURST_LIFE) return 0;
    const c0x = B[o + 1], c0y = B[o + 2], c0z = B[o + 3], vx = B[o + 4], vy = B[o + 5], vz = B[o + 6];
    const scale = B[o + 7], st = B[o + 8], decoy = B[o + 9] > 0;
    const e = (1 - Math.exp(-4 * a)) / 4;
    const cx = c0x + vx * e + W[0] * a, cy = c0y + vy * e + 0.5 * a, cz = c0z + vz * e + W[2] * a;
    const N = Math.round(WFX.BURST * scale);
    for (let i = 0; i < N; i++) {
      const h1 = hash(st, i * 3 + 1), h2 = hash(st, i * 3 + 2), h3 = hash(st, i * 3 + 3);
      randUnit(st + 11, i);
      const grow = 1 - Math.exp(-a / (0.08 + 0.1 * h2));
      const ri = (0.2 + 0.8 * Math.cbrt(h1)) * WFX.BURST_R * scale * grow * (1 + 0.25 * a);
      const size = scale * (decoy ? 2.2 : 1) * (0.5 + 0.9 * h2) * (0.25 + 0.75 * grow) * (1 + 0.45 * a);
      const heat = Math.exp(-a / (0.02 + 0.03 * h3));
      const fc = fireCol(heat, 5 * heat);
      const soot = 0.92 * sstep(0.0, 0.05, a) * (1 - sstep(1.2 + 1.2 * h1, 4.0 + 2.0 * h1, a));
      const alb = decoy ? 0.2 + 0.08 * h3 : 0.035 + 0.05 * h3;
      emit(cx + U3[0] * ri, cy + U3[1] * ri, cz + U3[2] * ri, size, h1 * 6.28, soot, a, alb * 0.85, alb, alb * 1.2, fc[0], fc[1], fc[2], 0, 0, 0, h2);
    }
    const d = Math.hypot(cx - camX, cy - camY, cz - camZ), px = d * WFX.PX;
    if (a < 0.1) { const f = Math.exp(-a / 0.022); emit(cx, cy, cz, Math.max(WFX.BURST_R * scale * 0.55, 3 * px), 0, 0, a, 0, 0, 0, 9 * f, 8 * f, 6.5 * f, 0, 0, 0, 0.5); }
    if ((decoy || scale >= 0.5) && a < 0.35) {   // a flash core and a softer glow that read at a kilometre (the film: decoy only)
      const f = Math.exp(-a / 0.06);
      emit(cx, cy, cz, Math.max(2 * scale, 4 * px), 0, 0, a, 0, 0, 0, 14 * f, 12 * f, 9 * f, 0, 0, 0, 0.5);
      emit(cx, cy, cz, Math.max(4.5 * scale, 10 * px), 0, 0, a, 0, 0, 0, 1.6 * f, 1.1 * f, 0.6 * f, 0, 0, 0, 0.8);
    }
    const NS = WFX.SPARKS * Math.max(scale, 0.35);
    for (let i = 0; i < NS; i++) {
      const life = 0.1 + 0.25 * hash(st + 3, i);
      if (a > life) continue;
      randUnit(st + 12, i);
      U3[1] *= 0.35; const l = Math.hypot(U3[0], U3[1], U3[2]) || 1;
      const ux = U3[0] / l, uy = U3[1] / l, uz = U3[2] / l;
      const sp = (90 + 160 * hash(st + 4, i)) * Math.min(1, scale + 0.3), f = (1 - Math.exp(-5 * a)) / 5, ve = sp * Math.exp(-5 * a) * 0.012;
      const hot = 1 - a / life;
      emit(c0x + vx * a + ux * sp * f, c0y + vy * a + uy * sp * f, c0z + vz * a + uz * sp * f,
        Math.max(0.05, px), 0, 0, a, 0, 0, 0, 6 * hot, 4 * hot, 2 * hot, ux * ve, uy * ve, uz * ve, 0.4);
    }
    return 1;
  }

  /** Combat events: bursts for hits and missile ends. Everything else is drawn from the arrays. */
  function onEvent(e) {
    if (!e) return;
    if (e.type === 'missileHit' || e.type === 'missileGone') {
      const s = slotOf(e.missile), p = e.pos || (s && s.pos);
      if (!p) return;
      const v = s ? s.vel : null, k = 0.1;
      const vi = v ? VI : null; if (v) { VI[0] = v[0] * k; VI[1] = v[1] * k; VI[2] = v[2] * k; }
      if (e.type === 'missileHit') burst(p, vi, 2, false);   // twice the film's warhead: it must read at gun range
      else if (e.reason === 'ground') burst(p, null, 0.8, false);
      else burst(p, vi, 0.55, true);   // decoyed / out of fuel: the lighter self-destruct among the flares
    } else if (e.type === 'gunHit' && e.pos) burst(e.pos, e.vel || null, 0.3, false);
  }
  const VI = [0, 0, 0];

  function drawMissiles(combat) {
    for (let i = 0; i < slots.length; i++) slots[i].seen = false;
    const ms = combat ? combat.missiles : null;
    if (ms) for (let i = 0; i < ms.length; i++) {
      const m = ms[i];
      if (!m || !m.alive) continue;
      let s = slotOf(m.id);
      if (s && !s.active) continue;   // a dead id never comes back
      if (!s) s = claim(m.id);
      if (!s) continue;
      s.seen = true;
      s.pos[0] = m.pos[0]; s.pos[1] = m.pos[1]; s.pos[2] = m.pos[2];
      s.vel[0] = m.vel[0]; s.vel[1] = m.vel[1]; s.vel[2] = m.vel[2];
      const motor = m.motor || 0;
      // the mesh along the velocity
      const sp = Math.hypot(m.vel[0], m.vel[1], m.vel[2]);
      if (sp > 1) dirV.set(m.vel[0] / sp, m.vel[1] / sp, m.vel[2] / sp); else dirV.copy(ZF);
      const mesh = s.mesh; mesh.visible = true;
      mesh.position.set(m.pos[0], m.pos[1], m.pos[2]); mesh.quaternion.setFromUnitVectors(ZF, dirV);
      // record a trail sample (ring buffer)
      const gap = t - s.lastRec;
      if (gap >= WFX.TRAIL_DT * 0.999) {
        const h = s.head, o = h * 8, R = s.R;
        R[o] = m.pos[0]; R[o + 1] = m.pos[1]; R[o + 2] = m.pos[2]; R[o + 3] = m.vel[0]; R[o + 4] = m.vel[1]; R[o + 5] = m.vel[2];
        R[o + 6] = motor; R[o + 7] = Math.min(gap, 0.1);
        s.TE[h] = t; s.K[h] = s.k++; s.head = (h + 1) % RING; if (s.n < RING) s.n++; s.lastRec = t;
      }
      // the motor flame (jetfx.js L612): a white core at the nozzle and a short orange plume streaked back
      if (motor > 0.02) {
        const fl = motor * (0.85 + 0.15 * vnoise(t * 40, s.st)), len = WFX.PLUME * fl, b = MISSILE.length / 2;
        const px = m.pos[0], py = m.pos[1], pz = m.pos[2], dx = dirV.x, dy = dirV.y, dz = dirV.z;
        const big = Math.max(1, Math.hypot(px - camX, py - camY, pz - camZ) * WFX.PX / 0.13);   // stays a visible point far off
        emit(px - dx * b, py - dy * b, pz - dz * b, 0.13 * big, 0, 0, 0, 0, 0, 0, 90 * fl, 75 * fl, 55 * fl, -dx * 0.4, -dy * 0.4, -dz * 0.4, 0.3);
        emit(px - dx * (b + len / 2), py - dy * (b + len / 2), pz - dz * (b + len / 2), 0.2 * big, 0, 0, 0,
          0, 0, 0, 24 * fl, 10 * fl, 3 * fl, -dx * len, -dy * len, -dz * len, 0.6);
      }
    }
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      if (s.seen && s.n > 0) connector(s);
      if (s.active && !s.seen) { s.active = false; s.tEnd = t; }
      if (!s.active) s.mesh.visible = false;
      if (!s.used) continue;
      if (!s.active && t - s.tEnd > WFX.TRAIL_LIFE) { s.used = false; continue; }
      drawTrail(s);
    }
  }

  /** The live smoke between the newest ring sample and the nozzle (samples are up to TRAIL_DT apart: ~15 m at 650 m/s). */
  function connector(s) {
    const R = s.R, o = ((s.head - 1 + RING) % RING) * 8, back = MISSILE.length / 2 + 0.6, motor = R[o + 6];
    const vx = s.vel[0], vy = s.vel[1], vz = s.vel[2], v = Math.hypot(vx, vy, vz) || 1;
    const ax = s.pos[0] - vx / v * back, ay = s.pos[1] - vy / v * back, az = s.pos[2] - vz / v * back;   // the nozzle, now
    const wx = R[o + 3], wy = R[o + 4], wz = R[o + 5], w = Math.hypot(wx, wy, wz) || 1;
    const bx = R[o] - wx / w * back, by = R[o + 1] - wy / w * back, bz = R[o + 2] - wz / w * back;          // the newest sample's front
    const thick = 0.45 + 0.55 * motor;
    emit((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2, 0.3 + 0.3 * thick, 0, 0.62 + 0.33 * motor, 0.01,
      0.23, 0.24, 0.28, 0, 0, 0, ax - bx, ay - by, az - bz, hash(s.st, 77));
  }

  /** One missile's smoke from its ring, newest first (jetfx.js L631-655, the plan read replaced by the ring). */
  function drawTrail(s) {
    const R = s.R, st = s.st, LIFE = WFX.TRAIL_LIFE, back = MISSILE.length / 2 + 0.6;
    for (let j = 0; j < s.n; j++) {
      const h = (s.head - 1 - j + RING) % RING, te = s.TE[h], a = t - te;
      if (a > LIFE) break;
      const o = h * 8, k = s.K[h], motor = R[o + 6], g = R[o + 7];
      const sx = R[o + 3] * g, sy = R[o + 4] * g, sz = R[o + 5] * g;
      const Ls = Math.sqrt(sx * sx + sy * sy + sz * sz) || 1;
      const thick = 0.45 + 0.55 * motor;
      randUnit(st, k);
      const spread = (1.0 * Math.sqrt(Math.max(0, a)) + 0.12 * a) * (0.5 + 0.5 * thick);
      const mx = vnoise(te * 0.8, st + 1) * 6 * sstep(0, 6, a), mz = vnoise(te * 0.8, st + 2) * 6 * sstep(0, 6, a);
      const size = (0.3 + 0.3 * thick) + (2.0 + 3.6 * thick) * (1 - Math.exp(-a / 1.4)) + 0.35 * a;
      const alpha = (0.62 + 0.33 * motor) * (0.4 + 0.65 * Math.exp(-a / 2.6)) * (1 - sstep(LIFE * 0.55, LIFE, a)) * (0.8 + 0.4 * hash(st, k + 5));
      // the capsule runs from this sample back to the previous one (never ahead of it: the live connector covers the front)
      emit(R[o] - sx / Ls * back - sx * 0.8 + W[0] * a + U3[0] * spread + mx, R[o + 1] - sy / Ls * back - sy * 0.8 + W[1] * a + U3[1] * spread * 0.7 + 0.35 * a / (1 + 0.2 * a),
        R[o + 2] - sz / Ls * back - sz * 0.8 + W[2] * a + U3[2] * spread + mz, size, hash(st, k) * 6.28, alpha, a,
        0.23, 0.24, 0.28, 0, 0, 0, sx * 1.6, sy * 1.6, sz * 1.6, hash(st, k + 3));   // no fire glow: the plume is the flame
    }
  }

  /** Flares (jetfx.js L673-697): a white-hot core and halo that grow with distance (bloom does the rest), a short smoke tail. */
  function drawFlares(combat, frameDt) {
    const fl = combat ? combat.flares : null;
    fAcc += frameDt;
    const tick = fAcc >= WFX.FLARE_DT; if (tick) fAcc = Math.min(fAcc - WFX.FLARE_DT, WFX.FLARE_DT);
    let shown = 0;
    if (fl) for (let i = 0; i < fl.length && shown < WFX.FLARES; i++) {
      const f = fl[i];
      if (!f || !f.alive || !(f.burn > 0.001)) continue;
      shown++;
      const st = 3000 + i * 31, x = f.pos[0], y = f.pos[1], z = f.pos[2];
      const b = f.burn * (0.78 + 0.22 * vnoise(t * 28, st));
      const gr = Math.min(1, Math.hypot(x - camX, y - camY, z - camZ) / 900);
      emit(x, y, z, 0.38 + 0.3 * gr, 0, 0, f.age, 0, 0, 0, 80 * b, 74 * b, 64 * b, 0, 0, 0, 0.2);
      emit(x, y, z, 1.0 + 1.6 * gr, 0, 0, f.age, 0, 0, 0, 1.4 * b, 1.15 * b, 0.85 * b, 0, 0, 0, 0.7);
      if (tick) {
        const o = fHead * 7;
        FR[o] = x; FR[o + 1] = y; FR[o + 2] = z; FR[o + 3] = f.vel[0]; FR[o + 4] = f.vel[1]; FR[o + 5] = f.vel[2]; FR[o + 6] = f.burn;
        FTE[fHead] = t; FK[fHead] = fK++; fHead = (fHead + 1) % WFX.FLARE_RING; if (fN < WFX.FLARE_RING) fN++;
      }
    }
    // ponytail: the flare ring holds 2048 samples (~1.4 s of 48 flares); with that many the oldest smoke drops early
    const LIFE = WFX.FLARE_SMOKE_LIFE, D = WFX.FLARE_DT * 1.6, st = 3000;
    for (let j = 0; j < fN; j++) {
      const h = (fHead - 1 - j + WFX.FLARE_RING) % WFX.FLARE_RING, ae = t - FTE[h];
      if (ae > LIFE) break;
      const o = h * 7, kk = FK[h], burn = FR[o + 6];
      randUnit(st, kk);
      const size = 0.35 + 2.6 * (1 - Math.exp(-ae / 0.7)) + 0.3 * ae, spread = 0.6 * Math.sqrt(Math.max(0, ae));
      const alpha = 0.75 * burn * (0.3 + 0.7 * Math.exp(-ae / 0.8)) * (1 - sstep(LIFE * 0.5, LIFE, ae));
      const hot = Math.max(0, 1 - ae / 0.03) * burn;
      emit(FR[o] - FR[o + 3] * D * 0.3 + W[0] * ae + U3[0] * spread, FR[o + 1] - FR[o + 4] * D * 0.3 + W[1] * ae + U3[1] * spread + 0.4 * ae, FR[o + 2] - FR[o + 5] * D * 0.3 + W[2] * ae + U3[2] * spread,
        size, hash(st, kk) * 6.28, alpha, ae, 0.9, 0.88, 0.86, 5 * hot, 3.6 * hot, 2.2 * hot, FR[o + 3] * D, FR[o + 4] * D, FR[o + 5] * D, hash(st, kk + 9));
    }
  }

  /** Tracers: a thin hot streak behind each bullet, at least ~1.5 px wide; a muzzle flash where a round has just left. */
  function drawBullets(combat) {
    const bs = combat ? combat.bullets : null;
    if (!bs) return;
    for (let i = 0; i < bs.length; i++) {
      const b = bs[i];
      if (!b || !b.alive) continue;
      const x = b.pos[0], y = b.pos[1], z = b.pos[2], vx = b.vel[0], vy = b.vel[1], vz = b.vel[2];
      const sp = Math.hypot(vx, vy, vz) || 1, age = b.age || 0;
      const dx = vx / sp, dy = vy / sp, dz = vz / sp;
      const d = Math.hypot(x - camX, y - camY, z - camZ), w = Math.max(0.05, d * WFX.PX);
      const L = Math.min(sp * WFX.TRACER_S, WFX.TRACER_MAX, sp * age + 1);
      emit(x - dx * L * 0.5, y - dy * L * 0.5, z - dz * L * 0.5, w, 0, 0, age, 0, 0, 0, 26, 19, 8, dx * L, dy * L, dz * L, 0.4);
      if (age < 0.02) {   // the muzzle: where this round was fired (pos - vel * age)
        const fx = x - vx * age, fy = y - vy * age, fz = z - vz * age, fd = Math.hypot(fx - camX, fy - camY, fz - camZ);
        const f = 0.7 + 0.3 * hash(i, Math.floor(t * 60));
        emit(fx + dx * 0.6, fy + dy * 0.6, fz + dz * 0.6, Math.max(0.35, 2 * fd * WFX.PX), hash(i, 3) * 6.28, 0, 0, 0, 0, 0, 30 * f, 20 * f, 8 * f, dx * 1.2, dy * 1.2, dz * 1.2, 0.5);
      }
    }
  }

  /** Once per displayed frame, before the render. frameDt 0 = paused (nothing ages). */
  function update(frameDt, combat, camera) {
    t += frameDt;
    camera.updateMatrixWorld();
    const ce = camera.matrixWorld.elements; camX = ce[12]; camY = ce[13]; camZ = ce[14];
    drawMissiles(combat);
    drawFlares(combat, frameDt);
    drawBullets(combat);
    for (let i = 0; i < WFX.BURSTS; i++) drawBurst(i * 10);
    puffs.flush(camera);
  }

  /** For the engine's warm-up render: a missile mesh and a puff 40 m in front of the camera. The next update() clears it. */
  function warmUp(camera) {
    const m = slots[0].mesh;
    if (camera) {
      camera.updateMatrixWorld();
      const e = camera.matrixWorld.elements, x = e[12] - e[8] * 40, y = e[13] - e[9] * 40, z = e[14] - e[10] * 40;
      m.position.set(x, y, z); m.visible = true;
      emit(x, y + 2, z, 3, 0, 0.6, 1, 0.23, 0.24, 0.28, 10, 8, 6, 0, 0, 0, 0.5);
      puffs.flush(camera);
    }
  }

  function dispose() {
    puffs.dispose();
    for (const s of slots) s.mesh.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });   // materials are the jet's: not ours
    scene.remove(root);
  }

  const stats = () => {
    let trails = 0, bursts = 0;
    for (const s of slots) if (s.used) trails++;
    for (let i = 0; i < WFX.BURSTS; i++) if (t - B[i * 10] < WFX.BURST_LIFE) bursts++;
    return { puffs: puffs.count(), trails, bursts };
  };
  return { onEvent, update, burst, warmUp, dispose, stats, root };
}
