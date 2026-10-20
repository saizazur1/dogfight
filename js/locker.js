/**
 * locker.js — the trails / finishes picker and the end-of-match XP panel (README "Hooks contract", lane UNLOCKS).
 * Plain DOM, own CSS in the menu's style (Rubik, dark translucent blur panels, accent #ffb43a, big rounded tiles).
 *
 *   const locker = createLocker(document.body, prog, { onEquip });
 *   locker.open() / locker.close()        Trails / Finishes tabs, a CSS preview per item, locked tiles say "LVL 8";
 *                                         a click on an unlocked tile equips it (prog.equip) and calls onEquip(); Esc / Back close
 *   locker.showResult(summary)            under the centred end card (cards.js z 15; this is z 16, no pointer events): "+340 XP",
 *                                         the XP bar filling level by level, LEVEL UP! + rank, "NEW: Rainbow trail" chips, challenges
 *   locker.hideResult()                   also automatic: when the end card leaves (next match / quit) or the menu shows
 */

const CSS = `
.dfl{position:fixed;inset:0;z-index:30;display:flex;align-items:center;justify-content:center;font-family:Rubik,system-ui,sans-serif;color:#fff;
  background:radial-gradient(ellipse at 50% 45%,rgba(8,10,16,.72),rgba(8,10,16,.9));-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);
  -webkit-font-smoothing:antialiased;overflow:auto}
.dfl[hidden],.dfr[hidden]{display:none}
.dfl *,.dfr *{box-sizing:border-box}
.dfl .box{width:min(640px,94vw);margin:auto;padding:16px 0;display:flex;flex-direction:column;align-items:center;gap:14px}
.dfl h2{margin:0;font-weight:800;font-size:34px;letter-spacing:.08em}
.dfl .who{font-weight:700;font-size:14px;letter-spacing:.1em;text-transform:uppercase;opacity:.75;margin-top:-8px}
.dfl .who b{color:#ffb43a}
.dfl .pnl{width:100%;background:rgba(12,14,20,.62);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);border-radius:20px;padding:20px 22px;
  display:flex;flex-direction:column;gap:14px;box-shadow:0 10px 40px rgba(0,0,0,.35)}
.dfl .tabs{display:flex;background:rgba(255,255,255,.1);border-radius:12px;padding:3px;gap:3px}
.dfl button{font-family:inherit;cursor:pointer;border:0;color:#fff}
.dfl .tabs button{flex:1;padding:9px 0;border-radius:9px;font-weight:700;font-size:15px;background:none;letter-spacing:.06em}
.dfl .tabs button[aria-selected=true]{background:#ffb43a;color:#1a1205}
.dfl .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
.dfl .tile{position:relative;display:flex;flex-direction:column;align-items:stretch;gap:7px;padding:8px 8px 10px;border-radius:14px;background:rgba(255,255,255,.1);
  transition:background .12s,transform .08s;text-align:center}
.dfl .tile:hover{background:rgba(255,255,255,.18)}
.dfl .tile:active{transform:scale(.97)}
.dfl .tile b{font-weight:800;font-size:14px;line-height:1.1}
.dfl .tile small{font-weight:700;font-size:10px;letter-spacing:.1em;opacity:.7;text-transform:uppercase;min-height:12px}
.dfl .tile.on{background:rgba(255,180,58,.22);box-shadow:inset 0 0 0 3px #ffb43a}
.dfl .tile.on small{color:#ffb43a;opacity:1}
.dfl .tile.lock{cursor:not-allowed}
.dfl .tile.lock .pv{filter:grayscale(.85) brightness(.45)}
.dfl .tile.lock b{opacity:.6}
.dfl .tile .lv{position:absolute;left:50%;top:30px;transform:translateX(-50%);font-weight:800;font-size:13px;letter-spacing:.06em;background:rgba(10,12,18,.85);
  border-radius:8px;padding:3px 9px;white-space:nowrap}
.dfl .tile.shake{animation:dflShake .3s}
.dfl .tile:focus-visible,.dfl .tabs button:focus-visible,.dfl .big:focus-visible{outline:3px solid #fff;outline-offset:2px}
.dfl .pv{position:relative;height:62px;border-radius:10px;overflow:hidden;background:linear-gradient(170deg,#202a4a,#4a3c5e 70%,#7a5a62)}
.dfl .pv.tr i{position:absolute;left:6%;right:22%;height:7px;border-radius:4px;background:var(--g);-webkit-mask:linear-gradient(90deg,transparent,#000 85%);mask:linear-gradient(90deg,transparent,#000 85%)}
.dfl .pv.tr i:nth-child(1){top:22px}.dfl .pv.tr i:nth-child(2){top:36px}
.dfl .pv.tr:after{content:"";position:absolute;right:12%;top:20px;width:0;height:0;border-top:12px solid transparent;border-bottom:12px solid transparent;border-left:22px solid #cfd3da;
  filter:drop-shadow(0 1px 2px rgba(0,0,0,.5))}
.dfl .pv.fi i{position:absolute;left:50%;top:50%;width:46px;height:46px;margin:-23px 0 0 -23px;border-radius:50%;background:var(--g);box-shadow:var(--s,none)}
.dfl .big{width:100%;font-weight:800;font-size:22px;letter-spacing:.1em;color:#1a1205;background:#ffb43a;border-radius:16px;padding:12px 0;
  box-shadow:0 6px 0 #b9761a,0 12px 28px rgba(0,0,0,.35)}
.dfl .big:active{transform:translateY(4px);box-shadow:0 2px 0 #b9761a,0 6px 16px rgba(0,0,0,.35)}
@keyframes dflShake{0%,100%{transform:none}25%{transform:translateX(-5px)}75%{transform:translateX(5px)}}
@media (max-width:560px){.dfl .grid{grid-template-columns:repeat(3,1fr)}}
@media (max-height:640px){.dfl .box{gap:8px}.dfl h2{font-size:26px}.dfl .pnl{padding:14px 16px;gap:10px}.dfl .pv{height:48px}.dfl .pv.tr i:nth-child(1){top:15px}
  .dfl .pv.tr i:nth-child(2){top:27px}.dfl .pv.tr:after{top:12px}.dfl .tile .lv{top:22px}.dfl .big{font-size:18px;padding:9px 0}}

.dfr{position:fixed;left:50%;top:calc(50% + 7.5vh + 46px);   /* showResult places it under the card's real height */
  transform:translateX(-50%);z-index:16;pointer-events:none;font-family:Rubik,system-ui,sans-serif;color:#fff;
  width:min(440px,92vw);-webkit-font-smoothing:antialiased}
.dfr .in{position:relative;display:flex;flex-direction:column;gap:9px;padding:14px 20px 16px;border-radius:20px;background:rgba(10,12,18,.58);
  -webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);box-shadow:0 14px 50px rgba(0,0,0,.4);animation:dfrIn .4s cubic-bezier(.2,1.3,.4,1) both}
.dfr .top{display:flex;align-items:baseline;justify-content:space-between;gap:12px}
.dfr .xp{font-weight:800;font-size:30px;color:#ffb43a;letter-spacing:.03em;text-shadow:0 2px 14px rgba(255,180,58,.35)}
.dfr .lvl{font-weight:800;font-size:15px;letter-spacing:.08em;text-transform:uppercase}
.dfr .lvl span{opacity:.7;font-weight:700}
.dfr .xbar{position:relative;height:12px;border-radius:6px;background:rgba(255,255,255,.16);overflow:hidden}
.dfr .xbar i{position:absolute;left:0;top:0;bottom:0;width:0;border-radius:6px;background:linear-gradient(90deg,#ffb43a,#ffd98a)}
.dfr .xbar i.go{transition:width .7s cubic-bezier(.3,.7,.3,1)}
.dfr .num{font-weight:700;font-size:12px;opacity:.7;text-align:right;margin-top:-4px;font-variant-numeric:tabular-nums}
.dfr .chips{display:flex;flex-wrap:wrap;gap:6px}
.dfr .chips:empty{display:none}
.dfr .chip{font-weight:700;font-size:12px;letter-spacing:.04em;padding:4px 10px;border-radius:9px;background:rgba(255,255,255,.14);opacity:0}
.dfr .chips.show .chip{animation:dfrIn .35s cubic-bezier(.2,1.3,.4,1) both}
.dfr .chip.new{background:#ffb43a;color:#1a1205}
.dfr .chip.ch{background:rgba(80,220,140,.22);color:#c8ffd9}
.dfr .lvl{transition:opacity .2s}.dfr .lvl.hid{opacity:0}
.dfr .up{position:absolute;right:18px;top:10px;pointer-events:none;opacity:0}
.dfr .up.go{animation:dfrUp 2.6s ease-out forwards}
.dfr .up b{position:relative;display:block;font-weight:800;font-size:30px;letter-spacing:.08em;color:#ffb43a;white-space:nowrap;text-shadow:0 0 18px rgba(255,180,58,.8),0 3px 18px rgba(0,0,0,.6)}
.dfr .up:before{content:"";position:absolute;left:50%;top:50%;width:220px;height:220px;margin:-110px 0 0 -110px;border-radius:50%;z-index:-1;
  background:repeating-conic-gradient(rgba(255,200,90,.32) 0 8deg,transparent 8deg 22deg);-webkit-mask:radial-gradient(circle,#000 18%,transparent 68%);
  mask:radial-gradient(circle,#000 18%,transparent 68%);animation:dfrSpin 3s linear infinite}
@keyframes dfrIn{from{opacity:0;transform:translateY(10px) scale(.92)}to{opacity:1;transform:none}}
@keyframes dfrUp{0%{opacity:0;transform:scale(.4)}12%{opacity:1;transform:scale(1.2)}22%{transform:scale(1)}85%{opacity:1;transform:scale(1)}100%{opacity:0;transform:scale(.9)}}
@keyframes dfrSpin{to{transform:rotate(360deg)}}
@media (max-height:640px){.dfr .in{padding:10px 16px 12px;gap:7px}.dfr .xp{font-size:24px}.dfr .up b{font-size:24px}}
@media (prefers-reduced-motion:reduce){.dfr .in,.dfr .chips.show .chip,.dfr .up.go,.dfl .tile.shake{animation-duration:.01s}.dfr .up:before{animation:none}}
`;

/** CSS backgrounds for the previews; 'C' is replaced by the player's jet colour. */
const TRAIL_PV = {
  vapor: 'linear-gradient(90deg,rgba(255,255,255,0),rgba(255,255,255,.75))',
  none: 'transparent',
  neon: 'linear-gradient(90deg,C,#fff)',
  rainbow: 'linear-gradient(90deg,#ff3b3b,#ffb43a,#ffe94a,#3bff7a,#3bc8ff,#8a5bff,#ff4bd8)',
  fire: 'linear-gradient(90deg,#5a0a00,#ff4a10,#ffb43a,#fff2c0)',
  ice: 'linear-gradient(90deg,#2a7cff,#7fdcff,#e8fbff)',
  galaxy: 'radial-gradient(circle at 30% 50%,#fff 0 1px,transparent 2px),radial-gradient(circle at 62% 40%,#fff 0 1px,transparent 2px),linear-gradient(90deg,#3a0d8a,#1a5ad0,#a04bff)',
  gold: 'linear-gradient(90deg,#7a4a08,#e0a020,#fff0b0,#e0a020)',
};
const FINISH_PV = {
  gloss: ['radial-gradient(circle at 34% 30%,#fff 0 4%,C 22%,C 55%,rgba(0,0,0,.55) 100%)'],
  matte: ['radial-gradient(circle at 40% 35%,C 0,C 60%,rgba(0,0,0,.35) 100%)'],
  pearl: ['radial-gradient(circle at 34% 30%,#fff 0 6%,rgba(255,255,255,.4) 25%,transparent 50%),conic-gradient(from 40deg,#ffd6f0,#d6e8ff,#e8ffd6,#fff2d0,#ffd6f0),C', ''],
  chrome: ['linear-gradient(160deg,#fff 0,#9aa3ad 30%,#2a2f36 48%,#e9eef3 52%,#7d8792 75%,#fff 100%)'],
  neon: ['radial-gradient(circle at 40% 35%,#fff 0 6%,C 30%,C 100%)', '0 0 14px 3px C,0 0 30px 6px C'],
  gold: ['linear-gradient(160deg,#fff4c4 0,#e0a020 30%,#7a4a08 50%,#ffe28a 56%,#b37812 80%,#fff0b0 100%)'],
};

const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * @param {HTMLElement} root
 * @param {object} prog       progress.js instance (state, equip, ITEMS, levelInfo)
 * @param {{onEquip?:()=>void}} [opts]
 */
export function createLocker(root, prog, { onEquip } = {}) {
  if (!document.getElementById('dfl-css')) { const st = document.createElement('style'); st.id = 'dfl-css'; st.textContent = CSS; document.head.appendChild(st); }
  const panel = document.createElement('div'); panel.className = 'dfl'; panel.hidden = true;
  panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'Locker');
  panel.innerHTML = `<div class="box"><h2>LOCKER</h2><div class="who"></div><div class="pnl">
    <div class="tabs" role="tablist"><button role="tab" data-t="trail">TRAILS</button><button role="tab" data-t="finish">FINISHES</button></div>
    <div class="grid"></div><button class="big" data-a="back">BACK</button></div></div>`;
  root.appendChild(panel);
  const res = document.createElement('div'); res.className = 'dfr'; res.hidden = true; res.setAttribute('aria-live', 'polite');
  root.appendChild(res);
  const grid = panel.querySelector('.grid'), who = panel.querySelector('.who');
  let tab = 'trail', lastFocus = null;

  const jetColor = () => {
    try { const c = JSON.parse(localStorage.getItem('dogfight.menu.v1') || '{}')?.profile?.color; if (/^#[0-9a-f]{6}$/i.test(c || '')) return c; } catch { /* no storage */ }
    return '#c8362c';
  };

  function render() {
    const st = prog.state, col = jetColor();
    who.innerHTML = `Level ${st.level} · <b>${esc(st.rank)}</b>`;
    for (const b of panel.querySelectorAll('[data-t]')) b.setAttribute('aria-selected', String(b.dataset.t === tab));
    const items = prog.ITEMS.filter((i) => i.kind === tab), have = tab === 'trail' ? st.unlocked.trails : st.unlocked.finishes, on = st.equipped[tab];
    grid.style.gridTemplateColumns = items.length <= 6 && innerWidth > 560 ? 'repeat(3,1fr)' : '';
    grid.innerHTML = items.map((i) => {
      const locked = !have.includes(i.id), cls = `tile${locked ? ' lock' : ''}${i.id === on ? ' on' : ''}`;
      let pv;
      if (tab === 'trail') { const g = TRAIL_PV[i.id] || TRAIL_PV.vapor; pv = `<div class="pv tr" style="--g:${g.replace(/C/g, col)}"><i></i><i></i></div>`; }
      else { const [g, s = ''] = FINISH_PV[i.id] || FINISH_PV.gloss; pv = `<div class="pv fi" style="--g:${g.replace(/C/g, col)};${s ? `--s:${s.replace(/C/g, col)}` : ''}"><i></i></div>`; }
      const tag = i.id === on ? 'Equipped' : locked ? '' : 'Tap to equip';
      return `<button class="${cls}" data-id="${i.id}" aria-pressed="${i.id === on}" aria-label="${esc(i.name)}${locked ? `, unlocks at level ${i.level}` : ''}">${pv}<b>${esc(i.name)}</b><small>${tag}</small>${locked ? `<span class="lv">LVL ${i.level}</span>` : ''}</button>`;
    }).join('');
  }

  function open() {
    try { prog.refresh?.(); } catch { /* progress lane */ }
    lastFocus = document.activeElement;
    render(); panel.hidden = false;
    panel.querySelector(`[data-t=${tab}]`).focus({ preventScroll: true });
  }
  function close() {
    if (panel.hidden) return;
    panel.hidden = true;
    try { lastFocus?.focus?.({ preventScroll: true }); } catch { /* gone */ }
  }

  panel.addEventListener('click', (e) => {
    const t = e.target.closest('[data-t]'); if (t) { tab = t.dataset.t; render(); panel.querySelector(`[data-t=${tab}]`).focus({ preventScroll: true }); return; }
    if (e.target.closest('[data-a=back]')) { close(); return; }
    const tile = e.target.closest('.tile'); if (!tile) return;
    const id = tile.dataset.id;
    if (!prog.equip(tab, id)) { tile.classList.remove('shake'); void tile.offsetWidth; tile.classList.add('shake'); return; }
    try { onEquip?.(); } catch (err) { console.warn('locker: onEquip', err); }
    render();
    grid.querySelector(`[data-id="${id}"]`)?.focus({ preventScroll: true });
  });
  // capture: while the locker is open, Esc / Enter never reach the menu underneath (Enter there would start a match)
  addEventListener('keydown', (e) => {
    if (panel.hidden) return;
    if (e.code === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(); }
    else if (e.code === 'Enter' || e.code === 'NumpadEnter') { e.stopImmediatePropagation(); }
  }, true);

  // ---------------------------------------------------------------- the end-of-match panel
  let runId = 0;
  const timers = [];
  const later = (ms, fn) => { timers.push(setTimeout(fn, ms)); };
  function hideResult() {
    runId++;
    while (timers.length) clearTimeout(timers.pop());
    res.hidden = true; res.innerHTML = '';
  }
  /** Hide when the end card changes at all (cards.hide on the next play / quit; the next mode's first card follows in the same
   *  task, so "is it still in" would already read true again) or the menu's visibility is touched. */
  const watch = new MutationObserver(() => { if (!res.hidden) hideResult(); watch.disconnect(); });
  const watchNow = () => {
    watch.disconnect();
    const menu = document.getElementById('menu'), card = document.querySelector('.dfc .cd');
    if (menu) watch.observe(menu, { attributes: true, attributeFilter: ['hidden'] });
    if (card) watch.observe(card, { attributes: true, attributeFilter: ['class'] });
  };

  /** Just under the end card (its real height: hype's cards are taller than the defaults), kept on screen. */
  function place() {
    const card = document.querySelector('.dfc .cd'), h = res.offsetHeight || 140;
    if (!card || card.style.display === 'none') { res.style.top = ''; return; }
    const bottom = (innerHeight + card.offsetHeight) / 2;
    res.style.top = `${Math.max(0, Math.min(bottom + 12, innerHeight - h - 12))}px`;
  }

  function showResult(sum) {
    if (!sum) return;
    hideResult();
    const id = runId, b = sum.before || { level: 1, into: 0, need: 1 }, a = sum.after || b;
    const chips = [
      ...(sum.rankUp ? [`<span class="chip new">NEW RANK: ${esc(sum.rank)}</span>`] : []),
      ...(sum.unlocked || []).map((u) => `<span class="chip new">NEW: ${esc(u.name)} ${u.kind === 'trail' ? 'trail' : 'finish'}</span>`),
      ...(sum.challenges || []).map((c) => `<span class="chip ch">✓ ${esc(c.text)} +${c.xp}</span>`),
    ];
    res.innerHTML = `<div class="in"><div class="up"><b>LEVEL UP!</b></div>
      <div class="top"><span class="xp">+0 XP</span><span class="lvl">LVL <b class="lv">${b.level}</b> <span class="rk"></span></span></div>
      <div class="xbar"><i></i></div><div class="num"></div><div class="chips">${chips.join('')}</div></div>`;
    res.hidden = false;
    place();   // the chips are in already (invisible until they pop), so the height is the real one
    watchNow();
    const xpEl = res.querySelector('.xp'), lvEl = res.querySelector('.lv'), rkEl = res.querySelector('.rk'), bar = res.querySelector('.xbar i'), lvlEl = res.querySelector('.lvl');
    const num = res.querySelector('.num'), up = res.querySelector('.up'), chipsEl = res.querySelector('.chips');
    rkEl.textContent = a.level === b.level ? `· ${sum.rank || ''}` : '';
    const pct = (into, need) => `${Math.max(0, Math.min(100, (100 * into) / Math.max(1, need)))}%`;
    bar.style.width = pct(b.into, b.need);
    num.textContent = `${b.into} / ${b.need} XP`;
    // count the XP up
    const total = Math.max(0, sum.xp | 0), t0 = performance.now(), dur = 900;
    const count = (now) => {
      if (id !== runId) return;
      const k = Math.min(1, (now - t0) / dur);
      xpEl.textContent = `+${Math.round(total * (1 - (1 - k) * (1 - k)))} XP`;
      if (k < 1) requestAnimationFrame(count);
    };
    requestAnimationFrame(count);
    // fill the bar: to the top for every level gained, then to where it ends
    let lvl = b.level, t = 350;
    const levelsUp = Math.max(0, a.level - b.level);
    for (let k = 0; k < levelsUp; k++) {
      later(t, () => { if (id !== runId) return; bar.classList.add('go'); bar.style.width = '100%'; });
      t += 750;
      later(t, () => {
        if (id !== runId) return;
        lvl++; lvEl.textContent = lvl; bar.classList.remove('go'); bar.style.width = '0%';
      });
      t += 60;
    }
    later(t, () => {
      if (id !== runId) return;
      bar.classList.add('go'); bar.style.width = pct(a.into, a.need); num.textContent = `${a.into} / ${a.need} XP`;
      if (sum.levelUp) {
        rkEl.textContent = `· ${sum.rank || ''}`;
        up.classList.add('go'); lvlEl.classList.add('hid');
        later(2500, () => { if (id === runId) lvlEl.classList.remove('hid'); });
      }
    });
    later(t + 400, () => { if (id === runId) chipsEl.classList.add('show'); });
  }

  return { open, close, showResult, hideResult, get isOpen() { return !panel.hidden; }, el: panel };
}
