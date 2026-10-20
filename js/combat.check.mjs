// combat.check.mjs -- node js/combat.check.mjs: the weapons' assertions with real flight.js jets (exit 1 on failure).
import { createJet, stepJet } from './flight.js';
import { createCombat, TUNE } from './combat.js';
import { mulberry32 } from './rng.js';

const DT = 1 / 120, D2R = Math.PI / 180;
let fails = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'}  ${msg}`); if (!cond) fails++; };
const rows = [];
const row = (test, o) => rows.push({ test, numbers: Object.entries(o).map(([k, v]) => `${k} ${v}`).join(', ') });

const hills = (x, z) => 200 + 200 * Math.sin(x / 3000) * Math.cos(z / 2500);
const env = { terrainHeightAt: hills, playArea: { cx: 0, cz: 0, half: 30000, ceiling: 8000 } };
const fighter = (id, pos, heading, speed = 250) => ({
  id, name: `F${id}`, isAI: false, s: createJet({ pos, heading, speed }),
  ctl: { aim: [Math.sin(heading), 0, -Math.cos(heading)], throttle: 0.84, ab: false, gun: false, missile: false, flare: false },
});
/** a combat with the given fighters; returns { c, ev } (ev = every event, in order) */
function setup(fs, seed = 1, th = hills) {
  const ev = [], c = createCombat({ terrainHeightAt: th, seed, onEvent: (e) => ev.push(e) });
  for (const f of fs) c.add(f);
  return { c, ev };
}
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const unit = (a) => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const fwdOf = (s) => unit(s.vel);
function stepAll(fs, c, n = 1, before = null) {
  for (let i = 0; i < n; i++) { before?.(); for (const f of fs) stepJet(f.s, f.ctl, DT, env); c.step(DT); }
}
/** aim the flight path so the NOSE (path + AoA) points along want: aim = want + (path - nose) */
function noseAim(f, want) {
  const s = f.s, F = fwdOf(s), q = s.q, x = q[0], y = q[1], z = q[2], w = q[3];
  const nose = [2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)];
  const a = unit([want[0] + F[0] - nose[0], want[1] + F[1] - nose[1], want[2] + F[2] - nose[2]]);
  f.ctl.aim[0] = a[0]; f.ctl.aim[1] = a[1]; f.ctl.aim[2] = a[2];
}

// 1. the seeker: acquires in the cone after lockTime, not out of range, not through a ridge; lost past 30 deg
{
  const A = fighter(0, [0, 2000, 0], 0), B = fighter(1, [0, 2000, -2000], 0);
  const { c, ev } = setup([A, B]);
  let tOn = NaN;
  for (let i = 0; i < 240 && Number.isNaN(tOn); i++) { c.step(DT); if (A.lock.locked) tOn = (i + 1) * DT; }
  ok(Math.abs(tOn - TUNE.lockTime) < 0.05 && ev.some((e) => e.type === 'lockOn' && e.owner === 0 && e.target === 1), `lock at 2 km dead ahead after ${tOn.toFixed(2)} s (lockTime ${TUNE.lockTime})`);
  // swing the target off the nose: kept to 30 deg, lost past it
  let lostDeg = NaN;
  for (let d = 0; d <= 45 && Number.isNaN(lostDeg); d += 0.5) {
    B.s.pos[0] = 2000 * Math.sin(d * D2R); B.s.pos[2] = -2000 * Math.cos(d * D2R); c.step(DT);
    if (!A.lock.locked) lostDeg = d;
  }
  ok(lostDeg > 29 && lostDeg < 31.5 && ev.some((e) => e.type === 'lockLost'), `lock lost at ${lostDeg} deg off the nose`);
  // 22 deg off: not acquired (cone 20); 15 deg: acquired
  B.s.pos[0] = 2000 * Math.sin(22 * D2R); B.s.pos[2] = -2000 * Math.cos(22 * D2R); c.step(DT);
  ok(A.lock.target === -1, 'no growl at 22 deg off the nose');
  B.s.pos[0] = 2000 * Math.sin(15 * D2R); B.s.pos[2] = -2000 * Math.cos(15 * D2R); stepAll([], c, 170);
  ok(A.lock.locked, 'locked at 15 deg off the nose');
  for (const [r, want] of [[250, false], [3900, true], [4500, false]]) {
    const a = fighter(0, [0, 2000, 0], 0), b = fighter(1, [0, 2000, -r], 0), { c: cc } = setup([a, b]);
    stepAll([], cc, 170);
    ok(a.lock.locked === want, `range ${r} m: ${want ? 'locks' : 'no lock'}`);
  }
  // locked at 3.9 km, then out to 5.5 km: lost past lockKeepMax
  { const a = fighter(0, [0, 2000, 0], 0), b = fighter(1, [0, 2000, -3900], 0), { c: cc } = setup([a, b]);
    stepAll([], cc, 170); b.s.pos[2] = -4900; cc.step(DT); const kept = a.lock.locked; b.s.pos[2] = -5100; cc.step(DT);
    ok(kept && !a.lock.locked, `kept at 4.9 km, lost at 5.1 km`); }
  // a 3 km ridge between them: no lock
  { const ridge = (x, z) => (Math.abs(z + 1000) < 300 ? 3000 : 0);
    const a = fighter(0, [0, 2000, 0], 0), b = fighter(1, [0, 2000, -2000], 0), { c: cc } = setup([a, b], 1, ridge);
    stepAll([], cc, 240); ok(a.lock.target === -1 && !a.lock.locked, 'no lock through a ridge'); }
}

// 2. missiles: from behind at 1.5 km vs a straight target -> hit; a side shot vs a hard break -> miss; close behind -> hit
function missileRun({ seed = 1, shooter, target, evade = null, flareAt = null, maxT = 14 }) {
  const A = fighter(0, ...shooter), B = fighter(1, ...target), { c, ev } = setup([A, B], seed);
  let fired = false, tFire = 0, miss = Infinity, burst = false;
  for (let i = 0; i < 120 * maxT; i++) {
    const t = i * DT;
    noseAim(A, unit(sub(B.s.pos, A.s.pos)));
    if (!fired && A.lock.locked) { A.ctl.missile = true; fired = true; tFire = t; } else A.ctl.missile = false;
    const m = c.missiles.find((x) => x.alive);
    if (fired && evade && t - tFire >= evade.delay) evade.fn(B, m);
    if (fired && flareAt && m && !burst && B.warn.missile) {   // tti from the warning's range and the missile's closure
      const r = sub(B.s.pos, m.pos), R = Math.hypot(...r), cl = ((m.vel[0] - B.s.vel[0]) * r[0] + (m.vel[1] - B.s.vel[1]) * r[1] + (m.vel[2] - B.s.vel[2]) * r[2]) / R;
      if (cl > 0 && R / cl <= flareAt) { B.ctl.flare = true; burst = true; }
    } else B.ctl.flare = false;
    stepAll([A, B], c);
    if (m && m.alive) miss = Math.min(miss, Math.hypot(...sub(m.pos, B.s.pos)));
    if (fired && !c.missiles.some((x) => x.alive)) break;
  }
  const hit = ev.find((e) => e.type === 'missileHit'), gone = ev.find((e) => e.type === 'missileGone');
  return { fired, hit: !!hit, tof: hit ? hit.t - tFire - DT : NaN, gone: gone?.reason, miss, hp: B.hp, B, ev };
}
// a sustained max turn, level, to the side the missile comes from (into it)
const breakTurn = (B, m) => {
  const F = fwdOf(B.s), right = unit([-F[2], 0, F[0]]);
  const side = m ? Math.sign((m.pos[0] - B.s.pos[0]) * right[0] + (m.pos[2] - B.s.pos[2]) * right[2]) || 1 : 1;
  B.ctl.aim[0] = right[0] * side; B.ctl.aim[1] = 0; B.ctl.aim[2] = right[2] * side; B.ctl.throttle = 1;
};
{
  const r = missileRun({ shooter: [[0, 2000, 0], 0, 250], target: [[0, 2000, -1500], 0, 250] });
  ok(r.hit && r.hp < 0.35, `rear shot 1.5 km vs straight target: hit after ${r.tof.toFixed(2)} s, target hp ${r.hp.toFixed(2)}`);
  row('rear 1.5 km, straight', { hit: r.hit, tof: r.tof.toFixed(2) + ' s', miss: r.miss.toFixed(1) + ' m' });
}
{ // side aspect (90 deg off the target's nose) at 2 km, target at corner speed breaks into it 0.5 s after launch
  const sideRun = (d, delay) => missileRun({ shooter: [[d, 2000, -d * 0.0], -Math.PI / 2, 250], target: [[0, 2000, 0], 0, 215], evade: { delay, fn: breakTurn } });
  let beat = 0; const n = 6;
  for (let k = 0; k < n; k++) { const r = sideRun(1800 + k * 200, 0.3); if (!r.hit) beat++; row(`side ${1800 + k * 200} m, break`, { hit: r.hit, miss: r.miss.toFixed(0) + ' m', gone: r.gone ?? '-' }); }
  ok(beat >= n - 1, `side-aspect shots 1.8-2.8 km vs a hard break: ${beat}/${n} beaten`);
  const straight = sideRun(2200, 99);
  ok(straight.hit, `the same side shot vs a non-manoeuvring target hits (tof ${straight.tof.toFixed(2)} s)`);
  row('side 2.2 km, straight', { hit: straight.hit, tof: straight.tof.toFixed(2) });
  // head-on at 2.5 km: turning away (to the beam and on) makes it chase and run short
  const away = (B, m) => { breakTurn(B, m); B.ctl.aim[0] *= -1; B.ctl.aim[2] *= -1; };
  const ho = missileRun({ shooter: [[0, 2000, -2500], Math.PI, 250], target: [[0, 2000, 0], 0, 215], evade: { delay: 0.2, fn: away } });
  ok(!ho.hit, `head-on 2.5 km vs a hard turn away: beaten (miss ${ho.miss.toFixed(0)} m)`);
  row('head-on 2.5 km, turn away', { hit: ho.hit, miss: ho.miss.toFixed(0) + ' m', gone: ho.gone ?? '-' });
  let caught = 0;
  for (const d of [600, 800, 1000]) {
    const r = missileRun({ shooter: [[0, 2000, 0], 0, 250], target: [[0, 2000, -d], 0, 215], evade: { delay: 0.3, fn: breakTurn } });
    if (r.hit) caught++;
    row(`rear ${d} m, break`, { hit: r.hit, tof: r.tof.toFixed(2), miss: r.miss.toFixed(1) + ' m' });
  }
  ok(caught === 3, `close rear shots (0.6-1 km) vs a hard break: ${caught}/3 hit`);
}

// 3. flares: a well-timed burst (2 s to impact) decoys >= 60 %; early and late bursts do worse
{
  const N = 60, res = {};
  for (const [name, tti] of [['early 6 s', 6], ['well 2 s', 2], ['late 0.6 s', 0.6]]) {
    let dec = 0, hit = 0;
    for (let k = 0; k < N; k++) {
      const R = mulberry32(1000 + k), ang = (R() * 60 - 30) * D2R, d = 2500 + R() * 600;   // from behind +-30 deg
      const r = missileRun({ seed: 7 + k, shooter: [[d * Math.sin(ang), 2000, d * Math.cos(ang)], -ang, 250], target: [[0, 2000, 0], 0, 250], flareAt: tti });
      if (r.gone === 'decoyed') dec++;
      if (r.hit) hit++;
    }
    res[name] = dec / N;
    row(`flares ${name}`, { decoyed: `${dec}/${N}`, hit: `${hit}/${N}` });
  }
  ok(res['well 2 s'] >= 0.6, `well-timed flares decoy ${(res['well 2 s'] * 100).toFixed(0)} % (>= 60)`);
  ok(res['early 6 s'] < res['well 2 s'] && res['late 0.6 s'] < res['well 2 s'], `early ${(res['early 6 s'] * 100).toFixed(0)} % and late ${(res['late 0.6 s'] * 100).toFixed(0)} % do worse`);
}

// 4. the gun: 400 m behind, nose on, 2 s burst -> hits; 20 rds/s; gunFired <= 10 Hz
{
  const A = fighter(0, [0, 2000, 0], 0), B = fighter(1, [0, 2000, -400], 0), { c, ev } = setup([A, B]);
  stepAll([A, B], c, 240, () => { noseAim(A, unit(sub(B.s.pos, A.s.pos))); A.ctl.gun = true; });
  const hits = ev.filter((e) => e.type === 'gunHit').length, fired = TUNE.gunAmmo - A.gunAmmo, gf = ev.filter((e) => e.type === 'gunFired').length;
  ok(fired >= 39 && fired <= 41, `2 s of trigger: ${fired} rounds`);
  ok(hits >= 10 && Math.abs(B.hp - (1 - hits * TUNE.gunDamage)) < 1e-9, `gun 400 m behind: ${hits} hits, hp ${B.hp.toFixed(2)}`);
  ok(gf <= 21, `gunFired events: ${gf} in 2 s (<= 10 Hz)`);
  row('gun 400 m, 2 s', { rounds: fired, hits, hp: B.hp.toFixed(2) });
  // missile + gun finish: hp 0.3 -> 8 more hits kill, with the kill event
  B.hp = 0.3; stepAll([A, B], c, 360, () => { noseAim(A, unit(sub(B.s.pos, A.s.pos))); A.ctl.gun = true; });
  const k = ev.find((e) => e.type === 'kill');
  ok(!B.alive && k && k.killer === 0 && k.victim === 1 && k.cause === 'gun', `the gun finishes a missile-damaged jet (kill ${k && k.cause})`);
}

// 5. crash -> kill credited to whoever locked the victim in the last 10 s
{
  const A = fighter(0, [0, 2000, 0], 0), B = fighter(1, [0, 2000, -2000], 0), { c, ev } = setup([A, B]);
  stepAll([], c, 170);
  B.s.crashed = true; c.step(DT);
  const k = ev.find((e) => e.type === 'kill');
  ok(k && k.cause === 'crash' && k.killer === 0 && !B.alive, `crash after being locked: killer ${k?.killer}`);
  const C = fighter(2, [0, 2000, 0], 0), { c: c2, ev: e2 } = setup([C]); C.s.crashed = true; c2.step(DT);
  ok(e2.find((e) => e.type === 'kill')?.killer === -1, 'a lone crash: killer -1');
  ok(A.lock.target === -1, 'a dead target drops the lock');
}

// 6. determinism and robustness: random pilots (seeded), 60 s twice -> same hash; 10,000 steps no NaN; pools reused
function randomFight(seed, steps) {
  const R = mulberry32(seed), A = fighter(0, [0, 2500, 0], 0), B = fighter(1, [300, 2500, -1800], Math.PI * 0.1);
  const { c, ev } = setup([A, B], seed);
  const pools = [c.missiles, c.bullets, c.flares].map((p) => [p, p.length, p[0]]);
  let nan = false;
  for (let i = 0; i < steps; i++) {
    for (const [f, g] of [[A, B], [B, A]]) {
      if (i % 30 === 0) {
        const to = unit(sub(g.s.pos, f.s.pos)), a = unit([to[0] + R() - 0.5, to[1] * 0.3 + (R() - 0.5) * 0.4, to[2] + R() - 0.5]);
        f.ctl.aim = a; f.ctl.throttle = R(); f.ctl.ab = R() < 0.2; f.ctl.gun = R() < 0.4;
      }
      f.ctl.missile = R() < 0.003; f.ctl.flare = R() < 0.002;
      if (f.s.pos[1] < hills(f.s.pos[0], f.s.pos[2]) + 400) f.ctl.aim = [0, 1, 0];
      stepJet(f.s, f.ctl, DT, env);
    }
    c.step(DT);
    for (const f of [A, B]) if (!f.alive || f.s.crashed) { const sp = f.id ? [300, 2500, -1800] : [0, 2500, 0]; f.s = createJet({ pos: sp, heading: R() * 6, speed: 230 }); c.reset(f); }
    if (i % 97 === 0) for (const p of [c.missiles, c.bullets, c.flares]) for (const o of p) if (o.alive && !(o.pos.every(Number.isFinite) && o.vel.every(Number.isFinite))) nan = true;
  }
  // FNV-1a over every number of the state
  let h = 2166136261 >>> 0; const f64 = new Float64Array(1), u8 = new Uint8Array(f64.buffer);
  const mix = (x) => { f64[0] = +x; for (let j = 0; j < 8; j++) { h ^= u8[j]; h = Math.imul(h, 16777619) >>> 0; } };
  for (const f of [A, B]) { [...f.s.pos, ...f.s.vel, ...f.s.q, f.hp, f.missiles, f.flares, f.gunAmmo, f.lock.target, f.lock.progress, f.warn.dist].forEach(mix); }
  for (const p of [c.missiles, c.bullets, c.flares]) for (const o of p) { mix(o.alive); [...o.pos, ...o.vel, o.age].forEach(mix); }
  ev.forEach((e) => mix(e.t));
  const reused = pools.every(([p, n, o0]) => p.length === n && p[0] === o0) && c.missiles === pools[0][0];
  return { h, nan, ev, reused, kinds: [...new Set(ev.map((e) => e.type))].sort() };
}
{
  const a = randomFight(42, 120 * 60), b = randomFight(42, 120 * 60), d = randomFight(43, 120 * 60);
  ok(a.h === b.h && a.ev.length === b.ev.length, `same seed + inputs, 60 s: hash ${a.h.toString(16)} == ${b.h.toString(16)} (${a.ev.length} events)`);
  ok(a.h !== d.h, `another seed differs (${d.h.toString(16)})`);
  const r = randomFight(7, 10000);
  ok(!r.nan && r.reused, `10,000 random steps: no NaN, pools reused (events: ${r.kinds.join(' ')})`);
}

console.log('');
console.table(rows);
console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
