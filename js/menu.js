// menu.js -- the start screen, pause screen and settings panel (lane UI, phase 2). Plain DOM, own CSS, no dependencies.
// Style: one big PLAY button, white on translucent dark panels with backdrop blur, one accent (#ffb43a), the live 3D scene
// visible behind. Everything is remembered in localStorage (try/catch: it works without it).
//
//   const menu = createMenu(rootDiv, { onPlay, onResume, onQuit, onSettings, onChange });
//   menu.show('start' | 'pause' | 'none')
//   menu.settings  { sensitivity (multiplier, 1 = default), invertY, volume (0..1), quality (0 low, 1 medium, 2 high), showFps }
//   menu.profile   { name, color ('#rrggbb'), skill ('easy'|'medium'|'hard') }
//   menu.onChange = (settings) => {}      // also fires for the options.onChange passed at creation; every settings edit
//   menu.screen    // 'start' | 'pause' | 'none' (what is showing; the settings panel counts as its parent screen)
// Enter plays (start) / resumes (pause); Esc resumes (pause) or goes back (settings). Real inputs underneath: Tab, arrows, Space work.

const KEY = 'dogfight.menu.v1';
const COLORS = [['#c8362c', 'Red'], ['#2b62cf', 'Blue'], ['#e0a020', 'Amber'], ['#3a9d5a', 'Green'], ['#8a4fd0', 'Violet'], ['#e7e7ea', 'White'], ['#2a2d33', 'Black'], ['#e0663a', 'Orange']];
const SKILLS = [['easy', 'Easy'], ['medium', 'Medium'], ['hard', 'Hard']];
const QUALITY = [['0', 'Low'], ['1', 'Medium'], ['2', 'High']];
const NAMES = ['Falcon', 'Viper', 'Raven', 'Condor', 'Maverick', 'Comet', 'Ghost', 'Hawk', 'Eagle', 'Storm', 'Phantom', 'Blaze'];
const DEFAULTS = { settings: { sensitivity: 1, invertY: false, volume: 0.8, quality: 2, showFps: false }, profile: { name: '', color: COLORS[0][0], skill: 'medium' } };

const CSS = `
.dfm{position:fixed;inset:0;z-index:20;display:flex;align-items:center;justify-content:center;font-family:Rubik,system-ui,sans-serif;color:#fff;
  background:radial-gradient(ellipse at 50% 45%,rgba(8,10,16,.18),rgba(8,10,16,.62));-webkit-font-smoothing:antialiased;overflow:auto}
.dfm[hidden]{display:none}
.dfm *{box-sizing:border-box}
.dfm .scr{display:none;flex-direction:column;align-items:center;gap:16px;width:min(440px,92vw);margin:auto;padding:16px 0}
.dfm .scr.on{display:flex}
.dfm h1{margin:0;font-weight:800;font-size:clamp(46px,8vh,76px);letter-spacing:.06em;line-height:1;text-shadow:0 3px 24px rgba(0,0,0,.55)}
.dfm h1 b{color:#ffb43a;font-weight:800}
.dfm h2{margin:0;font-weight:800;font-size:34px;letter-spacing:.08em}
.dfm .pnl{width:100%;background:rgba(12,14,20,.62);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);border-radius:20px;padding:22px 24px;
  display:flex;flex-direction:column;gap:16px;box-shadow:0 10px 40px rgba(0,0,0,.35)}
.dfm .lbl{font-weight:700;font-size:12px;letter-spacing:.12em;text-transform:uppercase;opacity:.7;margin-bottom:7px;display:flex;justify-content:space-between}
.dfm input[type=text]{width:100%;font:700 18px Rubik,system-ui,sans-serif;color:#fff;background:rgba(255,255,255,.1);border:2px solid transparent;border-radius:12px;padding:11px 14px;outline:none}
.dfm input[type=text]:focus{border-color:#ffb43a}
.dfm .sw{display:flex;gap:10px;justify-content:space-between}
.dfm .sw label{position:relative;width:38px;height:38px;cursor:pointer}
.dfm .sw input{position:absolute;inset:0;opacity:0;margin:0;cursor:pointer}
.dfm .sw i{position:absolute;inset:0;border-radius:50%;border:3px solid rgba(255,255,255,.25);transition:transform .12s,border-color .12s}
.dfm .sw label:hover i{transform:scale(1.1)}
.dfm .sw input:checked+i{border-color:#fff;transform:scale(1.12);box-shadow:0 0 0 3px rgba(255,180,58,.9)}
.dfm .sw input:focus-visible+i{outline:3px solid #ffb43a;outline-offset:3px}
.dfm .seg{display:flex;background:rgba(255,255,255,.1);border-radius:12px;padding:3px;gap:3px}
.dfm .seg label{position:relative;flex:1;text-align:center;cursor:pointer}
.dfm .seg input{position:absolute;inset:0;opacity:0;margin:0;cursor:pointer}
.dfm .seg span{display:block;padding:9px 0;border-radius:9px;font-weight:700;font-size:15px;transition:background .12s,color .12s}
.dfm .seg input:checked+span{background:#ffb43a;color:#1a1205}
.dfm .seg input:focus-visible+span{outline:3px solid #fff;outline-offset:1px}
.dfm button{font-family:inherit;cursor:pointer;border:0}
.dfm .big{width:100%;font-weight:800;font-size:28px;letter-spacing:.1em;color:#1a1205;background:#ffb43a;border-radius:16px;padding:16px 0;
  box-shadow:0 6px 0 #b9761a,0 12px 28px rgba(0,0,0,.35);transition:transform .08s,box-shadow .08s,filter .12s}
.dfm .big:hover{filter:brightness(1.08)}
.dfm .big:active{transform:translateY(4px);box-shadow:0 2px 0 #b9761a,0 6px 16px rgba(0,0,0,.35)}
.dfm .big:focus-visible,.dfm .lnk:focus-visible,.dfm .sec:focus-visible,.dfm .tg:focus-visible{outline:3px solid #fff;outline-offset:3px}
.dfm .sec{width:100%;font-weight:700;font-size:17px;color:#fff;background:rgba(255,255,255,.14);border-radius:12px;padding:12px 0}
.dfm .sec:hover{background:rgba(255,255,255,.22)}
.dfm .keys{white-space:nowrap;font-size:13px;opacity:.8;text-align:center;line-height:1.4;text-shadow:0 1px 6px rgba(0,0,0,.6)}
.dfm .lnk{background:none;color:#fff;opacity:.75;font-weight:500;font-size:14px;text-decoration:underline;padding:6px 10px;border-radius:8px}
.dfm .lnk:hover{opacity:1}
.dfm .row{display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:38px}
.dfm .row>span{font-weight:500;font-size:16px;flex:1}
.dfm .val{opacity:.7;font-variant-numeric:tabular-nums;min-width:44px;text-align:right;font-size:14px}
.dfm input[type=range]{-webkit-appearance:none;appearance:none;width:170px;height:6px;border-radius:3px;background:rgba(255,255,255,.25);outline:none;margin:0}
.dfm input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:22px;height:22px;border-radius:50%;background:#ffb43a;border:0;cursor:pointer}
.dfm input[type=range]::-moz-range-thumb{width:22px;height:22px;border-radius:50%;background:#ffb43a;border:0;cursor:pointer}
.dfm input[type=range]:focus-visible{outline:3px solid #fff;outline-offset:6px}
.dfm .tg{width:52px;height:30px;border-radius:15px;background:rgba(255,255,255,.25);position:relative;transition:background .15s;padding:0}
.dfm .tg:after{content:"";position:absolute;left:3px;top:3px;width:24px;height:24px;border-radius:50%;background:#fff;transition:transform .15s}
.dfm .tg[aria-checked=true]{background:#ffb43a}.dfm .tg[aria-checked=true]:after{transform:translateX(22px)}
.dfm .rseg{width:210px}
@media (max-height:640px){.dfm .pnl{padding:14px 18px;gap:11px}.dfm .big{font-size:24px;padding:12px 0}.dfm h1{font-size:44px}}
`;

/** @param {HTMLElement} root @param {{onPlay?:Function,onResume?:Function,onQuit?:Function,onSettings?:Function,onChange?:Function}} [opts] */
export function createMenu(root, opts = {}) {
  // ---- saved state (defaults when storage is missing / broken)
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { /* no storage: defaults */ }
  const settings = { ...DEFAULTS.settings, ...(saved.settings || {}) };
  const profile = { ...DEFAULTS.profile, ...(saved.profile || {}) };
  if (!profile.name) profile.name = `${NAMES[Math.floor(Math.random() * NAMES.length)]} ${100 + Math.floor(Math.random() * 900)}`;
  if (!COLORS.some((c) => c[0] === profile.color)) profile.color = COLORS[0][0];
  if (!SKILLS.some((c) => c[0] === profile.skill)) profile.skill = 'medium';
  const persist = () => { try { localStorage.setItem(KEY, JSON.stringify({ settings, profile })); } catch { /* ignore */ } };
  persist();

  if (!document.getElementById('dfm-css')) { const st = document.createElement('style'); st.id = 'dfm-css'; st.textContent = CSS; document.head.appendChild(st); }
  const radios = (name, list, cur, cls) => `<div class="${cls}">${list.map(([v, t]) => `<label${cls === 'sw' ? ` title="${t}"` : ''}><input type="radio" name="${name}" value="${v}" aria-label="${t}"${String(v) === String(cur) ? ' checked' : ''}>${cls === 'sw' ? `<i style="background:${v}"></i>` : `<span>${t}</span>`}</label>`).join('')}</div>`;

  root.classList.add('dfm'); root.hidden = true;
  root.innerHTML = `
  <section class="scr" data-s="start">
    <h1>DOGFIGHT</h1>
    <div class="pnl">
      <div><div class="lbl">Your name</div><input type="text" id="dfm-name" maxlength="16" autocomplete="off" spellcheck="false" value=""></div>
      <div><div class="lbl">Jet colour</div>${radios('color', COLORS, profile.color, 'sw')}</div>
      <div><div class="lbl">AI skill</div>${radios('skill', SKILLS, profile.skill, 'seg')}</div>
      <button class="big" data-a="play">PLAY</button>
      <div class="keys">Mouse aim · W/S throttle · Shift afterburner · V view · Esc pause</div>
    </div>
    <button class="lnk" data-a="settings">Settings</button>
  </section>
  <section class="scr" data-s="pause">
    <h2>PAUSED</h2>
    <div class="pnl"><button class="big" data-a="resume">RESUME</button><button class="sec" data-a="settings">Settings</button><button class="sec" data-a="quit">Quit to menu</button></div>
  </section>
  <section class="scr" data-s="settings">
    <h2>SETTINGS</h2>
    <div class="pnl">
      <div class="row"><span>Mouse sensitivity</span><input type="range" min="0.25" max="3" step="0.05" data-k="sensitivity" aria-label="Mouse sensitivity"><b class="val" data-v="sensitivity"></b></div>
      <div class="row"><span>Invert mouse up/down</span><button class="tg" role="switch" data-k="invertY" aria-label="Invert mouse up/down"></button></div>
      <div class="row"><span>Volume</span><input type="range" min="0" max="1" step="0.05" data-k="volume" aria-label="Volume"><b class="val" data-v="volume"></b></div>
      <div class="row"><span>Graphics</span>${radios('quality', QUALITY, settings.quality, 'seg rseg')}</div>
      <div class="row"><span>Show FPS</span><button class="tg" role="switch" data-k="showFps" aria-label="Show FPS"></button></div>
      <button class="big" data-a="back" style="font-size:22px;padding:12px 0">BACK</button>
    </div>
  </section>`;
  const $ = (sel) => root.querySelector(sel);
  const screens = {}; root.querySelectorAll('.scr').forEach((e) => { screens[e.dataset.s] = e; });
  const nameEl = $('#dfm-name'); nameEl.value = profile.name;

  const menu = { settings, profile, screen: 'none', onChange: opts.onChange || null, show, el: root };
  let from = 'start';   // where Settings was opened from (Back returns there)

  const fire = () => { persist(); if (menu.onChange) menu.onChange(settings); };
  const sync = () => {   // push the settings object into the controls
    for (const r of root.querySelectorAll('input[type=range]')) { r.value = settings[r.dataset.k]; $(`[data-v=${r.dataset.k}]`).textContent = r.dataset.k === 'volume' ? `${Math.round(settings.volume * 100)}%` : `${settings.sensitivity.toFixed(2)}x`; }
    for (const b of root.querySelectorAll('.tg')) b.setAttribute('aria-checked', String(!!settings[b.dataset.k]));
  };
  sync();

  function show(which) {
    const target = which === 'settings' ? 'settings' : which;
    for (const k in screens) screens[k].classList.toggle('on', k === target);
    root.hidden = which === 'none';
    if (which === 'start' || which === 'pause') { menu.screen = which; from = which; }
    else if (which === 'none') menu.screen = 'none';
    if (which !== 'none') { const b = screens[target].querySelector(target === 'settings' ? '[data-a=back]' : '.big'); if (b) b.focus({ preventScroll: true }); }
  }

  const act = {
    play() { profile.name = nameEl.value.trim().slice(0, 16) || profile.name; nameEl.value = profile.name; persist(); if (opts.onPlay) opts.onPlay(profile, settings); },
    resume() { if (opts.onResume) opts.onResume(); },
    quit() { show('start'); if (opts.onQuit) opts.onQuit(); },
    settings() { show('settings'); if (opts.onSettings) opts.onSettings(); },
    back() { show(from); },
  };
  root.addEventListener('click', (e) => { const b = e.target.closest('[data-a]'); if (b) act[b.dataset.a](); const t = e.target.closest('.tg'); if (t) { settings[t.dataset.k] = !settings[t.dataset.k]; sync(); fire(); } });
  root.addEventListener('input', (e) => {
    const t = e.target;
    if (t.type === 'range') { settings[t.dataset.k] = +t.value; sync(); fire(); }
    else if (t === nameEl) { profile.name = nameEl.value.slice(0, 16); persist(); }
  });
  root.addEventListener('change', (e) => {
    const t = e.target;
    if (t.name === 'color' || t.name === 'skill') { profile[t.name] = t.value; persist(); }
    else if (t.name === 'quality') { settings.quality = +t.value; fire(); }
  });
  addEventListener('keydown', (e) => {
    if (root.hidden || e.repeat) return;
    const scr = root.querySelector('.scr.on').dataset.s, tag = e.target.tagName;
    if (e.code === 'Escape') { if (scr === 'settings') act.back(); else if (scr === 'pause') act.resume(); }
    else if ((e.code === 'Enter' || e.code === 'NumpadEnter') && tag !== 'BUTTON') { if (scr === 'start') act.play(); else if (scr === 'pause') act.resume(); else if (scr === 'settings') act.back(); }
  });
  return menu;
}
