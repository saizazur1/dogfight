/**
 * duel.js — the 1-on-1 vs AI mode (README "Modes contract"): best of 3 rounds, 2-minute rounds.
 * Each round: both jets at two safeSpawn starts (sides swap every round), a 2 s countdown with weapons off, the fight with a
 * "1:42" banner. A kill (or a crash) ends the round; at 0:00 the jet with more health takes it; equal (or both down) is a
 * draw and the round is flown again. First to 2 round wins takes the match (game.finish: Space plays again).
 */
const COUNTDOWN = 2, ROUND_END = 4, ROUNDS_TO_WIN = 2, ROUND_S = 120, HP_EPS = 0.005;
const AI_NAMES = ['Viper', 'Kestrel', 'Raptor', 'Talon', 'Ghost', 'Harrier'];

/** @param {object} game  README `game` object */
export function createDuelMode(game) {
  const score = { me: 0, enemy: 0, round: 1 };
  let enemy = null, enemyName = '', phase = 'count', phaseT = 0, round = 0, clock = ROUND_S, shownSec = -1;

  function nextRound(replay = false) {
    if (!replay) round++;
    score.round = round;
    if (enemy) game.despawn(enemy);
    const swap = round % 2 === 0, a = game.safeSpawn(swap ? 1 : 0, 2), b = game.safeSpawn(swap ? 0 : 1, 2);
    game.respawnMe(a);
    enemy = game.spawnAI({ ...b, skill: game.profile.skill || 'medium', name: enemyName });
    phase = 'count'; phaseT = 0; clock = ROUND_S; shownSec = -1;
    game.weaponsOff = true;
    banner();
    game.cards.show('round', { text: replay ? `ROUND ${round} · AGAIN` : `ROUND ${round}`, sub: 'Get ready', ms: COUNTDOWN * 1000 });
  }

  /** The countdown line, rewritten only when the shown second changes. */
  function banner() {
    const sec = Math.ceil(Math.max(0, clock));
    if (sec === shownSec) return;
    shownSec = sec;
    game.setBanner(`${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`);
  }

  /** won: true = me, false = the AI, null = draw (replayed). */
  function endRound(won, sub) {
    phase = 'over'; phaseT = 0;
    if (won === true) { score.me++; game.cards.show('roundWin', { text: 'ROUND WON', sub, ms: ROUND_END * 1000 }); }
    else if (won === false) { score.enemy++; game.cards.show('roundLose', { text: 'ROUND LOST', sub, ms: ROUND_END * 1000 }); }
    else { phase = 'draw'; game.cards.show('round', { text: 'DRAW', sub: sub || 'Nobody scores · the round is flown again', ms: ROUND_END * 1000 }); }
  }

  const mode = {
    id: 'duel', title: 'Duel',
    get phase() { return phase; }, get round() { return round; }, get clock() { return clock; }, score,
    start() {
      score.me = score.enemy = 0; round = 0;
      enemyName = AI_NAMES[(Date.now() / 1000 | 0) % AI_NAMES.length];   // the HUD adds "(AI)"
      game.score = score;
      nextRound();
    },
    step(dt) {
      phaseT += dt;
      if (phase === 'count' && phaseT >= COUNTDOWN) {
        phase = 'fight'; phaseT = 0; game.weaponsOff = false;
        game.cards.show('round', { text: 'FIGHT!', ms: 900 });
      } else if (phase === 'fight') {
        clock -= dt;
        banner();
        if (clock <= 0) {
          const d = game.me.hp - enemy.hp;
          endRound(Math.abs(d) < HP_EPS ? null : d > 0, Math.abs(d) < HP_EPS ? 'Time · equal health · the round is flown again' : 'Time · more health wins');
        }
      } else if ((phase === 'over' || phase === 'draw') && phaseT >= ROUND_END) {
        if (score.me >= ROUNDS_TO_WIN || score.enemy >= ROUNDS_TO_WIN) {
          const won = score.me > score.enemy;
          game.finish({ title: won ? 'YOU WIN' : 'YOU LOSE', sub: `${score.me} – ${score.enemy}`, won });
        } else nextRound(phase === 'draw');
      }
    },
    frame() {},
    /** A kill in the fight ends the round (both down = a draw). */
    onEvent(e) {
      if (e.type !== 'kill' || phase !== 'fight') return;
      const me = game.me;
      if (me.alive && !enemy.alive) endRound(true, e.cause === 'crash' ? 'They hit the mountain' : 'Splash one');
      else if (enemy.alive && !me.alive) endRound(false, e.cause === 'crash' ? 'You hit the mountain' : `Shot down by ${enemy.name}`);
      else endRound(null, 'Both down · the round is flown again');
    },
    stop() {
      if (enemy) game.despawn(enemy);
      enemy = null; game.score = null; game.weaponsOff = false; game.setBanner(null);
    },
  };
  return mode;
}
