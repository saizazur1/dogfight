/**
 * lobby.js — "PLAY WITH FRIENDS": every screen a player sees to create or join a room (README "Online contract", lane LOBBY).
 * Plain DOM, own CSS in the menu's style (Rubik, dark translucent blur panels, accent #ffb43a, big rounded buttons), z 30 over the menu
 * like the locker. Talks to the network only through the README `net` API and starts the match with `game.playOnline(net, cfg)`.
 *
 *   const lobby = createLobby(document.body, { net, game, menu });
 *     net   a net object, or a factory (sync or async) returning one: called again for every new room after a leave
 *     game  needs playOnline(net, cfg); quit() is called when the host leaves during a match
 *     menu  menu.js instance: profile {name, color} is read and edited here (menu.save() persists), menu.el is made inert while
 *           the lobby is open, menu.setRoom(code|null) turns the start screen's friends button into "BACK TO ROOM"
 *   lobby.open()          the room if still connected (rematch), else the CREATE / JOIN choice
 *   lobby.openJoin(code)  the join screen with that code filled in (an invite link ?room=CODE)
 *   lobby.close()
 *
 * Views: choice → busy ("Creating room…" / "Joining room…") → room (host: code, invite link, match length, AI fill, START;
 * client: "Waiting for the host to start…"). Errors come back to choice / join as one plain sentence.
 * Keys (capture phase: nothing reaches the menu or the game while open): Esc backs out, Enter = the view's main action.
 */
import { COLORS } from './menu.js';

const SEATS = 8;
const LOOKALIKE = /[01OIL]/;   // README: room codes never use 0/O/1/I/L
const ERRORS = {
  'not-found': (c) => `Room ${c} not found. Check the code, or ask your friend for a new link.`,
  full: () => 'That room is full (8 players).',
  started: () => 'That match is already running. Wait for it to finish, then join again.',
  failed: () => "Couldn't connect. Some school or office networks block game connections — both try home Wi-Fi (phone hotspots often can't connect yet).",
  'host-left': () => 'The host left the match.',
};
const CROWN = '<svg class="cr" viewBox="0 0 24 24" aria-label="host"><path d="M2.5 7.5l5 4.2L12 4.5l4.5 7.2 5-4.2L19.4 19H4.6z" fill="currentColor"/></svg>';

const CSS = `
.dfo{position:fixed;inset:0;z-index:30;display:flex;font-family:Rubik,system-ui,sans-serif;color:#fff;
  background:radial-gradient(ellipse at 50% 45%,rgba(8,10,16,.72),rgba(8,10,16,.9));-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);
  -webkit-font-smoothing:antialiased;overflow:auto}
.dfo[hidden]{display:none}
.dfo *{box-sizing:border-box}
.dfo .box{width:min(460px,calc(100vw - 32px));margin:auto;padding:16px 0;display:flex;flex-direction:column;align-items:center;gap:14px}
.dfo .box.wide{width:min(860px,calc(100vw - 32px))}
.dfo h2{margin:0;font-weight:800;font-size:34px;letter-spacing:.08em;text-align:center;line-height:1.1}
.dfo .sub{font-weight:700;font-size:14px;letter-spacing:.1em;text-transform:uppercase;opacity:.75;margin-top:-6px;text-align:center}
.dfo .pnl{width:100%;min-width:0;background:rgba(12,14,20,.62);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);border-radius:20px;padding:20px 22px;
  display:flex;flex-direction:column;gap:14px;box-shadow:0 10px 40px rgba(0,0,0,.35)}
.dfo .lbl{font-weight:700;font-size:12px;letter-spacing:.12em;text-transform:uppercase;opacity:.7;margin-bottom:7px;display:flex;justify-content:space-between}
.dfo input[type=text]{width:100%;font:700 18px Rubik,system-ui,sans-serif;color:#fff;background:rgba(255,255,255,.1);border:2px solid transparent;border-radius:12px;padding:11px 14px;outline:none}
.dfo input[type=text]:focus{border-color:#ffb43a}
.dfo .sw{display:flex;gap:8px;justify-content:space-between}
.dfo .sw label{position:relative;width:36px;height:36px;cursor:pointer;flex:none}
.dfo .sw input{position:absolute;inset:0;opacity:0;margin:0;cursor:pointer}
.dfo .sw i{position:absolute;inset:0;border-radius:50%;border:3px solid rgba(255,255,255,.25);transition:transform .12s,border-color .12s}
.dfo .sw label:hover i{transform:scale(1.1)}
.dfo .sw input:checked+i{border-color:#fff;transform:scale(1.12);box-shadow:0 0 0 3px rgba(255,180,58,.9)}
.dfo .sw input:focus-visible+i{outline:3px solid #ffb43a;outline-offset:3px}
.dfo .seg{display:flex;background:rgba(255,255,255,.1);border-radius:12px;padding:3px;gap:3px;width:180px}
.dfo .seg label{position:relative;flex:1;text-align:center;cursor:pointer}
.dfo .seg input{position:absolute;inset:0;opacity:0;margin:0;cursor:pointer}
.dfo .seg span{display:block;padding:8px 0;border-radius:9px;font-weight:700;font-size:15px;transition:background .12s,color .12s}
.dfo .seg input:checked+span{background:#ffb43a;color:#1a1205}
.dfo .seg input:focus-visible+span{outline:3px solid #fff;outline-offset:1px}
.dfo button{font-family:inherit;cursor:pointer;border:0;color:#fff}
.dfo .big{width:100%;font-weight:800;font-size:26px;letter-spacing:.1em;color:#1a1205;background:#ffb43a;border-radius:16px;padding:14px 0;
  box-shadow:0 6px 0 #b9761a,0 12px 28px rgba(0,0,0,.35);transition:transform .08s,box-shadow .08s,filter .12s}
.dfo .big:hover{filter:brightness(1.08)}
.dfo .big:active{transform:translateY(4px);box-shadow:0 2px 0 #b9761a,0 6px 16px rgba(0,0,0,.35)}
.dfo .big:disabled{filter:grayscale(1) brightness(.7);cursor:not-allowed;transform:none}
.dfo .sec{flex:1;font-weight:800;font-size:15px;letter-spacing:.1em;background:rgba(255,255,255,.12);border-radius:12px;padding:12px 14px;white-space:nowrap;transition:background .12s}
.dfo .sec:hover{background:rgba(255,255,255,.2)}
.dfo .acc{box-shadow:inset 0 0 0 2px #ffb43a}.dfo .acc:hover{background:rgba(255,180,58,.22)}
.dfo .lnk{background:none;opacity:.75;font-weight:500;font-size:14px;text-decoration:underline;padding:6px 10px;border-radius:8px}
.dfo .lnk:hover{opacity:1}
.dfo .lv{font-weight:800;font-size:14px;letter-spacing:.12em;background:rgba(255,255,255,.1);border-radius:12px;padding:10px 22px}
.dfo .lv:hover{background:rgba(255,77,61,.3)}
.dfo .lv.sure{background:#ff4d3d}
.dfo .big:focus-visible,.dfo .sec:focus-visible,.dfo .lnk:focus-visible,.dfo .lv:focus-visible,.dfo .tg:focus-visible{outline:3px solid #fff;outline-offset:3px}
.dfo .tg{flex:none;width:52px;height:30px;border-radius:15px;background:rgba(255,255,255,.25);position:relative;transition:background .15s;padding:0}
.dfo .tg:after{content:"";position:absolute;left:3px;top:3px;width:24px;height:24px;border-radius:50%;background:#fff;transition:transform .15s}
.dfo .tg[aria-checked=true]{background:#ffb43a}.dfo .tg[aria-checked=true]:after{transform:translateX(22px)}
.dfo .row{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:38px}
.dfo .row>span{font-weight:500;font-size:16px}
.dfo .or{display:flex;align-items:center;gap:12px;font-weight:700;font-size:12px;letter-spacing:.12em;text-transform:uppercase;opacity:.6}
.dfo .or:before,.dfo .or:after{content:"";flex:1;height:1px;background:rgba(255,255,255,.35)}
.dfo .jn{display:flex;gap:10px}
.dfo .jn input[type=text]{flex:1;min-width:0;text-align:center;letter-spacing:.3em;font-size:22px;font-weight:800;text-transform:uppercase}
.dfo .jn input::placeholder{color:rgba(255,255,255,.3);letter-spacing:.2em}
.dfo .jn.solo input[type=text]{font-size:40px;padding:8px 10px;color:#ffb43a}
.dfo .hint{font-size:13px;line-height:1.35;opacity:.75;text-align:center;text-wrap:balance}
.dfo .hint:empty{display:none}
.dfo .hint.warn{opacity:1;color:#ffcf7a}
.dfo .err{width:100%;font-weight:600;font-size:15px;line-height:1.4;text-align:center;text-wrap:balance;background:rgba(255,77,61,.2);box-shadow:inset 0 0 0 2px rgba(255,77,61,.7);
  border-radius:14px;padding:12px 16px}
.dfo .busy{display:flex;flex-direction:column;align-items:center;gap:18px;padding:34px 22px}
.dfo .busy b{font-weight:700;font-size:20px;text-align:center}
.dfo .spin{display:inline-block;flex:none;width:44px;height:44px;border-radius:50%;border:5px solid rgba(255,255,255,.18);border-top-color:#ffb43a;animation:dfoSpin .8s linear infinite}
.dfo .cols{width:100%;display:grid;grid-template-columns:1fr 1fr;gap:16px;align-items:start}
.dfo .code{font-weight:800;font-size:clamp(40px,min(10vh,14vw),84px);line-height:1;letter-spacing:.16em;color:#ffb43a;text-align:center;text-shadow:0 3px 24px rgba(255,180,58,.3);
  margin:-4px 0 0 .16em;user-select:all}
.dfo .two{display:flex;gap:10px}
.dfo .link{font-size:13px!important;font-weight:500!important;padding:7px 10px!important;opacity:.8;text-overflow:ellipsis}
.dfo .wait{display:flex;align-items:center;justify-content:center;gap:12px;font-weight:700;font-size:17px;padding:14px 0 6px;text-align:center}
.dfo .wait .spin{width:24px;height:24px;border-width:3px}
.dfo .pl{display:flex;flex-direction:column;gap:6px}
.dfo .p{display:flex;align-items:center;gap:10px;min-height:38px;padding:0 12px;border-radius:11px;background:rgba(255,255,255,.08)}
.dfo .p.me{background:rgba(255,180,58,.16);box-shadow:inset 0 0 0 2px rgba(255,180,58,.6)}
.dfo .p>b{flex:none;width:14px;font-weight:700;font-size:12px;opacity:.5;text-align:center;font-variant-numeric:tabular-nums}
.dfo .p>i{flex:none;width:16px;height:16px;border-radius:50%;box-shadow:0 0 0 2px rgba(255,255,255,.35)}
.dfo .p>span{flex:1;min-width:0;display:flex;align-items:center;gap:6px;font-weight:700;font-size:16px;white-space:nowrap;overflow:hidden}
.dfo .p>span em{font-style:normal;font-weight:500;opacity:.65;font-size:14px}
.dfo .p .nm{overflow:hidden;text-overflow:ellipsis}
.dfo .p small{flex:none;font-weight:700;font-size:12px;font-variant-numeric:tabular-nums}
.dfo .p small.g{color:#5bd68f}.dfo .p small.o{color:#ffcf7a}.dfo .p small.b{color:#ff7a6a}
.dfo .p.empty{background:none;box-shadow:inset 0 0 0 2px rgba(255,255,255,.08)}
.dfo .p.empty>i{background:none;box-shadow:inset 0 0 0 2px rgba(255,255,255,.2)}
.dfo .p.empty>span{font-weight:500;opacity:.4}
.dfo .cr{flex:none;width:18px;height:18px;color:#ffb43a}
@keyframes dfoSpin{to{transform:rotate(360deg)}}
@media (max-width:760px){.dfo .cols{grid-template-columns:1fr}}
@media (max-width:420px){.dfo h2{font-size:28px}.dfo .pnl{padding:16px}.dfo .sw label{width:30px;height:30px}.dfo .sec{font-size:13px;padding:11px 8px;letter-spacing:.06em}
  .dfo .big{font-size:22px}.dfo .jn input[type=text]{font-size:18px;letter-spacing:.2em}.dfo .jn.solo input[type=text]{font-size:32px}.dfo .row>span{font-size:15px}.dfo .seg{width:150px}}
@media (max-height:800px){.dfo .box{gap:10px}.dfo .pnl{padding:16px 20px;gap:11px}.dfo .lbl{margin-bottom:5px}.dfo .big{font-size:24px;padding:11px 0}
  .dfo input[type=text]{padding:8px 12px}.dfo .sec{padding:10px 12px}.dfo .p{min-height:34px}.dfo .pl{gap:5px}.dfo .busy{padding:26px 20px}}
@media (max-height:640px){.dfo h2{font-size:26px}.dfo .sub{font-size:12px}.dfo .pnl{padding:12px 16px;gap:8px}.dfo .big{font-size:20px;padding:8px 0;box-shadow:0 4px 0 #b9761a,0 8px 18px rgba(0,0,0,.35)}
  .dfo .p{min-height:28px}.dfo .pl{gap:4px}.dfo .row{min-height:32px}.dfo .seg span{padding:5px 0}.dfo .sw label{width:30px;height:30px}.dfo .link{display:none}
  .dfo .code{font-size:52px}.dfo .err{padding:8px 12px;font-size:14px}}
@media (max-height:540px){.dfo .box{gap:6px;padding:8px 0}.dfo .sub,.dfo .hint{display:none}.dfo .p{min-height:24px}.dfo .p>span{font-size:14px}.dfo .code{font-size:42px}
  .dfo .sec{padding:7px 10px}.dfo .lv{padding:6px 18px}}
@media (prefers-reduced-motion:reduce){.dfo .spin{animation-duration:2.4s}}
`;

const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const safeColor = (c) => (/^#[0-9a-f]{6}$/i.test(c || '') ? c : '#888');

/**
 * Forgiving room-code input: a pasted invite link gives its ?room=, then upper case, letters and digits only, at most 5.
 * Look-alikes (0 O 1 I L) are kept so the hint can point at them (they are never in a real code).
 * @param {string} raw @returns {string}
 */
export function normCode(raw) {
  let s = String(raw || '').trim();
  const m = s.match(/[?&]room=([^&#\s]+)/i);
  if (m) s = m[1];
  return s.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 5);
}

/** One plain sentence for a net error ({ code } from net.join / net.host, or an onClose reason). */
function errText(e, code) {
  const k = e?.code || e;
  if (k === 'started' && e?.message) return e.message;
  return (ERRORS[k] || ERRORS.failed)(code);
}

/**
 * @param {HTMLElement} root
 * @param {{net:object|(()=>object|Promise<object>), game?:object, menu?:object}} opts
 */
export function createLobby(root, { net: netSrc, game, menu } = {}) {
  if (!document.getElementById('dfo-css')) { const st = document.createElement('style'); st.id = 'dfo-css'; st.textContent = CSS; document.head.appendChild(st); }
  const el = document.createElement('div'); el.className = 'dfo'; el.hidden = true;
  el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Play with friends');
  el.innerHTML = '<div class="box"></div>';
  root.appendChild(el);
  const box = el.firstChild;
  const profile = menu?.profile || { name: 'Pilot', color: COLORS[0][0] };
  const cfg = { minutes: 5, bots: true };   // host settings, kept for the rematch
  let view = 'choice', from = 'choice', msg = '', busyText = '', code = '', net = null, op = 0, inMatch = false, sure = false, flashT = 0;
  const $ = (sel) => box.querySelector(sel);
  const save = () => { try { menu?.save?.(); } catch (e) { console.warn('lobby: menu.save', e); } };
  const setRoom = (c) => { try { menu?.setRoom?.(c); } catch (e) { console.warn('lobby: menu.setRoom', e); } };
  const link = () => `${location.origin}${location.pathname}?room=${net?.code || ''}`;
  const humans = () => (net?.players || []).length;

  // ---------------------------------------------------------------- views
  const errBox = () => (msg ? `<div class="err" role="alert">${esc(msg)}</div>` : '');
  const who = () => `<div><div class="lbl">Your name</div><input type="text" data-k="name" maxlength="16" autocomplete="off" spellcheck="false" aria-label="Your name" value="${esc(profile.name)}"></div>
    <div><div class="lbl">Jet colour</div><div class="sw">${COLORS.map(([v, t]) => `<label title="${t}"><input type="radio" name="dfo-color" value="${v}" aria-label="${t}"${v === profile.color ? ' checked' : ''}><i style="background:${v}"></i></label>`).join('')}</div></div>`;
  const codeInput = (solo) => `<input type="text" data-k="code" placeholder="CODE" autocomplete="off" autocapitalize="characters" spellcheck="false" aria-label="Room code" value="${esc(code)}">`
    + (solo ? '' : '<button class="sec acc" data-a="join">JOIN ROOM</button>');
  const VIEWS = {
    choice: () => `<h2>PLAY WITH FRIENDS</h2><div class="sub">Free · up to 8 jets · no account</div>${errBox()}
      <div class="pnl">${who()}
        <button class="big" data-a="create">CREATE ROOM</button>
        <div class="hint">You get a link to send to your friends.</div>
        <div class="or">or join a friend's room</div>
        <div class="jn">${codeInput(false)}</div><div class="hint" data-hint></div>
      </div><button class="lnk" data-a="close">Back</button>`,
    join: () => `<h2>JOIN ROOM</h2><div class="sub">You're invited to a dogfight</div>${errBox()}
      <div class="pnl"><div><div class="lbl">Room code</div><div class="jn solo">${codeInput(true)}</div></div><div class="hint" data-hint></div>
        ${who()}<button class="big" data-a="join">JOIN</button></div><button class="lnk" data-a="choice">Back</button>`,
    busy: () => `<div class="pnl busy"><i class="spin"></i><b>${esc(busyText)}</b><button class="lnk" data-a="cancel">Cancel</button></div>`,
    room: () => {
      const host = !!net?.isHost;
      const settings = host ? `<div class="row"><span>Match length</span><div class="seg">${[3, 5].map((m) => `<label><input type="radio" name="dfo-min" value="${m}" aria-label="${m} minutes"${cfg.minutes === m ? ' checked' : ''}><span>${m} min</span></label>`).join('')}</div></div>
        <div class="row"><span>Fill empty seats with AI</span><button class="tg" role="switch" data-a="bots" aria-checked="${cfg.bots}" aria-label="Fill empty seats with AI"></button></div>
        <button class="big" data-a="start">START</button>`
        : '<div class="wait"><i class="spin"></i>Waiting for the host to start…</div>';
      return `<h2>${host ? 'YOUR ROOM' : 'ROOM'}</h2>${errBox()}<div class="cols">
        <div class="pnl"><div><div class="lbl">Room code</div><div class="code">${esc(net?.code)}</div></div>
          <div class="two"><button class="sec acc" data-a="copy">COPY INVITE LINK</button>${navigator.share ? '<button class="sec" data-a="share">SHARE</button>' : ''}</div>
          <input type="text" class="link" readonly value="${esc(link())}" aria-label="Invite link">
          <div class="hint" data-hint>Send the link (or the code) to your friends. They open it and press JOIN.</div>
          ${settings}</div>
        <div class="pnl"><div class="lbl" style="margin:0"><span>Players</span><span data-count></span></div><div class="pl" data-pl></div></div>
      </div><button class="lv" data-a="leave">LEAVE ROOM</button>`;
    },
  };

  /** Seats 1..8: a player (colour, name, crown, "(you)", ping) or "Waiting…"; the START label counts the humans. */
  function renderPlayers() {
    const pl = $('[data-pl]');
    if (!pl || !net) return;
    const bySeat = [];
    for (const p of net.players || []) if (p.seat >= 0 && p.seat < SEATS) bySeat[p.seat] = p;
    let html = '';
    for (let i = 0; i < SEATS; i++) {
      const p = bySeat[i];
      if (!p) { html += `<div class="p empty"><b>${i + 1}</b><i></i><span>Waiting…</span></div>`; continue; }
      const ping = !p.isHost && Number.isFinite(p.ping) ? Math.round(p.ping) : null;
      html += `<div class="p${p.isMe ? ' me' : ''}"><b>${i + 1}</b><i style="background:${safeColor(p.color)}"></i>`
        + `<span><span class="nm">${esc(p.name)}</span>${p.isHost ? CROWN : ''}${p.isMe ? '<em>(you)</em>' : ''}</span>`
        + `${ping === null ? '' : `<small class="${ping < 90 ? 'g' : ping < 180 ? 'o' : 'b'}">${ping} ms</small>`}</div>`;
    }
    pl.innerHTML = html;
    const n = humans();
    $('[data-count]').textContent = `${n} / ${SEATS}`;
    const st = $('[data-a=start]');
    if (st) { st.textContent = `START (${n} player${n === 1 ? '' : 's'})`; st.disabled = n < 1; }
  }

  /** Renders a view, opens the overlay, focuses the view's main control. */
  function show(v) {
    if (v === 'choice' || v === 'join') from = v;
    view = v; sure = false; clearTimeout(flashT);
    box.className = `box${v === 'room' ? ' wide' : ''}`;
    box.innerHTML = VIEWS[v]();
    el.hidden = false;
    if (menu?.el) menu.el.inert = true;
    if (v === 'room') renderPlayers();
    if (v === 'choice' || v === 'join') codeHint(false);
    const codeOk = code.length === 5;
    const focus = v === 'choice' ? (code ? '[data-k=code]' : '[data-a=create]') : v === 'join' ? (codeOk ? '[data-a=join]' : '[data-k=code]')
      : v === 'busy' ? '[data-a=cancel]' : net?.isHost ? '[data-a=start]' : '[data-a=copy]';
    $(focus)?.focus({ preventScroll: true });
  }
  function hide() {
    el.hidden = true;
    if (menu?.el) menu.el.inert = false;
  }

  /** The hint under the code box: look-alike letters, or (on a JOIN press) a short code. */
  function codeHint(pressed) {
    const h = $('[data-hint]');
    if (!h) return true;
    let t = '';
    if (LOOKALIKE.test(code)) t = 'Room codes never use 0, O, 1, I or L. Check those letters again.';
    else if (pressed && code.length !== 5) t = code ? 'A room code has 5 letters or numbers.' : 'Type the 5-letter room code first.';
    h.textContent = t; h.classList.toggle('warn', !!t);
    return !t;
  }

  // ---------------------------------------------------------------- net
  /** Creates the net on first use (the factory may be async: net.js is loaded lazily) and takes over its callbacks. */
  async function ensureNet() {
    if (!net) net = await (typeof netSrc === 'function' ? netSrc() : netSrc);
    if (!net) throw { code: 'failed' };
    net.onPlayers = () => { if (view === 'room' && !el.hidden) renderPlayers(); };
    net.onStart = (c) => started(c);
    net.onClose = (r) => closed(r);
  }
  /** Leaves the room (if any) without hearing our own close; a factory gives a fresh net next time. */
  function dropNet() {
    if (net) {
      net.onPlayers = net.onStart = net.onClose = null;
      try { net.leave(); } catch (e) { console.warn('lobby: net.leave', e); }
      if (typeof netSrc === 'function') net = null;
    }
    inMatch = false; setRoom(null);
  }
  function started(c) {
    inMatch = true; setRoom(net?.code || null); hide();
    try {
      if (typeof game?.playOnline !== 'function') throw new Error('game.playOnline is missing');
      game.playOnline(net, c);
    } catch (e) {
      console.error('lobby: playOnline', e);
      inMatch = false; msg = "The match couldn't start here. Try START again."; show('room');
    }
  }
  function closed(reason) {
    const wasMatch = inMatch, wasHost = !!net?.isHost;
    dropNet();
    msg = ERRORS[reason] && reason !== 'failed' ? ERRORS[reason]() : wasHost ? 'Lost the connection: your room closed.' : ERRORS['host-left']();
    if (wasMatch) { try { game?.quit?.(); } catch (e) { console.warn('lobby: game.quit', e); } }
    show('choice');
  }

  // ---------------------------------------------------------------- actions
  async function create() {
    const my = ++op; msg = ''; busyText = 'Creating room…'; show('busy');
    try {
      await ensureNet();
      await net.host({ name: profile.name, color: profile.color });
      if (my !== op) return;
      setRoom(net.code); show('room');
    } catch (e) {
      if (my !== op) return;
      console.warn('lobby: host', e);
      dropNet(); msg = errText(e); show('choice');
    }
  }
  async function join() {
    if (!codeHint(true)) { $('[data-k=code]')?.focus(); return; }
    const my = ++op, c = code; msg = ''; busyText = `Joining room ${c}…`; show('busy');
    try {
      await ensureNet();
      await net.join(c, { name: profile.name, color: profile.color });
      if (my !== op) return;
      setRoom(net.code || c); show('room');
    } catch (e) {
      if (my !== op) return;
      console.warn('lobby: join', e);
      dropNet(); msg = errText(e, c); show(from);
    }
  }
  /** Host with friends in the room: the first press asks (the room closes for everyone), the second leaves. */
  function leave() {
    if (net?.isHost && humans() > 1 && !sure) {
      sure = true;
      const b = $('[data-a=leave]'); b.classList.add('sure'); b.textContent = 'CLOSE THE ROOM FOR EVERYONE?'; b.focus();
      return;
    }
    dropNet(); msg = ''; show('choice');
  }
  async function copy() {
    const b = $('[data-a=copy]'), h = $('[data-hint]'), url = link();
    let ok = false;
    try { await navigator.clipboard.writeText(url); ok = true; } catch { /* no permission / not a secure page */ }
    if (!ok) { const i = $('.link'); if (i) { i.style.display = 'block'; i.focus(); i.select(); } }
    if (!b) return;
    b.textContent = ok ? 'LINK COPIED ✓' : 'SELECTED';
    if (h) { h.textContent = ok ? 'Paste it to your friends in any chat app.' : `Press ${/Mac|iPhone|iPad/.test(navigator.userAgent) ? '⌘C' : 'Ctrl+C'} to copy the link.`; h.classList.toggle('warn', !ok); }
    clearTimeout(flashT);
    flashT = setTimeout(() => { if ($('[data-a=copy]') === b) b.textContent = 'COPY INVITE LINK'; }, 2200);
  }
  const act = {
    create, join, leave, copy,
    close() { close(); },
    choice() { msg = ''; show('choice'); },
    cancel() { op++; dropNet(); show(from); },
    share() { navigator.share?.({ title: 'Dogfight.io', text: `Fly with me in Dogfight.io! Room ${net?.code}`, url: link() }).catch(() => { /* closed the sheet */ }); },
    bots() { cfg.bots = !cfg.bots; $('[data-a=bots]').setAttribute('aria-checked', String(cfg.bots)); },
    start() {
      if (!net?.isHost || humans() < 1) return;
      try { net.start({ minutes: cfg.minutes, bots: cfg.bots }); } catch (e) { console.error('lobby: net.start', e); msg = errText(e); show('room'); }
    },
  };

  el.addEventListener('click', (e) => { const b = e.target.closest('[data-a]'); if (b && !b.disabled) act[b.dataset.a]?.(); });
  el.addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset.k === 'name') { profile.name = t.value.slice(0, 16); save(); }
    else if (t.dataset.k === 'code') { const v = normCode(t.value); if (t.value !== v) t.value = v; code = v; codeHint(false); }
  });
  el.addEventListener('focusout', (e) => {   // an emptied name falls back to the last good one
    if (e.target.dataset?.k !== 'name') return;
    const v = e.target.value.trim();
    if (v) profile.name = v; else e.target.value = profile.name || '';
    if (!profile.name) profile.name = e.target.value = 'Pilot';
    save();
  });
  el.addEventListener('change', (e) => {
    const t = e.target;
    if (t.name === 'dfo-color') { profile.color = t.value; save(); }
    else if (t.name === 'dfo-min') cfg.minutes = +t.value;
  });
  // capture: while open, no key reaches the menu (Enter = PLAY there) or the game's controls
  addEventListener('keydown', (e) => {
    if (el.hidden) return;
    e.stopImmediatePropagation();
    if (e.code === 'Escape') { e.preventDefault(); back(); }
    else if ((e.code === 'Enter' || e.code === 'NumpadEnter') && e.target.tagName !== 'BUTTON' && !e.repeat) {
      e.preventDefault();
      if (view === 'choice') (e.target.dataset?.k === 'code' ? join : create)();
      else if (view === 'join') join();
      else if (view === 'room' && net?.isHost) act.start();
    }
  }, true);
  function back() {
    if (view === 'choice') close();
    else if (view === 'join') act.choice();
    else if (view === 'busy') act.cancel();
    else if (view === 'room') leave();
  }

  /** Back to the start screen (the menu re-reads the name / colour edited here). */
  function close() {
    if (el.hidden) return;
    op++; hide();
    try { if (menu?.screen === 'start') menu.show('start'); } catch (e) { console.warn('lobby: menu.show', e); }
  }
  function open() {
    inMatch = false; msg = '';
    show(net?.code ? 'room' : 'choice');
  }
  function openJoin(c) {
    code = normCode(c); msg = '';
    if (net?.code) dropNet();
    show('join');
  }

  return { open, openJoin, close, get isOpen() { return !el.hidden; }, get view() { return view; }, el };
}
