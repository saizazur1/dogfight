// powerups.js -- floating pick-ups and supply drops (lane CHAOS, README "Hooks contract"). Pure: no three.js, no DOM, runs in
// node (powerups.check.mjs). Deterministic from (seed, the fighters' paths): one mulberry32 stream, no wall clock, a fixed
// item pool (no allocation in step() except the event records, which are rare).
//
//   const pu = createPowerups({ terrainHeightAt, playArea, seed, onEvent, combat });
//   pu.start({ count, dropEvery, kinds?, radius? });   // radius: m round the play area's middle (default: its middle 60 %)   // count floating pick-ups kept in the sky; a supply drop every dropEvery s (0 = never)
//   pu.step(dt, fighters);                    // after combat.step: collect, respawn timers, falling drops, shield / boost countdown
//   pu.items                                  // fixed pool: [{ id, kind, pos[3], alive, drop, chute, age }]
//   pu.stop();
//
// Kinds: 'repair' (+50 % hp, cap 1), 'missiles' (missiles, flares, gun rounds back to combat.TUNE's loadout), 'boost'
// (fighter.s.boost = 6 s: flight.js thrust), 'shield' (fighter.shield = 6 s: combat.js takes no damage). A supply drop
// (kind 'drop') gives all four. A pick-up hangs 250-800 m over the local ground in the middle 60 % of the play area, at least
// ~1.5 km from the others; a collected one comes back elsewhere after `respawn` s. A drop starts dropStartAgl m over the
// ground, falls under its parachute (chute true) at dropFall m/s, can be grabbed in the air, lands (chute false), stays
// dropStay s, then goes. Collect = a live fighter's path this step (a segment, so a fast jet never skips through) passes
// within `radius` m. Events: pickup {owner, kind, pos} and dropIncoming {id, pos}.

import { mulberry32 } from './rng.js';

/** Every power-up number in one place (m, s, m/s, hp 0..1). */
export const PU = {
  radius: 45,                  // m: a fighter's path this close collects it
  respawn: 10,                 // s before a collected pick-up comes back (somewhere else)
  aglMin: 250, aglMax: 800,    // m over the local ground (the highest of a few samples round the spot)
  groundR: 300,                // m: the ground is sampled this far round a spot (no pick-up tucked against a cliff)
  ceilingGap: 150,             // m under the play area's ceiling at most
  spread: 0.6,                 // the middle fraction of the play area's side
  minGap: 1500,                // m between pick-ups (best effort: tries, then keeps the most spread spot)
  tries: 24,
  repair: 0.5, boost: 6, shield: 6,
  dropStartAgl: 900, dropFall: 30, dropStay: 20,   // a supply drop: start height, fall speed under the chute, time on the ground
  dropLand: 2.5,               // m: the crate's centre this far over the ground = landed
  maxItems: 16, maxDrops: 3,   // pools (a 900 m fall takes 30 s)
  teleport: 120,               // m: a fighter that moved more than this in one step was placed (respawn): no segment
};
export const KINDS = Object.freeze(['repair', 'missiles', 'boost', 'shield']);
const LOADOUT = { missiles: 4, flareBursts: 3, gunAmmo: 400 };   // combat.TUNE's, if no combat is given
const MAXF = 64;                                                  // fighter ids tracked for the last-position segment

/**
 * @param {{terrainHeightAt:(x:number,z:number)=>number, playArea:{cx:number,cz:number,half:number,ceiling?:number},
 *   seed?:number, onEvent?:(e:Object)=>void, combat?:{TUNE:Object, t?:number}}} o
 */
export function createPowerups({ terrainHeightAt, playArea, seed = 1, onEvent = null, combat = null }) {
  const th = terrainHeightAt || (() => 0), pa = playArea || { cx: 0, cz: 0, half: 15000 };
  const ceiling = pa.ceiling !== undefined ? pa.ceiling : 1e9;
  const items = [];
  for (let i = 0; i < PU.maxItems + PU.maxDrops; i++) {
    items.push({ id: 0, kind: 'repair', pos: [0, 0, 0], alive: false, drop: i >= PU.maxItems, chute: false, age: 0, _wait: 0, _landed: 0, _on: false });
  }
  const last = new Float64Array(MAXF * 3), lastSeen = new Int32Array(MAXF).fill(-10);   // each fighter's position at its last step
  let rng = mulberry32(seed), starts = 0, t = 0, nextId = 1, stepN = 0, count = 0, dropEvery = 0, dropT = 0, kinds = KINDS;

  const emit = (e) => { e.t = combat && combat.t !== undefined ? combat.t : t; if (onEvent) onEvent(e); };
  /** the highest ground round (x, z) */
  function groundAt(x, z) {
    const r = PU.groundR;
    return Math.max(th(x, z), th(x + r, z), th(x - r, z), th(x, z + r), th(x, z - r));
  }
  /** a random spot in the middle of the play area */
  let half = pa.half * PU.spread;   // start({ radius }) narrows it (Chaos: the fight's own arena)
  function spot(o) {
    o[0] = pa.cx + (rng() * 2 - 1) * half; o[2] = pa.cz + (rng() * 2 - 1) * half;
  }
  const P = [0, 0, 0], B = [0, 0, 0];
  /** places floating item `it` (not a drop): far from the other live ones (and its own old spot), 250-800 m over the ground */
  function place(it) {
    let bestD = -1, bestY = 0;
    for (let k = 0; k < PU.tries; k++) {
      spot(P);
      const g = groundAt(P[0], P[2]), top = ceiling - PU.ceilingGap;
      if (g + PU.aglMin > top) continue;   // a peak too close to the ceiling
      let d = it._on ? Math.hypot(P[0] - it.pos[0], P[2] - it.pos[2]) : 1e9;
      for (let j = 0; j < PU.maxItems; j++) {
        const o = items[j];
        if (o === it || !o.alive) continue;
        d = Math.min(d, Math.hypot(P[0] - o.pos[0], P[2] - o.pos[2]));
      }
      if (d > bestD) { bestD = d; B[0] = P[0]; B[2] = P[2]; bestY = Math.min(top, g + PU.aglMin + rng() * (PU.aglMax - PU.aglMin)); }
      if (d >= PU.minGap) break;
    }
    if (bestD < 0) { B[0] = pa.cx; B[2] = pa.cz; bestY = Math.min(ceiling - PU.ceilingGap, groundAt(pa.cx, pa.cz) + PU.aglMin); }   // nothing fitted
    it.pos[0] = B[0]; it.pos[1] = bestY; it.pos[2] = B[2];
    it.id = nextId++; it.alive = true; it.age = 0; it._wait = 0; it._on = true;
  }
  function spawnDrop() {
    let it = null;
    for (let i = PU.maxItems; i < items.length && !it; i++) if (!items[i].alive) it = items[i];
    if (!it) return;   // the pool is full: this one is skipped
    spot(P);
    const g = th(P[0], P[2]);
    it.pos[0] = P[0]; it.pos[1] = Math.max(g + 200, Math.min(ceiling - 50, groundAt(P[0], P[2]) + PU.dropStartAgl)); it.pos[2] = P[2];
    it.id = nextId++; it.kind = 'drop'; it.alive = true; it.chute = true; it.age = 0; it._landed = 0; it._on = true;
    emit({ type: 'dropIncoming', id: it.id, pos: [it.pos[0], it.pos[1], it.pos[2]] });
  }

  /** what a pick-up does to fighter f */
  function give(f, kind) {
    const T = (combat && combat.TUNE) || LOADOUT, all = kind === 'drop';
    if (all || kind === 'repair') f.hp = Math.min(1, (f.hp || 0) + PU.repair);
    if (all || kind === 'missiles') { f.missiles = T.missiles; f.flares = T.flareBursts; f.gunAmmo = T.gunAmmo; }
    if (all || kind === 'boost') f.s.boost = PU.boost;
    if (all || kind === 'shield') f.shield = PU.shield;
  }
  /** squared distance from point c to the segment a -> b */
  function seg2(a0, a1, a2, b0, b1, b2, c) {
    const dx = b0 - a0, dy = b1 - a1, dz = b2 - a2, dd = dx * dx + dy * dy + dz * dz;
    let u = dd > 1e-9 ? ((c[0] - a0) * dx + (c[1] - a1) * dy + (c[2] - a2) * dz) / dd : 0;
    u = u < 0 ? 0 : u > 1 ? 1 : u;
    const x = a0 + dx * u - c[0], y = a1 + dy * u - c[1], z = a2 + dz * u - c[2];
    return x * x + y * y + z * z;
  }

  function step(dt, fighters) {
    t += dt; stepN++;
    const n = fighters ? fighters.length : 0;
    // 1. shield / boost run out
    for (let i = 0; i < n; i++) {
      const f = fighters[i];
      if (f.shield > 0) f.shield = Math.max(0, f.shield - dt);
      if (f.s && f.s.boost > 0) f.s.boost = Math.max(0, f.s.boost - dt);
    }
    // 2. respawns, falling drops, the drop timer
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!it.alive) { if (!it.drop && it._wait > 0 && (it._wait -= dt) <= 0 && i < count) place(it); continue; }
      it.age += dt;
      if (it.drop) {
        if (it.chute) {
          it.pos[1] -= PU.dropFall * dt;
          const g = th(it.pos[0], it.pos[2]) + PU.dropLand;
          if (it.pos[1] <= g) { it.pos[1] = g; it.chute = false; }
        } else if ((it._landed += dt) >= PU.dropStay) it.alive = false;
      }
    }
    if (dropEvery > 0 && (dropT += dt) >= dropEvery) { dropT -= dropEvery; spawnDrop(); }
    // 3. collect: each live fighter's path this step against every live item (the first to touch it takes it)
    for (let i = 0; i < n; i++) {
      const f = fighters[i], id = f.id, p = f.s && f.s.pos;
      if (!p || id < 0 || id >= MAXF) continue;
      const o = id * 3, fresh = lastSeen[id] !== stepN - 1;
      let a0 = last[o], a1 = last[o + 1], a2 = last[o + 2];
      lastSeen[id] = stepN; last[o] = p[0]; last[o + 1] = p[1]; last[o + 2] = p[2];
      if (fresh || Math.abs(p[0] - a0) + Math.abs(p[1] - a1) + Math.abs(p[2] - a2) > PU.teleport) { a0 = p[0]; a1 = p[1]; a2 = p[2]; }
      if (!f.alive || f.s.crashed) continue;
      for (let k = 0; k < items.length; k++) {
        const it = items[k];
        if (!it.alive || seg2(a0, a1, a2, p[0], p[1], p[2], it.pos) > PU.radius * PU.radius) continue;
        it.alive = false;
        if (!it.drop) it._wait = PU.respawn;
        give(f, it.kind);
        emit({ type: 'pickup', owner: id, kind: it.kind, pos: [it.pos[0], it.pos[1], it.pos[2]] });
      }
    }
  }

  /** count floating pick-ups (kinds in turn), a supply drop every dropEvery s (0 = never). A new layout each start. */
  function start({ count: c = 6, dropEvery: de = 0, kinds: ks, radius = 0 } = {}) {
    stop();
    half = radius > 0 ? Math.min(radius, pa.half) : pa.half * PU.spread;
    rng = mulberry32((seed * 7919 + ++starts * 104729) >>> 0);
    kinds = ks && ks.length ? ks : KINDS;
    count = Math.max(0, Math.min(PU.maxItems, c | 0)); dropEvery = Math.max(0, +de || 0); dropT = 0;
    for (let i = 0; i < count; i++) { items[i].kind = kinds[i % kinds.length]; place(items[i]); }
  }
  function stop() {
    for (const it of items) { it.alive = false; it._wait = 0; it._on = false; it.chute = false; it.age = 0; }
    count = 0; dropEvery = 0; dropT = 0;
  }

  return { start, step, stop, items, get count() { return count; }, get dropEvery() { return dropEvery; } };
}
