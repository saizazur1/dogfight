/**
 * chaos.js — the Chaos mode (README "Modes contract" + "Hooks contract", lane CHAOS): a 2-minute free-for-all, me + 7 AIs, lots of
 * power-ups and a supply drop every 30 s. Everyone fights everyone: every ~3 s each AI picks the nearest live jet (a mild bias
 * toward me). Shot down or crashed: back in the air 3 s later at the start slot farthest from the others. A kill counts for
 * whoever combat credits (a solo crash is only a death). Banner "1:42 · 2nd · 3 kills"; at 0:00 a leaderboard (most kills, then
 * fewest deaths) and game.finish with my place (top 3 = a win).
 *
 * Online (README "Online contract", lane NET): createChaosMode(game, { online: { host, minutes, bots, players, mySeat, view } }).
 *   host:   the same match on seats 0..7 (fighter id = seat): humans from `players` (seat 0 = me, the others are remote players
 *           flown from the network: game.spawnAI({ id, remote: true }), respawned with game.respawnRemote), AIs on every other
 *           seat when `bots`; `minutes` long. mode.toAI(seat) (a player left: an AI takes the jet, score kept) and
 *           mode.toHuman(seat, { name, color }) (a late joiner takes an AI's seat, or an empty one; its score starts at 0).
 *   client: a view only: the clock, phase and every seat's kills / deaths come from the host's snapshots (`view`, netgame.js);
 *           it shows the same cards, banner and leaderboard and finishes with MY place. Nothing here decides anything.
 */
const ARENA_R = 3500;   // m: everyone starts on a ring this wide (the default ring is ~8 km: too far apart for 2 minutes)
const COUNTDOWN = 2, MATCH_S = 120, RESPAWN_S = 3, RETARGET_S = 10, SWITCH_IF = 0.5, ME_BIAS = 0.7, N = 8;
const AI_NAMES = ['Viper', 'Kestrel', 'Raptor', 'Talon', 'Ghost', 'Harrier', 'Osprey', 'Merlin'];
const COLORS = ['#e8453c', '#3b7bff', '#ffc02e', '#38c172', '#a66bff', '#ff7a3d', '#22c8d6', '#ff5fae', '#e7e7ea'];
const SKILLS = ['easy', 'medium', 'hard'];
const MISSILE_DMG = 1, GUN_X = 1.5;   // arcade: one missile hit kills, the gun hits 1.5x harder (duel keeps 0.7 / 1x)
const SKILL_MIX = [0, 0, -1, 1, 0, -1, 0];   // around the player's skill, one per AI
const ord = (n) => `${n}${n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th'}`;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

const CSS = `
.chb{position:fixed;right:1.5vw;top:50%;transform:translateY(-50%);z-index:16;pointer-events:none;font-family:Rubik,system-ui,sans-serif;color:#fff;
  min-width:250px;padding:14px 14px 10px;border-radius:20px;background:rgba(10,12,18,.62);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);
  box-shadow:0 14px 50px rgba(0,0,0,.4);animation:chbIn .4s cubic-bezier(.2,1.3,.4,1) both}
.chb h3{margin:0 0 10px;font-size:15px;font-weight:800;letter-spacing:.18em;color:#ffb43a;text-align:center}
.chb table{border-collapse:collapse;width:100%;font-size:15px;font-weight:700}
.chb th{font-size:11px;letter-spacing:.14em;opacity:.6;font-weight:700;padding:0 6px 6px;text-align:right}
.chb th:nth-child(2){text-align:left}
.chb td{padding:5px 6px;text-align:right;text-shadow:0 1px 3px rgba(0,0,0,.7)}.chb td:nth-child(2){text-align:left;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chb td:first-child{opacity:.75;width:2.4em}
.chb tr.me td{background:rgba(255,180,58,.18)}.chb tr.me td:first-child{border-radius:8px 0 0 8px;opacity:1}.chb tr.me td:last-child{border-radius:0 8px 8px 0}
.chb tr.me td:nth-child(2)::after{content:' (you)';color:#fff;opacity:.7;font-weight:600}
@keyframes chbIn{from{opacity:0;transform:translateY(-50%) translateX(30px)}to{opacity:1;transform:translateY(-50%)}}
@media (max-width:1100px){.chb{transform:translateY(-50%) scale(.78);transform-origin:right center;animation:none}}
`;

/** @param {object} game  README `game` object */
export function createChaosMode(game, { online = null } = {}) {
  const roster = [];   // [{ f, name, color, skill, kills, deaths, dead, deadT, retT, isMe, remote?, seat? }]
  const MATCH = online ? Math.round((online.minutes || 3) * 60) : MATCH_S, client = !!online && !online.host;
  let phase = 'count', phaseT = 0, clock = MATCH, slots = [], board = null, saved = null;   // saved: combat's damage numbers, put back in stop()
  let shownSec = -1, shownPlace = -1, shownKills = -1;

  const byFighter = (id) => { for (let i = 0; i < roster.length; i++) if (roster[i].f.id === id) return roster[i]; return null; };
  const items = () => (game.powerups ? game.powerups.items : null);

  /** the start slot farthest from every live jet but `self` */
  function farthestSlot(self) {
    let best = 0, bestD = -1;
    for (let k = 0; k < slots.length; k++) {
      const p = slots[k].pos;
      let d = Infinity;
      for (const g of game.fighters) {
        if (g === self || !g.alive) continue;
        d = Math.min(d, Math.hypot(g.s.pos[0] - p[0], g.s.pos[1] - p[1], g.s.pos[2] - p[2]));
      }
      if (d > bestD) { bestD = d; best = k; }
    }
    return slots[best];
  }

  /** an AI's target: the nearest live jet (me counts as a bit nearer). Sticky: the current one is kept unless another is
   *  less than SWITCH_IF as far (a lock takes 1.3 s and a chase much longer; swapping every few seconds meant no kills). */
  function retarget(r) {
    const f = r.f, cur = f.target && f.target.alive && f.target !== f ? f.target : null;
    let best = null, bd = Infinity;
    for (const g of game.fighters) {
      if (g === f || !g.alive) continue;
      let d = Math.hypot(g.s.pos[0] - f.s.pos[0], g.s.pos[1] - f.s.pos[1], g.s.pos[2] - f.s.pos[2]);
      if (g === game.me) d *= ME_BIAS;
      if (d < bd) { bd = d; best = g; }
    }
    if (cur && best !== cur) {
      let dc = Math.hypot(cur.s.pos[0] - f.s.pos[0], cur.s.pos[1] - f.s.pos[1], cur.s.pos[2] - f.s.pos[2]);
      if (cur === game.me) dc *= ME_BIAS;
      if (bd > dc * SWITCH_IF) best = cur;
    }
    f.target = best;
    r.retT = RETARGET_S;
  }

  function spawn(r, start) {
    r.f = game.spawnAI({ ...start, skill: r.skill, name: r.name, color: r.color, id: r.seat, remote: r.remote });
    r.f.ai?.setPickups?.(items());
    r.dead = false; r.deadT = 0; r.retT = 0;
  }

  /** my place: 1 + everyone with more kills, or as many kills and fewer deaths */
  function placeOf(me) {
    let p = 1;
    for (let i = 0; i < roster.length; i++) { const r = roster[i]; if (r !== me && (r.kills > me.kills || (r.kills === me.kills && r.deaths < me.deaths))) p++; }
    return p;
  }

  function banner() {
    const me = roster.find((r) => r.isMe), sec = Math.ceil(Math.max(0, clock)), place = placeOf(me);
    if (sec === shownSec && place === shownPlace && me.kills === shownKills) return;
    shownSec = sec; shownPlace = place; shownKills = me.kills;
    game.setBanner(`${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')} · ${ord(place)} · ${plural(me.kills, 'kill')}`);
  }

  function showBoard(sorted) {
    removeBoard();
    if (!document.getElementById('chb-css')) { const st = document.createElement('style'); st.id = 'chb-css'; st.textContent = CSS; document.head.appendChild(st); }
    board = document.createElement('div'); board.className = 'chb';
    const h = document.createElement('h3'); h.textContent = 'LEADERBOARD';
    const tb = document.createElement('table'), head = tb.insertRow();
    for (const s of ['#', 'PILOT', 'KILLS', 'DEATHS']) { const th = document.createElement('th'); th.textContent = s; head.appendChild(th); }
    sorted.forEach((r) => {
      const tr = tb.insertRow();
      if (r.isMe) tr.className = 'me';
      const cells = [ord(placeOf(r)), r.name, r.kills, r.deaths].map((v) => { const td = tr.insertCell(); td.textContent = String(v); return td; });
      cells[1].style.color = r.color;
    });
    board.append(h, tb);
    document.body.appendChild(board);
  }
  function removeBoard() { if (board) { board.remove(); board = null; } }

  function end() {
    phase = 'over'; phaseT = 0;
    const me = roster.find((r) => r.isMe), place = placeOf(me);
    const sorted = roster.slice().sort((a, b) => b.kills - a.kills || a.deaths - b.deaths || (b.isMe ? 1 : 0) - (a.isMe ? 1 : 0));
    showBoard(sorted);
    game.finish({ title: me.kills ? `${ord(place).toUpperCase()} PLACE` : 'NO KILLS', sub: `${plural(me.kills, 'kill')} · ${plural(me.deaths, 'death')}`, won: place <= 3 && me.kills > 0, place });   // 0 kills is never a W, even when ties put me 2nd
  }

  const mode = {
    id: 'chaos', title: 'Chaos', powerups: { count: 10, dropEvery: 30, radius: ARENA_R + 1500 },
    get phase() { return phase; }, get clock() { return clock; }, roster,
    get kills() { return roster[0] ? roster[0].kills : 0; },
    get place() { return roster[0] ? placeOf(roster[0]) : 0; },
    start() {
      if (client) { startClient(); return; }
      removeBoard();
      for (let i = 1; i < roster.length; i++) if (roster[i].f) game.despawn(roster[i].f);
      roster.length = 0;
      slots = [];
      for (let k = 0; k < N; k++) slots.push(game.safeSpawn(k, N, ARENA_R));
      const me = game.me;
      game.respawnMe(slots[0]);
      me.ai?.setPickups?.(items());
      roster.push({ f: me, name: me.name, color: me.color, skill: null, kills: 0, deaths: 0, dead: false, deadT: 0, retT: 0, isMe: true });
      const mine = String(me.color || '').toLowerCase(), cols = COLORS.filter((c) => c !== mine);
      const base = Math.max(0, SKILLS.indexOf(game.profile?.skill || 'medium'));
      const first = String(me.name || '').split(' ')[0], names = AI_NAMES.filter((n) => n !== first);   // no 'Ghost' next to 'Ghost 520'
      if (online) {   // seats: the humans where the room put them, AIs on the rest (if wanted)
        const humans = new Map((online.players || []).filter((p) => p.seat > 0 && p.seat < N).map((p) => [p.seat, p]));
        const taken = new Set([...humans.values()].map((p) => String(p.name || '').split(' ')[0]));
        const aiNames = names.filter((n) => !taken.has(n));
        for (let k = 1; k < N; k++) {
          const p = humans.get(k);
          if (!p && !online.bots) continue;
          const r = { f: null, seat: k, remote: !!p, name: p ? p.name : aiNames[(k - 1) % aiNames.length], color: p ? p.color : cols[(k - 1) % cols.length],
            skill: SKILLS[Math.min(2, Math.max(0, base + SKILL_MIX[k - 1]))], kills: 0, deaths: 0, dead: false, deadT: 0, retT: 0.4 * k, isMe: false };
          spawn(r, slots[k]);
          if (r.remote) game.respawnRemote(r.f, slots[k]);
          r.retT = 0.4 * k;
          roster.push(r);
        }
        game.netRoster?.();
      } else for (let k = 1; k < N; k++) {
        const r = { f: null, name: names[(k - 1) % names.length], color: cols[(k - 1) % cols.length],
          skill: SKILLS[Math.min(2, Math.max(0, base + SKILL_MIX[k - 1]))], kills: 0, deaths: 0, dead: false, deadT: 0, retT: 0, isMe: false };
        spawn(r, slots[k]);
        r.retT = 0.4 * k;   // staggered retargeting
        roster.push(r);
      }
      const T = game.combat.TUNE; saved = saved || { m: T.mDamage, g: T.gunDamage };
      T.mDamage = MISSILE_DMG; T.gunDamage = saved.g * GUN_X;
      phase = 'count'; phaseT = 0; clock = MATCH; shownSec = shownPlace = shownKills = -1;
      game.weaponsOff = true;
      banner();
      game.cards.show('round', { text: online ? 'ONLINE CHAOS' : 'CHAOS', sub: `Everyone vs everyone · most kills in ${Math.floor(MATCH / 60)}:${String(MATCH % 60).padStart(2, '0')}`, ms: COUNTDOWN * 1000 });
    },
    step(dt) {
      if (client) { stepClient(); return; }
      phaseT += dt;
      if (phase === 'count') {
        if (phaseT >= COUNTDOWN) { phase = 'fight'; phaseT = 0; game.weaponsOff = false; game.cards.show('round', { text: 'FIGHT!', ms: 900 }); }
        return;
      }
      if (phase !== 'fight') return;
      clock -= dt;
      for (let i = 0; i < roster.length; i++) {
        const r = roster[i], f = r.f;
        if (r.dead || !f.alive) {
          if ((r.deadT += dt) >= RESPAWN_S) {
            if (r.isMe) { game.respawnMe(farthestSlot(f)); f.ai?.setPickups?.(items()); r.dead = false; r.deadT = 0; }   // (?bot: an AI flies me)
            else if (r.remote) { game.respawnRemote(f, farthestSlot(f)); r.dead = false; r.deadT = 0; r.retT = 0; }   // the player places its own jet
            else { const at = farthestSlot(f); game.despawn(f); spawn(r, at); }
          }
          continue;
        }
        if (!r.isMe && !r.remote && ((r.retT -= dt) <= 0 || !f.target || !f.target.alive)) retarget(r);
      }
      banner();
      if (clock <= 0) end();
    },
    frame() {},
    /** kills (combat's credit) and deaths; a solo crash (killer -1 or the victim) is only a death */
    onEvent(e) {
      if (client || e.type !== 'kill' || phase === 'over') return;
      const v = byFighter(e.victim);
      if (v && !v.dead) { v.deaths++; v.dead = true; v.deadT = 0; }
      if (e.killer >= 0 && e.killer !== e.victim) { const k = byFighter(e.killer); if (k) k.kills++; }
    },
    stop() {
      removeBoard();
      if (saved) { game.combat.TUNE.mDamage = saved.m; game.combat.TUNE.gunDamage = saved.g; saved = null; }
      for (let i = 0; i < roster.length; i++) { const f = roster[i].f; if (f && !roster[i].isMe) { f.target = null; game.despawn(f); } }
      game.me.target = null;
      roster.length = 0;
      game.weaponsOff = false; game.setBanner(null);
      phase = 'count';
    },
    /** online host: a player left; an AI flies its jet from here (the score stays with the seat) */
    toAI(seat) {
      const r = roster.find((x) => x.seat === seat && x.remote);
      if (!r || !r.f) return;
      r.remote = false; r.retT = 0;
      game.setPilot(r.f, 'ai', r.skill || 'medium');
      game.netRoster?.();
    },
    /** online host: a late joiner takes this seat (an AI's, or an empty one), score from 0, in the air at the farthest slot */
    toHuman(seat, p) {
      if (phase === 'over' || !online) return;
      let r = roster.find((x) => x.seat === seat);
      if (!r) { r = { f: null, seat, remote: true, name: p.name, color: p.color, skill: 'medium', kills: 0, deaths: 0, dead: false, deadT: 0, retT: 0, isMe: false }; roster.push(r); }
      r.remote = true; r.name = p.name; r.color = p.color; r.kills = 0; r.deaths = 0; r.dead = false; r.deadT = 0;
      const at = farthestSlot(r.f);
      if (r.f) { game.despawn(r.f); r.f = null; }
      spawn(r, at);
      game.respawnRemote(r.f, at);
      game.netRoster?.();
    },
  };

  // ---------------------------------------------------------------------------------- online client: a view of the host's match
  const V = online && online.view;
  function startClient() {
    removeBoard();
    roster.length = 0;
    slots = [];
    for (let k = 0; k < N; k++) slots.push(game.safeSpawn(k, N, ARENA_R));
    game.respawnMe(slots[online.mySeat] || slots[0]);   // the host's respawn message places me for real
    phase = 'count'; phaseT = 0; clock = MATCH; shownSec = shownPlace = shownKills = -1;
    game.weaponsOff = true;
    syncClient();
    banner();
    game.cards.show('round', { text: 'ONLINE CHAOS', sub: `Everyone vs everyone · most kills in ${Math.floor(MATCH / 60)}:${String(MATCH % 60).padStart(2, '0')}`, ms: COUNTDOWN * 1000 });
  }
  /** roster = the view's active seats (the same 8 objects, refreshed in place) */
  function syncClient() {
    roster.length = 0;
    for (const s of V.seats) {
      if (!s.active && !s.isMe) continue;
      const r = s.r || (s.r = { f: null, name: '', color: '', kills: 0, deaths: 0, isMe: false, seat: s.seat });
      r.f = s.isMe ? game.me : s.f; r.name = s.isMe ? game.me.name : s.name; r.color = s.isMe ? game.me.color : s.color;
      r.kills = s.kills; r.deaths = s.deaths; r.isMe = s.isMe;
      if (r.isMe) roster.unshift(r); else roster.push(r);
    }
  }
  function stepClient() {
    if (!V.have) return;
    syncClient();
    clock = V.clock;
    if (phase === 'count' && V.phase !== 'count') { game.weaponsOff = false; game.cards.show('round', { text: 'FIGHT!', ms: 900 }); }
    if (phase !== 'over') phase = V.phase === 'over' ? phase : V.phase;
    game.weaponsOff = phase === 'count';
    banner();
    if (V.phase === 'over' && phase !== 'over') end();
  }
  return mode;
}
