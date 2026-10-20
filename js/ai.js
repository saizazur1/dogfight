// ai.js -- the AI pilot (lane COMBAT + AI, README "Phase 3 contract"). Pure: no three.js, no DOM, runs in node (ai.check.mjs).
//
//   const ai = createAI(fighter, { skill: 'easy'|'medium'|'hard', env, combat, seed });
//   ai.think(dt, target);   // every step, BEFORE stepJet: writes fighter.ctl (aim, throttle, ab, gun, missile, flare)
//
// It flies through flight.js exactly like the mouse does (ctl.aim = the world direction it wants to fly), so it has no
// physics the player lacks; its g is held to the skill's (times a seeded +-12 % 'nerve') by how far off the path it aims. It sees the target late (a delay line of the target's position and velocity, extrapolated by
// the reaction time) and aims with a slowly wandering error. A small state machine picks the wanted direction:
//   ENGAGE  not behind it: fly for its six (a point behind it on its path); behind it: lead pursuit, gun lead (the rounds'
//           flight, the target's seen acceleration) on the gun line, lag when overshooting; head-on gun snapshots; throttle
//           holds a range behind it (outside the missile's minimum while it has missiles) or the corner speed in a turn;
//           missiles when locked, in range and aspect. With the target in its rear hemisphere it jinks (random reversals),
//           which is what breaks the equal-jets circle (without it Medium vs Medium drew ~70 % of 3-min fights)
//   DEFEND  a missile warning, after the reaction time: turn away from a frontal missile (it must chase and runs short),
//           hard into one from the side or behind (it must out-turn the jet; combat.check's numbers); flares on the timing
//   EXTEND  too slow: unload, afterburner, until the speed is back
//   PATROL  no live target: back to the middle of the play area
// and AVOID TERRAIN sits on top of all of them: the wanted direction's path is checked against terrainHeightAt; if it
// comes too close the AI searches a fan of headings / climbs for the clear one nearest to what it wanted (it turns into
// the valley rather than always climbing); an imminent impact on the current path is a full pull up.
// Deterministic: one mulberry32 stream, no wall clock, no allocation in think().

import { mulberry32 } from './rng.js';
import { TUNE as FT } from './flight.js';
import { G } from './jetspec.js';

const D2R = Math.PI / 180;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** Every skill knob in one table. */
export const SKILL = {
  easy: {
    react: 0.9,            // s: it sees the target this late (extrapolated), and answers a missile warning this late
                           // (defendReact, optional: a later answer to a missile than react)
    aimErrDeg: 5,          // the wandering aim error (deg, rms-ish)
    gMax: 5.0,             // g it pulls at most in a fight (terrain escapes use everything)
    flareTti: [3.5, 6],    // s to impact it pops flares at (drawn per missile; > ~3 s is early = poor odds)
    flareForget: 0.35,     // chance it forgets the flares for a missile
    missileGap: 10,        // s between its missiles
    missileRange: [900, 3500],
    gunRange: 600, gunConeDeg: 3, gunHold: 0.6,    // m, deg off the lead it fires inside, s it may keep firing after the solution goes
    minAlt: 600,           // m over the ground it tries to keep (how low it dares)
    ab: false,             // uses the afterburner only to escape the ground / a stall
    defend: false,         // false: always turns away from a missile; true: away from a frontal one, hard into one from the side / rear
    missileAspect: -1,     // fires only when at least this far round to the target's tail (cos: 1 = dead astern)
    headOn: false,         // takes head-on gun snapshots
  },
  medium: {
    react: 0.45, defendReact: 0.9, aimErrDeg: 2.2, gMax: 7.0, flareTti: [0.9, 4.5], flareForget: 0.3, missileGap: 6, missileRange: [550, 3200],
    gunRange: 750, gunConeDeg: 2, gunHold: 0.4, minAlt: 300, ab: true, defend: true, missileAspect: -0.5, headOn: true,
  },
  hard: {
    react: 0.18, aimErrDeg: 0.8, gMax: 8.5, flareTti: [1.2, 2.4], flareForget: 0, missileGap: 3, missileRange: [450, 2800],
    gunRange: 900, gunConeDeg: 1.5, gunHold: 0.3, minAlt: 140, ab: true, defend: true, missileAspect: -0.2, headOn: true,
  },
};

/** The non-skill numbers. */
export const AI_TUNE = {
  look: [0.5, 1, 1.5, 2, 3, 4, 5.5],     // s ahead along the wanted path the terrain check samples
  turnIn: 0.8,                            // s the path keeps its current direction before it follows the wanted one
  fanYawDeg: [0, -25, 25, -50, 50, -80, 80, -120, 120],
  fanPitchDeg: [0, 10, 20, 35, 55],
  avoidEvery: 0.1,                        // s between fan searches (the choice is held in between)
  impactLook: [0.5, 1, 1.5, 2.2],         // s ahead on the CURRENT path: ground inside these = full pull up
  pullOutG: 5, rollT: 1.2,                // the dive check (conservative): the arc's acceleration (g, effective) and the roll + g onset before it (s)
  extendBelow: 145, extendUntil: 215,     // m/s
  holdRange: 450,                         // m behind the target the throttle aims to sit at
  breakOff: 350,                          // m: closer than this head-on it stops shooting and passes to the left
  headOnShotR: 1800,                      // m: a missile at a target facing it only from this far (it forces the target to turn away)
  sixDist: 800,                           // m behind the target the 'go for its six' point sits
  gSpread: 0.12,                          // +- fraction of the skill's g a pilot may pull (seeded per AI)
  jinkRange: 1800, jinkEvery: 3,          // m: an enemy this close in my rear hemisphere -> jink; s between reversals (randomised)
  rearBonus: 800,                         // m more missile range from dead astern
  cornerV: 225,                           // m/s it holds in a turning fight (flight.js vCorner 215)
  errEvery: 0.5,                          // s between new aim-error targets
  bulletV: 1000,                          // m/s (combat TUNE.gunV) for the lead
};

// scratch (shared by every AI: think() is not re-entrant)
const F = [0, 0, 0], W = [0, 0, 0], TP = [0, 0, 0], TV = [0, 0, 0], TA = [0, 0, 0], GL = [0, 0, 0], C = [0, 0, 0], NOSE = [0, 0, 0], BEST = [0, 0, 0];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]); if (l > 1e-12) { a[0] /= l; a[1] /= l; a[2] /= l; } return l; };
function noseOf(q, o) { const x = q[0], y = q[1], z = q[2], w = q[3]; o[0] = 2 * (x * z + w * y); o[1] = 2 * (y * z - w * x); o[2] = 1 - 2 * (x * x + y * y); return o; }

/**
 * @param {Object} fighter  README fighter (its ctl is written in place; aim gets its own array)
 * @param {{skill?:string, env:{terrainHeightAt:Function, playArea?:Object}, combat?:Object, seed?:number}} o
 */
export function createAI(fighter, { skill = 'medium', env, combat = null, seed = 1 }) {
  const K = SKILL[skill] || SKILL.medium, A = AI_TUNE, rng = mulberry32(seed);
  // this pilot's own nerve (seeded): pulls a little more or less than the skill's g, so equal skills do not fight to a draw
  const gMax = Math.min(FT.nMax, K.gMax * (1 - A.gSpread + 2 * A.gSpread * rng()));
  const th = (env && env.terrainHeightAt) || (() => -1e9), pa = env && env.playArea;
  const ctl = fighter.ctl;
  if (!ctl.aim) ctl.aim = [0, 0, -1];
  // the delay line: the target's pos + vel, one sample per think() (120 Hz)
  const NBUF = Math.max(2, Math.round(K.react * 120) + 1), buf = new Float64Array(6 * NBUF);
  let head = 0, filled = 0, bufId = -1;
  const err = [0, 0, 0], errWant = [0, 0, 0];
  let t = 0, errT = 0, state = 'patrol', warnT = 0, lastDist = 0, flareTti = 0, flareSkip = false, lastFlare = -99, lastMissile = -99, gunT = -99;
  let avoidT = -1, avoiding = false, lastOff = NaN, jinkT = 0, jinkSide = 1, jinkUp = 0;
  const avoidDir = [0, 0, -1];

  /** the least clearance (m) over the ground along a path that turns from the current velocity onto dir */
  function clearance(s, dir, v) {
    let m = 1e9;
    for (let i = 0; i < A.look.length; i++) {
      const tt = A.look[i], a = Math.min(tt, A.turnIn), b = Math.max(0, tt - A.turnIn);
      const x = s.pos[0] + (F[0] * a + dir[0] * b) * v, y = s.pos[1] + (F[1] * a + dir[1] * b) * v, z = s.pos[2] + (F[2] * a + dir[2] * b) * v;
      m = Math.min(m, y - th(x, z));
    }
    return m;
  }
  /** turn `want` (unit) into a direction clear of the ground (in place) */
  function avoidTerrain(s, want, v) {
    const margin = K.minAlt * 0.6;
    // 1. the current path hits the ground soon, or a dive is steeper than the height left can pull it out of (a roll, then an
    //    arc at ~pullOutG): everything into a climb along the current heading
    const sinD = Math.max(0, -F[1]), hNeed = sinD > 0.05 ? v * v / (A.pullOutG * G) * (1 - Math.sqrt(1 - sinD * sinD)) + A.rollT * v * sinD : 0;
    const agl = s.pos[1] - Math.max(th(s.pos[0], s.pos[2]), th(s.pos[0] + s.vel[0], s.pos[2] + s.vel[2]));
    for (let i = -1; i < A.impactLook.length; i++) {
      const tt = i < 0 ? 0 : A.impactLook[i], x = s.pos[0] + s.vel[0] * tt, z = s.pos[2] + s.vel[2] * tt;
      if (i < 0 ? agl < hNeed + K.minAlt * 0.5 : s.pos[1] + s.vel[1] * tt < th(x, z) + 40) {
        const h = Math.hypot(F[0], F[2]) || 1;
        want[0] = F[0] / h * 0.45; want[1] = 0.9; want[2] = F[2] / h * 0.45; norm(want);
        return 2;
      }
    }
    // 2. the wanted path is clear: keep it (and stop any held avoidance once it has been clear a moment)
    if (clearance(s, want, v) >= margin) { avoiding = false; return 0; }
    // 3. search the fan (held for avoidEvery s): the clear direction nearest the wanted one, else the highest clearance
    if (!avoiding || t - avoidT >= A.avoidEvery) {
      avoiding = true; avoidT = t;
      const hw = Math.atan2(want[0], -want[2]), pw = Math.asin(clamp(want[1], -1, 1));
      let bestScore = Infinity;
      for (let i = 0; i < A.fanYawDeg.length; i++) for (let j = 0; j < A.fanPitchDeg.length; j++) {
        const hh = hw + A.fanYawDeg[i] * D2R, pp = Math.max(pw, 0) + A.fanPitchDeg[j] * D2R, cp = Math.cos(pp);
        C[0] = Math.sin(hh) * cp; C[1] = Math.sin(pp); C[2] = -Math.cos(hh) * cp;
        const cl = clearance(s, C, v), off = Math.acos(clamp(dot(C, want), -1, 1));
        const score = cl >= margin ? off : 10 + (margin - cl) / 50;
        if (score < bestScore) { bestScore = score; BEST[0] = C[0]; BEST[1] = C[1]; BEST[2] = C[2]; }
      }
      avoidDir[0] = BEST[0]; avoidDir[1] = BEST[1]; avoidDir[2] = BEST[2];
    }
    want[0] = avoidDir[0]; want[1] = avoidDir[1]; want[2] = avoidDir[2];
    return 1;
  }
  /** hold `want` to at most the skill's g: no more than the angle off the path that asks for gMax (flight.js's instructor
   *  pulls aimGain * (angle - turnRate * aimLead), so the angle allows for the lead too) */
  function limitG(want, v, gUse) {
    const thMax = clamp(1.1 * (1 + (gUse - 1) * FT.turnBoost) * G / v * (1 / FT.aimGain + FT.aimLead), 4 * D2R, Math.PI);   // (lift is boosted: turnBoost)
    const c = clamp(dot(want, F), -1, 1);
    if (Math.acos(c) <= thMax) return;
    W[0] = want[0] - c * F[0]; W[1] = want[1] - c * F[1]; W[2] = want[2] - c * F[2];
    if (norm(W) < 1e-6) { W[0] = fighter.s.up[0]; W[1] = fighter.s.up[1]; W[2] = fighter.s.up[2]; }
    // a turn "down" through the canopy: keep the aim past flight.js's push window so it ROLLS to it rather than pushing -g
    // forever (the roll comes first at ~1 g, then the limit holds the pull again)
    const lim = dot(W, fighter.s.up) < -0.3 ? Math.max(thMax, Math.min(Math.acos(c), (FT.pushMaxDeg + 5) * D2R)) : thMax;
    const cm = Math.cos(lim), sm = Math.sin(lim);
    want[0] = F[0] * cm + W[0] * sm; want[1] = F[1] * cm + W[1] * sm; want[2] = F[2] * cm + W[2] * sm;
  }

  function think(dt, target) {
    t += dt;
    const f = fighter, s = f.s;
    ctl.missile = false; ctl.flare = false; ctl.gun = false;
    if (!f.alive || s.crashed) { ctl.ab = false; return; }
    const v = Math.max(s.speed, 1);
    F[0] = s.vel[0] / v; F[1] = s.vel[1] / v; F[2] = s.vel[2] / v;
    const aim = ctl.aim, tgt = target && target.alive ? target : null;

    // --- perceive (late): the delay line, extrapolated by the reaction time
    if (tgt) {
      if (tgt.id !== bufId) { bufId = tgt.id; filled = 0; }
      const o = head * 6;
      for (let j = 0; j < 3; j++) { buf[o + j] = tgt.s.pos[j]; buf[o + 3 + j] = tgt.s.vel[j]; }
      head = (head + 1) % NBUF; filled = Math.min(filled + 1, NBUF);
      // what it sees: the oldest sample, its acceleration (from the next few samples), carried forward by the delay
      const oldest = (head - filled + NBUF) % NBUF, age = (filled - 1) * dt, r = oldest * 6;
      const k = Math.min(12, filled - 1), r2 = ((oldest + k) % NBUF) * 6;
      for (let j = 0; j < 3; j++) {
        TA[j] = k > 0 ? (buf[r2 + 3 + j] - buf[r + 3 + j]) / (k * dt) : 0;
        TV[j] = buf[r + 3 + j] + TA[j] * age; TP[j] = buf[r + j] + buf[r + 3 + j] * age + 0.5 * TA[j] * age * age;
      }
    }
    // --- the aim error: a slow wander toward a new random offset every errEvery s
    if ((errT -= dt) <= 0) { errT = A.errEvery; const e = K.aimErrDeg * D2R; for (let j = 0; j < 3; j++) errWant[j] = (rng() * 2 - 1) * e; }
    for (let j = 0; j < 3; j++) err[j] += (errWant[j] - err[j]) * Math.min(1, 3 * dt);

    // --- the state
    if (f.warn.missile) {   // a new warning: draw this missile's flare timing (and whether it forgets)
      if (warnT === 0) { flareTti = K.flareTti[0] + (K.flareTti[1] - K.flareTti[0]) * rng(); flareSkip = rng() < K.flareForget; }
      warnT += dt;
    } else warnT = 0;
    if (!tgt) state = 'patrol';
    else if (warnT > (K.defendReact ?? K.react)) state = 'defend';   // defendReact: a missile is answered later than a turn
    else if (state === 'extend' ? v < A.extendUntil : v < A.extendBelow) state = 'extend';
    else state = 'engage';

    let thr = 0.84, ab = false, brake = false, gunSolution = false, R = 0;
    if (state === 'patrol') {
      const cx = pa ? pa.cx : 0, cz = pa ? pa.cz : 0, dx = cx - s.pos[0], dz = cz - s.pos[2], d = Math.hypot(dx, dz);
      if (d > 3000) { aim[0] = dx / d; aim[1] = 0; aim[2] = dz / d; } else { aim[0] = F[0]; aim[1] = 0; aim[2] = F[2]; }
      norm(aim); thr = 0.75;
    } else if (state === 'extend') {
      aim[0] = F[0]; aim[1] = -0.08; aim[2] = F[2]; norm(aim); thr = 1; ab = true;
    } else if (state === 'defend') {
      // a frontal missile: turn away (level); from the side or behind: a level break toward its side. Flares when the time
      // to impact comes down to this missile's drawn timing
      const d = f.warn.dir, h = Math.hypot(d[0], d[2]) || 1, hf = Math.hypot(F[0], F[2]) || 1;
      if (!K.defend || (d[0] * F[0] + d[2] * F[2]) / (h * hf) > 0.5) { aim[0] = -d[0] / h; aim[2] = -d[2] / h; }
      else { const rx = -F[2] / hf, rz = F[0] / hf, side = rx * d[0] + rz * d[2] >= 0 ? 1 : -1; aim[0] = rx * side; aim[2] = rz * side; }
      aim[1] = 0; norm(aim);
      thr = 1; ab = K.ab;
      const closure = warnT > dt ? (lastDist - f.warn.dist) / dt : 0, tti = closure > 1 ? f.warn.dist / closure : 99;
      if (!flareSkip && f.flares > 0 && tti < flareTti && t - lastFlare > 2.5) { ctl.flare = true; lastFlare = t; }
    } else {
      // ENGAGE
      for (let j = 0; j < 3; j++) W[j] = TP[j] - s.pos[j];
      R = norm(W);                                            // W = unit line of sight
      const tvl = Math.hypot(TV[0], TV[1], TV[2]) || 1, behind = dot(TV, W) / tvl;   // 1 = I am dead astern of it
      const closure = (s.vel[0] - TV[0]) * W[0] + (s.vel[1] - TV[1]) * W[1] + (s.vel[2] - TV[2]) * W[2];
      let tau, aimOffsetRight = false;
      if (R < K.gunRange * 1.8 && (behind > -0.2 || (K.headOn && behind < -0.7 && R > A.breakOff))) {   // gun (also a head-on
        tau = R / (A.bulletV + Math.max(0, closure));                                                       // snapshot): lead by
        gunSolution = true;                                                                                 // the rounds' flight
        if (behind > 0.3 && closure > 50 && R < 700 && dot(W, F) < 0.985) { tau = -0.4; gunSolution = false; }   // overshooting: lag
      } else if (behind < -0.3 && R < A.breakOff) { tau = 0; aimOffsetRight = true; }   // about to pass head-on: pass to its left
      else if (behind < 0.3) tau = -Math.min(A.sixDist, R * 0.5) / tvl;   // not behind it: go for its six (a point behind it on its path)
      else tau = Math.min(1.2, R / 2500);                      // behind it, closing: a little lead
      for (let j = 0; j < 3; j++) aim[j] = TP[j] + TV[j] * tau + (gunSolution ? 0.5 * TA[j] * tau * tau : 0) - s.pos[j];
      if (gunSolution) aim[1] += 0.5 * G * tau * tau;
      norm(aim);
      if (aimOffsetRight) { const hf = Math.hypot(F[0], F[2]) || 1; aim[0] += -F[2] / hf * 0.5; aim[2] += F[0] / hf * 0.5; norm(aim); }
      // it sits in my rear hemisphere: jink (hard turns that reverse at random moments) so a circle never settles
      if (dot(W, F) < -0.2 && R < A.jinkRange) {
        if ((jinkT -= dt) <= 0) { jinkT = A.jinkEvery * (0.6 + 0.8 * rng()); jinkSide = rng() < 0.5 ? -1 : 1; jinkUp = (rng() * 2 - 1) * 0.3; }
        const hf = Math.hypot(F[0], F[2]) || 1;
        aim[0] = F[0] / hf * 0.35 - F[2] / hf * jinkSide; aim[1] = jinkUp; aim[2] = F[2] / hf * 0.35 + F[0] / hf * jinkSide; norm(aim);
      } else jinkT = 0;
      if (gunSolution) {   // the rounds leave along the nose plus the jet's own velocity: steer the path so THAT line is on the lead
        noseOf(s.q, NOSE);
        for (let j = 0; j < 3; j++) GL[j] = F[j] * v + NOSE[j] * A.bulletV;
        norm(GL);
        const off = Math.acos(clamp(dot(GL, aim), -1, 1)); lastOff = off;
        if (R < K.gunRange && off < K.gunConeDeg * D2R && f.gunAmmo > 0) gunT = t;
        for (let j = 0; j < 3; j++) aim[j] += F[j] - GL[j];
        norm(aim);
      }
      ctl.gun = t - gunT < K.gunHold && R < K.gunRange * 1.1;
      // the throttle: sit holdRange behind it; turning hard (it is well off the nose): hold the corner speed; else keep the energy
      const offNose = dot(W, F);
      // (with missiles left and the seeker on it, it drops back outside the missile's minimum range instead)
      const hold = f.missiles > 0 && f.lock.target === tgt.id && R < K.missileRange[0] + 200 ? K.missileRange[0] + 250 : A.holdRange;
      if (behind > 0.3 && offNose > 0.7) {
        thr = clamp(0.8 + (clamp((R - hold) * 0.35, -50, 80) - closure) * 0.02, 0, 1); brake = closure > 40 && R < hold * 1.5;
        if (offNose < 0.99 && v < A.cornerV && closure < 20) thr = 1;   // it is turning: keep the corner speed unless closing fast
      }
      else if (offNose < 0.5) { thr = clamp(0.84 + (A.cornerV - v) * 0.02, 0.3, 1); brake = v > A.cornerV + 60; }
      else thr = v < 240 ? 1 : 0.84;
      ab = K.ab && (v < A.cornerV || (thr > 0.99 && R > 1200));
      // the missile: locked on it, in range, and not one of mine already chasing it
      const L = f.lock;
      if (L.locked && L.target === tgt.id && f.missiles > 0 && t - lastMissile >= K.missileGap && R >= K.missileRange[0] && R <= K.missileRange[1] + A.rearBonus * Math.max(0, behind) && (behind >= K.missileAspect || R >= A.headOnShotR)) {
        let chasing = false;
        if (combat) for (let i = 0; i < combat.missiles.length; i++) { const m = combat.missiles[i]; if (m.alive && m.owner === f.id && m.target === tgt.id) chasing = true; }
        if (!chasing) { ctl.missile = true; lastMissile = t; }
      }
    }
    lastDist = f.warn.dist;
    if (state === 'engage' || state === 'defend') {
      for (let j = 0; j < 3; j++) aim[j] += err[j];
      norm(aim);
      // slow: pull less (keep the energy: a turn at the lift limit bleeds it fast and a slow jet turns worse)
      limitG(aim, v, gMax * clamp((v - A.extendBelow) / (A.cornerV - A.extendBelow), 0.5, 1));
    }
    // stay well inside the box (flight.js turns it back at the edge anyway)
    if (pa) {
      const dx = s.pos[0] - pa.cx, dz = s.pos[2] - pa.cz, out = Math.max(Math.abs(dx), Math.abs(dz)) - (pa.half - 2500);
      if (out > 0) { const w = clamp(out / 2000, 0, 0.8), d = Math.hypot(dx, dz) || 1; aim[0] = aim[0] * (1 - w) - dx / d * w; aim[2] = aim[2] * (1 - w) - dz / d * w; norm(aim); }
    }
    // AVOID TERRAIN: always last, always wins
    const av = avoidTerrain(s, aim, v);
    if (av) { thr = Math.max(thr, 0.84); ab = ab || av === 2 || v < 170; ctl.gun = ctl.gun && av !== 2; }
    ctl.throttle = thr; ctl.ab = ab; ctl.brake = brake && !av;
  }

  return { think, get state() { return state; }, get gunOff() { return lastOff; }, skill: K, gMax };
}
