// powerups.check.mjs -- node js/powerups.check.mjs: pick-ups and supply drops (exit 1 on failure).
import { createPowerups, PU } from './powerups.js';
import { TUNE, createCombat } from './combat.js';
import { createJet, stepJet } from './flight.js';
import { createAI } from './ai.js';

const DT = 1 / 120;
let fails = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'}  ${msg}`); if (!cond) fails++; };
const hills = (x, z) => 1500 + 900 * Math.sin(x / 3000) * Math.cos(z / 2500);
const pa = { cx: -5500, cz: -3000, half: 15000, ceiling: 6000 };
const fighter = (id, pos) => ({ id, alive: true, hp: 1, missiles: 4, flares: 3, gunAmmo: 400, shield: 0, s: { pos: pos.slice(), vel: [0, 0, 0], crashed: false, boost: 0 } });
function setup(seed = 7) {
  const ev = [], pu = createPowerups({ terrainHeightAt: hills, playArea: pa, seed, onEvent: (e) => ev.push(e), combat: { TUNE } });
  return { pu, ev };
}
const live = (pu) => pu.items.filter((it) => it.alive && !it.drop);
const far = [1e6, 9000, 1e6];

// 1. spawn spread: count items, 250-800 m over the ground, under the ceiling, in the middle 60 %, >= ~1.5 km apart
{
  const { pu } = setup();
  pu.start({ count: 10, dropEvery: 0 });
  const L = live(pu);
  let minGap = Infinity, aglOk = true, inside = true;
  for (const a of L) {
    const agl = a.pos[1] - hills(a.pos[0], a.pos[2]);
    if (agl < PU.aglMin - 1 || a.pos[1] > pa.ceiling - PU.ceilingGap + 1e-6) aglOk = false;
    if (Math.abs(a.pos[0] - pa.cx) > pa.half * 0.6 + 1 || Math.abs(a.pos[2] - pa.cz) > pa.half * 0.6 + 1) inside = false;
    for (const b of L) if (a !== b) minGap = Math.min(minGap, Math.hypot(a.pos[0] - b.pos[0], a.pos[2] - b.pos[2]));
  }
  ok(L.length === 10, `10 pick-ups live (${L.length})`);
  ok(aglOk, 'each 250+ m over the ground and under the ceiling');
  ok(inside, 'each inside the middle 60 % of the play area');
  ok(minGap >= 1400, `at least ~1.5 km apart (closest ${minGap.toFixed(0)} m)`);
  const k = {}; for (const a of L) k[a.kind] = (k[a.kind] || 0) + 1;
  ok(k.repair >= 2 && k.missiles >= 2 && k.boost >= 2 && k.shield >= 2, `a mix of kinds ${JSON.stringify(k)}`);
}

// 2. collection by a fast jet's segment: 300 m/s passing 40 m off an item (the step's endpoints alone are > 45 m away at 30 Hz-ish
//    steps): it is collected once, with the right effect, and the item comes back elsewhere after ~10 s
{
  const { pu, ev } = setup();
  pu.start({ count: 4, dropEvery: 0, kinds: ['repair'] });
  const it = live(pu)[0], c = it.pos.slice(), f = fighter(3, [c[0] - 200, c[1] + 40, c[2]]);
  f.hp = 0.3;
  const big = 0.25;   // 75 m per step at 300 m/s: the segment test must catch it
  pu.step(big, [f]);
  for (let i = 0; i < 6; i++) { f.s.pos[0] += 300 * big; pu.step(big, [f]); }
  const picks = ev.filter((e) => e.type === 'pickup');
  ok(picks.length === 1 && picks[0].owner === 3 && picks[0].kind === 'repair', `collected once by the 300 m/s jet (${picks.length})`);
  ok(Math.abs(f.hp - 0.8) < 1e-9 && !it.alive, `repair +50 % (hp ${f.hp.toFixed(2)})`);
  const g = fighter(4, [c[0] - 200, c[1] + 60, c[2]]);   // 60 m off: missed
  const { pu: pu2, ev: ev2 } = setup(); pu2.start({ count: 1, kinds: ['repair'] });
  const it2 = pu2.items[0]; g.s.pos = [it2.pos[0] - 200, it2.pos[1] + 60, it2.pos[2]];
  for (let i = 0; i < 8; i++) { g.s.pos[0] += 75; pu2.step(big, [g]); }
  ok(!ev2.some((e) => e.type === 'pickup'), 'a pass 60 m off misses');
  const oldPos = c.slice();
  f.s.pos = far.slice();
  let back = NaN;
  for (let i = 0; i < 120 * 12 && Number.isNaN(back); i++) { pu.step(DT, [f]); if (it.alive) back = (i + 1) * DT; }
  ok(Math.abs(back - (PU.respawn - 1.5)) < 1.6, `back after ${back.toFixed(1)} s`);
  ok(Math.hypot(it.pos[0] - oldPos[0], it.pos[2] - oldPos[2]) > 1000, 'somewhere else');
  // a dead fighter collects nothing; a teleport (respawn) is not a segment
  const d = fighter(5, it.pos.slice()); d.alive = false; pu.step(DT, [d]);
  ok(it.alive, 'a dead fighter collects nothing');
}

// 3. effects: missiles / boost / shield, and the countdown of shield and boost for every fighter
{
  const { pu } = setup();
  pu.start({ count: 3, kinds: ['missiles', 'boost', 'shield'] });
  const f = fighter(1, far); f.missiles = 0; f.flares = 0; f.gunAmmo = 10;
  for (const it of pu.items.slice(0, 3)) { f.s.pos = it.pos.slice(); pu.step(DT, [f]); }
  ok(f.missiles === TUNE.missiles && f.flares === TUNE.flareBursts && f.gunAmmo === TUNE.gunAmmo, 'missiles: loadout refilled');
  ok(Math.abs(f.s.boost - (PU.boost - DT)) < 1e-6 || Math.abs(f.s.boost - PU.boost) < 0.02, `boost set (${f.s.boost.toFixed(3)} s)`);
  ok(Math.abs(f.shield - PU.shield) < 0.02, `shield set (${f.shield.toFixed(3)} s)`);
  const other = fighter(2, far); other.shield = 2; other.s.boost = 1;
  f.s.pos = far.slice();
  for (let i = 0; i < 120 * 3; i++) pu.step(DT, [f, other]);
  ok(Math.abs(f.shield - (PU.shield - 3)) < 0.03 && Math.abs(f.s.boost - (PU.boost - 3)) < 0.03, `counted down (shield ${f.shield.toFixed(2)}, boost ${f.s.boost.toFixed(2)})`);
  ok(other.shield === 0 && other.s.boost === 0, 'and stops at 0');
}

// 4. supply drop: dropIncoming after dropEvery, starts ~PU.dropStartAgl over the ground, falls ~PU.dropFall under the chute, can be grabbed in the
//    air (all four effects); a second one lands, stays ~20 s, then goes
{
  const { pu, ev } = setup();
  pu.start({ count: 0, dropEvery: 5 });
  const nobody = fighter(9, far);
  for (let i = 0; i < 120 * 5; i++) pu.step(DT, [nobody]);
  const inc = ev.filter((e) => e.type === 'dropIncoming');
  const d = pu.items.find((it) => it.alive && it.drop);
  ok(inc.length === 1 && d && d.kind === 'drop' && d.chute, 'dropIncoming after 5 s, falling under its chute');
  const agl0 = d.pos[1] - hills(d.pos[0], d.pos[2]);
  ok(agl0 > PU.dropStartAgl - 100 && agl0 < PU.dropStartAgl + 1000, `starts ${agl0.toFixed(0)} m over the ground`);
  const y0 = d.pos[1];
  for (let i = 0; i < 120 * 2; i++) pu.step(DT, [nobody]);
  ok(Math.abs((y0 - d.pos[1]) / 2 - PU.dropFall) < 0.1, `falls ${((y0 - d.pos[1]) / 2).toFixed(1)} m/s`);
  const f = fighter(1, [d.pos[0], d.pos[1] - 20, d.pos[2]]); f.hp = 0.2; f.missiles = 0;
  pu.step(DT, [f]);
  const p = ev.filter((e) => e.type === 'pickup');
  ok(p.length === 1 && p[0].kind === 'drop' && !d.alive, 'grabbed in the air');
  ok(Math.abs(f.hp - 0.7) < 1e-9 && f.missiles === TUNE.missiles && f.shield > 5.9 && f.s.boost > 5.9, 'the drop gives all four');
  // the next one: nobody takes it
  f.s.pos = far.slice();
  let land = NaN, gone = NaN, d2 = null;
  for (let i = 0; i < 120 * 200 && Number.isNaN(gone); i++) {
    pu.step(DT, [f]);
    d2 = d2 || pu.items.find((it) => it.alive && it.drop);
    if (d2 && Number.isNaN(land) && !d2.chute) land = i * DT;
    if (d2 && !Number.isNaN(land) && !d2.alive) gone = i * DT;
  }
  ok(!Number.isNaN(land) && Math.abs(d2.pos[1] - hills(d2.pos[0], d2.pos[2]) - PU.dropLand) < 0.01, `lands on the ground (${land.toFixed(0)} s)`);
  ok(Math.abs(gone - land - PU.dropStay) < 0.05, `stays ${(gone - land).toFixed(1)} s, then goes`);
  ok(pu.items.filter((it) => it.drop && it.alive).length <= PU.maxDrops, 'never more drops than the pool');
}

// 5. determinism: the same seed and paths give the same items and events; another seed a different layout; stop clears
{
  const run = (seed) => {
    const { pu, ev } = setup(seed);
    pu.start({ count: 8, dropEvery: 7 });
    const fs = [fighter(0, [pa.cx, 3500, pa.cz]), fighter(1, [pa.cx + 3000, 3600, pa.cz - 2000])];
    for (let i = 0; i < 120 * 40; i++) {
      for (const f of fs) { f.s.pos[0] += 2 * Math.sin(i / 900 + f.id); f.s.pos[2] -= 2; }
      if (i === 1200) for (const f of fs) { const it = pu.items.find((x) => x.alive); f.s.pos = it.pos.slice(); }
      pu.step(DT, fs);
    }
    return JSON.stringify({ items: pu.items.map((it) => [it.id, it.kind, it.alive, it.pos.map((v) => +v.toFixed(6))]), ev });
  };
  const a = run(11), b = run(11), c = run(12);
  ok(a === b, 'same seed, same run');
  ok(a !== c, 'another seed, another run');
  const { pu } = setup(); pu.start({ count: 5, dropEvery: 1 }); for (let i = 0; i < 200; i++) pu.step(DT, []);
  pu.stop();
  ok(pu.items.every((it) => !it.alive), 'stop clears every item');
  pu.start({ count: 5 }); const first = pu.items[0].pos.slice(); pu.start({ count: 5 });
  ok(first[0] !== pu.items[0].pos[0], 'each start lays them out anew');
}

// 6. no allocation in step beyond V8's boxed numbers (~25 B/step, like combat.js): 60 s of steps stay inside a small heap growth
{
  const { pu } = setup(); pu.start({ count: 10, dropEvery: 0 });
  const fs = Array.from({ length: 8 }, (_, k) => fighter(k, [pa.cx + k * 500, 3500, pa.cz]));
  for (let i = 0; i < 2000; i++) pu.step(DT, fs);
  global.gc?.();
  const h0 = process.memoryUsage().heapUsed;
  for (let i = 0; i < 120 * 60; i++) { for (const f of fs) f.s.pos[2] -= 1; pu.step(DT, fs); }
  const grow = process.memoryUsage().heapUsed - h0;
  ok(grow < 4e6, `heap +${(grow / 1024).toFixed(0)} kB over 60 s of steps`);
}

// 7. combat with a shield: guns at 400 m dead astern for 2 s do no damage while shield > 0 (shieldHit <= ~10 Hz); without it they do;
//    a crash still kills a shielded jet
{
  const flat = () => 0, env = { terrainHeightAt: flat };
  const run = (shield) => {
    const mk = (id, z) => ({ id, s: createJet({ pos: [0, 2000, z], heading: 0, speed: 250 }), ctl: { aim: [0, 0, -1], throttle: 0.84, gun: false, missile: false, flare: false } });
    const A = mk(0, 0), B = mk(1, -400), ev = [], c = createCombat({ terrainHeightAt: flat, seed: 1, onEvent: (e) => ev.push(e) });
    c.add(A); c.add(B); B.shield = shield;
    stepJet(A.s, A.ctl, DT, env); B.s.pos[1] = A.s.pos[1] + 400 * Math.tan(A.s.aoa);   // on the nose line (the AoA lifts the nose)
    A.ctl.gun = true;
    for (let i = 0; i < 240; i++) { stepJet(A.s, A.ctl, DT, env); stepJet(B.s, B.ctl, DT, env); c.step(DT); }
    return { B, ev, c };
  };
  const off = run(0), on = run(6);
  const hitsOn = on.ev.filter((e) => e.type === 'gunHit').length, sh = on.ev.filter((e) => e.type === 'shieldHit').length;
  ok(off.B.hp < 0.8, `no shield: hp ${off.B.hp.toFixed(2)} after 2 s of gun`);
  ok(on.B.hp === 1 && hitsOn > 5 && on.ev.every((e) => e.type !== 'gunHit' || e.shielded), `shield: hp 1 with ${hitsOn} hits (flagged shielded)`);
  ok(sh >= 5 && sh <= 21, `shieldHit rate-limited (${sh} in 2 s)`);
  on.B.s.crashed = true; on.c.step(DT);
  ok(!on.B.alive && on.ev.some((e) => e.type === 'kill' && e.victim === 1 && e.cause === 'crash'), 'a shielded jet still dies on the ground');
}

// 8. ai.js PICKUP: a hurt AI (or one out of missiles) with an enemy far ahead detours to a power-up 3 km off to the side; a healthy one
//    does not; one with the enemy on its tail does not
{
  const env = { terrainHeightAt: () => 0, playArea: { cx: 0, cz: 0, half: 30000, ceiling: 8000 } };
  const run = (hp, missiles, enemyBehind, at = [2500, 2100, -1500]) => {
    const pu = createPowerups({ terrainHeightAt: () => 0, playArea: env.playArea, seed: 3 });
    const mk = (id, pos, h) => ({ id, alive: true, hp: 1, shield: 0, missiles: 4, flares: 3, gunAmmo: 400, s: createJet({ pos, heading: h, speed: 250 }),
      ctl: { aim: [0, 0, -1], throttle: 0.84 }, lock: { target: -1, progress: 0, locked: false }, warn: { missile: false, dir: [0, 0, 0], dist: 0 } });
    const me = mk(1, [0, 2000, 0], 0), foe = mk(2, enemyBehind ? [0, 2000, 1200] : [0, 2000, -12000], 0);
    me.hp = hp; me.missiles = missiles;
    pu.start({ count: 1, kinds: ['repair'] });
    const it = pu.items[0]; it.pos[0] = at[0]; it.pos[1] = at[1]; it.pos[2] = at[2];
    const ai = createAI(me, { skill: 'easy', env, seed: 5, pickups: pu.items });
    let got = false, wentPickup = false;
    for (let i = 0; i < 120 * 25 && !got; i++) {
      ai.think(DT, foe); wentPickup ||= ai.state === 'pickup';
      stepJet(me.s, me.ctl, DT, env); stepJet(foe.s, foe.ctl, DT, env);
      pu.step(DT, [me]); got = !it.alive;
    }
    return { got, wentPickup };
  };
  const hurt = run(0.3, 4, false), dry = run(1, 0, false), fine = run(1, 4, false), chased = run(0.3, 4, true);
  ok(hurt.wentPickup && hurt.got, `hurt: detours and collects (${JSON.stringify(hurt)})`);
  ok(dry.wentPickup && dry.got, `out of missiles: detours and collects (${JSON.stringify(dry)})`);
  ok(!fine.wentPickup, 'healthy with missiles: no detour');
  ok(!chased.wentPickup, 'an enemy on its tail: no detour');
  const ahead = run(1, 4, false, [150, 2060, -1200]);
  ok(ahead.wentPickup && ahead.got, `healthy: snags one close ahead (${JSON.stringify(ahead)})`);
}

console.log(fails ? `\n${fails} FAILED` : '\nall ok');
process.exit(fails ? 1 : 0);
