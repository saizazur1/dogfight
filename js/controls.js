// controls.js -- keyboard, mouse aim and pointer lock (lane FLIGHT). README "controls.js".
//
// Mouse aim (War Thunder arcade "instructor"): the mouse turns a WORLD direction (yaw about world up, pitch clamped to
// +-85 deg); flight.js flies the jet toward it and chasecam.js looks along it. Because the aim is a world direction (not a
// screen offset), the jet stops turning once its nose reaches it and flies straight on: it never holds a turn forever,
// so the aim is NOT re-centred on the nose when the mouse is idle (that would drag a lined-up shot off target). The aim
// is only pulled toward the jet when the jet cannot follow it: keyboard pitch/roll held (the aim rides the flight path,
// so releasing the key never snaps the jet back), the play area's turn-back (the aim follows the jet's own steer), and a
// stall (the aim sinks to the flight path, so the jet does not climb straight back into the stall).
//
// Keys: W / S throttle (ramps; W stops at the afterburner detent, keep holding past it for afterburner), Shift afterburner
// hold, A / D roll, Q / E yaw, Arrow up / down pitch, B air brake (hold), C free look (hold: the aim freezes, the mouse
// orbits the camera), V view (chase | cockpit), F flares. Esc releases the pointer lock (the browser's own).
// Gamepad (standard mapping, if one is connected): left stick moves the aim, RT / LT throttle up / down, A afterburner,
// RB gun (hold), LB missile, B flares.
//
// PHASE 3 weapons: ctl.gun is HELD state (left mouse button while the pointer is locked, or RB). ctl.missile / ctl.flare are EDGES:
// a right click / Space / LB (flare: F / B) sets them true and they STAY true until the game calls controls.consumeEdges(), so a press
// is never lost between display frames and never fires twice. Call consumeEdges() once after EVERY sim step:
//     step(dt) { ...pilots write ctl...; stepJet(...); combat.step(dt); controls.consumeEdges(); }
// (the first step after a press sees the edge, the clearing happens right after it; later steps in the same frame see false).

import { AB_DETENT } from './jetspec.js';

const D2R = Math.PI / 180;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const PITCH_MAX = 85 * D2R;
const SENS_KEY = 'dogfight.mouseSens', INV_KEY = 'dogfight.invertY';
const THR_RATE = 0.5, DETENT_HOLD = 0.35;   // lever units per second; seconds W must stay held at the detent to light the AB

const load = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private window: keep it for this visit */ } };

/**
 * Keyboard + mouse-aim + pointer-lock input. Allocation-free per frame.
 * @param {{canvas: HTMLElement}} o  the element clicks lock the pointer to
 * @returns {{
 *   ctl: {aim:number[], pitch:number, roll:number, yaw:number, throttle:number, ab:boolean, brake:boolean, gun:boolean, missile:boolean, flare:boolean},
 *   consumeEdges: () => void,   // clears ctl.missile / ctl.flare: call after each sim step
 *   update: (frameDt:number, s?:import('./flight.js').JetState) => void,
 *   reset: (heading:number, pitch?:number) => void,
 *   view: 'chase'|'cockpit', locked: boolean, onLockChange: ((locked:boolean)=>void)|null,
 *   look: {active:boolean, yaw:number, pitch:number},
 *   sensitivity: number, invertY: boolean, setSensitivity: (v:number)=>void, setInvertY: (b:boolean)=>void, dispose: ()=>void
 * }}
 *   ctl is the object to pass to stepJet (updated live). look = the free-look orbit (rad) for the chase camera.
 */
export function createControls({ canvas }) {
  const ctl = { aim: [0, 0, -1], pitch: 0, roll: 0, yaw: 0, throttle: 0.7, ab: false, brake: false, gun: false, missile: false, flare: false };
  let mouseGun = false, padGun = false, padMissile = false, padFlare = false;   // last gamepad button states, for edge detection
  const keys = Object.create(null);
  let aimYaw = 0, aimPitch = 0, detentT = 0;
  const api = {
    ctl, view: 'chase', locked: false, onLockChange: null,
    look: { active: false, yaw: 0, pitch: 0 },
    sensitivity: load(SENS_KEY, 0.0018),   // rad per mouse pixel
    invertY: !!load(INV_KEY, false),
    setSensitivity(v) { api.sensitivity = clamp(+v || 0.0018, 0.0003, 0.01); save(SENS_KEY, api.sensitivity); },
    setInvertY(b) { api.invertY = !!b; save(INV_KEY, api.invertY); },
    reset(heading, pitch = 0) { aimYaw = heading; aimPitch = clamp(pitch, -PITCH_MAX, PITCH_MAX); api.look.yaw = api.look.pitch = 0; writeAim(); },
    update, dispose,
    /** clears the one-step edges (ctl.missile, ctl.flare): the game calls it after every sim step */
    consumeEdges() { ctl.missile = false; ctl.flare = false; },
  };

  function writeAim() {
    const cp = Math.cos(aimPitch);
    ctl.aim[0] = Math.sin(aimYaw) * cp; ctl.aim[1] = Math.sin(aimPitch); ctl.aim[2] = -Math.cos(aimYaw) * cp;
  }
  // turn the aim toward a world direction d by the fraction k (0..1) of the angle, through yaw / pitch
  function pullAim(d, k) {
    const h = Math.hypot(d[0], d[2]), ty = h > 1e-4 ? Math.atan2(d[0], -d[2]) : aimYaw, tp = clamp(Math.atan2(d[1], h), -PITCH_MAX, PITCH_MAX);
    let dy = ty - aimYaw; dy -= Math.round(dy / (2 * Math.PI)) * 2 * Math.PI;
    aimYaw += dy * k; aimPitch += (tp - aimPitch) * k;
  }

  const onMove = (e) => {
    if (!api.locked) return;
    const s = api.sensitivity, dy = (api.invertY ? -1 : 1) * e.movementY * s;
    if (api.look.active) {
      api.look.yaw += e.movementX * s;
      api.look.pitch = clamp(api.look.pitch - dy, -PITCH_MAX, PITCH_MAX);
    } else {
      aimYaw += e.movementX * s;
      aimPitch = clamp(aimPitch - dy, -PITCH_MAX, PITCH_MAX);
    }
  };
  const onClick = () => {
    if (api.locked) return;
    try { const p = canvas.requestPointerLock(); if (p && p.catch) p.catch(() => {}); } catch { /* not allowed here */ }
  };
  const onLock = () => {
    api.locked = document.pointerLockElement === canvas;
    if (!api.locked) releaseButtons();   // a held trigger must not stay stuck when the lock is lost (Esc, menu)
    if (api.onLockChange) api.onLockChange(api.locked);
  };
  const GAME_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
  const onKey = (e) => {
    const down = e.type === 'keydown';
    if (GAME_KEYS.has(e.code)) e.preventDefault();
    if (down && e.code === 'KeyV' && !e.repeat) api.view = api.view === 'chase' ? 'cockpit' : 'chase';
    if (e.code === 'Space' && api.locked) e.preventDefault();   // no page scroll / button press while flying
    if (down && !e.repeat && api.locked) {
      if (e.code === 'Space') ctl.missile = true; else if (e.code === 'KeyF') ctl.flare = true;
    }
    keys[e.code] = down;
  };
  // mouse buttons only count while the pointer is locked (the first click just locks it): left = gun (held), right = missile
  const onMouse = (e) => {
    if (!api.locked) return;
    const down = e.type === 'mousedown';
    if (e.button === 0) ctl.gun = mouseGun = down; else if (e.button === 2 && down) ctl.missile = true;
    e.preventDefault();
  };
  const onMenu = (e) => { if (api.locked) e.preventDefault(); };   // no context menu on right click while flying
  const releaseButtons = () => { mouseGun = false; ctl.gun = padGun; };
  const onBlur = () => { for (const k in keys) keys[k] = false; releaseButtons(); };
  canvas.addEventListener('click', onClick);
  document.addEventListener('mousemove', onMove);
  document.addEventListener('pointerlockchange', onLock);
  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', onKey);
  window.addEventListener('blur', onBlur);
  document.addEventListener('mousedown', onMouse);
  document.addEventListener('mouseup', onMouse);
  document.addEventListener('contextmenu', onMenu);

  /**
   * Once per display frame: keyboard ramps, gamepad, free look, and the aim kept where the jet can follow it.
   * @param {number} frameDt  seconds
   * @param {import('./flight.js').JetState} [s]  the player's jet (for the aim rules); optional
   */
  function update(frameDt, s) {
    const dt = Math.min(frameDt, 0.1), k = (c) => (keys[c] ? 1 : 0);
    let pitch = k('ArrowUp') - k('ArrowDown'), roll = k('KeyD') - k('KeyA'), yaw = k('KeyE') - k('KeyQ');
    let thrUp = k('KeyW'), thrDn = k('KeyS'), ab = !!(keys.ShiftLeft || keys.ShiftRight);

    // gamepad: left stick moves the aim (90 deg/s at full deflection), RT / LT throttle, A afterburner
    const pads = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : null;
    const gp = pads && pads[0];
    if (gp && gp.mapping === 'standard') {
      const dz = (v) => (Math.abs(v) < 0.15 ? 0 : (v - Math.sign(v) * 0.15) / 0.85);
      aimYaw += dz(gp.axes[0]) * 90 * D2R * dt;
      aimPitch = clamp(aimPitch - (api.invertY ? -1 : 1) * dz(gp.axes[1]) * 90 * D2R * dt, -PITCH_MAX, PITCH_MAX);
      thrUp = Math.max(thrUp, gp.buttons[7] ? gp.buttons[7].value : 0); thrDn = Math.max(thrDn, gp.buttons[6] ? gp.buttons[6].value : 0);
      ab = ab || !!(gp.buttons[0] && gp.buttons[0].pressed);
      const pr = (i) => !!(gp.buttons[i] && gp.buttons[i].pressed);
      padGun = pr(5); ctl.gun = mouseGun || padGun;   // RB held, or the left mouse button
      if (pr(4) && !padMissile) ctl.missile = true;   // LB: edge
      if (pr(1) && !padFlare) ctl.flare = true;       // B: edge
      padMissile = pr(4); padFlare = pr(1);
    }

    // throttle: W ramps up to the detent and stops; held there DETENT_HOLD s more it carries on into afterburner
    let t = ctl.throttle;
    if (thrUp > 0) {
      if (t < AB_DETENT) { t = Math.min(AB_DETENT, t + THR_RATE * thrUp * dt); detentT = 0; }
      else if ((detentT += dt) > DETENT_HOLD || t > AB_DETENT) t = Math.min(1, t + THR_RATE * thrUp * dt);
    } else detentT = 0;
    if (thrDn > 0) t = t > AB_DETENT ? AB_DETENT : Math.max(0, t - THR_RATE * thrDn * dt);   // S leaves the AB at once
    ctl.throttle = t;
    ctl.ab = ab; ctl.brake = !!keys.KeyB;
    ctl.pitch = pitch; ctl.roll = roll; ctl.yaw = yaw;

    // free look: C held freezes the aim and orbits the camera; released, the orbit eases home
    api.look.active = !!keys.KeyC;
    if (!api.look.active) { const e = 1 - Math.exp(-8 * dt); api.look.yaw -= api.look.yaw * e; api.look.pitch -= api.look.pitch * e; }

    if (s && !s.crashed) {
      const v = s.speed || 1, path = PATH; path[0] = s.vel[0] / v; path[1] = s.vel[1] / v; path[2] = s.vel[2] / v;
      if (pitch || roll) pullAim(path, 1);                                   // flying by hand: the aim rides the flight path
      else if (s.warn.boundary) pullAim(s.steer, 1 - Math.exp(-1.5 * dt));   // the turn-back: follow the jet home
      else if (s.warn.stall && aimPitch > Math.asin(clamp(path[1], -1, 1))) pullAim(path, 1 - Math.exp(-1.5 * dt));
    }
    writeAim();
  }
  const PATH = [0, 0, -1];

  function dispose() {
    canvas.removeEventListener('click', onClick);
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('pointerlockchange', onLock);
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('keyup', onKey);
    window.removeEventListener('blur', onBlur);
    document.removeEventListener('mousedown', onMouse);
    document.removeEventListener('mouseup', onMouse);
    document.removeEventListener('contextmenu', onMenu);
  }
  writeAim();
  return api;
}
