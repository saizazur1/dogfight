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

import * as THREE from 'three';
import { AB_DETENT, WORLD_FRAME } from './jetspec.js';

const CSS = `
.fhud{position:absolute;inset:0;pointer-events:none;overflow:hidden;color:#fff;
  font-family:"Nunito","Varela Round",ui-rounded,"SF Pro Rounded",system-ui,sans-serif;font-weight:800;
  text-shadow:0 1px 3px rgba(0,0,0,.55);--acc:#4fe3ff;--panel:rgba(8,12,18,.42)}
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
@keyframes fhudBlink{50%{color:#fff;background:rgba(220,30,30,.75)}}
@media (max-width:600px){.fhud .big{font-size:22px}.fhud .warn{font-size:30px}.fhud .side{min-width:70px;padding:8px 10px}}
`;

const V = new THREE.Vector3();
const RAD = Math.PI / 180, TAU = Math.PI * 2;
const FONT = '800 13px Nunito,"Varela Round",ui-rounded,system-ui,sans-serif';
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
    ln.href = 'https://fonts.googleapis.com/css2?family=Nunito:wght@800&display=swap'; document.head.appendChild(ln);
  }
  const el = document.createElement('div'); el.className = 'fhud';
  el.innerHTML = `<div class="side l"><div class="big" data-k="spd">0</div><div class="unit">KM/H</div><div class="small" data-k="g">1.0 G</div></div>
    <div class="side r"><div class="big" data-k="alt">0</div><div class="unit">M ALT</div><div class="small" data-k="ralt">R 0</div></div>
    <div class="thrl" data-k="thrl">THROTTLE</div><div class="thr"><i></i><b style="left:${AB_DETENT * 100}%"></b></div>
    <canvas class="cv"></canvas><div class="hdg" data-k="hdg">HDG 000</div>
    <div class="edge">RETURN TO BATTLE AREA</div><div class="warn"></div><div class="mk nose"></div><div class="mk aim"></div>`;
  root.appendChild(el);
  const q = (s) => el.querySelector(s);
  const aimEl = q('.aim'), noseEl = q('.nose'), thrEl = q('.thr i'), warnEl = q('.warn'), edgeEl = q('.edge');
  const cv = q('.cv'), ctx = cv.getContext('2d'), sideL = q('.side.l'), sideR = q('.side.r'), thrBar = q('.thr'), thrLbl = q('.thrl');
  const txt = { hdg: q('[data-k=hdg]'), spd: q('[data-k=spd]'), g: q('[data-k=g]'), alt: q('[data-k=alt]'), ralt: q('[data-k=ralt]'), thrl: q('[data-k=thrl]') };
  const last = { hdg: '', spd: '', g: '', alt: '', ralt: '', thrl: '', warn: '', edge: null, thr: -1, ab: null, ax: NaN, ay: NaN, av: null, nx: NaN, ny: NaN, nv: null };
  let env = null, mode = 'chase', ladder = false, cvDirty = false, rectGiven = false, cvW = 0, cvH = 0, cvDpr = 0, lw = 0, lh = 0;
  const R = { x: 0, y: 0, w: 0, h: 0 };   // the glass rectangle (CSS px)

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
    const cx = inRect ? px(R.x + R.w / 2) : '', bot = inRect ? H - R.y - R.h : 0;
    thrBar.style.left = thrLbl.style.left = cx; thrBar.style.bottom = inRect ? px(bot + 14) : ''; thrLbl.style.bottom = inRect ? px(bot + 30) : '';
    warnEl.style.left = edgeEl.style.left = cx; warnEl.style.top = inRect ? px(R.y + R.h * 0.3) : ''; edgeEl.style.top = inRect ? px(R.y + R.h * 0.18) : '';
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
  }
  return { update, setMode, setLadder(on) { ladder = !!on; }, setEnv(e) { env = e; }, el };
}
