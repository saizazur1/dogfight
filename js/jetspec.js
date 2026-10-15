// jetspec.js -- THE SHARED CONTRACT of the jet dogfight (?jet=1; JET_LANES.md section 1). Pure: no three.js, no DOM,
// runs in node. FROZEN once the coordinator merges it: a lane that needs a change writes a request in its report; the
// coordinator batches requests and the SPEC owner applies them between merges.
//
// CONTRACT v3 (2026-10-15; v2 kept in work/jetspec.v2.js). The owner wants the fight AMONG the snowy peaks; v2's floor
// (world y 1,300 = 5,800 m) was above all the ground within 8 km of its anchor, so no summit ever rose beside a jet.
//   1. THE PLACE MOVES ~14.8 km east and ~21.3 km south: WORLD_FRAME.anchor 36.2627 N 75.1483 E, DEM pixel [3723, 2189]
//      (was [3220, 1460]). The fight box keeps its size (x, z +-3 km about the anchor) and moves with it. Picked by SPEC
//      from a scan of ~6,700 centres (250 m apart, then 125 m) with the 100 real plans of jetplan.js (50 seeds x 2
//      orders) placed in each: the most jet samples with higher ground within 3-6 km, every jet sunlit (WORLD's shadow
//      test, jetplan.check.mjs sunMargin), the hidden spans inside the cuts >= 300 m over the DEM.
//   2. terrainMaxInBox 800 -> 1,607 (6,107 m: the DEM + the most WORLD's detailAt can add, on a 25 m grid; WORLD's own
//      stat reads the drawn ground, never higher) and planFloorY 1,300 -> 1,740 (6,240 m). The floor is now 133 m over
//      the box's highest ground, not 500: with jetplan's 25 m margin the lowest body sits >= 150 m over the real ground
//      anywhere in the box (jetplan.check.mjs measures every jet, missile, seat, man and canopy against it). Summits of up
//      to ~7,810 m (DEM) stand within 10 km, 200+ m over the fight on 25 of 36 bearings at 3.5-10 km; the cloud deck (unchanged) is 1,090 m below the floor.
//   3. FLARE (FX's request): tau 1.2 -> 0.45, eject 30 -> 40, burn 3.5 -> 2.5, so a flare sheds the jet's speed, droops
//      and fans out instead of trailing the jet for ~250 m only ~12 m lower.
//   4. The fixture is lifted with the floor (every fixture height + planFloorY - 1,300), so its shapes are v2's.
//   Nothing else moved: the sun (7 deg at 252), the cloud deck, the box's height range (world y 1,000-4,000: its bottom
//   now lies under the ground; planFloorY is the bound), the jet, the beats, the limits and the shapes are v2's.
//
// CONTRACT v2 (2026-10-14, approved by the coordinator on the PILOT lane's fit of all 8 real figures; v1 kept in
// work/jetspec.v1.js):
//   1. STICK.grip      [0, 0.62, 4.68] -> [0, 0.74, 4.46]  (v1 was out of every man's reach; PILOT's request,
//      jet-pilot.html?req=0.12,-0.22: all 8 fit with <= 9 deg of lean). The research's "0.32 m ahead of the hip, 0.25 m up"
//      (B3) is marked an estimate; the measured fit wins (it is ~13 cm closer). STICK.pivot becomes the VIRTUAL point
//      the grip turns about, 0.54 m straight below it (the v1 floor point would put a straight stick through the seat
//      pan); the travel is the research's +-8 cm fore-aft, +-6 cm side (B3), not MODEL's +-16 deg: STICK.maxDeg is now
//      { roll 6.3, pitch 8.4 }. MODEL draws a rigid bent stick from a floor boot ahead of the pan to the grip.
//   2. The seat's angles are two named numbers: SEAT.panDeg 8 (the front up; research B3) and SEAT.backDeg 20 (from
//      vertical; research B3 -- v1 had 18 for both, MODEL's whole-seat turn). The rails stay 15 deg back.
//   3. Every ANCHORS entry is a POSITION in jet space. An Object3D a lane exports for one carries NO rotation of its own
//      (identity in the jet group): no hidden seat angle on seatRef. The seat's angles live in SEAT and turn the seat
//      MESH only. The moving parts (stick, throttle, surfaces) move by the contract's helpers and channels.
//   4. ANCHORS.eye [0, 1.21, 4.02] -> [0, 1.31, 4.17]: the mean eye of the 8 fitted men with the seat at mid-rail
//      (measured by SPEC 2026-10-14 in jet-pilot.html with request 1; each man was 13.9-22.3 cm ahead of and 3.7-10.0 cm
//      above the v1 eye; their spread along the rail, -6.8 .. +5.7 cm, fits SEAT.adjust's +-7.5 cm).
//   5. CANOPY.topY 1.53 -> 1.62 (+ topZ 4.2): MODEL raised the bubble for the v2 eye; read from jetmodel.js (2026-10-14):
//      the profile cH peaks at 0.77 m over the sill (0.85) at z 4.2 (a pchip knot with lower neighbours, so the exact
//      maximum). It is the glass's outer surface; a nominal helmet top (eye + 0.16 m) now has ~15 cm under it.
//   Nothing else moved: the jet, the world, the plan's shapes, the beats and the fixture are v1's.
//
// WHERE THE NUMBERS CAME FROM. Four lanes started before this file, so v1 ADOPTS what they built rather than inventing
// a second answer: the jet's geometry and anchors are jetmodel.js's `JET` (MODEL lane, 2026-10-14; twin engines, twin
// fins canted 22 deg, a centre stick); the place, the datum, the sun and the fight box are jetworld.js's (WORLD lane:
// SITE, DATUM, SUN, FIGHT); the pilot's cues use jetpilot.js's names (six, fist, gaze); the beats are
// JET_DOGFIGHT_RESEARCH.md B1, the ejection times its A5 (Martin-Baker). A lane whose own copy disagrees with this file
// moves to this file (MODEL's `anchors` must equal ANCHORS within 1 cm; PILOT's stand-in JSEAT becomes SEAT below).
//
//   import { JET, ANCHORS, SEAT, STICK, THROTTLE, WORLD_FRAME, JET_BEATS, LIMITS, JET_CAMS,
//            makeJetFixture, sampleJetPlan, makeJetSample, poseMatrix, toWorld, flareAt } from './jetspec.js';
//
// ======================================================================================================
// 1. FRAMES, SIGNS AND UNITS  (read this once; every lane relies on it)
// ======================================================================================================
// Units: metres, seconds, radians, m/s, g = 9.81 m/s^2 (`G`). Angles in the data are RADIANS; `...Deg` names are
// degrees. No money, sales, customers, insignia, flags, serials, brands or personal data exist in this contract.
//
// WORLD FRAME (right-handed, y UP): x = EAST, z = SOUTH (north is -z), y = METRES ABOVE SEA LEVEL MINUS DATUM (4,500), so
//   world y 2,000 is 6,500 m above the sea. The origin is WORLD_FRAME.anchor (lat/lon). This is the climb's convention
//   (climbarena.js SUN: x east, z south) and jetworld.js's. The fight lives in WORLD_FRAME.fightBox; PLAN keeps every jet
//   at or above planFloorY (v3: 133 m over the box's highest ground, so >= 150 m with the plan's margin; 1,090 m over the
//   cloud deck's top).
//
// JET SPACE (the kart's): origin on the fuselage reference line at MID-LENGTH (the nose tip is z +8.5, the nozzle exits
//   z -8.5); +z FORWARD, +y UP, +x the PILOT'S LEFT (right-handed: x = y cross z). The figure GLBs face +z, so a seated
//   man needs no rotation. The pilot's right is -x. Rails and dispensers come in LEFT, RIGHT order (+x first).
//
// ORIENTATION: every body (jet, canopy, seat, pilot, chute) is a POSE { pos [3] world, q [x,y,z,w] }: q rotates its own
//   space into the world. q = identity points the nose SOUTH (+z), wings level. Plans store q as four channels and keep
//   consecutive samples in ONE hemisphere (dot > 0), so the sampler's normalised lerp is correct.
//   Readouts (derived from q, never used to build a matrix; stored UNWRAPPED so lerp is safe; a HUD wraps them):
//     heading  compass, clockwise from north: 0 = north (-z), +PI/2 = east (+x)
//     pitch    + = nose UP
//     bank     + = RIGHT wing DOWN (the kart's roll sign: + = the top tips toward the pilot's right)
//   q = qY(PI - heading) * qX(-pitch) * qZ(bank)  (quatFromEuler; eulerOf is its inverse for |pitch| < 90 deg).
//
// CONTROLS AND SURFACES (derived by the planner from the motion, so they always agree with it). The surface names and
//   signs are jetmodel.js setState's, so MODEL needs no adapter for them:
//   stickX  -1..1, + = stick top RIGHT (roll right)     stickY -1..1, + = stick AFT (pull, nose up)
//   pedal   -1..1, + = RIGHT pedal forward (nose right) throttle 0..1, >= AB_DETENT = afterburner
//   aileron   rad, + = roll RIGHT (left trailing edge down, right one up)
//   elevator  rad, + = pitch NOSE UP (both stabilators' trailing edges UP; MODEL adds the differential for roll)
//   rudderDef rad, + = yaw NOSE RIGHT (both rudders' trailing edges to the pilot's right)   [MODEL's setState `rudder`]
//   flap      rad, + = trailing edge DOWN           lef rad, + = leading-edge droop
//   brake 0..1 the dorsal speed brake (0 -> 45 deg)  nozzle 0..1 (1 = open, afterburner)  ab 0..1 afterburner flame
//   vapour 0..1 wing condensation (high G)  nz load factor in g (+ = pressed into the seat)  ny side g
//   aoa rad (+ = nose above the flight path)        rollRate rad/s (+ = rolling right)
//
// THE PILOT (jetpilot.js reads these): headYaw rad, + = LEFT; headPitch rad, + = UP (relative to the jet's axes; PILOT
//   splits them over the back, neck and eyes); gaze [x,y,z] WORLD (where he looks: usually the other jet); six -1..1
//   (checking six: + = over his LEFT shoulder); strain 0..1 (the anti-G straining face); shake 0..1 (buffet, damage);
//   fist 0..1 (the winner's fist pump). In the ejection: tuck, hang, thumb (EjectState).
//
// THE LANDING GEAR IS ALWAYS UP (no channel). The canopy, the seat and the man leave the LOSER's jet only.
//
// ======================================================================================================
// 2. TIME BASE  (the kart's, imported: one implementation for both scenes)
// ======================================================================================================
// RACE clock (tRace: the planner's arrays at DT = 1/120) and SCREEN clock (tScreen: ?t=, cameras, HUD, sound). They
// differ only across a CUT in `screenMap` (kartspec.js section 2 explains the knots). The research doc compresses the
// fight "by the cut, not by speeding anything up", so expect cuts in the real plan; every reader converts through
// raceTime()/screenTime(), and a jump check skips cutsOf(M). Event times are on the RACE clock; JET_BEATS on the SCREEN.
//
// ======================================================================================================
// 3. SHAPES (JSDoc typedefs; samples are plain objects, allocation-free when `out` is passed)
// ======================================================================================================
/**
 * @typedef {Object} JetPlan   (Float32Array channels, one array of length n per channel)
 * @property {number} seed
 * @property {number[]} order     [winner, loser] jet indexes. order[0] WINS (an INPUT, never a result).
 * @property {string[]} pilots    2 roster ids; pilots[k] flies jet k (jet k wears LANE_COLORS[k]; MODEL's `side` = k)
 * @property {number} dt  @property {number} n  @property {number} duration  @property {number} screenDuration
 * @property {number[][]} screenMap
 * @property {{t:number, kind:string, jet:number, other?:number, missile?:number, marker?:boolean}[]} events  sorted by
 *           t (RACE clock); kinds = BEAT_KINDS; jet -1 = both/global. marker: true = a label with no physics behind it.
 * @property {Object<string, Float32Array[]>} ch   ch[name][jet], names = JET_CHANNELS
 * @property {MissilePlan[]} missiles
 * @property {FlarePlan[]} flares
 * @property {EjectPlan} eject
 *
 * @typedef {Object} MissilePlan  { id, shooter, target, rail (0..3, ANCHORS.missileRails), tLaunch, tEnd, tBurnout,
 *           outcome: 'decoyed'|'hit', burst [3] WORLD (where it bursts at tEnd), ch: { x,y,z,vx,vy,vz,motor } }
 *           The arrays cover the WHOLE plan: before tLaunch they ride the shooter's rail, after tEnd they hold still.
 * @typedef {Object} FlarePlan    { id, jet, dispenser (0 left | 1 right), tEject, p0 [3], v0 [3] }   closed form: flareAt()
 * @typedef {Object} EjectPlan    { jet (the loser), tCanopy, tSeat, tSep, tChute, tKit, ch: EJECT_CHANNELS } arrays for
 *           the whole plan (before each event they ride the jet), so a trail or a seek never needs history.
 *
 * @typedef {Object} Pose { pos: number[3], q: number[4] }
 * @typedef {Object} JetState  one jet at one instant (WORLD)
 *   pos, q, vel [3]; v, heading, pitch, bank, aoa, nz, ny, rollRate; stickX, stickY, pedal, throttle, ab;
 *   aileron, elevator, rudderDef, flap, lef, brake, nozzle, vapour; headYaw, headPitch, gaze [3], six, strain, shake,
 *   fist; damage (0|1 step), fire 0..1, smoke 0..1, canopy (0 on | 1 gone, step); rails [4] (1 = a missile still on it);
 *   seatPose, pilotPose, canopyPose: Pose (WORLD).
 *     seatPose   the seat's frame: origin SEAT.ref (the SRP), the jet's axes while installed;
 *     pilotPose  the frame the man's ROOT hangs under with no rotation: = seatPose until the man leaves the seat, then
 *                his harness frame (origin at SEAT.ref's place on him, +y up the risers);
 *     canopyPose origin ANCHORS.canopyHinge, the jet's axes while closed.
 *   All three are for seatAdjust = 0: a rig adds its fit along SEAT.rail in its own frame.
 * @typedef {Object} MissileState { id, shooter, target, state (0 rail | 1 flying | 2 gone), pos, vel, motor 0..1,
 *           age (s since launch, < 0 before), outcome }
 * @typedef {Object} FlareState   { id, jet, pos, vel, burn 0..1 (light), alive (bool), age }
 * @typedef {Object} EjectState   { jet, phase (EJECT_PHASE), chute 0..1 (inflation), rocket 0..1, tuck 0..1 (the
 *           ejection posture: head back, elbows in, hands on the handle), hang 0..1 (hands up on the risers, legs
 *           together), thumb 0..1 (the thumbs-up), kit 0..1 (the survival kit lowered on its lanyard),
 *           chutePose: Pose (the canopy's crown frame: origin at the riser confluence, +y up the canopy's axis) }
 * @typedef {Object} JetSample    { tScreen, tRace, jets: [2] JetState, missiles: MissileState[], flares: FlareState[], eject: EjectState }
 */

import { raceTime, screenTime, cutsOf } from './kartspec.js';
export { raceTime, screenTime, cutsOf };

export const CONTRACT = 'jetspec v2 (2026-10-14)';
export const G = 9.81;
export const DT = 1 / 120;
export const JET_COUNT = 2;
export const AB_DETENT = 0.85;
export const LANE_COLORS = ['#c8362c', '#2b62cf'];          // red, blue (climbarena.js 0..1): fin-tip bands and the helmet only
const D2R = Math.PI / 180;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
// C2 (smootherstep): a jump in a path's 2nd derivative jumps its lift vector, so its bank, in one sample
const s2 = (a, b, x) => { const u = clamp((x - a) / (b - a), 0, 1); return u * u * u * (u * (6 * u - 15) + 10); };
const deepFreeze = (o) => { Object.values(o).forEach((v) => { if (v && typeof v === 'object' && !Object.isFrozen(v)) deepFreeze(v); }); return Object.freeze(o); };
const norm3 = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };

// ======================================================================================================
// 4. THE WORLD  (jetworld.js's numbers; PLAN keeps every jet inside the box and above the floor)
// ======================================================================================================
const SUN_EL = 7 * D2R, SUN_AZ = 252 * D2R;                 // mid-October, ~25 min before sunset at 36.5 N (WORLD)
export const WORLD_FRAME = deepFreeze({
  anchor: { lat: 36.2627, lon: 75.1483, demPx: [3723, 2189] }, // v3: among the peaks SE of the v2 site [3220, 1460] (SPEC's scan)
  datum: 4500,                                               // world y 0 = 4,500 m above the sea
  dem: 'assets/climb/hunza_cop30_n36e074.png',               // its credit line (the .json) goes on screen when it is used
  fightBox: { x: [-3000, 3000], z: [-3000, 3000], y: [1000, 4000] },
  terrainMaxInBox: 1607,                                     // world y (6,107 m): DEM + detailAt's max, 25 m grid (SPEC, v3)
  cloudDeck: { base: 200, top: 650 },                        // the cloud sea under the fight (world y)
  planFloorY: 1740,                                          // v3: no jet, seat or man below this (6,240 m; summits to ~7,810 m around)
  sun: { elevDeg: 7, azDeg: 252, dir: [Math.sin(SUN_AZ) * Math.cos(SUN_EL), Math.sin(SUN_EL), -Math.cos(SUN_AZ) * Math.cos(SUN_EL)] },
  logDepth: true,                                            // GLUE creates the renderer with logarithmicDepthBuffer in jet mode
});
/** lat/lon (degrees) -> world [x, 0, z] (the climb's flat map: 111,320 cos(lat0) m/deg east, 110,574 m/deg north). WORLD
 *  draws the earth's curve on top (h - d^2 * 0.87 / 2R): under 1 m inside the fight box. */
export function latLonToWorld(lat, lon, out = [0, 0, 0]) {
  const a = WORLD_FRAME.anchor;
  out[0] = (lon - a.lon) * 111320 * Math.cos(a.lat * D2R); out[1] = 0; out[2] = -(lat - a.lat) * 110574;
  return out;
}

// ======================================================================================================
// 5. THE JET  (jetmodel.js JET: a generic twin-engine, twin-fin, single-seat fighter; no real type, no markings)
// ======================================================================================================
export const JET = deepFreeze({
  length: 17.0, span: 12.0, noseZ: 8.5, tailZ: -8.5,        // span = the tip missiles' outer edge
  box: { x: [-6.1, 6.1], y: [-1.0, 2.9], z: [-8.6, 8.6] },  // gear up, stores on: the hull's bounds (no camera lens inside)
  finCantDeg: 22,
  finTips: [[1.78, 2.74, -5.6], [-1.78, 2.74, -5.6]],       // the fins' tip leading edges (the seat must clear them)
  wingtips: [[5.85, -0.08, -3.1], [-5.85, -0.08, -3.1]],    // leading edge at the tip: vortex / vapour trails
  limits: { aileron: 25 * D2R, elevator: 25 * D2R, rudderDef: 30 * D2R, flap: 35 * D2R, lef: 25 * D2R, brakeDeg: 45 },
  triangles: [30000, 70000],                                // the budget per jet (close-ups through the canopy)
});

// The seat. SEAT.ref is the SRP (where the pan meets the back, on the centre line): the seat frame's origin.
const SRP = [0, 0.45, 4.15];
const BACK = 20 * D2R, PAN = 8 * D2R;
const SU = norm3([0, 0.92, -0.25]);                          // the seat rails (jetmodel.js 'seat-rails': 15 deg back)
export const SEAT = deepFreeze({
  ref: SRP,                                                  // the SRP: the pan's top line meets the back's surface line (centre line)
  panDeg: 8, backDeg: 20,                                    // the pan's front up from horizontal; the back reclined from vertical
  panDir: [0, Math.sin(PAN), Math.cos(PAN)], panLen: 0.44,   // along the pan's top, forward from the SRP
  backUp: [0, Math.cos(BACK), -Math.sin(BACK)], backNormal: [0, Math.sin(BACK), Math.cos(BACK)],
  rail: SU,                                                  // seat up the rails = the ejection direction, jet space
  adjust: [-0.075, 0.075],                                   // seat height along the rail, per man: PILOT fits his eye to ANCHORS.eye
  // SEAT frame: the yellow-and-black firing loop's TOP (where both hands close on it), at the pan's front between the thighs.
  // r8 (MODEL's request, 2026-10-15): was [0, 0.035, 0.43], which r6's mesh did not match (its top sat 3.5 cm higher) and where
  // the stick's shaft cut through the loop for every seat at mid-rail or higher. Now 8 cm back with the ring leaning 37 deg toward
  // the man (ejectLoop): clear of the shaft by >= 10 mm over the whole rail and every stick corner (jetspec.check.mjs).
  ejectHandle: [0, 0.057, 0.311],
  ejectLoop: { R: 0.065, r: 0.014, tiltDeg: 37 },            // the half ring's radius and tube; its plane leans back from upright
  pedals: { x: 0.12, y: 0.2, z: 5.25, travel: 0.04 },        // jet space; + pedal moves the RIGHT one forward
});
// The centre stick's grip turns about a VIRTUAL pivot 0.54 m straight below it (v2): +-8 cm fore-aft, +-6 cm side at the
// grip (research B3). The throttle slides along +z on the left console.
export const STICK = deepFreeze({ pivot: [0, 0.20, 4.46], grip: [0, 0.74, 4.46], r: 0.016, maxDeg: { roll: Math.atan2(0.06, 0.54) / D2R, pitch: Math.atan2(0.08, 0.54) / D2R }, travel: { side: 0.06, fore: 0.08 } });
export const THROTTLE = deepFreeze({ grip0: [0.33, 0.66, 4.245], travel: 0.11, r: 0.019 });                  // throttle 0 -> grip0, 1 -> +0.11 z
export const CANOPY = deepFreeze({ sill: 0.85, z: [2.95, 5.0], windscreenZ: [5.0, 5.62], topY: 1.62, topZ: 4.2, hinge: [0, 0.88, 2.95], helmetClear: 0.05 });
const add3 = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];

/** The named points every lane uses: POSITIONS in jet space, nothing else (v2). MODEL's exported `anchors` (Object3Ds) sit
 *  here within 1 cm with NO rotation of their own relative to the jet group. */
export const ANCHORS = deepFreeze({
  seatRef: SRP,
  eye: [0, 1.31, 4.17],                                      // the design eye (v2: the 8 fitted men's mean, seat at mid-rail)
  stick: STICK.grip,                                         // grip centre, neutral
  throttle: add3(THROTTLE.grip0, [0, 0, THROTTLE.travel / 2]),   // grip centre at throttle 0.5
  canopyHinge: CANOPY.hinge,
  canopyRail: [0, CANOPY.sill, (CANOPY.z[0] + CANOPY.z[1]) / 2],  // MODEL's single sill point; the rail runs z 2.95..5.0 at y 0.85
  nozzles: [[0.6, -0.08, -8.5], [-0.6, -0.08, -8.5]],        // exit-plane centres; the flame goes -z
  nozzle: [0, -0.08, -8.5],
  nozzleR: { dry: 0.40, ab: 0.47 },                          // estimate (petals open ~35 % in area); MODEL's mesh is the truth
  missileRails: [[5.97, -0.08, -2.0], [3.25, -0.57, -2.12], [-3.25, -0.57, -2.12], [-5.97, -0.08, -2.0]],   // 0 tipL, 1 pylL, 2 pylR, 3 tipR
  flareDispensers: [{ p: [0.82, -0.5, -6.1], dir: norm3([0.34, -0.94, 0]) }, { p: [-0.82, -0.5, -6.1], dir: norm3([-0.34, -0.94, 0]) }],
  tailHitPoint: [0.95, 0.55, -6.3],                          // the burst lands and the fire burns here (left engine bay, fin root)
  wingtipL: JET.wingtips[0], wingtipR: JET.wingtips[1],
});
export const RAIL_NAMES = Object.freeze(['tipL', 'pylL', 'pylR', 'tipR']);
export const RAIL_KIND = Object.freeze(['short', 'medium', 'medium', 'short']);   // v1 plans fire from the tip rails only

export const MISSILE = deepFreeze({ length: 3.0, diameter: 0.13, burn: 2.5, fuse: 9.0, maxSpeed: 1100, trailLife: 20 });
// v3 (FX's request): tau 1.2 -> 0.45, eject 30 -> 40, burn 3.5 -> 2.5. With tau 1.2 a flare kept the jet's speed and
// ended ~250 m behind and only ~12 m lower; now it sheds the jet's speed in ~1 s and droops and fans out (research A3).
export const FLARE = deepFreeze({ eject: 40, tau: 0.45, ignite: 0.08, burn: 2.5, fade: 0.6, salvo: 8, gap: 0.12 });
// Martin-Baker's sequence, seconds from the canopy's jettison (research A5)
export const EJECT_TIMING = deepFreeze({ canopy: 0.0, rails: 0.1, rocketOut: 0.5, drogue: 0.7, main: 1.0, sep: 1.5, full: 2.0, kit: 2.5 });
export const CHUTE = deepFreeze({ diameter: 8.5, riser: 6.5, descent: 7.0, swingDeg: 12, swingHz: 0.3, swingDecay: 3.0, colours: ['#e8641e', '#f2f0ea'] });

// ======================================================================================================
// 6. CHANNELS, BEATS, LIMITS, CAMERAS
// ======================================================================================================
export const JET_CHANNELS = Object.freeze([
  'x', 'y', 'z', 'qx', 'qy', 'qz', 'qw', 'vx', 'vy', 'vz', 'v', 'heading', 'pitch', 'bank', 'aoa', 'nz', 'ny', 'rollRate',
  'stickX', 'stickY', 'pedal', 'throttle', 'ab', 'aileron', 'elevator', 'rudderDef', 'flap', 'lef', 'brake', 'nozzle',
  'vapour', 'headYaw', 'headPitch', 'gx', 'gy', 'gz', 'six', 'strain', 'shake', 'fist', 'damage', 'fire', 'smoke', 'canopy',
]);
export const STEP_CHANNELS = Object.freeze(['damage', 'canopy']);
export const MISSILE_CHANNELS = Object.freeze(['x', 'y', 'z', 'vx', 'vy', 'vz', 'motor']);
const POSE7 = (p) => [`${p}x`, `${p}y`, `${p}z`, `${p}qx`, `${p}qy`, `${p}qz`, `${p}qw`];
/** c = canopy, s = seat, p = pilot (root frame), k = chute crown */
export const EJECT_CHANNELS = Object.freeze([...POSE7('c'), ...POSE7('s'), ...POSE7('p'), ...POSE7('k'), 'chute', 'rocket', 'tuck', 'hang', 'thumb', 'kit']);
export const EJECT_PHASE = Object.freeze({ none: 0, canopyGone: 1, rails: 2, seatFree: 3, separated: 4, chuteOpen: 5 });

/** The beats (research doc B1), in story order. `who`: 'W' = order[0] (the winner), 'L' = order[1] (the loser), '-' =
 *  both. `t` is the target on the SCREEN clock and `tol` the miss PLAN may have. The research beat sheet may retune `t`
 *  through a change request; the KINDS, their ORDER and `who` are the contract. (Research calls the loser "A" and the
 *  winner "B"; this file says L and W so nobody has to remember that.) */
export const JET_BEATS = deepFreeze([
  { kind: 'open', who: '-', t: 0.0, tol: 0 },               // the ridge, long lens: the loser rips past, names
  { kind: 'merge', who: '-', t: 4.9, tol: 0.4 },            // head-on, afterburners lit, 120-200 m apart
  { kind: 'checkSix', who: 'W', t: 6.0, tol: 0.5 },         // the winner looks back BEFORE the pull
  { kind: 'tone', who: 'L', t: 10.4, tol: 0.5 },            // growl, then the lock tone
  { kind: 'launch', who: 'L', t: 11.4, tol: 0.4, missile: 0 },
  { kind: 'break', who: 'W', t: 12.6, tol: 0.3 },           // max G, vapour, strain
  { kind: 'flares', who: 'W', t: 12.8, tol: 0.3 },          // two salvos (the second ~0.7 s later)
  { kind: 'nearMiss', who: 'W', t: 14.4, tol: 0.5, missile: 0 },   // passes ~30 m behind the tail, pops in the flares
  { kind: 'pullUp', who: 'W', t: 15.6, tol: 0.5 },          // speed brake, 1.2 s high-AoA pull (nose ~28 deg up)
  { kind: 'overshoot', who: 'L', t: 16.8, tol: 0.6 },       // the loser slides past the winner's tail
  { kind: 'reversed', who: 'W', t: 18.6, tol: 0.6 },        // the winner rolls in behind, afterburner
  { kind: 'tone', who: 'W', t: 20.4, tol: 0.5 },
  { kind: 'launch', who: 'W', t: 21.2, tol: 0.4, missile: 1 },
  { kind: 'break', who: 'L', t: 22.4, tol: 0.4 },
  { kind: 'flares', who: 'L', t: 22.6, tol: 0.4 },          // one late salvo
  { kind: 'hit', who: 'L', t: 23.8, tol: 0.4, missile: 1 }, // proximity burst beside the tail: flash, smoke, flame
  { kind: 'canopyOff', who: 'L', t: 24.6, tol: 0.5 },       // EJECT_TIMING from here
  { kind: 'eject', who: 'L', t: 24.7, tol: 0.5 },
  { kind: 'seatSep', who: 'L', t: 26.1, tol: 0.5 },
  { kind: 'chuteOpen', who: 'L', t: 26.6, tol: 0.5 },       // full: the HUD may say he is safe
  { kind: 'kit', who: 'L', t: 27.1, tol: 0.5 },
  { kind: 'thumbsUp', who: 'L', t: 27.8, tol: 0.6 },
  { kind: 'wingRock', who: 'W', t: 28.4, tol: 0.6 },        // a respectful pass 300-500 m from the chute
  { kind: 'roll', who: 'W', t: 28.9, tol: 0.6 },            // the victory roll, 360 deg in ~2 s, against the sun
  { kind: 'rollDone', who: 'W', t: 30.8, tol: 0.6 },
  { kind: 'end', who: '-', t: 31.2, tol: 1.5 },
]);
export const BEAT_KINDS = Object.freeze([...new Set(JET_BEATS.map((b) => b.kind))]);

/** What every real plan must obey (PLAN's check and GLUE's ?jetcheck=1). `tol` is rounding, not leniency. */
export const LIMITS = deepFreeze({
  vMin: 110, vMax: 300, nzMin: -3, nzMax: 9, gOnset: 8,     // g per second
  rollRateDeg: 280, aoaDeg: 30, minSepM: 120,               // the jets never closer than this (the merge is 120-200 m)
  missPass: [15, 40], seatFinClear: 2.0, chuteDescent: [5, 9],
  missileMaxSpeed: MISSILE.maxSpeed, jumpTol: 0.05,         // off a cut, a body moves at most |v| * dt + jumpTol per step
  tol: 1e-4,
});

/** Camera keys (research B5). DIRECT owns the lenses and may ADD keys; these names are frozen for GLUE's buttons. */
export const JET_CAMS = Object.freeze(['ridge', 'faceW', 'faceL', 'shoulder', 'merge', 'airframe', 'wing', 'chase', 'sideWide', 'missile', 'eject', 'chute', 'victory', 'faces']);
/** A shot (screen clock): { t0, t1, cam, subject (jet or -1), partner?, missile?, insets? [jet] } -- planJetShots(M). */

// ======================================================================================================
// 7. SMALL PURE HELPERS  (ONE copy for everybody)
// ======================================================================================================
export function qMul(a, b, out = [0, 0, 0, 1]) {
  const ax = a[0], ay = a[1], az = a[2], aw = a[3], bx = b[0], by = b[1], bz = b[2], bw = b[3];
  out[0] = aw * bx + ax * bw + ay * bz - az * by; out[1] = aw * by - ax * bz + ay * bw + az * bx;
  out[2] = aw * bz + ax * by - ay * bx + az * bw; out[3] = aw * bw - ax * bx - ay * by - az * bz;
  return out;
}
export function qAxis(ax, a, out = [0, 0, 0, 1]) { const s = Math.sin(a / 2); out[0] = ax[0] * s; out[1] = ax[1] * s; out[2] = ax[2] * s; out[3] = Math.cos(a / 2); return out; }
/** rotate v by unit q */
export function qRot(q, v, out = [0, 0, 0]) {
  const x = q[0], y = q[1], z = q[2], w = q[3], vx = v[0], vy = v[1], vz = v[2];
  const tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx);
  out[0] = vx + w * tx + y * tz - z * ty; out[1] = vy + w * ty + z * tx - x * tz; out[2] = vz + w * tz + x * ty - y * tx;
  return out;
}
export function qNorm(q) { const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1; q[0] /= l; q[1] /= l; q[2] /= l; q[3] /= l; return q; }
/** the quaternion whose columns are left (+x), up (+y), fwd (+z) -- unit and orthogonal */
export function quatFromBasis(l, u, f, out = [0, 0, 0, 1]) {
  const m00 = l[0], m01 = u[0], m02 = f[0], m10 = l[1], m11 = u[1], m12 = f[1], m20 = l[2], m21 = u[2], m22 = f[2], tr = m00 + m11 + m22;
  if (tr > 0) { const s = 0.5 / Math.sqrt(tr + 1); out[3] = 0.25 / s; out[0] = (m21 - m12) * s; out[1] = (m02 - m20) * s; out[2] = (m10 - m01) * s; }
  else if (m00 > m11 && m00 > m22) { const s = 2 * Math.sqrt(1 + m00 - m11 - m22); out[3] = (m21 - m12) / s; out[0] = 0.25 * s; out[1] = (m01 + m10) / s; out[2] = (m02 + m20) / s; }
  else if (m11 > m22) { const s = 2 * Math.sqrt(1 + m11 - m00 - m22); out[3] = (m02 - m20) / s; out[0] = (m01 + m10) / s; out[1] = 0.25 * s; out[2] = (m12 + m21) / s; }
  else { const s = 2 * Math.sqrt(1 + m22 - m00 - m11); out[3] = (m10 - m01) / s; out[0] = (m02 + m20) / s; out[1] = (m12 + m21) / s; out[2] = 0.25 * s; }
  return qNorm(out);
}
const AXX = [1, 0, 0], AXY = [0, 1, 0], AXZ = [0, 0, 1];
/** heading (clockwise from north), pitch (+ nose up), bank (+ right wing down) -> q (section 1) */
export function quatFromEuler(heading, pitch, bank, out = [0, 0, 0, 1]) {
  const a = qAxis(AXY, Math.PI - heading), b = qAxis(AXX, -pitch), c = qAxis(AXZ, bank);
  return qMul(qMul(a, b, out), c, out);
}
/** q -> { heading (0..2PI, wrapped), pitch, bank } */
export function eulerOf(q, out = { heading: 0, pitch: 0, bank: 0 }) {
  const f = qRot(q, AXZ), u = qRot(q, AXY), l = qRot(q, AXX);
  out.heading = (Math.atan2(f[0], -f[2]) + 2 * Math.PI) % (2 * Math.PI);
  out.pitch = Math.asin(clamp(f[1], -1, 1));
  out.bank = Math.atan2(l[1], u[1]);
  return out;
}
/** world matrix (column-major, three.js Matrix4.elements) of a pose */
export function poseMatrix(pos, q, out = new Array(16)) {
  const x = q[0], y = q[1], z = q[2], w = q[3], x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2, wx = w * x2, wy = w * y2, wz = w * z2;
  out[0] = 1 - (yy + zz); out[1] = xy + wz; out[2] = xz - wy; out[3] = 0;
  out[4] = xy - wz; out[5] = 1 - (xx + zz); out[6] = yz + wx; out[7] = 0;
  out[8] = xz + wy; out[9] = yz - wx; out[10] = 1 - (xx + yy); out[11] = 0;
  out[12] = pos[0]; out[13] = pos[1]; out[14] = pos[2]; out[15] = 1;
  return out;
}
/** a body-space point -> world, for a pose { pos, q } (a JetState is a pose) */
export function toWorld(pose, p, out = [0, 0, 0]) { qRot(pose.q, p, out); out[0] += pose.pos[0]; out[1] += pose.pos[1]; out[2] += pose.pos[2]; return out; }

/** the centre stick's grip in JET space: the grip turns about STICK.pivot exactly as a three.js group at the pivot with
 *  `rotation.set(-stickY * pitch, 0, stickX * roll)` (Euler XYZ; roll, pitch = STICK.maxDeg): + stickX tips the top RIGHT
 *  (-x), + stickY AFT (-z). Returns { c (grip centre), axis (unit, pivot -> grip) }. */
export function stickGrip(stickX, stickY, out = { c: [0, 0, 0], axis: [0, 0, 0] }) {
  const ax = stickX * STICK.maxDeg.roll * D2R, ay = stickY * STICK.maxDeg.pitch * D2R, L = STICK.grip[1] - STICK.pivot[1];
  const d = [-Math.sin(ax), Math.cos(ax) * Math.cos(ay), -Math.cos(ax) * Math.sin(ay)];
  for (let i = 0; i < 3; i++) { out.axis[i] = d[i]; out.c[i] = STICK.pivot[i] + d[i] * L; }
  return out;
}
/** the throttle grip centre in JET space (it slides forward along +z with throttle 0..1) */
export function throttleGrip(throttle, out = [0, 0, 0]) {
  out[0] = THROTTLE.grip0[0]; out[1] = THROTTLE.grip0[1]; out[2] = THROTTLE.grip0[2] + THROTTLE.travel * clamp(throttle, 0, 1);
  return out;
}
/** a jet-space point -> the SEAT frame (origin SEAT.ref, the jet's axes; valid while the seat is installed) */
export const jetToSeat = (p, out = [0, 0, 0]) => { out[0] = p[0] - SRP[0]; out[1] = p[1] - SRP[1]; out[2] = p[2] - SRP[2]; return out; };

/** a flare at race time t, closed form (linear drag tau + gravity, no wind): { pos, vel, burn 0..1, alive, age } */
export function flareAt(f, tRace, out = { pos: [0, 0, 0], vel: [0, 0, 0], burn: 0, alive: false, age: 0 }) {
  const a = tRace - f.tEject, F = FLARE;
  out.age = a; out.alive = a >= 0 && a < F.burn + F.fade;
  const tt = Math.max(0, a), e = Math.exp(-tt / F.tau), vT = -G * F.tau;
  out.pos[0] = f.p0[0] + f.v0[0] * F.tau * (1 - e); out.vel[0] = f.v0[0] * e;
  out.pos[2] = f.p0[2] + f.v0[2] * F.tau * (1 - e); out.vel[2] = f.v0[2] * e;
  out.pos[1] = f.p0[1] + vT * tt + (f.v0[1] - vT) * F.tau * (1 - e); out.vel[1] = vT + (f.v0[1] - vT) * e;
  out.burn = a < 0 ? 0 : a < F.ignite ? a / F.ignite : a < F.burn ? 1 : clamp(1 - (a - F.burn) / F.fade, 0, 1);
  return out;
}

// ======================================================================================================
// 8. THE SAMPLER  (THE only one: the real plan and the fixture are sampled by this, so they cannot differ)
// ======================================================================================================
const pose = () => ({ pos: [0, 0, 0], q: [0, 0, 0, 1] });
const VEC_KEYS = /^(x|y|z|q[xyzw]|v[xyz]|g[xyz])$/;
const jetState = () => {
  const s = { pos: [0, 0, 0], q: [0, 0, 0, 1], vel: [0, 0, 0], gaze: [0, 0, 0], rails: [1, 1, 1, 1], seatPose: pose(), pilotPose: pose(), canopyPose: pose() };
  for (const k of JET_CHANNELS) if (!VEC_KEYS.test(k)) s[k] = 0;
  return s;
};
/** a blank JetSample shaped for plan M (the missile and flare counts come from M) */
export function makeJetSample(M) {
  return {
    tScreen: 0, tRace: 0, jets: [jetState(), jetState()],
    missiles: M.missiles.map((m) => ({ id: m.id, shooter: m.shooter, target: m.target, state: 0, pos: [0, 0, 0], vel: [0, 0, 0], motor: 0, age: 0, outcome: m.outcome })),
    flares: M.flares.map((f) => ({ id: f.id, jet: f.jet, pos: [0, 0, 0], vel: [0, 0, 0], burn: 0, alive: false, age: 0 })),
    eject: { jet: M.eject.jet, phase: 0, chute: 0, rocket: 0, tuck: 0, hang: 0, thumb: 0, kit: 0, chutePose: pose() },
  };
}
function readPose(ch, pre, i0, i1, u, P) {
  const g = (n) => { const a = ch[n]; return a[i0] + (a[i1] - a[i0]) * u; };
  P.pos[0] = g(pre + 'x'); P.pos[1] = g(pre + 'y'); P.pos[2] = g(pre + 'z');
  P.q[0] = g(pre + 'qx'); P.q[1] = g(pre + 'qy'); P.q[2] = g(pre + 'qz'); P.q[3] = g(pre + 'qw'); qNorm(P.q);
}
/** THE sampler: plan + SCREEN time -> JetSample. Pure in t; allocation-free when `out` is passed. */
export function sampleJetPlan(M, tScreen, out = makeJetSample(M)) {
  const tr = clamp(raceTime(M, tScreen), 0, M.duration);
  const f = tr / M.dt, i0 = Math.min(M.n - 2, Math.floor(f + 1e-9)), u = clamp(f - i0, 0, 1), i1 = i0 + 1;
  out.tScreen = tScreen; out.tRace = tr;
  const ch = M.ch, E = M.eject;
  for (let k = 0; k < JET_COUNT; k++) {
    const s = out.jets[k];
    for (const n of JET_CHANNELS) {
      const a = ch[n][k];
      const v = STEP_CHANNELS.includes(n) ? a[u >= 1 ? i1 : i0] : a[i0] + (a[i1] - a[i0]) * u;
      switch (n) {
        case 'x': s.pos[0] = v; break; case 'y': s.pos[1] = v; break; case 'z': s.pos[2] = v; break;
        case 'qx': s.q[0] = v; break; case 'qy': s.q[1] = v; break; case 'qz': s.q[2] = v; break; case 'qw': s.q[3] = v; break;
        case 'vx': s.vel[0] = v; break; case 'vy': s.vel[1] = v; break; case 'vz': s.vel[2] = v; break;
        case 'gx': s.gaze[0] = v; break; case 'gy': s.gaze[1] = v; break; case 'gz': s.gaze[2] = v; break;
        default: s[n] = v;
      }
    }
    qNorm(s.q);
    for (let r = 0; r < 4; r++) s.rails[r] = 1;
    for (const m of M.missiles) if (m.shooter === k && tr >= m.tLaunch) s.rails[m.rail] = 0;
    if (k === E.jet) { readPose(E.ch, 'c', i0, i1, u, s.canopyPose); readPose(E.ch, 's', i0, i1, u, s.seatPose); readPose(E.ch, 'p', i0, i1, u, s.pilotPose); }
    else for (const [P, local] of [[s.seatPose, SRP], [s.pilotPose, SRP], [s.canopyPose, CANOPY.hinge]]) { toWorld(s, local, P.pos); for (let i = 0; i < 4; i++) P.q[i] = s.q[i]; }
  }
  M.missiles.forEach((m, i) => {
    const o = out.missiles[i], c = m.ch, g = (n) => c[n][i0] + (c[n][i1] - c[n][i0]) * u;
    o.pos[0] = g('x'); o.pos[1] = g('y'); o.pos[2] = g('z'); o.vel[0] = g('vx'); o.vel[1] = g('vy'); o.vel[2] = g('vz');
    o.motor = g('motor'); o.age = tr - m.tLaunch; o.state = tr < m.tLaunch ? 0 : tr < m.tEnd ? 1 : 2;
  });
  M.flares.forEach((fl, i) => flareAt(fl, tr, out.flares[i]));
  const e = out.eject, g = (n) => E.ch[n][i0] + (E.ch[n][i1] - E.ch[n][i0]) * u;
  e.chute = g('chute'); e.rocket = g('rocket'); e.tuck = g('tuck'); e.hang = g('hang'); e.thumb = g('thumb'); e.kit = g('kit');
  e.phase = tr >= E.tChute ? 5 : tr >= E.tSep ? 4 : tr >= E.tSeat + 0.4 ? 3 : tr >= E.tSeat ? 2 : tr >= E.tCanopy ? 1 : 0;
  readPose(E.ch, 'k', i0, i1, u, e.chutePose);
  return out;
}

// ======================================================================================================
// 9. THE LANE INTERFACES  (typedefs only: each lane implements its own; names are what the lanes already export)
// ======================================================================================================
/**
 * MODEL (jetmodel.js):  buildJet(side, { color }) -> { group (jet space; GLUE: matrix = poseMatrix(state.pos, state.q)),
 *   anchors (Object3Ds at ANCHORS, within 1 cm, no rotation of their own -- v2), canopy, seat (its origin at SEAT.ref
 *   with the jet's axes; the mesh under it carries SEAT.panDeg / backDeg) (Object3Ds GLUE re-parents to the scene at canopyOff /
 *   eject and then places from state.canopyPose / state.seatPose every frame), setState(state, fit?) (surfaces, stick
 *   = stickGrip, throttle = throttleGrip, pedals, nozzles, afterburner, brake, rails [4], damage/fire -> tailDamage,
 *   canopy; fit = { seatAdjust } from PILOT; allocation-free), buildMissile(kind), triangles }.
 *   No tail number, serial, roundel or text on the airframe (owner: no insignia; research B4). Fin-tip bands in
 *   LANE_COLORS[side] are the only identity (the pilot's first name under the rail waits on the owner).
 * PILOT (jetpilot.js):  buildJetPilots(scene, figures [2], seats [2], opts) -> { fit[2] { seatAdjust, ... } (his eye
 *   within 1 cm of ANCHORS.eye, the helmet >= CANOPY.helmetClear under CANOPY.topY), pose(t, sample), heads(out),
 *   hands(out), risers(out), faces[2], setFaceKeys(k, keys, gaze), measure(sample) }.
 *   seats[k] is an Object3D GLUE places every frame at poseMatrix(sample.jets[k].pilotPose); the root hangs under it with
 *   no rotation (the kart's rule), shifted by fit.seatAdjust along SEAT.rail. Hands: right on stickGrip, left on
 *   throttleGrip while seated; both on SEAT.ejectHandle while eject.tuck > 0; on the risers while eject.hang > 0.
 *   Helmet in LANE_COLORS[k], VISOR UP, NO oxygen mask, no markings.
 * FX (jetfx.js):  buildJetFx(scene, opts) -> { update(t, sample) }: missiles (MODEL's buildMissile) + their smoke, flares,
 *   vapour, the bursts, tail fire and smoke at ANCHORS.tailHitPoint, the seat's rocket, the drogue and the main chute
 *   (CHUTE, eject.chutePose, eject.chute), the survival kit. A trail is SAMPLED from the plan's past at fixed emission
 *   times, never accumulated (jetfx.js already works this way).
 * DIRECT (jetshots.js, jetcams.js, jetsound.js, jethud.js):  planJetShots(M) -> shots (screen clock);
 *   makeJetCameras(camera, { world, pilots }) -> { frame(sample, shot, dt) -> { cut, cam, hidden }, cams: JET_CAMS };
 *   makeJetSound(sfx) -> { update(sample, camera), start(), stop() }; makeJetHud(root) -> { update(sample, M), card(text, t) }.
 * WORLD (jetworld.js):  buildJetWorld(scene, renderer, { seed, noAssets }) -> { update(t, camera), sunDir, skyEnv,
 *   applyEnv(obj), exposure, bloom, fightBox, terrainHeightAt(x, z), deck, cloudsAt(t), credit, stats }.
 */

// ======================================================================================================
// 10. THE FIXTURE  (a hand-built JetPlan so every lane can build before PLAN merges; FROZEN with this file)
// ======================================================================================================
// WHAT IS REAL: every channel is DERIVED from the paths (orientation from velocity and the lift direction, nz from the
// acceleration, controls from rates), all poses obey the frames above, the missiles reach their marks by construction
// (a near miss ~19 m from the winner's nozzles, a burst 2.7 m beside the loser's tail point), the flares are closed form,
// the ejection is integrated (drag + gravity) on EJECT_TIMING and clears the fins.
// WHAT IS NOT (tune nothing to it): the jets fly two offset circles (R ~2.0-2.2 km, clockwise; the winner 150 m higher)
// with NO merge and NO real reversal -- the loser is simply faster (260 vs 200 m/s) and passes the winner at ~13 s; the
// break is a 15 m tightening, so G stays ~2-4 (the real 7-9 g break, the merge and the overshoot are PLAN's). Every event
// sits at its JET_BEATS time; `marker: true` where no physics is behind it.
export function makeJetFixture({ seed = 7, order = [0, 1], pilots = ['hassan', 'fazeel'] } = {}) {
  const W = order[0], L = order[1], dt = DT, duration = 31.2, n = Math.round(duration / dt) + 1;
  const T = Object.fromEntries(JET_BEATS.map((b) => [`${b.kind}${b.who}`, b.t]));
  const tHit = T.hitL, tC = T.canopyOffL, ET = EJECT_TIMING;
  const tS = tC + ET.rails, tSep = tC + ET.sep, tCh = tC + ET.full, tKit = tC + ET.kit;
  let sd = (seed >>> 0) || 1; const rnd = () => ((sd = (sd * 1664525 + 1013904223) >>> 0) / 4294967296);
  const phase0 = rnd() * 2 * Math.PI;                              // where on the circle it starts (seeded)
  const ch = Object.fromEntries(JET_CHANNELS.map((k) => [k, [new Float32Array(n), new Float32Array(n)]]));
  // ---- the paths (arc distance on a nominal 2,100 m circle; radius and height vary on top) ----
  const R0 = 2100, sArr = [new Float64Array(n), new Float64Array(n)], P = [[], []], fixDy = WORLD_FRAME.planFloorY - 1300;   // v3: lifted with the floor
  const vOf = (k, t) => (k === W ? 200 + 30 * s2(T.reversedW, T.reversedW + 2.5, t) : 260 - 70 * s2(tHit, tHit + 2.5, t));
  for (let k = 0; k < 2; k++) for (let i = 1; i < n; i++) sArr[k][i] = sArr[k][i - 1] + 0.5 * dt * (vOf(k, (i - 1) * dt) + vOf(k, i * dt));
  const posAt = (k, i) => {
    const t = i * dt, s = sArr[k][i] + (k === W ? 780 : 0);
    const r = k === W ? 2200 - 15 * s2(T.breakW, T.breakW + 3, t) : 2000;
    const y = k === W ? 2000 + 150 * s2(T.pullUpW - 1, T.reversedW + 2, t) : 1850 - (t > tHit ? 0.5 * 5 * (t - tHit) ** 2 * s2(tHit, tHit + 3, t) : 0);
    const th = phase0 + s / R0;
    return [r * Math.cos(th), y + fixDy, r * Math.sin(th)];
  };
  for (let k = 0; k < 2; k++) for (let i = 0; i < n; i++) P[k].push(posAt(k, i));
  // central differences; the two end samples copy their neighbour's (a one-sided end would flip the lift vector)
  const VV = [[], []];
  for (let k = 0; k < 2; k++) for (let i = 0; i < n; i++) { const j = clamp(i, 1, n - 2), a = P[k][j - 1], b = P[k][j + 1]; VV[k].push([0, 1, 2].map((m) => (b[m] - a[m]) / (2 * dt))); }
  const acc = (k, i) => { const j = clamp(i, 2, n - 3), a = VV[k][j - 1], b = VV[k][j + 1]; return [0, 1, 2].map((m) => (b[m] - a[m]) / (2 * dt)); };
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const qPrev = [null, null], unwrap = [{}, {}], eu = {};
  for (let k = 0; k < 2; k++) for (let i = 0; i < n; i++) {
    const t = i * dt, p = P[k][i], v = VV[k][i], a = acc(k, i), f = norm3(v), sp = Math.hypot(v[0], v[1], v[2]);
    const Lf = [a[0], a[1] + G, a[2]], Lp = [Lf[0] - dot(Lf, f) * f[0], Lf[1] - dot(Lf, f) * f[1], Lf[2] - dot(Lf, f) * f[2]];
    const up = norm3(Lp), nz = Math.hypot(Lp[0], Lp[1], Lp[2]) / G, left = cross(up, f);
    const aoa = 0.02 + 0.012 * (nz - 1);
    const q = quatFromBasis(left, up, f);
    qMul(q, qAxis(AXX, -aoa), q);                                  // the nose above the flight path
    const roll = k === W ? 2 * Math.PI * sstep(T.rollW - 0.1, T.rollDoneW + 0.1, t) : 0;
    qMul(q, qAxis(AXZ, roll), q);                                  // the victory roll (right wing down first)
    if (qPrev[k] && dot4(qPrev[k], q) < 0) for (let j = 0; j < 4; j++) q[j] = -q[j];
    qPrev[k] = q.slice();
    eulerOf(q, eu);
    const U = unwrap[k];
    for (const key of ['heading', 'bank']) { let val = eu[key]; if (U[key] !== undefined) { while (val - U[key] > Math.PI) val -= 2 * Math.PI; while (val - U[key] < -Math.PI) val += 2 * Math.PI; } U[key] = val; }
    const set = (name, val) => { ch[name][k][i] = val; };
    set('x', p[0]); set('y', p[1]); set('z', p[2]); set('qx', q[0]); set('qy', q[1]); set('qz', q[2]); set('qw', q[3]);
    set('vx', v[0]); set('vy', v[1]); set('vz', v[2]); set('v', sp); set('heading', U.heading); set('pitch', eu.pitch); set('bank', U.bank);
    set('aoa', aoa); set('nz', nz); set('ny', 0);
    const other = P[1 - k][i]; set('gx', other[0]); set('gy', other[1]); set('gz', other[2]);
    const dl = qRot([-q[0], -q[1], -q[2], q[3]], [other[0] - p[0], other[1] - p[1], other[2] - p[2]]);
    set('headYaw', clamp(Math.atan2(dl[0], dl[2]), -150 * D2R, 150 * D2R)); set('headPitch', clamp(Math.atan2(dl[1], Math.hypot(dl[0], dl[2])), -0.5, 1.2));
    set('six', k === W ? sstep(T.checkSixW - 0.3, T.checkSixW, t) * (1 - sstep(T.checkSixW + 1.2, T.checkSixW + 1.6, t)) : 0);
    const thr = k === W ? (t > T.breakW && t < T.breakW + 3 ? 1 : t > T.pullUpW && t < T.reversedW ? 0.35 : t >= T.reversedW && t < T.launchW ? 1 : 0.75)
      : (t > tHit ? 0 : t > T.breakL && t < T.breakL + 1.4 ? 1 : 0.8);
    set('throttle', thr); set('ab', clamp((thr - AB_DETENT) / (1 - AB_DETENT), 0, 1)); set('nozzle', thr >= AB_DETENT ? 1 : 0.3 * thr);
    set('brake', k === W ? sstep(T.pullUpW, T.pullUpW + 0.6, t) * (1 - sstep(T.reversedW - 0.6, T.reversedW, t)) : 0);
    set('stickY', clamp((nz - 1) / 8, -1, 1)); set('elevator', clamp((nz - 1) / 8, -1, 1) * 0.6 * JET.limits.elevator);
    set('lef', clamp(aoa * 0.8, 0, JET.limits.lef)); set('flap', clamp(aoa * 0.5, 0, JET.limits.flap));
    set('vapour', sstep(3.5, 6, nz)); set('strain', clamp((nz - 3) / 4, 0, 1));
    set('fist', k === W ? sstep(T.rollDoneW - 0.2, T.rollDoneW + 0.2, t) : 0);
    const dmg = k === L && t >= tHit ? 1 : 0;
    set('damage', dmg); set('fire', k === L ? sstep(tHit, tHit + 0.4, t) : 0); set('smoke', k === L ? sstep(tHit, tHit + 0.8, t) : 0);
    set('shake', clamp(0.15 * ch.vapour[k][i] + 0.6 * dmg, 0, 1)); set('canopy', k === L && t >= tC ? 1 : 0);
  }
  for (let k = 0; k < 2; k++) for (let i = 0; i < n; i++) {         // rates and the roll surfaces, from the derived arrays
    const im = Math.max(0, i - 1), ip = Math.min(n - 1, i + 1), h = (ip - im) * dt;
    const rr = (ch.bank[k][ip] - ch.bank[k][im]) / h, sx = clamp(rr / (LIMITS.rollRateDeg * D2R), -1, 1);
    ch.rollRate[k][i] = rr; ch.stickX[k][i] = sx; ch.aileron[k][i] = sx * JET.limits.aileron;
    ch.pedal[k][i] = 0.15 * sx; ch.rudderDef[k][i] = 0.15 * sx * JET.limits.rudderDef;
  }
  const stateAt = (k, t) => { const i = clamp(Math.round(t / dt), 0, n - 1); return { pos: P[k][i], q: [ch.qx[k][i], ch.qy[k][i], ch.qz[k][i], ch.qw[k][i]], vel: VV[k][i] }; };
  // ---- the missiles: a cubic Hermite from the rail to the mark (a point on the target at the beat), then straight on ----
  const missile = (id, shooter, target, rail, tL, tM, outcome, mark, extra) => {
    const c = Object.fromEntries(MISSILE_CHANNELS.map((k) => [k, new Float32Array(n)]));
    const S0 = stateAt(shooter, tL), p0 = toWorld(S0, ANCHORS.missileRails[rail]), Tm = stateAt(target, tM), p1 = toWorld(Tm, mark);
    const span = tM - tL, dir = norm3([p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]]), dist = Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]);
    const v0 = S0.vel, sp1 = Math.max(2 * dist / span - Math.hypot(...v0), Math.hypot(...Tm.vel) + 150), v1 = dir.map((d) => d * sp1);
    const tEnd = tM + extra;
    for (let i = 0; i < n; i++) {
      const t = i * dt; let p, v;
      if (t < tL) { const s = stateAt(shooter, t); p = toWorld(s, ANCHORS.missileRails[rail]); v = s.vel; }
      else if (t <= tM) {
        const u = (t - tL) / span, u2 = u * u, u3 = u2 * u, h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
        const d00 = 6 * u2 - 6 * u, d10 = 3 * u2 - 4 * u + 1, d01 = -6 * u2 + 6 * u, d11 = 3 * u2 - 2 * u;
        p = [0, 1, 2].map((j) => h00 * p0[j] + h10 * span * v0[j] + h01 * p1[j] + h11 * span * v1[j]);
        v = [0, 1, 2].map((j) => (d00 * p0[j] + d01 * p1[j]) / span + d10 * v0[j] + d11 * v1[j]);
      } else { const tt = Math.min(t, tEnd) - tM; p = [0, 1, 2].map((j) => p1[j] + v1[j] * tt); v = t < tEnd ? v1 : [0, 0, 0]; }
      c.x[i] = p[0]; c.y[i] = p[1]; c.z[i] = p[2]; c.vx[i] = v[0]; c.vy[i] = v[1]; c.vz[i] = v[2];
      c.motor[i] = t < tL || t >= tEnd ? 0 : 1 - sstep(tL + MISSILE.burn - 0.2, tL + MISSILE.burn, t);
    }
    const ie = Math.round(tEnd / dt);
    return { id, shooter, target, rail, tLaunch: tL, tEnd, tBurnout: tL + MISSILE.burn, outcome, burst: [c.x[ie], c.y[ie], c.z[ie]], ch: c };
  };
  const missiles = [
    missile(0, L, W, 3, T.launchL, T.nearMissW, 'decoyed', [0, -6, -27], 0.5),          // behind and under the winner: ~19 m from his nozzles
    missile(1, W, L, 0, T.launchW, T.hitL, 'hit', add3(ANCHORS.tailHitPoint, [2.5, 1.0, 0]), 0),   // 2.7 m beside the loser's tail
  ];
  // ---- the flares: two salvos from the winner, one late one from the loser, alternating dispensers ----
  const flares = [];
  for (const [jet, t0] of [[W, T.flaresW], [W, T.flaresW + 0.7], [L, T.flaresL]]) for (let j = 0; j < FLARE.salvo; j++) {
    const t = t0 + j * FLARE.gap, s = stateAt(jet, t), D = ANCHORS.flareDispensers[j % 2], dw = qRot(s.q, D.dir);
    flares.push({ id: flares.length, jet, dispenser: j % 2, tEject: t, p0: toWorld(s, D.p), v0: [0, 1, 2].map((m) => s.vel[m] + dw[m] * FLARE.eject) });
  }
  // ---- the ejection (the loser): integrated on the grid (drag tau + gravity), poses for the whole plan ----
  const ec = Object.fromEntries(EJECT_CHANNELS.map((k) => [k, new Float32Array(n)]));
  const putPose = (pre, i, p, q) => { ec[pre + 'x'][i] = p[0]; ec[pre + 'y'][i] = p[1]; ec[pre + 'z'][i] = p[2]; ec[pre + 'qx'][i] = q[0]; ec[pre + 'qy'][i] = q[1]; ec[pre + 'qz'][i] = q[2]; ec[pre + 'qw'][i] = q[3]; };
  const SB = stateAt(L, tS), railW = qRot(SB.q, SU), CB = stateAt(L, tC), upC = qRot(CB.q, AXY), backC = qRot(CB.q, [0, 0, -1]);
  let sp = null, sv = null, mp = null, mv = null, cp = null, cv = null;
  const prevQ = { c: null, s: null, p: null, k: null };
  for (let i = 0; i < n; i++) {
    const t = i * dt, Ls = stateAt(L, t);
    let cq;                                                         // the canopy: thrown up and back, tumbling
    if (t < tC) { cp = toWorld(Ls, CANOPY.hinge); cq = Ls.q.slice(); }
    else { if (!cv) { cp = toWorld(CB, CANOPY.hinge); cv = [0, 1, 2].map((j) => CB.vel[j] + upC[j] * 12 + backC[j] * 4); } else step(cp, cv, 0.5); cq = qMul(CB.q, qAxis(AXX, -8 * (t - tC))); }
    let sq;                                                         // the seat (with the man until tSep)
    if (t < tS) { sp = toWorld(Ls, SRP); sq = Ls.q.slice(); }
    else { if (!sv) { sp = toWorld(SB, SRP); sv = [0, 1, 2].map((j) => SB.vel[j] + railW[j] * 18); } else step(sp, sv, t < tSep ? 2.5 : 4.0); sq = qMul(SB.q, qAxis(AXX, -0.5 * sstep(tS, tS + 0.6, t))); }
    const c = sstep(tC + ET.main, tCh, t);                           // the main chute: deploys at +1.0, full at +2.0
    let pp, pq;
    if (t < tSep) { pp = sp.slice(); pq = sq; }
    else {
      if (!mp) { mp = sp.slice(); mv = sv.slice(); } else step(mp, mv, 1 / ((1 - c) / 3 + c / (CHUTE.descent / G)));
      pp = mp.slice();
      const hz = Math.hypot(mv[0], mv[2]) < 1 ? [0, 0, 1] : norm3([mv[0], 0, mv[2]]);
      pq = nlerp(sq, quatFromBasis(cross(AXY, hz), AXY, hz), sstep(tSep, tSep + 1.2, t));
      const sw = CHUTE.swingDeg * D2R * sstep(tCh - 0.5, tCh, t) * Math.exp(-Math.max(0, t - tCh) / CHUTE.swingDecay) * Math.sin(2 * Math.PI * CHUTE.swingHz * (t - tCh));
      qMul(pq, qAxis(AXX, sw), pq);
    }
    const kp = [pp[0], pp[1] + 1.0 + CHUTE.riser * c, pp[2]];
    for (const [pre, p, q] of [['c', cp, cq], ['s', sp, sq], ['p', pp, pq], ['k', kp, pq]]) {
      if (prevQ[pre] && dot4(prevQ[pre], q) < 0) for (let j = 0; j < 4; j++) q[j] = -q[j];
      prevQ[pre] = q.slice(); putPose(pre, i, p, q);
    }
    ec.chute[i] = c; ec.rocket[i] = t >= tS && t < tC + ET.rocketOut ? 1 : 0;
    ec.tuck[i] = sstep(tC - 0.4, tC - 0.1, t) * (1 - sstep(tSep + 0.3, tSep + 1.0, t)); ec.hang[i] = sstep(tCh - 0.6, tCh, t);
    ec.thumb[i] = sstep(T.thumbsUpL, T.thumbsUpL + 0.4, t) * (1 - sstep(T.thumbsUpL + 1.6, T.thumbsUpL + 2.0, t)); ec.kit[i] = sstep(tKit, tKit + 0.5, t);
  }
  // ---- the events: every beat at its target; the ones with no physics in this fixture are markers ----
  const physical = new Set(['open', 'launch', 'flares', 'nearMiss', 'hit', 'canopyOff', 'eject', 'seatSep', 'chuteOpen', 'kit', 'roll', 'rollDone', 'end']);
  const events = JET_BEATS.map((b) => {
    const e = { t: b.t, kind: b.kind, jet: b.who === 'W' ? W : b.who === 'L' ? L : -1 };
    if (e.jet >= 0) e.other = 1 - e.jet;
    if (b.missile !== undefined) e.missile = b.missile;
    if (!physical.has(b.kind)) e.marker = true;
    return e;
  });
  return { seed, order: [W, L], pilots: pilots.slice(), dt, n, duration: (n - 1) * dt, screenDuration: (n - 1) * dt, screenMap: [[0, 0]], events, ch, missiles, flares, eject: { jet: L, tCanopy: tC, tSeat: tS, tSep, tChute: tCh, tKit, ch: ec } };
}
function step(p, v, tau) { for (let j = 0; j < 3; j++) { const a = (j === 1 ? -G : 0) - v[j] / tau; v[j] += a * DT; p[j] += v[j] * DT; } }
function dot4(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]; }
function nlerp(a, b, w) { const s = dot4(a, b) < 0 ? -1 : 1; return qNorm([0, 1, 2, 3].map((j) => a[j] * (1 - w) + s * b[j] * w)); }
