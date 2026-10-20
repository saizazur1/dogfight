// cards.js -- the big centred cards: "ROUND 1 / Fight!", "YOU WIN", the 3-2-1 countdown. Bold Rubik, white on translucent dark,
// one accent (#ffb43a), red for a loss. A short scale + fade in, and out.
//
//   const cards = createCards(root);                 // root: any positioned full-screen element (the HUD's root works)
//   cards.show('round',     { text?, sub?, ms? });   // "ROUND 1", sub "Fight!"
//   cards.show('roundWin' | 'roundLose' | 'win' | 'lose' | 'count', { text, sub, ms });
//   cards.hide();
//
// Defaults (text / sub / how long it stays; ms: 0 = until hide()):
//   round      ROUND 1 / Fight!                   1800 ms        roundWin   ROUND WON / (none)     2200 ms (accent)
//   roundLose  ROUND LOST / (none)                2200 ms (red)   win        YOU WIN / Press Space to play again  stays (accent)
//   lose       YOU LOSE / Press Space to play again  stays (red)   count      (text is the digit)   900 ms
// Showing a card replaces the one on screen (count digits chain with no fade-out flash).
// 'win' / 'lose' also show a giant W (accent) / L (red) glyph above the title with a ray burst behind; o.glyph overrides it
// ('' = none, e.g. a draw).

const CSS = `
.dfc{position:fixed;inset:0;z-index:15;display:flex;align-items:center;justify-content:center;pointer-events:none;font-family:Rubik,system-ui,sans-serif;color:#fff}
.dfc .cd{display:flex;flex-direction:column;align-items:center;gap:10px;text-align:center;padding:22px 54px 26px;border-radius:26px;
  background:rgba(10,12,18,.58);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);box-shadow:0 14px 50px rgba(0,0,0,.4);
  opacity:0;transform:scale(.7)}
.dfc .cd.in{animation:dfcIn .32s cubic-bezier(.2,1.3,.4,1) forwards}
.dfc .cd.out{animation:dfcOut .24s ease-in forwards}
.dfc .t{font-weight:800;font-size:clamp(46px,11vh,110px);letter-spacing:.07em;line-height:1;text-shadow:0 3px 24px rgba(0,0,0,.55)}
.dfc .s{font-weight:700;font-size:clamp(18px,3.2vh,30px);letter-spacing:.06em;opacity:.9}
.dfc .cd.acc .t{color:#ffb43a}.dfc .cd.bad .t{color:#ff4d3d}
.dfc .cd.count{background:none;box-shadow:none;-webkit-backdrop-filter:none;backdrop-filter:none;padding:0}
.dfc .cd.count .t{font-size:clamp(90px,26vh,260px)}
@keyframes dfcIn{from{opacity:0;transform:scale(.7)}to{opacity:1;transform:scale(1)}}
@keyframes dfcOut{from{opacity:1;transform:scale(1)}to{opacity:0;transform:scale(1.12)}}
.dfc .g{display:none;font-weight:800;font-size:clamp(110px,28vh,260px);line-height:.82;margin:-4px 0 -6px;transform:rotate(-6deg)}
.dfc .cd.acc .g{color:#ffb43a;text-shadow:0 0 46px rgba(255,180,58,.55),0 6px 30px rgba(0,0,0,.5)}
.dfc .cd.bad .g{color:#ff4d3d;text-shadow:0 0 46px rgba(255,77,61,.5),0 6px 30px rgba(0,0,0,.5)}
.dfc .cd.gl .g{display:block}.dfc .cd.gl.in .g{animation:dfcG .55s cubic-bezier(.2,1.6,.4,1) both}
.dfc .bu{position:absolute;left:50%;top:50%;width:130vmin;height:130vmin;margin:-65vmin 0 0 -65vmin;border-radius:50%;opacity:0;
  background:repeating-conic-gradient(rgba(255,180,58,.4) 0 5deg,transparent 5deg 15deg);
  -webkit-mask:radial-gradient(circle,transparent 16%,#000 30%,transparent 68%);mask:radial-gradient(circle,transparent 16%,#000 30%,transparent 68%)}
.dfc .bu.bad{background:repeating-conic-gradient(rgba(255,77,61,.35) 0 5deg,transparent 5deg 15deg)}
.dfc .bu.go{animation:dfcB 1s ease-out forwards}
@keyframes dfcG{0%{opacity:0;transform:scale(2.8) rotate(-18deg)}55%{opacity:1}100%{opacity:1;transform:scale(1) rotate(-6deg)}}
@keyframes dfcB{0%{opacity:0;transform:scale(.3) rotate(0)}18%{opacity:1}100%{opacity:0;transform:scale(1.35) rotate(28deg)}}
@media (prefers-reduced-motion:reduce){.dfc .cd.in,.dfc .cd.out,.dfc .cd.gl.in .g{animation-duration:.01s}.dfc .bu.go{animation:none}}
`;

/** kind -> default text, sub, ms, look */
const KINDS = {
  round: { text: 'ROUND 1', sub: 'Fight!', ms: 1800, look: '' },
  roundWin: { text: 'ROUND WON', sub: '', ms: 2200, look: 'acc' },
  roundLose: { text: 'ROUND LOST', sub: '', ms: 2200, look: 'bad' },
  win: { text: 'YOU WIN', sub: 'Press Space to play again', ms: 0, look: 'acc', glyph: 'W' },
  lose: { text: 'YOU LOSE', sub: 'Press Space to play again', ms: 0, look: 'bad', glyph: 'L' },
  count: { text: '3', sub: '', ms: 900, look: 'count' },
};

/**
 * @param {HTMLElement} root  the cards are appended here
 * @returns {{show:(kind:'round'|'roundWin'|'roundLose'|'win'|'lose'|'count', o?:{text?:string, sub?:string, ms?:number, glyph?:string})=>void, hide:()=>void, el:HTMLElement}}
 */
export function createCards(root) {
  if (!document.getElementById('dfc-css')) {
    const st = document.createElement('style'); st.id = 'dfc-css'; st.textContent = CSS; document.head.appendChild(st);
  }
  const wrap = document.createElement('div'); wrap.className = 'dfc';
  wrap.innerHTML = '<div class="bu"></div><div class="cd" role="status" aria-live="polite"><div class="g" aria-hidden="true"></div><div class="t"></div><div class="s"></div></div>';
  root.appendChild(wrap);
  const bu = wrap.children[0], card = wrap.children[1], gEl = card.children[0], tEl = card.children[1], sEl = card.children[2];
  let timer = 0, outTimer = 0;

  /** fades the card out (and hides it for good once the animation is done) */
  function hide() {
    clearTimeout(timer); clearTimeout(outTimer);
    if (!card.classList.contains('in')) return;
    card.classList.remove('in'); card.classList.add('out');
    outTimer = setTimeout(() => { card.classList.remove('out'); card.style.display = 'none'; }, 260);
  }
  function show(kind, o = {}) {
    const k = KINDS[kind] || KINDS.round;
    clearTimeout(timer); clearTimeout(outTimer);
    tEl.textContent = o.text ?? k.text;
    const sub = o.sub ?? k.sub; sEl.textContent = sub; sEl.style.display = sub ? '' : 'none';
    const glyph = o.glyph ?? k.glyph ?? ''; gEl.textContent = glyph;
    card.className = `cd ${k.look}${glyph ? ' gl' : ''}`; card.style.display = '';
    bu.className = `bu ${k.look}`;
    void card.offsetWidth;   // restart the animation when a card replaces a card
    card.classList.add('in');
    if (glyph) bu.classList.add('go');
    const ms = o.ms ?? k.ms;
    if (ms > 0) timer = setTimeout(hide, ms);
  }
  card.style.display = 'none';
  return { show, hide, el: wrap };
}
