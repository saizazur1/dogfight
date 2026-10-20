// race.check.mjs -- node js/race.check.mjs: the Valley Run course on a synthetic ridged terrain and (if the PNG is here) the
// real DEM: every ring over the ground, every leg clear, turns and slopes in limits, all inside the play area, determinism;
// then flies it with flight.js and a simple autopilot (aim at the next ring, lead in along its normal). Exit 1 on a failure.
import { readFileSync, existsSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { createJet, stepJet } from './flight.js';
import { makeCourse, passRing, carrotAim, fmtTime, courseFits, COURSE, VALLEY_RUN } from './race.js';
import { WORLD_FRAME } from './jetspec.js';

const DT = 1 / 120, D2R = Math.PI / 180;
let fails = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'}  ${msg}`); if (!cond) fails++; };

// ---- terrains (ai.check.mjs's)
const ridged = (x, z) => {
  const r = 1 - Math.abs(Math.sin(x / 3100 + 0.8 * Math.sin(z / 4700))), q = 1 - Math.abs(Math.sin(z / 3700 + 0.6 * Math.sin(x / 5300)));
  return 300 + 1300 * r * r * (0.65 + 0.35 * Math.cos(z / 2900)) + 500 * q * q * q;
};
function loadDem() {   // ai.check.mjs's decoder + jetworld.js's placement (no fine detail noise: within ~tens of metres)
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
const T = [{ name: 'ridged', th: ridged, area: { cx: 0, cz: 0, half: 15000, ceiling: 6000 }, start: { pos: [0, 0, 6000], heading: 0 } }];
try { const th = loadDem(); if (th) T.push({ name: 'DEM', th, area: { cx: -5500, cz: -3000, half: 15000, ceiling: 6000 }, start: { pos: [4250, 900, 4500], heading: 310 * D2R } }); }   // jetworld's PLAY / SPAWN
catch (e) { console.log('DEM not loaded:', e.message); }

// ---- fly it with race.js's carrotAim (the in-game ?autopilot=1)
function fly(th, area, course, thr = 0.88) {
  const s = createJet(course.start), env = { terrainHeightAt: th, playArea: area };
  const ctl = { aim: [0, 0, -1], throttle: thr, ab: false, pitch: 0, roll: 0, yaw: 0 };
  const a = [0, 0, 0], N = course.rings.length;
  let next = 0, t0 = -1, minAgl = 1e9;
  while (s.t < 400 && !s.crashed && next < N) {
    const r = course.rings[next], B = r.pos;
    carrotAim(course, next, s.pos, ctl.aim);
    const d = Math.hypot(B[0] - s.pos[0], B[1] - s.pos[1], B[2] - s.pos[2]);
    for (let j = 0; j < 3; j++) a[j] = s.pos[j];
    stepJet(s, ctl, DT, env);
    minAgl = Math.min(minAgl, s.pos[1] - th(s.pos[0], s.pos[2]));
    if (passRing(a, s.pos, r)) { if (next === 0) t0 = s.t; next++; }
    if (process.env.TRACE && Math.round(s.t * 120) % 60 === 0) console.log(`  t ${s.t.toFixed(1)} ring ${next} d ${d.toFixed(0)} y ${s.pos[1].toFixed(0)} agl ${(s.pos[1] - th(s.pos[0], s.pos[2])).toFixed(0)} v ${s.speed.toFixed(0)} g ${s.gLoad.toFixed(1)} pullUp ${s.warn.pullUp}`);
  }
  return { passed: next, crashT: s.crashed ? s.t : 0, crashed: s.crashed, lap: next === course.rings.length ? s.t - t0 : NaN, minAgl, t: s.t };
}

for (const { name, th, area, start } of T) {
  console.log(`\n== ${name}`);
  const t1 = performance.now(), gen = makeCourse(th, area, start, VALLEY_RUN.seed), ms = performance.now() - t1;
  ok(!!gen, `makeCourse found a course (${ms.toFixed(0)} ms)`);
  if (!gen) continue;
  const r1 = (v) => Math.round(v * 10) / 10;
  if (name === 'DEM') ok(gen.rings.every((r, i) => r.pos.every((v, j) => r1(v) === VALLEY_RUN.rings[i]?.pos[j])) && gen.rings.length === VALLEY_RUN.rings.length, 'the baked VALLEY_RUN is makeCourse(DEM, seed) (re-bake if not)');
  const c = name === 'DEM' ? VALLEY_RUN : gen;
  ok(courseFits(th, c).ok, 'courseFits');
  const R = c.rings, legs = [];
  let minClr = 1e9, minRing = 1e9, maxTurn = 0, maxSlope = 0, minD = 1e9, maxD = 0, inside = true, ap = 1e9;
  const clr = (a, b) => { let m = 1e9; for (let i = 0; i <= 200; i++) { const u = i / 200; m = Math.min(m, a[1] + (b[1] - a[1]) * u - th(a[0] + (b[0] - a[0]) * u, a[2] + (b[2] - a[2]) * u)); } return m; };
  R.forEach((r, i) => {
    const a = i ? R[i - 1].pos : c.start.pos, b = r.pos, d = Math.hypot(b[0] - a[0], b[2] - a[2]);
    legs.push([b[0] - a[0], b[2] - a[2]]);
    minClr = Math.min(minClr, clr(a, b)); minRing = Math.min(minRing, b[1] - th(b[0], b[2]));
    maxSlope = Math.max(maxSlope, Math.abs(b[1] - a[1]) / d);
    if (i) { minD = Math.min(minD, d); maxD = Math.max(maxD, d); }
    inside &&= Math.abs(b[0] - area.cx) < area.half && Math.abs(b[2] - area.cz) < area.half;
    for (let j = 0; j < i - 1; j++) ap = Math.min(ap, Math.hypot(b[0] - R[j].pos[0], b[2] - R[j].pos[2]));
  });
  for (let i = 1; i < legs.length; i++) { const [x0, z0] = legs[i - 1], [x1, z1] = legs[i]; maxTurn = Math.max(maxTurn, Math.abs(Math.atan2(x0 * z1 - z0 * x1, x0 * x1 + z0 * z1)) / D2R); }
  const radii = R.map((r) => r.radius);
  console.log(`  ${R.length} rings, ${(c.length / 1000).toFixed(1)} km, legs ${(minD / 1000).toFixed(2)}-${(maxD / 1000).toFixed(2)} km, radii ${[...new Set(radii)].sort().join('/')} (${radii.filter((r) => r > COURSE.radius).length} big, ${radii.filter((r) => r < COURSE.radius).length} tight)`);
  console.log(`  ring heights ${R.map((r) => Math.round(r.pos[1] - th(r.pos[0], r.pos[2]))).join(' ')} m AGL`);
  ok(R.length >= 14 && R.length <= 18, `14-18 rings (${R.length})`);
  ok(minRing >= 120, `every ring >= 120 m over the ground (min ${minRing.toFixed(0)})`);
  ok(minClr >= 50, `every leg clear of the terrain by >= 50 m (min ${minClr.toFixed(0)}, start run included)`);
  ok(maxTurn <= 60, `turns <= 60 deg (max ${maxTurn.toFixed(0)})`);
  ok(maxSlope <= 0.2, `slopes <= 0.2 (max ${maxSlope.toFixed(2)})`);
  ok(minD >= 1200 && maxD <= 2500, `spacing 1.2-2.5 km`);
  ok(inside, 'all rings inside the play area');
  ok(ap >= 1500, `non-neighbour rings >= 1.5 km apart (min ${ap.toFixed(0)})`);
  ok(JSON.stringify(makeCourse(th, area, start, VALLEY_RUN.seed)) === JSON.stringify(gen), 'deterministic from the seed');
  // fly it at three throttles, and over a bumpier ground (±45 m: the live ground's detail noise the DEM here lacks)
  const bumpy = (x, z) => th(x, z) + 30 * Math.sin(x / 310 + 1.3) * Math.cos(z / 270) + 15 * Math.sin(z / 130 - x / 170);
  for (const [t, thr, label] of [[th, 0.7, 'throttle 0.70'], [th, 0.88, 'throttle 0.88'], [th, 0.95, 'throttle 0.95'], [bumpy, 0.88, 'bumpy ground, 0.88']]) {
    const f = fly(t, area, c, thr);
    const line = `autopilot ${label}:`;
    if (name !== 'DEM' && thr > 0.9) { console.log(`info  ${line} ${f.passed}/${R.length} rings, ${f.crashed ? 'CRASHED' : 'no crash'} (generated course: the 0.95 run is required on the real map only)`); continue; }
    ok(f.passed === R.length && !f.crashed, `autopilot ${label}: ${f.passed}/${R.length} rings, ${f.crashed ? 'CRASHED' : 'no crash'}, lap ${isNaN(f.lap) ? '-' : fmtTime(f.lap)}, min AGL ${f.minAgl.toFixed(0)} m`);
  }
}
// passRing: front-to-back only, inside the radius
const ring = { pos: [0, 0, 0], normal: [0, 0, 1], radius: 50 };
ok(passRing([0, 0, -1], [0, 0, 1], ring) && !passRing([0, 0, 1], [0, 0, -1], ring) && !passRing([60, 0, -1], [60, 0, 1], ring) && passRing([30, 30, -1], [30, 30, 1], ring), 'passRing: direction and radius');
console.log(fails ? `\n${fails} FAILED` : '\nall ok');
process.exit(fails ? 1 : 0);
