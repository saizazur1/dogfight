// ai.check.mjs -- node js/ai.check.mjs [seeds]: the AI pilot over N seeds, on a synthetic ridged terrain and (if the PNG is
// here) the real DEM: AI vs a scripted straight / turning target, and AI vs AI. Tables of kill rate, time to kill, crash
// rate, shots. Exit 1 if a hard requirement fails (crashes on Medium / Hard, Medium-vs-Medium fights that never end,
// skill order, NaN, determinism).
import { readFileSync, existsSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { createJet, stepJet } from './flight.js';
import { createCombat, TUNE as CT } from './combat.js';
import { createAI } from './ai.js';
import { mulberry32 } from './rng.js';
import { WORLD_FRAME } from './jetspec.js';

const DT = 1 / 120, N = +(process.argv[2] || 12);   // 12 seeds ~15 s; 24 for the report
let fails = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'}  ${msg}`); if (!cond) fails++; };

// ---- terrains
// ridged: valleys ~300 m, crests to ~2,100 m, ridges every ~5-10 km, meandering
const ridged = (x, z) => {
  const r = 1 - Math.abs(Math.sin(x / 3100 + 0.8 * Math.sin(z / 4700))), q = 1 - Math.abs(Math.sin(z / 3700 + 0.6 * Math.sin(x / 5300)));
  return 300 + 1300 * r * r * (0.65 + 0.35 * Math.cos(z / 2900)) + 500 * q * q * q;
};
const SYN = { name: 'ridged', th: ridged, area: { cx: 0, cz: 0, half: 15000, ceiling: 6000 }, spawnY: (th, x, z) => Math.max(2400, th(x, z) + 900) };

// the real DEM (decoder from ~/SalesLeagueBoxingProto/web/js/jetplan.check.mjs L19-54, jetworld.js's placement; without
// jetworld's fine detail noise, so the ground is within ~tens of metres of the drawn one)
function loadDem() {
  const png = new URL('../assets/terrain/hunza_cop30_n36e074.png', import.meta.url);
  if (!existsSync(png)) return null;
  const meta = JSON.parse(readFileSync(new URL('../assets/terrain/hunza_cop30_n36e074.json', import.meta.url), 'utf8'));
  const buf = readFileSync(png), dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let p = 8, W = 0, H = 0; const idat = [];
  while (p < buf.length) {
    const n = dv.getUint32(p), type = buf.toString('latin1', p + 4, p + 8);
    if (type === 'IHDR') { W = dv.getUint32(p + 8); H = dv.getUint32(p + 12); } else if (type === 'IDAT') idat.push(buf.subarray(p + 8, p + 8 + n)); else if (type === 'IEND') break;
    p += 12 + n;
  }
  const raw = inflateSync(Buffer.concat(idat)), st = W * 2, img = new Uint8Array(H * st);
  for (let y = 0; y < H; y++) {
    const f = raw[y * (st + 1)], r0 = y * (st + 1) + 1, o = y * st, u = o - st;
    for (let i = 0; i < st; i++) {
      const x = raw[r0 + i], a = i >= 2 ? img[o + i - 2] : 0, b = y ? img[u + i] : 0, c = i >= 2 && y ? img[u + i - 2] : 0;
      let v;
      if (f === 0) v = x; else if (f === 1) v = x + a; else if (f === 2) v = x + b; else if (f === 3) v = x + ((a + b) >> 1);
      else { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
      img[o + i] = v & 255;
    }
  }
  const DEG = Math.PI / 180, SITE = WORLD_FRAME.anchor.demPx, k = (meta.max_m - meta.min_m) / 65535, base = meta.min_m - WORLD_FRAME.datum;
  const lat0 = meta.north_lat - (SITE[1] / (H - 1)) * (meta.north_lat - meta.south_lat);
  const dx = (111320 * Math.cos(lat0 * DEG) * (meta.east_lon - meta.west_lon)) / (W - 1), dz = (110574 * (meta.north_lat - meta.south_lat)) / (H - 1);
  const hAt = (x, y) => base + ((img[(y * W + x) * 2] << 8) | img[(y * W + x) * 2 + 1]) * k;
  const cl = (v, a, b) => (v < a ? a : v > b ? b : v), CURVE = 0.87 / (2 * 6371000);
  return (x, z) => {
    const fx = cl(x / dx + SITE[0], 0, W - 2), fz = cl(z / dz + SITE[1], 0, H - 2), i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j;
    return (hAt(i, j) * (1 - u) + hAt(i + 1, j) * u) * (1 - v) + (hAt(i, j + 1) * (1 - u) + hAt(i + 1, j + 1) * u) * v - (x * x + z * z) * CURVE;
  };
}
let DEM = null;
try { const th = loadDem(); if (th) DEM = { name: 'DEM', th, area: { cx: -5500, cz: -3000, half: 15000, ceiling: 6000 }, spawnY: (t, x, z) => Math.min(5200, t(x, z) + 900) }; } catch (e) { console.log('DEM not loaded:', e.message); }

// ---- one fight. pilot = 'easy'|'medium'|'hard'|'straight'|'turn'
function fight(T, pa, pb, seed, maxT = 180, gunDuel = false) {
  const R = mulberry32(seed * 7919 + 13), ang = R() * Math.PI * 2, sep = 7000 + R() * 3000, off = (R() - 0.5) * 3000;
  const cx = T.area.cx + (R() - 0.5) * 6000, cz = T.area.cz + (R() - 0.5) * 6000, ca = Math.cos(ang), sa = Math.sin(ang);
  const place = (side) => {
    const lx = side * sep / 2, lz = side * off / 2, x = cx + lx * ca - lz * sa, z = cz + lx * sa + lz * ca;
    return { pos: [x, T.spawnY(T.th, x, z) + (pa === 'straight' || pa === 'turn' || pb === 'straight' || pb === 'turn' ? 600 : 0), z], heading: Math.atan2(cx - x, -(cz - z)), speed: 230 };
  };
  const env = { terrainHeightAt: T.th, playArea: T.area };
  const ev = [], combat = createCombat({ terrainHeightAt: T.th, seed, onEvent: (e) => ev.push(e) });
  const mk = (id, pilot, sp) => {
    const f = { id, name: pilot, isAI: true, s: createJet(sp), ctl: { aim: [Math.sin(sp.heading), 0, -Math.cos(sp.heading)], throttle: 0.84, ab: false, gun: false, missile: false, flare: false } };
    combat.add(f);
    f.ai = SCRIPTED.includes(pilot) ? null : createAI(f, { skill: pilot, env, combat, seed: seed * 31 + id });
    f.pilot = pilot;
    return f;
  };
  const A = mk(0, pa, place(-1)), B = mk(1, pb, place(1));
  if (gunDuel) {   // A 600 m behind B, same heading and speed, no missiles: the gun alone
    const h = B.s.vel, l = Math.hypot(h[0], h[2]);
    A.s = createJet({ pos: [B.s.pos[0] - h[0] / l * 600, B.s.pos[1], B.s.pos[2] - h[2] / l * 600], heading: Math.atan2(h[0], -h[2]), speed: 230 });
    A.missiles = 0;
  }
  let nan = false, i = 0;
  const steps = Math.round(maxT / DT);
  for (; i < steps && A.alive && B.alive; i++) {
    for (const [f, g] of [[A, B], [B, A]]) f.ai ? f.ai.think(DT, g) : script(f, i * DT, env);
    stepJet(A.s, A.ctl, DT, env); stepJet(B.s, B.ctl, DT, env);
    combat.step(DT);
    if (!Number.isFinite(A.s.pos[0] + A.s.pos[1] + B.s.pos[0] + B.s.pos[1])) { nan = true; break; }
  }
  const kill = ev.find((e) => e.type === 'kill');
  const shots = (id) => ({ missiles: ev.filter((e) => e.type === 'missileFired' && e.owner === id).length, rounds: CT.gunAmmo - [A, B][id].gunAmmo,
    mHits: ev.filter((e) => e.type === 'missileHit' && e.target !== id && ev.find((m) => m.type === 'missileFired' && m.missile === e.missile)?.owner === id).length,
    gHits: ev.filter((e) => e.type === 'gunHit' && e.owner === id).length });
  return { winner: kill ? (kill.victim === 0 ? 1 : 0) : -1, victim: kill ? kill.victim : -1, cause: kill?.cause, t: i * DT, nan, A: shots(0), B: shots(1), hash: [...A.s.pos, ...B.s.pos, ev.length].join() };
}
const SCRIPTED = ['straight', 'turn'];
// scripted targets: level at their height (climb if the ground comes up); 'turn' = 4 g level turns, 12 s each way
function script(f, t, env) {
  const s = f.s, v = s.speed || 1, F = [s.vel[0] / v, 0, s.vel[2] / v], h = Math.hypot(F[0], F[2]) || 1;
  const ahead = env.terrainHeightAt(s.pos[0] + s.vel[0] * 4, s.pos[2] + s.vel[2] * 4);
  let y = s.pos[1] < ahead + 500 ? 0.4 : 0;
  if (f.pilot === 'turn') {
    const side = Math.floor(t / 12) % 2 ? 1 : -1, k = Math.tan(30 * Math.PI / 180);
    f.ctl.aim[0] = F[0] / h - side * F[2] / h * k; f.ctl.aim[2] = F[2] / h + side * F[0] / h * k;
  } else { f.ctl.aim[0] = F[0] / h; f.ctl.aim[2] = F[2] / h; }
  f.ctl.aim[1] = y; const l = Math.hypot(...f.ctl.aim); for (let j = 0; j < 3; j++) f.ctl.aim[j] /= l;
  f.ctl.throttle = 0.84;
}

// ---- the runs
const pct = (a, b) => `${Math.round((100 * a) / Math.max(1, b))} %`;
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
let anyNaN = false;
const crashRate = {};
for (const T of [SYN, DEM].filter(Boolean)) {
  // AI vs scripted
  const rows = [];
  for (const skill of ['easy', 'medium', 'hard']) for (const tgt of SCRIPTED) {
    let kills = 0, crashes = 0; const tk = [], ms = [], rd = [], mh = [], gh = [];
    for (let k = 0; k < N; k++) {
      const r = fight(T, skill, tgt, 100 + k, 120);
      anyNaN ||= r.nan;
      if (r.winner === 0 && r.cause !== 'crash') { kills++; tk.push(r.t); }
      if (r.victim === 0 && r.cause === 'crash') crashes++;
      ms.push(r.A.missiles); rd.push(r.A.rounds); mh.push(r.A.mHits); gh.push(r.A.gHits);
    }
    if (tgt === 'turn') {   // and the gun alone, from 600 m behind
      let gk = 0, rds = 0, hits = 0; const gt = [];
      for (let k = 0; k < N; k++) { const r = fight(T, skill, tgt, 300 + k, 60, true); rds += r.A.rounds; hits += r.A.gHits; if (r.winner === 0) { gk++; gt.push(r.t); } }
      rows.push({ AI: skill, vs: 'turn, gun only from 600 m', kills: pct(gk, N), 'time to kill': gt.length ? `${avg(gt).toFixed(0)} s` : '-', crashes: '-', 'missiles fired': '-', 'missile hits': '-', rounds: (rds / N).toFixed(0), 'gun hits': `${(hits / N).toFixed(1)} (${pct(hits, rds)} of rounds)` });
    }
    (crashRate[skill] ||= []).push(crashes / N);
    rows.push({ AI: skill, vs: tgt, kills: pct(kills, N), 'time to kill': tk.length ? `${avg(tk).toFixed(0)} s` : '-', crashes: pct(crashes, N),
      'missiles fired': avg(ms).toFixed(1), 'missile hits': avg(mh).toFixed(2), rounds: avg(rd).toFixed(0), 'gun hits': avg(gh).toFixed(1) });
  }
  console.log(`\n${T.name}: AI vs a scripted target (${N} seeds, 120 s)`); console.table(rows);
  // AI vs AI
  const rows2 = [], res = {};
  for (const [a, b] of [['medium', 'medium'], ['hard', 'easy'], ['hard', 'medium'], ['medium', 'easy'], ['easy', 'easy'], ['hard', 'hard']]) {
    let wa = 0, wb = 0, none = 0, crashes = 0, crashA = 0, crashB = 0; const ts = [], cause = {};
    for (let k = 0; k < N; k++) {
      const r = fight(T, a, b, 500 + k, 180);
      anyNaN ||= r.nan;
      if (r.winner === 0) wa++; else if (r.winner === 1) wb++; else none++;
      if (r.winner >= 0) { ts.push(r.t); cause[r.cause] = (cause[r.cause] || 0) + 1; }
      if (r.cause === 'crash') { crashes++; if (r.victim === 0) crashA++; else crashB++; }
    }
    (crashRate[a] ||= []).push(crashA / N); (crashRate[b] ||= []).push(crashB / N);
    res[`${a}-${b}`] = { wa, wb, none };
    rows2.push({ A: a, B: b, 'A wins': wa, 'B wins': wb, 'no result (3 min)': none, 'mean time': ts.length ? `${avg(ts).toFixed(0)} s` : '-', 'by': Object.entries(cause).map(([k, v]) => `${k} ${v}`).join(', '), crashes });
  }
  console.log(`\n${T.name}: AI vs AI (${N} seeds, <= 180 s)`); console.table(rows2);
  const mm = res['medium-medium'];
  ok(mm.wa + mm.wb >= Math.ceil(N * 0.75), `${T.name}: Medium vs Medium ends within 3 min in ${mm.wa + mm.wb}/${N} (>= 75 %)`);
  ok(res['hard-easy'].wa > res['hard-easy'].wb * 2, `${T.name}: Hard beats Easy (${res['hard-easy'].wa} - ${res['hard-easy'].wb})`);
  ok(res['hard-medium'].wa >= res['hard-medium'].wb, `${T.name}: Hard >= Medium (${res['hard-medium'].wa} - ${res['hard-medium'].wb})`);
}
for (const [k, v] of Object.entries(crashRate)) {
  const mx = Math.max(...v);
  ok(k === 'easy' ? mx <= 0.2 : mx <= 0.05, `crash rate ${k}: worst run ${Math.round(mx * 100)} % (limit ${k === 'easy' ? 20 : 5} %)`);
}
ok(!anyNaN, 'no NaN in any fight');
const d1 = fight(SYN, 'medium', 'hard', 9, 60), d2 = fight(SYN, 'medium', 'hard', 9, 60);
ok(d1.hash === d2.hash, 'determinism: the same seed flies the same fight');
console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
