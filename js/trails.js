/**
 * trails.js — wingtip ribbons (README "Hooks contract", lane UNLOCKS).
 *
 *   const trails = createTrails(scene, world);
 *   trails.set(fighter, styleId)    'vapor' | 'none' | 'neon' | 'rainbow' | 'fire' | 'ice' | 'galaxy' | 'gold' (unknown -> vapor)
 *   trails.clear(fighter)           wipes the history (respawns teleport)
 *   trails.update(frameDt, fighters, camera)
 *
 * Per jet: two camera-facing ribbons (left / right wingtip) in ONE mesh (one draw), from a ring buffer of world-space tip
 * positions sampled at 30 Hz (2.4 s) plus the live tip as the head, so the ribbon stays glued to the wing. The vertex buffer is
 * rebuilt head -> tail every frame on the CPU (8 jets x 2 x 73 points: cheap) and the index buffer never changes. Preallocated
 * for the 8-jet pool, nothing allocated per frame. 'vapor' is subtle normal-blended white that thickens with g; the unlockables
 * are additive (bright enough to touch the bloom at the core). Each jet has its own material (same program) for its colour.
 */
import * as THREE from 'three';

const MAX = 8;                       // the game's pool
const N = 72;                        // history samples per wingtip
const SAMPLE = 1 / 30;               // s between samples -> N * SAMPLE = 2.4 s
const M = N + 1;                     // + the live head
const LIFE = N * SAMPLE;
const SERIAL_WRAP = 3000;            // along-coordinate wrap (rainbow: 0.05 / sample -> 150 whole cycles, seamless)
const TIP = [5.95, -0.08, -3.8];     // jet space (+x = the pilot's LEFT): the wingtip rail's tail, behind jetspec's wingtips
const TELEPORT2 = 400 * 400;         // a jump this big in one frame is a respawn: start over

const STYLES = { vapor: 0, neon: 1, rainbow: 2, fire: 3, ice: 4, galaxy: 5, gold: 6 };
//                     half width (m), spread to the tail (x), min half width per metre of camera distance
const WIDTH = [[0.2, 3.0, 0.0008], [0.26, 1.4, 0.0013], [0.3, 1.4, 0.0013], [0.32, 2.0, 0.0013], [0.28, 1.6, 0.0013], [0.34, 1.6, 0.0013], [0.28, 1.4, 0.0013]];

const VS = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec4 aD;            // age 0..1, across -1..1, strength 0..1, along (samples)
varying vec4 vD; varying vec3 vW;
void main() {
  vD = aD; vW = position;   // the mesh sits at the world origin: position is world space
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}`;
const FS = /* glsl */`
#include <logdepthbuf_pars_fragment>
uniform float uStyle; uniform vec3 uColor; uniform float uTime;
varying vec4 vD; varying vec3 vW;
vec3 hue(float h) { return clamp(abs(fract(h + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0) - 1.0, 0.0, 1.0); }
float h21(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
// a twinkling star field on the ribbon: cells along x across, one star in some cells
float stars(float s, float x, float density, float rate) {
  vec2 g = vec2(s * density, (x * 0.5 + 0.5) * 4.0), id = floor(g), f = fract(g) - 0.5;
  float h = h21(id);
  float tw = 0.5 + 0.5 * sin(uTime * (rate + h * 5.0) + h * 60.0);
  return step(0.82, h) * smoothstep(0.32, 0.0, length(f)) * tw;
}
void main() {
  #include <logdepthbuf_fragment>
  float age = clamp(vD.x, 0.0, 1.0), x = clamp(vD.y, -1.0, 1.0), k = clamp(vD.z, 0.0, 1.0), s = vD.w;
  float edge = 1.0 - abs(x);
  float tail = 1.0 - age; tail *= tail;
  float a = tail * smoothstep(0.0, 0.025, age);         // emerges from the tip, fades along the length
  a *= smoothstep(8.0, 30.0, distance(vW, cameraPosition));   // never a wall of colour across the chase camera
  if (a < 0.004) discard;
  float soft = smoothstep(0.0, 0.7, edge), core = edge * edge * edge * edge;
  int st = int(uStyle + 0.5);
  vec3 c = vec3(1.0); float alpha = 0.0;
  if (st == 0) {                                          // vapour: thin white, stronger when pulling g
    c = vec3(0.92, 0.95, 1.0);
    alpha = a * soft * (0.07 + 0.5 * k);
  } else {
    float boost = 1.0 + 0.4 * k;
    if (st == 1) {                                        // neon: the jet's own colour, white-hot core
      c = uColor * 1.7 + vec3(1.1) * core;
    } else if (st == 2) {                                 // rainbow: hue cycles along and over time
      c = hue(fract(s * 0.05 - uTime * 0.5)) * 1.5 + vec3(0.6) * core;
    } else if (st == 3) {                                 // fire: white-yellow at the tip -> orange -> embers
      c = mix(vec3(1.8, 1.2, 0.35), vec3(1.6, 0.4, 0.05), smoothstep(0.0, 0.12, age));
      c = mix(c, vec3(0.5, 0.06, 0.01), smoothstep(0.12, 0.8, age));
      c *= 0.75 + 0.25 * sin(s * 1.9 + uTime * 23.0 + x * 2.0);
      c += vec3(0.8, 0.5, 0.15) * core;
    } else if (st == 4) {                                 // ice: cyan with frosty sparkles
      c = mix(vec3(0.25, 0.8, 1.5), vec3(1.4, 1.8, 2.0), core) + vec3(2.5) * stars(s, x, 1.3, 9.0);
    } else if (st == 5) {                                 // galaxy: deep violet / blue clouds, twinkling stars
      float n = 0.5 + 0.5 * sin(s * 0.11 + x * 1.7 + uTime * 0.6) * sin(s * 0.047 - uTime * 0.3);
      c = mix(vec3(0.5, 0.08, 1.1), vec3(0.08, 0.45, 1.3), n) + vec3(3.0) * stars(s, x, 1.0, 4.0);
    } else {                                              // gold: warm metal glow with glints
      c = mix(vec3(1.5, 0.85, 0.15), vec3(2.0, 1.6, 0.8), core) + vec3(3.0, 2.4, 1.2) * stars(s, x, 1.1, 7.0);
    }
    c *= boost;
    alpha = a * soft;
  }
  gl_FragColor = vec4(c, alpha);
}`;

/**
 * @param {THREE.Scene} scene
 * @param {object} [world]  unused today (kept for the contract: env / quality later)
 */
export function createTrails(scene, world) {
  void world;
  const group = new THREE.Group(); group.name = 'trails';
  scene.add(group);
  const index = new Uint16Array((M - 1) * 12);
  for (let i = 0, o = 0; i < M - 1; i++) {
    for (let r = 0; r < 2; r++) {
      const a = (r * M + i) * 2, b = a + 2;
      index[o++] = a; index[o++] = a + 1; index[o++] = b; index[o++] = a + 1; index[o++] = b + 1; index[o++] = b;
    }
  }
  const indexAttr = new THREE.BufferAttribute(index, 1);
  const slots = [];
  for (let k = 0; k < MAX; k++) {
    const pos = new Float32Array(2 * M * 2 * 3), dat = new Float32Array(2 * M * 2 * 4);
    const geo = new THREE.BufferGeometry();
    const pa = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage), da = new THREE.BufferAttribute(dat, 4).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', pa); geo.setAttribute('aD', da); geo.setIndex(indexAttr);
    geo.setDrawRange(0, 12);   // degenerate (all zero) until used: visible during the engine's warm-up so the program compiles there
    const mat = new THREE.ShaderMaterial({
      uniforms: { uStyle: { value: 0 }, uColor: { value: new THREE.Color(1, 1, 1) }, uTime: { value: 0 } },
      vertexShader: VS, fragmentShader: FS, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false; mesh.renderOrder = 9; mesh.name = `trail-${k}`;
    group.add(mesh);
    slots.push({ f: null, style: -1, colorOf: '', mesh, geo, pa, da, pos, dat, hist: new Float32Array(N * 7), head: -1, count: 0, acc: 0, serial: 0 });
  }
  let time = 0;
  const tip = [0, 0, 0, 0, 0, 0];   // live L xyz, R xyz

  const slotOf = (f) => (f && f.id >= 0 && f.id < MAX ? slots[f.id] : null);

  function set(f, styleId) {
    const sl = slotOf(f);
    if (!sl) return;
    if (sl.f !== f) { sl.f = f; sl.count = 0; }
    sl.style = styleId === 'none' ? -1 : (STYLES[styleId] ?? 0);
    const m = sl.mesh.material;
    m.uniforms.uStyle.value = Math.max(0, sl.style);
    m.blending = sl.style > 0 ? THREE.AdditiveBlending : THREE.NormalBlending;
    sl.colorOf = '';
  }
  function clear(f) { const sl = slotOf(f); if (sl) { sl.count = 0; sl.head = -1; sl.acc = 0; } }

  /** The fighter's two wingtips in world space (interpolated pose) into tip[]. */
  function tips(f) {
    const p = f.pose.pos, q = f.pose.q, qx = q[0], qy = q[1], qz = q[2], qw = q[3];
    for (let side = 0; side < 2; side++) {
      const vx = side === 0 ? TIP[0] : -TIP[0], vy = TIP[1], vz = TIP[2];
      // v' = v + 2w (q x v) + 2 q x (q x v)
      const tx = 2 * (qy * vz - qz * vy), ty = 2 * (qz * vx - qx * vz), tz = 2 * (qx * vy - qy * vx);
      const o = side * 3;
      tip[o] = p[0] + vx + qw * tx + (qy * tz - qz * ty);
      tip[o + 1] = p[1] + vy + qw * ty + (qz * tx - qx * tz);
      tip[o + 2] = p[2] + vz + qw * tz + (qx * ty - qy * tx);
    }
  }

  /** Vapour / brightness strength from the g load (and a little speed). */
  function strength(f) {
    const g = f.s?.gLoad || 1, v = f.s?.speed || 0;
    const kg = Math.min(1, Math.max(0, (g - 2.5) / 4.5)), kv = Math.min(1, Math.max(0, (v - 120) / 200));
    return kg * (0.4 + 0.6 * kv);
  }

  function update(frameDt, fighters, camera) {
    void fighters;
    const dt = frameDt > 0 && frameDt < 0.5 ? frameDt : 0;
    time = (time + dt) % 3600;
    camera.updateMatrixWorld();
    const ce = camera.matrixWorld.elements, cx = ce[12], cy = ce[13], cz = ce[14];
    for (let k = 0; k < MAX; k++) {
      const sl = slots[k], f = sl.f, mesh = sl.mesh;
      if (!f || sl.style < 0 || !f.alive || !f.jet?.group?.visible) { mesh.visible = false; if (f && !f.alive) sl.count = 0; continue; }
      tips(f);
      const st = strength(f), H = sl.hist;
      // teleport guard: the newest sample far from the live tip = a respawn without clear()
      if (sl.count > 0) {
        const o = sl.head * 7, dx = H[o] - tip[0], dy = H[o + 1] - tip[1], dz = H[o + 2] - tip[2];
        if (dx * dx + dy * dy + dz * dz > TELEPORT2) sl.count = 0;
      }
      sl.acc += dt;
      if (sl.count === 0 || sl.acc >= SAMPLE) {
        sl.acc = sl.count === 0 ? 0 : Math.min(sl.acc - SAMPLE, SAMPLE);
        sl.head = (sl.head + 1) % N;
        const o = sl.head * 7;
        H[o] = tip[0]; H[o + 1] = tip[1]; H[o + 2] = tip[2]; H[o + 3] = tip[3]; H[o + 4] = tip[4]; H[o + 5] = tip[5]; H[o + 6] = st;
        if (sl.count < N) sl.count++;
        sl.serial = (sl.serial + 1) % SERIAL_WRAP;
      }
      if (sl.style === 1 && sl.colorOf !== f.color) { mesh.material.uniforms.uColor.value.set(f.color || '#ffffff'); sl.colorOf = f.color; }
      mesh.material.uniforms.uTime.value = time;
      const pts = sl.count + 1, Wd = WIDTH[sl.style] || WIDTH[0], pos = sl.pos, dat = sl.dat;
      const headSerial = sl.serial + sl.acc / SAMPLE;
      for (let r = 0; r < 2; r++) {
        const ro = r * 3;
        let px = 0, py = 0, pz = 0, sx = 0, sy = 1, sz = 0;   // last good side vector (fallback)
        for (let i = 0; i < pts; i++) {
          // this point, the one toward the head (i-1) and toward the tail (i+1)
          const hi = i === 0 ? -1 : (sl.head - (i - 1) + N) % N;
          const x = i === 0 ? tip[ro] : H[hi * 7 + ro], y = i === 0 ? tip[ro + 1] : H[hi * 7 + ro + 1], z = i === 0 ? tip[ro + 2] : H[hi * 7 + ro + 2];
          const kk = i === 0 ? st : H[hi * 7 + 6];
          let ax, ay, az;   // tangent: previous - next (clamped at the ends)
          if (i + 1 < pts) { const ni = (sl.head - i + N) % N; ax = (i === 0 ? x : px) - H[ni * 7 + ro]; ay = (i === 0 ? y : py) - H[ni * 7 + ro + 1]; az = (i === 0 ? z : pz) - H[ni * 7 + ro + 2]; }
          else { ax = px - x; ay = py - y; az = pz - z; }
          const vx = x - cx, vy = y - cy, vz = z - cz;
          let nx = ay * vz - az * vy, ny = az * vx - ax * vz, nz = ax * vy - ay * vx;
          const nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
          if (nl > 1e-6) { nx /= nl; ny /= nl; nz /= nl; sx = nx; sy = ny; sz = nz; } else { nx = sx; ny = sy; nz = sz; }
          const age = i === 0 ? 0 : (sl.acc + (i - 1) * SAMPLE) / LIFE;
          const dist = Math.sqrt(vx * vx + vy * vy + vz * vz);
          const near = dist < 8 ? 0 : dist < 14 ? (dist - 8) / 6 : 1;   // squeezed to nothing beside the camera: no full-screen overdraw
          const w = Math.max(Wd[0], dist * Wd[2]) * (1 + (Wd[1] - 1) * age) * (sl.style === 0 ? 0.7 + 0.6 * kk : 1) * near;
          const v0 = (r * M + i) * 2, o0 = v0 * 3, d0 = v0 * 4;
          pos[o0] = x - nx * w; pos[o0 + 1] = y - ny * w; pos[o0 + 2] = z - nz * w;
          pos[o0 + 3] = x + nx * w; pos[o0 + 4] = y + ny * w; pos[o0 + 5] = z + nz * w;
          const along = i === 0 ? headSerial : sl.serial - (i - 1);
          dat[d0] = age; dat[d0 + 1] = -1; dat[d0 + 2] = kk; dat[d0 + 3] = along;
          dat[d0 + 4] = age; dat[d0 + 5] = 1; dat[d0 + 6] = kk; dat[d0 + 7] = along;
          px = x; py = y; pz = z;
        }
      }
      sl.pa.needsUpdate = true; sl.da.needsUpdate = true;
      sl.geo.setDrawRange(0, (pts - 1) * 12);
      mesh.visible = pts > 1;
    }
  }

  return { set, clear, update, group };
}
