// flight.js -- the jet's flight model (lane FLIGHT). Pure: no three.js, no DOM, runs in node (flight.check.mjs).
//
// A point mass with a lift vector (the maths of ~/SalesLeagueBoxingProto/web/js/jetplan.js step(): thrust, drag with the
// induced term, the lift limit n ~ v^2, the 2nd-order bank loop, roll-before-pull, g onset), driven by a "mouse aim
// instructor" in the War Thunder arcade style: the pilot (or an AI) gives a world DIRECTION it wants to fly toward
// (ctl.aim); the jet rolls its lift vector toward it, then pulls g in proportion to the angle off the nose, capped by what
// the speed allows. With the aim on the nose the 1 g that holds the jet up points straight up, so the wings level by
// themselves. Keyboard pitch / roll / yaw add on top (a held roll or pitch key switches the auto-bank off).
//
// Easy forgiveness: no spin exists in this model. Too slow (stall) -> the lift fades, the wings level and the nose falls
// gently until the speed is back. Terrain still kills: any body point under env.terrainHeightAt -> crashed.
//
// The orientation is singularity-free: the jet keeps its own lift direction `up` (unit, perpendicular to the velocity),
// carried along as the velocity turns and rolled about it by the roll rate, so loops and vertical flight are fine.
//
// Frames: jetspec.js section 1 (world x east, y up, z south; jet +z forward, +y up, +x the pilot's LEFT).

import { qMul, qAxis, qNorm, quatFromBasis, G, JET, AB_DETENT } from './jetspec.js';

const D2R = Math.PI / 180;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

/**
 * Every feel number in one place. Units: m/s, m/s^2, g, rad, rad/s, s. Change these to change the feel; nothing else
 * in this file holds a tuning constant.
 */
export const TUNE = {
  // --- lift and g
  vCorner: 215,          // m/s: the lift limit reaches nMax here (fastest turn rate)
  nMax: 8.5,             // g, the structural / pilot limit
  nMin: -2.0,            // g, the most negative push
  aoaMaxDeg: 24,         // the AoA the lift limit needs (nose above the flight path, visual only)
  gOnset: 9,             // g/s the load may build
  gRelease: 12,          // g/s it may fall
  turnBoost: 1.3,        // arcade: the lift above 1 g pushes this much harder than the g the HUD shows (1 = real)
  // --- the instructor (mouse aim)
  aimGain: 4.0,          // 1/s: wanted turn rate = aimGain * angle off the nose (so the error decays in ~1/aimGain s)
  aimLead: 0.25,         // s: how far ahead the instructor allows for its own roll-out and unload (kills the overshoot)
  pullStartDeg: 20,      // roll-before-pull: the full pull waits until the bank is within this of the wanted one...
  pullFullDeg: 55,       // ...and is held to 1.2 g while it is further off than this
  pushMaxDeg: 25,        // aims below the nose within this angle are reached by pushing (negative g), not rolling over
  // --- roll
  rollMaxDeg: 240,       // deg/s roll-rate cap (LIMITS.rollRateDeg is 280)
  rollW: 8,              // the bank loop's natural frequency (rad/s): higher = snappier, settles in ~0.6 s
  rollAcc: 14,           // rad/s^2 roll acceleration cap: the roll eases in and out
  keyRollDeg: 180,       // deg/s for a held A / D
  // --- keyboard pitch / yaw
  keyPushG: 1.5,         // g pushed by a full Arrow-down (from 1 g, so -0.5 g)
  yawG: 0.6,             // g of side force for a full Q / E (a flat rudder skid)
  yawBetaDeg: 6,         // the nose's visual skid angle at full rudder
  // --- engine and drag (per unit mass: jetplan's FLIGHT, research A2 bleed numbers)
  thrDry: 5.2,           // m/s^2 at the detent (military power)
  thrAb: 13.5,           // m/s^2 at full afterburner
  spool: 1.6,            // throttle units per second the engine follows the lever at
  d0: 4.0,               // parasite drag at 250 m/s (m/s^2)
  di: 0.17,              // induced drag at 1 g and 250 m/s (m/s^2): the hard-turn bleed (jetplan 0.2256: we bleed a bit less)
  dBrake: 9.0,           // extra parasite drag with the air brake out
  dTrans: 0.006,         // the transonic rise above vTrans (per (m/s)^2)
  vTrans: 265,
  brakeRate: 2.0,        // air brake travel per second
  vMaxHard: 420,         // a hard clamp (a vertical dive in AB)
  // --- boost (a power-up: powerups.js sets s.boost = s left and counts it down)
  boostThrust: 1.6,      // thrust times this while s.boost > 0
  boostTrans: 0.45,      // the transonic drag rise times this: level top speed ~300 -> ~335 m/s (a noticeable surge)
  // --- stall (Easy)
  vStall: 110,           // below this the jet is stalled (warn.stall)
  stallBand: 18,         // the stall fades in over vStall + 8 .. vStall - stallBand + 8
  stallLift: 0.8,        // the fraction of the lift a full stall takes away
  stallDropRate: 0.55,   // rad/s the flight path falls at in a full stall (the nose drop)
  vFloor: 35,            // the speed never goes below this (no tail slide, no NaN)
  // --- terrain and the play area
  pullUpLook: [0.5, 1, 1.5, 2, 3, 4],   // s ahead along the flight path the PULL UP check samples
  pullUpMargin: 25,      // m over the ground counts as an impact
  pullUpHold: 0.4,       // s the warning stays on after the last hit (no flicker)
  edgeIn: 300,           // m inside the box's edge the turn-back starts
  edgeFull: 1500,        // m outside the edge the soft blend is full
  edgeSoft: 0.6,         // the most of the aim the soft (distance) blend takes
  edgeEase: 2.0,         // s the full turn-back takes to ease in once past the edge (and out once back inside)
  ceilingBand: 600,      // m under the ceiling the nose-down push starts
  ceilingDiveSin: -0.3,  // the aim's steepest allowed climb at the ceiling (sin of the angle; < 0 = it must descend)
};

/** Body points tested against the ground (jet space): nose, tail, belly, both wingtips, the fin tops. */
const PROBES = [[0, 0, JET.noseZ], [0, -0.3, JET.tailZ], [0, -1.0, 0], JET.wingtips[0], JET.wingtips[1], [0, 2.74, -5.6]];

/**
 * @typedef {Object} JetState  one jet (README flight.js). Every array is the jet's own, rewritten in place each step.
 * @property {number[]} pos   [3] world (m)            @property {number[]} vel  [3] world (m/s)
 * @property {number[]} q     [4] body -> world        @property {number} speed m/s
 * @property {number} throttle  0..1 the engine's spooled lever (>= AB_DETENT = afterburner)
 * @property {number} ab        0..1 afterburner          @property {number} aoa rad (nose above the path)
 * @property {number} gLoad     g (+ = pressed into the seat)   @property {number} rollRate rad/s (+ = right)
 * @property {number} stall     0..1                      @property {number} brake 0..1 (the air brake's travel)
 * @property {boolean} crashed  @property {number[]|null} crashPoint [3] world where it hit
 * @property {{pullUp:boolean, stall:boolean, boundary:boolean}} warn
 * @property {number[]} steer   [3] the direction the jet actually steers to (ctl.aim after the boundary / ceiling blend)
 * @property {number[]} up      [3] the lift direction (body +y before the AoA tilt)
 * @property {number} t         s since createJet
 * @property {number} boost     s of power-up boost left (powerups.js writes it): more thrust, less transonic drag
 */

/**
 * A new jet in level flight.
 * @param {{pos:number[], heading?:number, speed?:number}} o  heading clockwise from north (rad), speed m/s
 * @returns {JetState}
 */
export function createJet({ pos, heading = 0, speed = 220 }) {
  const fx = Math.sin(heading), fz = -Math.cos(heading);
  const s = {
    pos: [pos[0], pos[1], pos[2]], vel: [fx * speed, 0, fz * speed], q: [0, 0, 0, 1], up: [0, 1, 0], steer: [fx, 0, fz],
    speed, throttle: 0.7, ab: 0, aoa: 0, gLoad: 1, rollRate: 0, stall: 0, brake: 0, yaw: 0, stickX: 0, stickY: 0,
    crashed: false, crashPoint: null, warn: { pullUp: false, stall: false, boundary: false }, t: 0, _pullUpT: 0, _back: 0, boost: 0,
  };
  orient(s);
  return s;
}

// scratch (no allocations in stepJet)
const F = [0, 0, 0], U = [0, 0, 0], R = [0, 0, 0], A = [0, 0, 0], L = [0, 0, 0], LV = [0, 0, 0], P = [0, 0, 0];
const QA = [0, 0, 0, 1], LEFT = [0, 0, 0], AXX = [1, 0, 0], AXY = [0, 1, 0];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]); if (l > 1e-12) { a[0] /= l; a[1] /= l; a[2] /= l; } return l; };
// out = a x b (out must not alias a or b)
const cross = (a, b, o) => { o[0] = a[1] * b[2] - a[2] * b[1]; o[1] = a[2] * b[0] - a[0] * b[2]; o[2] = a[0] * b[1] - a[1] * b[0]; return o; };
// rotate v about the unit axis k by angle a (Rodrigues), in place
function rotAbout(v, k, a) {
  const c = Math.cos(a), s = Math.sin(a), d = dot(k, v) * (1 - c);
  const x = v[0] * c + (k[1] * v[2] - k[2] * v[1]) * s + k[0] * d;
  const y = v[1] * c + (k[2] * v[0] - k[0] * v[2]) * s + k[1] * d;
  const z = v[2] * c + (k[0] * v[1] - k[1] * v[0]) * s + k[2] * d;
  v[0] = x; v[1] = y; v[2] = z;
}
/** the lift limit (g) at speed v */
/** the lift acceleration (in g) a load of n gives: 1 g holds the jet up exactly, the rest is boosted (TUNE.turnBoost) */
const nEff = (n) => 1 + (n - 1) * TUNE.turnBoost;
const nLift = (v) => Math.min(TUNE.nMax, TUNE.nMax * (v / TUNE.vCorner) ** 2);
const thrustOf = (thr) => (thr < AB_DETENT ? TUNE.thrDry * thr / AB_DETENT : TUNE.thrDry + (TUNE.thrAb - TUNE.thrDry) * (thr - AB_DETENT) / (1 - AB_DETENT));
const dragOf = (v, n, brake, trans = 1) => (TUNE.d0 + TUNE.dBrake * brake) * (v / 250) ** 2 + TUNE.di * n * n * (250 / v) ** 2 + TUNE.dTrans * trans * Math.max(0, v - TUNE.vTrans) ** 2;
const aoaOf = (v, n) => clamp(TUNE.aoaMaxDeg * D2R * n / (TUNE.nMax * (v / TUNE.vCorner) ** 2), -6 * D2R, (TUNE.aoaMaxDeg + 4) * D2R);

// q from the flight path, the lift direction, the AoA and the skid
function orient(s) {
  const v = Math.hypot(s.vel[0], s.vel[1], s.vel[2]) || 1;
  F[0] = s.vel[0] / v; F[1] = s.vel[1] / v; F[2] = s.vel[2] / v;
  cross(s.up, F, LEFT);                                     // +x = left = up x fwd
  quatFromBasis(LEFT, s.up, F, s.q);
  qMul(s.q, qAxis(AXX, -s.aoa, QA), s.q);                   // nose up above the path
  if (s.yaw) qMul(s.q, qAxis(AXY, -s.yaw * TUNE.yawBetaDeg * D2R, QA), s.q);   // nose right = about -y
  qNorm(s.q);
}

// the aim after the play area's rules: back toward the centre past the edge, down under the ceiling
function steerOf(s, ctl, env, dt) {
  const a = s.steer;
  if (ctl && ctl.aim) { a[0] = ctl.aim[0]; a[1] = ctl.aim[1]; a[2] = ctl.aim[2]; } else { a[0] = F[0]; a[1] = F[1]; a[2] = F[2]; }
  if (norm(a) < 1e-9) { a[0] = F[0]; a[1] = F[1]; a[2] = F[2]; }
  s.warn.boundary = false;
  const pa = env && env.playArea;
  if (!pa) return;
  const dx = s.pos[0] - pa.cx, dz = s.pos[2] - pa.cz, out = Math.max(Math.abs(dx), Math.abs(dz)) - pa.half;
  // past the edge the turn-back eases in over edgeEase s and holds until the jet is edgeIn back inside (hysteresis)
  s._back = clamp(s._back + (out > 0 ? dt : out < -TUNE.edgeIn ? -dt : 0) / TUNE.edgeEase, 0, 1);
  if (out > -TUNE.edgeIn || s._back > 0) {
    const w = Math.max(TUNE.edgeSoft * sstep(-TUNE.edgeIn, TUNE.edgeFull, out), sstep(0, 1, s._back)), d = Math.hypot(dx, dz) || 1;
    // toward the centre, level; plus a sliver of the nose so a 180 deg blend never passes through zero
    // + a sliver of the jet's right, so an aim straight away from the centre still blends into a (right) turn, never zero
    a[0] = a[0] * (1 - w) - dx / d * w + R[0] * 0.15 * w; a[1] = a[1] * (1 - w); a[2] = a[2] * (1 - w) - dz / d * w + R[2] * 0.15 * w;
    norm(a);
    if (out > 0) s.warn.boundary = true;
  }
  if (pa.ceiling !== undefined && s.pos[1] > pa.ceiling - TUNE.ceilingBand) {
    const yMax = 1 + (TUNE.ceilingDiveSin - 1) * sstep(pa.ceiling - TUNE.ceilingBand, pa.ceiling + 200, s.pos[1]);
    if (a[1] > yMax) {
      let hx = a[0], hz = a[2], h = Math.hypot(hx, hz);
      if (h < 1e-3) { hx = F[0]; hz = F[2]; h = Math.hypot(hx, hz) || 1; }
      const k = Math.sqrt(1 - yMax * yMax) / h;
      a[0] = hx * k; a[1] = yMax; a[2] = hz * k;
    }
    if (s.pos[1] > pa.ceiling) s.warn.boundary = true;
  }
}

/**
 * One fixed step of the flight model. Allocation-free.
 * @param {JetState} s
 * @param {{aim:number[]|null, pitch?:number, roll?:number, yaw?:number, throttle?:number, ab?:boolean, brake?:boolean}} ctl
 *        aim: unit world direction to fly toward (null = straight on); pitch/roll/yaw -1..1 keyboard (+ = pull, roll
 *        right, nose right); throttle 0..1 target lever; ab forces full afterburner; brake holds the air brake out.
 * @param {number} dt  seconds (the game steps 1/120)
 * @param {{terrainHeightAt?:(x:number,z:number)=>number, playArea?:{cx:number,cz:number,half:number,ceiling?:number}}} env
 * @returns {JetState} s
 */
export function stepJet(s, ctl, dt, env) {
  if (s.crashed) return s;
  s.t += dt;
  const T = TUNE;
  let v = Math.hypot(s.vel[0], s.vel[1], s.vel[2]);
  if (!(v > T.vFloor)) {                                    // also catches NaN: never let the speed vanish
    if (!(v > 1e-6)) { s.vel[0] = F[0] || 0; s.vel[1] = F[1] || 0; s.vel[2] = F[2] || 1; v = Math.hypot(s.vel[0], s.vel[1], s.vel[2]); }
    const k = T.vFloor / v; s.vel[0] *= k; s.vel[1] *= k; s.vel[2] *= k; v = T.vFloor;
  }
  F[0] = s.vel[0] / v; F[1] = s.vel[1] / v; F[2] = s.vel[2] / v;
  // carry the lift direction with the turning path (remove its along-path part)
  const ua = dot(s.up, F);
  s.up[0] -= ua * F[0]; s.up[1] -= ua * F[1]; s.up[2] -= ua * F[2];
  if (norm(s.up) < 1e-6) { s.up[0] = 0; s.up[1] = 1; s.up[2] = 0; const k = dot(s.up, F); s.up[0] -= k * F[0]; s.up[1] -= k * F[1]; s.up[2] -= k * F[2]; if (norm(s.up) < 1e-6) { s.up[0] = 1; s.up[1] = 0; s.up[2] = 0; } }
  cross(F, s.up, R);                                        // right = fwd x up

  const pitchK = ctl ? clamp(ctl.pitch || 0, -1, 1) : 0, rollK = ctl ? clamp(ctl.roll || 0, -1, 1) : 0, yawK = ctl ? clamp(ctl.yaw || 0, -1, 1) : 0;
  const manualRoll = Math.abs(rollK) > 0.05, manualPitch = Math.abs(pitchK) > 0.05;
  s.stall = sstep(T.vStall + 8, T.vStall + 8 - T.stallBand, v);
  const nCap = nLift(v) * (1 - T.stallLift * s.stall);

  // --- the instructor: the lift that turns the path toward the aim (gravity compensated)
  steerOf(s, ctl, env, dt);
  const c = clamp(dot(F, s.steer), -1, 1), th = Math.acos(c);
  A[0] = s.steer[0] - c * F[0]; A[1] = s.steer[1] - c * F[1]; A[2] = s.steer[2] - c * F[2];
  if (norm(A) < 0.05 && c < 0) { A[0] = s.up[0]; A[1] = s.up[1]; A[2] = s.up[2]; }   // the aim dead astern: pull through
  // lead: the turn rate the jet already has toward the aim, times the time it takes to roll out and unload, is angle it
  // will still turn anyway -- without it the jet overshoots the aim by ~15 deg after a hard 90
  const wNow = (nEff(s.gLoad) * G * dot(s.up, A) - G * A[1]) / v;
  const thEff = Math.max(0, th - wNow * T.aimLead);
  const aWant = Math.min(T.aimGain * thEff * v, (nEff(nCap) + 1) * G);   // m/s^2 toward the aim
  // L = wanted acceleration - (gravity's part across the path)
  L[0] = A[0] * aWant - F[0] * F[1] * G; L[1] = A[1] * aWant + (1 - F[1] * F[1]) * G; L[2] = A[2] * aWant - F[2] * F[1] * G;
  const lMag = norm(L);
  let nDes = 1 + (lMag / G - 1) / T.turnBoost;             // the load (HUD g) whose boosted lift is |L|
  // the target lift direction LV, and whether to push rather than roll over
  LV[0] = L[0]; LV[1] = L[1]; LV[2] = L[2];
  if (dot(L, s.up) < -0.3 && th < T.pushMaxDeg * D2R) { LV[0] = -L[0]; LV[1] = -L[1]; LV[2] = -L[2]; nDes = Math.max(1 + (-lMag / G - 1) / T.turnBoost, T.nMin); }
  if (s.stall > 0) {                                        // stalled: wings level (the lift goes back to "up")
    const k = s.stall;
    LV[0] = LV[0] * (1 - k) - k * F[0] * F[1]; LV[1] = LV[1] * (1 - k) + k * (1 - F[1] * F[1]); LV[2] = LV[2] * (1 - k) - k * F[2] * F[1];
    norm(LV);
  }
  let phiErr = Math.atan2(dot(cross(s.up, LV, P), F), dot(s.up, LV));   // + = roll right
  phiErr *= sstep(0.1, 0.4, lMag / G);                      // no wanted lift (vertical, aim on the nose): hold the bank

  // --- roll: the 2nd-order bank loop (jetplan), or the keyboard's rate
  const rMax = T.rollMaxDeg * D2R;
  let pAcc;
  if (manualRoll && s.stall < 0.5) pAcc = clamp((rollK * T.keyRollDeg * D2R - s.rollRate) * T.rollW, -T.rollAcc, T.rollAcc);
  else if (manualPitch && s.stall < 0.5) pAcc = clamp(-2 * T.rollW * s.rollRate, -T.rollAcc, T.rollAcc);   // hold the bank
  else pAcc = clamp(T.rollW * T.rollW * phiErr - 2 * T.rollW * s.rollRate, -T.rollAcc, T.rollAcc);
  s.rollRate = clamp(s.rollRate + pAcc * dt, -rMax, rMax);
  rotAbout(s.up, F, s.rollRate * dt);
  cross(F, s.up, R);
  s.stickX = clamp(pAcc / T.rollAcc * 0.6 + s.rollRate / rMax * 0.4, -1, 1);

  // --- pull: roll first, then pull (the 1 g that holds the jet up is always allowed)
  if (manualPitch) nDes = pitchK > 0 ? 1 + pitchK * (nCap - 1) : 1 + pitchK * T.keyPushG;
  else {
    const wPull = 1 - sstep(T.pullStartDeg * D2R, T.pullFullDeg * D2R, Math.abs(phiErr));
    const n0 = Math.min(nDes, 1.2);
    nDes = n0 + (nDes - n0) * wPull;
  }
  nDes = clamp(nDes, T.nMin, nCap);
  s.gLoad += clamp((nDes - s.gLoad) * 8, -T.gRelease, T.gOnset) * dt;
  s.gLoad = clamp(s.gLoad, T.nMin, nCap);
  s.stickY = clamp(s.gLoad >= 1 ? (s.gLoad - 1) / (T.nMax - 1) : (s.gLoad - 1) / (1 - T.nMin), -1, 1);

  // --- engine, air brake
  const thrWant = ctl ? (ctl.ab ? 1 : clamp(ctl.throttle ?? s.throttle, 0, 1)) : s.throttle;
  s.throttle += clamp(thrWant - s.throttle, -T.spool * dt, T.spool * dt);
  s.ab = s.throttle > AB_DETENT ? (s.throttle - AB_DETENT) / (1 - AB_DETENT) : 0;
  s.brake += clamp((ctl && ctl.brake ? 1 : 0) - s.brake, -T.brakeRate * dt, T.brakeRate * dt);
  s.yaw += clamp(yawK - s.yaw, -3 * dt, 3 * dt);

  // --- the point mass: lift + side force + thrust - drag + gravity (+ the stall's nose drop)
  const boost = s.boost > 0;
  const along = thrustOf(s.throttle) * (boost ? T.boostThrust : 1) - dragOf(v, s.gLoad, s.brake, boost ? T.boostTrans : 1);
  const nG = nEff(s.gLoad) * G, side = s.yaw * T.yawG * G;
  // stall drop: turn the path toward the ground (the across-path part of "down")
  const drop = s.stall * T.stallDropRate * v;
  P[0] = F[0] * F[1]; P[1] = -(1 - F[1] * F[1]); P[2] = F[2] * F[1];
  const pd = Math.hypot(P[0], P[1], P[2]) || 1;
  for (let j = 0; j < 3; j++) s.vel[j] += (nG * s.up[j] + side * R[j] + along * F[j] + drop * P[j] / pd) * dt;
  s.vel[1] -= G * dt;
  v = Math.hypot(s.vel[0], s.vel[1], s.vel[2]);
  if (v > T.vMaxHard) { const k = T.vMaxHard / v; s.vel[0] *= k; s.vel[1] *= k; s.vel[2] *= k; v = T.vMaxHard; }
  for (let j = 0; j < 3; j++) s.pos[j] += s.vel[j] * dt;
  s.speed = v;
  s.aoa = aoaOf(v, s.gLoad) + s.stall * 8 * D2R;
  orient(s);
  s.warn.stall = s.stall > 0.5;

  // --- terrain: crash, and PULL UP along the path
  const th8 = env && env.terrainHeightAt;
  if (th8) {
    if (s.pos[1] - th8(s.pos[0], s.pos[2]) < 30) {
      for (let i = 0; i < PROBES.length; i++) {
        qRotTo(s.q, PROBES[i], P);
        const x = s.pos[0] + P[0], y = s.pos[1] + P[1], z = s.pos[2] + P[2], h = th8(x, z);
        if (y < h) {
          s.crashed = true; s.crashPoint = [x, h, z];       // one allocation, once per life
          s.vel[0] = s.vel[1] = s.vel[2] = 0; s.speed = 0; s.rollRate = 0; s.warn.pullUp = false;
          return s;
        }
      }
    }
    let hit = false;
    for (let i = 0; i < T.pullUpLook.length && !hit; i++) {
      const tt = T.pullUpLook[i], x = s.pos[0] + s.vel[0] * tt, z = s.pos[2] + s.vel[2] * tt;
      hit = s.pos[1] + s.vel[1] * tt < th8(x, z) + T.pullUpMargin;
    }
    s._pullUpT = hit ? T.pullUpHold : Math.max(0, s._pullUpT - dt);
    s.warn.pullUp = s._pullUpT > 0;
  }
  return s;
}

// qRot without the default-arg allocation
function qRotTo(q, v, o) {
  const x = q[0], y = q[1], z = q[2], w = q[3], vx = v[0], vy = v[1], vz = v[2];
  const tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx);
  o[0] = vx + w * tx + y * tz - z * ty; o[1] = vy + w * ty + z * tx - x * tz; o[2] = vz + w * tz + x * ty - y * tx;
  return o;
}

/**
 * Fill `out` for jetmodel.js setState(): the surfaces (rad, inside JET.limits), the stick, throttle, pedals, the nozzle
 * and the afterburner flame, all derived from the flight state so the model always agrees with the motion.
 * @param {JetState} s
 * @param {Object} [out]
 * @returns {{aileron:number, elevator:number, rudder:number, flap:number, lef:number, brake:number, stickX:number,
 *   stickY:number, throttle:number, pedal:number, nozzle:number, ab:number, t:number, nz:number, aoa:number, vapour:number}}
 */
export function jetModelState(s, out = {}) {
  const lim = JET.limits, slow = sstep(170, 120, s.speed);
  out.stickX = s.stickX; out.stickY = s.stickY; out.pedal = clamp(s.yaw, -1, 1);
  out.aileron = s.stickX * lim.aileron;
  out.elevator = s.stickY * lim.elevator;
  out.rudder = out.pedal * lim.rudderDef;
  out.flap = slow * lim.flap * 0.6;
  out.lef = clamp(s.aoa / (TUNE.aoaMaxDeg * D2R), 0, 1) * lim.lef;
  out.brake = s.brake;
  out.throttle = s.throttle;
  out.ab = s.ab;
  out.nozzle = s.ab > 0 ? 0.4 + 0.6 * s.ab : clamp(0.4 - s.throttle, 0, 0.4);   // open at idle and in AB, closed at mil
  out.t = s.t;
  out.nz = s.gLoad; out.aoa = s.aoa;
  out.vapour = sstep(5.5, 8, s.gLoad);
  return out;
}
