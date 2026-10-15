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
@keyframes fhudBlink{50%{color:#fff;background:rgba(220,30,30,.75)}}
@media (max-width:600px){.fhud .big{font-size:22px}.fhud .warn{font-size:30px}.fhud .side{min-width:70px;padding:8px 10px}}
`;

const V = new THREE.Vector3();

/**
 * @param {HTMLElement} root  the overlay is appended here (give it position:relative or fixed and full size)
 * @returns {{update:(camera:THREE.Camera, pose:{pos:number[],q:number[]}, aim:number[], s:object)=>void,
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
    <div class="edge">RETURN TO BATTLE AREA</div><div class="warn"></div><div class="mk nose"></div><div class="mk aim"></div>`;
  root.appendChild(el);
  const q = (s) => el.querySelector(s);
  const aimEl = q('.aim'), noseEl = q('.nose'), thrEl = q('.thr i'), warnEl = q('.warn'), edgeEl = q('.edge');
  const txt = { spd: q('[data-k=spd]'), g: q('[data-k=g]'), alt: q('[data-k=alt]'), ralt: q('[data-k=ralt]'), thrl: q('[data-k=thrl]') };
  const last = { spd: '', g: '', alt: '', ralt: '', thrl: '', warn: '', edge: null, thr: -1, ab: null, ax: NaN, ay: NaN, av: null, nx: NaN, ny: NaN, nv: null };
  let env = null;

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

  /**
   * Once per display frame, after the camera has moved.
   * @param {THREE.Camera} camera @param {{pos:number[],q:number[]}} pose the drawn (interpolated) pose
   * @param {number[]} aim unit world direction @param {import('./flight.js').JetState} s
   */
  function update(camera, pose, aim, s) {
    const cp = camera.position;
    place(aimEl, camera, cp.x + aim[0] * 2000, cp.y + aim[1] * 2000, cp.z + aim[2] * 2000, 'ax', 'ay', 'av');
    // the nose: body +z through q, 1 km ahead of the jet
    const x = pose.q[0], y = pose.q[1], z = pose.q[2], w = pose.q[3];
    const fx = 2 * (x * z + w * y), fy = 2 * (y * z - w * x), fz = 1 - 2 * (x * x + y * y);
    place(noseEl, camera, pose.pos[0] + fx * 1000, pose.pos[1] + fy * 1000, pose.pos[2] + fz * 1000, 'nx', 'ny', 'nv');

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
  return { update, setEnv(e) { env = e; }, el };
}
