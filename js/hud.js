// hud.js -- the phase-1 HUD (lane FLIGHT). README "hud.js". A DOM overlay: bold rounded sans-serif, white on translucent
// dark, one accent colour (cyan); red only for PULL UP. Allocation-light: text is written only when its value changes,
// positions only when they move by half a pixel.
//
//   const hud = createHud(root);  hud.setEnv(env);  hud.update(camera, pose, aim, s);
//   aim circle   at the aim's screen projection (the chase camera keeps it at the centre)
//   nose cross   where the nose points (1 km ahead)
//   left         speed (km/h) and g        right   altitude above sea level (y + DATUM) and radar altitude
//   bottom       throttle bar with the afterburner detent
//   centre       PULL UP (red, flashing) / STALL; RETURN TO BATTLE AREA above it
//
// PHASE 2: hud.setMode('chase'|'cockpit', hudRect?) -- call every frame. In cockpit mode the symbology is drawn in green-white
// "glass" style INSIDE hudRect ({x,y,w,h} in CSS pixels, from cockpitcam.hudRect(camera)): pitch ladder (conformal: it follows the
// real horizon, so it rolls with the bank and with head turns), heading tape, speed / altitude / throttle at the rect's sides,
// flight-path marker (where the velocity points), aim circle, boresight. One <canvas> is redrawn per frame with no allocations;
// the text is DOM. In chase mode the look is today's plus a small heading readout; hud.setLadder(true) adds the ladder there.
//
// PHASE 3 (the fight): hud.setFight({ me, enemy, combat, score:{ me, enemy, round } }) once or every frame (setFight(null) = off),
// then hud.update as before; hud.onEvent(e, meId) for the hit marker and the red "I was hit" flash. Drawn in both modes (cockpit:
// inside the glass rect, green): target box (distance; a ring closes while me.lock.progress rises; red + LOCK when locked), an
// arrow at the edge toward an off-screen enemy, the gun lead pip (within 1.5 km), MISSILE warning (flash rate rises as the missile
// closes) with a red arrow on a ring pointing at it, ammo (missiles, flares, gun rounds), my health, the enemy's health + name, score.
// The fighters are the README records: me.s.pos / vel, me.hp / alive / missiles / flares / gunAmmo / lock / warn.

import * as THREE from 'three';
import { AB_DETENT, WORLD_FRAME } from './jetspec.js';

const CSS = `
.fhud{position:absolute;inset:0;pointer-events:none;overflow:hidden;color:#fff;
  font-family:Rubik,ui-rounded,"SF Pro Rounded",system-ui,sans-serif;font-weight:700;
  text-shadow:0 1px 3px rgba(0,0,0,.55);--acc:#ffb43a;--panel:rgba(8,12,18,.42)}
.fhud .mk{position:absolute;left:0;top:0;will-change:transform}
.fhud .aim{width:34px;height:34px;margin:-17px 0 0 -17px;border:2.5px solid rgba(255,255,255,.92);border-radius:50%;
  box-shadow:0 0 0 1px rgba(0,0,0,.25),inset 0 0 0 1px rgba(0,0,0,.18)}
.fhud .nose{width:22px;height:22px;margin:-11px 0 0 -11px}
.fhud .nose:before,.fhud .nose:after{content:"";position:absolute;background:var(--acc);border-radius:2px;box-shadow:0 0 2px rgba(0,0,0,.6)}
.fhud .nose:before{left:10px;top:0;width:2.5px;height:22px}.fhud .nose:after{top:10px;left:0;height:2.5px;width:22px}
.fhud .side{position:absolute;top:50%;transform:translateY(-50%);background:var(--panel);border-radius:14px;padding:10px 14px;
  min-width:96px;backdrop-filter:blur(3px)}
.fhud .side.l{left:max(16px,18vw);text-align:right}.fhud .side.r{right:max(16px,18vw)}
.fhud .big{font-size:30px;line-height:1;letter-spacing:.5px;font-variant-numeric:tabular-nums}
.fhud .unit{font-size:12px;opacity:.7;letter-spacing:1px;margin-top:3px}
.fhud .small{font-size:15px;margin-top:8px;font-variant-numeric:tabular-nums;color:var(--acc)}
.fhud .thr{position:absolute;left:50%;bottom:26px;transform:translateX(-50%);width:min(260px,60vw);height:10px;
  background:var(--panel);border-radius:6px;overflow:hidden}
.fhud .thr i{position:absolute;left:0;top:0;bottom:0;width:0;background:#fff;border-radius:6px}
.fhud .thr i.ab{background:linear-gradient(90deg,#fff 0,#fff 80%,#ffb347 100%)}
.fhud .thr b{position:absolute;top:-2px;bottom:-2px;width:2px;background:var(--acc)}
.fhud .thrl{position:absolute;left:50%;bottom:42px;transform:translateX(-50%);font-size:12px;letter-spacing:1.5px;opacity:.8}
.fhud .warn{position:absolute;left:50%;top:30%;transform:translate(-50%,-50%);font-size:44px;letter-spacing:3px;
  padding:6px 22px;border-radius:14px;background:var(--panel);display:none;white-space:nowrap}
.fhud .warn.pull{color:#ff3b3b;animation:fhudBlink .5s steps(1) infinite}
.fhud .warn.stall{color:#ffc04d}
.fhud .warn.crash{color:#fff}
.fhud .edge{position:absolute;left:50%;top:18%;transform:translateX(-50%);font-size:20px;letter-spacing:2px;color:#ffc04d;
  padding:6px 16px;border-radius:12px;background:var(--panel);display:none;white-space:nowrap}
.fhud .cv{position:absolute;inset:0;width:100%;height:100%}
.fhud .hdg{position:absolute;left:50%;top:14px;transform:translateX(-50%);font-size:14px;letter-spacing:2px;padding:3px 12px;
  border-radius:10px;background:var(--panel);font-variant-numeric:tabular-nums}
.fhud.cp{--acc:#b6ffd0;--panel:rgba(0,28,12,.16);color:#d6ffe4;text-shadow:0 0 6px rgba(70,255,150,.6)}
.fhud.cp .mk,.fhud.cp .hdg{display:none}
.fhud.cp .side{border:1.5px solid rgba(190,255,210,.5);border-radius:6px;backdrop-filter:none;min-width:84px}
.fhud.cp .big{font-size:26px}
.fhud.cp .thr{border:1px solid rgba(190,255,210,.5);border-radius:3px}.fhud.cp .thr i{background:#c9ffd9;border-radius:0}
.fhud.cp .warn.pull{color:#ff5a4a}
.fhud .pt{position:absolute;left:0;top:0;will-change:transform}
.fhud .fo{display:none}
.fhud.fight .fo{display:block}
.fhud.fight .fx{display:flex}
.fhud.fight .hdg{top:100px}
.fhud .ftop{position:absolute;left:50%;top:14px;transform:translateX(-50%);flex-direction:column;align-items:center;gap:6px}
.fhud .fscore{font-size:20px;font-weight:800;letter-spacing:2px;background:var(--panel);padding:5px 18px;border-radius:12px;white-space:nowrap;font-variant-numeric:tabular-nums}
.fhud .fen{display:flex;align-items:center;gap:10px;font-size:14px;letter-spacing:1px;background:var(--panel);padding:6px 12px;border-radius:12px;white-space:nowrap}
.fhud .fen b{color:var(--acc);font-weight:800}
.fhud .fen .hb{width:150px}
.fhud .hb{height:10px;border-radius:5px;background:rgba(255,255,255,.2);overflow:hidden}
.fhud .hb i{display:block;height:100%;width:100%;background:#fff;border-radius:5px}
.fhud .hb.mid i{background:#ffb43a}.fhud .hb.low i{background:#ff4d3d}
.fhud .fme{position:absolute;left:20px;bottom:22px;width:230px;flex-direction:column;gap:6px;background:var(--panel);padding:9px 13px;border-radius:14px}
.fhud .flbl{font-size:11px;letter-spacing:1.5px;opacity:.8}
.fhud .fam{position:absolute;right:20px;bottom:22px;flex-direction:column;align-items:flex-end;gap:8px;background:var(--panel);padding:10px 14px;border-radius:14px}
.fhud .ar{display:flex;align-items:center;gap:8px;min-height:20px;font-size:11px;letter-spacing:1.5px}
.fhud .ar em{font-style:normal;opacity:.8}
.fhud .ar .gn{font-size:20px;font-weight:800;letter-spacing:.5px;font-variant-numeric:tabular-nums;min-width:40px;text-align:right}
.fhud .ar .gn.low{color:#ffb43a}.fhud .ar .gn.zero{color:#ff4d3d}
.fhud .mis,.fhud .fls{display:flex;align-items:center;gap:5px}
.fhud .mi{display:block;width:8px;height:20px;background:#fff;clip-path:polygon(50% 0,100% 26%,100% 100%,0 100%,0 26%)}
.fhud .fi{display:block;width:11px;height:11px;border-radius:50%;background:#ffb43a}
.fhud .mi.x,.fhud .fi.x{opacity:.2}
.fhud .tbox{width:58px;height:58px;margin:-29px 0 0 -29px;border:3px solid #fff;border-radius:10px;box-shadow:0 0 0 1px rgba(0,0,0,.35),0 0 12px rgba(0,0,0,.35)}
.fhud .tbox.lk{border-color:#ff4d3d;box-shadow:0 0 0 1px rgba(0,0,0,.35),0 0 16px rgba(255,77,61,.7)}
.fhud .tring{position:absolute;inset:-3px;border:3px solid #ffb43a;border-radius:14px;opacity:0}
.fhud .tlock{position:absolute;left:50%;bottom:100%;margin-bottom:10px;transform:translateX(-50%);font-size:15px;font-weight:800;letter-spacing:2px;color:#ff4d3d;background:var(--panel);padding:1px 10px;border-radius:8px;display:none}
.fhud .tbox.lk .tlock{display:block}.fhud .tbox.lk .tring{display:none}
.fhud .tdist{position:absolute;left:50%;top:100%;margin-top:11px;transform:translateX(-50%);font-size:14px;white-space:nowrap;background:var(--panel);padding:1px 9px;border-radius:8px;font-variant-numeric:tabular-nums}
.fhud .lead{width:16px;height:16px;margin:-8px 0 0 -8px;border:2.5px solid var(--acc);border-radius:50%;box-shadow:0 0 0 1px rgba(0,0,0,.3)}
.fhud .lead:after{content:"";position:absolute;left:5px;top:5px;width:3px;height:3px;border-radius:50%;background:var(--acc)}
.fhud .arrw{filter:drop-shadow(0 1px 2px rgba(0,0,0,.7))}
.fhud .tri{width:28px;height:28px;margin:-14px 0 0 -14px;background:#fff;clip-path:polygon(100% 50%,0 0,24% 50%,0 100%)}
.fhud .adist{font-size:13px;white-space:nowrap;transform-origin:0 0;background:var(--panel);padding:0 7px;border-radius:7px;font-variant-numeric:tabular-nums}
.fhud .mwarn{position:absolute;left:50%;top:66%;transform:translate(-50%,-50%);flex-direction:column;align-items:center;gap:6px}
.fhud .mw{font-size:54px;font-weight:800;letter-spacing:5px;line-height:1;color:#ff4d3d;background:var(--panel);padding:6px 24px;border-radius:14px}
.fhud .mw.off{opacity:.12}
.fhud .mf{font-size:18px;letter-spacing:2px;background:var(--panel);padding:3px 14px;border-radius:10px}
.fhud .mring{border:2px solid rgba(255,77,61,.35);border-radius:50%}
.fhud .marrw .tri{background:#ff4d3d}
.fhud .marrw.bk{opacity:.55}
.fhud .dmg{position:absolute;inset:0;box-shadow:inset 0 0 140px 36px rgba(255,77,61,.85);opacity:0}
.fhud .hitx{position:absolute;left:50%;top:50%;width:36px;height:36px;margin:-18px 0 0 -18px;opacity:0}
.fhud .hitx:before,.fhud .hitx:after{content:"";position:absolute;left:16px;top:-3px;width:4px;height:42px;background:#fff;border-radius:2px;box-shadow:0 0 4px rgba(0,0,0,.7)}
.fhud .hitx:before{transform:rotate(45deg)}.fhud .hitx:after{transform:rotate(-45deg)}
.fhud .hitx.m:before,.fhud .hitx.m:after{background:#ffb43a;width:6px;left:15px}
.fhud.cp .fme,.fhud.cp .fam,.fhud.cp .fscore,.fhud.cp .fen{border:1.5px solid rgba(190,255,210,.5);border-radius:6px}
.fhud.cp .tbox{border-color:#c9ffd9}.fhud.cp .tbox.lk{border-color:#ff4d3d}
.fhud.cp .tring{border-color:#c9ffd9}
.fhud.cp .lead{border-color:#c9ffd9}.fhud.cp .lead:after{background:#c9ffd9}
.fhud.cp .tri{background:#c9ffd9}.fhud.cp .marrw .tri{background:#ff5a4a}
.fhud.cp .hb i{background:#c9ffd9}.fhud.cp .hb.mid i{background:#ffd27a}.fhud.cp .hb.low i{background:#ff5a4a}
.fhud.cp .mi{background:#c9ffd9}.fhud.cp .fi{background:#c9ffd9}
.fhud.cp .fen b{color:#c9ffd9}.fhud.cp .mw{color:#ff5a4a}
.fhud.cp .ftop{flex-direction:row;align-items:center;gap:8px;top:8px}
.fhud.cp .fscore{font-size:14px;padding:3px 10px;letter-spacing:1px}.fhud.cp .fen{font-size:13px;padding:3px 10px}.fhud.cp .fen .hb{width:90px;height:8px}
.fhud.cp .fam{padding:6px 10px;gap:3px}.fhud.cp .ar .gn{font-size:17px}.fhud.cp .fme{padding:6px 12px}.fhud.cp .mw{font-size:40px}
@media (max-width:600px){.fhud .fme{width:150px}.fhud .mw{font-size:34px}.fhud .fscore{font-size:15px}}
@keyframes fhudBlink{50%{color:#fff;background:rgba(220,30,30,.75)}}
@media (max-width:600px){.fhud .big{font-size:22px}.fhud .warn{font-size:30px}.fhud .side{min-width:70px;padding:8px 10px}}
`;

const V = new THREE.Vector3();
const RAD = Math.PI / 180, TAU = Math.PI * 2;
const FONT = '700 13px Rubik,ui-rounded,system-ui,sans-serif';
const HDG = [], TAPE = [], PL = [];   // label tables, built once: no strings are made per frame
for (let i = 0; i < 360; i++) HDG.push(String(i).padStart(3, '0'));
for (let i = 0; i < 36; i++) TAPE.push(i % 9 === 0 ? 'NESW'[i / 9] : String(i).padStart(2, '0'));
for (let i = 0; i <= 9; i++) PL.push(String(i * 10));
const DASH = [7, 6], NODASH = [];
let PX = 0, PY = 0;   // projectDir's result (screen px)

/** Projects the world direction (heading H, pitch p; radians) seen from the camera into PX/PY. @returns {boolean} in front of the camera */
function projectDir(camera, H, p, w, h) {
  const cp = Math.cos(p), c = camera.position;
  V.set(c.x + Math.sin(H) * cp * 1000, c.y + Math.sin(p) * 1000, c.z - Math.cos(H) * cp * 1000).project(camera);
  PX = (V.x * 0.5 + 0.5) * w; PY = (0.5 - V.y * 0.5) * h;
  return V.z < 1 && V.z > -1;
}
/** same for a world vector (unit or not) */
function projectVec(camera, x, y, z, w, h) {
  const c = camera.position;
  V.set(c.x + x * 1000, c.y + y * 1000, c.z + z * 1000).project(camera);
  PX = (V.x * 0.5 + 0.5) * w; PY = (0.5 - V.y * 0.5) * h;
  return V.z < 1 && V.z > -1;
}

/**
 * @param {HTMLElement} root  the overlay is appended here (give it position:relative or fixed and full size)
 * @returns {{update:(camera:THREE.Camera, pose:{pos:number[],q:number[]}, aim:number[], s:object)=>void,
 *            setMode:(m:'chase'|'cockpit', rect?:{x:number,y:number,w:number,h:number})=>void, setLadder:(on:boolean)=>void,
 *            setEnv:(env:{terrainHeightAt?:(x:number,z:number)=>number})=>void, el:HTMLElement}}
 */
export function createHud(root) {
  if (!document.getElementById('fhud-css')) {
    const st = document.createElement('style'); st.id = 'fhud-css'; st.textContent = CSS; document.head.appendChild(st);
    const ln = document.createElement('link'); ln.rel = 'stylesheet';
    ln.href = 'https://fonts.googleapis.com/css2?family=Rubik:wght@500;700;800&display=swap'; document.head.appendChild(ln);
  }
  const el = document.createElement('div'); el.className = 'fhud';
  el.innerHTML = `<div class="side l"><div class="big" data-k="spd">0</div><div class="unit">KM/H</div><div class="small" data-k="g">1.0 G</div></div>
    <div class="side r"><div class="big" data-k="alt">0</div><div class="unit">M ALT</div><div class="small" data-k="ralt">R 0</div></div>
    <div class="thrl" data-k="thrl">THROTTLE</div><div class="thr"><i></i><b style="left:${AB_DETENT * 100}%"></b></div>
    <canvas class="cv"></canvas><div class="hdg" data-k="hdg">HDG 000</div>
    <div class="edge">RETURN TO BATTLE AREA</div><div class="warn"></div><div class="mk nose"></div><div class="mk aim"></div>
    <div class="fo fx ftop"><div class="fscore"></div><div class="fen"><b>VS</b><span class="fname"></span><div class="hb"><i></i></div></div></div>
    <div class="fo fx fme"><div class="flbl">HEALTH</div><div class="hb"><i></i></div></div>
    <div class="fo fx fam"><div class="ar"><em>MISSILES</em><span class="mis"><i class="mi"></i><i class="mi"></i><i class="mi"></i><i class="mi"></i></span></div>
      <div class="ar"><em>FLARES</em><span class="fls"><i class="fi"></i><i class="fi"></i><i class="fi"></i></span></div>
      <div class="ar"><em>GUN</em><span class="gn">0</span></div></div>
    <div class="fo pt tbox"><div class="tring"></div><div class="tlock">LOCK</div><div class="tdist"></div></div>
    <div class="fo pt lead"></div>
    <div class="fo pt arrw"><div class="tri"></div></div><div class="fo pt adist"></div>
    <div class="fo pt mring"></div><div class="fo pt arrw marrw"><div class="tri"></div></div>
    <div class="fo fx mwarn"><div class="mw">MISSILE</div><div class="mf">F — FLARES</div></div>
    <div class="fo dmg"></div><div class="fo hitx"></div>`;
  root.appendChild(el);
  const q = (s) => el.querySelector(s);
  const aimEl = q('.aim'), noseEl = q('.nose'), thrEl = q('.thr i'), warnEl = q('.warn'), edgeEl = q('.edge');
  const cv = q('.cv'), ctx = cv.getContext('2d'), sideL = q('.side.l'), sideR = q('.side.r'), thrBar = q('.thr'), thrLbl = q('.thrl');
  const txt = { hdg: q('[data-k=hdg]'), spd: q('[data-k=spd]'), g: q('[data-k=g]'), alt: q('[data-k=alt]'), ralt: q('[data-k=ralt]'), thrl: q('[data-k=thrl]') };
  const last = { hdg: '', spd: '', g: '', alt: '', ralt: '', thrl: '', warn: '', edge: null, thr: -1, ab: null, ax: NaN, ay: NaN, av: null, nx: NaN, ny: NaN, nv: null };
  let env = null, mode = 'chase', ladder = false, cvDirty = false, rectGiven = false, cvW = 0, cvH = 0, cvDpr = 0, lw = 0, lh = 0;
  const R = { x: 0, y: 0, w: 0, h: 0 };   // the glass rectangle (CSS px)


  // ---- PHASE 3: fight elements and state
  const fightNodes = {
    top: q('.ftop'), score: q('.fscore'), name: q('.fname'), enBar: q('.fen .hb'), meBox: q('.fme'), meBar: q('.fme .hb'), ammo: q('.fam'),
    mis: q('.mis').children, fls: q('.fls').children, gun: q('.gn'), tbox: q('.tbox'), ring: q('.tring'), tdist: q('.tdist'), lead: q('.lead'),
    arw: q('.arrw'), adist: q('.adist'), mring: q('.mring'), marw: q('.marrw'), mwarn: q('.mwarn'), mw: q('.mw'), dmg: q('.dmg'), hitx: q('.hitx'),
  };
  const FN = fightNodes;
  const F = { on: false, me: null, enemy: null, combat: null, score: null };
  const fl = {   // last written values (text / classes / positions), so nothing is touched twice
    sc: -1, name: '', enHp: -1, meHp: -1, mis: -1, fls: -1, gun: -1, tdist: -2, prog: -1, lk: null, tvis: null, lvis: null, avis: null, adist: -2,
    wvis: null, woff: null, wbk: null, mrr: -1, mrx: NaN, mry: NaN, now: 0, wphase: 0,
  };
  const ARW = { x: 0, y: 0 };   // edgeArrow's result: the clamped screen point

  const setText = (k, v) => { if (last[k] !== v) { last[k] = v; txt[k].textContent = v; } };
  // place a marker at a world point's projection; hidden when behind the camera
  function place(node, camera, x, y, z, kx, ky, kv) {
    V.set(x, y, z).project(camera);
    const vis = V.z < 1 && V.z > -1 && Math.abs(V.x) < 1.2 && Math.abs(V.y) < 1.2;
    if (vis !== last[kv]) { last[kv] = vis; node.style.display = vis ? '' : 'none'; }
    if (!vis) return;
    const px = (V.x * 0.5 + 0.5) * el.clientWidth, py = (0.5 - V.y * 0.5) * el.clientHeight;
    if (Math.abs(px - last[kx]) > 0.5 || Math.abs(py - last[ky]) > 0.5 || !(last[kx] === last[kx])) {
      last[kx] = px; last[ky] = py; node.style.transform = `translate(${px.toFixed(1)}px,${py.toFixed(1)}px)`;
    }
  }

  /** Moves the DOM readouts into the glass rect (cockpit) or back to their chase places (rect = null). */
  function layout(inRect) {
    const W = el.clientWidth, H = el.clientHeight; lw = W; lh = H;
    const px = (v) => `${Math.round(v)}px`;
    sideL.style.left = inRect ? px(R.x + 12) : ''; sideR.style.left = ''; sideR.style.right = inRect ? px(W - R.x - R.w + 12) : '';
    const cx = inRect ? px(R.x + R.w / 2) : '';
    // throttle, score, health and ammo stay at the screen edges in both views: inside the glass they crowded the flight symbols
    warnEl.style.left = edgeEl.style.left = cx; warnEl.style.top = inRect ? px(R.y + R.h * 0.3) : ''; edgeEl.style.top = inRect ? px(R.y + R.h * 0.18) : '';
    FN.mwarn.style.left = cx; FN.mwarn.style.top = inRect ? px(R.y + R.h * 0.7) : '';
    FN.hitx.style.left = inRect ? px(R.x + R.w / 2) : ''; FN.hitx.style.top = inRect ? px(R.y + R.h / 2) : '';
  }

  /**
   * Chase or cockpit; call every frame (cheap when nothing changed).
   * @param {'chase'|'cockpit'} m @param {{x:number,y:number,w:number,h:number}} [rect] glass rect in CSS px (cockpit); default = whole screen
   */
  function setMode(m, rect) {
    rectGiven = !!rect;
    const w = el.clientWidth, h = el.clientHeight;
    const x0 = rect ? rect.x : 0, y0 = rect ? rect.y : 0, w0 = rect ? rect.w : w, h0 = rect ? rect.h : h;
    const changed = m !== mode || x0 !== R.x || y0 !== R.y || w0 !== R.w || h0 !== R.h || w !== lw || h !== lh;
    if (!changed) return;
    if (m !== mode) { el.classList.toggle('cp', m === 'cockpit'); last.av = last.nv = null; last.ax = last.nx = NaN; cvDirty = true; }
    mode = m; R.x = x0; R.y = y0; R.w = w0; R.h = h0;
    layout(m === 'cockpit');
  }

  /** Strokes the pitch ladder (conformal to the world horizon) around heading H; glass = green-white, else plain white. */
  function drawLadder(camera, H, w, h) {
    for (let pass = 0; pass < 2; pass++) {   // pass 0: level and climbing lines (solid), pass 1: diving lines (dashed)
      ctx.setLineDash(pass ? DASH : NODASH); ctx.beginPath();
      for (let k = -8; k <= 8; k++) {
        if ((k < 0) !== (pass === 1)) continue;
        const p = k * 10 * RAD, sc = 1 / Math.max(0.3, Math.cos(p)), half = (k === 0 ? 14 : 5) * sc * RAD, gap = (k === 0 ? 3 : 1.6) * sc * RAD;
        for (let side = -1; side <= 1; side += 2) {
          if (!projectDir(camera, H + side * gap, p, w, h)) continue;
          const x1 = PX, y1 = PY;
          if (!projectDir(camera, H + side * half, p, w, h)) continue;
          const x2 = PX, y2 = PY;
          if (Math.max(x1, x2) < R.x - 40 || Math.min(x1, x2) > R.x + R.w + 40 || Math.max(y1, y2) < R.y - 40 || Math.min(y1, y2) > R.y + R.h + 40) continue;
          ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
          if (k !== 0) {   // end tick: toward the horizon (down for climb lines, up for dive lines), and the pitch number
            const dx = x2 - x1, dy = y2 - y1, l = Math.hypot(dx, dy) || 1, sg = side * (k > 0 ? 9 : -9);
            ctx.moveTo(x2, y2); ctx.lineTo(x2 + (-dy / l) * sg, y2 + (dx / l) * sg);
          }
        }
      }
      ctx.stroke();
    }
    ctx.setLineDash(NODASH); ctx.textBaseline = 'middle';
    for (let k = -8; k <= 8; k++) {
      if (k === 0) continue;
      const p = k * 10 * RAD, half = 5 / Math.max(0.3, Math.cos(p)) * RAD;
      for (let side = -1; side <= 1; side += 2) {
        if (!projectDir(camera, H + side * half, p, w, h)) continue;
        if (PX < R.x || PX > R.x + R.w || PY < R.y || PY > R.y + R.h) continue;
        ctx.textAlign = side < 0 ? 'right' : 'left'; ctx.fillText(PL[Math.abs(k)], PX + side * 8, PY);
      }
    }
  }

  /** Redraws the canvas: clipped to the glass rect (cockpit) or the screen (chase ladder). */
  function drawCanvas(camera, pose, aim, s, hd, pitch, glass) {
    const w = el.clientWidth, h = el.clientHeight, dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (w !== cvW || h !== cvH || dpr !== cvDpr) { cvW = w; cvH = h; cvDpr = dpr; cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
    ctx.save(); ctx.beginPath(); ctx.rect(R.x, R.y, R.w, R.h); ctx.clip();
    const ink = glass ? '#c9ffd9' : 'rgba(255,255,255,.85)';
    ctx.strokeStyle = ink; ctx.fillStyle = ink; ctx.lineWidth = glass ? 2 : 1.6; ctx.font = FONT; ctx.lineCap = 'round';
    ctx.shadowColor = glass ? 'rgba(60,255,140,.8)' : 'rgba(0,0,0,.5)'; ctx.shadowBlur = glass ? 5 : 3;
    drawLadder(camera, hd, w, h);
    if (glass) {
      const cx = R.x + R.w / 2, tw = Math.min(R.w * 0.45, 560), ty = R.y + Math.min(R.h * 0.1, 60) + 24, hdDeg = hd / RAD, pxPerDeg = tw / 50;
      // heading tape: ticks every 5 degrees, numbers every 10, the current heading in a box above
      ctx.beginPath();
      for (let d = Math.floor(hdDeg / 5) * 5 - 25; d <= hdDeg + 26; d += 5) {
        const x = cx + (d - hdDeg) * pxPerDeg; if (x < cx - tw / 2 || x > cx + tw / 2) continue;
        const dd = ((d % 360) + 360) % 360, big = dd % 10 === 0;
        ctx.moveTo(x, ty); ctx.lineTo(x, ty + (big ? 12 : 7));
      }
      ctx.moveTo(cx - tw / 2, ty); ctx.lineTo(cx + tw / 2, ty);
      ctx.rect(cx - 24, ty - 28, 48, 20); ctx.moveTo(cx - 6, ty - 8); ctx.lineTo(cx, ty); ctx.lineTo(cx + 6, ty - 8);
      ctx.stroke();
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      for (let d = Math.floor(hdDeg / 10) * 10 - 20; d <= hdDeg + 21; d += 10) {
        const x = cx + (d - hdDeg) * pxPerDeg; if (x < cx - tw / 2 + 8 || x > cx + tw / 2 - 8) continue;
        ctx.fillText(TAPE[((Math.round(d / 10) % 36) + 36) % 36], x, ty + 24);
      }
      ctx.fillText(HDG[Math.round(hdDeg + 720) % 360], cx, ty - 18);
      // flight-path marker: a circle with wings and a fin, where the velocity points
      const vm = 1 / (Math.hypot(s.vel[0], s.vel[1], s.vel[2]) || 1);
      if (s.speed > 5 && projectVec(camera, s.vel[0] * vm, s.vel[1] * vm, s.vel[2] * vm, w, h)) {
        ctx.beginPath(); ctx.moveTo(PX + 7, PY); ctx.arc(PX, PY, 7, 0, TAU);
        ctx.moveTo(PX - 7, PY); ctx.lineTo(PX - 17, PY); ctx.moveTo(PX + 7, PY); ctx.lineTo(PX + 17, PY); ctx.moveTo(PX, PY - 7); ctx.lineTo(PX, PY - 13); ctx.stroke();
      }
      // aim circle (where the mouse wants to go) and the boresight cross (the nose)
      if (projectVec(camera, aim[0], aim[1], aim[2], w, h)) { ctx.beginPath(); ctx.moveTo(PX + 15, PY); ctx.arc(PX, PY, 15, 0, TAU); ctx.moveTo(PX + 1.5, PY); ctx.arc(PX, PY, 1.5, 0, TAU); ctx.stroke(); }
      if (projectDir(camera, hd, pitch, w, h)) { ctx.beginPath(); ctx.moveTo(PX - 8, PY); ctx.lineTo(PX + 8, PY); ctx.moveTo(PX, PY - 8); ctx.lineTo(PX, PY + 8); ctx.stroke(); }
    }
    ctx.restore(); cvDirty = true;
  }


  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  /** moves a node (kept at the origin by .pt) to px,py, rotated by `rot` radians; skipped when it hasn't moved */
  function mv(node, x, y, rot) {
    if (Math.abs(x - node._x) < 0.5 && Math.abs(y - node._y) < 0.5 && Math.abs(rot - node._r) < 0.01) return;
    node._x = x; node._y = y; node._r = rot;
    node.style.transform = rot ? `translate(${x.toFixed(1)}px,${y.toFixed(1)}px) rotate(${rot.toFixed(3)}rad)` : `translate(${x.toFixed(1)}px,${y.toFixed(1)}px)`;
  }
  for (const n of [FN.tbox, FN.lead, FN.arw, FN.adist, FN.mring, FN.marw]) { n._x = n._y = n._r = NaN; }
  const vis = (node, key, on) => { if (fl[key] !== on) { fl[key] = on; node.style.display = on ? '' : 'none'; } };
  const bar = (node, key, hp) => {   // a health bar: width in 1% steps, amber under 50%, red under 25%
    const v = Math.round(clamp01(hp) * 100);
    if (fl[key] === v) return; fl[key] = v;
    node.firstElementChild.style.width = `${v}%`; node.className = v < 25 ? 'hb low' : v < 50 ? 'hb mid' : 'hb';
  };
  const icons = (list, key, n, cls) => {   // n of the icons lit, the spent ones dim
    if (fl[key] === n) return; fl[key] = n;
    for (let i = 0; i < list.length; i++) list[i].className = i < n ? cls : `${cls} x`;
  };
  /** "2.4 km" / "0.45 km", rebuilt only when the rounded value changes. @returns {number} the cache key */
  const kmKey = (d) => (d < 1000 ? -Math.round(d / 10) - 1 : Math.round(d / 100));
  const kmText = (key) => (key < 0 ? `${((-key - 1) / 100).toFixed(2)} km` : `${(key / 10).toFixed(1)} km`);

  /**
   * Camera-space position of a world point -> screen px. Writes ARW.x/y; @returns {boolean} in front of the camera.
   * ex/ey (camera-space x right, y up) stay in CX/CY for the edge arrow, also when the point is behind.
   */
  let CX = 0, CY = 0;
  function toScreen(camera, x, y, z, w, h) {
    V.set(x, y, z).applyMatrix4(camera.matrixWorldInverse);
    CX = V.x; CY = V.y;
    if (V.z > -0.01) return false;
    const e = camera.projectionMatrix.elements;
    ARW.x = (CX * e[0] / -V.z * 0.5 + 0.5) * w; ARW.y = (0.5 - CY * e[5] / -V.z * 0.5) * h;
    return true;
  }

  /** The point where the ray from the rect centre along screen direction (dx,dy) meets the rect inset by `m`. Writes ARW. */
  function edgePoint(dx, dy, m) {
    const hx = R.w / 2 - m, hy = R.h / 2 - m, ax = Math.abs(dx), ay = Math.abs(dy);
    const k = Math.min(ax > 1e-6 ? hx / ax : 1e9, ay > 1e-6 ? hy / ay : 1e9);
    ARW.x = R.x + R.w / 2 + dx * k; ARW.y = R.y + R.h / 2 + dy * k;
  }

  /** The fight overlay, once per display frame (after the camera and pose are placed). */
  function fightUpdate(camera, pose) {
    const me = F.me, en = F.enemy, W = lw, H = lh, now = performance.now();
    const dt = fl.now ? Math.min(0.1, (now - fl.now) / 1000) : 0; fl.now = now;
    const meAlive = me.alive !== false;

    // score, names, health, ammo
    const sc = F.score;
    if (sc) {
      const key = sc.round * 10000 + sc.me * 100 + sc.enemy;
      if (key !== fl.sc) { fl.sc = key; FN.score.textContent = `ROUND ${sc.round} · YOU ${sc.me} – ${sc.enemy} ${en && !en.isAI ? 'ENEMY' : 'AI'}`; }
    }
    FN.score.style.display = sc ? '' : 'none';
    const nm = en ? (en.isAI ? `${en.name} (AI)` : en.name) : '';
    if (nm !== fl.name) { fl.name = nm; FN.name.textContent = nm; }
    FN.enBar.parentElement.style.display = en ? '' : 'none';
    if (en) bar(FN.enBar, 'enHp', en.hp);
    bar(FN.meBar, 'meHp', me.hp);
    icons(FN.mis, 'mis', me.missiles, 'mi'); icons(FN.fls, 'fls', me.flares, 'fi');
    if (me.gunAmmo !== fl.gun) { fl.gun = me.gunAmmo; FN.gun.textContent = String(me.gunAmmo); FN.gun.className = me.gunAmmo <= 0 ? 'gn zero' : me.gunAmmo < 60 ? 'gn low' : 'gn'; }

    // the enemy: target box on screen, else an arrow at the edge
    let showBox = false, showArw = false, showLead = false;
    if (en && en.alive !== false && meAlive) {
      const ex = en.s.pos[0], ey = en.s.pos[1], ez = en.s.pos[2];
      const dist = Math.hypot(ex - pose.pos[0], ey - pose.pos[1], ez - pose.pos[2]);
      const front = toScreen(camera, ex, ey, ez, W, H), sx = ARW.x, sy = ARW.y, ox = CX, oy = CY;
      const inside = front && sx > R.x + 44 && sx < R.x + R.w - 44 && sy > R.y + 44 && sy < R.y + R.h - 44;
      const key = kmKey(dist);
      if (inside) {
        showBox = true; mv(FN.tbox, sx, sy, 0);
        if (key !== fl.tdist) { fl.tdist = key; FN.tdist.textContent = kmText(key); }
        const lk = me.lock, prog = lk && !lk.locked ? clamp01(lk.progress) : 0, locked = !!(lk && lk.locked);
        if (locked !== fl.lk) { fl.lk = locked; FN.tbox.classList.toggle('lk', locked); }
        const pq = Math.round(prog * 50);
        if (pq !== fl.prog) { fl.prog = pq; FN.ring.style.opacity = pq ? '1' : '0'; FN.ring.style.transform = `scale(${(2.6 - 1.6 * pq / 50).toFixed(3)})`; }
      } else {
        showArw = true;
        let dx = ox, dy = -oy; const l = Math.hypot(dx, dy);
        if (l < 1e-4) { dx = 1; dy = 0; } else { dx /= l; dy /= l; }   // dead ahead / behind with no sideways part: point right
        edgePoint(dx, dy, 56);
        mv(FN.arw, ARW.x, ARW.y, Math.atan2(dy, dx));
        mv(FN.adist, ARW.x - dx * 50 - 28, ARW.y - dy * 30 - 9, 0);
        if (key !== fl.adist) { fl.adist = key; FN.adist.textContent = kmText(key); }
      }
      // gun lead: where the target will be when a 1000 m/s round gets there (two refinements)
      if (dist < 1500 && front) {
        let t = dist / 1000, px = ex, py = ey, pz = ez;
        for (let i = 0; i < 3; i++) {
          px = ex + en.s.vel[0] * t; py = ey + en.s.vel[1] * t; pz = ez + en.s.vel[2] * t;
          t = Math.hypot(px - pose.pos[0], py - pose.pos[1], pz - pose.pos[2]) / 1000;
        }
        if (toScreen(camera, px, py, pz, W, H) && ARW.x > R.x + 20 && ARW.x < R.x + R.w - 20 && ARW.y > R.y + 20 && ARW.y < R.y + R.h - 20) { showLead = true; mv(FN.lead, ARW.x, ARW.y, 0); }
      }
    }
    vis(FN.tbox, 'tvis', showBox); vis(FN.arw, 'avis', showArw); FN.adist.style.display = showArw ? '' : 'none'; vis(FN.lead, 'lvis', showLead);

    // missile warning: flashing text (faster as it closes) + a red arrow on a ring around the centre
    const w = me.warn, wOn = !!(w && w.missile) && meAlive;
    vis(FN.mwarn, 'wvis', wOn); vis(FN.mring, 'wvis2', wOn); vis(FN.marw, 'wvis3', wOn);
    if (wOn) {
      fl.wphase += dt * (2 + 8 * (1 - clamp01(w.dist / 2500)));
      const off = fl.wphase % 1 > 0.6;
      if (off !== fl.woff) { fl.woff = off; FN.mw.className = off ? 'mw off' : 'mw'; }
      const rr = Math.min(R.w, R.h) * 0.22, cx = R.x + R.w / 2, cy = R.y + R.h / 2;
      if (rr !== fl.mrr || cx !== fl.mrx || cy !== fl.mry) {
        fl.mrr = rr; fl.mrx = cx; fl.mry = cy;
        FN.mring.style.width = FN.mring.style.height = `${rr * 2}px`; FN.mring.style.margin = `${-rr}px 0 0 ${-rr}px`; FN.mring.style.transform = `translate(${cx}px,${cy}px)`;
      }
      V.set(w.dir[0], w.dir[1], w.dir[2]).transformDirection(camera.matrixWorldInverse);   // into the camera frame
      let dx = V.x, dy = -V.y; const l = Math.hypot(dx, dy);
      if (l < 0.05) { dx = 0; dy = -1; } else { dx /= l; dy /= l; }
      mv(FN.marw, cx + dx * rr, cy + dy * rr, Math.atan2(dy, dx));
      const bk = V.z > 0;   // behind us: dimmer
      if (bk !== fl.wbk) { fl.wbk = bk; FN.marw.classList.toggle('bk', bk); }
    } else fl.wphase = 0;
  }

  /** A flash of the screen edge when I'm hit, and an X at the centre when my shot lands. e = a combat event, meId = my fighter id. */
  function onEvent(e, meId) {
    if (!F.on) return;
    const kind = e.type || e.kind || e.name || e.event;   // README names the events but not the field: accept the usual ones
    let mine = false, onMe = false;
    if (kind === 'gunHit' || kind === 'missileHit') {
      let owner = e.owner;
      if (owner === undefined) {   // missileHit carries the missile (object or id): its owner fired it
        const m = typeof e.missile === 'object' ? e.missile : F.combat && F.combat.missiles.find((k) => k.id === e.missile);
        owner = m ? m.owner : e.target === meId ? -1 : meId;
      }
      mine = owner === meId; onMe = e.target === meId;
      if (mine) {
        FN.hitx.className = kind === 'missileHit' ? 'fo hitx m' : 'fo hitx';
        FN.hitx.animate([{ opacity: 1, transform: 'scale(1.4)' }, { opacity: 1, transform: 'scale(1)', offset: 0.25 }, { opacity: 0, transform: 'scale(.9)' }], { duration: kind === 'missileHit' ? 450 : 260 });
      }
      if (onMe) FN.dmg.animate([{ opacity: kind === 'missileHit' ? 1 : 0.7 }, { opacity: 0 }], { duration: kind === 'missileHit' ? 700 : 350 });
    }
  }

  /**
   * Once per display frame, after the camera has moved.
   * @param {THREE.Camera} camera @param {{pos:number[],q:number[]}} pose the drawn (interpolated) pose
   * @param {number[]} aim unit world direction @param {import('./flight.js').JetState} s
   */
  function update(camera, pose, aim, s) {
    camera.updateMatrixWorld();   // matrixWorldInverse is only refreshed at render time otherwise: the markers would lag a frame
    if (!rectGiven) setMode(mode);   // no rect from the caller: the glass is the whole screen and follows resizes
    const cp = camera.position, cockpit = mode === 'cockpit';
    if (!cockpit) place(aimEl, camera, cp.x + aim[0] * 2000, cp.y + aim[1] * 2000, cp.z + aim[2] * 2000, 'ax', 'ay', 'av');
    // the nose: body +z through q, 1 km ahead of the jet
    const x = pose.q[0], y = pose.q[1], z = pose.q[2], w = pose.q[3];
    const fx = 2 * (x * z + w * y), fy = 2 * (y * z - w * x), fz = 1 - 2 * (x * x + y * y);
    if (!cockpit) place(noseEl, camera, pose.pos[0] + fx * 1000, pose.pos[1] + fy * 1000, pose.pos[2] + fz * 1000, 'nx', 'ny', 'nv');
    const hd = Math.atan2(fx, -fz), pitch = Math.asin(Math.max(-1, Math.min(1, fy)));   // heading clockwise from north (-z), radians
    if (!cockpit) setText('hdg', `HDG ${HDG[Math.round(hd / RAD + 720) % 360]}`);
    if (cockpit || ladder) drawCanvas(camera, pose, aim, s, hd, pitch, cockpit);
    else if (cvDirty) { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, cv.width, cv.height); cvDirty = false; }

    setText('spd', String(Math.round(s.speed * 3.6)));
    setText('g', `${s.gLoad.toFixed(1)} G`);
    setText('alt', String(Math.round(pose.pos[1] + WORLD_FRAME.datum)));
    const gnd = env && env.terrainHeightAt ? env.terrainHeightAt(pose.pos[0], pose.pos[2]) : NaN;
    setText('ralt', gnd === gnd ? `R ${Math.max(0, Math.round(pose.pos[1] - gnd))}` : '');
    const thr = Math.round(s.throttle * 200) / 200;
    if (thr !== last.thr) { last.thr = thr; thrEl.style.width = `${thr * 100}%`; }
    const ab = s.ab > 0.01;
    if (ab !== last.ab) { last.ab = ab; thrEl.className = ab ? 'ab' : ''; }
    setText('thrl', s.brake > 0.5 ? 'AIR BRAKE' : ab ? 'AFTERBURNER' : 'THROTTLE');

    const wk = s.crashed ? 'crash' : s.warn.pullUp ? 'pull' : s.warn.stall ? 'stall' : '';
    if (wk !== last.warn) {
      last.warn = wk; warnEl.className = `warn ${wk}`; warnEl.style.display = wk ? 'block' : 'none';
      warnEl.textContent = wk === 'crash' ? 'CRASHED' : wk === 'pull' ? 'PULL UP' : wk === 'stall' ? 'STALL' : '';
    }
    const edge = !s.crashed && s.warn.boundary;
    if (edge !== last.edge) { last.edge = edge; edgeEl.style.display = edge ? 'block' : 'none'; }
    if (F.on) fightUpdate(camera, pose);
  }

  /**
   * Turns the fight overlay on (or off with null). Cheap enough to call every frame: it only copies references.
   * @param {{me:object, enemy?:object, combat?:object, score?:{me:number, enemy:number, round:number}}|null} o  README fighter records
   */
  function setFight(o) {
    const on = !!(o && o.me);
    if (on) { F.me = o.me; F.enemy = o.enemy || null; F.combat = o.combat || null; F.score = o.score || null; } else F.me = F.enemy = F.combat = F.score = null;
    if (on !== F.on) { F.on = on; el.classList.toggle('fight', on); }
  }
  return { update, setMode, setFight, onEvent, setLadder(on) { ladder = !!on; }, setEnv(e) { env = e; }, el };
}
