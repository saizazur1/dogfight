// race.js -- the RING RACE mode (README "Modes contract"): no enemies, a course of glowing gold rings set low through the
// valleys and between the peaks. The timer starts at ring 1; the last ring finishes. Missing a ring costs nothing but the
// turn back (the next ring stays the same). The best time per course is kept in localStorage.
//
//   createRaceMode(game) -> mode       makeCourse(terrainHeightAt, playArea, start, seed) -> course (pure, runs in node)
//   passRing(a, b, ring) -> bool       the jet's step segment a->b crosses the ring's disc front-to-back (pure)
import * as THREE from 'three';
import { mulberry32 } from './rng.js';

const D2R = Math.PI / 180;

/** Every course-shaping number in one place (metres, degrees). */
export const COURSE = {
  rings: 16,
  hMin: 140, hMax: 260, hCap: 350,   // ring centre over the ground straight below it; raised (≤ hCap) to clear a saddle
  dMin: 1300, dMax: 2400,            // ring spacing along the straight segment
  turnMax: 55,                       // deg, horizontal heading change between legs (a 5-7 g turn at ~230 m/s makes it)
  slopeMax: 0.18,                    // |dy| / d of a leg
  clear: 70,                         // m the straight leg keeps over the terrain (and the start run)
  rimClear: 25,                      // m the ring's rim keeps over the terrain
  edge: 2500,                        // m inside the play area's edge
  apart: 1800,                       // m any ring keeps from every ring but its neighbours (no crossings, no loops)
  fanLen: 900, fanClear: 45,         // m: the turn's fan (see place()) is checked this far out from the ring, for this clearance
  tries: 64,                         // seeded search attempts before giving up
  startRun: 1400,                    // m from the start point to ring 1 (level, lined up)
  radius: 50, big: 62, tight: 38,    // ring radii: 3 big ones on the hardest turns, 2 tight ones on the straightest legs
};
/**
 * The Valley Run: makeCourse(real DEM, jetworld's PLAY, jetworld's SPAWN, seed 2), baked here so the game flies exactly the
 * course race.check.mjs checked (the in-browser ground carries fine detail noise the node DEM lacks, and the search would
 * wander off on it). createRaceMode re-checks it against the live ground and regenerates from the seed if it doesn't fit.
 * Re-bake after changing COURSE, the DEM or the spawn: race.check.mjs fails when the bake is stale.
 */
export const VALLEY_RUN = {
  name: 'Valley Run', seed: 2,
  start: { pos: [4250,689,4500], heading: -1.7981, speed: 230 },
rings: [
    { pos: [2886, 689, 4815.4], normal: [-0.9712, -0.0824, 0.2236], radius: 50 },
    { pos: [546.6, 289.2, 5351.4], normal: [-0.9471, -0.1664, 0.2743], radius: 38 },
    { pos: [-887.1, 30.3, 5856.4], normal: [-0.9816, -0.1595, 0.1049], radius: 50 },
    { pos: [-2177, -157.2, 5694.7], normal: [-0.8679, -0.058, -0.4934], radius: 50 },
    { pos: [-3251.5, -94.7, 4326.1], normal: [-0.1873, 0.0904, -0.9781], radius: 62 },
    { pos: [-2878.5, 68.5, 3080.8], normal: [0.4016, 0.0253, -0.9155], radius: 50 },
    { pos: [-2103.3, -45.2, 1773.3], normal: [0.7181, -0.0007, -0.6959], radius: 50 },
    { pos: [-964.9, 50.3, 1145.7], normal: [0.9266, 0.0365, -0.3743], radius: 38 },
    { pos: [290, 49.2, 806.1], normal: [0.9957, 0.0314, -0.0866], radius: 50 },
    { pos: [1584.6, 130.6, 924.4], normal: [0.966, 0.0843, -0.2444], radius: 50 },
    { pos: [2666.5, 256.7, 203.6], normal: [0.7229, 0.1178, -0.6808], radius: 50 },
    { pos: [3450, 435, -833.8], normal: [0.4505, 0.1463, -0.8807], radius: 50 },
    { pos: [3832.1, 635.4, -2076.4], normal: [-0.1445, 0.1812, -0.9728], radius: 62 },
    { pos: [3103.3, 866.9, -3152.9], normal: [-0.8598, 0.0854, -0.5035], radius: 62 },
    { pos: [1151.5, 824.5, -3331.4], normal: [-0.9512, -0.0047, 0.3086], radius: 50 },
    { pos: [172.9, 841.5, -2475.6], normal: [-0.7527, 0.013, 0.6582], radius: 50 },
  ],
  length: 23685,
};

// ---------------------------------------------------------------- course generation (pure)
const clearance = (th, a, b) => {   // the least height of the straight a->b over the ground, sampled every ~40 m
  const d = Math.hypot(b[0] - a[0], b[2] - a[2]), n = Math.max(2, Math.ceil(d / 40));
  let m = 1e9;
  for (let i = 0; i <= n; i++) { const u = i / n; m = Math.min(m, a[1] + (b[1] - a[1]) * u - th(a[0] + (b[0] - a[0]) * u, a[2] + (b[2] - a[2]) * u)); }
  return m;
};
const unit = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const rimClear = (th, p, n, r) => {   // the least height of the ring's rim (16 points) over the ground
  const h = unit([n[2], 0, -n[0]]), v = unit([n[1] * h[2] - n[2] * h[1], n[2] * h[0] - n[0] * h[2], n[0] * h[1] - n[1] * h[0]]);
  let m = 1e9;
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2, c = Math.cos(a) * r, s = Math.sin(a) * r, x = p[0] + h[0] * c + v[0] * s, z = p[2] + h[2] * c + v[2] * s;
    m = Math.min(m, p[1] + h[1] * c + v[1] * s - th(x, z));
  }
  return m;
};

/**
 * A ring course that follows the valley floors: a depth-first search (with backtracking) over headings within ±turnMax of
 * the last leg and spacings dMin..dMax, scoring low ground, deep valleys (high ground either side) and a little seeded
 * noise; every leg is a straight line clear of the terrain, every ring inside the play area and apart from the others.
 * @param {(x:number,z:number)=>number} th  terrainHeightAt
 * @param {{cx:number,cz:number,half:number}} area  the play area
 * @param {{pos:number[], heading:number}} start  where the course begins (x, z used; y is set level with ring 1)
 * @param {number} seed
 * @returns {{seed:number, rings:{pos:number[],normal:number[],radius:number}[], start:{pos:number[],heading:number,speed:number}, length:number}|null}
 */
export function makeCourse(th, area, start, seed = VALLEY_RUN.seed) {
  const C = COURSE, sx = start.pos[0], sz = start.pos[2];
  const toEdge = (x, z) => area.half - Math.max(Math.abs(x - area.cx), Math.abs(z - area.cz));
  const pts = [];        // ring centres so far
  let R, budget;         // the attempt's random stream; candidate legs it may still try
  const g0 = th(sx, sz), startPt = [sx, g0 + 200, sz];

  // candidate next rings from p (leg heading hd), best first
  function candidates(p, hd, first) {
    const out = [];
    for (let k = -Math.floor(C.turnMax / 5); k <= Math.floor(C.turnMax / 5); k++) {
      const dh = (k * 5 + (R() - 0.5) * 4) * D2R, h = hd + dh, fx = Math.sin(h), fz = -Math.cos(h);
      for (let d = first ? C.startRun : C.dMin; d <= (first ? C.startRun : C.dMax); d += 220) {
        const x = p[0] + fx * d, z = p[2] + fz * d;
        if (toEdge(x, z) < C.edge || pts.some((q, i) => i < pts.length - 1 && Math.hypot(q[0] - x, q[2] - z) < C.apart)) continue;
        const g = th(x, z), side = (th(x + fz * 900, z - fx * 900) + th(x - fz * 900, z + fx * 900)) / 2;
        out.push({ x, z, g, h, d, score: g - 0.35 * Math.max(0, side - g) + Math.abs(k) * 6 + R() * 160 + 0.3 * Math.max(0, 6000 - toEdge(x, z)) });
      }
    }
    return out.sort((a, b) => a.score - b.score);
  }
  // place a candidate's ring height: the seeded height, raised to clear the leg from p; null if it can't be done
  function place(p, c, first, hdIn) {
    for (let H = C.hMin + R() * (C.hMax - C.hMin); H <= C.hCap; H += 40) {
      const q = [c.x, c.g + H, c.z];
      const a = first ? [p[0], q[1], p[2]] : p;   // the start run is level with ring 1
      if (Math.abs(q[1] - a[1]) > C.slopeMax * c.d) { if (q[1] > a[1]) return null; continue; }
      if (clearance(th, a, q) < C.clear) continue;
      // the turn at p: the jet arrives along the old heading and swings round to the new one, so the fan between them
      // (fanLen out, on the new leg's slope) must be clear too, or the outside of the turn meets a valley wall
      let fan = true;
      for (let f = 0; f <= 4 && fan && !first; f++) {
        const h = hdIn + (c.h - hdIn) * f / 4, e = [p[0] + Math.sin(h) * C.fanLen, p[1] + (q[1] - p[1]) * C.fanLen / c.d, p[2] - Math.cos(h) * C.fanLen];
        fan = clearance(th, p, e) >= C.fanClear;
      }
      if (fan) return { q, a };
    }
    return null;
  }
  function dfs(p, hd, depth) {
    if (depth === C.rings) return true;
    for (const c of candidates(p, hd, depth === 0).slice(0, 3)) {
      if (--budget < 0) return false;
      const pl = place(p, c, depth === 0, hd);
      if (!pl) continue;
      if (depth === 0) { p[1] = pl.q[1]; if (th(p[0], p[2]) > p[1] - C.clear) continue; }
      pts.push(pl.q);
      if (dfs(pl.q, c.h, depth + 1)) return true;
      pts.pop();
    }
    return false;
  }
  // a few seeded attempts, each a short depth-first search (top 3 per ring, ~2,000 legs): dead ends deep in a gorge are
  // cheaper to leave by starting over than by exhausting the tree under them
  let found = false;
  for (let k = 0; k < C.tries && !found; k++) { R = mulberry32(seed * 101 + k); budget = 2000; pts.length = 0; found = dfs(startPt, start.heading, 0); }
  if (!found) return null;

  // normals: the bisector of the legs in and out; radii by turn angle
  const legs = pts.map((q, i) => unit([q[0] - (i ? pts[i - 1] : startPt)[0], q[1] - (i ? pts[i - 1] : startPt)[1], q[2] - (i ? pts[i - 1] : startPt)[2]]));
  const rings = pts.map((q, i) => ({ pos: q, normal: i < pts.length - 1 ? unit(legs[i].map((v, j) => v + legs[i + 1][j])) : legs[i], radius: C.radius }));
  const turn = rings.map((r, i) => (i < pts.length - 1 ? Math.acos(Math.min(1, legs[i][0] * legs[i + 1][0] + legs[i][1] * legs[i + 1][1] + legs[i][2] * legs[i + 1][2])) : 0));
  const byTurn = rings.map((r, i) => i).filter((i) => i > 0 && i < rings.length - 1).sort((a, b) => turn[b] - turn[a]);
  for (const i of byTurn.slice(0, 3)) rings[i].radius = C.big;
  for (const i of byTurn.slice(-2)) if (rimClear(th, rings[i].pos, rings[i].normal, C.tight) > C.rimClear) rings[i].radius = C.tight;
  for (const r of rings) while (r.radius > C.tight && rimClear(th, r.pos, r.normal, r.radius) < C.rimClear) r.radius -= 4;
  let length = 0;
  for (let i = 0; i < pts.length; i++) { const a = i ? pts[i - 1] : startPt; length += Math.hypot(pts[i][0] - a[0], pts[i][1] - a[1], pts[i][2] - a[2]); }
  return { seed, rings, start: { pos: startPt, heading: Math.atan2(legs[0][0], -legs[0][2]), speed: 230 }, length };
}

/**
 * Did the step a -> b fly through the ring? It must cross the ring's plane going along its normal, inside its radius.
 * @param {number[]} a @param {number[]} b @param {{pos:number[],normal:number[],radius:number}} ring
 */
export function passRing(a, b, ring) {
  const p = ring.pos, n = ring.normal;
  const da = (a[0] - p[0]) * n[0] + (a[1] - p[1]) * n[1] + (a[2] - p[2]) * n[2];
  const db = (b[0] - p[0]) * n[0] + (b[1] - p[1]) * n[1] + (b[2] - p[2]) * n[2];
  if (!(da < 0 && db >= 0)) return false;
  const u = da / (da - db), x = a[0] + (b[0] - a[0]) * u - p[0], y = a[1] + (b[1] - a[1]) * u - p[1], z = a[2] + (b[2] - a[2]) * u - p[2];
  return x * x + y * y + z * z <= ring.radius * ring.radius;
}

/**
 * Does this course fit this ground? Every ring >= minAgl over it, every leg (start run included) >= minClear over it.
 * @returns {{ok:boolean, ringAgl:number, legClear:number}}
 */
export function courseFits(th, course, minAgl = 80, minClear = 30) {
  let ringAgl = 1e9, legClear = 1e9;
  course.rings.forEach((r, i) => {
    ringAgl = Math.min(ringAgl, r.pos[1] - th(r.pos[0], r.pos[2]));
    legClear = Math.min(legClear, clearance(th, i ? course.rings[i - 1].pos : course.start.pos, r.pos));
  });
  return { ok: ringAgl >= minAgl && legClear >= minClear, ringAgl, legClear };
}

/**
 * The autopilot's (and race.check's) aim: pure pursuit of a carrot `ahead` m along the current leg (the cleared straight line
 * from the last ring to the next), stopping at the ring itself so the turn starts only once through it. Allocation-free.
 * @param {object} course @param {number} next  the next ring's index @param {number[]} pos @param {number[]} out  unit aim
 */
export function carrotAim(course, next, pos, out, ahead = 600) {
  const A = next ? course.rings[next - 1].pos : course.start.pos, B = course.rings[next].pos;
  const bx = B[0] - A[0], by = B[1] - A[1], bz = B[2] - A[2], L = Math.hypot(bx, by, bz) || 1;
  const u = Math.min(((pos[0] - A[0]) * bx + (pos[1] - A[1]) * by + (pos[2] - A[2]) * bz) / L + ahead, L) / L;
  const x = A[0] + bx * u - pos[0], y = A[1] + by * u - pos[1], z = A[2] + bz * u - pos[2], l = Math.hypot(x, y, z) || 1;
  out[0] = x / l; out[1] = y / l; out[2] = z / l;
  return out;
}

/** m:ss.s */
export const fmtTime = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;

// ---------------------------------------------------------------- the mode
/** @param {object} game  README "Modes contract" */
export function createRaceMode(game) {
  const SPEC = VALLEY_RUN, KEY = `dogfight.raceBest.${SPEC.seed}`;
  let course = null, group = null, meshes = [];
  let next = 0, t0 = -1, done = false, lastBanner = -2;
  const prevPos = [0, 0, 0], apAim = [0, 0, -1];
  // ?autopilot=1 flies the course (carrotAim); ?ring=N starts lined up on the leg into ring N (practice: no best time saved)
  const AP = game.params?.get?.('autopilot') === '1', RING0 = Math.max(1, +(game.params?.get?.('ring') || 1)) - 1;
  let practice = false;
  // three looks, shared by the ring meshes: the next ring (pulsing), the one after, the one after that
  const GOLD = [1.0, 0.62, 0.2];
  const mats = [1.25, 0.6, 0.3].map((k) => new THREE.MeshBasicMaterial({ color: new THREE.Color(GOLD[0] * k, GOLD[1] * k, GOLD[2] * k), transparent: k < 1, opacity: k < 1 ? 0.85 : 1, depthWrite: k >= 1 }));
  const _z = new THREE.Vector3(0, 0, 1), _n = new THREE.Vector3();

  const loadBest = () => { try { const v = +localStorage.getItem(KEY); return v > 0 ? v : 0; } catch { return 0; } };
  const saveBest = (t) => { try { localStorage.setItem(KEY, t.toFixed(1)); } catch {} };

  function build() {
    const th = game.world.terrainHeightAt, fit = courseFits(th, SPEC);
    course = fit.ok ? SPEC : makeCourse(th, game.env?.playArea ?? game.world.playArea, game.world.spawn ?? { pos: [0, 0, 0], heading: 0 }, SPEC.seed);
    console.log(`[race] ${fit.ok ? 'baked' : 'generated'} course: ring AGL >= ${Math.round(fit.ringAgl)} m, legs clear >= ${Math.round(fit.legClear)} m`);
    if (!course) { console.warn('[race] no course found for seed', SPEC.seed); return; }
    group = new THREE.Group(); group.name = 'race';
    meshes = course.rings.map((r) => {
      const m = new THREE.Mesh(new THREE.TorusGeometry(r.radius, r.radius < COURSE.radius ? 3.2 : 4, 12, 64), mats[0]);
      m.position.fromArray(r.pos);
      m.quaternion.setFromUnitVectors(_z, _n.fromArray(r.normal));
      m.visible = false; group.add(m);
      return m;
    });
  }

  function showRings() {
    meshes.forEach((m, i) => { const k = i - next; m.visible = k >= 0 && k < 3; if (m.visible) m.material = mats[k]; });
  }

  const mode = {
    id: 'race', title: 'Ring race',
    weapons: false,   // for game.js: please don't feed ctl.gun / missile / flare to combat in this mode
    course: null,
    start() {
      if (!course) build();
      if (!course) { game.finish({ title: 'NO COURSE', sub: 'This map has no room for the Valley Run', won: false }); return; }
      mode.course = course;
      if (!group.parent) game.scene.add(group);
      next = Math.min(RING0, course.rings.length - 1); practice = next > 0; t0 = practice ? game.t : -1; done = false; lastBanner = -2;
      const sp = practice ? { pos: course.rings[next - 1].pos, heading: 0, speed: 230 } : course.start;
      if (practice) { const a = sp.pos, b = course.rings[next].pos; sp.heading = Math.atan2(b[0] - a[0], -(b[2] - a[2])); }
      game.respawnMe(sp);
      game.controls?.reset?.(sp.heading, 0);
      for (let j = 0; j < 3; j++) prevPos[j] = game.me.s.pos[j];
      showRings();
    },
    step() {
      if (!course || done) return;
      const me = game.me, s = me.s, c = me.ctl;
      c.gun = false; c.missile = false; c.flare = false;
      if (AP && !s.crashed) {
        carrotAim(course, next, s.pos, apAim);
        game.controls.reset(Math.atan2(apAim[0], -apAim[2]), Math.asin(apAim[1]));
        c.throttle = 0.88;
      }
      if (s.crashed) {
        done = true;
        game.setBanner(null);
        game.finish({ title: 'RACE OVER', sub: `Crashed before ring ${next + 1}/${course.rings.length}`, won: false });   // the HUD already says CRASHED
        return;
      }
      if (passRing(prevPos, s.pos, course.rings[next])) {
        if (next === 0) t0 = game.t;
        game.sound?.oneShot?.('pop');
        next++;
        if (next === course.rings.length) {
          done = true;
          const t = game.t - t0, best = loadBest(), rec = !practice && (!best || t < best);
          if (rec) saveBest(t);
          game.setBanner(null);
          game.finish({ title: fmtTime(t), sub: practice ? `Practice from ring ${RING0 + 1}` : rec ? `Best ${fmtTime(t)} — New record!` : `Best ${fmtTime(best)}`, won: true });
        }
        showRings();
      }
      for (let j = 0; j < 3; j++) prevPos[j] = s.pos[j];
    },
    frame() {
      if (!course || done) return;
      const key = next * 1e6 + (t0 < 0 ? -1 : Math.floor((game.t - t0) * 10));   // a new string only when the text changes (10 Hz)
      if (key !== lastBanner) { lastBanner = key; game.setBanner(`RING ${next + 1}/${course.rings.length} · ${t0 < 0 ? 'fly through to start' : fmtTime(game.t - t0)}`); }
      const k = 1.0 + 0.35 * Math.sin(game.t * 6);   // the next ring pulses (stays well under the bloom threshold)
      mats[0].color.setRGB(GOLD[0] * k * 1.25, GOLD[1] * k * 1.25, GOLD[2] * k * 1.25);
    },
    onEvent() {},
    stop() {
      if (group?.parent) group.parent.remove(group);
      game.setBanner(null);
      done = true;
    },
  };
  return mode;
}
