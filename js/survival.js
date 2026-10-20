/**
 * survival.js — endless waves vs AI (README "Modes contract"). Wave 1 = 1 easy, 2 = easy + medium, 3 = 2 medium,
 * 4 = medium, medium, hard, then more hards, at most 4 AIs at once (performance); each from game.safeSpawn, each after me.
 * Between waves a 4 s breather ("WAVE 3"): missiles, flares and gun rounds refilled, +30 % health (capped).
 * Score = my kills (banner "WAVE 3 · KILLS 5"). Shot down or crashed ends the run; the best kills are kept in localStorage.
 */
const BREATHER = 4, CLEAR_DELAY = 1.5, END_DELAY = 3, HEAL = 0.3, MAX_AI = 4, BEST_KEY = 'dogfight.survivalBest';

/** The skills of wave w (1-based). */
export function waveSkills(w) {
  if (w === 1) return ['easy'];
  if (w === 2) return ['easy', 'medium'];
  if (w === 3) return ['medium', 'medium'];
  if (w === 4) return ['medium', 'medium', 'hard'];
  const n = Math.min(MAX_AI, 3 + ((w - 4) >> 1)), hard = Math.min(n, w - 3);
  return Array.from({ length: n }, (_, k) => (k < n - hard ? 'medium' : 'hard'));
}

const readBest = () => { try { return +(localStorage.getItem(BEST_KEY) || 0) || 0; } catch { return 0; } };
const saveBest = (v) => { try { localStorage.setItem(BEST_KEY, String(v)); } catch { /* private mode: not kept */ } };

/** @param {object} game  README `game` object */
export function createSurvivalMode(game) {
  const wave = [];   // this wave's AI fighters
  let phase = 'breather', phaseT = 0, w = 0, kills = 0, bannerKey = '';

  function banner() {
    const key = `WAVE ${Math.max(1, w)} · KILLS ${kills}`;
    if (key !== bannerKey) { bannerKey = key; game.setBanner(key); }
  }

  /** The pause before wave w + 1: refills and heals me, shows the card. */
  function breather() {
    const me = game.me, T = game.combat.TUNE;
    for (const f of wave) game.despawn(f);
    wave.length = 0;
    if (w > 0) { me.missiles = T.missiles; me.flares = T.flareBursts; me.gunAmmo = T.gunAmmo; me.hp = Math.min(1, me.hp + HEAL); }
    phase = 'breather'; phaseT = 0;
    game.cards.show('round', { text: `WAVE ${w + 1}`, sub: w ? 'Missiles and flares refilled · +30 % health' : 'Survive as long as you can', ms: BREATHER * 1000 });
  }

  function anyAlive() { for (let k = 0; k < wave.length; k++) if (wave[k].alive) return true; return false; }

  function spawnWave() {
    w++;
    const skills = waveSkills(w), n = skills.length + 1;   // slot 0 is the player's (the run's start)
    skills.forEach((skill, k) => wave.push(game.spawnAI({ ...game.safeSpawn(k + 1, n), skill })));
    phase = 'fight'; phaseT = 0;
    banner();
  }

  const mode = {
    id: 'survival', title: 'Survival',
    powerups: { count: 4, dropEvery: 60 },
    get phase() { return phase; }, get wave() { return w; }, get kills() { return kills; },
    start() {
      w = 0; kills = 0; bannerKey = ''; wave.length = 0;
      game.respawnMe(game.safeSpawn(0, 5));
      banner();
      breather();
    },
    step(dt) {
      phaseT += dt;
      if (phase === 'breather' && phaseT >= BREATHER) spawnWave();
      else if (phase === 'fight' && !anyAlive()) { phase = 'cleared'; phaseT = 0; game.emit?.({ type: 'wave', n: w }); }
      else if (phase === 'cleared' && phaseT >= CLEAR_DELAY) breather();
      else if (phase === 'dead' && phaseT >= END_DELAY) {
        const best = readBest();
        if (kills > best) saveBest(kills);
        game.finish({ title: 'SHOT DOWN', sub: `${kills} kill${kills === 1 ? '' : 's'}, wave ${w}${kills > best ? ' · new best' : ` · best ${best}`}`, won: false });
      }
    },
    frame() {},
    onEvent(e) {
      if (e.type !== 'kill' || phase === 'dead') return;
      if (e.victim === game.me.id) { phase = 'dead'; phaseT = 0; return; }
      if (e.killer === game.me.id) { kills++; banner(); }
    },
    stop() {
      for (const f of wave) game.despawn(f);
      wave.length = 0; game.setBanner(null);
    },
  };
  return mode;
}
