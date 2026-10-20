// menu.js -- the start screen, pause screen and settings panel (lane UI, phase 2). Plain DOM, own CSS, no dependencies.
// Style: one big PLAY button, white on translucent dark panels with backdrop blur, one accent (#ffb43a), the live 3D scene
// visible behind. Everything is remembered in localStorage (try/catch: it works without it).
//
//   const menu = createMenu(rootDiv, { onPlay, onResume, onQuit, onSettings, onChange });
//   menu.show('start' | 'pause' | 'none')
//   menu.settings  { sensitivity (multiplier, 1 = default), invertY, volume (0..1), quality (0 low, 1 medium, 2 high), showFps }
//   menu.profile   { name, color ('#rrggbb'), skill ('easy'|'medium'|'hard'), mode ('duel'|'survival'|'race'|'tutorial') }
//                  mode is picked on the start screen; it defaults to 'tutorial' until localStorage['dogfight.tutorialDone'] is set
//                  (then 'duel'), and is remembered once the player has chosen one. Skill only shows for duel / survival.
//                  Saved bests shown on the cards: any localStorage key starting 'dogfight.raceBest' (seconds, or ms when >= 5000;
//                  the lowest wins) and 'dogfight.survivalBest' (kills). They refresh every time the start screen is shown.
//   menu.onChange = (settings) => {}      // also fires for the options.onChange passed at creation; every settings edit
//   menu.screen    // 'start' | 'pause' | 'none' (what is showing; the settings panel counts as its parent screen)
// Enter plays (start) / resumes (pause); Esc resumes (pause) or goes back (settings). Real inputs underneath: Tab, arrows, Space work.

const KEY = 'dogfight.menu.v1';
const COLORS = [['#c8362c', 'Red'], ['#2b62cf', 'Blue'], ['#e0a020', 'Amber'], ['#3a9d5a', 'Green'], ['#8a4fd0', 'Violet'], ['#e7e7ea', 'White'], ['#2a2d33', 'Black'], ['#e0663a', 'Orange']];
const SKILLS = [['easy', 'Easy'], ['medium', 'Medium'], ['hard', 'Hard']];
const QUALITY = [['0', 'Low'], ['1', 'Medium'], ['2', 'High']];
const MODES = [['duel', 'Duel', 'vs AI · best of 3'], ['survival', 'Survival', 'endless waves'], ['race', 'Ring race', 'fly the rings'], ['tutorial', 'First flight', 'learn the controls']];
const NAMES = ['Falcon', 'Viper', 'Raven', 'Condor', 'Maverick', 'Comet', 'Ghost', 'Hawk', 'Eagle', 'Storm', 'Phantom', 'Blaze'];
const DEFAULTS = { settings: { sensitivity: 1, invertY: false, volume: 0.8, quality: 2, showFps: false }, profile: { name: '', color: COLORS[0][0], skill: 'medium' } };

const CSS = `
.dfm{position:fixed;inset:0;z-index:20;display:flex;align-items:center;justify-content:center;font-family:Rubik,system-ui,sans-serif;color:#fff;
  background:radial-gradient(ellipse at 50% 45%,rgba(8,10,16,.18),rgba(8,10,16,.62));-webkit-font-smoothing:antialiased;overflow:auto}
.dfm[hidden]{display:none}
.dfm *{box-sizing:border-box}
.dfm .scr{display:none;flex-direction:column;align-items:center;gap:16px;width:min(440px,92vw);margin:auto;padding:16px 0}
.dfm .scr[data-s=start]{width:min(560px,92vw)}
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
.dfm .modes{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}
.dfm .modes label{position:relative;cursor:pointer;display:flex}
.dfm .modes input{position:absolute;inset:0;opacity:0;margin:0;cursor:pointer}
.dfm .modes span{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;text-align:center;padding:9px 4px;border-radius:12px;
  background:rgba(255,255,255,.1);transition:background .12s,color .12s}
.dfm .modes b{font-weight:800;font-size:16px;line-height:1.15}
.dfm .modes small{font-weight:500;font-size:11px;opacity:.75;line-height:1.2}
.dfm .modes em{font-style:normal;font-weight:700;font-size:11px;color:#ffb43a;line-height:1.2}
.dfm .modes label:hover span{background:rgba(255,255,255,.18)}
.dfm .modes input:checked+span{background:#ffb43a;color:#1a1205}
.dfm .modes input:checked+span small{opacity:.8}.dfm .modes input:checked+span em{color:#1a1205}
.dfm .modes input:focus-visible+span{outline:3px solid #fff;outline-offset:1px}
.dfm .modes i{position:absolute;right:-3px;top:-9px;font-style:normal;font-weight:800;font-size:10px;letter-spacing:.04em;white-space:nowrap;color:#1a1205;background:#fff;
  border-radius:8px;padding:2px 7px;box-shadow:0 2px 8px rgba(0,0,0,.4);pointer-events:none;z-index:1}
.dfm [hidden]{display:none!important}
@media (max-height:800px){.dfm .scr{gap:10px;padding:10px 0}.dfm h1{font-size:54px}.dfm .pnl{padding:16px 22px;gap:11px}.dfm .lbl{margin-bottom:5px}.dfm .big{font-size:26px;padding:12px 0}
  .dfm input[type=text]{padding:8px 12px}.dfm .sw label{width:34px;height:34px}.dfm .seg span{padding:7px 0}.dfm .modes span{padding:7px 4px}}
@media (max-height:640px){.dfm .pnl{padding:14px 18px;gap:11px}.dfm .big{font-size:24px;padding:12px 0}.dfm h1{font-size:44px}}
@media (max-height:540px){.dfm .scr{gap:6px;padding:8px 0}.dfm h1{font-size:34px}.dfm .pnl{padding:10px 16px;gap:7px;border-radius:16px}.dfm .lbl{font-size:10px;margin-bottom:3px}
  .dfm input[type=text]{font-size:15px;padding:5px 10px}.dfm .sw label{width:26px;height:26px}.dfm .sw i{border-width:2px}.dfm .seg span{padding:5px 0;font-size:13px}
  .dfm .modes b{font-size:14px}.dfm .modes small{font-size:10px}.dfm .modes span{padding:5px 3px;gap:1px}.dfm .big{font-size:20px;padding:8px 0;box-shadow:0 4px 0 #b9761a,0 8px 18px rgba(0,0,0,.35)}
  .dfm .keys{display:none}.dfm .lnk{padding:2px 10px;font-size:13px}}
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
  const ls = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const tutDone = () => !!ls('dogfight.tutorialDone');
  let chosen = MODES.some((m) => m[0] === profile.mode);   // has the player ever picked a mode? (else it follows tutorialDone)
  if (!chosen) profile.mode = tutDone() ? 'duel' : 'tutorial';
  const persist = () => { try { localStorage.setItem(KEY, JSON.stringify({ settings, profile: { ...profile, mode: chosen ? profile.mode : undefined } })); } catch { /* ignore */ } };
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
      <div><div class="lbl">Mode</div><div class="modes">${MODES.map(([v, t, d]) => `<label><input type="radio" name="mode" value="${v}" aria-label="${t}"><span><b>${t}</b><small>${d}</small><em data-best="${v}" hidden></em></span>${v === 'tutorial' ? '<i data-new hidden>New? Start here</i>' : ''}</label>`).join('')}</div></div>
      <div data-skill><div class="lbl">AI skill</div>${radios('skill', SKILLS, profile.skill, 'seg')}</div>
      <button class="big" data-a="play">PLAY</button>
      <div class="keys">Mouse aim · Click gun · Right-click / Space missile · F flares · W/S throttle · Shift afterburner · V view</div>
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
  const skillEl = $('[data-skill]'), newTag = $('[data-new]');
  const fmtTime = (sec) => `${Math.floor(sec / 60)}:${(sec % 60).toFixed(1).padStart(4, '0')}`;
  /** lowest saved race time in seconds, or 0 */
  function raceBest() {
    let best = 0;
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i); if (!k || !k.startsWith('dogfight.raceBest')) continue;
        let v = JSON.parse(localStorage.getItem(k)); if (v && typeof v === 'object') v = v.time ?? v.best ?? v.t;
        v = Number(v); if (v >= 5000) v /= 1000;   // ms -> s
        if (v > 0 && (!best || v < best)) best = v;
      }
    } catch { /* no storage */ }
    return best;
  }
  /** pushes mode-dependent bits: the radio, the skill row, the "New?" tag and the saved bests */
  function syncMode() {
    const r = root.querySelector(`input[name=mode][value=${profile.mode}]`); if (r) r.checked = true;
    skillEl.hidden = profile.mode !== 'duel' && profile.mode !== 'survival';
    newTag.hidden = tutDone();
    const rb = raceBest(), sb = Math.floor(Number(ls('dogfight.survivalBest')) || 0);
    const set = (k, t) => { const e = $(`[data-best=${k}]`); e.hidden = !t; if (e.textContent !== t) e.textContent = t; };
    set('race', rb ? `Best ${fmtTime(rb)}` : ''); set('survival', sb ? `Best ${sb} kill${sb === 1 ? '' : 's'}` : '');
  }

  const menu = { settings, profile, screen: 'none', onChange: opts.onChange || null, show, el: root };
  let from = 'start';   // where Settings was opened from (Back returns there)

  const fire = () => { persist(); if (menu.onChange) menu.onChange(settings); };
  const sync = () => {   // push the settings object into the controls
    for (const r of root.querySelectorAll('input[type=range]')) { r.value = settings[r.dataset.k]; $(`[data-v=${r.dataset.k}]`).textContent = r.dataset.k === 'volume' ? `${Math.round(settings.volume * 100)}%` : `${settings.sensitivity.toFixed(2)}x`; }
    for (const b of root.querySelectorAll('.tg')) b.setAttribute('aria-checked', String(!!settings[b.dataset.k]));
  };
  sync(); syncMode();

  function show(which) {
    const target = which === 'settings' ? 'settings' : which;
    for (const k in screens) screens[k].classList.toggle('on', k === target);
    root.hidden = which === 'none';
    if (which === 'start') { if (!chosen) profile.mode = tutDone() ? 'duel' : 'tutorial'; syncMode(); }
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
    else if (t.name === 'mode') { profile.mode = t.value; chosen = true; persist(); syncMode(); }
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
