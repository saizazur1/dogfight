/**
 * hype.js (lane HYPE) — the juice and the hype announcer (README "Hooks contract"). DOM + camera only, never writes the sim.
 *
 *   const hype = createHype(root, { sound });        // root = document.body; sound = sound.js (oneShot kinds tick, thunk, kill, ...)
 *   hype.onEvent(e, ctx)                              // ctx = { meId, byId(id) -> fighter|null, me, modeId }; every combat / mode event
 *   hype.frame(frameDt, camera, me, view)             // after the camera is placed: shake, FOV kick (chase only), speed lines, slow-mo clock
 *   hype.say(text, { sub, tone: 'gold'|'red'|'white'|'cyan', voice: true|'spoken text' })   // a big callout (+ a spoken line)
 *   hype.popup(text, tone)                            // a small "+100" floating up from the crosshair
 *   hype.slowmo                                       // 1, or 0.3 for 0.7 s REAL time (then eased back) after MY kill
 *   hype.reset()  hype.setVoice(on)
 *
 * WHAT IT DOES: screen shake (a trauma value: hits on me, my missile hits, explosions near me, a rumble while my gun fires;
 * angles + a little position jitter applied on top of the chase / cockpit camera, halved for prefers-reduced-motion), a +6° FOV
 * kick on afterburner / boost (chase view only: chasecam rewrites camera.fov every frame, we add on top), speed-line streaks at
 * the screen edges when fast on afterburner (a half-res canvas; none for reduced motion), hit ticks, "+N" pop-ups from POINTS,
 * the kill feed (top right, last 5), and the announcer: DOUBLE / TRIPLE / QUAD KILL (my kills within 4 s), streaks 3 ON FIRE /
 * 5 UNSTOPPABLE / 7 LEGENDARY, CLUTCH (hp < 25 %), REVENGE, FIRST BLOOD (Chaos), SKILL ISSUE, SHOT DOWN by <name>, pick-ups,
 * SUPPLY DROP INCOMING, and a spoken W / L at the match end (the card shows the giant W / L glyph).
 * The layer sits at z-index 12: over the HUD (no z-index), under the cards (15) and the menu (20). pointer-events none.
 * Per frame: no allocations (pooled DOM, typed arrays for the streaks); everything is fenced so it never throws.
 */
import { POINTS } from './points.js';

/** Every feel number in one place. Times in ms unless named _s. */
export const HYPE = {
  multiWindow_s: 4, clutchHp: 0.25,
  slowmo: 0.3, slowHold_s: 0.7, slowEase_s: 0.3,
  fovKick: 6, fovRate: 4,                       // deg, 1/s
  shakeDecay: 1.5,                              // trauma per real second
  shakeYaw: 0.03, shakePitch: 0.03, shakeRoll: 0.05, shakePos: 0.5, shakePosCockpit: 0.03,   // rad / m at full trauma
  hit: { meMissile: 0.95, meGun: 0.22, myMissile: 0.38, gunRumble: 0.2, near: 0.6, meDead: 0.8, shieldHit: 0.18 },
  nearR: 700,                                   // m: an explosion closer than this shakes me
  gunTickGap: 60, gunPopGap: 300, calloutHold: 650,
  speedFrom: 180, speedSpan: 100,               // m/s: the streaks fade in from 180 to 280 m/s (on afterburner)
};

const CSS = `
.dfh{position:fixed;inset:0;z-index:12;pointer-events:none;overflow:hidden;font-family:Rubik,system-ui,sans-serif;color:#fff;-webkit-font-smoothing:antialiased}
.dfh .sl{position:absolute;inset:0;width:100%;height:100%}
.dfh .co{position:absolute;left:50%;top:22%;display:flex;flex-direction:column;align-items:center;gap:4px;padding:8px 30px 11px;border-radius:18px;
  background:rgba(10,12,18,.58);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);box-shadow:0 10px 40px rgba(0,0,0,.35);opacity:0;white-space:nowrap;transform:translate(-50%,-50%)}
.dfh .co.on{animation:dfhPop 1.9s ease-out forwards}
.dfh .ct{font-weight:800;font-size:clamp(38px,8.5vh,88px);letter-spacing:.05em;line-height:1;text-shadow:0 3px 18px rgba(0,0,0,.5)}
.dfh .co.long .ct{font-size:clamp(28px,6vh,60px)}
.dfh .cs{font-weight:700;font-size:clamp(14px,2.4vh,22px);letter-spacing:.08em;opacity:.92}
.dfh .g{color:#ffb43a}.dfh .r{color:#ff4d3d}.dfh .c{color:#4fe3ff}.dfh .w{color:#fff}
.dfh .co.g .ct{text-shadow:0 0 30px rgba(255,180,58,.6),0 3px 18px rgba(0,0,0,.5)}
.dfh .co.r .ct{text-shadow:0 0 30px rgba(255,77,61,.55),0 3px 18px rgba(0,0,0,.5)}
.dfh .co.c .ct{text-shadow:0 0 30px rgba(79,227,255,.55),0 3px 18px rgba(0,0,0,.5)}
.dfh .co .cs{color:#fff}
.dfh .pp i{position:absolute;left:50%;top:50%;font-style:normal;font-weight:800;font-size:26px;opacity:0;white-space:nowrap;
  text-shadow:0 0 3px #000,0 0 2px #000,0 2px 12px rgba(0,0,0,.75);--x:26px;--y:-44px}
.dfh .pp i.on{animation:dfhUp .95s ease-out forwards}
.dfh .kf{position:absolute;top:44px;right:16px;display:flex;flex-direction:column;align-items:flex-end;gap:5px}
.dfh .kf>div{display:flex;align-items:center;gap:8px;padding:5px 11px;border-radius:10px;background:rgba(10,12,18,.52);font-weight:700;font-size:15px;opacity:0;white-space:nowrap}
.dfh .kf>div.me{background:rgba(10,12,18,.66);box-shadow:inset 0 0 0 2px rgba(255,180,58,.9)}
.dfh .kf>div.on{animation:dfhFeed 6.4s linear forwards}
.dfh .kf b{font-weight:800;text-shadow:0 0 2px rgba(0,0,0,.95),0 1px 4px rgba(0,0,0,.8)}
.dfh .kf span{opacity:.8}.dfh .kf em{font-style:normal;opacity:.75;font-size:13px;font-weight:700}
@keyframes dfhPop{0%{opacity:0;transform:translate(-50%,-50%) scale(1.9) rotate(-9deg)}10%{opacity:1;transform:translate(-50%,-50%) scale(.93) rotate(-3deg)}
  17%{transform:translate(-50%,-50%) scale(1.04) rotate(-3deg)}23%{transform:translate(-50%,-50%) scale(1) rotate(-3deg)}
  82%{opacity:1;transform:translate(-50%,-50%) scale(1) rotate(-3deg)}100%{opacity:0;transform:translate(-50%,-64%) scale(.97) rotate(-3deg)}}
@keyframes dfhUp{0%{opacity:0;transform:translate(var(--x),var(--y)) scale(.6)}14%{opacity:1;transform:translate(var(--x),calc(var(--y) - 8px)) scale(1.18)}
  28%{transform:translate(var(--x),calc(var(--y) - 14px)) scale(1)}100%{opacity:0;transform:translate(var(--x),calc(var(--y) - 56px)) scale(1)}}
@keyframes dfhFeed{0%{opacity:0;transform:translateX(24px)}4%{opacity:1;transform:none}88%{opacity:1}100%{opacity:0}}
@keyframes dfhFade{0%{opacity:0;transform:translate(-50%,-50%)}8%,82%{opacity:1;transform:translate(-50%,-50%)}100%{opacity:0;transform:translate(-50%,-50%)}}
@media (prefers-reduced-motion:reduce){.dfh .co.on{animation-name:dfhFade}}
`;

const TONE = { gold: 'g', red: 'r', white: 'w', cyan: 'c' };
const MULTI = ['', '', 'DOUBLE KILL', 'TRIPLE KILL', 'QUAD KILL'];
const STREAKS = { 3: 'ON FIRE', 5: 'UNSTOPPABLE', 7: 'LEGENDARY' };
const PICKUPS = { shield: 'SHIELD UP', repair: 'REPAIRED', missiles: 'MISSILES REFILLED', boost: 'BOOST', drop: 'SUPPLY DROP' };
const PICKSUB = { shield: '6 s no damage', repair: '+50 % health', missiles: 'Full rack', boost: '6 s more thrust', drop: 'Everything refilled' };
const NOVELTY = /Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Good News|Jester|Organ|Superstar|Trinoids|Whisper|Wobble|Zarvox|Junior|Ralph|Fred|Kathy|Grandma|Grandpa|Rocko|Shelley|Eddy|Flo|Reed|Sandy/i;
const N_STREAK = 60;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const wob = (x) => Math.sin(x) * 0.6 + Math.sin(x * 2.17 + 1.3) * 0.4;   // smooth pseudo-noise, -1..1
/** true for a colour too dark to read on the dark feed pill (its name is mixed further toward white) */
function isDark(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return false;
  const n = parseInt(m[1], 16);
  return (0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255 < 0.3;
}

/**
 * @param {HTMLElement} root  where the layer goes (document.body)
 * @param {{sound?:{oneShot?:(kind:string, pos?:number[])=>void}}} [o]
 */
export function createHype(root, { sound } = {}) {
  if (!document.getElementById('dfh-css')) {
    const st = document.createElement('style'); st.id = 'dfh-css'; st.textContent = CSS; document.head.appendChild(st);
  }
  const layer = document.createElement('div'); layer.className = 'dfh';
  layer.innerHTML = '<canvas class="sl"></canvas><div class="co" role="status" aria-live="polite"><div class="ct"></div><div class="cs"></div></div>'
    + `<div class="pp">${'<i></i>'.repeat(8)}</div><div class="kf">${'<div><b></b><span>✈</span><b></b><em>crashed</em></div>'.repeat(5)}</div>`;
  root.appendChild(layer);
  const canvas = layer.children[0], co = layer.children[1], ct = co.children[0], cs = co.children[1];
  const pops = Array.from(layer.children[2].children), feedEl = layer.children[3], rows = Array.from(feedEl.children);
  const g2 = canvas.getContext('2d');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');

  // ---- state
  let trauma = 0, shT = 0, kick = 0, lastNow = performance.now(), gunUntil = 0, slowT0 = -1;
  let tickT = -1e9, gunAcc = 0, gunPopT = -1e9, shieldT = -1e9, popI = 0, popT = -1e9, stackK = 0, rowI = 0, coT = -1e9, coPrio = 0;
  let streak = 0, multi = 0, lastKillT = -1e9, lastKiller = -1, firstBlood = false, ended = false, voiceOn = true, voice = null, warned = 0;
  const sa = new Float32Array(N_STREAK), sc = new Float32Array(N_STREAK), ss = new Float32Array(N_STREAK);
  const sr = new Float32Array(N_STREAK), sv = new Float32Array(N_STREAK), sl = new Float32Array(N_STREAK);
  let slOn = false, cw = 0, ch = 0;

  const warn = (where, e) => { if (warned++ < 5) console.warn(`hype: ${where}`, e); };
  const S = (kind) => { try { sound?.oneShot?.(kind); } catch (e) { warn('sound', e); } };
  const bump = (a) => { trauma = Math.min(1, trauma + a); };
  const fighter = (ctx, id) => { try { return id >= 0 && ctx?.byId ? ctx.byId(id) : null; } catch { return null; } };

  // ---- voice (speechSynthesis): one line at a time, the previous one is cancelled
  function pickVoice() {
    try {
      const vs = window.speechSynthesis.getVoices().filter((v) => /^en/i.test(v.lang) && !NOVELTY.test(v.name));
      voice = vs.find((v) => /^en[-_]US/i.test(v.lang) && /Google US|Samantha|Aria|Jenny|Guy|Alex|Ava|Allison/i.test(v.name))
        || vs.find((v) => /^en[-_]US/i.test(v.lang)) || vs[0] || null;
    } catch { voice = null; }
  }
  try { if (window.speechSynthesis) { pickVoice(); window.speechSynthesis.addEventListener?.('voiceschanged', pickVoice); } } catch { /* no speech */ }
  function speak(text) {
    if (!voiceOn || !text) return;
    try {
      const syn = window.speechSynthesis, U = window.SpeechSynthesisUtterance;
      if (!syn || !U) return;
      syn.cancel();
      const u = new U(text); u.rate = 1.1; u.pitch = 1.05;
      if (voice) { u.voice = voice; u.lang = voice.lang; } else u.lang = 'en-US';
      syn.speak(u);
    } catch (e) { warn('speak', e); }
  }
  const hush = () => { try { window.speechSynthesis?.cancel(); } catch { /* no speech */ } };

  // ---- the big callout, pop-ups, kill feed
  /** prio (internal): a fresh callout (< 650 ms) is not replaced by a lower-priority one (pick-up 1 < kill / death 2 < big 3) */
  function say(text, o = {}) {
    try {
      const prio = o.prio ?? 2, now = performance.now();
      if (now - coT < HYPE.calloutHold && prio < coPrio) return;
      coT = now; coPrio = prio;
      ct.textContent = text; cs.textContent = o.sub || ''; cs.style.display = o.sub ? '' : 'none';
      co.className = `co ${TONE[o.tone] || 'w'}${text.length > 11 ? ' long' : ''}`;
      void co.offsetWidth;   // restart the animation
      co.classList.add('on');
      if (o.voice) speak(typeof o.voice === 'string' ? o.voice : text.toLowerCase());
    } catch (e) { warn('say', e); }
  }
  function popup(text, tone = 'gold') {
    try {
      const now = performance.now();
      stackK = now - popT < 350 ? (stackK + 1) % 4 : 0; popT = now;   // pop-ups at the same moment sit side by side
      const el = pops[popI]; popI = (popI + 1) % pops.length;
      el.textContent = text; el.className = TONE[tone] || 'g';
      el.style.setProperty('--x', `${26 + stackK * 66}px`);   // side by side: stacking upward would run into the callout
      void el.offsetWidth;
      el.classList.add('on');
    } catch (e) { warn('popup', e); }
  }
  function flushGun(now) { if (gunAcc) { popup(`+${gunAcc}`, 'white'); gunAcc = 0; gunPopT = now; } }
  function nameInto(el, f) {
    // the fighter's colour lifted toward white so every hue reads on the dark pill (event time only, never per frame)
    el.textContent = f ? f.name : '?'; el.style.color = f?.color ? `color-mix(in srgb, ${f.color} ${isDark(f.color) ? 35 : 68}%, #fff)` : '#fff';
  }
  function feed(ctx, e, solo) {
    const row = rows[rowI]; rowI = (rowI + 1) % rows.length;
    const [k, sep, v, tail] = row.children;
    if (solo) { nameInto(k, fighter(ctx, e.victim)); v.style.display = 'none'; tail.style.display = ''; }
    else { nameInto(k, fighter(ctx, e.killer)); nameInto(v, fighter(ctx, e.victim)); v.style.display = ''; tail.style.display = 'none'; }
    sep.style.display = '';
    row.className = e.killer === ctx.meId || e.victim === ctx.meId ? 'me' : '';
    feedEl.insertBefore(row, feedEl.firstChild);
    void row.offsetWidth;
    row.classList.add('on');
  }
  /** an explosion at pos shakes me if it is close */
  function near(pos, me) {
    if (!pos || !me?.s) return;
    const p = me.s.pos, d = Math.hypot(pos[0] - p[0], pos[1] - p[1], pos[2] - p[2]);
    if (d < HYPE.nearR) bump(HYPE.hit.near * (1 - d / HYPE.nearR));
  }

  // ---- events
  function onKill(e, ctx, now) {
    const meId = ctx.meId, me = ctx.me, kf = fighter(ctx, e.killer), vf = fighter(ctx, e.victim);
    const solo = e.killer < 0 || e.killer === e.victim || !kf;
    feed(ctx, e, solo);
    const first = !solo && !firstBlood && ctx.modeId === 'chaos'; if (!solo) firstBlood = true;
    if (e.victim === meId) {
      streak = 0; multi = 0; bump(HYPE.hit.meDead);
      if (solo) say('SKILL ISSUE', { sub: 'You crashed', tone: 'red', voice: 'Skill issue', prio: 3 });
      else { lastKiller = e.killer; say('SHOT DOWN', { sub: `by ${kf.name}`, tone: 'red', voice: 'Shot down', prio: 3 }); }
      return;
    }
    if (vf && e.cause !== 'crash') near(vf.s?.pos, me);
    if (e.killer !== meId || solo) { if (first) say('FIRST BLOOD', { sub: kf ? kf.name : '', tone: 'white', prio: 1 }); return; }
    // my kill
    const t = e.t ?? now / 1000;
    multi = t - lastKillT <= HYPE.multiWindow_s ? multi + 1 : 1; lastKillT = t;
    streak++;
    const tags = [];
    if (multi >= 2) tags.push(MULTI[Math.min(multi, 4)]);
    if (STREAKS[streak]) tags.push(STREAKS[streak]);
    if (me && me.hp > 0 && me.hp < HYPE.clutchHp) tags.push('CLUTCH');
    if (e.victim === lastKiller) { tags.push('REVENGE'); lastKiller = -1; }
    if (first) tags.push('FIRST BLOOD');
    const big = tags.length > 0, main = big ? tags.shift() : 'ELIMINATED';
    if (STREAKS[streak]) tags.push(`${streak} STREAK`);
    if (vf) tags.push(vf.name);
    say(main, { sub: tags.join(' · '), tone: 'gold', voice: big, prio: big ? 3 : 2 });
    S('kill'); if (big) S('stinger');
    popup(`+${POINTS.kill}`, 'gold');
    slowT0 = now; api.slowmo = HYPE.slowmo;
  }

  function handle(e, ctx) {
    const meId = ctx ? ctx.meId : 0, now = performance.now(), me = ctx?.me;
    switch (e.type) {
      case 'gunFired': if (e.owner === meId) gunUntil = now + 160; break;
      case 'gunHit':
        if (e.target === meId) bump(HYPE.hit.meGun);
        else if (e.owner === meId) {
          if (now - tickT > HYPE.gunTickGap) { tickT = now; S('tick'); }
          gunAcc += POINTS.gunHit; if (now - gunPopT > HYPE.gunPopGap) flushGun(now);
        }
        break;
      case 'missileHit':
        if (e.target === meId) bump(HYPE.hit.meMissile);
        else { if (e.owner === meId) { S('thunk'); popup(`+${POINTS.missileHit}`, 'gold'); bump(HYPE.hit.myMissile); } near(e.pos, me); }
        break;
      case 'shieldHit': if (e.target === meId) { if (now - shieldT > 250) { shieldT = now; S('shield'); } bump(HYPE.hit.shieldHit); } break;
      case 'kill': if (ctx) onKill(e, ctx, now); break;
      case 'pickup':
        if (e.owner === meId) {
          say(PICKUPS[e.kind] || 'POWER-UP', { sub: PICKSUB[e.kind] || '', tone: 'cyan', prio: 1 });
          S(e.kind === 'shield' ? 'shield' : 'pickup'); popup(`+${POINTS.pickup}`, 'cyan');
        }
        break;
      case 'dropIncoming': say('SUPPLY DROP INCOMING', { sub: 'Watch the radar', tone: 'cyan', voice: 'Supply drop incoming', prio: 2 }); S('drop'); break;
      case 'match':
        slowT0 = -1; api.slowmo = 1; ended = true; co.classList.remove('on');   // the end card has the stage (giant W / L); no streaks / kick behind it
        if (e.result === 'win') { S('levelup'); popup(`+${POINTS.matchWin}`, 'gold'); speak('W! G G!'); }
        else if (e.result === 'lose') speak('L. Run it back.');
        else speak('G G.');
        break;
      case 'round': if (e.result === 'win') { S('stinger'); popup(`+${POINTS.roundWin}`, 'gold'); } break;
      case 'wave': S('levelup'); popup(`+${POINTS.wave}`, 'gold'); break;
      case 'ring': S('pickup'); popup(`+${POINTS.ring}`, 'gold'); break;
      default: break;
    }
  }

  // ---- speed lines: N streaks flying outward from ~45 % of the half-diagonal, one stroke call (half-res canvas)
  function seed(i, r) {
    const a = Math.random() * 6.2832;
    sa[i] = a; sc[i] = Math.cos(a); ss[i] = Math.sin(a); sr[i] = r; sv[i] = 0.9 + Math.random() * 0.9; sl[i] = 0.06 + Math.random() * 0.12;
  }
  for (let i = 0; i < N_STREAK; i++) seed(i, 0.45 + Math.random() * 0.6);
  function speedLines(k, dt) {
    if (k < 0.03) { if (slOn) { g2.clearRect(0, 0, cw, ch); slOn = false; } return; }
    const w = innerWidth >> 1, h = innerHeight >> 1;
    if (w !== cw || h !== ch) {
      canvas.width = cw = w; canvas.height = ch = h;
      const R = Math.hypot(cw, ch) / 2, grad = g2.createRadialGradient(cw / 2, ch / 2, R * 0.42, cw / 2, ch / 2, R);
      grad.addColorStop(0, 'rgba(255,255,255,0)'); grad.addColorStop(0.35, 'rgba(255,255,255,.75)'); grad.addColorStop(1, 'rgba(255,255,255,.95)');
      g2.strokeStyle = grad; g2.lineWidth = 1.6; g2.lineCap = 'round';
    }
    g2.clearRect(0, 0, cw, ch);
    const cx = cw / 2, cy = ch / 2, R = Math.hypot(cx, cy), adv = dt * (0.6 + 1.2 * k);
    g2.beginPath();
    for (let i = 0; i < N_STREAK; i++) {
      sr[i] += sv[i] * adv;
      if (sr[i] > 1.05) seed(i, 0.45 + Math.random() * 0.1);
      const r0 = sr[i] * R, r1 = (sr[i] + sl[i]) * R;
      g2.moveTo(cx + sc[i] * r0, cy + ss[i] * r0); g2.lineTo(cx + sc[i] * r1, cy + ss[i] * r1);
    }
    g2.globalAlpha = 0.55 * k; g2.stroke();
    slOn = true;
  }

  // ---- per frame
  function frame(frameDt, camera, me, view) {
    try {
      const now = performance.now();
      let rdt = (now - lastNow) / 1000; lastNow = now;   // REAL seconds: frameDt is scaled by the slow motion
      rdt = rdt > 0 ? (rdt > 0.1 ? 0.1 : rdt) : 0;
      if (slowT0 >= 0) {
        const a = (now - slowT0) / 1000;
        if (a < HYPE.slowHold_s) api.slowmo = HYPE.slowmo;
        else if (a < HYPE.slowHold_s + HYPE.slowEase_s) { const k = (a - HYPE.slowHold_s) / HYPE.slowEase_s; api.slowmo = HYPE.slowmo + (1 - HYPE.slowmo) * k * k * (3 - 2 * k); }
        else { api.slowmo = 1; slowT0 = -1; }
      }
      if (gunAcc && now - gunPopT > HYPE.gunPopGap) flushGun(now);
      const s = me?.s, rm = reduce.matches;
      // screen shake on top of the placed camera (the cameras rewrite position + rotation every frame: no build-up)
      trauma = Math.max(0, trauma - rdt * HYPE.shakeDecay);
      const tr = Math.max(trauma, now < gunUntil ? HYPE.hit.gunRumble : 0), amp = tr * tr * (rm ? 0.5 : 1);
      if (camera && amp > 1e-4) {
        shT += rdt;
        const pm = (view === 'cockpit' ? HYPE.shakePosCockpit : HYPE.shakePos) * amp;
        camera.rotateY(amp * HYPE.shakeYaw * wob(shT * 21));
        camera.rotateX(amp * HYPE.shakePitch * wob(shT * 19 + 5));
        camera.rotateZ(amp * HYPE.shakeRoll * wob(shT * 15 + 9));
        camera.translateX(pm * wob(shT * 25 + 7)); camera.translateY(pm * wob(shT * 23 + 3));
        camera.updateMatrixWorld();
      }
      // afterburner / boost FOV kick (chase only: chasecam rewrote camera.fov this frame; the cockpit fov is left alone)
      const burn = s && !s.crashed && !ended ? Math.max(s.ab || 0, s.boost > 0 ? 1 : 0) : 0;
      kick += ((view === 'chase' ? burn : 0) - kick) * (1 - Math.exp(-HYPE.fovRate * rdt));
      if (camera && view === 'chase' && kick > 0.002) { camera.fov += kick * HYPE.fovKick; camera.updateProjectionMatrix(); }
      const fast = s ? clamp01((s.speed - HYPE.speedFrom) / HYPE.speedSpan) : 0;
      speedLines(rm ? 0 : burn * fast, rdt);
    } catch (e) { warn('frame', e); }
  }

  function reset() {
    streak = 0; multi = 0; lastKillT = -1e9; lastKiller = -1; firstBlood = false; ended = false;
    trauma = 0; kick = 0; slowT0 = -1; api.slowmo = 1; gunAcc = 0; gunUntil = 0; coT = -1e9;
    co.classList.remove('on');
    for (const r of rows) r.classList.remove('on');
    for (const p of pops) p.classList.remove('on');
    speedLines(0, 0);
    hush();
  }

  const api = {
    slowmo: 1,
    onEvent(e, ctx) { try { if (e) handle(e, ctx); } catch (err) { warn('onEvent', err); } },
    frame, say, popup, reset,
    setVoice(on) { voiceOn = !!on; if (!voiceOn) hush(); },
    el: layer,
  };
  return api;
}
