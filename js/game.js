/**
 * game.js — the session (README "Modes contract"): engine loop glue, the fighter pool (up to 8 jets), views, HUD, radar,
 * sound, effects, combat, cards. A MODE (duel.js, survival.js, race.js, tutorial.js) is a small controller plugged into it.
 *
 *   const game = await createGame({ engine, world, menu, params, progress? });   // builds, warms up, runs the loop
 *   game.play(modeId) / game.resume() / game.quit() / game.applySettings(st)      // main.js wires the menu to these
 *
 * Per 120 Hz step (phase 'play'): ai.think (every AI fighter → f.target || me; with ?bot also me → nearest) → stepJet (each
 * fighter) → combat.step → mode.step → controls.consumeEdges. Rendering interpolates each jet between its last two steps.
 * Extras beyond the README object: game.weaponsOff (true = no weapons and no combat.step, e.g. a countdown), game.score
 * (the HUD's {me, enemy, round} line, or null), game.nearest (closest live other fighter to me; the HUD / sound "enemy").
 * A mode with weapons === false (the race) has gun / missile / flare input cleared every step.
 * Hooks (README "Hooks contract"), each optional and fenced by try/catch: hype.js (juice + announcer), progress.js / trails.js /
 * locker.js (XP, unlocks), powerups.js / powerupfx.js (pick-ups, supply drops; a mode opts in with `powerups`), chaos.js.
 * game.emit(e) sends a mode's own event (round / wave / ring) down the same stream as combat's.
 */
import * as THREE from 'three';
import { buildJet } from './jetmodel.js';
import { poseMatrix } from './jetspec.js';
import { createJet, stepJet, jetModelState } from './flight.js';
import { createControls } from './controls.js';
import { createChaseCam } from './chasecam.js';
import { createHud } from './hud.js';
import { createCockpitCam } from './cockpitcam.js';
import { buildPilot } from './pilot.js';
import { createSound } from './sound.js';
import { createCombat, RAIL_ORDER } from './combat.js';
import { createAI } from './ai.js';
import { createWeaponFx } from './weaponfx.js';
import { createCards } from './cards.js';
import { createDuelMode } from './duel.js';
import { createSurvivalMode } from './survival.js';

const $ = (id) => document.getElementById(id);
const PALETTE = ['#c8362c', '#2b62cf', '#e0a020', '#3a9d5a', '#8a4fd0', '#e7e7ea', '#2a2d33', '#e0663a'];
const AI_NAMES = ['Viper', 'Kestrel', 'Raptor', 'Talon', 'Ghost', 'Harrier', 'Osprey', 'Merlin'];
const POOL_MAX = 8;
const PREBUILD = 8;          // me + 7 AIs (Chaos) built behind the loading screen
const SPAWN_CLEAR = 600, SPAWN_RUN = 6000, SPAWN_SPEED = 230;

/** Loads an optional module's factory (race / tutorial / radar are written by other lanes); null if missing or broken. */
async function optional(path, name) {
  try { return (await import(path))[name] || null; } catch (e) { console.warn(`game: ${path} not loaded (${e?.message || e})`); return null; }
}

/**
 * Builds the session and starts the engine loop.
 * @param {{engine:object, world:object, menu:object, params:URLSearchParams, progress?:(frac:number, text?:string)=>void}} o
 * @returns {Promise<object>} the README `game` object plus play / resume / quit / applySettings
 */
export async function createGame({ engine, world, menu, params, progress = () => {} }) {
  const { scene, camera } = engine;
  const env = { terrainHeightAt: world.terrainHeightAt, playArea: world.playArea };
  const th = world.terrainHeightAt;
  const BOT = params.has('bot');   // test only: an AI flies the player's jet too (robot play-tests, screenshots)
  const seed0 = +(params.get('seed') || 7);

  const [createRaceMode, createTutorialMode, createRadar, createChaosMode, createHype, createProgress, createTrails, createLocker, createPowerups, createPowerupFx] = await Promise.all([
    optional('./race.js', 'createRaceMode'), optional('./tutorial.js', 'createTutorialMode'), optional('./radar.js', 'createRadar'),
    optional('./chaos.js', 'createChaosMode'), optional('./hype.js', 'createHype'), optional('./progress.js', 'createProgress'),
    optional('./trails.js', 'createTrails'), optional('./locker.js', 'createLocker'), optional('./powerups.js', 'createPowerups'),
    optional('./powerupfx.js', 'createPowerupFx')]);
  const MODES = { duel: createDuelMode, survival: createSurvivalMode, race: createRaceMode, tutorial: createTutorialMode, chaos: createChaosMode };

  progress(0.7, 'Rolling out the jets…');
  const controls = createControls({ canvas: $('stage') });
  const pool = [], fighters = [];
  /** Builds pool fighter #id (jet ~67K triangles + pilot); hidden and out of combat until spawned. */
  function buildFighter() {
    const id = pool.length, t0 = performance.now();
    const jet = buildJet(id, { screenLight: false });
    const pilot = buildPilot(jet, {});
    world.applyEnv(jet.group, 1);
    jet.group.visible = false;
    scene.add(jet.group);
    const ctl = id === 0 ? controls.ctl : { aim: [0, 0, -1], pitch: 0, roll: 0, yaw: 0, throttle: 0.84, ab: false, brake: false, gun: false, missile: false, flare: false };
    const f = {
      id, name: id === 0 ? 'You' : AI_NAMES[id % AI_NAMES.length], color: PALETTE[id % PALETTE.length], isAI: id !== 0, s: createJet(world.spawn), ctl,
      hp: 1, alive: false, target: null, jet, pilot, ai: null, prev: { pos: [0, 0, 0], q: [0, 0, 0, 1] }, pose: { pos: [0, 0, 0], q: [0, 0, 0, 1] }, model: { rails: [1, 1, 1, 1] },
    };
    pool.push(f);
    buildMs.push(Math.round(performance.now() - t0));
    return f;
  }
  const buildMs = [];
  for (let k = 0; k < PREBUILD; k++) buildFighter();
  console.info(`game: pool prebuilt ${PREBUILD} jets in ${buildMs.reduce((a, b) => a + b, 0)} ms (${buildMs.join(', ')})`);
  const me = pool[0];
  fighters.push(me);
  const glassSymbols = me.jet.group.getObjectByName('hud-symbols');   // the model's fake HUD picture: hidden while hud.js draws the real one

  const cam = createChaseCam(camera); cam.setEnv(env);
  const hud = createHud($('hud')); hud.setEnv(env);
  let radar = null;
  try { radar = createRadar ? createRadar($('hud')) : null; } catch (e) { console.warn('game: radar failed', e); }
  const cockpit = createCockpitCam(camera, { jet: me.jet });
  const sound = createSound();
  const cards = createCards(document.body);
  const wfx = createWeaponFx(scene, { buildMissile: me.jet.buildMissile, world });
  const combat = createCombat({ terrainHeightAt: th, seed: seed0, onEvent });
  combat.add(me);
  // ---- hooks (README "Hooks contract"): each one optional; a hook that throws is switched off, the game goes on
  const hooks = {};
  const hook = (name, fn) => { try { return fn(); } catch (e) { console.warn(`game: ${name} off`, e); hooks[name] = null; return undefined; } };
  hooks.hype = createHype && hook('hype', () => createHype(document.body, { sound }));
  hooks.prog = createProgress && hook('prog', () => createProgress());
  hooks.trails = createTrails && hook('trails', () => createTrails(scene, world));
  hooks.pu = createPowerups && hook('pu', () => createPowerups({ terrainHeightAt: th, playArea: world.playArea, seed: seed0, onEvent, combat }));
  hooks.pfx = createPowerupFx && hook('pfx', () => createPowerupFx(scene, world));
  hooks.locker = createLocker && hooks.prog && hook('locker', () => createLocker(document.body, hooks.prog, { onEquip: () => dressMe() }));
  const H = (name, fn) => { const h = hooks[name]; if (h) hook(name, () => fn(h)); };
  const byId = (id) => pool[id] || null;
  const hypeCtx = { meId: 0, byId, me: null, modeId: null };
  /** My jet wears what the locker has equipped (finish now; the trail style is set per spawn). */
  function dressMe() {
    const eq = hooks.prog?.state?.equipped || {};
    if (me.jet.finish) hook('finish', () => me.jet.finish(eq.finish || 'gloss'));
    H('trails', (tr) => tr.set(me, eq.trail || 'vapor'));
  }

  let phase = 'menu', resumePhase = 'play', mode = null, modeId = null, view = 'chase', t = 0, seedN = seed0 * 1000, stepping = false;
  const modeInst = {}, outOfCombat = [];
  const fight = { me, enemy: null, combat, score: null };
  if (params.get('view') === 'cockpit') controls.view = 'cockpit';
  const qa = new THREE.Quaternion(), qb = new THREE.Quaternion(), mat = new Array(16);
  // The model's HUD glass is only ~5% of the screen wide from the pilot's eye: the HUD is drawn over the glass,
  // grown upward to at least this size, so it stays readable (a game HUD, not a to-scale one).
  const HUD_MIN_W = 0.34, hudBox = { x: 0, y: 0, w: 0, h: 0 };

  /** A pooled fighter's fresh start: new JetState, combat reset, interpolation snapped, visible. */
  function place(f, { pos, heading, speed = SPAWN_SPEED }) {
    f.s = createJet({ pos, heading, speed });
    if (combat.fighters.includes(f)) combat.reset(f); else combat.add(f);
    f.prev.pos = f.s.pos.slice(); f.prev.q = f.s.q.slice();
    f.ctl.gun = f.ctl.missile = f.ctl.flare = false;
    f.ctl.aim[0] = Math.sin(heading); f.ctl.aim[1] = 0; f.ctl.aim[2] = -Math.cos(heading);
    f.ctl.throttle = 0.84; f.ctl.ab = false;
    f.shield = 0; f.s.boost = 0;
    f.jet.group.visible = true;
    H('trails', (tr) => tr.clear(f));
    placeJet(f, 1);
  }

  /** README: a pooled AI fighter joins the match (built on demand past the prebuilt pool). */
  function spawnAI({ pos, heading, speed = SPAWN_SPEED, skill = 'medium', name, color } = {}) {
    let f = pool.find((g) => g !== me && !fighters.includes(g));
    if (!f) {
      if (pool.length >= POOL_MAX) throw new Error(`game: no free jet (max ${POOL_MAX})`);
      f = buildFighter();
      console.info(`game: built jet #${f.id} on demand in ${buildMs[buildMs.length - 1]} ms`);
    }
    f.name = name || AI_NAMES[f.id % AI_NAMES.length];
    f.color = color || PALETTE.find((c) => c !== me.color && !fighters.some((g) => g.color === c)) || PALETTE[f.id % PALETTE.length];
    f.jet.paint(f.color);
    f.target = null;
    place(f, { pos, heading, speed });
    f.ai = createAI(f, { skill, env, combat, seed: ++seedN });
    H('trails', (tr) => tr.set(f, 'vapor'));
    fighters.push(f);
    return f;
  }

  /** README: back to the pool (hidden, out of combat). Safe from onEvent: combat's list is edited after its step. */
  function despawn(f) {
    if (f === me) return;
    const i = fighters.indexOf(f);
    if (i < 0) return;
    fighters.splice(i, 1);
    if (combat.fighters.includes(f)) combat.reset(f);   // its missiles, bullets, flares and the locks on it go
    f.alive = false; f.ai = null; f.target = null;
    f.jet.group.visible = false;
    if (stepping) outOfCombat.push(f); else dropFromCombat(f);
  }
  function dropFromCombat(f) { const k = combat.fighters.indexOf(f); if (k >= 0) combat.fighters.splice(k, 1); }

  /** README: fresh JetState + full hp / ammo for the player. */
  function respawnMe({ pos, heading, speed = SPAWN_SPEED }) {
    place(me, { pos, heading, speed });
    me.target = null;
    if (BOT) me.ai = createAI(me, { skill: 'hard', env, combat, seed: ++seedN });
    controls.reset(heading, 0); controls.ctl.throttle = 0.84;
    cam.snap();
    engine.calm();
  }

  /**
   * README: the i-th of n well-spread starts. Slots sit on a ring round the play area's middle, heading inward; each tries a
   * few angles and headings and keeps the lowest start that clears every ground sample of the next 6 km by 600 m.
   * Deterministic (no random numbers). ponytail: straight-line sampling only, a ridge just off the path is not checked.
   */
  function safeSpawn(i, n) {
    const pa = world.playArea, r = Math.min(pa.half * 0.55, 2500 + 1200 * n), top = pa.ceiling - 300;
    let best = null;
    for (const da of [0, -0.12, 0.12, -0.24, 0.24]) {
      const a = 0.7 + (2 * Math.PI * i) / Math.max(1, n) + da * (Math.PI / Math.max(2, n));
      const x = pa.cx + Math.sin(a) * r, z = pa.cz - Math.cos(a) * r, inward = Math.atan2(pa.cx - x, -(pa.cz - z));
      for (const dh of [0, -0.35, 0.35]) {
        const h = inward + dh, sx = Math.sin(h), sz = -Math.cos(h);
        let ground = -1e9;
        for (let d = 0; d <= SPAWN_RUN; d += 250) ground = Math.max(ground, th(x + sx * d, z + sz * d));
        const y = ground + SPAWN_CLEAR, score = y > top ? y + 1e5 : y;   // over the ceiling: only if nothing else fits
        if (!best || score < best.score) best = { score, pos: [x, Math.min(y, Math.max(top, ground + SPAWN_CLEAR)), z], heading: h, speed: SPAWN_SPEED };
      }
    }
    return { pos: best.pos, heading: best.heading, speed: best.speed };
  }

  const setBanner = (text) => { try { hud.setBanner?.(text); } catch (e) { console.warn('game: setBanner', e); } };

  /** README: ends the mode with a big card; Space plays it again, Esc goes to the menu. */
  function finish({ title, sub = '', won, place } = {}) {
    if (phase !== 'play') return;
    emit({ type: 'match', result: won === false ? 'lose' : won === null ? 'draw' : 'win', place, modeId });
    phase = 'finished';
    engine.timeScale = 1;
    cards.show(won === false ? 'lose' : 'win', { text: title, sub: `${sub ? `${sub} · ` : ''}Space: again · Esc: menu`, ms: 0 });
    H('prog', (pr) => { const sum = pr.matchEnd({ modeId, won: won !== false && won !== null }); H('locker', (lk) => lk.showResult(sum)); });
    engine.setBusy(false); engine.calm();
  }
  /** README: a mode's own event (round / wave / ring) into the same stream as combat's. */
  function emit(e) { e.t = t; onEvent(e); }

  /** Every combat event: HUD, sound, effects; a shot-down jet is hidden (a burst unless it hit the ground); then the mode. */
  function onEvent(e) {
    hud.onEvent(e, me.id); sound.onEvent(e, me.id); wfx.onEvent(e);
    H('hype', (hy) => hy.onEvent(e, hypeCtx));
    if (phase === 'play') H('prog', (pr) => pr.onEvent(e, me.id, modeId));
    if (e.type === 'kill') {
      const victim = pool[e.victim];
      if (victim) { victim.jet.group.visible = false; if (e.cause !== 'crash') wfx.burst(victim.s.pos, victim.s.vel, 3); }
    }
    if (mode && phase === 'play') mode.onEvent?.(e);
  }

  /** Writes a fighter's interpolated pose into its jet's matrix and control surfaces. */
  function placeJet(f, alpha) {
    const s = f.s, pose = f.pose, prev = f.prev;
    for (let i = 0; i < 3; i++) pose.pos[i] = prev.pos[i] + (s.pos[i] - prev.pos[i]) * alpha;
    qa.fromArray(prev.q); qb.fromArray(s.q); qa.slerp(qb, alpha); qa.toArray(pose.q);
    f.jet.group.matrix.fromArray(poseMatrix(pose.pos, pose.q, mat));
    f.jet.group.matrixWorldNeedsUpdate = true;
    jetModelState(s, f.model);
    for (let r = 0; r < 4; r++) f.model.rails[RAIL_ORDER[r]] = r < 4 - (f.missiles ?? 4) ? 0 : 1;   // fired rails show empty
    f.jet.setState(f.model);
  }

  /** The closest live fighter to me (the HUD / sound enemy, the ?bot target), or null. */
  function nearestToMe() {
    let best = null, bd = Infinity;
    for (let i = 1; i < fighters.length; i++) {
      const f = fighters[i];
      if (!f.alive) continue;
      const d = (f.s.pos[0] - me.s.pos[0]) ** 2 + (f.s.pos[1] - me.s.pos[1]) ** 2 + (f.s.pos[2] - me.s.pos[2]) ** 2;
      if (d < bd) { bd = d; best = f; }
    }
    return best;
  }

  function step(dt) {
    if (phase !== 'play') return;
    t += dt;
    for (const f of fighters) {
      const p = f.prev, s = f.s;
      p.pos[0] = s.pos[0]; p.pos[1] = s.pos[1]; p.pos[2] = s.pos[2];
      p.q[0] = s.q[0]; p.q[1] = s.q[1]; p.q[2] = s.q[2]; p.q[3] = s.q[3];
    }
    game.nearest = nearestToMe();
    for (let i = 1; i < fighters.length; i++) { const f = fighters[i]; if (f.ai) f.ai.think(dt, f.target || me); }
    if (BOT && me.ai) me.ai.think(dt, me.target && me.target.alive ? me.target : game.nearest);
    if (game.weaponsOff || mode.weapons === false) for (const f of fighters) f.ctl.gun = f.ctl.missile = f.ctl.flare = false;   // mode.weapons false: e.g. the race
    for (const f of fighters) if (f.alive && !f.s.crashed) stepJet(f.s, f.ctl, dt, env);
    if (!game.weaponsOff) {
      stepping = true; combat.step(dt); stepping = false;
      while (outOfCombat.length) dropFromCombat(outOfCombat.pop());
      if (game.powerups) H('pu', (pu) => pu.step(dt, fighters));
    }
    if (phase === 'play') mode.step(dt);
    controls.consumeEdges();
  }

  function frame(alpha, frameDt) {
    if (!BOT) controls.update(frameDt, me.s);   // with ?bot the AI owns me.ctl
    for (const f of fighters) { placeJet(f, alpha); f.pilot.update(f.model, f === me ? controls.look : null); }
    if (controls.view !== view) {
      view = controls.view;
      if (view === 'cockpit') cockpit.enter([me.pilot.head, glassSymbols]); else { cockpit.exit(); cam.snap(); }
    }
    if (view === 'cockpit') cockpit.update(frameDt, me.pose, controls.look, me.s);
    else cam.update(frameDt, me.pose, controls.ctl.aim, me.s, controls.look);
    if (phase !== 'menu') H('hype', (hy) => { hy.frame(frameDt, camera, me, view); engine.timeScale = phase === 'play' ? hy.slowmo : 1; });
    world.update(t, camera);
    wfx.update(frameDt, combat, camera);
    H('trails', (tr) => tr.update(frameDt, fighters, camera));
    H('pfx', (px) => px.update(frameDt, game.powerups, fighters, camera));
    if (mode && phase !== 'menu') mode.frame?.(frameDt);
    fight.enemy = game.nearest; fight.score = game.score; fight.noWeapons = !!mode && mode.weapons === false;
    hud.setMode(view, view === 'cockpit' ? hudRectFor() : undefined);
    hud.setFight(phase === 'menu' ? null : fight);
    hud.update(camera, me.pose, controls.ctl.aim, me.s);
    if (radar) try { radar.update(me, fighters, combat, world.playArea, camera, game.powerups?.items); } catch (e) { console.warn('game: radar.update', e); radar = null; }
    sound.setFight(fight);
    sound.update(camera, me.s, view);
  }

  /** The cockpit HUD box: on the model's glass, grown (upward) to a readable size. */
  function hudRectFor() {
    const r = cockpit.hudRect(innerWidth, innerHeight);
    if (!r) return undefined;
    const w = Math.max(r.w, innerWidth * HUD_MIN_W), h = Math.max(r.h, w * 0.55);
    hudBox.x = r.x + r.w / 2 - w / 2; hudBox.y = r.y + r.h - h; hudBox.w = w; hudBox.h = h;   // grows upward: never over the instrument panel
    return hudBox;
  }

  /** Leaves the current mode and clears the field (every AI back to the pool). */
  function stopMode() {
    if (mode) { try { mode.stop?.(); } catch (e) { console.error('game: mode.stop', e); } }
    while (fighters.length > 1) despawn(fighters[fighters.length - 1]);
    if (game.powerups) H('pu', (pu) => pu.stop());
    mode = null; game.mode = null; game.powerups = null;
    game.weaponsOff = false; game.score = null; game.nearest = null; engine.timeScale = 1;
    setBanner(null); cards.hide();
  }

  const showHud = (on) => { $('hud').classList.toggle('hidden', !on); try { radar?.setVisible(on); } catch { /* radar lane */ } };
  const lockPointer = () => { try { $('stage').requestPointerLock()?.catch?.(() => {}); } catch { /* refused: the canvas click retries */ } };

  /** Starts (or restarts) a mode by id; unknown or not-yet-written modes fall back to the duel. */
  function play(id = menu.profile.mode || 'duel') {
    stopMode();
    if (!MODES[id]) { console.warn(`game: mode '${id}' not available, playing duel`); id = 'duel'; }
    const p = menu.profile;
    me.name = p.name || 'You'; me.color = p.color || PALETTE[0]; me.jet.paint(me.color);
    modeId = id;
    mode = modeInst[id] ||= MODES[id](game);
    game.mode = mode;
    phase = 'play';
    hypeCtx.me = me; hypeCtx.modeId = id;
    H('hype', (hy) => hy.reset());
    H('prog', (pr) => pr.matchStart(id));
    dressMe();
    if (mode.powerups && hooks.pu) { game.powerups = hooks.pu; H('pu', (pu) => pu.start(mode.powerups)); }
    sound.start(); sound.pause(false);
    menu.show('none'); showHud(true);
    engine.setBusy(true);
    mode.start();
    cam.snap(); engine.calm();
    lockPointer();
  }
  function resume() { sound.pause(false); menu.show('none'); showHud(true); phase = resumePhase; engine.setBusy(phase === 'play'); lockPointer(); }
  /** Back to the start screen: the mode stops, my jet waits at the world spawn behind the menu. */
  function quit() {
    stopMode();
    phase = 'menu'; engine.setBusy(false);
    respawnMe(world.spawn);
    showHud(false); menu.show('start');
  }
  const applySettings = (st) => {
    controls.setSensitivity(0.0018 * st.sensitivity);
    controls.setInvertY(st.invertY);
    sound.setVolume(st.volume);
    world.setQuality(st.quality);
    H('hype', (hy) => hy.setVoice(st.voice !== false));
    $('fps').classList.toggle('hidden', !st.showFps);
  };

  const game = {
    world, scene, camera, env, combat, controls, hud, cards, sound, wfx, params, profile: menu.profile,
    me, fighters, spawnAI, despawn, respawnMe, safeSpawn, setBanner, finish, emit,
    get t() { return t; }, get phase() { return phase; },
    mode: null, nearest: null, weaponsOff: false, score: null, pool, powerups: null, hooks,
    play, resume, quit, applySettings,
    openLocker: () => H('locker', (lk) => lk.open()),
  };

  // ---- warm-up: the scene from a few angles, every pooled jet in view once (uploads its geometry), one of every weapon effect
  respawnMe(world.spawn);
  progress(0.85, 'Warming up…');
  const look = (heading, pitch) => () => {   // three's camera looks down -z; heading is clockwise from north (-z)
    camera.position.fromArray(me.s.pos);
    camera.rotation.set(pitch, -heading, 0, 'YXZ');
    camera.updateMatrixWorld();
    world.update(0, camera);
  };
  const h0 = world.spawn.heading;
  pool.forEach((f, k) => {
    if (f === me) return;
    f.s = createJet({ pos: [me.s.pos[0] + Math.sin(h0) * 60 * k, me.s.pos[1] + 8 * k, me.s.pos[2] - Math.cos(h0) * 60 * k], heading: h0, speed: 200 });
    f.prev.pos = f.s.pos.slice(); f.prev.q = f.s.q.slice(); placeJet(f, 1); f.jet.group.visible = true;
  });
  await engine.warmUp([0, 1, 2, 3].map((k) => look(k * Math.PI / 2, 0)).concat([look(0, -0.6), look(0, 0.5), () => { look(h0, 0)(); wfx.warmUp(camera); }]));
  for (const f of pool) if (f !== me) f.jet.group.visible = false;
  respawnMe(world.spawn);
  progress(1, 'Ready');

  $('loading').classList.add('hidden');
  applySettings(menu.settings);
  engine.onPerf = (st) => { if (menu.settings.showFps) $('fps').textContent = `${Math.round(st.fps)} fps`; };
  showHud(false);
  menu.show('start');
  const direct = params.get('mode');
  if (params.has('autoplay') || direct) play(direct || menu.profile.mode || 'duel');
  controls.onLockChange = (locked) => {
    if (locked || params.has('autoplay') || params.has('mode') || phase === 'menu' || phase === 'paused') return;
    if (phase === 'finished') { quit(); return; }
    resumePhase = phase; phase = 'paused';
    showHud(false); sound.pause(true); menu.show('pause'); engine.setBusy(false); engine.calm();
  };
  addEventListener('keydown', (e) => {
    if (phase !== 'finished') return;
    if (e.code === 'Space') { e.preventDefault(); play(modeId); }
    else if (e.code === 'Escape') quit();
  });

  window.__game = { engine, world, controls, menu, sound, combat, fighters, game, get mode() { return mode; }, get phase() { return phase; }, get state() { return me.s; } };
  window.__engine = engine; window.__ready = true;   // tools/perf.mjs reads these
  engine.run(step, frame);
  return game;
}
