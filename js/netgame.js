/**
 * netgame.js — the online match's sync (README "Online contract", lane NET). Pure: no three.js, no DOM (net.check.mjs runs the
 * codec, the sampler and the trigger counters in node). game.js creates one controller per online match:
 *
 *   const ng = createNetGame(api, net, cfg);   // api: game.js internals (below); net: net.js; cfg: net.start's cfg
 *   ng.preStep(dt)    every 120 Hz step, before stepJet   (host: remote players' states and triggers onto their fighters)
 *   ng.postStep(dt)   every step, after mode.step         (host: events + snapshot at 20 Hz; client: my state + trigger counts at 30 Hz)
 *   ng.frame(frameDt) every display frame, first          (client: every other jet from the snapshot buffer, missiles, tracers, flares)
 *   ng.onEvent(e)     host: every event (queued for the clients, in order; 'match' stays local)
 *   ng.mirror         client: { missiles, bullets, flares } in combat.js's shape for weaponfx / hud / radar / sound / ai
 *   ng.pu             client: { items } in powerups.js's shape for powerupfx / radar
 *   ng.view           client: { phase, clock, seats[8] } for chaos.js's online client
 *   ng.respawn(f, start)   host: tells a remote player to place its own jet;  ng.sendRoster();  ng.leaveMatch();  ng.stop()
 *
 * Wire (PeerJS binary serialization; a typed message is an ArrayBuffer whose first byte is its type, the rest are small objects):
 *   host → clients  SNAP (20 Hz, ~0.5–1 KB): phase, clock, host time; per fighter pos (f32) vel / q / model (int16 / int8), hp, ammo,
 *                   lock, warn, shield, boost, kills, deaths, life; live missiles; live pick-ups.
 *                   {k:'ev', l:[events]} just before each SNAP (every event since the last one, in order);
 *                   {k:'respawn', pos, heading, speed, life}; {k:'roster', seats}; {k:'abort'}
 *   client → host   STATE (30 Hz, 64 B): its jet (pos, vel, q, model), life, crashed, gun held, missile / flare press COUNTS;
 *                   {k:'quit'} (left the match, stays in the room)
 * A press is a count, never a flag: the host turns each new count into one rising edge for combat (one per 2 steps), so a press
 * is never lost (reliable channel) and never doubled. `life` (bumped by every placement) keeps an old life's packets (a crash, a
 * position) away from the new one.
 * Client view: other jets are drawn NET_DELAY (100 ms) behind the host's clock, Hermite-interpolated between snapshots
 * (extrapolated with the velocity and spin if the buffer runs dry). Missiles: the newest snapshot moved along their velocity to the
 * same time (mine to "now", so they leave my rails). Tracers and flares are made locally (no damage): tracers from each firing
 * jet's gun bit (mine from my trigger), flares from the host's flare events. The host's clock is estimated per peer (max filter
 * of send time − arrival time). The host flies remote players at their own clock "now" (extrapolated), so what the host shoots at
 * is where they are drawn.
 */
import { qRot, ANCHORS, G } from './jetspec.js';
import { TUNE as CT } from './combat.js';

export const SNAP = 1, STATE = 2;
export const SEATS = 8, MAX_M = 32, MAX_I = 19;
export const NET_DELAY = 0.1;              // s: other jets are drawn this far behind the host's clock (two snapshots of slack)
const SNAP_EVERY = 6, STATE_EVERY = 4;     // steps (120 Hz): 20 Hz snapshots, 30 Hz client states
const PHASES = ['count', 'fight', 'over'];
const KIND = ['repair', 'missiles', 'boost', 'shield', 'drop'];
const MODEL = ['throttle', 'ab', 'aoa', 'gLoad', 'stickX', 'stickY', 'yaw', 'brake'];
export const F_BYTES = 48, M_BYTES = 26, I_BYTES = 18, SNAP_MAX = 17 + SEATS * F_BYTES + 2 + MAX_M * M_BYTES + MAX_I * I_BYTES, STATE_BYTES = 64;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const u8 = (v) => clamp(Math.round(v * 255), 0, 255);
const s8 = (v, k) => clamp(Math.round(v * k), -127, 127);
const s16 = (v, k) => clamp(Math.round(v * k), -32767, 32767);
const fin = (v) => (Number.isFinite(v) ? v : 0);

// ------------------------------------------------------------------------------------------------- codec (allocation-free)
/** A decode target for snapshots (all pools preallocated). */
export function makeSnapshot() {
  const f = [], m = [], items = [];
  for (let i = 0; i < SEATS; i++) {
    f.push({ seat: 0, alive: false, isAI: false, locked: false, gun: false, warn: false, life: 0, hp: 0, missiles: 0, flares: 0, gunAmmo: 0,
      lockTarget: -1, lockProgress: 0, shield: 0, boost: 0, kills: 0, deaths: 0, pos: [0, 0, 0], vel: [0, 0, 0], q: [0, 0, 0, 1],
      throttle: 0, ab: 0, aoa: 0, gLoad: 1, stickX: 0, stickY: 0, yaw: 0, brake: 0 });
  }
  for (let i = 0; i < MAX_M; i++) m.push({ id: 0, owner: -1, target: -1, decoy: -1, motor: 0, age: 0, pos: [0, 0, 0], vel: [0, 0, 0] });
  for (let i = 0; i < MAX_I; i++) items.push({ idx: 0, id: 0, kind: 'repair', drop: false, chute: false, age: 0, pos: [0, 0, 0] });
  return { type: SNAP, phase: 'count', seq: 0, t: 0, clock: 0, nF: 0, f, nM: 0, m, nI: 0, items };
}

/**
 * Writes a snapshot. h = { phase, seq, t (host clock, s), clock (match s left) }; fighters = README fighter records (f.id = seat);
 * score = { kills: number[8], deaths: number[8] } by seat; missiles = combat.missiles; items = pu.items or null.
 * @returns {number} bytes written
 */
export function encodeSnapshot(dv, h, fighters, score, missiles, items) {
  let o = 0;
  dv.setUint8(o, SNAP); dv.setUint8(o + 1, Math.max(0, PHASES.indexOf(h.phase))); dv.setUint16(o + 2, h.seq & 0xffff);
  dv.setFloat64(o + 4, h.t); dv.setFloat32(o + 12, fin(h.clock));
  const nF = Math.min(SEATS, fighters.length);
  dv.setUint8(o + 16, nF); o = 17;
  for (let i = 0; i < nF; i++) {
    const f = fighters[i], s = f.s, L = f.lock, id = f.id;
    const fl = (f.alive ? 1 : 0) | (f.isAI ? 2 : 0) | (L && L.locked ? 4 : 0) | (f.alive && f.ctl && f.ctl.gun && f.gunAmmo > 0 ? 8 : 0) | (f.warn && f.warn.missile ? 16 : 0);
    dv.setUint8(o, id); dv.setUint8(o + 1, fl); dv.setUint8(o + 2, (f.life || 0) & 255); dv.setUint8(o + 3, u8(f.hp ?? 1));
    dv.setUint8(o + 4, clamp(f.missiles | 0, 0, 255)); dv.setUint8(o + 5, clamp(f.flares | 0, 0, 255)); dv.setUint16(o + 6, clamp(f.gunAmmo | 0, 0, 65535));
    dv.setInt8(o + 8, L ? clamp(L.target, -1, 127) : -1); dv.setUint8(o + 9, L ? u8(L.progress) : 0);
    dv.setUint8(o + 10, clamp(Math.round((f.shield || 0) * 20), 0, 255)); dv.setUint8(o + 11, clamp(Math.round((s.boost || 0) * 20), 0, 255));
    dv.setUint8(o + 12, clamp(score ? score.kills[id] | 0 : 0, 0, 255)); dv.setUint8(o + 13, clamp(score ? score.deaths[id] | 0 : 0, 0, 255));
    o += 14;
    for (let j = 0; j < 3; j++) dv.setFloat32(o + j * 4, fin(s.pos[j]));
    o += 12;
    for (let j = 0; j < 3; j++) dv.setInt16(o + j * 2, s16(fin(s.vel[j]), 50));
    o += 6;
    for (let j = 0; j < 4; j++) dv.setInt16(o + j * 2, s16(fin(s.q[j]), 32767));
    o += 8;
    dv.setUint8(o, u8(s.throttle)); dv.setUint8(o + 1, u8(s.ab)); dv.setInt8(o + 2, s8(fin(s.aoa), 200)); dv.setInt8(o + 3, s8(fin(s.gLoad), 12));
    dv.setInt8(o + 4, s8(fin(s.stickX), 127)); dv.setInt8(o + 5, s8(fin(s.stickY), 127)); dv.setInt8(o + 6, s8(fin(s.yaw), 127)); dv.setUint8(o + 7, u8(s.brake || 0));
    o += 8;
  }
  const mAt = o; let nM = 0; o++;
  for (let i = 0; i < missiles.length && nM < MAX_M; i++) {
    const m = missiles[i];
    if (!m.alive) continue;
    nM++;
    dv.setUint16(o, m.id & 0xffff); dv.setUint8(o + 2, clamp(m.owner, 0, 255)); dv.setInt8(o + 3, clamp(m.target, -1, 127));
    dv.setInt8(o + 4, clamp(m.decoy, -1, 127)); dv.setUint8(o + 5, u8(m.motor)); dv.setUint16(o + 6, clamp(Math.round(m.age * 1000), 0, 65535));
    o += 8;
    for (let j = 0; j < 3; j++) dv.setFloat32(o + j * 4, fin(m.pos[j]));
    o += 12;
    for (let j = 0; j < 3; j++) dv.setInt16(o + j * 2, s16(fin(m.vel[j]), 32));
    o += 6;
  }
  dv.setUint8(mAt, nM);
  const iAt = o; let nI = 0; o++;
  if (items) for (let i = 0; i < items.length && nI < MAX_I; i++) {
    const it = items[i];
    if (!it.alive) continue;
    nI++;
    dv.setUint8(o, i); dv.setUint16(o + 1, it.id & 0xffff);
    dv.setUint8(o + 3, Math.max(0, KIND.indexOf(it.kind)) | (it.drop ? 16 : 0) | (it.chute ? 32 : 0));
    for (let j = 0; j < 3; j++) dv.setFloat32(o + 4 + j * 4, fin(it.pos[j]));
    dv.setUint16(o + 16, clamp(Math.round((it.age || 0) * 10), 0, 65535));
    o += I_BYTES;
  }
  dv.setUint8(iAt, nI);
  return o;
}

/** Reads a snapshot into `out` (makeSnapshot()). Throws on a short or foreign buffer (the caller drops the packet). */
export function decodeSnapshot(dv, out) {
  if (dv.getUint8(0) !== SNAP) throw new Error('not a snapshot');
  out.phase = PHASES[dv.getUint8(1)] || 'fight'; out.seq = dv.getUint16(2); out.t = dv.getFloat64(4); out.clock = dv.getFloat32(12);
  const nF = dv.getUint8(16);
  if (nF > SEATS) throw new Error('bad fighter count');
  let o = 17;
  for (let i = 0; i < nF; i++) {
    const f = out.f[i], fl = dv.getUint8(o + 1);
    f.seat = dv.getUint8(o) & 7; f.alive = !!(fl & 1); f.isAI = !!(fl & 2); f.locked = !!(fl & 4); f.gun = !!(fl & 8); f.warn = !!(fl & 16);
    f.life = dv.getUint8(o + 2); f.hp = dv.getUint8(o + 3) / 255; f.missiles = dv.getUint8(o + 4); f.flares = dv.getUint8(o + 5); f.gunAmmo = dv.getUint16(o + 6);
    f.lockTarget = dv.getInt8(o + 8); f.lockProgress = dv.getUint8(o + 9) / 255; f.shield = dv.getUint8(o + 10) / 20; f.boost = dv.getUint8(o + 11) / 20;
    f.kills = dv.getUint8(o + 12); f.deaths = dv.getUint8(o + 13);
    o += 14;
    for (let j = 0; j < 3; j++) f.pos[j] = dv.getFloat32(o + j * 4);
    o += 12;
    for (let j = 0; j < 3; j++) f.vel[j] = dv.getInt16(o + j * 2) / 50;
    o += 6;
    let l = 0;
    for (let j = 0; j < 4; j++) { f.q[j] = dv.getInt16(o + j * 2) / 32767; l += f.q[j] * f.q[j]; }
    l = Math.sqrt(l) || 1; for (let j = 0; j < 4; j++) f.q[j] /= l;
    o += 8;
    f.throttle = dv.getUint8(o) / 255; f.ab = dv.getUint8(o + 1) / 255; f.aoa = dv.getInt8(o + 2) / 200; f.gLoad = dv.getInt8(o + 3) / 12;
    f.stickX = dv.getInt8(o + 4) / 127; f.stickY = dv.getInt8(o + 5) / 127; f.yaw = dv.getInt8(o + 6) / 127; f.brake = dv.getUint8(o + 7) / 255;
    o += 8;
  }
  out.nF = nF;
  const nM = dv.getUint8(o); o++;
  if (nM > MAX_M) throw new Error('bad missile count');
  for (let i = 0; i < nM; i++) {
    const m = out.m[i];
    m.id = dv.getUint16(o); m.owner = dv.getUint8(o + 2); m.target = dv.getInt8(o + 3); m.decoy = dv.getInt8(o + 4); m.motor = dv.getUint8(o + 5) / 255; m.age = dv.getUint16(o + 6) / 1000;
    o += 8;
    for (let j = 0; j < 3; j++) m.pos[j] = dv.getFloat32(o + j * 4);
    o += 12;
    for (let j = 0; j < 3; j++) m.vel[j] = dv.getInt16(o + j * 2) / 32;
    o += 6;
  }
  out.nM = nM;
  const nI = dv.getUint8(o); o++;
  if (nI > MAX_I) throw new Error('bad item count');
  for (let i = 0; i < nI; i++) {
    const it = out.items[i], k = dv.getUint8(o + 3);
    it.idx = dv.getUint8(o) % MAX_I; it.id = dv.getUint16(o + 1); it.kind = KIND[k & 15] || 'repair'; it.drop = !!(k & 16); it.chute = !!(k & 32);
    for (let j = 0; j < 3; j++) it.pos[j] = dv.getFloat32(o + 4 + j * 4);
    it.age = dv.getUint16(o + 16) / 10;
    o += I_BYTES;
  }
  out.nI = nI;
  return out;
}

/** A decode target for client states. */
export function makeState() { return { type: STATE, life: 0, crashed: false, gun: false, t: 0, mCount: 0, fCount: 0, pos: [0, 0, 0], vel: [0, 0, 0], q: [0, 0, 0, 1], throttle: 0, ab: 0, aoa: 0, gLoad: 1, stickX: 0, stickY: 0, yaw: 0, brake: 0 }; }

/** Writes a client state: st = { life, crashed, gun, t, mCount, fCount }, s = my JetState. @returns {number} bytes (64) */
export function encodeState(dv, st, s) {
  dv.setUint8(0, STATE); dv.setUint8(1, st.life & 255); dv.setUint8(2, (st.crashed ? 1 : 0) | (st.gun ? 2 : 0)); dv.setUint8(3, 0);
  dv.setFloat64(4, st.t); dv.setUint16(12, st.mCount & 0xffff); dv.setUint16(14, st.fCount & 0xffff);
  let o = 16;
  for (let j = 0; j < 3; j++, o += 4) dv.setFloat32(o, fin(s.pos[j]));
  for (let j = 0; j < 3; j++, o += 4) dv.setFloat32(o, fin(s.vel[j]));
  for (let j = 0; j < 4; j++, o += 4) dv.setFloat32(o, fin(s.q[j]));
  dv.setUint8(o, u8(s.throttle)); dv.setUint8(o + 1, u8(s.ab)); dv.setInt8(o + 2, s8(fin(s.aoa), 200)); dv.setInt8(o + 3, s8(fin(s.gLoad), 12));
  dv.setInt8(o + 4, s8(fin(s.stickX), 127)); dv.setInt8(o + 5, s8(fin(s.stickY), 127)); dv.setInt8(o + 6, s8(fin(s.yaw), 127)); dv.setUint8(o + 7, u8(s.brake || 0));
  return o + 8;
}

/** Reads a client state into `out` (makeState()). Throws on a short / foreign / non-finite packet. */
export function decodeState(dv, out) {
  if (dv.getUint8(0) !== STATE || dv.byteLength < STATE_BYTES) throw new Error('not a state');
  const fl = dv.getUint8(2);
  out.life = dv.getUint8(1); out.crashed = !!(fl & 1); out.gun = !!(fl & 2); out.t = dv.getFloat64(4); out.mCount = dv.getUint16(12); out.fCount = dv.getUint16(14);
  let o = 16, l = 0;
  for (let j = 0; j < 3; j++, o += 4) out.pos[j] = dv.getFloat32(o);
  for (let j = 0; j < 3; j++, o += 4) out.vel[j] = dv.getFloat32(o);
  for (let j = 0; j < 4; j++, o += 4) { out.q[j] = dv.getFloat32(o); l += out.q[j] * out.q[j]; }
  for (let j = 0; j < 3; j++) if (!Number.isFinite(out.pos[j]) || !Number.isFinite(out.vel[j]) || Math.abs(out.vel[j]) > 2000) throw new Error('bad state');
  if (!(l > 0.5 && l < 1.5) || !Number.isFinite(out.t)) throw new Error('bad state');
  l = Math.sqrt(l); for (let j = 0; j < 4; j++) out.q[j] /= l;
  out.throttle = dv.getUint8(o) / 255; out.ab = dv.getUint8(o + 1) / 255; out.aoa = dv.getInt8(o + 2) / 200; out.gLoad = dv.getInt8(o + 3) / 12;
  out.stickX = dv.getInt8(o + 4) / 127; out.stickY = dv.getInt8(o + 5) / 127; out.yaw = dv.getInt8(o + 6) / 127; out.brake = dv.getUint8(o + 7) / 255;
  return out;
}

// ------------------------------------------------------------------------------------------------- triggers as counts
/** Client side: counts rising edges of a trigger (one see() per step). count wraps at 16 bits. */
export function createEdgeOut() {
  return { count: 0, prev: false, see(v) { if (v && !this.prev) this.count = (this.count + 1) & 0xffff; this.prev = !!v; } };
}
/** Host side: turns new counts into one-step pulses (true, then false), so combat sees one rising edge per press. */
export function createEdgeIn() {
  return {
    seen: 0, pending: 0, high: false,
    recv(count) { const d = (count - this.seen) & 0xffff; if (d > 0 && d < 0x8000) { this.pending = Math.min(this.pending + d, 16); this.seen = count; } },
    sync(count) { this.seen = count; this.pending = 0; },   // presses from an old life / a countdown: dropped
    pulse() { if (this.high) { this.high = false; return false; } if (this.pending > 0) { this.pending--; this.high = true; return true; } return false; },
  };
}

// ------------------------------------------------------------------------------------------------- clocks and the snapshot buffer
/** A peer's clock offset (its time − ours), as a max filter of send − arrival (the least-delayed packet wins), drifting down slowly. */
export function createClock() {
  let off = 0, init = false, last = 0;
  return {
    update(remoteT, localT) {
      const o = remoteT - localT;
      if (!init) { off = o; init = true; last = localT; return; }
      off -= 0.002 * Math.max(0, localT - last); last = localT;
      if (o > off || o < off - 1) off = o;   // a faster packet, or the clocks jumped (a re-sync)
    },
    toRemote(localT) { return localT + off; },
    get ready() { return init; }, get off() { return off; },
  };
}

const QT = [0, 0, 0, 1], QB = [0, 0, 0, 1];
function slerp(a, b, u, o) {
  let bx = b[0], by = b[1], bz = b[2], bw = b[3], c = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
  if (c < 0) { c = -c; bx = -bx; by = -by; bz = -bz; bw = -bw; }
  let ka = 1 - u, kb = u;
  if (c < 0.9995) { const th = Math.acos(c), s = Math.sin(th); ka = Math.sin((1 - u) * th) / s; kb = Math.sin(u * th) / s; }
  const x = a[0] * ka + bx * kb, y = a[1] * ka + by * kb, z = a[2] * ka + bz * kb, w = a[3] * ka + bw * kb, l = Math.hypot(x, y, z, w) || 1;
  o[0] = x / l; o[1] = y / l; o[2] = z / l; o[3] = w / l;
  return o;
}
/** q1 extrapolated by the rotation q0 → q1 scaled by k (k = 1: once more), into o. */
function spinOn(q0, q1, k, o) {
  // d = q1 * conj(q0)
  const ax = -q0[0], ay = -q0[1], az = -q0[2], aw = q0[3];
  let dx = q1[3] * ax + q1[0] * aw + q1[1] * az - q1[2] * ay, dy = q1[3] * ay - q1[0] * az + q1[1] * aw + q1[2] * ax;
  let dz = q1[3] * az + q1[0] * ay - q1[1] * ax + q1[2] * aw, dw = q1[3] * aw - q1[0] * ax - q1[1] * ay - q1[2] * az;
  if (dw < 0) { dx = -dx; dy = -dy; dz = -dz; dw = -dw; }
  const sn = Math.hypot(dx, dy, dz), ang = 2 * Math.atan2(sn, dw) * k;
  if (sn < 1e-9) { o[0] = q1[0]; o[1] = q1[1]; o[2] = q1[2]; o[3] = q1[3]; return o; }
  const h = Math.sin(ang / 2) / sn, rx = dx * h, ry = dy * h, rz = dz * h, rw = Math.cos(ang / 2);
  o[0] = rw * q1[0] + rx * q1[3] + ry * q1[2] - rz * q1[1]; o[1] = rw * q1[1] - rx * q1[2] + ry * q1[3] + rz * q1[0];
  o[2] = rw * q1[2] + rx * q1[1] - ry * q1[0] + rz * q1[3]; o[3] = rw * q1[3] - rx * q1[0] - ry * q1[1] - rz * q1[2];
  return o;
}

/**
 * A ring of timed jet samples (pos, vel, q, the model bits, alive, life): sample(T) Hermite-interpolates pos (with the velocities),
 * slerps q and blends the model; past the newest it extrapolates (velocity, and the last spin) up to MAX_EXTRAP s. A new life (a
 * respawn) or a > 600 m jump is never blended across.
 */
export function createSampler(n = 16) {
  const MAX_EXTRAP = 0.3;
  const ring = [];
  for (let i = 0; i < n; i++) ring.push({ t: 0, pos: [0, 0, 0], vel: [0, 0, 0], q: [0, 0, 0, 1], m: new Float32Array(8), alive: false, life: 0 });
  let head = 0, count = 0;
  const at = (k) => ring[(head - 1 - k + n * 2) % n];   // k = 0: the newest
  const res = { alive: false, life: 0, extrap: 0 };
  return {
    get count() { return count; },
    get newestT() { return count ? at(0).t : -Infinity; },
    clear() { count = 0; },
    /** src: { pos, vel, q, alive, life, throttle, ab, ... } at sender time t. Old or duplicate times are dropped. */
    push(t, src) {
      if (count && t <= at(0).t) return false;
      const r = ring[head];
      r.t = t; r.alive = !!src.alive; r.life = src.life | 0;
      for (let j = 0; j < 3; j++) { r.pos[j] = src.pos[j]; r.vel[j] = src.vel[j]; }
      for (let j = 0; j < 4; j++) r.q[j] = src.q[j];
      for (let j = 0; j < 8; j++) r.m[j] = src[MODEL[j]] || 0;
      head = (head + 1) % n; if (count < n) count++;
      return true;
    },
    /** Writes pos / vel / q / the model fields at time T into out (a JetState); returns { alive, life, extrap } (shared object). */
    sample(T, out) {
      if (!count) return null;
      let k = 0;
      while (k < count - 1 && at(k).t > T) k++;
      const a = at(k);
      if (k === 0 || a.t > T) {   // past the newest (or before the oldest): extrapolate / hold
        const dt = clamp(T - a.t, -MAX_EXTRAP, MAX_EXTRAP);
        for (let j = 0; j < 3; j++) { out.pos[j] = a.pos[j] + a.vel[j] * dt; out.vel[j] = a.vel[j]; }
        const p = count > 1 ? at(k + 1 < count ? k + 1 : k) : a, span = a.t - p.t;
        if (p !== a && p.life === a.life && span > 1e-3 && span < 0.5 && dt > 0) spinOn(p.q, a.q, dt / span, out.q);
        else for (let j = 0; j < 4; j++) out.q[j] = a.q[j];
        for (let j = 0; j < 8; j++) out[MODEL[j]] = a.m[j];
        res.alive = a.alive; res.life = a.life; res.extrap = dt;
        return res;
      }
      const b = at(k - 1), h = b.t - a.t, u = clamp((T - a.t) / (h || 1), 0, 1);
      const jump = (b.pos[0] - a.pos[0]) ** 2 + (b.pos[1] - a.pos[1]) ** 2 + (b.pos[2] - a.pos[2]) ** 2 > 600 * 600;
      if (b.life !== a.life || jump) {   // never blend across a respawn
        const s = u < 1 ? a : b;
        for (let j = 0; j < 3; j++) { out.pos[j] = s.pos[j]; out.vel[j] = s.vel[j]; }
        for (let j = 0; j < 4; j++) out.q[j] = s.q[j];
        for (let j = 0; j < 8; j++) out[MODEL[j]] = s.m[j];
        res.alive = s.alive; res.life = s.life; res.extrap = 0;
        return res;
      }
      const u2 = u * u, u3 = u2 * u, h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
      for (let j = 0; j < 3; j++) {
        out.pos[j] = h00 * a.pos[j] + h10 * h * a.vel[j] + h01 * b.pos[j] + h11 * h * b.vel[j];
        out.vel[j] = a.vel[j] + (b.vel[j] - a.vel[j]) * u;
      }
      slerp(a.q, b.q, u, out.q);
      for (let j = 0; j < 8; j++) out[MODEL[j]] = a.m[j] + (b.m[j] - a.m[j]) * u;
      res.alive = u < 1 ? a.alive : b.alive; res.life = u < 1 ? a.life : b.life; res.extrap = 0;
      return res;
    },
  };
}

// ------------------------------------------------------------------------------------------------- the match controller
/**
 * @param {object} api  game.js internals: { game, pool, fighters, me, combat, controls, byId(id), place(f, start), respawnMe(start),
 *   spawnPuppet(seat, {name, color, isAI}), despawn(f), onEvent(e), trailsClear(f), endOnline(reason), th(x, z), now() }
 * @param {object} net  net.js
 * @param {object} cfg  net.start's cfg { minutes, bots, seed, players }
 */
export function createNetGame(api, net, cfg) {
  const host = !!net.isHost, mySeat = net.seat | 0, now = api.now || (() => performance.now() / 1000);
  const buf = new ArrayBuffer(Math.max(SNAP_MAX, STATE_BYTES) + 64), dv = new DataView(buf);
  let tick = 0, T = now(), seq = 0, alive = true, overSent = false;
  const stats = { snapsSent: 0, statesSent: 0, snapsIn: 0, statesIn: 0, bad: 0, eventsIn: 0, bytesOut: 0, predN: 0, predSum: 0, predOver5: 0, predMax: 0 };
  const score = { kills: new Uint8Array(SEATS), deaths: new Uint8Array(SEATS) };

  /** a stepped clock: dt per step, softly held to the wall clock (steps inside one display frame stay dt apart) */
  function advance(dt) { const w = now(); T += dt; if (Math.abs(w - T) > 0.1) T = w; else T += (w - T) * 0.02; }
  const send = (to, msg) => { try { net.send(to, msg); } catch (e) { console.warn('netgame: send', e); } };

  // ============================================================================================= HOST
  const rs = [];   // per seat: the remote player's buffer, clock and triggers
  for (let i = 0; i < SEATS; i++) rs.push({ sampler: createSampler(16), clock: createClock(), m: createEdgeIn(), f: createEdgeIn(), gun: false, crashed: false, life: -1 });
  const st = makeState(), PRED = makeState();
  let evq = [];

  function hostMsg(type, d, seat) {
    if (type === 'msg') {
      if (d instanceof ArrayBuffer) {
        if (seat <= 0 || seat >= SEATS) return;
        try { decodeState(new DataView(d), st); } catch { stats.bad++; return; }
        stats.statesIn++;
        const r = rs[seat], f = api.byId(seat);
        if (!f || f.net !== 'remote' || st.life !== ((f.life || 0) & 255)) { r.m.sync(st.mCount); r.f.sync(st.fCount); return; }   // an old life's packet
        r.clock.update(st.t, now());
        st.alive = true; st.life = st.life | 0;
        if (r.sampler.count && r.sampler.sample(st.t, PRED)) {   // how far our extrapolation was off when the truth arrived
          const e = Math.hypot(PRED.pos[0] - st.pos[0], PRED.pos[1] - st.pos[1], PRED.pos[2] - st.pos[2]);
          if (e < 300) { stats.predN++; stats.predSum += e; if (e > 5) stats.predOver5++; if (e > stats.predMax) stats.predMax = e; }
        }
        r.sampler.push(st.t, st);
        r.m.recv(st.mCount); r.f.recv(st.fCount); r.gun = st.gun; r.crashed = st.crashed;
      } else if (d && d.k === 'quit') api.game.mode?.toAI?.(seat);
    } else if (type === 'leave') api.game.mode?.toAI?.(seat);
    else if (type === 'join') { api.game.mode?.toHuman?.(seat, d); }
  }

  /** Remote players' fighters: their own clock's "now" (extrapolated) and their triggers, once per step before stepJet. */
  function hostPre(dt) {
    advance(dt);
    const fs = api.fighters, off = api.game.weaponsOff;
    for (let i = 0; i < fs.length; i++) {
      const f = fs[i];
      if (f.net !== 'remote') continue;
      const r = rs[f.id], s = f.s;
      if (f.alive && !s.crashed) {
        if (r.sampler.count) { r.sampler.sample(r.clock.toRemote(T), s); s.speed = Math.hypot(s.vel[0], s.vel[1], s.vel[2]); }
        else for (let j = 0; j < 3; j++) s.pos[j] += s.vel[j] * dt;   // no packet of this life yet: dead reckoning
        s.t = T;
        if (r.crashed) { s.crashed = true; s.vel[0] = s.vel[1] = s.vel[2] = 0; s.speed = 0; }   // combat.step credits the kill
      }
      if (off) { r.m.sync(r.m.seen); r.f.sync(r.f.seen); }
      f.ctl.gun = r.gun && !off; f.ctl.missile = r.m.pulse(); f.ctl.flare = r.f.pulse();
    }
  }

  function hostPost() {
    const mode = api.game.mode, over = mode && mode.phase === 'over';
    if (over && overSent) return;
    if (++tick % SNAP_EVERY !== 0 && !over) return;
    overSent = over;
    if (evq.length) { send(-1, { k: 'ev', l: evq }); evq = []; }
    score.kills.fill(0); score.deaths.fill(0);
    if (mode && mode.roster) for (const r of mode.roster) if (r.f) { score.kills[r.f.id] = r.kills; score.deaths[r.f.id] = r.deaths; }
    const n = encodeSnapshot(dv, { phase: mode ? mode.phase : 'fight', seq: ++seq, t: T, clock: mode ? mode.clock : 0 }, api.fighters, score, api.combat.missiles, api.game.powerups ? api.game.powerups.items : null);
    send(-1, buf.slice(0, n));
    stats.snapsSent++; stats.bytesOut += n;
  }

  // ============================================================================================= CLIENT
  const snap = makeSnapshot(), hostClock = createClock();
  const seats = [];
  const view = { phase: 'count', clock: (cfg.minutes || 3) * 60, seats, have: false };
  for (let i = 0; i < SEATS; i++) seats.push({ seat: i, active: false, name: '', color: '#888', isAI: true, kills: 0, deaths: 0, f: null, isMe: i === mySeat, sampler: createSampler(16), deadLife: -1, life: -1, gun: false, gunAcc: 1, flSide: 0 });
  const outM = createEdgeOut(), outF = createEdgeOut();
  const mirror = { missiles: [], bullets: [], flares: [], TUNE: CT };
  for (let i = 0; i < MAX_M; i++) mirror.missiles.push({ id: 0, owner: -1, target: -1, pos: [0, 0, 0], vel: [0, 0, 0], age: 0, motor: 0, alive: false, decoy: -1 });
  for (let i = 0; i < 192; i++) mirror.bullets.push({ owner: -1, pos: [0, 0, 0], vel: [0, 0, 0], age: 0, alive: false });
  for (let i = 0; i < 96; i++) mirror.flares.push({ owner: -1, pos: [0, 0, 0], vel: [0, 0, 0], age: 0, burn: 0, alive: false });
  const pu = { items: [] };
  for (let i = 0; i < MAX_I; i++) pu.items.push({ id: 0, kind: 'repair', pos: [0, 0, 0], alive: false, drop: false, chute: false, age: 0 });
  const deadIds = new Int32Array(64).fill(-1); let deadHead = 0, bulletNext = 0, flareNext = 0, lastSeq = -1;
  const myState = { life: 255, crashed: false, gun: false, t: 0, mCount: 0, fCount: 0 };
  const delay = api.delay ?? NET_DELAY;
  const S0 = [0, 0, 0], S1 = [0, 0, 0], S2 = [0, 0, 0], S3 = [0, 0, 0], FWD = [0, 0, 1], RT = [-1, 0, 0], UP = [0, 1, 0];
  let hidCrash = false;

  function clientMsg(type, d) {
    if (type !== 'msg') return;
    if (d instanceof ArrayBuffer) {
      try { decodeSnapshot(new DataView(d), snap); } catch { stats.bad++; return; }
      if (lastSeq >= 0 && ((snap.seq - lastSeq) & 0xffff) >= 0x8000) return;   // older than the last one
      lastSeq = snap.seq; stats.snapsIn++;
      hostClock.update(snap.t, now());
      applySnap();
      return;
    }
    if (!d || typeof d !== 'object') return;
    try {
      if (d.k === 'ev' && Array.isArray(d.l)) for (const e of d.l) { stats.eventsIn++; clientEvent(e); api.onEvent(e); }
      else if (d.k === 'respawn') respawn(d);
      else if (d.k === 'roster') roster(d.seats);
      else if (d.k === 'abort') api.endOnline('abort');
    } catch (e) { stats.bad++; console.warn('netgame: message', d && d.k, e); }
  }

  function roster(list) {
    if (!Array.isArray(list)) return;
    const want = new Array(SEATS).fill(null);
    for (const p of list) if (p && p.seat >= 0 && p.seat < SEATS) want[p.seat] = p;
    for (let i = 0; i < SEATS; i++) {
      const s = seats[i], p = want[i];
      if (i === mySeat) { s.active = true; s.name = api.me.name; s.color = api.me.color; s.isAI = false; s.f = api.me; continue; }
      if (!p) { if (s.active && s.f) api.despawn(s.f); s.active = false; s.f = null; continue; }
      s.name = String(p.name || 'Pilot').slice(0, 20); s.color = /^#[0-9a-f]{6}$/i.test(p.color) ? p.color : '#888'; s.isAI = !!p.ai;
      if (!s.active || !s.f) { s.f = api.spawnPuppet(i, { name: s.name, color: s.color, isAI: s.isAI }); s.sampler.clear(); s.deadLife = -1; s.life = -1; }
      else { s.f.name = s.name; s.f.isAI = s.isAI; if (s.f.color !== s.color) { s.f.color = s.color; s.f.jet.paint(s.color); } }
      s.active = true;
    }
  }

  function respawn(d) {
    const pos = Array.isArray(d.pos) && d.pos.length === 3 && d.pos.every(Number.isFinite) ? d.pos : null;
    if (!pos) return;
    api.respawnMe({ pos, heading: +d.heading || 0, speed: +d.speed || 230 });
    api.me.life = myState.life = d.life & 255;
    hidCrash = false;
  }

  /** the newest snapshot onto the fighters: everything but the pose (that is sampled per frame) */
  function applySnap() {
    view.phase = snap.phase; view.clock = snap.clock; view.have = true;
    const me = api.me;
    for (let i = 0; i < snap.nF; i++) {
      const x = snap.f[i], s = seats[x.seat];
      s.kills = x.kills; s.deaths = x.deaths;
      if (x.seat === mySeat) {
        if (x.life !== myState.life) continue;   // an old life (a respawn is on its way / just happened)
        me.hp = x.hp; me.missiles = x.missiles; me.flares = x.flares; me.gunAmmo = x.gunAmmo; me.shield = x.shield; me.s.boost = x.boost;
        me.lock.target = x.lockTarget; me.lock.progress = x.lockProgress; me.lock.locked = x.locked; me.warn.missile = x.warn;
        if (!x.alive && me.alive) me.alive = false;
        continue;
      }
      if (!s.active || !s.f) continue;
      const f = s.f;
      s.sampler.push(snap.t, x);
      s.gun = x.gun && x.alive;
      f.hp = x.hp; f.missiles = x.missiles; f.flares = x.flares; f.gunAmmo = x.gunAmmo; f.shield = x.shield; f.s.boost = x.boost;
      f.lock.target = x.lockTarget; f.lock.progress = x.lockProgress; f.lock.locked = x.locked; f.warn.missile = x.warn;
    }
    for (let i = 0; i < MAX_I; i++) pu.items[i].alive = false;
    for (let i = 0; i < snap.nI; i++) {
      const x = snap.items[i], it = pu.items[x.idx];
      it.alive = true; it.id = x.id; it.kind = x.kind; it.drop = x.drop; it.chute = x.chute; it.age = x.age;
      it.pos[0] = x.pos[0]; it.pos[1] = x.pos[1]; it.pos[2] = x.pos[2];
    }
  }

  /** mirror bookkeeping for an event, before the game sees it */
  function clientEvent(e) {
    if (!e) return;
    if (e.type === 'missileHit' || e.type === 'missileGone') { deadIds[deadHead] = e.missile; deadHead = (deadHead + 1) % deadIds.length; }
    else if (e.type === 'flare') { const f = api.byId(e.owner); if (f) dropFlare(f, e.owner); }
    else if (e.type === 'kill') {
      const s = seats[e.victim];
      if (e.victim === mySeat) { api.me.alive = false; api.me.hp = 0; }
      else if (s) s.deadLife = s.life;   // hidden until a sample of a newer life
    }
  }

  function dropFlare(f, seat) {
    const fl = mirror.flares[flareNext]; flareNext = (flareNext + 1) % mirror.flares.length;
    const sd = seats[seat] || seats[0], d = ANCHORS.flareDispensers[sd.flSide], s = f.s;
    sd.flSide ^= 1;
    qRot(s.q, d.p, S0); qRot(s.q, d.dir, S1);
    for (let j = 0; j < 3; j++) { fl.pos[j] = s.pos[j] + S0[j]; fl.vel[j] = s.vel[j] + S1[j] * CT.flEject; }
    fl.owner = seat; fl.age = 0; fl.burn = 0; fl.alive = true;
  }
  function fireRound(f, seat) {
    const b = mirror.bullets[bulletNext]; bulletNext = (bulletNext + 1) % mirror.bullets.length;
    const s = f.s, sp = CT.gunSpreadDeg * Math.PI / 180;
    qRot(s.q, FWD, S0); qRot(s.q, RT, S1); qRot(s.q, UP, S2); qRot(s.q, CT.muzzle, S3);
    const a = (Math.random() * 2 - 1) * sp, el = (Math.random() * 2 - 1) * sp;
    let l = 0;
    for (let j = 0; j < 3; j++) { S0[j] += S1[j] * a + S2[j] * el; l += S0[j] * S0[j]; }
    l = Math.sqrt(l) || 1;
    for (let j = 0; j < 3; j++) { b.pos[j] = s.pos[j] + S3[j]; b.vel[j] = s.vel[j] + S0[j] / l * CT.gunV; }
    b.owner = seat; b.age = 0; b.alive = true;
  }

  /** every display frame: other jets from the buffer, my warning direction, missiles, tracers, flares (all local, no damage) */
  function clientFrame(frameDt) {
    const w = now(), me = api.me;
    const hostNow = hostClock.ready ? hostClock.toRemote(w) : 0, renderT = hostNow - delay;
    const meP = net.players && net.players.find ? net.players.find((p) => p.isMe) : null;
    const rtt = meP && Number.isFinite(meP.ping) ? meP.ping / 1000 : 0.1;
    for (let i = 0; i < SEATS; i++) {
      const s = seats[i], f = s.f;
      if (i === mySeat || !s.active || !f) continue;
      const r = hostClock.ready ? s.sampler.sample(renderT, f.s) : null;
      if (!r) { f.jet.group.visible = false; f.alive = false; continue; }
      if (r.life !== s.life) { if (s.life >= 0) api.trailsClear(f); s.life = r.life; }
      f.s.speed = Math.hypot(f.s.vel[0], f.s.vel[1], f.s.vel[2]); f.s.t = w;
      const p = f.prev; for (let j = 0; j < 3; j++) p.pos[j] = f.s.pos[j]; for (let j = 0; j < 4; j++) p.q[j] = f.s.q[j];
      f.alive = r.alive && r.life !== s.deadLife;
      f.jet.group.visible = f.alive;
    }
    if (me.s.crashed && !hidCrash) { hidCrash = true; me.jet.group.visible = false; }
    // missiles: the newest snapshot moved to the render time (mine to my "now": they leave my rails)
    const ms = mirror.missiles;
    for (let i = 0; i < MAX_M; i++) ms[i].alive = false;
    let nearD = Infinity, near = -1;
    for (let i = 0, k = 0; i < snap.nM && k < MAX_M; i++) {
      const x = snap.m[i];
      let dead = false;
      for (let j = 0; j < deadIds.length; j++) if (deadIds[j] === x.id) { dead = true; break; }
      if (dead) continue;
      const tAt = x.owner === mySeat ? hostNow + rtt : renderT, dt = clamp(tAt - snap.t, -0.5, 0.6);
      if (x.age + dt < 0) continue;   // not launched yet at the render time
      const m = ms[k++];
      m.alive = true; m.id = x.id; m.owner = x.owner; m.target = x.target; m.decoy = x.decoy; m.motor = x.motor; m.age = x.age + dt;
      for (let j = 0; j < 3; j++) { m.vel[j] = x.vel[j]; m.pos[j] = x.pos[j] + x.vel[j] * dt; }
      if (x.target === mySeat && x.decoy < 0) {
        const d = Math.hypot(m.pos[0] - me.s.pos[0], m.pos[1] - me.s.pos[1], m.pos[2] - me.s.pos[2]);
        if (d < nearD) { nearD = d; near = k - 1; }
      }
    }
    if (near >= 0) { const m = ms[near], k = 1 / (nearD || 1); for (let j = 0; j < 3; j++) me.warn.dir[j] = (m.pos[j] - me.s.pos[j]) * k; me.warn.dist = nearD; }
    // tracers: every firing gun (mine from my own trigger, at once)
    const dt = Math.min(frameDt, 0.1);
    for (let i = 0; i < SEATS; i++) {
      const s = seats[i], f = i === mySeat ? me : s.f;
      if (!f || !s.active) continue;
      const firing = i === mySeat ? me.alive && !me.s.crashed && api.controlsGun() && me.gunAmmo > 0 && !api.game.weaponsOff : s.gun && f.alive;
      if (!firing) { s.gunAcc = Math.min(s.gunAcc, 1); continue; }
      s.gunAcc += dt * CT.gunRate;
      while (s.gunAcc >= 1) { s.gunAcc -= 1; fireRound(f, i); }
    }
    const th = api.th;
    for (let i = 0; i < mirror.bullets.length; i++) {
      const b = mirror.bullets[i];
      if (!b.alive) continue;
      b.age += dt; b.vel[1] -= G * dt;
      for (let j = 0; j < 3; j++) b.pos[j] += b.vel[j] * dt;
      if (b.age >= CT.gunLife || b.pos[1] < th(b.pos[0], b.pos[2])) b.alive = false;
    }
    // flares: combat.js's drag and burn
    const fe = Math.exp(-dt / CT.flTau);
    for (let i = 0; i < mirror.flares.length; i++) {
      const fl = mirror.flares[i];
      if (!fl.alive) continue;
      fl.age += dt;
      fl.vel[0] *= fe; fl.vel[1] = (fl.vel[1] + G * CT.flTau) * fe - G * CT.flTau; fl.vel[2] *= fe;
      for (let j = 0; j < 3; j++) fl.pos[j] += fl.vel[j] * dt;
      const a = fl.age;
      fl.burn = a < CT.flIgnite ? a / CT.flIgnite : a < CT.flBurn ? 1 : clamp(1 - (a - CT.flBurn) / CT.flFade, 0, 1);
      if (a >= CT.flBurn + CT.flFade) fl.alive = false;
    }
  }

  /** every step after mode.step: count my presses, send my state at 30 Hz */
  function clientPost(dt) {
    advance(dt);
    const me = api.me, ctl = me.ctl, armed = me.alive && !me.s.crashed && !api.game.weaponsOff;
    outM.see(armed && ctl.missile); outF.see(armed && ctl.flare);
    if (++tick % STATE_EVERY !== 0) return;
    myState.t = T; myState.crashed = !!me.s.crashed; myState.gun = armed && !!ctl.gun; myState.mCount = outM.count; myState.fCount = outF.count;
    const n = encodeState(dv, myState, me.s);
    send(0, buf.slice(0, n));
    stats.statesSent++; stats.bytesOut += n;
  }

  const off = net.listen((type, d, seat) => {
    if (!alive) return;
    if (host) hostMsg(type, d, seat); else clientMsg(type, d);
  });

  return {
    host, mySeat, mirror: host ? null : mirror, pu: host ? null : pu, view, stats, snap,
    get hostClock() { return hostClock; },
    preStep(dt) { if (host) hostPre(dt); },
    postStep(dt) { if (host) hostPost(); else clientPost(dt); },
    frame(frameDt) { if (!host) clientFrame(frameDt); },
    onEvent(e) { if (host && alive && e && e.type !== 'match') evq.push(e); },
    /** host: a remote player places its own jet (its fighter's life was just bumped by game.place) */
    respawn(f, start) {
      const r = rs[f.id]; r.sampler.clear(); r.crashed = false; r.gun = false; r.m.sync(r.m.seen); r.f.sync(r.f.seen);
      send(f.id, { k: 'respawn', pos: [start.pos[0], start.pos[1], start.pos[2]], heading: start.heading, speed: start.speed || 230, life: f.life & 255 });
    },
    /** host: who sits where (names, colours, AI or human) */
    sendRoster() {
      const list = [];
      for (const f of api.fighters) list.push({ seat: f.id, name: f.name, color: f.color, ai: !!f.isAI });
      send(-1, { k: 'roster', seats: list });
    },
    /** leaving the match (the room stays): the host ends it for everyone, a client hands its jet to an AI */
    leaveMatch() { if (!alive) return; if (host) { if (!overSent) send(-1, { k: 'abort' }); net.endMatch?.(); } else send(0, { k: 'quit' }); },
    stop() { alive = false; try { off(); } catch { /* net gone */ } },
  };
}
