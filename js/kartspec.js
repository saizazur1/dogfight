// kartspec.js -- THE SHARED CONTRACT of the kart race (KART_LANES.md section 1). Pure: no three.js, no DOM,
// runs in node. FROZEN once merged: a lane that needs a change writes a request in its report.
//
// CONTRACT v2 (2026-10-13, approved by the coordinator on the DRIVER lane's measurements; lanes/kart-driver/NOTES.md):
//   1. KART.pedal.zRange[1]  1.10 -> 1.22  (at 1.10 the four men's knees flexed 41-72 deg; the target is 25-35 deg)
//   2. KART.seat.halfW       0.20 -> 0.215 (Hassan's hips sat 5.7 mm into the side bolsters)
//   Nothing else moved: kartSdfLite reads both values, so it follows; the tray still ends at z = 1.15 (KART lane adds a
//   decor toe-board beyond it for the farthest pedal positions).
//
//
//   import { KART, TRACK_SPEC, kartMatrix, ackermann, wheelAngle, rpmOf, raceTime, screenTime,
//            kartSdfLite, sampleKartPlan, makeKartSample, ... } from './kartspec.js';
//
// ======================================================================================================
// 1. FRAMES, SIGNS AND UNITS  (read this once; every lane relies on it)
// ======================================================================================================
// Units: metres, seconds, radians, m/s, g = 9.81 m/s^2 (`G`). Angles in the data are RADIANS; `...Deg`
// names are degrees. Money, sales, customers and personal data do not exist in this contract.
//
// WORLD / TRACK FRAME (right-handed, y UP).  The track lies in the plane y = 0 of the *track frame*; WORLD
// places that frame on the valley floor (a Matrix4 `trackFrame`), so a world matrix is trackFrame * kartMatrix.
//   heading `yaw`: the forward direction is (sin yaw, 0, cos yaw)  -> yaw 0 faces +z.
//   yaw is the rotation about +y, so it is POSITIVE TO THE LEFT (counter-clockwise seen from above).
//   The circuit runs CLOCKWISE (right turns dominate): yaw DECREASES by 2*PI per lap. `yaw` is stored
//   UNWRAPPED (continuous, never jumps by 2*PI), so linear interpolation is always correct.
//   Lateral offset `n` (track-API terms): positive = to the LEFT of the direction of travel (+x at yaw 0).
//
// KART SPACE: origin on the GROUND under the MIDDLE OF THE REAR AXLE; +z FORWARD, +y UP, +x the DRIVER'S LEFT
//   (right-handed: x = y cross z). The figure GLBs face +z, so a figure needs no rotation in kart space.
//   The driver's right is -x (the engine is at x < 0). All KART numbers below are in kart space.
//
// BODY ANGLES (kartMatrix applies R = Ry(yaw+beta) * Rx(pitch) * Rz(roll), pivoting at the kart-space origin):
//   yaw   path heading (the direction the kart TRAVELS); beta = body slip: the body points at yaw + beta.
//         beta > 0 = nose rotated to the left of the path; a tail-out in a right-hand corner has beta < 0.
//   pitch POSITIVE = NOSE DOWN (braking). roll POSITIVE = the TOP tips toward the DRIVER'S RIGHT (-x).
//   Tilts are small (<= 3 deg), so a pivot at the rear-axle ground point is exact enough: the KART lane
//   corrects each wheel's height itself (kerb heave, the lifted wheel).
//
// STEERING:  `steer` = the front-wheel angle of the bicycle model, radians, POSITIVE = RIGHT turn (front
//   wheels point to the driver's right). `wheel` = steering-wheel angle theta = steer * 4.0, clamped to
//   +-100 deg; POSITIVE = the TOP of the wheel turns to the driver's right (a right turn). To put an angle on
//   a three.js mesh that rotates about +y, use `mesh.rotation.y = -angle` (right = clockwise from above).
//   Counter-steer in a tail-out is steer = pathSteer + beta (beta < 0 gives a left correction).
//
// SIGNED LATERAL / LONGITUDINAL G:  latG POSITIVE = the kart accelerates toward its LEFT (a LEFT turn),
//   so a right-hand corner has latG < 0. longG positive = speeding up. `inside` = sign of latG
//   (+1 left is inside, -1 right is inside; step channel). `lean` POSITIVE = toward the driver's LEFT; the
//   driver leans to the OUTSIDE, so lean = -k * latG (right turn -> lean > 0). `headYaw` POSITIVE = left.
//
// WHEEL SPIN: spinR / spinFL / spinFR are ACCUMULATED rolling angles in radians, forward rolling = POSITIVE
//   (mesh.rotation.x = +spin for a wheel whose axle is the kart x axis: the top moves forward).
//   BOTH REAR WHEELS ALWAYS SHARE spinR (solid axle, even the lifted one). d(spinR)/dt * rRear = v +-2 %.
//
// WHEEL / ONKERB ORDER everywhere: [RL, RR, FL, FR] = rear-left, rear-right, front-left, front-right.
//
// ======================================================================================================
// 2. TIME BASE
// ======================================================================================================
// Two clocks. RACE clock `tRace` (seconds from the plan's start, everything the planner computes, the
// arrays are sampled on it at DT = 1/120). SCREEN clock `tScreen` (what the viewer's `?t=` and the
// cameras/HUD/sound use). They are identical except across the CUT to parc ferme, where the race clock
// jumps forward. The map is stored in the plan as `screenMap` and converted ONLY by raceTime() /
// screenTime() below -- nobody else may re-implement it. Event times (`events[].t`, `tLightsOut`,
// `tFinish`, `duration`) are on the RACE clock; use screenTime(M, t) to put an event on the screen clock.
// Shot lists (DIRECT) and the HUD are on the SCREEN clock.
//
// screenMap = [[tScreen, tRace], ...]: knots, piecewise LINEAR between them, both columns nondecreasing,
// slope 1 outside the first/last knot. A CUT is two knots with the SAME tScreen and different tRace:
//   [[0,0], [12,12], [12,14], [14,16]]  => screen 0..12 is race 0..12; at screen 12 the race clock jumps
//   12 -> 14 (the 2 s in between are never shown); screen 12..14 is race 14..16. raceTime at the cut
//   instant returns the AFTER value. screenTime of a race time inside the skipped span returns the cut's
//   tScreen. Positions JUMP at a cut (the camera cuts with them): a jump check must skip it (cutsOf()).
//
// ======================================================================================================
// 3. SHAPES (JSDoc typedefs; samples are plain objects, allocation-free when `out` is passed)
// ======================================================================================================
/**
 * @typedef {Object} KartPlan   (Float32Array channels, one array of length n per lane per channel)
 * @property {number}   seed
 * @property {number[]} order        4 lane indexes; order[0] WINS, order[3] is last
 * @property {string[]} lanes        4 roster ids, lanes[i] is the man in lane i (lane colours by index)
 * @property {number}   dt           1/120
 * @property {number}   n            samples per channel = round(duration/dt) + 1
 * @property {number}   duration     race clock, seconds ((n-1)*dt)
 * @property {number}   screenDuration screen clock, seconds
 * @property {number[][]} screenMap  see section 2
 * @property {number}   tLightsOut   race clock
 * @property {number[]} tFinish      race clock, indexed BY LANE; min is the winner's
 * @property {{t:number, kind:string, lane:number, other?:number, marker?:boolean}[]} events  sorted by t.
 *   `lane` is -1 for global events. Kinds: lightsOn (the first light; the rest follow every LIGHT_STEP),
 *   lightsOut, t1Squeeze, draftStart, pullOut, dive, passDone, nearSpin, catch, switchback, finish (one
 *   per lane), fist, slap, cut, stand. `marker: true` = a label with no physics behind it (fixture only).
 * @property {Object<string, Float32Array[]>} ch   ch[name][lane] -- names in CHANNELS below.
 *
 * @typedef {Object} KartState   one kart at one instant (all in the track frame)
 * @property {number[]} pos      [x, 0, z]  the kart-space origin on the ground (y is always 0; heave is the KART lane's)
 * @property {number} yaw  @property {number} beta  @property {number} pitch  @property {number} roll
 * @property {number} liftIn     metres the INSIDE rear wheel is raised (0..0.04); the lifted wheel is
 *                               RL when inside = +1, RR when inside = -1
 * @property {number} inside     +1 | -1 (step)
 * @property {number} steer  @property {number} wheel
 * @property {number} spinR  @property {number} spinFL  @property {number} spinFR
 * @property {number} throttle   0..1 (pedal travel)   @property {number} brake 0..1
 * @property {number} v          m/s along the path     @property {number} latG  @property {number} longG
 * @property {number} lean       rad, + = toward the driver's left
 * @property {number} headYaw    rad, + = left of the body's heading (the planned HEAD turn; eyes lead it 0.1-0.2 s, DRIVER does that)
 * @property {number[]} gaze     [x,y,z] track frame: the point he looks at (~0.8 s ahead on his line, y ~ 1 m)
 * @property {number[]} onKerb   [RL, RR, FL, FR] each 0..1 (1 = wheel fully on a kerb)
 * @property {number} fist       0..1 right fist raised (winner only)
 * @property {number} slap       0..1 the 2nd's one slap of the rim (a pulse 0 -> 1 -> 0)
 * @property {number} stand      0..1 standing up in the seat (winner only, karts stopped)
 * @property {number} place      1..4 (step); the HUD tower reads this
 *
 * @typedef {Object} KartSample
 * @property {number} tScreen  @property {number} tRace
 * @property {number} lightsLit   0..4 (see lightsLit())
 * @property {'none'|'green'|'chequered'} flag   (see flagAt())
 * @property {KartState[]} karts  4, indexed BY LANE
 */

export const G = 9.81;
export const DT = 1 / 120;
export const LANE_COUNT = 4;
export const LIGHT_STEP = 0.3;     // seconds between the red lights coming on (1,2,3,4); all out at tLightsOut
export const GREEN_SECONDS = 2.5;  // the green flag shows for this long from lights out
const D2R = Math.PI / 180;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** Channel names of KartPlan.ch: the KartState scalars, pos -> x,z; gaze -> gx,gy,gz; onKerb -> onKerb0..3. */
export const CHANNELS = Object.freeze([
  'x', 'z', 'yaw', 'beta', 'pitch', 'roll', 'liftIn', 'inside', 'steer', 'wheel',
  'spinR', 'spinFL', 'spinFR', 'throttle', 'brake', 'v', 'latG', 'longG', 'lean', 'headYaw',
  'gx', 'gy', 'gz', 'onKerb0', 'onKerb1', 'onKerb2', 'onKerb3', 'fist', 'slap', 'stand', 'place',
]);
/** Channels sampled as STEPS (previous sample, never interpolated). All the others are linear. */
export const STEP_CHANNELS = Object.freeze(['inside', 'place']);

// ======================================================================================================
// 4. THE KART  (provisional; "sourced" = a real page, the rest are estimates from KART_RACING_RESEARCH.md)
// ======================================================================================================
const deepFreeze = (o) => { Object.values(o).forEach((v) => { if (v && typeof v === 'object') deepFreeze(v); }); return Object.freeze(o); };

export const KART = deepFreeze({
  wheelbase: 1.05, trackRear: 1.20, trackFront: 1.04,            // between wheel centres
  rRear: 0.138, wRear: 0.210, rFront: 0.132, wFront: 0.132,       // Mitas 11x7.10-5 / 10x4.50-5 (sourced)
  box: { zMin: -0.42, zMax: 1.53, xHalf: 0.70, yTop: 0.62 },      // bumpers included: 1.95 x 1.40 m
  trayY: 0.035, trayThick: 0.012,                                 // trayY = TOP of the floor tray above the ground
  hPoint: [0, 0.11, 0.20], seatBackDeg: 22,                       // hip-joint target; back reclined from vertical
  // The seat shell the SDF draws. The hip joint sits 65 mm above the pan (compressed soft tissue) and 100 mm
  // in front of the back's surface: provisional, DRIVER may send ONE change request about these in half a day.
  seat: { halfW: 0.215, thick: 0.012, panTopY: 0.045, panZ1: 0.46, backH: 0.45, backDist: 0.10, sideH: 0.10 },
  wheelC: [0, 0.50, 0.68], columnDir: [0, -0.574, 0.819],         // column runs 35 deg below horizontal, forward
  column: { length: 0.45, radius: 0.0125 },                       // from wheelC along columnDir
  rimR: 0.142, rimTube: 0.015,                                    // 300 mm wheel (centre-line radius, tube radius)
  gripClock: { left: Math.PI / 2, right: -Math.PI / 2 },          // 9 and 3 o'clock, 0 = 12 o'clock
  pedal: {
    y: 0.11, zDefault: 1.02, zRange: [0.92, 1.22],                // pedal plate CENTRE height and z (the rail)
    throttle: { x: -0.10, deg: 18 }, brake: { x: 0.10, deg: 10 }, // throttle = right foot (-x), brake = left foot (+x)
    plate: { hx: 0.0375, hl: 0.065, ht: 0.005, tiltDeg: 25 },     // half width, half length, half thickness, face tilt
  },
  sidepod: { xIn: 0.46, xOut: 0.62, yMin: 0.06, yMax: 0.26, zMin: 0.40, zMax: 0.95 },
  engine: { box: [-0.72, 0.04, -0.05, -0.38, 0.45, 0.38] },       // xMin yMin zMin xMax yMax zMax, the driver's right
  steerRatio: 4.0, wheelMaxDeg: 100, massKart: 157,
  chain: 2.7, idleRpm: 1800, clutchRpm: 2000, govRpm: 3900,       // engine: rpm = wheel rpm * chain above the clutch
  lift: { max: 0.04 },                                            // inside rear wheel lift, metres (0..40 mm)
  limits: { vMax: 20.8, latG: 1.35, accel: 0.45, brake: 0.9 },    // 75 km/h, g
});

/** The four wheels in kart space, order RL, RR, FL, FR: { id, x, z, r, w } (centre height = r). */
export const WHEELS = Object.freeze([
  { id: 'RL', x: KART.trackRear / 2, z: 0, r: KART.rRear, w: KART.wRear },
  { id: 'RR', x: -KART.trackRear / 2, z: 0, r: KART.rRear, w: KART.wRear },
  { id: 'FL', x: KART.trackFront / 2, z: KART.wheelbase, r: KART.rFront, w: KART.wFront },
  { id: 'FR', x: -KART.trackFront / 2, z: KART.wheelbase, r: KART.rFront, w: KART.wFront },
].map(Object.freeze));

// ======================================================================================================
// 5. THE TRACK SPEC  (karttrack.js builds the real track from this)
// ======================================================================================================
// A closed circuit traversed CLOCKWISE from the START OF THE MAIN STRAIGHT (= the exit of T8) at the
// track-frame origin heading +z. dir 'R' = right turn (yaw decreases), 'L' = left (yaw increases). Turns:
// 5 R (90+45+180+90+100 = 505) minus 3 L (45+40+60 = 145) = 360 deg. `r` = centre-line radius (m);
// clothoid transitions of `clothoid` m are added at each corner entry/exit (curvature continuous).
//
// !! CHANGE FROM THE RESEARCH DOC, AND WHY: B1's order (T5 L40, T6 R90, T7 L60, T8 R100) CANNOT CLOSE:
// after the hairpin only the T5/T7 straights head back toward the start, and with the T6 right-hander before
// them the loop needs negative straight lengths (checked by solving the 2x2 closure; see kartspec.check.mjs).
// Swapping the last two middle corners closes it with sane straights (lengths below). So T6 is now the
// L60 r14 corner (was "T7": the near-spin on its exit kerb, tag 'nearSpin') and T7 the R90 r10 (was "T6").
// Total length ~321 m (research said ~280). The two `free` straights hold NOMINAL lengths solved with plain
// arcs; makeTrack re-solves them with the clothoids so the loop closes to < 1 mm.
export const TRACK_SPEC = deepFreeze({
  width: 7, kerbW: 0.8, kerbH: 0.05, clothoid: 5,
  origin: { x: 0, z: 0, yaw: 0 },
  segments: [
    { id: 'main', kind: 'straight', length: 55 },
    { id: 'T1', kind: 'turn', dir: 'R', deg: 90, r: 12, tags: ['exitKerb', 'squeeze'] },
    { id: 's1', kind: 'straight', length: 10 },
    { id: 'T2', kind: 'turn', dir: 'L', deg: 45, r: 15 },
    { id: 'T3', kind: 'turn', dir: 'R', deg: 45, r: 15 },
    { id: 'back', kind: 'straight', length: 50, tags: ['draft'] },
    { id: 'T4', kind: 'turn', dir: 'R', deg: 180, r: 7, tags: ['hairpin', 'exitKerb', 'dive'] },
    { id: 's2', kind: 'straight', length: 4 },
    { id: 'T5', kind: 'turn', dir: 'L', deg: 40, r: 25, tags: ['kink'] },
    { id: 's3', kind: 'straight', length: 49.569, free: true },
    { id: 'T6', kind: 'turn', dir: 'L', deg: 60, r: 14, was: 'T7', tags: ['exitKerb', 'nearSpin'] },
    { id: 's4', kind: 'straight', length: 9.562, free: true },
    { id: 'T7', kind: 'turn', dir: 'R', deg: 90, r: 10, was: 'T6' },
    { id: 's5', kind: 'straight', length: 10 },
    { id: 'T8', kind: 'turn', dir: 'R', deg: 100, r: 12, tags: ['exitKerb', 'switchback'] },
  ],
  apexKerbs: true,                       // a kerb at the inside apex of every turn; exitKerb tags add the exits
  startLine: 18,                         // s (m from the start of the main straight) of the control line
  // Pit lane and parc ferme live beside the main straight in (s, n) track terms (n > 0 left; the pit is on the
  // inside = right = n < 0). The straight is 55 m, so (s, n) -> world is exact there.
  pit: { wallN: -5.0, laneN: [-9.5, -5.5], s0: 2, s1: 52 },
  parc: { s0: 24, s1: 36, n0: -15, n1: -10.5 },       // room for a 2 x 2 block of karts (2.2 m columns, 5.5 m rows)
});

// ======================================================================================================
// 6. SMALL PURE HELPERS  (ONE copy for everybody)
// ======================================================================================================

/** World matrix (column-major, three.js Matrix4.elements layout) of a KartState: translate(pos) * Ry(yaw+beta) * Rx(pitch) * Rz(roll). */
export function kartMatrix(k, out = new Array(16)) {
  const psi = k.yaw + k.beta;
  const cy = Math.cos(psi), sy = Math.sin(psi), cx = Math.cos(k.pitch), sx = Math.sin(k.pitch);
  const cz = Math.cos(k.roll), sz = Math.sin(k.roll);
  out[0] = cy * cz + sy * sx * sz; out[1] = cx * sz;  out[2] = -sy * cz + cy * sx * sz; out[3] = 0;
  out[4] = -cy * sz + sy * sx * cz; out[5] = cx * cz; out[6] = sy * sz + cy * sx * cz;   out[7] = 0;
  out[8] = sy * cx;                 out[9] = -sx;     out[10] = cy * cx;                 out[11] = 0;
  out[12] = k.pos[0]; out[13] = k.pos[1]; out[14] = k.pos[2]; out[15] = 1;
  return out;
}

/** Ackermann split of the bicycle-model front angle `steer` (rad, + = right). The INSIDE wheel turns more:
 *  inside = atan(L/(R - T/2)), outside = atan(L/(R + T/2)), R = L/tan|steer|, T = trackFront. Same sign as steer.
 *  Returns { left, right } (rad); a mesh angle is rotation.y = -angle. */
export function ackermann(steer, out = { left: 0, right: 0 }) {
  const a = Math.abs(steer);
  if (a < 1e-9) { out.left = 0; out.right = 0; return out; }
  const L = KART.wheelbase, T = KART.trackFront / 2, R = L / Math.tan(a);
  const inn = Math.atan(L / (R - T)), outer = Math.atan(L / (R + T));
  if (steer > 0) { out.right = inn; out.left = outer; } else { out.left = -inn; out.right = -outer; }
  return out;
}

/** Steering-wheel angle theta (rad) for a front angle `steer`: steer * 4.0, clamped to +-100 deg. */
export function wheelAngle(steer) {
  const m = KART.wheelMaxDeg * D2R;
  return clamp(steer * KART.steerRatio, -m, m);
}

/** Engine rpm from the rear wheel surface speed vRear (m/s). Above the clutch lock (2,000 rpm, ~10.7 m/s
 *  at the 2.7:1 chain) rpm = wheel rpm * 2.7 (3,650 rpm at 19.5 m/s); below it the clutch slips between
 *  idle (1,800) and 2,000. Monotonic, capped by the governor. Firing frequency Hz = rpm / 120. */
export function rpmOf(vRear) {
  const drive = (Math.max(0, vRear) / KART.rRear) * (60 / (2 * Math.PI)) * KART.chain;
  if (drive >= KART.clutchRpm) return Math.min(drive, KART.govRpm);
  return KART.idleRpm + (KART.clutchRpm - KART.idleRpm) * (drive / KART.clutchRpm);
}

/** Screen clock -> race clock through M.screenMap (section 2). At a cut instant returns the AFTER value. */
export function raceTime(M, tScreen) {
  const m = M.screenMap, last = m.length - 1;
  if (tScreen < m[0][0]) return m[0][1] + (tScreen - m[0][0]);
  if (tScreen >= m[last][0]) return m[last][1] + (tScreen - m[last][0]);
  let i = 0;
  while (i + 1 < m.length && m[i + 1][0] <= tScreen) i++;
  const a = m[i], b = m[i + 1];
  return b[0] === a[0] ? a[1] : a[1] + ((tScreen - a[0]) * (b[1] - a[1])) / (b[0] - a[0]);
}

/** Race clock -> screen clock. A race time inside a skipped span returns the cut's tScreen. */
export function screenTime(M, tRace) {
  const m = M.screenMap, last = m.length - 1;
  if (tRace < m[0][1]) return m[0][0] + (tRace - m[0][1]);
  if (tRace >= m[last][1]) return m[last][0] + (tRace - m[last][1]);
  let i = 0;
  while (i + 1 < m.length && m[i + 1][1] <= tRace) i++;
  const a = m[i], b = m[i + 1];
  if (b[0] === a[0]) return a[0];                       // inside a skipped span
  return a[0] + ((tRace - a[1]) * (b[0] - a[0])) / (b[1] - a[1]);
}

/** The cuts of a plan: [{ tScreen, tRaceFrom, tRaceTo }] (a jump check skips frames across these). */
export function cutsOf(M) {
  const r = [];
  for (let i = 0; i + 1 < M.screenMap.length; i++) {
    const a = M.screenMap[i], b = M.screenMap[i + 1];
    if (a[0] === b[0] && b[1] > a[1]) r.push({ tScreen: a[0], tRaceFrom: a[1], tRaceTo: b[1] });
  }
  return r;
}

/** Race time of the first event of `kind` (for `lane` when given), or NaN. */
export function eventTime(M, kind, lane) {
  for (const e of M.events) if (e.kind === kind && (lane === undefined || e.lane === lane)) return e.t;
  return NaN;
}

/** Red lights lit (0..4) at race time t: the lightsOn event lights #1, then one more every LIGHT_STEP,
 *  all four by lightsOn + 3*LIGHT_STEP; 0 before lightsOn and from tLightsOut on. */
export function lightsLit(M, tRace) {
  const t0 = eventTime(M, 'lightsOn');
  if (!(tRace >= t0) || tRace >= M.tLightsOut) return 0;
  return Math.min(4, 1 + Math.floor((tRace - t0) / LIGHT_STEP + 1e-9));
}

/** Flag state at race time t: 'green' for GREEN_SECONDS from lights out, 'chequered' from the moment the
 *  WINNER reaches the line (never before), else 'none'. The marshal's cloth is DIRECT's/WORLD's business. */
export function flagAt(M, tRace) {
  const tWin = Math.min(...M.tFinish);
  if (tRace >= tWin) return 'chequered';
  if (tRace >= M.tLightsOut && tRace < M.tLightsOut + GREEN_SECONDS) return 'green';
  return 'none';
}

/** A blank KartSample with every key present (so sampling is allocation-free). */
export function makeKartSample() {
  const kart = () => ({
    pos: [0, 0, 0], yaw: 0, beta: 0, pitch: 0, roll: 0, liftIn: 0, inside: 1, steer: 0, wheel: 0,
    spinR: 0, spinFL: 0, spinFR: 0, throttle: 0, brake: 0, v: 0, latG: 0, longG: 0, lean: 0, headYaw: 0,
    gaze: [0, 0, 0], onKerb: [0, 0, 0, 0], fist: 0, slap: 0, stand: 0, place: 1,
  });
  return { tScreen: 0, tRace: 0, lightsLit: 0, flag: 'none', karts: [kart(), kart(), kart(), kart()] };
}

/** THE sampler: KartPlan + screen time -> KartSample (linear in the arrays, steps for STEP_CHANNELS, clamped
 *  to [0, duration]). Pure in t; allocation-free when `out` is passed. karttrack/kart.js's sampleKart and the
 *  fixture both use this, so a plan and its fixture can never be sampled differently. */
export function sampleKartPlan(M, tScreen, out = makeKartSample()) {
  const tr = clamp(raceTime(M, tScreen), 0, M.duration);
  const f = tr / M.dt, i0 = Math.min(M.n - 2, Math.floor(f + 1e-9)), u = clamp(f - i0, 0, 1), i1 = i0 + 1;
  out.tScreen = tScreen; out.tRace = tr; out.lightsLit = lightsLit(M, tr); out.flag = flagAt(M, tr);
  const ch = M.ch;
  const lin = (name, k) => { const a = ch[name][k]; return a[i0] + (a[i1] - a[i0]) * u; };
  const stp = (name, k) => ch[name][k][u >= 1 ? i1 : i0];
  for (let k = 0; k < LANE_COUNT; k++) {
    const s = out.karts[k];
    s.pos[0] = lin('x', k); s.pos[1] = 0; s.pos[2] = lin('z', k);
    s.yaw = lin('yaw', k); s.beta = lin('beta', k); s.pitch = lin('pitch', k); s.roll = lin('roll', k);
    s.liftIn = lin('liftIn', k); s.inside = stp('inside', k); s.steer = lin('steer', k); s.wheel = lin('wheel', k);
    s.spinR = lin('spinR', k); s.spinFL = lin('spinFL', k); s.spinFR = lin('spinFR', k);
    s.throttle = lin('throttle', k); s.brake = lin('brake', k); s.v = lin('v', k);
    s.latG = lin('latG', k); s.longG = lin('longG', k); s.lean = lin('lean', k); s.headYaw = lin('headYaw', k);
    s.gaze[0] = lin('gx', k); s.gaze[1] = lin('gy', k); s.gaze[2] = lin('gz', k);
    s.onKerb[0] = lin('onKerb0', k); s.onKerb[1] = lin('onKerb1', k); s.onKerb[2] = lin('onKerb2', k); s.onKerb[3] = lin('onKerb3', k);
    s.fist = lin('fist', k); s.slap = lin('slap', k); s.stand = lin('stand', k); s.place = stp('place', k);
  }
  return out;
}

// ---- oriented boxes: the 1.95 x 1.40 m rectangle of a kart, for "no pair closer than ..." checks ----
/** The 4 corners of a kart's box on the ground, [x0,z0, x1,z1, x2,z2, x3,z3] (track frame, body heading yaw+beta). */
export function boxCorners(k, out = new Array(8)) {
  const psi = k.yaw + k.beta, c = Math.cos(psi), s = Math.sin(psi), b = KART.box;
  const kx = [b.xHalf, -b.xHalf, -b.xHalf, b.xHalf], kz = [b.zMax, b.zMax, b.zMin, b.zMin];
  for (let i = 0; i < 4; i++) { out[2 * i] = k.pos[0] + kx[i] * c + kz[i] * s; out[2 * i + 1] = k.pos[2] - kx[i] * s + kz[i] * c; }
  return out;
}
const segDist = (px, pz, ax, az, bx, bz) => {
  const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz;
  const t = L2 > 0 ? clamp(((px - ax) * dx + (pz - az) * dz) / L2, 0, 1) : 0;
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
};
const _ca = new Array(8), _cb = new Array(8);
/** Signed gap between two karts' boxes: the exact distance (>= 0) when apart, MINUS the smallest
 *  penetration depth (< 0) when they overlap. PLAN's no-overlap solve and every check use this one. */
export function boxGap(a, b) {
  boxCorners(a, _ca); boxCorners(b, _cb);
  let minOverlap = Infinity;
  for (const P of [_ca, _cb]) {
    for (let e = 0; e < 2; e++) {                                  // two edge axes per rectangle
      const ax = -(P[2 * (e + 1) + 1] - P[2 * e + 1]), az = P[2 * (e + 1)] - P[2 * e], L = Math.hypot(ax, az);
      const nx = ax / L, nz = az / L;
      let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
      for (let i = 0; i < 4; i++) {
        const pa = _ca[2 * i] * nx + _ca[2 * i + 1] * nz, pb = _cb[2 * i] * nx + _cb[2 * i + 1] * nz;
        a0 = Math.min(a0, pa); a1 = Math.max(a1, pa); b0 = Math.min(b0, pb); b1 = Math.max(b1, pb);
      }
      minOverlap = Math.min(minOverlap, Math.min(a1, b1) - Math.max(a0, b0));
    }
  }
  if (minOverlap > 0) return -minOverlap;
  let d = Infinity;                                                // separated: exact corner/edge distance
  for (const [P, Q] of [[_ca, _cb], [_cb, _ca]]) {
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
      const j2 = (j + 1) % 4;
      d = Math.min(d, segDist(P[2 * i], P[2 * i + 1], Q[2 * j], Q[2 * j + 1], Q[2 * j2], Q[2 * j2 + 1]));
    }
  }
  return d;
}

// ======================================================================================================
// 7. THE STEERING WHEEL AND THE PEDALS  (geometry the KART mesh and the DRIVER hands/feet both read)
// ======================================================================================================
const _cd = KART.columnDir, _cl = Math.hypot(_cd[0], _cd[1], _cd[2]);
/** Unit axes of the steering wheel in kart space: `axis` = the column (normal of the wheel plane, pointing
 *  forward-down, AWAY from the driver), `up` = the in-plane direction of 12 o'clock, `left` = +x = 9 o'clock. */
export const WHEEL_AXES = deepFreeze({
  axis: [_cd[0] / _cl, _cd[1] / _cl, _cd[2] / _cl],
  up: [0, _cd[2] / _cl, -_cd[1] / _cl],
  left: [1, 0, 0],
});

/** Centre-line point of the rim at CLOCK angle phi (0 = 12 o'clock, + toward the driver's left) of the
 *  UNROTATED wheel, kart space. A grip point glued to the rim has clock = gripClock - theta once the wheel
 *  is turned by theta (positive theta moves the top toward the driver's right). Optionally also the unit
 *  tangent (increasing phi) in `tan`. */
export function rimPoint(phi, out = [0, 0, 0], tan) {
  const u = WHEEL_AXES.up, c = Math.cos(phi), s = Math.sin(phi), R = KART.rimR, w = KART.wheelC;
  out[0] = w[0] + R * s; out[1] = w[1] + R * c * u[1]; out[2] = w[2] + R * c * u[2];
  if (tan) { tan[0] = c; tan[1] = -s * u[1]; tan[2] = -s * u[2]; }
  return out;
}

/** The pedal plate for `which` ('throttle' | 'brake') with `press` 0..1 at rail position `pedalZ`:
 *  { hinge, c (centre), u (unit, bottom -> top of the plate), n (unit face normal, toward the driver),
 *    hx, hl, ht (half width, half length, half thickness) }. The plate hinges at its lower edge and the top
 *  swings FORWARD by press * (18 deg throttle, 10 deg brake). The ball of the foot goes on the face. */
export function pedalPlate(which, press, pedalZ = KART.pedal.zDefault, out = { hinge: [0, 0, 0], c: [0, 0, 0], u: [0, 0, 0], n: [0, 0, 0], hx: 0, hl: 0, ht: 0 }) {
  const P = KART.pedal, pl = P.plate, spec = which === 'throttle' ? P.throttle : P.brake;
  const a0 = pl.tiltDeg * D2R, a = a0 + clamp(press, 0, 1) * spec.deg * D2R;
  const uy = Math.cos(a), uz = Math.sin(a), ny = Math.sin(a), nz = -Math.cos(a);
  out.hinge[0] = spec.x; out.hinge[1] = P.y - pl.hl * Math.cos(a0); out.hinge[2] = pedalZ - pl.hl * Math.sin(a0);
  out.u[0] = 0; out.u[1] = uy; out.u[2] = uz; out.n[0] = 0; out.n[1] = ny; out.n[2] = nz;
  out.c[0] = spec.x; out.c[1] = out.hinge[1] + pl.hl * uy; out.c[2] = out.hinge[2] + pl.hl * uz;
  out.hx = pl.hx; out.hl = pl.hl; out.ht = pl.ht;
  return out;
}

/** Seat geometry derived from KART.hPoint / seat: the back's surface plane and the pan. Kart space. */
export const SEAT = (() => {
  const s = KART.seat, a = KART.seatBackDeg * D2R, h = KART.hPoint;
  const nb = [0, Math.sin(a), Math.cos(a)];            // back surface normal, pointing at the driver (up and forward)
  const u = [0, Math.cos(a), -Math.sin(a)];            // up the back, leaning rearward
  const p = [h[0], h[1] - s.backDist * nb[1], h[2] - s.backDist * nb[2]];        // a point ON the back surface
  const t = (s.panTopY - p[1]) / u[1];
  const bottom = [0, s.panTopY, p[2] + t * u[2]];      // where the back's surface meets the pan top
  return deepFreeze({ nb, u, bottom, panZ0: bottom[2], panZ1: s.panZ1 });
})();

// ======================================================================================================
// 8. kartSdfLite -- the analytic stand-in every lane checks against (negative inside; EXACT distances)
// ======================================================================================================
export const PARTS = Object.freeze(['seat', 'rim', 'column', 'pedalThrottle', 'pedalBrake', 'tray', 'sidepod', 'engine']);

// rounded box, centre c, half extents h (the rounding eats `r` of each half extent), local axes e1,e2,e3
function sdOBox(px, py, pz, cx, cy, cz, e1, e2, e3, hx, hy, hz, r) {
  const dx = px - cx, dy = py - cy, dz = pz - cz;
  const a = Math.abs(dx * e1[0] + dy * e1[1] + dz * e1[2]) - (hx - r);
  const b = Math.abs(dx * e2[0] + dy * e2[1] + dz * e2[2]) - (hy - r);
  const c = Math.abs(dx * e3[0] + dy * e3[1] + dz * e3[2]) - (hz - r);
  return Math.hypot(Math.max(a, 0), Math.max(b, 0), Math.max(c, 0)) + Math.min(Math.max(a, b, c), 0) - r;
}
const AX = [1, 0, 0], AY = [0, 1, 0], AZ = [0, 0, 1];
const sdAABB = (px, py, pz, cx, cy, cz, hx, hy, hz, r) => sdOBox(px, py, pz, cx, cy, cz, AX, AY, AZ, hx, hy, hz, r);

const _pl = { hinge: [0, 0, 0], c: [0, 0, 0], u: [0, 0, 0], n: [0, 0, 0], hx: 0, hl: 0, ht: 0 };
const _eN = [0, 0, 0], _eU = [0, 0, 0];
const _sd = { d: 0, part: '' };

/** Signed distance (m) from kart-space point p=[x,y,z] to the nearest part, and which part it is.
 *  st = { throttle, brake, pedalZ } (all optional: 0, 0, KART.pedal.zDefault). The wheel is modelled at
 *  theta = 0; the rim is a torus, so it is symmetric about the column (a turned wheel has the same SDF).
 *  The tyres and the bodywork are NOT in it. The KART lane's mesh agrees with it within 5 mm. */
export function kartSdfLite(p, st, out = _sd) {
  const x = p[0], y = p[1], z = p[2], K = KART;
  const throttle = st && st.throttle || 0, brake = st && st.brake || 0, pedalZ = st && st.pedalZ !== undefined ? st.pedalZ : K.pedal.zDefault;
  let best = Infinity, part = '';
  const take = (d, name) => { if (d < best) { best = d; part = name; } };

  // seat shell: pan + back + two side bolsters
  const S = K.seat, sh = S.thick / 2;
  const panC = [0, S.panTopY - sh, (SEAT.panZ0 + SEAT.panZ1) / 2], panH = (SEAT.panZ1 - SEAT.panZ0) / 2;
  let d = sdAABB(x, y, z, 0, panC[1], panC[2], S.halfW, sh, panH, 0.004);
  const bc = [0, SEAT.bottom[1] + SEAT.u[1] * S.backH / 2 - SEAT.nb[1] * sh, SEAT.bottom[2] + SEAT.u[2] * S.backH / 2 - SEAT.nb[2] * sh];
  d = Math.min(d, sdOBox(x, y, z, bc[0], bc[1], bc[2], AX, SEAT.u, SEAT.nb, S.halfW, S.backH / 2, sh, 0.004));
  const sideZ0 = SEAT.panZ0 + 0.03, sideZ1 = 0.40;
  for (const sx of [S.halfW + sh, -(S.halfW + sh)]) d = Math.min(d, sdAABB(x, y, z, sx, S.panTopY + S.sideH / 2, (sideZ0 + sideZ1) / 2, sh, S.sideH / 2, (sideZ1 - sideZ0) / 2, 0.003));
  take(d, 'seat');

  // steering wheel rim: torus about the column through wheelC
  const W = K.wheelC, ax = WHEEL_AXES.axis, vx = x - W[0], vy = y - W[1], vz = z - W[2];
  const along = vx * ax[0] + vy * ax[1] + vz * ax[2];
  const perp = Math.hypot(vx - ax[0] * along, vy - ax[1] * along, vz - ax[2] * along);
  take(Math.hypot(perp - K.rimR, along) - K.rimTube, 'rim');

  // column: a capsule from the hub along columnDir
  const L = K.column.length, t = clamp(along, 0, L);
  take(Math.hypot(vx - ax[0] * t, vy - ax[1] * t, vz - ax[2] * t) - K.column.radius, 'column');

  // pedal plates (oriented boxes)
  for (const which of ['throttle', 'brake']) {
    pedalPlate(which, which === 'throttle' ? throttle : brake, pedalZ, _pl);
    _eN[0] = 0; _eN[1] = _pl.n[1]; _eN[2] = _pl.n[2]; _eU[0] = 0; _eU[1] = _pl.u[1]; _eU[2] = _pl.u[2];
    take(sdOBox(x, y, z, _pl.c[0], _pl.c[1], _pl.c[2], AX, _eU, _eN, _pl.hx, _pl.hl, _pl.ht, 0.002), which === 'throttle' ? 'pedalThrottle' : 'pedalBrake');
  }

  // floor tray (top surface at trayY)
  take(sdAABB(x, y, z, 0, K.trayY - K.trayThick / 2, 0.55, 0.38, K.trayThick / 2, 0.60, 0.003), 'tray');

  // sidepods (both sides)
  const sp = K.sidepod, spc = [(sp.xIn + sp.xOut) / 2, (sp.yMin + sp.yMax) / 2, (sp.zMin + sp.zMax) / 2], sph = [(sp.xOut - sp.xIn) / 2, (sp.yMax - sp.yMin) / 2, (sp.zMax - sp.zMin) / 2];
  take(Math.min(sdAABB(x, y, z, spc[0], spc[1], spc[2], sph[0], sph[1], sph[2], 0.02), sdAABB(x, y, z, -spc[0], spc[1], spc[2], sph[0], sph[1], sph[2], 0.02)), 'sidepod');

  // engine block
  const e = K.engine.box;
  take(sdAABB(x, y, z, (e[0] + e[3]) / 2, (e[1] + e[4]) / 2, (e[2] + e[5]) / 2, (e[3] - e[0]) / 2, (e[4] - e[1]) / 2, (e[5] - e[2]) / 2, 0.01), 'engine');

  out.d = best; out.part = part;
  return out;
}
