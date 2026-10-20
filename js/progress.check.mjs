// node js/progress.check.mjs — progress.js in node with a fake storage: the level curve, unlocks, the daily pick, matchEnd, equip.
import assert from 'node:assert/strict';
import { createProgress, levelInfo, needFor, dailyFor, rankFor, ITEMS, KEY } from './progress.js';
import { POINTS } from './points.js';

const fakeStorage = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m }; };
const day = (s) => () => new Date(`${s}T12:00:00`);

// curve: quick early, slower later
assert.equal(needFor(1), 400); assert.ok(needFor(2) > needFor(1)); assert.ok(needFor(20) > 10 * needFor(1));
assert.equal(levelInfo(0).level, 1); assert.equal(levelInfo(399).level, 1); assert.equal(levelInfo(400).level, 2);
assert.equal(levelInfo(400).into, 0); assert.equal(levelInfo(-5).level, 1); assert.equal(levelInfo(NaN).level, 1);
let tot = 0; for (let L = 1; L < 10; L++) tot += needFor(L);
assert.equal(levelInfo(tot).level, 10);
assert.ok(tot > 12000 && tot < 25000, `level 10 at ${tot} XP (~20 matches)`);
assert.equal(rankFor(1), 'Rookie'); assert.equal(rankFor(4), 'Wingman'); assert.equal(rankFor(30), 'Mythic');

// every item id is unique per kind, free ones are the defaults, something unlocks at level 2
const ids = ITEMS.map((i) => i.kind + ':' + i.id); assert.equal(new Set(ids).size, ids.length);
assert.ok(ITEMS.some((i) => i.level === 2));

// daily: stable for a date, 3 distinct, changes across days
const a = dailyFor('2026-10-20'), b = dailyFor('2026-10-20');
assert.deepEqual(a, b); assert.equal(new Set(a.map((c) => c.id)).size, 3);
const weekIds = new Set(); for (let d = 1; d <= 28; d++) dailyFor(`2026-11-${String(d).padStart(2, '0')}`).forEach((c) => weekIds.add(c.id));
assert.ok(weekIds.size >= 8, 'the pool rotates');

// a fresh player: defaults, saved daily list
const st = fakeStorage();
const p = createProgress(st, { now: day('2026-10-20') });
assert.equal(p.state.level, 1); assert.equal(p.state.equipped.trail, 'vapor'); assert.equal(p.state.equipped.finish, 'gloss');
assert.deepEqual(p.state.unlocked.trails.sort(), ['none', 'vapor']);
assert.equal(p.state.daily.date, '2026-10-20'); assert.equal(p.state.daily.list.length, 3);
assert.ok(st.m.has(KEY));

// equip of a locked item refused, a free one accepted
assert.equal(p.equip('trail', 'galaxy'), false); assert.equal(p.equip('trail', 'nope'), false); assert.equal(p.equip('hat', 'vapor'), false);
assert.equal(p.equip('trail', 'none'), true); assert.equal(p.state.equipped.trail, 'none');

// a won duel: my events count, others' do not; one match is a level-up with an unlock
p.matchStart('duel');
const me = 0, ev = (o) => p.onEvent(o, me, 'duel');
for (let i = 0; i < 10; i++) ev({ type: 'gunHit', owner: me, target: 1 });
ev({ type: 'gunHit', owner: 1, target: me });            // not mine
ev({ type: 'missileHit', owner: me, target: 1 });
ev({ type: 'kill', killer: me, victim: 1, cause: 'gun', t: 10 });
ev({ type: 'kill', killer: me, victim: me, cause: 'crash', t: 11 });   // my own crash: no points
ev({ type: 'round', result: 'win' }); ev({ type: 'round', result: 'lose' });
const expectMatch = 10 * POINTS.gunHit + POINTS.missileHit + POINTS.kill + POINTS.roundWin;
const sum = p.matchEnd({ modeId: 'duel', won: true });
const bonus = sum.challenges.reduce((s, c) => s + c.xp, 0);
assert.equal(sum.xp, expectMatch + POINTS.played + POINTS.matchWin + bonus);
assert.equal(sum.before.level, 1); assert.equal(sum.before.xp, 0);
assert.equal(sum.after.xp, sum.xp); assert.ok(sum.levelUp, 'the first won match levels up');
assert.ok(sum.unlocked.some((u) => u.kind === 'trail' && u.id === 'neon'), 'level 2 unlocks the neon trail');
assert.equal(typeof sum.rank, 'string');
for (const k of ['xp', 'before', 'after', 'levelUp', 'rank', 'unlocked', 'challenges']) assert.ok(k in sum, k);
assert.equal(p.equip('trail', 'neon'), true);

// saved and reloaded the same day: same XP, equip kept, daily progress kept
const p2 = createProgress(st, { now: day('2026-10-20') });
assert.equal(p2.state.xp, p.state.xp); assert.equal(p2.state.equipped.trail, 'neon');
assert.deepEqual(p2.state.daily, p.state.daily);

// a challenge completes and pays once: force one into today's list
const st3 = fakeStorage();
st3.setItem(KEY, JSON.stringify({ xp: 0, equipped: {}, daily: { date: '2026-10-20', list: [{ id: 'missileHits', text: 'Land 3 missile hits', goal: 3, n: 0, done: false, xp: 200, paid: false }] } }));
const p3 = createProgress(st3, { now: day('2026-10-20') });
assert.equal(p3.state.daily.list[0].id, 'missileHits');
p3.matchStart('survival');
for (let i = 0; i < 3; i++) p3.onEvent({ type: 'missileHit', owner: 0, target: 2 }, 0, 'survival');
p3.onEvent({ type: 'wave', n: 1 }, 0, 'survival');
const s3 = p3.matchEnd({ modeId: 'survival', won: false });
assert.deepEqual(s3.challenges.map((c) => c.id), ['missileHits']);
assert.equal(s3.xp, 3 * POINTS.missileHit + POINTS.wave + POINTS.played + 200);
p3.matchStart('survival'); const s3b = p3.matchEnd({ modeId: 'survival', won: false });
assert.equal(s3b.challenges.length, 0, 'paid once'); assert.equal(s3b.xp, POINTS.played);

// a new day rolls the list
const p4 = createProgress(st3, { now: day('2026-10-21') });
assert.equal(p4.state.daily.date, '2026-10-21'); assert.deepEqual(p4.state.daily.list, dailyFor('2026-10-21'));

// a locked equip in storage falls back; broken storage still works in memory
const st5 = fakeStorage(); st5.setItem(KEY, JSON.stringify({ xp: 10, equipped: { trail: 'gold', finish: 'gold' } }));
const p5 = createProgress(st5, { now: day('2026-10-20') });
assert.equal(p5.state.equipped.trail, 'vapor'); assert.equal(p5.state.equipped.finish, 'gloss');
const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
const warn = console.warn; console.warn = () => {};
const p6 = createProgress(broken, { now: day('2026-10-20') }); p6.matchStart('race'); p6.onEvent({ type: 'ring', n: 1 }, 0, 'race');
assert.equal(p6.matchEnd({ modeId: 'race', won: true }).xp >= POINTS.ring + POINTS.played + POINTS.matchWin, true);
const p7 = createProgress(null, { now: day('2026-10-20') }); assert.equal(p7.state.level, 1);
console.warn = warn;

// matchEnd without matchStart (defensive) and events before matchStart are ignored
const p8 = createProgress(fakeStorage(), { now: day('2026-10-20') });
p8.onEvent({ type: 'kill', killer: 0, victim: 1 }, 0, 'duel');
assert.equal(p8.matchEnd({ modeId: 'duel', won: false }).xp >= POINTS.played, true);

console.log(`progress.check: ok (level 10 at ${tot} XP; first match +${sum.xp} XP -> level ${sum.after.level}, unlocked ${sum.unlocked.map((u) => u.name + ' ' + u.kind).join(', ')})`);
