// sound.js -- the jet's sound, all synthesised on the Web Audio graph in audio.js (no files). Adapted from the film's
// jetsound.js: the plan / jethud / eject dependencies are gone, it is driven by the live jet state instead.
//
//   const snd = createSound();
//   snd.start();                      // on the PLAY click (browsers need a user gesture)
//   snd.update(camera, s, view);      // every display frame; view = 'chase' | 'cockpit'
//   snd.setVolume(0..1);  snd.pause(bool);
//   snd.oneShot('launch'|'flare'|'pop'|'boom'|'bang'|'rocket'|'crack', pos?);   // pos = [x,y,z] world; omitted = at the player
//   snd.status()                      // { ctx ('running'...), muffleHz (the live low-pass), view, wind, pullUp, stall } for the harness
//
// WHAT YOU HEAR: the engine's roar (brown noise through a low-pass that opens with the throttle), the turbine whine, the
// afterburner's ragged rumble, wind rising with speed. In the cockpit view the whole bed goes through a low-pass (the muffled
// interior): the film's version never played it (jetmode never passed the lens), here `view` drives it. PULL UP: a fast square
// beep. Stall: a slower, lower two-tone warble.
import * as THREE from 'three';
import { Sfx } from './audio.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const MUFFLE = { cockpit: 650, chase: 7000 };   // Hz: the bed's low-pass per view

/** @returns {{start:()=>void, update:Function, setVolume:(v:number)=>void, pause:(on:boolean)=>void, oneShot:Function, status:()=>object}} */
export function createSound() {
  const sfx = new Sfx();
  let A = null, bus = null, running = false, volume = 0.8;
  const st = { view: 'chase', ctx: 'none', muffleHz: 0, engineTone: 0, wind: 0, pullUp: false, stall: false };
  const cam = new THREE.Vector3(), right = new THREE.Vector3();   // the last camera, for oneShot positions
  let E = null, wind = null, windLp = null, pullG = null, stallG = null, stallO = null;

  const gain = (v = 0) => { const g = A.createGain(); g.gain.value = v; return g; };
  const filt = (type, f, q = 0.7) => { const b = A.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; return b; };
  const loop = (buf, off) => { const s = A.createBufferSource(); s.buffer = buf; s.loop = true; s.start(0, off); return s; };

  /** builds the whole graph once, after the first gesture */
  function build() {
    A = sfx.ctx; bus = gain(0.9); bus.connect(sfx.master);
    // the muffle: everything continuous goes through it (cockpit 650 Hz, chase 7 kHz)
    const tone = filt('lowpass', MUFFLE.chase, 0.5); tone.connect(bus);
    // engine
    E = { tone };
    E.roarLp = filt('lowpass', 600, 0.6); E.roarG = gain(0); loop(sfx.brown, 0).connect(E.roarLp).connect(E.roarG).connect(tone);
    E.hissG = gain(0); loop(sfx.noise, 0.3).connect(filt('bandpass', 2600, 1.2)).connect(E.hissG).connect(tone);
    E.whine = A.createOscillator(); E.whine.type = 'triangle'; E.whine.frequency.value = 2200; E.whineG = gain(0); E.whine.connect(E.whineG).connect(tone); E.whine.start();
    E.abAm = gain(0.6); E.abG = gain(0); E.abLfo = A.createOscillator(); E.abLfo.type = 'sawtooth'; E.abLfo.frequency.value = 17;
    const lg = gain(0.4); E.abLfo.connect(lg).connect(E.abAm.gain); E.abLfo.start();
    loop(sfx.brown, 1.3).connect(filt('lowpass', 180, 0.9)).connect(E.abAm).connect(E.abG).connect(tone);
    // wind
    wind = gain(0); windLp = filt('bandpass', 500, 0.4); loop(sfx.noise, 1.7).connect(windLp).connect(wind).connect(tone);
    // PULL UP: a 1 kHz square gated at 4 Hz (outside the muffle: a warning must be heard)
    const po = A.createOscillator(); po.type = 'square'; po.frequency.value = 1000; pullG = gain(0);
    const pam = gain(0); const plfo = A.createOscillator(); plfo.type = 'square'; plfo.frequency.value = 4; const plg = gain(0.5); plfo.connect(plg).connect(pam.gain);
    po.connect(filt('lowpass', 3000, 0.7)).connect(pam).connect(pullG).connect(sfx.master); po.start(); plfo.start();
    // STALL: a 440 Hz triangle warbling +-90 Hz at 2.5 Hz
    stallO = A.createOscillator(); stallO.type = 'triangle'; stallO.frequency.value = 440; stallG = gain(0);
    const slfo = A.createOscillator(); slfo.frequency.value = 2.5; const sd = gain(90); slfo.connect(sd).connect(stallO.frequency);
    stallO.connect(stallG).connect(sfx.master); stallO.start(); slfo.start();
  }

  // ---- one-shots (g already includes the distance); noise burst through a filter and a pan
  function burst(t, { type = 'bandpass', f0 = 1000, f1 = f0, q = 1, dur = 0.3, g0 = 0.2, att = 0.005, buf = sfx.noise, pan = 0 }) {
    const s = A.createBufferSource(); s.buffer = buf; const b = filt(type, f0, q), g = A.createGain();
    b.frequency.setValueAtTime(f0, t); if (f1 !== f0) b.frequency.exponentialRampToValueAtTime(f1, t + dur);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(Math.max(0.0002, g0), t + att); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    let out = s.connect(b).connect(g);
    if (A.createStereoPanner) { const p = A.createStereoPanner(); p.pan.value = pan; out = out.connect(p); }
    out.connect(bus); s.start(t, 0.37 * ((t * 7.3) % 1)); s.stop(t + dur + 0.05);
  }
  function thump(t, f, g0, dur = 0.5) {
    const o = A.createOscillator(), g = A.createGain(); o.frequency.setValueAtTime(f * 1.6, t); o.frequency.exponentialRampToValueAtTime(f, t + 0.12);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(Math.max(0.0002, g0), t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(bus); o.start(t); o.stop(t + dur + 0.05);
  }
  const SHOTS = {
    launch: (t, g, p) => { burst(t, { f0: 500, f1: 2400, q: 0.8, dur: 0.9, g0: 0.35 * g, att: 0.03, pan: p }); burst(t, { type: 'lowpass', f0: 300, dur: 0.6, g0: 0.3 * g, buf: sfx.brown, pan: p }); },
    flare: (t, g, p) => { burst(t, { f0: 1800, q: 2, dur: 0.06, g0: 0.25 * g, pan: p }); thump(t, 90, 0.12 * g, 0.18); },
    pop: (t, g, p) => { burst(t, { f0: 1200, f1: 400, q: 1, dur: 0.35, g0: 0.3 * g, pan: p }); thump(t, 70, 0.2 * g, 0.4); },
    boom: (t, g, p) => { burst(t, { type: 'lowpass', f0: 420, f1: 120, q: 0.7, dur: 1.6, g0: 0.55 * g, att: 0.01, buf: sfx.brown, pan: p }); thump(t, 48, 0.45 * g, 1.0); burst(t, { f0: 2500, f1: 800, q: 0.8, dur: 0.25, g0: 0.12 * g, pan: p }); },
    bang: (t, g, p) => { burst(t, { type: 'highpass', f0: 1500, q: 0.7, dur: 0.12, g0: 0.45 * g, att: 0.002, pan: p }); thump(t, 110, 0.3 * g, 0.25); },
    rocket: (t, g, p) => { burst(t, { f0: 350, f1: 900, q: 0.6, dur: 0.55, g0: 0.45 * g, att: 0.02, pan: p }); burst(t, { type: 'lowpass', f0: 250, dur: 0.6, g0: 0.35 * g, buf: sfx.brown, pan: p }); },
    crack: (t, g, p) => { burst(t, { f0: 1400, q: 1.5, dur: 0.12, g0: 0.35 * g, att: 0.003, pan: p }); burst(t + 0.05, { f0: 600, q: 0.9, dur: 0.5, g0: 0.12 * g, pan: p }); },
  };

  return {
    /** call from a click / key handler */
    start() { sfx.start(); if (!sfx.ctx) return; if (!A) build(); running = true; sfx.master.gain.value = volume; sfx.ctx.resume(); },
    setVolume(v) { volume = clamp(+v || 0, 0, 1); if (sfx.master) sfx.master.gain.setTargetAtTime(volume, sfx.ctx.currentTime, 0.03); },
    pause(on) { sfx.pause(on); },
    status() { st.ctx = sfx.ctx ? sfx.ctx.state : 'none'; st.muffleHz = E ? Math.round(E.tone.frequency.value) : 0; return st; },
    /** plays a one-shot; pos = world [x,y,z] (distance falloff + pan against the last camera) or omitted for full volume */
    oneShot(name, pos) {
      if (!running || !A || !SHOTS[name]) return;
      let g = 1, pan = 0;
      if (pos) {
        const dx = pos[0] - cam.x, dy = pos[1] - cam.y, dz = pos[2] - cam.z, d = Math.max(1, Math.hypot(dx, dy, dz));
        g = Math.max(0.05, 1.6 / (1 + Math.pow(d / 150, 1.25)));
        pan = clamp((dx * right.x + dy * right.y + dz * right.z) / d, -1, 1) * 0.8;
      }
      SHOTS[name](A.currentTime, Math.min(1.5, g), pan);
    },
    /**
     * Every display frame, after the camera is placed.
     * @param {THREE.Camera} camera @param {import('./flight.js').JetState} s @param {'chase'|'cockpit'} v
     */
    update(camera, s, v) {
      camera.getWorldPosition(cam); right.set(1, 0, 0).applyQuaternion(camera.quaternion);   // (no allocation: reused vectors)
      if (!running || !A) return;
      const t = A.currentTime, inside = v === 'cockpit', thr = clamp(s.throttle ?? 0.7, 0, 1), ab = clamp(s.ab || 0, 0, 1);
      const spd = clamp((s.speed || 0) / 400, 0, 1.2), crashed = !!s.crashed;
      const alive = crashed ? 0 : 1;
      E.tone.frequency.setTargetAtTime(inside ? MUFFLE.cockpit : MUFFLE.chase, t, 0.08);
      E.roarLp.frequency.setTargetAtTime((350 + 900 * thr + 600 * ab) * (0.9 + 0.3 * spd), t, 0.05);
      E.roarG.gain.setTargetAtTime(0.5 * (0.5 + 0.5 * thr) * alive, t, 0.05);
      E.hissG.gain.setTargetAtTime(0.05 * thr * alive, t, 0.05);
      E.whine.frequency.setTargetAtTime(1700 + 900 * thr + 300 * ab, t, 0.05);
      E.whineG.gain.setTargetAtTime(0.012 * thr * alive, t, 0.05);
      E.abG.gain.setTargetAtTime(0.55 * ab * alive, t, 0.06);
      const wl = 0.02 + 0.2 * spd * spd;   // wind: quadratic in speed
      wind.gain.setTargetAtTime(wl * (inside ? 0.6 : 1), t, 0.08); windLp.frequency.setTargetAtTime(350 + 1100 * spd, t, 0.1);
      const pu = !crashed && !!s.warn.pullUp, sl = !crashed && !pu && !!s.warn.stall;
      pullG.gain.setTargetAtTime(pu ? 0.05 : 0, t, 0.02);
      stallG.gain.setTargetAtTime(sl ? 0.07 : 0, t, 0.03);
      st.view = v; st.engineTone = inside ? MUFFLE.cockpit : MUFFLE.chase; st.wind = wl; st.pullUp = pu; st.stall = sl;
    },
  };
}
