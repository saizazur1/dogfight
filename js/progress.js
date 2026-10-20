/**
 * progress.js — the "one more match" loop (README "Hooks contract", lane UNLOCKS): XP, levels, ranks, daily challenges and the
 * cosmetic unlocks (wingtip trails, paint finishes). Pure: no DOM, no Three.js; progress.check.mjs runs it in node.
 *
 *   const prog = createProgress(storage = localStorage, { now? });   // now() -> Date (tests pin the day)
 *   prog.state        { xp, level, rank, equipped:{trail, finish}, unlocked:{trails:[], finishes:[]}, daily:{date, list:[{id,text,goal,n,done,xp,paid}]} }
 *   prog.matchStart(modeId)                 a new match: the per-match XP counter starts at 0
 *   prog.onEvent(e, meId, modeId)           MY points (POINTS) + daily-challenge counters
 *   prog.matchEnd({ modeId, won }) -> { xp, before:{level,xp,into,need}, after:{...}, levelUp, rank, rankUp, unlocked:[{kind,id,name}], challenges:[{id,text,xp}] }
 *   prog.equip('trail'|'finish', id) -> bool   (refuses unknown / locked items)
 *   prog.levelInfo(xp) -> { level, into, need, frac }    prog.ITEMS, prog.RANKS, prog.refresh() (rolls the daily list at midnight)
 *
 * Level curve: level L -> L+1 needs 400 + 200(L-1) + 25(L-1)^2 XP (400, 625, 900, 1225 …): a first match (~400-1000 XP) is a
 * level-up, level 10 is ~20 matches, level 20 ~100. Every save / load is try/catch: without storage it still works (in memory).
 */
import { POINTS } from './points.js';

export const KEY = 'dogfight.progress.v1';
export const MAX_LEVEL = 99;

/** Ranks by the level they start at (clean names, no trademarks). */
export const RANKS = Object.freeze([
  { level: 1, name: 'Rookie' }, { level: 4, name: 'Wingman' }, { level: 8, name: 'Hotshot' },
  { level: 12, name: 'Ace' }, { level: 18, name: 'Sky Legend' }, { level: 25, name: 'Mythic' },
]);

/** Every cosmetic: level 1 = free. One unlock per level from 2 to 8, then spaced out. */
export const ITEMS = Object.freeze([
  { kind: 'trail', id: 'vapor', name: 'Vapour', level: 1 },
  { kind: 'trail', id: 'none', name: 'No trail', level: 1 },
  { kind: 'finish', id: 'gloss', name: 'Gloss', level: 1 },
  { kind: 'trail', id: 'neon', name: 'Neon', level: 2 },
  { kind: 'finish', id: 'matte', name: 'Matte', level: 3 },
  { kind: 'trail', id: 'rainbow', name: 'Rainbow', level: 4 },
  { kind: 'finish', id: 'pearl', name: 'Pearl', level: 5 },
  { kind: 'trail', id: 'fire', name: 'Fire', level: 6 },
  { kind: 'finish', id: 'chrome', name: 'Chrome', level: 7 },
  { kind: 'trail', id: 'ice', name: 'Ice', level: 8 },
  { kind: 'finish', id: 'neon', name: 'Neon glow', level: 10 },
  { kind: 'trail', id: 'galaxy', name: 'Galaxy', level: 12 },
  { kind: 'finish', id: 'gold', name: 'Gold', level: 15 },
  { kind: 'trail', id: 'gold', name: 'Gold', level: 20 },
].map(Object.freeze));

/** The daily pool. count(e, me, modeId, m) -> how much this event adds (m = per-match scratch); end: counted at matchEnd. */
const CHALLENGES = [
  { id: 'gunKills', text: 'Get 3 gun kills', goal: 3, xp: 200, count: (e, me) => (e.type === 'kill' && e.killer === me && e.victim !== me && e.cause === 'gun' ? 1 : 0) },
  { id: 'winDuel', text: 'Win a duel', goal: 1, xp: 300, end: (r) => (r.modeId === 'duel' && r.won ? 1 : 0) },
  { id: 'rings', text: 'Pass 20 rings', goal: 20, xp: 200, count: (e) => (e.type === 'ring' ? 1 : 0) },
  { id: 'pickups', text: 'Grab 5 power-ups', goal: 5, xp: 200, count: (e, me) => (e.type === 'pickup' && e.owner === me ? 1 : 0) },
  { id: 'wave4', text: 'Reach wave 4', goal: 4, xp: 250, reach: (e) => (e.type === 'wave' ? (e.n | 0) + 1 : 0) },
  { id: 'double', text: 'Get a double kill', goal: 1, xp: 250, count: (e, me, mode, m) => {
    if (e.type !== 'kill' || e.killer !== me || e.victim === me) return 0;
    const dbl = e.t - m.lastKill <= 4; m.lastKill = e.t; return dbl ? 1 : 0;
  } },
  { id: 'chaosKills', text: 'Get 5 kills in Chaos', goal: 5, xp: 250, count: (e, me, mode) => (mode === 'chaos' && e.type === 'kill' && e.killer === me && e.victim !== me ? 1 : 0) },
  { id: 'missileHits', text: 'Land 3 missile hits', goal: 3, xp: 200, count: (e, me) => (e.type === 'missileHit' && e.owner === me ? 1 : 0) },
  { id: 'kills10', text: 'Shoot down 10 jets', goal: 10, xp: 300, count: (e, me) => (e.type === 'kill' && e.killer === me && e.victim !== me ? 1 : 0) },
  { id: 'play3', text: 'Play 3 matches', goal: 3, xp: 150, end: () => 1 },
  { id: 'win2', text: 'Win 2 matches', goal: 2, xp: 250, end: (r) => (r.won ? 1 : 0) },
];
const BY_ID = Object.fromEntries(CHALLENGES.map((c) => [c.id, c]));

/** XP to go from level L to L+1. */
export const needFor = (L) => 400 + 200 * (L - 1) + 25 * (L - 1) * (L - 1);

/** Total XP -> { level, into (XP inside this level), need (this level's size), frac 0..1 }. */
export function levelInfo(xp) {
  let L = 1, rest = Math.max(0, Math.floor(xp) || 0);
  while (L < MAX_LEVEL && rest >= needFor(L)) { rest -= needFor(L); L++; }
  const need = needFor(L);
  return { level: L, into: rest, need, frac: L >= MAX_LEVEL ? 1 : rest / need };
}
export const rankFor = (level) => RANKS.reduce((r, k) => (level >= k.level ? k.name : r), RANKS[0].name);

/** Local date as 'YYYY-MM-DD'. */
const dayOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** 3 distinct challenges for a date, the same for everyone that day (string hash -> small LCG). */
export function dailyFor(date) {
  let h = 2166136261;
  for (let i = 0; i < date.length; i++) h = Math.imul(h ^ date.charCodeAt(i), 16777619) >>> 0;
  const pool = CHALLENGES.map((c) => c.id), out = [];
  while (out.length < 3) {
    h = (Math.imul(h, 1664525) + 1013904223) >>> 0;
    out.push(pool.splice((h >>> 8) % pool.length, 1)[0]);
  }
  return out.map((id) => { const c = BY_ID[id]; return { id, text: c.text, goal: c.goal, n: 0, done: false, xp: c.xp, paid: false }; });
}

const itemsUpTo = (kind, level) => ITEMS.filter((i) => i.kind === kind && i.level <= level).map((i) => i.id);

/**
 * @param {{getItem:(k:string)=>string|null, setItem:(k:string,v:string)=>void}|null} [storage]
 * @param {{now?:()=>Date}} [opts]
 */
export function createProgress(storage = globalThis.localStorage, { now = () => new Date() } = {}) {
  let saved = null;
  try { saved = JSON.parse(storage?.getItem(KEY) || 'null'); } catch (e) { console.warn('progress: could not read', e); }
  const state = {
    xp: Math.max(0, Number(saved?.xp) || 0), level: 1, rank: RANKS[0].name,
    equipped: { trail: 'vapor', finish: 'gloss', ...(saved?.equipped || {}) },
    unlocked: { trails: [], finishes: [] },
    daily: saved?.daily && Array.isArray(saved.daily.list) ? saved.daily : { date: '', list: [] },
  };
  let match = null;   // per-match scratch: { modeId, xp, lastKill }

  /** Level, rank and the unlock lists follow the XP (so an item added later unlocks for everyone already past its level). */
  function derive() {
    state.level = levelInfo(state.xp).level;
    state.rank = rankFor(state.level);
    state.unlocked.trails = itemsUpTo('trail', state.level);
    state.unlocked.finishes = itemsUpTo('finish', state.level);
    if (!state.unlocked.trails.includes(state.equipped.trail)) state.equipped.trail = 'vapor';
    if (!state.unlocked.finishes.includes(state.equipped.finish)) state.equipped.finish = 'gloss';
  }
  /** A new local day: a new list (yesterday's progress goes). Returns true when it rolled. */
  function refresh() {
    const d = dayOf(now());
    if (state.daily.date === d && state.daily.list.every((c) => BY_ID[c.id])) return false;
    state.daily = { date: d, list: dailyFor(d) };
    return true;
  }
  function save() {
    try { storage?.setItem(KEY, JSON.stringify({ xp: state.xp, equipped: state.equipped, daily: state.daily })); } catch (e) { console.warn('progress: could not save', e); }
  }
  /** Adds to a challenge counter; marks it done at its goal. */
  function bump(c, add, reach = 0) {
    if (c.done) return;
    c.n = reach ? Math.max(c.n, reach) : c.n + add;
    if (c.n >= c.goal) { c.n = c.goal; c.done = true; }
  }

  derive();
  if (refresh()) save();

  function matchStart(modeId) { refresh(); match = { modeId, xp: 0, lastKill: -1e9 }; }

  function onEvent(e, meId, modeId) {
    if (!e || !match) return;
    const mine = (k) => e[k] === meId;
    let add = 0;
    switch (e.type) {
      case 'gunHit': if (mine('owner')) add = POINTS.gunHit; break;
      case 'missileHit': if (mine('owner')) add = POINTS.missileHit; break;
      case 'kill': if (mine('killer') && e.victim !== meId) add = POINTS.kill; break;
      case 'pickup': if (mine('owner')) add = POINTS.pickup; break;
      case 'ring': add = POINTS.ring; break;
      case 'wave': add = POINTS.wave; break;
      case 'round': if (e.result === 'win') add = POINTS.roundWin; break;
      default: break;
    }
    match.xp += add;
    for (const c of state.daily.list) {
      const def = BY_ID[c.id];
      if (!def || c.done) continue;
      if (def.count) { const k = def.count(e, meId, modeId ?? match.modeId, match); if (k) bump(c, k); }
      else if (def.reach) { const r = def.reach(e); if (r) bump(c, 0, r); }
    }
  }

  function matchEnd({ modeId, won } = {}) {
    const m = match || { modeId, xp: 0 };
    match = null;
    const b = levelInfo(state.xp), before = { level: b.level, xp: state.xp, into: b.into, need: b.need };
    const rank0 = state.rank;
    const haveKind = { trail: new Set(state.unlocked.trails), finish: new Set(state.unlocked.finishes) };
    let gained = m.xp + POINTS.played + (won ? POINTS.matchWin : 0);
    const challenges = [];
    for (const c of state.daily.list) {
      const def = BY_ID[c.id];
      if (def?.end && !c.done) bump(c, def.end({ modeId: modeId ?? m.modeId, won: !!won }));
      if (c.done && !c.paid) { c.paid = true; gained += c.xp; challenges.push({ id: c.id, text: c.text, xp: c.xp }); }
    }
    state.xp += gained;
    derive();
    save();
    const a = levelInfo(state.xp);
    const unlocked = ITEMS.filter((i) => i.level <= state.level && !haveKind[i.kind].has(i.id)).map(({ kind, id, name }) => ({ kind, id, name }));
    return {
      xp: gained, before, after: { level: a.level, xp: state.xp, into: a.into, need: a.need },
      levelUp: a.level > before.level, rank: state.rank, rankUp: state.rank !== rank0, unlocked, challenges,
    };
  }

  function equip(kind, id) {
    const list = kind === 'trail' ? state.unlocked.trails : kind === 'finish' ? state.unlocked.finishes : null;
    if (!list || !list.includes(id)) return false;
    state.equipped[kind] = id;
    save();
    return true;
  }

  return { state, matchStart, onEvent, matchEnd, equip, refresh, levelInfo, ITEMS, RANKS, KEY };
}
