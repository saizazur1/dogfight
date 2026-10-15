// flight.check.mjs -- node js/flight.check.mjs: the flight model's assertions on a synthetic terrain (exit 1 on failure).
import { createJet, stepJet, jetModelState, TUNE } from './flight.js';
import { JET, eulerOf } from './jetspec.js';

const DT = 1 / 120, D2R = Math.PI / 180;
let fails = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'}  ${msg}`); if (!cond) fails++; };
const rows = [];
const row = (name, o) => rows.push({ test: name, numbers: Object.entries(o).map(([k, v]) => `${k} ${v}`).join(', ') });

// rolling hills ~0..400 m, plus a 2 km ridge across z = -9000 (only where asked)
const hills = (x, z) => 200 + 200 * Math.sin(x / 3000) * Math.cos(z / 2500);
const ridge = (x, z) => hills(x, z) + 2000 * Math.exp(-(((z + 9000) / 400) ** 2));
const area = { cx: 0, cz: 0, half: 15000, ceiling: 6000 };
const env = { terrainHeightAt: hills, playArea: area };
const finite = (s) => [...s.pos, ...s.vel, ...s.q, s.speed, s.gLoad, s.aoa].every(Number.isFinite);
const hdgDeg = (s) => ((Math.atan2(s.vel[0], -s.vel[2]) / D2R) + 360) % 360;   // of the flight path (the nose adds the AoA in a bank)

// 1. level flight holds its height
{
  const s = createJet({ pos: [0, 2000, 0], heading: 0, speed: 230 });
  const ctl = { aim: [0, 0, -1], throttle: 0.7 };
  let dy = 0;
  for (let i = 0; i < 120 * 30; i++) { stepJet(s, ctl, DT, env); dy = Math.max(dy, Math.abs(s.pos[1] - 2000)); }
  ok(dy < 15, `level flight: height within ${dy.toFixed(1)} m over 30 s (tol 15)`);
  row('level 30 s', { speed: s.speed.toFixed(0), g: s.gLoad.toFixed(2), note: `dy max ${dy.toFixed(1)} m` });
}

// 2. aim 90 deg right -> a banked right turn
for (const [v0, thr] of [[230, 0.85], [230, 1], [160, 1], [300, 1]]) {
  const s = createJet({ pos: [0, 2000, 0], heading: 0, speed: v0 });
  const ctl = { aim: [1, 0, 0], throttle: thr };
  let t90 = NaN, bankMax = 0, gMax = 0, vMin = 1e9, rateMax = 0, prevH = 0, over = 0;
  for (let i = 0; i < 120 * 15; i++) {
    stepJet(s, ctl, DT, env);
    const h = hdgDeg(s), b = eulerOf(s.q).bank / D2R;
    bankMax = Math.max(bankMax, b); gMax = Math.max(gMax, s.gLoad); vMin = Math.min(vMin, s.speed);
    rateMax = Math.max(rateMax, (h - prevH) / DT); prevH = h;
    if (Number.isNaN(t90) && h > 88 && h < 180) t90 = (i + 1) * DT;
    if (h < 180) over = Math.max(over, h - 90);
  }
  const b = eulerOf(s.q).bank / D2R;
  ok(t90 > 1.5 && t90 < 8, `aim 90 right @${v0} m/s thr ${thr}: heading 90 in ${t90.toFixed(2)} s, bank max ${bankMax.toFixed(0)} deg, ${gMax.toFixed(1)} g`);
  ok(bankMax > 45, `  it banked right (max ${bankMax.toFixed(0)} deg)`);
  ok(Math.abs(b) < 10 && over < 6, `  wings level after (bank ${b.toFixed(1)}), overshoot ${over.toFixed(1)} deg`);
  row(`turn 90 @${v0} thr ${thr}`, { t90: t90.toFixed(2) + ' s', rate: rateMax.toFixed(1) + ' deg/s', g: gMax.toFixed(1), bank: bankMax.toFixed(0), vMin: vMin.toFixed(0) });
}

// 3. sustained max turn (aim kept 90 deg off): turn rate, g and the bleed
{
  const s = createJet({ pos: [0, 2000, 0], heading: 0, speed: 260 });
  const ctl = { aim: [1, 0, 0], throttle: 1 };
  const out = [];
  for (let i = 1; i <= 120 * 20; i++) {
    const f = [s.vel[0] / s.speed, 0, s.vel[2] / s.speed], l = Math.hypot(f[0], f[2]);
    ctl.aim[0] = -f[2] / l; ctl.aim[1] = 0; ctl.aim[2] = f[0] / l;            // always 90 deg right, level
    const h0 = hdgDeg(s); stepJet(s, ctl, DT, env);
    let d = hdgDeg(s) - h0; if (d < -180) d += 360;
    if (i % (120 * 5) === 0) out.push({ t: i / 120, rate: d / DT, g: s.gLoad, v: s.speed, y: s.pos[1] });
  }
  for (const o of out) row(`sustained AB t=${o.t}`, { rate: o.rate.toFixed(1) + ' deg/s', g: o.g.toFixed(1), speed: o.v.toFixed(0), y: o.y.toFixed(0) });
  ok(out[out.length - 1].v < 260 && out[out.length - 1].v > 100, `hard turn bleeds energy: 260 -> ${out[out.length - 1].v.toFixed(0)} m/s in 20 s`);
}

// 4. climb slows, dive speeds up
{
  const a = createJet({ pos: [0, 2000, 0], heading: 0, speed: 250 }), b = createJet({ pos: [0, 4000, 0], heading: 0, speed: 250 });
  const up = { aim: [0, Math.sin(40 * D2R), -Math.cos(40 * D2R)], throttle: 0.85 }, dn = { aim: [0, -Math.sin(30 * D2R), -Math.cos(30 * D2R)], throttle: 0.85 };
  for (let i = 0; i < 120 * 8; i++) { stepJet(a, up, DT, env); stepJet(b, dn, DT, env); }
  ok(a.speed < 230 && b.speed > 270, `40 deg climb 250 -> ${a.speed.toFixed(0)} m/s, 30 deg dive 250 -> ${b.speed.toFixed(0)} m/s (8 s)`);
  row('climb 40 deg 8 s', { speed: a.speed.toFixed(0) }); row('dive 30 deg 8 s', { speed: b.speed.toFixed(0) });
}

// 5. full pull at low speed (and a vertical idle climb): stall, nose drops, recovers, no NaN, no spin
for (const [name, ctl, v0] of [['aim straight up, idle', { aim: [0, 1, 0], throttle: 0 }, 180], ['Arrow-up full pull, idle', { aim: null, pitch: 1, throttle: 0 }, 140]]) {
  const s = createJet({ pos: [0, 4000, 0], heading: 0, speed: v0 });
  let tStall = NaN, tRec = NaN, vMin = 1e9, rollMax = 0, pitchMin = 99, nan = false;
  for (let i = 0; i < 120 * 25; i++) {
    if (!Number.isNaN(tStall) && i * DT > tStall + 2) { ctl.aim = [0, 0, -1]; ctl.pitch = 0; ctl.throttle = 0.85; }   // let go: aim at the horizon
    stepJet(s, ctl, DT, env);
    nan ||= !finite(s);
    vMin = Math.min(vMin, s.speed); rollMax = Math.max(rollMax, Math.abs(s.rollRate) / D2R);
    if (s.warn.stall && Number.isNaN(tStall)) tStall = i * DT;
    if (!Number.isNaN(tStall)) pitchMin = Math.min(pitchMin, eulerOf(s.q).pitch / D2R);
    if (!Number.isNaN(tStall) && Number.isNaN(tRec) && !s.warn.stall && i * DT > tStall + 2) tRec = i * DT;
  }
  ok(!Number.isNaN(tStall), `${name}: stalled at ${tStall.toFixed(1)} s (min speed ${vMin.toFixed(0)} m/s)`);
  ok(!Number.isNaN(tRec) && s.speed > TUNE.vStall, `  recovered at ${tRec.toFixed(1)} s, now ${s.speed.toFixed(0)} m/s`);
  ok(pitchMin < -10, `  the nose dropped (lowest pitch ${pitchMin.toFixed(0)} deg)`);
  ok(!nan && !s.crashed, `  no NaN, no crash`);
  ok(rollMax < 200, `  no spin: roll rate never over ${rollMax.toFixed(0)} deg/s`);
  row(`stall: ${name}`, { tStall: tStall.toFixed(1), tRec: tRec.toFixed(1), vMin: vMin.toFixed(0) });
}

// 6. into a ridge: PULL UP first, then the crash
{
  const s = createJet({ pos: [0, 600, 0], heading: 0, speed: 250 });
  const ctl = { aim: [0, 0, -1], throttle: 0.85 }, e = { terrainHeightAt: ridge, playArea: area };
  let tWarn = NaN, tCrash = NaN;
  for (let i = 0; i < 120 * 60 && !s.crashed; i++) {
    stepJet(s, ctl, DT, e);
    if (s.warn.pullUp && Number.isNaN(tWarn)) tWarn = (i + 1) * DT;
    if (s.crashed) tCrash = (i + 1) * DT;
  }
  ok(s.crashed && s.crashPoint && Math.abs(s.crashPoint[2] + 9000) < 1500, `ridge: crashed at ${tCrash.toFixed(2)} s, z ${s.crashPoint?.[2].toFixed(0)}`);
  ok(tCrash - tWarn > 2.5, `  PULL UP ${(tCrash - tWarn).toFixed(2)} s before the impact`);
  const p0 = s.pos.slice(); stepJet(s, ctl, DT, e);
  ok(s.pos.every((v, i) => v === p0[i]), '  a crashed jet stays put');
  row('ridge', { tWarn: tWarn.toFixed(2), tCrash: tCrash.toFixed(2), lead: (tCrash - tWarn).toFixed(2) + ' s' });
}

// 7. outside the box: turned back (even with the aim held outward); under the ceiling: pushed down
{
  const s = createJet({ pos: [14500, 2000, 0], heading: Math.PI / 2, speed: 250 });
  const ctl = { aim: [1, 0, 0], throttle: 0.85 };
  let xMax = 0, tOut = NaN, tBack = NaN;
  for (let i = 0; i < 120 * 60; i++) {
    stepJet(s, ctl, DT, env); xMax = Math.max(xMax, s.pos[0]);
    if (s.warn.boundary && Number.isNaN(tOut)) tOut = i * DT;
    if (!Number.isNaN(tOut) && Number.isNaN(tBack) && s.pos[0] < 15000) tBack = i * DT;
  }
  ok(xMax < 15000 + 2500 && tBack - tOut < 30, `box: aim held outward, out to ${(xMax - 15000).toFixed(0)} m past the edge, back inside ${(tBack - tOut).toFixed(1)} s later`);
  row('box edge', { maxOut: (xMax - 15000).toFixed(0) + ' m', back: (tBack - tOut).toFixed(1) + ' s' });
  const c = createJet({ pos: [0, 5500, 0], heading: 0, speed: 280 });
  const up = { aim: [0, 0.9, -0.436], throttle: 1 };
  let yMax = 0;
  for (let i = 0; i < 120 * 40; i++) { stepJet(c, up, DT, env); yMax = Math.max(yMax, c.pos[1]); }
  ok(yMax < area.ceiling + 600 && !c.warn.stall, `ceiling ${area.ceiling}: aim 64 deg up in AB peaks at ${yMax.toFixed(0)}, no stall`);
  row('ceiling', { yMax: yMax.toFixed(0) });
}

// 8. 10,000 random-input steps (jetModelState stays inside the model's limits)
const L = JET.limits, ms = {}, bad = new Set();
const LIMS = [['aileron', L.aileron], ['elevator', L.elevator], ['rudder', L.rudderDef], ['flap', L.flap], ['lef', L.lef], ['brake', 1],
  ['stickX', 1], ['stickY', 1], ['pedal', 1], ['throttle', 1], ['nozzle', 1], ['ab', 1]];
// (and 10,000 more at 1/30 s): never NaN
for (const dt of [DT, 1 / 30]) {
  let seed = 12345; const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  let s = createJet({ pos: [0, 2500, 0], heading: 0, speed: 220 }), nan = false, crashes = 0, stalls = 0;
  const ctl = { aim: [0, 0, -1], pitch: 0, roll: 0, yaw: 0, throttle: 0.7, ab: false, brake: false };
  for (let i = 0; i < 10000; i++) {
    if (i % 60 === 0) {
      const a = [rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1], l = Math.hypot(...a);
      ctl.aim = rnd() < 0.1 ? null : a.map((x) => x / l);
      ctl.pitch = rnd() < 0.2 ? rnd() * 2 - 1 : 0; ctl.roll = rnd() < 0.2 ? rnd() * 2 - 1 : 0; ctl.yaw = rnd() < 0.2 ? rnd() * 2 - 1 : 0;
      ctl.throttle = rnd(); ctl.ab = rnd() < 0.2; ctl.brake = rnd() < 0.2;
    }
    stepJet(s, ctl, dt, env);
    if (!finite(s)) { nan = true; break; }
    jetModelState(s, ms);
    for (const [k, lim] of LIMS) if (!(Math.abs(ms[k]) <= lim + 1e-9)) bad.add(`${k} ${ms[k]}`);
    if (s.warn.stall) stalls++;
    if (s.crashed) { crashes++; s = createJet({ pos: [0, 2500, 0], heading: rnd() * 6, speed: 220 }); }
  }
  ok(bad.size === 0, `  jetModelState inside JET.limits and -1..1 / 0..1 ${[...bad].slice(0, 3).join(', ')}`);
  ok(!nan, `random inputs, 10,000 steps at dt ${dt.toFixed(4)}: no NaN (${crashes} crashes, ${(stalls / 100).toFixed(0)} % stalled)`);
}

console.log('');
console.table(rows);
console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
