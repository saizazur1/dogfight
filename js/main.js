/**
 * main.js — boots the game and glues the lanes together (README "Files and owners", "Phase 3 contract").
 *
 * Flow: loading screen → build engine, world, two jets with pilots → warm up shaders → start menu (menu.js) → match.
 * Match: best of 3 rounds against the AI. Each round: both jets spawn ~7 km apart facing each other, a 2 s countdown
 * (no weapons), the fight, then a round card; first to 2 round wins takes the match (Space plays again).
 * Every jet is a "fighter" record (README): the mouse (controls.js) or the AI (ai.js) only writes fighter.ctl, once per step.
 * Simulation: per 120 Hz step: ai.think → flight.stepJet (each fighter) → combat.step → controls.consumeEdges.
 * Rendering interpolates each jet between its last two steps. Views: V toggles chase / cockpit.
 */
import * as THREE from 'three';
import { createEngine } from './engine.js';
import { buildJetWorld } from './jetworld.js';
import { buildJet } from './jetmodel.js';
import { poseMatrix } from './jetspec.js';
import { createJet, stepJet, jetModelState } from './flight.js';
import { createControls } from './controls.js';
import { createChaseCam } from './chasecam.js';
import { createHud } from './hud.js';
import { createCockpitCam } from './cockpitcam.js';
import { buildPilot } from './pilot.js';
import { createMenu } from './menu.js';
import { createSound } from './sound.js';
import { createCombat, RAIL_ORDER } from './combat.js';
import { createAI } from './ai.js';
import { createWeaponFx } from './weaponfx.js';
import { createCards } from './cards.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const progress = (frac, text) => { $('loadBar').style.width = `${Math.round(frac * 100)}%`; if (text) $('loadText').textContent = text; };
const fail = (e) => { console.error(e); $('loadText').textContent = `Could not start: ${e?.message || e}`; $('loadText').style.color = '#ff4d3d'; };
addEventListener('unhandledrejection', (e) => fail(e.reason));

const PALETTE = ['#c8362c', '#2b62cf', '#e0a020', '#3a9d5a', '#8a4fd0', '#e7e7ea', '#2a2d33', '#e0663a'];
const AI_NAMES = ['Viper', 'Kestrel', 'Raptor', 'Talon', 'Ghost', 'Harrier'];
const COUNTDOWN = 2, ROUND_END = 4, ROUNDS_TO_WIN = 2, SPAWN_GAP = 7000;
const BOT = params.has('bot');   // test only: an AI flies the player's jet too (robot play-tests, screenshots)

try {
  await boot();
} catch (e) {
  fail(e);
}

/** Builds everything, then hands control to the engine's fixed-step loop. */
async function boot() {
  progress(0.05, 'Starting the engine…');
  const engine = await createEngine({ canvas: $('stage'), params });
  const { scene, camera, renderer } = engine;

  progress(0.15, 'Loading the mountains…');
  const world = await buildJetWorld(scene, renderer, { seed: +(params.get('seed') || 7) });
  engine.configure({ bloom: world.bloom, exposure: world.exposure, toneMapping: world.toneMapping });
  $('credit').textContent = world.credit || '';
  const env = { terrainHeightAt: world.terrainHeightAt, playArea: world.playArea };
  const th = world.terrainHeightAt;

  progress(0.7, 'Rolling out the jets…');
  const controls = createControls({ canvas: $('stage') });
  const fighters = [0, 1].map((id) => {
    const jet = buildJet(id, { screenLight: false });
    const pilot = buildPilot(jet, {});
    world.applyEnv(jet.group, 1);
    scene.add(jet.group);
    const ctl = id === 0 ? controls.ctl : { aim: [0, 0, -1], pitch: 0, roll: 0, yaw: 0, throttle: 0.84, ab: false, brake: false, gun: false, missile: false, flare: false };
    return {
      id, name: id === 0 ? 'You' : 'Viper', color: PALETTE[id], isAI: id === 1, s: null, ctl,
      jet, pilot, ai: null, prev: { pos: [0, 0, 0], q: [0, 0, 0, 1] }, pose: { pos: [0, 0, 0], q: [0, 0, 0, 1] }, model: { rails: [1, 1, 1, 1] },
    };
  });
  const [me, enemy] = fighters;
  const glassSymbols = me.jet.group.getObjectByName('hud-symbols');   // the model's fake HUD picture: hidden while hud.js draws the real one

  const cam = createChaseCam(camera); cam.setEnv(env);
  const hud = createHud($('hud')); hud.setEnv(env);
  const cockpit = createCockpitCam(camera, { jet: me.jet });
  const sound = createSound();
  const cards = createCards(document.body);
  const wfx = createWeaponFx(scene, { buildMissile: me.jet.buildMissile, world });
  const combat = createCombat({ terrainHeightAt: th, seed: +(params.get('seed') || 7), onEvent });
  for (const f of fighters) combat.add(f);
  sound.setFight({ me, enemy, combat });

  // ---- match state
  const match = { phase: 'menu', round: 0, phaseT: 0, skill: 'medium' };
  const score = { me: 0, enemy: 0, round: 1 };
  const fight = { me, enemy, combat, score };
  let view = 'chase', t = 0;
  if (params.get('view') === 'cockpit') controls.view = 'cockpit';
  const qa = new THREE.Quaternion(), qb = new THREE.Quaternion(), mat = new Array(16);
  // The model's HUD glass is only ~5% of the screen wide from the pilot's eye: the HUD is drawn over the glass,
  // grown upward to at least this size, so it stays readable (a game HUD, not a to-scale one).
  const HUD_MIN_W = 0.34, hudBox = { x: 0, y: 0, w: 0, h: 0 };

  /** Both jets ~7 km apart along the spawn valley, nose to nose, each well above the ground under it. */
  function spawnRound() {
    const sp = world.spawn, h = sp.heading, sx = Math.sin(h), sz = -Math.cos(h);
    const far = [sp.pos[0] + sx * SPAWN_GAP, 0, sp.pos[2] + sz * SPAWN_GAP];
    far[1] = Math.max(sp.pos[1], th(far[0], far[2]) + 700);
    const starts = [
      { pos: [sp.pos[0], Math.max(sp.pos[1], th(sp.pos[0], sp.pos[2]) + 500), sp.pos[2]], heading: h, speed: 230 },
      { pos: far, heading: h + Math.PI, speed: 230 },
    ];
    for (const f of fighters) {
      f.s = createJet(starts[f.id]);
      combat.reset(f);
      f.prev.pos = f.s.pos.slice(); f.prev.q = f.s.q.slice();
      f.jet.group.visible = true;
      f.ctl.gun = f.ctl.missile = f.ctl.flare = false;
      if (f.isAI || (f === me && BOT)) f.ai = createAI(f, { skill: f === me ? 'hard' : match.skill, env, combat, seed: match.round * 101 + 7 + f.id });
      placeJet(f, 1);
    }
    controls.reset(h, 0); controls.ctl.throttle = 0.84;
    cam.snap();
    engine.calm();
  }

  function startMatch() {
    const p = menu.profile;
    match.skill = p.skill || 'medium';
    me.name = p.name || 'You'; me.color = p.color || PALETTE[0];
    enemy.color = PALETTE.find((c) => c !== me.color);
    enemy.name = AI_NAMES[(Date.now() / 1000 | 0) % AI_NAMES.length];   // the HUD adds "(AI)"
    me.jet.paint(me.color); enemy.jet.paint(enemy.color);
    score.me = score.enemy = 0; match.round = 0;
    nextRound();
  }

  function nextRound() {
    match.round++; score.round = match.round;
    spawnRound();
    match.phase = 'count'; match.phaseT = 0;
    cards.show('round', { text: `ROUND ${match.round}`, sub: 'Get ready', ms: COUNTDOWN * 1000 });
  }

  /** Every combat event goes to the HUD, sound and effects; a kill ends the round. */
  function onEvent(e) {
    hud.onEvent(e, me.id); sound.onEvent(e, me.id); wfx.onEvent(e);
    if (e.type !== 'kill' || match.phase !== 'fight') return;
    const victim = fighters[e.victim];
    victim.jet.group.visible = false;
    if (e.cause !== 'crash') wfx.burst(victim.s.pos, victim.s.vel, 3);
    match.phase = 'over'; match.phaseT = 0;
    if (me.alive && !enemy.alive) { score.me++; cards.show('roundWin', { text: 'ROUND WON', sub: e.cause === 'crash' ? 'They hit the mountain' : 'Splash one', ms: ROUND_END * 1000 }); }
    else if (enemy.alive && !me.alive) { score.enemy++; cards.show('roundLose', { text: 'SHOT DOWN', sub: e.cause === 'crash' ? 'You hit the mountain' : `By ${enemy.name}`, ms: ROUND_END * 1000 }); }
    else cards.show('round', { text: 'DRAW', sub: 'Nobody scores', ms: ROUND_END * 1000 });
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

  function step(dt) {
    t += dt;
    const ph = match.phase;
    if (ph === 'menu' || ph === 'paused' || ph === 'match') return;
    match.phaseT += dt;
    for (const f of fighters) {
      const p = f.prev, s = f.s;
      p.pos[0] = s.pos[0]; p.pos[1] = s.pos[1]; p.pos[2] = s.pos[2];
      p.q[0] = s.q[0]; p.q[1] = s.q[1]; p.q[2] = s.q[2]; p.q[3] = s.q[3];
    }
    if (enemy.alive && me.alive) { enemy.ai.think(dt, me); if (BOT) me.ai.think(dt, enemy); }
    if (ph === 'count') for (const f of fighters) f.ctl.gun = f.ctl.missile = f.ctl.flare = false;   // no weapons before "Fight!"
    for (const f of fighters) if (f.alive && !f.s.crashed) stepJet(f.s, f.ctl, dt, env);
    if (ph !== 'count') combat.step(dt);
    controls.consumeEdges();
    if (ph === 'count' && match.phaseT >= COUNTDOWN) { match.phase = 'fight'; match.phaseT = 0; cards.show('round', { text: 'FIGHT!', ms: 900 }); engine.setBusy(true); }
    if (ph === 'over' && match.phaseT >= ROUND_END) {
      engine.setBusy(false);
      if (score.me >= ROUNDS_TO_WIN || score.enemy >= ROUNDS_TO_WIN) {
        match.phase = 'match';
        const won = score.me > score.enemy;
        cards.show(won ? 'win' : 'lose', { text: won ? 'YOU WIN' : 'YOU LOSE', sub: `${score.me} – ${score.enemy} · Press Space to play again` });
        engine.calm();
      } else nextRound();
    }
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
    world.update(t, camera);
    wfx.update(frameDt, combat, camera);
    hud.setMode(view, view === 'cockpit' ? hudRectFor() : undefined);
    hud.setFight(match.phase === 'menu' ? null : fight);
    hud.update(camera, me.pose, controls.ctl.aim, me.s);
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

  spawnRound();

  // ---- warm-up: the scene from a few angles plus one of every weapon effect, behind the loading screen
  progress(0.85, 'Warming up…');
  const look = (heading, pitch) => () => {   // three's camera looks down -z; heading is clockwise from north (-z)
    camera.position.fromArray(me.s.pos);
    camera.rotation.set(pitch, -heading, 0, 'YXZ');
    camera.updateMatrixWorld();
    world.update(0, camera);
  };
  await engine.warmUp([0, 1, 2, 3].map((k) => look(k * Math.PI / 2, 0)).concat([look(0, -0.6), look(0, 0.5), () => { look(world.spawn.heading, 0)(); wfx.warmUp(camera); }]));
  spawnRound();
  progress(1, 'Ready');

  $('loading').classList.add('hidden');
  const showHud = (on) => $('hud').classList.toggle('hidden', !on);   // the menu sits over the live scene, without the flight HUD
  const lockPointer = () => { try { $('stage').requestPointerLock()?.catch?.(() => {}); } catch { /* refused: the canvas click retries */ } };
  const applySettings = (st) => {
    controls.setSensitivity(0.0018 * st.sensitivity);
    controls.setInvertY(st.invertY);
    sound.setVolume(st.volume);
    world.setQuality(st.quality);
    $('fps').classList.toggle('hidden', !st.showFps);
  };
  let resumePhase = 'fight';
  const menu = createMenu($('menu'), {
    onPlay: () => { sound.start(); sound.pause(false); menu.show('none'); showHud(true); startMatch(); lockPointer(); },
    onResume: () => { sound.pause(false); menu.show('none'); showHud(true); match.phase = resumePhase; lockPointer(); },
    onQuit: () => { match.phase = 'menu'; cards.hide(); engine.setBusy(false); spawnRound(); showHud(false); menu.show('start'); },
    onChange: applySettings,
  });
  applySettings(menu.settings);
  engine.onPerf = (st) => { if (menu.settings.showFps) $('fps').textContent = `${Math.round(st.fps)} fps`; };
  showHud(false);
  menu.show('start');
  if (params.has('autoplay')) { menu.show('none'); showHud(true); startMatch(); }
  controls.onLockChange = (locked) => {
    if (locked || params.has('autoplay') || match.phase === 'menu' || match.phase === 'paused') return;
    resumePhase = match.phase; match.phase = 'paused';
    showHud(false); sound.pause(true); menu.show('pause'); engine.calm();
  };
  addEventListener('keydown', (e) => {
    if (e.code === 'Space' && match.phase === 'match') { e.preventDefault(); cards.hide(); startMatch(); }
  });

  window.__game = { engine, world, controls, menu, sound, combat, fighters, match, get state() { return me.s; } };
  window.__engine = engine; window.__ready = true;   // tools/perf.mjs reads these
  engine.run(step, frame);
}
