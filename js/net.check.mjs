// net.check.mjs -- node checks for netgame.js (lane NET): snapshot / client-state round trips, trigger counts (a press is never
// lost or doubled, even with packets dropped, duplicated or late), the snapshot buffer (interpolation, extrapolation, respawns),
// the clock offset filter, and that a bad packet throws (the caller drops it) instead of corrupting state.
import {
  encodeSnapshot, decodeSnapshot, makeSnapshot, encodeState, decodeState, makeState, createEdgeOut, createEdgeIn, createSampler,
  createClock, SNAP_MAX, STATE_BYTES,
} from './netgame.js';

let fails = 0, n = 0;
const ok = (c, msg) => { n++; if (!c) { fails++; console.log('FAIL', msg); } };
const near = (a, b, e, msg) => ok(Math.abs(a - b) <= e, `${msg}: ${a} vs ${b}`);

// ---------------------------------------------------------------- snapshot round trip
const q = [0.1, -0.7, 0.2, 0.676]; { const l = Math.hypot(...q); for (let i = 0; i < 4; i++) q[i] /= l; }
const jet = (id, x) => ({
  id, alive: id !== 3, isAI: id > 1, life: 200 + id, hp: 0.37, missiles: 2, flares: 1, gunAmmo: 312, shield: 4.25, ctl: { gun: id === 2 },
  lock: { target: id === 1 ? 5 : -1, progress: 0.6, locked: id === 1 }, warn: { missile: id === 4 },
  s: { pos: [x, 1234.5, -9876.25], vel: [250.33, -12.5, 3], q: q.slice(), boost: 2.5, throttle: 0.9, ab: 0.4, aoa: 0.12, gLoad: 6.2, stickX: -0.3, stickY: 0.8, yaw: 0.1, brake: 0.5 },
});
const fighters = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => jet(i, 1000 * i + 0.125));
fighters[2].gunAmmo = 0;
const missiles = [];
for (let i = 0; i < 32; i++) missiles.push({ id: 1000 + i, owner: i % 8, target: i % 3 ? 2 : -1, decoy: i === 5 ? 7 : -1, motor: 0.5, age: 1.234, alive: i % 2 === 0, pos: [i, 2, 3], vel: [700, -20, 5] });
const items = [];
for (let i = 0; i < 19; i++) items.push({ id: 50 + i, kind: ['repair', 'missiles', 'boost', 'shield', 'drop'][i % 5], drop: i >= 16, chute: i === 17, alive: i !== 4, age: 3.3, pos: [i * 10, 500, -i] });
const score = { kills: [3, 0, 1, 0, 0, 0, 0, 9], deaths: [1, 2, 0, 0, 0, 0, 0, 0] };
const dv = new DataView(new ArrayBuffer(SNAP_MAX + 64));
const bytes = encodeSnapshot(dv, { phase: 'fight', seq: 70000, t: 12345.678901, clock: 87.5 }, fighters, score, missiles, items);
ok(bytes <= SNAP_MAX, `snapshot fits (${bytes} <= ${SNAP_MAX})`);
console.log(`snapshot: 8 jets + 16 missiles + 18 items = ${bytes} B (${(bytes * 20 / 1024).toFixed(1)} KB/s per client at 20 Hz)`);
const sn = decodeSnapshot(new DataView(dv.buffer.slice(0, bytes)), makeSnapshot());
ok(sn.phase === 'fight' && sn.seq === 70000 % 65536 && sn.t === 12345.678901, 'header');
near(sn.clock, 87.5, 1e-6, 'clock');
ok(sn.nF === 8 && sn.nM === 16 && sn.nI === 18, `counts ${sn.nF}/${sn.nM}/${sn.nI}`);
for (let i = 0; i < 8; i++) {
  const a = fighters[i], b = sn.f[i];
  ok(b.seat === i && b.alive === a.alive && b.isAI === a.isAI && b.life === a.life && b.missiles === 2 && b.flares === 1 && b.gunAmmo === a.gunAmmo, `fighter ${i} ints`);
  ok(b.locked === (i === 1) && b.lockTarget === a.lock.target && b.warn === (i === 4), `fighter ${i} lock / warn`);
  ok(b.gun === (i === 2 ? false : false), `fighter ${i} gun bit (fighter 2 has no ammo)`);
  ok(b.kills === score.kills[i] && b.deaths === score.deaths[i], `fighter ${i} score`);
  near(b.hp, 0.37, 1 / 255, `hp ${i}`); near(b.shield, 4.25, 0.05, `shield ${i}`); near(b.boost, 2.5, 0.05, `boost ${i}`);
  for (let j = 0; j < 3; j++) { near(b.pos[j], a.s.pos[j], 1e-3, `pos ${i}.${j}`); near(b.vel[j], a.s.vel[j], 0.02, `vel ${i}.${j}`); }
  for (let j = 0; j < 4; j++) near(b.q[j], q[j], 1e-4, `q ${i}.${j}`);
  near(b.throttle, 0.9, 0.005, 'throttle'); near(b.ab, 0.4, 0.005, 'ab'); near(b.aoa, 0.12, 0.005, 'aoa'); near(b.gLoad, 6.2, 0.05, 'g');
  near(b.stickX, -0.3, 0.01, 'stickX'); near(b.stickY, 0.8, 0.01, 'stickY'); near(b.yaw, 0.1, 0.01, 'yaw'); near(b.brake, 0.5, 0.005, 'brake');
}
{ fighters[2].gunAmmo = 5; const k = encodeSnapshot(dv, { phase: 'over', seq: 1, t: 1, clock: 0 }, fighters, score, missiles, items); const s2 = decodeSnapshot(new DataView(dv.buffer.slice(0, k)), makeSnapshot()); ok(s2.f[2].gun && !s2.f[1].gun && s2.phase === 'over', 'gun bit with ammo, phase over'); }
const m0 = sn.m[0], m5 = sn.m.find((m) => m.id === 1004);
ok(m0.id === 1000 && m0.owner === 0 && m0.target === -1 && m0.decoy === -1, 'missile ints');
ok(sn.m[1].id === 1002 && sn.m[1].target === 2, 'missile order + target');
near(m0.age, 1.234, 1e-3, 'missile age'); near(m0.motor, 0.5, 0.005, 'motor'); near(m0.vel[0], 700, 0.05, 'missile vel'); ok(m5 && m5.pos[0] === 4, 'missile pos');
ok(sn.items[0].idx === 0 && sn.items[3].idx === 3 && sn.items[4].idx === 5, 'item slots keep their pool index (dead #4 skipped)');
const d17 = sn.items.find((x) => x.idx === 17);
ok(d17.kind === 'boost' && d17.drop && d17.chute && sn.items.find((x) => x.idx === 16).chute === false, 'item flags');
near(d17.age, 3.3, 0.051, 'item age');

// ---------------------------------------------------------------- client state round trip + bad packets
{
  const s = { pos: [1.5, 2.25, -3], vel: [200, 1, -2], q: q.slice(), throttle: 1, ab: 1, aoa: -0.05, gLoad: -1.5, stickX: 1, stickY: -1, yaw: 0, brake: 0 };
  const sdv = new DataView(new ArrayBuffer(STATE_BYTES));
  const k = encodeState(sdv, { life: 300, crashed: true, gun: true, t: 99.125, mCount: 65535, fCount: 7 }, s);
  ok(k === STATE_BYTES, `state is ${k} B`);
  const o = decodeState(sdv, makeState());
  ok(o.life === 300 % 256 && o.crashed && o.gun && o.t === 99.125 && o.mCount === 65535 && o.fCount === 7, 'state ints');
  for (let j = 0; j < 3; j++) near(o.pos[j], s.pos[j], 1e-4, 'state pos');
  for (let j = 0; j < 4; j++) near(o.q[j], q[j], 1e-5, 'state q');
  near(o.gLoad, -1.5, 0.05, 'state g');
  let threw = 0;
  try { decodeState(new DataView(new ArrayBuffer(10)), makeState()); } catch { threw++; }
  sdv.setFloat32(16, NaN); try { decodeState(sdv, makeState()); } catch { threw++; }
  try { decodeSnapshot(new DataView(dv.buffer.slice(0, 40)), makeSnapshot()); } catch { threw++; }
  try { const b = new DataView(new ArrayBuffer(20)); b.setUint8(0, 1); b.setUint8(16, 200); decodeSnapshot(b, makeSnapshot()); } catch { threw++; }
  try { decodeSnapshot(sdv, makeSnapshot()); } catch { threw++; }
  ok(threw === 5, `bad packets throw (${threw}/5)`);
}

// ---------------------------------------------------------------- trigger counts: never lost, never doubled
{
  const out = createEdgeOut(), inn = createEdgeIn();
  // the client's ctl.missile over 400 steps: a press = true for one step (sometimes held for a few steps: still one press)
  let presses = 0;
  const seq = [];
  for (let i = 0; i < 400; i++) { const p = i % 37 === 3 || i % 37 === 4 || (i % 53 === 10); seq.push(p); }
  for (let i = 0; i < 400; i++) { if (seq[i] && !seq[i - 1]) presses++; }
  // packets every 4 steps; some dropped (never with a reliable channel, but counts must survive it), one duplicated, one late
  let fired = 0, prevCtl = false, edges = 0;
  const packets = [];
  for (let i = 0; i < 400; i++) { out.see(seq[i]); if (i % 4 === 3) packets.push(out.count); }
  const arrive = packets.filter((_, k) => k % 7 !== 2);   // drops
  arrive.splice(10, 0, arrive[9]);                          // a duplicate
  const late = arrive.splice(20, 1)[0]; arrive.splice(23, 0, late);   // an old count after newer ones
  for (const c of arrive) { inn.recv(c); for (let s = 0; s < 6; s++) { const v = inn.pulse(); if (v && !prevCtl) edges++; if (v) fired++; prevCtl = v; } }
  for (let s = 0; s < 40; s++) { const v = inn.pulse(); if (v && !prevCtl) edges++; if (v) fired++; prevCtl = v; }
  ok(out.count === presses, `client counted ${out.count} presses of ${presses}`);
  ok(fired === presses && edges === presses, `host fired ${fired} (rising edges ${edges}) of ${presses} presses`);
  // a burst of 3 presses in one packet: 3 separate rising edges
  const i2 = createEdgeIn(); i2.recv(3); let e2 = 0, p2 = false;
  for (let s = 0; s < 10; s++) { const v = i2.pulse(); if (v && !p2) e2++; p2 = v; }
  ok(e2 === 3, `3 presses in one packet -> ${e2} edges`);
  // wrap-around at 16 bits
  const i3 = createEdgeIn(); i3.sync(65534); i3.recv(1); let e3 = 0; for (let s = 0; s < 10; s++) if (i3.pulse()) e3++;
  ok(e3 === 3, `count wrap 65534 -> 1 = ${e3} presses`);
  // sync (respawn / countdown) drops pending presses
  const i4 = createEdgeIn(); i4.recv(5); i4.sync(5); ok(!i4.pulse(), 'sync drops pending');
}

// ---------------------------------------------------------------- the snapshot buffer
{
  const sm = createSampler(16), out = { pos: [0, 0, 0], vel: [0, 0, 0], q: [0, 0, 0, 1] };
  const st = (t, x, life = 1) => ({ pos: [x, 100, 0], vel: [200, 0, 0], q: [0, 0, 0, 1], alive: true, life, throttle: t, ab: 0, aoa: 0, gLoad: 1, stickX: 0, stickY: 0, yaw: 0, brake: 0 });
  for (let k = 0; k <= 10; k++) sm.push(k * 0.05, st(k * 0.05, k * 10));   // 200 m/s, 20 Hz
  ok(!sm.push(0.2, st(0.2, 999)), 'an old sample is dropped');
  let r = sm.sample(0.125, out);
  near(out.pos[0], 25, 1e-6, 'interpolated (Hermite on a straight line = exact)'); ok(r.alive && r.life === 1 && r.extrap === 0, 'alive/life');
  near(out.throttle, 0.125, 1e-6, 'model blend');
  r = sm.sample(0.6, out); near(out.pos[0], 120, 1e-6, 'extrapolated 0.1 s'); near(r.extrap, 0.1, 1e-9, 'extrap');
  r = sm.sample(5, out); near(out.pos[0], 100 + 200 * 0.3, 1e-6, 'extrapolation capped at 0.3 s');
  // a curve: x = 100 sin(t), the Hermite (with velocities) beats a straight line
  const sc = createSampler(8);
  for (let k = 0; k < 8; k++) { const t = k * 0.05; sc.push(t, { pos: [100 * Math.sin(t * 4), 0, 0], vel: [400 * Math.cos(t * 4), 0, 0], q: [0, 0, 0, 1], alive: true, life: 1 }); }
  sc.sample(0.175, out);
  near(out.pos[0], 100 * Math.sin(0.7), 0.02, 'Hermite on a curve');
  // a respawn (new life, far away): no blend across it
  const sr = createSampler(8);
  sr.push(1.0, st(1, 0, 4)); sr.push(1.05, st(1.05, 5000, 5));
  sr.sample(1.03, out); r = sr.sample(1.03, out);
  ok(out.pos[0] === 0 && r.life === 4, `before the respawn sample: the old life (${out.pos[0]}, life ${r.life})`);
  r = sr.sample(1.05, out); ok(out.pos[0] === 5000 && r.life === 5, 'at the respawn sample: the new life');
  // the spin is extrapolated (a jet rolling at 2 rad/s about its nose)
  const sq = createSampler(4), roll = (a) => [0, 0, Math.sin(a / 2), Math.cos(a / 2)];
  sq.push(0, { pos: [0, 0, 0], vel: [0, 0, 0], q: roll(0), alive: true, life: 1 }); sq.push(0.05, { pos: [0, 0, 0], vel: [0, 0, 0], q: roll(0.1), alive: true, life: 1 });
  sq.sample(0.1, out); near(2 * Math.atan2(out.q[2], out.q[3]), 0.2, 1e-6, 'spin extrapolated');
  sq.sample(0.025, out); near(2 * Math.atan2(out.q[2], out.q[3]), 0.05, 1e-6, 'slerp');
}

// ---------------------------------------------------------------- the clock offset (max filter)
{
  const c = createClock();
  // remote clock = local + 50 s; one-way delay 20 ms + jitter 0..40 ms
  let worst = 0;
  for (let k = 0; k < 200; k++) {
    const local = 10 + k * 0.05, delay = 0.02 + ((k * 7919) % 41) / 1000;
    c.update(local - delay + 50, local);
    if (k > 20) worst = Math.max(worst, Math.abs(c.toRemote(local) - (local + 50 - 0.02)));
  }
  ok(worst < 0.006, `offset tracks the least-delayed packet (worst error ${(worst * 1000).toFixed(1)} ms)`);
}

console.log(fails ? `net.check: ${fails} of ${n} FAILED` : `net.check: all ${n} passed`);
process.exit(fails ? 1 : 0);
