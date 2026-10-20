// combat.js -- weapons, damage and kills (lane COMBAT, README "Phase 3 contract"). Pure: no three.js, no DOM, runs in node
// (combat.check.mjs). Deterministic from (seed, inputs): one mulberry32 stream, no wall clock, fixed pools (no allocation
// in step() except the event records themselves, which are rare: <= 10 Hz gunFired while the trigger is held).
//
//   const combat = createCombat({ terrainHeightAt, seed, onEvent });
//   combat.add(fighter); combat.reset(fighter); combat.step(dt);   // step AFTER every fighter's stepJet for this step
//   combat.missiles / bullets / flares   fixed pools: check .alive
//
// Seeker: the nose cone (lockConeDeg, lockMin..lockMax, terrain line of sight) held lockTime -> locked; kept inside
// lockKeepDeg / lockKeepMax. Missile = proportional navigation N=4 with gravity compensation and a g cap (the maths of
// ~/SalesLeagueBoxingProto/web/js/jetplan.js flyMissile, per step), a motor, drag and turn drag. Fired with no lock it is a
// "maddog": it flies straight and takes the first enemy that crosses its narrow seeker cone. Flares: each one rolls, as it
// ignites, against every missile chasing its owner (aspect and timing decide the odds, jetplan's seeker slide to the flare).
// Gun: rounds with gravity, a segment-vs-sphere test against every other live fighter.

import { mulberry32 } from './rng.js';
import { ANCHORS, FLARE, G, qRot } from './jetspec.js';

const D2R = Math.PI / 180;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

/** Every weapon number in one place (m, s, m/s, m/s^2, g, deg, hp 0..1). */
export const TUNE = {
  // --- loadout (reset)
  missiles: 4, flareBursts: 3, gunAmmo: 400,
  // --- seeker / lock
  lockConeDeg: 20, lockKeepDeg: 30, lockMin: 300, lockMax: 4000, lockKeepMax: 5000, lockTime: 1.3,
  losSamples: 8, losMargin: 5,          // terrain samples along the line of sight; m over the ground it must clear
  // --- missile
  mIgnite: 0.1, mBurn: 3.0, mBoost: 240, mDrag: 1.2e-4, mTurnDrag: 0.12, mVMax: 820,
  mN: 4, mGMax: 22, mGRefV: 820, mGFloor: 0.85,   // PN gain; lateral g cap at >= mGRefV m/s, falling with v^2 below (not under mGFloor of it) (a jet at corner speed pulls ~11 g effective, flight.js turnBoost)
  mLag: 0.25, mGimbalDeg: 45,         // s: the airframe's response (lateral accel follows the command); the seeker's field of view
  mBlindR: 150,                        // m: inside this the seeker stops steering (and its field of view no longer matters)
  mFuse: 10, mArm: 0.4, mLife: 12, mDamage: 0.7, mDrop: 4,   // m, s, s, hp, m/s ejected down off the rail
  mBoreDeg: 8, mBoreRange: 3000,        // a maddog's seeker cone and range
  // --- flares (eject / tau / ignite / burn / fade from jetspec FLARE so the effects agree)
  flSalvo: FLARE.salvo, flGap: FLARE.gap, flEject: FLARE.eject, flTau: FLARE.tau, flIgnite: FLARE.ignite, flBurn: FLARE.burn, flFade: FLARE.fade,
  dcRange: 3000,                        // m: only missiles this close to the jet can be decoyed
  dcLate: 0.4,                          // s: closer than this to impact, nothing decoys it
  dcRear: 0.85, dcFront: 0.55,          // burst odds from dead astern / head on (rear aspect is easier)
  dcEarly: 3, dcEarlyZero: 5.5, dcEarlyMin: 0.1,   // released earlier than dcEarly s before impact: odds fade to dcEarlyMin at dcEarlyZero
  dcSlide: 0.3, dcFizzle: 30,           // s the seeker slides onto the flare; m from the flare it fizzles
  // --- gun
  gunRate: 20, gunV: 1000, gunLife: 1.5, gunSpreadDeg: 0.25, gunR: 7, gunDamage: 0.04, gunEvtGap: 0.1,
  muzzle: [0.55, 0.45, 5.0],            // jet space (+z fwd, +x left): the left side of the nose
  // --- kills
  creditTime: 10,                       // s: a crash is credited to whoever hurt or locked the victim this recently
  // --- pools
  maxMissiles: 32, maxBullets: 256, maxFlares: 192,
};

/** The rail each missile leaves from, in firing order (ANCHORS.missileRails: 0 tipL, 1 pylL, 2 pylR, 3 tipR). */
export const RAIL_ORDER = Object.freeze([0, 3, 1, 2]);

// scratch (module level: step() never allocates)
const NOCTL = Object.freeze({}), FWD = [0, 0, 1], RT = [-1, 0, 0], UPB = [0, 1, 0], S0 = [0, 0, 0], S1 = [0, 0, 0], S2 = [0, 0, 0], S3 = [0, 0, 0];
const AP = [0, 0, 0], AV = [0, 0, 0], LAT = [0, 0, 0], OM = [0, 0, 0];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b, o) => { const x = a[1] * b[2] - a[2] * b[1], y = a[2] * b[0] - a[0] * b[2], z = a[0] * b[1] - a[1] * b[0]; o[0] = x; o[1] = y; o[2] = z; return o; };
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/**
 * Closest approach, during one step, of a projectile moving p0 -> p1 to a fighter moving (c - cv*dt) -> c.
 * @returns {number} the fraction u (0..1) of the step at closest approach; the squared distance is left in SEG.d2
 */
const SEG = { d2: 0 };
function segHit(p0, p1, c, cv, dt) {
  const r0x = p0[0] - (c[0] - cv[0] * dt), r0y = p0[1] - (c[1] - cv[1] * dt), r0z = p0[2] - (c[2] - cv[2] * dt);
  const dx = p1[0] - c[0] - r0x, dy = p1[1] - c[1] - r0y, dz = p1[2] - c[2] - r0z, dd = dx * dx + dy * dy + dz * dz;
  const u = dd > 1e-12 ? clamp(-(r0x * dx + r0y * dy + r0z * dz) / dd, 0, 1) : 0;
  const x = r0x + dx * u, y = r0y + dy * u, z = r0z + dz * u;
  SEG.d2 = x * x + y * y + z * z;
  return u;
}

/**
 * @typedef {Object} Fighter  README "Phase 3 contract". combat.js writes hp, alive, missiles, flares, gunAmmo, lock, warn
 *   and keeps its private bookkeeping in fighter._c.
 */

/**
 * Create the combat simulation for one match.
 * @param {{terrainHeightAt:(x:number,z:number)=>number, seed?:number, onEvent?:(e:Object)=>void}} o
 */
export function createCombat({ terrainHeightAt, seed = 1, onEvent = null }) {
  const T = TUNE, rng = mulberry32(seed), th = terrainHeightAt || (() => -1e9);
  const fighters = [], byId = [];
  let t = 0, nextMissileId = 1, bulletNext = 0, flareNext = 0;
  const missiles = [], bullets = [], flares = [];
  for (let i = 0; i < T.maxMissiles; i++) missiles.push({ id: 0, owner: -1, target: -1, pos: [0, 0, 0], vel: [0, 0, 0], age: 0, motor: 0, alive: false, decoy: -1, rail: 0, _decoyT: 0, _blind: false, _lat: [0, 0, 0] });
  for (let i = 0; i < T.maxBullets; i++) bullets.push({ owner: -1, pos: [0, 0, 0], vel: [0, 0, 0], age: 0, alive: false });
  for (let i = 0; i < T.maxFlares; i++) flares.push({ owner: -1, pos: [0, 0, 0], vel: [0, 0, 0], age: 0, burn: 0, alive: false, _lit: false });

  const emit = (e) => { e.t = t; if (onEvent) onEvent(e); };
  const live = (id) => { const f = id >= 0 ? byId[id] : null; return f && f.alive ? f : null; };

  /** the terrain does not cut the straight line a -> b */
  function losClear(a, b) {
    const n = T.losSamples;
    for (let k = 1; k <= n; k++) {
      const u = k / (n + 1), x = a[0] + (b[0] - a[0]) * u, y = a[1] + (b[1] - a[1]) * u, z = a[2] + (b[2] - a[2]) * u;
      if (y < th(x, z) + T.losMargin) return false;
    }
    return true;
  }
  /** cos of the angle between f's nose and the line to g; range in RNG */
  let RNG = 0;
  function noseCos(f, g) {
    qRot(f.s.q, FWD, S0);
    const dx = g.s.pos[0] - f.s.pos[0], dy = g.s.pos[1] - f.s.pos[1], dz = g.s.pos[2] - f.s.pos[2];
    RNG = Math.hypot(dx, dy, dz) || 1e-9;
    return (S0[0] * dx + S0[1] * dy + S0[2] * dz) / RNG;
  }
  function blame(victim, killerId) { if (killerId >= 0 && killerId !== victim.id) { victim._c.aggId = killerId; victim._c.aggT = t; } }

  function kill(f, killer, cause) {
    if (!f.alive) return;
    f.alive = false; f.hp = 0;
    for (let i = 0; i < fighters.length; i++) {   // its own seeker, and every seeker on it, go quiet
      const L = fighters[i].lock;
      if (fighters[i] !== f && L.target !== f.id) continue;
      if (L.locked) emit({ type: 'lockLost', owner: fighters[i].id });
      L.target = -1; L.locked = false; L.progress = 0;
    }
    emit({ type: 'kill', killer, victim: f.id, cause });
  }
  function damage(f, amount, killer, cause) {
    if (!f.alive) return;
    blame(f, killer);
    f.hp = Math.max(0, f.hp - amount);
    if (f.hp <= 1e-9) kill(f, killer, cause);
  }

  // ------------------------------------------------------------------------------------------- per fighter: seeker
  function updateLock(f, dt) {
    const L = f.lock;
    if (L.target >= 0) {
      const g = live(L.target);
      let keep = false;
      if (g) {
        const c = noseCos(f, g);
        keep = L.locked ? c >= Math.cos(T.lockKeepDeg * D2R) && RNG <= T.lockKeepMax
          : c >= Math.cos(T.lockConeDeg * D2R) && RNG >= T.lockMin && RNG <= T.lockMax;
        keep = keep && losClear(f.s.pos, g.s.pos);
      }
      if (keep) {
        if (L.locked) blame(g, f.id);
        else if ((L.progress += dt / T.lockTime) >= 1) { L.progress = 1; L.locked = true; blame(g, f.id); emit({ type: 'lockOn', owner: f.id, target: g.id }); }
      } else {
        if (L.locked) emit({ type: 'lockLost', owner: f.id });
        L.target = -1; L.locked = false; L.progress = 0;
      }
    }
    if (L.target < 0) {   // the best candidate in the cone (smallest angle) starts the growl
      let best = -1, bestC = Math.cos(T.lockConeDeg * D2R);
      for (let i = 0; i < fighters.length; i++) {
        const g = fighters[i];
        if (g === f || !g.alive) continue;
        const c = noseCos(f, g);
        if (c >= bestC && RNG >= T.lockMin && RNG <= T.lockMax && losClear(f.s.pos, g.s.pos)) { best = g.id; bestC = c; }
      }
      if (best >= 0) { L.target = best; L.progress = dt / T.lockTime; }
    }
  }

  // ------------------------------------------------------------------------------------------- spawning
  function fireMissile(f) {
    let m = null;
    for (let i = 0; i < missiles.length && !m; i++) if (!missiles[i].alive) m = missiles[i];
    if (!m) return;
    const s = f.s, rail = RAIL_ORDER[(T.missiles - f.missiles) % 4];
    f.missiles--;
    // it leaves the rail along the NOSE (arcade: at the jet's speed; a hard-turning jet's nose is up to ~25 deg off its path)
    qRot(s.q, ANCHORS.missileRails[rail], S0); qRot(s.q, UPB, S1); qRot(s.q, FWD, S2);
    const sp = Math.hypot(s.vel[0], s.vel[1], s.vel[2]);
    for (let j = 0; j < 3; j++) { m.pos[j] = s.pos[j] + S0[j]; m.vel[j] = S2[j] * sp - S1[j] * T.mDrop; }
    m.id = nextMissileId++; m.owner = f.id; m.target = f.lock.locked ? f.lock.target : -1; m.rail = rail;
    m.age = 0; m.motor = 0; m.alive = true; m.decoy = -1; m._decoyT = 0; m._blind = false; m._lat[0] = m._lat[1] = m._lat[2] = 0;
    emit({ type: 'missileFired', owner: f.id, missile: m.id, target: m.target, rail });
  }
  function dropFlare(f) {
    const fl = flares[flareNext]; flareNext = (flareNext + 1) % flares.length;   // ring: the oldest goes first
    const c = f._c, d = ANCHORS.flareDispensers[c.flSide], s = f.s;
    c.flSide ^= 1;
    qRot(s.q, d.p, S0); qRot(s.q, d.dir, S1);
    for (let j = 0; j < 3; j++) { fl.pos[j] = s.pos[j] + S0[j]; fl.vel[j] = s.vel[j] + S1[j] * T.flEject; }
    fl.owner = f.id; fl.age = 0; fl.burn = 0; fl.alive = true; fl._lit = false;
    emit({ type: 'flare', owner: f.id, pos: [fl.pos[0], fl.pos[1], fl.pos[2]] });
  }
  function fireRound(f) {
    const b = bullets[bulletNext]; bulletNext = (bulletNext + 1) % bullets.length;
    const s = f.s, sp = T.gunSpreadDeg * D2R;
    qRot(s.q, FWD, S0); qRot(s.q, RT, S1); qRot(s.q, UPB, S2); qRot(s.q, T.muzzle, S3);
    const a = (rng() * 2 - 1) * sp, e = (rng() * 2 - 1) * sp;
    let l = 0;
    for (let j = 0; j < 3; j++) { S0[j] += S1[j] * a + S2[j] * e; l += S0[j] * S0[j]; }
    l = Math.sqrt(l);
    for (let j = 0; j < 3; j++) { b.pos[j] = s.pos[j] + S3[j]; b.vel[j] = s.vel[j] + S0[j] / l * T.gunV; }
    b.owner = f.id; b.age = 0; b.alive = true;
    f.gunAmmo--;
  }

  // ------------------------------------------------------------------------------------------- the decoy roll (a flare igniting)
  function flareRoll(fl, idx) {
    const owner = byId[fl.owner];
    if (!owner) return;
    const tp = owner.s.pos, tv = owner.s.vel, tvl = Math.hypot(tv[0], tv[1], tv[2]) || 1;
    for (let i = 0; i < missiles.length; i++) {
      const m = missiles[i];
      if (!m.alive || m.target !== fl.owner || m.decoy >= 0) continue;
      const rx = tp[0] - m.pos[0], ry = tp[1] - m.pos[1], rz = tp[2] - m.pos[2], R = Math.hypot(rx, ry, rz) || 1e-9;
      if (R > T.dcRange) continue;
      const closure = ((m.vel[0] - tv[0]) * rx + (m.vel[1] - tv[1]) * ry + (m.vel[2] - tv[2]) * rz) / R;
      const tti = closure > 1 ? R / closure : 1e9;
      if (tti < T.dcLate) continue;
      const mv = Math.hypot(m.vel[0], m.vel[1], m.vel[2]) || 1;
      const cosAsp = (m.vel[0] * tv[0] + m.vel[1] * tv[1] + m.vel[2] * tv[2]) / (mv * tvl);   // 1 = from dead astern
      const timing = tti <= T.dcEarly ? 1 : Math.max(T.dcEarlyMin, 1 - (tti - T.dcEarly) / (T.dcEarlyZero - T.dcEarly));
      const pBurst = (T.dcFront + (T.dcRear - T.dcFront) * (1 + cosAsp) / 2) * timing;
      const pOne = 1 - Math.pow(1 - pBurst, 1 / T.flSalvo);   // per flare, so a whole well-timed burst gives pBurst
      if (rng() < pOne) { m.decoy = idx; m._decoyT = m.age; }
    }
  }

  // ------------------------------------------------------------------------------------------- the step
  function step(dt) {
    t += dt;
    // 1. crashes, then each live fighter's seeker and triggers
    for (let i = 0; i < fighters.length; i++) {
      const f = fighters[i], c = f._c, ctl = f.ctl || NOCTL;
      if (f.alive && f.s.crashed) kill(f, t - c.aggT <= T.creditTime ? c.aggId : -1, 'crash');
      const mEdge = !!ctl.missile && !c.prevMissile, fEdge = !!ctl.flare && !c.prevFlare;
      c.prevMissile = !!ctl.missile; c.prevFlare = !!ctl.flare;
      if (!f.alive) { c.burstLeft = 0; continue; }
      updateLock(f, dt);
      if (mEdge && f.missiles > 0) fireMissile(f);
      if (fEdge && f.flares > 0 && c.burstLeft === 0) { f.flares--; c.burstLeft = T.flSalvo; c.burstT = 0; }
      if (c.burstLeft > 0 && (c.burstT -= dt) <= 0) { dropFlare(f); c.burstLeft--; c.burstT += T.flGap; }
      if (ctl.gun && f.gunAmmo > 0) {
        c.gunAcc += dt * T.gunRate;
        while (c.gunAcc >= 1 && f.gunAmmo > 0) { c.gunAcc -= 1; fireRound(f); }
        if (t - c.gunEvtT >= T.gunEvtGap - 1e-9) { c.gunEvtT = t; emit({ type: 'gunFired', owner: f.id }); }
      } else c.gunAcc = Math.min(c.gunAcc, 1);   // the first round of a burst leaves at once
    }

    // 2. flares: linear drag toward a falling terminal speed; the roll as each one ignites
    const fe = Math.exp(-dt / T.flTau);
    for (let i = 0; i < flares.length; i++) {
      const fl = flares[i];
      if (!fl.alive) continue;
      fl.age += dt;
      fl.vel[0] *= fe; fl.vel[1] = (fl.vel[1] + G * T.flTau) * fe - G * T.flTau; fl.vel[2] *= fe;
      for (let j = 0; j < 3; j++) fl.pos[j] += fl.vel[j] * dt;
      const a = fl.age;
      fl.burn = a < T.flIgnite ? a / T.flIgnite : a < T.flBurn ? 1 : clamp(1 - (a - T.flBurn) / T.flFade, 0, 1);
      if (!fl._lit && a >= T.flIgnite) { fl._lit = true; flareRoll(fl, i); }
      if (a >= T.flBurn + T.flFade) fl.alive = false;
    }

    // 3. missiles
    for (let i = 0; i < missiles.length; i++) {
      const m = missiles[i];
      if (!m.alive) continue;
      m.age += dt;
      const v = Math.hypot(m.vel[0], m.vel[1], m.vel[2]) || 1, fx = m.vel[0] / v, fy = m.vel[1] / v, fz = m.vel[2] / v;
      // a maddog takes the first enemy inside its seeker cone
      if (m.target < 0 && m.decoy < 0 && !m._blind) {
        const cb = Math.cos(T.mBoreDeg * D2R);
        for (let k = 0; k < fighters.length; k++) {
          const g = fighters[k];
          if (!g.alive || g.id === m.owner) continue;
          const dx = g.s.pos[0] - m.pos[0], dy = g.s.pos[1] - m.pos[1], dz = g.s.pos[2] - m.pos[2], R = Math.hypot(dx, dy, dz);
          if (R < T.mBoreRange && (fx * dx + fy * dy + fz * dz) / R > cb) { m.target = g.id; break; }
        }
      }
      // the aim point: the target, sliding onto the decoy flare
      const tg = live(m.target), dfl = m.decoy >= 0 ? flares[m.decoy] : null;
      let guide = false;
      if (dfl && dfl.alive) {
        const w = tg ? sstep(0, T.dcSlide, m.age - m._decoyT) : 1;
        for (let j = 0; j < 3; j++) { AP[j] = dfl.pos[j]; AV[j] = dfl.vel[j]; if (w < 1) { AP[j] += (tg.s.pos[j] - AP[j]) * (1 - w); AV[j] += (tg.s.vel[j] - AV[j]) * (1 - w); } }
        guide = true;
      } else if (tg && m.decoy < 0) {
        for (let j = 0; j < 3; j++) { AP[j] = tg.s.pos[j]; AV[j] = tg.s.vel[j]; }
        guide = true;
        blame(tg, m.owner);
      }
      if (guide && dist(AP, m.pos) > T.mBlindR && (AP[0] - m.pos[0]) * fx + (AP[1] - m.pos[1]) * fy + (AP[2] - m.pos[2]) * fz < Math.cos(T.mGimbalDeg * D2R) * dist(AP, m.pos)) {
        guide = false; m._blind = true;   // out of the seeker's view (overshot): lost for good (no maddog re-acquire)
        if (m.decoy < 0) m.target = -1; else m.decoy = -1;
      }
      let la = 0;
      LAT[0] = LAT[1] = LAT[2] = 0;
      if (m.age >= T.mIgnite) {
        if (guide) {   // true PN: N * (LOS rate x V)
          const rx = AP[0] - m.pos[0], ry = AP[1] - m.pos[1], rz = AP[2] - m.pos[2], r2 = rx * rx + ry * ry + rz * rz || 1;
          S0[0] = rx; S0[1] = ry; S0[2] = rz; S1[0] = AV[0] - m.vel[0]; S1[1] = AV[1] - m.vel[1]; S1[2] = AV[2] - m.vel[2];
          cross(S0, S1, OM); OM[0] /= r2; OM[1] /= r2; OM[2] /= r2;
          if (r2 > T.mBlindR * T.mBlindR) { cross(OM, m.vel, LAT); LAT[0] *= T.mN; LAT[1] *= T.mN; LAT[2] *= T.mN; }
        }
        // gravity compensation (also holds an unguided missile's line)
        LAT[0] -= fx * fy * G; LAT[1] -= -G + fy * fy * G; LAT[2] -= fz * fy * G;
        la = Math.hypot(LAT[0], LAT[1], LAT[2]);
        const cap = T.mGMax * G * clamp((v / T.mGRefV) ** 2, T.mGFloor, 1);
        if (la > cap) { const k = cap / la; LAT[0] *= k; LAT[1] *= k; LAT[2] *= k; la = cap; }
      }
      // the airframe lags the command (first order), and only the across-path part turns it
      const kl = 1 - Math.exp(-dt / T.mLag), L = m._lat;
      for (let j = 0; j < 3; j++) L[j] += (LAT[j] - L[j]) * kl;
      const lf = L[0] * fx + L[1] * fy + L[2] * fz;
      for (let j = 0; j < 3; j++) LAT[j] = L[j] - lf * (j === 0 ? fx : j === 1 ? fy : fz);
      la = Math.hypot(LAT[0], LAT[1], LAT[2]);
      const lit = m.age >= T.mIgnite;
      m.motor = lit ? sstep(0.06, T.mIgnite + 0.04, m.age) * (1 - sstep(T.mBurn - 0.2, T.mBurn, m.age)) : 0;
      const along = (lit ? T.mBoost * m.motor : 0) - T.mDrag * v * v - T.mTurnDrag * la;
      for (let j = 0; j < 3; j++) S2[j] = m.pos[j];   // the step's start, for the fuse
      m.vel[0] += (LAT[0] + along * fx) * dt; m.vel[1] += (LAT[1] + along * fy - G) * dt; m.vel[2] += (LAT[2] + along * fz) * dt;
      const vv = Math.hypot(m.vel[0], m.vel[1], m.vel[2]);
      if (vv > T.mVMax) { const k = T.mVMax / vv; m.vel[0] *= k; m.vel[1] *= k; m.vel[2] *= k; }
      for (let j = 0; j < 3; j++) m.pos[j] += m.vel[j] * dt;
      // proximity fuse (not once decoyed: the seeker is on the flare)
      if (m.decoy < 0 && m.age >= T.mArm) {
        for (let k = 0; k < fighters.length && m.alive; k++) {
          const g = fighters[k];
          if (!g.alive || g.id === m.owner) continue;
          const u = segHit(S2, m.pos, g.s.pos, g.s.vel, dt);
          if (SEG.d2 < T.mFuse * T.mFuse) {
            m.alive = false;
            for (let j = 0; j < 3; j++) S3[j] = S2[j] + (m.pos[j] - S2[j]) * u;
            emit({ type: 'missileHit', missile: m.id, target: g.id, pos: [S3[0], S3[1], S3[2]] });
            damage(g, T.mDamage, m.owner, 'missile');
          }
        }
        if (!m.alive) continue;
      }
      if (m.decoy >= 0) {   // fizzles at (or past) its flare
        const fl = flares[m.decoy];
        const d = dist(m.pos, fl.pos), opening = (m.pos[0] - fl.pos[0]) * (m.vel[0] - fl.vel[0]) + (m.pos[1] - fl.pos[1]) * (m.vel[1] - fl.vel[1]) + (m.pos[2] - fl.pos[2]) * (m.vel[2] - fl.vel[2]) > 0;
        if (!fl.alive || d < T.dcFizzle || (opening && m.age - m._decoyT > T.dcSlide)) { m.alive = false; emit({ type: 'missileGone', missile: m.id, reason: 'decoyed' }); continue; }
      }
      if (m.pos[1] < th(m.pos[0], m.pos[2])) { m.alive = false; emit({ type: 'missileGone', missile: m.id, reason: 'ground' }); continue; }
      if (m.age >= T.mLife) { m.alive = false; emit({ type: 'missileGone', missile: m.id, reason: 'fuel' }); }
    }

    // 4. bullets
    for (let i = 0; i < bullets.length; i++) {
      const b = bullets[i];
      if (!b.alive) continue;
      b.age += dt;
      for (let j = 0; j < 3; j++) S2[j] = b.pos[j];
      b.vel[1] -= G * dt;
      for (let j = 0; j < 3; j++) b.pos[j] += b.vel[j] * dt;
      for (let k = 0; k < fighters.length; k++) {
        const g = fighters[k];
        if (!g.alive || g.id === b.owner) continue;
        const u = segHit(S2, b.pos, g.s.pos, g.s.vel, dt);
        if (SEG.d2 < T.gunR * T.gunR) {
          b.alive = false;
          for (let j = 0; j < 3; j++) S3[j] = S2[j] + (b.pos[j] - S2[j]) * u;
          emit({ type: 'gunHit', owner: b.owner, target: g.id, pos: [S3[0], S3[1], S3[2]] });
          damage(g, T.gunDamage, b.owner, 'gun');
          break;
        }
      }
      if (b.alive && (b.age >= T.gunLife || b.pos[1] < th(b.pos[0], b.pos[2]))) b.alive = false;
    }

    // 5. missile warnings: the nearest missile still chasing each fighter
    for (let i = 0; i < fighters.length; i++) {
      const f = fighters[i], w = f.warn;
      let best = null, bd = Infinity;
      if (f.alive) for (let k = 0; k < missiles.length; k++) {
        const m = missiles[k];
        if (!m.alive || m.target !== f.id || m.decoy >= 0) continue;
        const d = dist(m.pos, f.s.pos);
        if (d < bd) { bd = d; best = m; }
      }
      const on = !!best;
      if (on) { const k = 1 / (bd || 1); for (let j = 0; j < 3; j++) w.dir[j] = (best.pos[j] - f.s.pos[j]) * k; w.dist = bd; }
      else { w.dist = 0; }
      if (on !== w.missile) { w.missile = on; emit({ type: 'warning', target: f.id, on }); }
    }
  }

  /** a new round for this fighter: full hp and ammo, lock cleared; its own and its chasers' projectiles removed */
  function reset(f) {
    f.hp = 1; f.alive = true; f.missiles = T.missiles; f.flares = T.flareBursts; f.gunAmmo = T.gunAmmo;
    f.lock = f.lock || { target: -1, progress: 0, locked: false };
    f.lock.target = -1; f.lock.progress = 0; f.lock.locked = false;
    f.warn = f.warn || { missile: false, dir: [0, 0, 0], dist: 0 };
    f.warn.missile = false; f.warn.dist = 0; f.warn.dir[0] = f.warn.dir[1] = f.warn.dir[2] = 0;
    const c = f._c = f._c || {};
    c.prevMissile = false; c.prevFlare = false; c.gunAcc = 1; c.gunEvtT = -1; c.burstLeft = 0; c.burstT = 0; c.flSide = 0; c.aggId = -1; c.aggT = -1e9;
    for (const m of missiles) if (m.alive && (m.owner === f.id || m.target === f.id)) m.alive = false;
    for (const b of bullets) if (b.owner === f.id) b.alive = false;
    for (const fl of flares) if (fl.owner === f.id) fl.alive = false;
    for (const g of fighters) if (g.lock && g.lock.target === f.id) { g.lock.target = -1; g.lock.progress = 0; g.lock.locked = false; }
  }
  function add(f) { if (!fighters.includes(f)) { fighters.push(f); byId[f.id] = f; } reset(f); return f; }

  return { add, reset, step, missiles, bullets, flares, fighters, TUNE: T, get t() { return t; } };
}
