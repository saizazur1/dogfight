// tutorial.js -- "First flight": a ~2 minute guided first flight (lane TUTORIAL, README "Modes contract").
//
//   const mode = createTutorialMode(game);   mode.start(); mode.step(dt); mode.frame(fdt); mode.onEvent(e); mode.stop();
//
// A step machine. Each step shows ONE short instruction in a big prompt panel (bottom centre: clear of the aim circle and
// the target) and advances only when the player has done it (read from game.me.s / game.me.ctl / combat events), then a
// short ✓ pause. The tutorial never kills the player: a crash respawns them at a safe spot and repeats the step, and a
// missile hit cannot take the last of their health.
//
// The training drone is an EASY AI (game.spawnAI) that never shoots on its own: its ctl.gun / missile / flare / throttle are
// accessor properties (installed by tame(), removed by untame() before despawn) so whatever ai.think writes, combat reads
// what the tutorial allows. It chases a "carrot" (a fake target 2.5 km ahead of it, drone.target) so it flies straight-ish
// while ai.js still keeps it off the mountains. In step 9 it gets the player as its target and one missile.
//
// Test hooks (tutorial.html): start(firstStep) jumps to a step (1-based); skipStep() completes the current one.

const D2R = Math.PI / 180;
const DONE_KEY = 'dogfight.tutorialDone';
const PAUSE = 1.4;            // s the ✓ stays up before the next step
const RESPAWN_AFTER = 1.5;    // s after a crash before the player is put back in the air
const LOW_AGL = 300, LOW_TIME = 5;
const DRONE = { ahead: 2000, behind: 2600, carrot: 2500, color: '#e7e7ea', name: 'Drone' };

const CSS = `
.tut{position:fixed;left:50%;bottom:78px;transform:translateX(-50%);width:min(560px,calc(100vw - 32px));box-sizing:border-box;
  font-family:Rubik,system-ui,sans-serif;color:#fff;text-align:center;background:rgba(12,14,20,.66);backdrop-filter:blur(8px);
  -webkit-backdrop-filter:blur(8px);border-radius:18px;padding:14px 22px 12px;pointer-events:none;z-index:20;
  border:1px solid rgba(255,180,58,.35);box-shadow:0 8px 30px rgba(0,0,0,.35);transition:border-color .2s}
.tut .tn{font-size:12px;font-weight:700;letter-spacing:2px;color:#ffb43a;opacity:.9}
.tut .tt{font-size:24px;font-weight:700;line-height:1.25;margin-top:4px}
.tut .ts{font-size:15px;font-weight:500;opacity:.8;margin-top:6px;min-height:1em;font-variant-numeric:tabular-nums}
.tut .tk{font-size:11px;font-weight:500;opacity:.5;margin-top:8px;letter-spacing:.5px}
.tut kbd{display:inline-block;font:700 .85em Rubik,system-ui,sans-serif;color:#1a1206;background:#ffb43a;border-radius:6px;
  padding:1px 8px;margin:0 2px;box-shadow:0 2px 0 #b07018;vertical-align:1px}
.tut.ok{border-color:#5be38a}.tut.ok .tt{color:#8ff0ad}
.tut.ok .tt:before{content:"✓ ";color:#5be38a}
`;
const keycaps = (s) => s.replace(/\[([^\]]+)\]/g, '<kbd>$1</kbd>');

/**
 * @param {Object} game  README "Modes contract" game object
 * @returns {{id:'tutorial', title:string, start:(first?:number)=>void, step:(dt:number)=>void, frame:(fdt:number)=>void,
 *            onEvent:(e:Object)=>void, stop:()=>void, skipStep:()=>void, readonly index:number}}
 */
export function createTutorialMode(game) {
  const me = game.me, th = game.world.terrainHeightAt;
  let el = null, tt = null, ts = null, tn = null, shown = '';
  let i = 0, phase = 'off', phaseT = 0, crashT = 0, okText = '', drone = null;
  // per-step scratch (reset on every enter)
  const st = { t: 0, a: 0, b: 0, n: 0, yaw0: 0, view: 'chase', fired: -1, hit: false, gone: false, fireAt: 0, armed: false };
  // the drone's leash: what combat sees of its triggers, and its throttle cap
  const leash = { fire: false, thr: 1 };
  const store = { gun: false, missile: false, flare: false, throttle: 0.84 };
  const carrot = { id: 1000, alive: true, s: { pos: [0, 0, 0], vel: [0, 0, 0] } };

  // ---------------------------------------------------------------- helpers
  const heading = (v) => Math.atan2(v[0], -v[2]);   // clockwise from north (-z)
  const wrap = (a) => a - Math.round(a / (2 * Math.PI)) * 2 * Math.PI;
  const pathDeg = () => Math.asin(Math.max(-1, Math.min(1, me.s.vel[1] / (me.s.speed || 1)))) / D2R;
  const agl = () => me.s.pos[1] - th(me.s.pos[0], me.s.pos[2]);

  /** the straight line from (x, y, z) to the player clears the terrain by 40 m */
  function losClear(x, y, z) {
    const p = me.s.pos;
    for (let k = 1; k < 12; k++) {
      const u = k / 12, px = x + (p[0] - x) * u, pz = z + (p[2] - z) * u;
      if (y + (p[1] - y) * u < th(px, pz) + 40) return false;
    }
    return true;
  }
  /** the drone's triggers become accessors: ai.think writes go to store, combat reads the leash */
  function tame(f) {
    const c = f.ctl;
    store.throttle = c.throttle ?? 0.84;
    for (const k of ['gun', 'missile', 'flare', 'throttle']) {
      Object.defineProperty(c, k, {
        configurable: true, enumerable: true, set: (v) => { store[k] = v; },
        get: k === 'missile' ? () => leash.fire : k === 'throttle' ? () => Math.min(store.throttle, leash.thr) : () => false,
      });
    }
  }
  function untame(f) {
    const c = f.ctl;
    for (const k of ['gun', 'missile', 'flare', 'throttle']) { delete c[k]; c[k] = k === 'throttle' ? store.throttle : false; }
  }
  /** (re)spawns the drone `dist` m along the player's flat path (negative: behind), same heading, terrain-safe */
  function spawnDrone(dist) {
    dropDrone();
    const v = me.s.vel, h = Math.hypot(v[0], v[2]) || 1, fx = v[0] / h, fz = v[2] / h, p = me.s.pos;
    // the first of 100 % / 75 % / 55 % of the distance, at the player's height, with clear air there and a clear line to
    // the player (the seekers need it); else the last one, lifted clear of the ground
    let x = 0, y = 0, z = 0;
    for (const k of [1, 0.75, 0.55]) {
      x = p[0] + fx * dist * k; z = p[2] + fz * dist * k; y = p[1] + 40;
      if (th(x, z) + 150 < y && losClear(x, y, z)) break;
      y = Math.max(y, th(x, z) + 350);
    }
    drone = game.spawnAI({ pos: [x, y, z], heading: heading(v), speed: Math.max(180, me.s.speed * 0.9), skill: 'easy', name: DRONE.name, color: DRONE.color });
    tame(drone);
    leash.fire = false; leash.thr = 1;
    drone.target = carrot;
    drone._deadT = 0;
  }
  /** step 9: a drone behind the player, hunting them */
  function chaser() { spawnDrone(-DRONE.behind); drone.target = me; }
  /** the drone's flight path points within 20 deg of the player, under 4 km, terrain clear (its nose is a few deg off that) */
  function onNose() {
    const q = drone.s.pos, v = drone.s.vel, p = me.s.pos, dx = p[0] - q[0], dy = p[1] - q[1], dz = p[2] - q[2];
    const R = Math.hypot(dx, dy, dz) || 1, sp = Math.hypot(v[0], v[1], v[2]) || 1;
    return R < 4000 && (v[0] * dx + v[1] * dy + v[2] * dz) / (R * sp) > Math.cos(20 * D2R) && losClear(q[0], q[1], q[2]);
  }
  function dropDrone() {
    if (!drone) return;
    untame(drone); drone.target = null; game.despawn(drone); drone = null;
  }
  /** the carrot rides 2.5 km ahead of the drone, bent back toward the play area's middle when it wanders out */
  function moveCarrot() {
    const s = drone.s, v = s.vel, h = Math.hypot(v[0], v[2]) || 1, pa = game.env?.playArea || game.world.playArea;
    let dx = v[0] / h, dz = v[2] / h;
    if (pa) {
      const ox = pa.cx - s.pos[0], oz = pa.cz - s.pos[2], r = Math.hypot(ox, oz) || 1, k = Math.max(0, Math.min(1, (r / pa.half - 0.45) * 2)) * 0.6;
      dx += (ox / r - dx) * k; dz += (oz / r - dz) * k;
      const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
    }
    const c = carrot.s, x = s.pos[0] + dx * DRONE.carrot, z = s.pos[2] + dz * DRONE.carrot;
    c.pos[0] = x; c.pos[2] = z; c.pos[1] = Math.max(s.pos[1], th(x, z) + 600);
    c.vel[0] = dx * s.speed; c.vel[1] = 0; c.vel[2] = dz * s.speed;
  }

  // ---------------------------------------------------------------- the steps
  /** @type {{text:string, sub?:()=>string, enter?:()=>void, check:(dt:number)=>boolean, ok:()=>string}[]} */
  const STEPS = [
    { text: 'Move the mouse to steer. Look left, then right.', sub: () => 'The jet follows the circle.',
      enter() { st.yaw0 = heading(me.ctl.aim); },
      check() { const d = wrap(heading(me.ctl.aim) - st.yaw0) / D2R; st.a = Math.min(st.a, d); st.b = Math.max(st.b, d); return st.a <= -45 && st.b >= 45; },
      ok: () => 'Nice steering!' },
    { text: 'Pull up: move the mouse up.', check: () => pathDeg() >= 15, ok: () => 'Good climb!' },
    { text: 'Dive: move the mouse down.', check: () => pathDeg() <= -10, ok: () => 'Good dive!' },
    { text: 'More speed: hold [W]. Keep holding for the afterburner.', sub: () => `${Math.round(me.s.speed * 3.6)} km/h`,
      check: () => me.s.ab > 0.05, ok: () => 'Afterburner!' },
    { text: 'Fly LOW between the mountains: under 300 m above the ground for 5 seconds.',
      sub: () => { const h = agl(); return h < LOW_AGL ? `Low! ${(LOW_TIME - st.a).toFixed(1)} s to go` : `Now ${Math.round(h / 10) * 10} m above the ground. Go lower.`; },
      check(dt) { st.a = agl() < LOW_AGL && !me.s.crashed ? st.a + dt : 0; return st.a >= LOW_TIME; },
      ok: () => 'Low and fast!' },
    { text: "A training drone is ahead. Keep it inside the box until you hear LOCK.", sub: () => "It won't shoot back.",
      enter() { if (!drone || !drone.alive) spawnDrone(DRONE.ahead); },
      check: () => st.n > 0, ok: () => 'LOCKED!' },
    { text: 'Fire a missile: right-click or [Space].',
      sub: () => (st.fired < 0 ? 'The lock tone means it will chase the drone.' : st.hit ? 'Splash!' : 'Missile away…'),
      enter() { if (!drone || !drone.alive) spawnDrone(DRONE.ahead); },
      check() { return st.fired >= 0 && (st.hit || st.gone || st.t - st.a > 6); },
      ok: () => (st.hit ? 'Splash! Direct hit.' : 'Missile away! Good shot.') },
    { text: 'Now the gun: get close and hold the left mouse button.', sub: () => `Hits ${Math.min(st.n, 3)} / 3 · hold [W] to catch up`,
      enter() { if (!drone || !drone.alive) spawnDrone(DRONE.ahead * 0.6); leash.thr = 0.45; },
      check: () => st.n >= 3, ok: () => 'Got it!' },
    { text: 'Incoming missile! Press [F] for flares.', sub: () => (st.fired < 0 ? 'Get ready…' : 'Press [F] now!'),
      enter() { chaser(); st.fireAt = 0.6; },
      check() {
        if (st.fired < 0 && st.t >= st.fireAt) {   // one missile, locked on the player
          if (!drone || !drone.alive) { chaser(); st.fireAt = st.t + 1; return false; }
          // combat's seeker only keeps a lock inside its 30 deg keep cone, so wait for the hunting drone's nose (else the
          // missile flies unguided); then the lock goes in one step, the trigger the next
          if (onNose()) {
            drone.lock.target = me.id; drone.lock.progress = 1; drone.lock.locked = true;
            if (st.armed) leash.fire = true; else st.armed = true;
          } else if (st.t > st.fireAt + 8) { chaser(); st.armed = false; st.fireAt = st.t + 1; }   // never lined up: a new one
        }
        // missed the flares: a fresh drone behind (the old one has used its missile and flown on), and again
        if (st.fired >= 0 && st.gone && st.n === 0) { chaser(); st.fired = -1; st.gone = false; st.armed = false; st.fireAt = st.t + 2; }
        return st.n > 0;
      },
      ok: () => 'Flares out! The missile chases them.' },
    { text: 'Press [V] to see the cockpit. [V] again to come back.',
      enter() { st.view = game.controls.view; dropDrone(); },
      check() { if (game.controls.view !== st.view) { st.view = game.controls.view; st.n++; } return st.n >= 2; },
      ok: () => "That's it!" },
  ];
  const N = STEPS.length;

  function enter(k) {
    i = k; phase = 'do'; phaseT = 0;
    st.t = 0; st.a = 0; st.b = 0; st.n = 0; st.fired = -1; st.hit = false; st.gone = false; st.fireAt = 0; st.armed = false;
    if (i >= N) return finish();
    game.setBanner(`First flight · step ${i + 1}/${N}`);
    STEPS[i].enter?.();
  }
  function complete() {
    if (phase !== 'do') return;
    okText = STEPS[i].ok(); phase = 'ok'; phaseT = 0;
  }
  function finish() {
    phase = 'end';
    dropDrone();
    game.setBanner(null);
    try { localStorage.setItem(DONE_KEY, '1'); } catch { /* private window */ }
    game.finish({ title: 'READY TO FIGHT', sub: 'Try a duel next', won: true });
  }

  // ---------------------------------------------------------------- the mode
  function start(first = 1) {
    if (!el) {
      if (!document.getElementById('tut-css')) { const s = document.createElement('style'); s.id = 'tut-css'; s.textContent = CSS; document.head.appendChild(s); }
      el = document.createElement('div'); el.className = 'tut'; el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite');
      el.innerHTML = '<div class="tn"></div><div class="tt"></div><div class="ts"></div><div class="tk">Esc: menu · skip the tutorial there</div>';
      [tn, tt, ts] = el.children;
      document.body.appendChild(el);
    }
    shown = ''; crashT = 0;
    enter(Math.max(0, Math.min(N, (first | 0) - 1)));
  }

  function step(dt) {
    if (phase === 'off' || phase === 'end') return;
    // the tutorial never kills: crash -> back in the air, same step again
    if (!me.alive || me.s.crashed) {
      if ((crashT += dt) >= RESPAWN_AFTER) { crashT = 0; game.respawnMe(game.safeSpawn(0, 1)); enter(i); }
      return;
    }
    if (me.hp < 0.75) me.hp = 0.75;   // a missile (0.7) can never take the last of it
    if (me.missiles < 1) me.missiles = 1;
    if (me.flares < 1) me.flares = 1;
    if (me.gunAmmo < 100) me.gunAmmo = 400;
    if (drone) {
      if (drone.alive) { drone._deadT = 0; if (drone.target === carrot) moveCarrot(); }
      else if ((drone._deadT += dt) > 2 && phase === 'do' && i >= 5 && i <= 7) spawnDrone(DRONE.ahead);
    }
    phaseT += dt; st.t += dt;
    if (phase === 'do') { if (STEPS[i].check(dt)) complete(); }
    else if (phase === 'ok' && phaseT >= PAUSE) enter(i + 1);
  }

  function onEvent(e) {
    if (phase !== 'do') return;
    const dId = drone ? drone.id : -2;
    switch (e.type) {
      case 'lockOn': if (i === 5 && e.owner === me.id && e.target === dId) st.n++; break;
      case 'missileFired':
        if (i === 6 && e.owner === me.id && st.fired < 0) { st.fired = e.missile; st.a = st.t; }
        if (i === 8 && e.owner === dId) { st.fired = e.missile; leash.fire = false; }
        break;
      case 'missileHit': if (e.missile === st.fired) { st.hit = true; st.gone = true; } break;
      case 'missileGone': if (e.missile === st.fired) st.gone = true; break;
      case 'gunHit': if (i === 7 && e.owner === me.id && e.target === dId) st.n++; break;
      case 'flare': if (i === 8 && e.owner === me.id && st.fired >= 0) st.n++; break;
    }
  }

  function frame() {
    if (!el) return;
    let key, html, sub = '';
    if (phase === 'end') { el.style.display = 'none'; return; }
    if (!me.alive || me.s.crashed) { key = 'crash'; html = 'Oops! Hit the ground. Back in the air in a moment…'; }
    else if (phase === 'ok') { key = `ok${i}`; html = okText; }
    else { const S = STEPS[i]; key = `do${i}`; html = S.text; sub = S.sub ? S.sub() : ''; }
    const k = key + sub;
    if (k === shown) return;
    shown = k;
    el.style.display = '';
    el.classList.toggle('ok', phase === 'ok' && key.startsWith('ok'));
    tn.textContent = `FIRST FLIGHT · STEP ${Math.min(i + 1, N)} / ${N}`;
    tt.innerHTML = keycaps(html);   // our own fixed strings only
    ts.innerHTML = keycaps(sub);
  }

  function stop() {
    if (phase !== 'end') game.setBanner(null);
    phase = 'off';
    dropDrone();
    if (el) { el.remove(); el = null; }
  }

  return {
    id: 'tutorial', title: 'First flight', start, step, frame, onEvent, stop,
    skipStep: complete,
    get index() { return i; },
  };
}
