// radar.js -- the round radar, bottom-left above the health box (lane UI, phase 4). One <canvas>, heading-up, 8 km range, ring at 4 km.
//
//   const radar = createRadar(root);          // root = the HUD's overlay element (position fixed / relative, full size); the canvas goes into it
//   radar.update(me, fighters, combat, playArea, camera);   // every display frame; it redraws itself at most 30 times a second
//   radar.setVisible(bool);  radar.setMode('chase'|'cockpit'|null);   // null (default) = auto: green when root or a child has class 'cp' (hud.js sets it)
//
//   me, fighters   README fighter records (s.pos, s.q, alive, id); `fighters` may include me (skipped)
//   combat         { missiles: [{ owner, target, pos[3], alive }] } or null;  playArea { cx, cz, half } (a square) or null
//   camera         unused for now (the radar turns with MY nose heading, not the camera)
// Shows: enemies as red triangles pointing their heading (beyond range: pinned to the rim and dimmed), my missiles as small white dots,
// missiles chasing me as red blinking dots, the play-area boundary as an amber line, and a small N. Nothing is allocated per frame.

const CSS = `
.rdr{position:absolute;left:20px;bottom:100px;width:170px;height:170px;pointer-events:none;border-radius:50%;
  background:rgba(8,12,18,.42);box-shadow:0 0 0 1.5px rgba(255,255,255,.28);-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px)}
.rdr.cp{background:rgba(0,28,12,.2);box-shadow:0 0 0 1.5px rgba(190,255,210,.5);-webkit-backdrop-filter:none;backdrop-filter:none}
.rdr.off{display:none}
.rdr canvas{position:absolute;left:-15px;top:-15px;width:200px;height:200px}
`;
const SIZE = 170, PAD = 15, BOX = SIZE + 2 * PAD, C = BOX / 2, R = SIZE / 2 - 3, RANGE = 8000, SCALE = R / RANGE;
const RATE_MS = 1000 / 30;
const DASH = [5, 4], NODASH = [];
const TAU = Math.PI * 2;
let PX = 0, PY = 0;   // rel()'s result (canvas px)

/** @param {HTMLElement} root @returns {{update:Function, setVisible:(on:boolean)=>void, setMode:(m:string|null)=>void, el:HTMLElement}} */
export function createRadar(root) {
  if (!document.getElementById('rdr-css')) { const st = document.createElement('style'); st.id = 'rdr-css'; st.textContent = CSS; document.head.appendChild(st); }
  const el = document.createElement('div'); el.className = 'rdr';
  const cv = document.createElement('canvas'); el.appendChild(cv); root.appendChild(el);
  const ctx = cv.getContext('2d');
  let dpr = 0, tint = false, forced = null, visible = true, lastDraw = 0;
  let h = 0, sh = 0, ch = 1, ox = 0, oz = 0;   // my heading (rad, clockwise from north = -z), its sin / cos, my position

  /** world (x,z) -> canvas px relative to me, heading-up. Writes PX/PY. */
  function rel(x, z) {
    const dx = x - ox, dz = z - oz;
    PX = C + (dx * ch + dz * sh) * SCALE; PY = C - (dx * sh - dz * ch) * SCALE;
  }
  const headingOf = (q) => Math.atan2(2 * (q[0] * q[2] + q[3] * q[1]), -(1 - 2 * (q[0] * q[0] + q[1] * q[1])));   // nose = body +z through q; north = -z

  function setTint(on) { if (on !== tint) { tint = on; el.classList.toggle('cp', on); } }

  /** Redraws when 33 ms passed. Cheap to call every frame. */
  function update(me, fighters, combat, playArea, camera) { // eslint-disable-line no-unused-vars
    if (!visible || !me) return;
    const now = performance.now();
    if (now - lastDraw < RATE_MS) return;
    lastDraw = now;
    setTint(forced ? forced === 'cockpit' : root.classList.contains('cp') || !!root.querySelector('.cp'));
    const d = Math.min(window.devicePixelRatio || 1, 2);
    if (d !== dpr) { dpr = d; cv.width = cv.height = Math.round(BOX * d); }
    const ink = tint ? '#c9ffd9' : '#fff', ring = tint ? 'rgba(190,255,210,.4)' : 'rgba(255,255,255,.3)', foe = tint ? '#ff5a4a' : '#ff4d3d';
    ctx.setTransform(d, 0, 0, d, 0, 0); ctx.clearRect(0, 0, BOX, BOX);
    ox = me.s.pos[0]; oz = me.s.pos[2]; h = headingOf(me.s.q); sh = Math.sin(h); ch = Math.cos(h);

    // rings, cross hairs, labels
    ctx.lineWidth = 1; ctx.strokeStyle = ring; ctx.fillStyle = ink; ctx.font = '700 11px Rubik,system-ui,sans-serif'; ctx.textBaseline = 'middle';
    ctx.beginPath(); ctx.arc(C, C, R / 2, 0, TAU); ctx.moveTo(C - R, C); ctx.lineTo(C + R, C); ctx.moveTo(C, C - R); ctx.lineTo(C, C + R); ctx.stroke();
    ctx.globalAlpha = 0.8; ctx.textAlign = 'right'; ctx.fillText('8 km', BOX - 2, BOX - 6); ctx.textAlign = 'left'; ctx.fillText('4', C + R / 2 * 0.72 + 3, C - R / 2 * 0.72 - 4);
    ctx.globalAlpha = 1;

    // everything below is clipped to the disc
    ctx.save(); ctx.beginPath(); ctx.arc(C, C, R, 0, TAU); ctx.clip();
    if (playArea) {   // the boundary square, rotated with the radar
      const x0 = playArea.cx - playArea.half, x1 = playArea.cx + playArea.half, z0 = playArea.cz - playArea.half, z1 = playArea.cz + playArea.half;
      ctx.strokeStyle = '#ffb43a'; ctx.lineWidth = 2; ctx.setLineDash(DASH); ctx.beginPath();
      rel(x0, z0); ctx.moveTo(PX, PY); rel(x1, z0); ctx.lineTo(PX, PY); rel(x1, z1); ctx.lineTo(PX, PY); rel(x0, z1); ctx.lineTo(PX, PY); ctx.closePath(); ctx.stroke();
      ctx.setLineDash(NODASH);
    }
    if (combat && combat.missiles) {
      const blink = (now / 170) & 1;
      for (let i = 0; i < combat.missiles.length; i++) {
        const m = combat.missiles[i];
        if (!m.alive) continue;
        const mine = m.owner === me.id, atMe = m.target === me.id && !mine;
        if (!mine && !atMe) continue;
        rel(m.pos[0], m.pos[2]);
        if (Math.hypot(PX - C, PY - C) > R) continue;
        if (atMe) { if (!blink) continue; ctx.fillStyle = foe; ctx.beginPath(); ctx.arc(PX, PY, 3.4, 0, TAU); ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.stroke(); }
        else { ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(PX, PY, 2.2, 0, TAU); ctx.fill(); }
      }
    }
    ctx.fillStyle = foe; ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.lineWidth = 1;
    for (let i = 0; i < fighters.length; i++) {
      const f = fighters[i];
      if (f === me || f.alive === false) continue;
      rel(f.s.pos[0], f.s.pos[2]);
      let dx = PX - C, dy = PY - C; const dist = Math.hypot(dx, dy), out = dist > R - 6;
      if (out) { const k = (R - 6) / dist; dx *= k; dy *= k; }
      ctx.globalAlpha = out ? 0.6 : 1;
      ctx.save(); ctx.translate(C + dx, C + dy); ctx.rotate(headingOf(f.s.q) - h); ctx.scale(1.25, 1.25);
      ctx.beginPath(); ctx.moveTo(0, -6); ctx.lineTo(4.5, 5); ctx.lineTo(0, 2.5); ctx.lineTo(-4.5, 5); ctx.closePath(); ctx.fill(); ctx.stroke(); ctx.restore();
    }
    ctx.globalAlpha = 1; ctx.restore();

    // me (centre, pointing up) and the N on the rim
    ctx.fillStyle = ink; ctx.beginPath(); ctx.moveTo(C, C - 6); ctx.lineTo(C + 4.5, C + 5); ctx.lineTo(C, C + 2.5); ctx.lineTo(C - 4.5, C + 5); ctx.closePath(); ctx.fill();
    ctx.textAlign = 'center'; ctx.globalAlpha = 0.9; ctx.fillText('N', C - sh * (R - 8), C - ch * (R - 8)); ctx.globalAlpha = 1;
  }

  return { update, el,
    setVisible(on) { visible = !!on; el.classList.toggle('off', !on); },
    setMode(m) { forced = m === 'chase' || m === 'cockpit' ? m : null; } };
}
