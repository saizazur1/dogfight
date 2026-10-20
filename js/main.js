/**
 * main.js — boots the game and glues the lanes together (README "Files and owners").
 *
 * Flow: loading screen → build engine, world, jet and pilot → warm up shaders → start menu (menu.js) → fly.
 * Views: V toggles the chase camera (chasecam.js) and the cockpit (cockpitcam.js); the HUD follows (hud.setMode).
 * Simulation: flight.stepJet at a fixed 120 Hz (engine.run); rendering interpolates between the last two steps.
 * A crash (the HUD shows CRASHED) waits 2 s, then respawns at world.spawn (a calm moment for the adaptive resolution).
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

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const progress = (frac, text) => { $('loadBar').style.width = `${Math.round(frac * 100)}%`; if (text) $('loadText').textContent = text; };
const fail = (e) => { console.error(e); $('loadText').textContent = `Could not start: ${e?.message || e}`; $('loadText').style.color = '#ff4d3d'; };
addEventListener('unhandledrejection', (e) => fail(e.reason));

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

  progress(0.7, 'Rolling out the jet…');
  const jet = buildJet(0, { screenLight: false });
  const pilot = buildPilot(jet, {});
  world.applyEnv(jet.group, 1);
  const glassSymbols = jet.group.getObjectByName('hud-symbols');   // the model's fake HUD picture: hidden while hud.js draws the real one
  scene.add(jet.group);

  const env = { terrainHeightAt: world.terrainHeightAt, playArea: world.playArea };
  const controls = createControls({ canvas: $('stage') });
  const cam = createChaseCam(camera); cam.setEnv(env);
  const hud = createHud($('hud')); hud.setEnv(env);
  const cockpit = createCockpitCam(camera, { jet });
  const sound = createSound();
  let view = 'chase';
  if (params.get('view') === 'cockpit') controls.view = 'cockpit';
  // The model's HUD glass is only ~5% of the screen wide from the pilot's eye: the HUD is drawn over the glass's centre
  // but at least this big, so it stays readable (a game HUD, not a to-scale one).
  const HUD_MIN_W = 0.34, hudBox = { x: 0, y: 0, w: 0, h: 0 };

  // ---- state: the sim (s), the previous step (for interpolation) and the drawn pose
  let s;
  const prev = { pos: [0, 0, 0], q: [0, 0, 0, 1] };
  const pose = { pos: [0, 0, 0], q: [0, 0, 0, 1] };
  const qa = new THREE.Quaternion(), qb = new THREE.Quaternion();
  const modelState = {};
  const mat = new Array(16);
  let crashTimer = 0, playing = false, t = 0;

  function spawn() {
    const sp = world.spawn;
    s = createJet({ pos: sp.pos.slice(), heading: sp.heading, speed: sp.speed });
    prev.pos = s.pos.slice(); prev.q = s.q.slice();
    controls.reset(sp.heading, 0);
    crashTimer = 0;
    placeJet(1);
    cam.snap();
    engine.calm();
  }

  /** Writes the interpolated pose into the jet's matrix and its control surfaces. */
  function placeJet(alpha) {
    for (let i = 0; i < 3; i++) pose.pos[i] = prev.pos[i] + (s.pos[i] - prev.pos[i]) * alpha;
    qa.fromArray(prev.q); qb.fromArray(s.q); qa.slerp(qb, alpha); qa.toArray(pose.q);
    jet.group.matrix.fromArray(poseMatrix(pose.pos, pose.q, mat));
    jet.group.matrixWorldNeedsUpdate = true;
    jet.setState(jetModelState(s, modelState));
  }

  function step(dt) {
    t += dt;
    if (!playing) return;
    prev.pos[0] = s.pos[0]; prev.pos[1] = s.pos[1]; prev.pos[2] = s.pos[2];
    prev.q[0] = s.q[0]; prev.q[1] = s.q[1]; prev.q[2] = s.q[2]; prev.q[3] = s.q[3];
    if (s.crashed) {
      crashTimer += dt;
      if (crashTimer > 2) spawn();
      return;
    }
    stepJet(s, controls.ctl, dt, env);
  }

  function frame(alpha, frameDt) {
    controls.update(frameDt, s);
    placeJet(alpha);
    jet.group.visible = !s.crashed;
    pilot.update(modelState, controls.look);
    if (controls.view !== view) {
      view = controls.view;
      if (view === 'cockpit') cockpit.enter([pilot.head, glassSymbols]); else { cockpit.exit(); cam.snap(); }
    }
    if (view === 'cockpit') cockpit.update(frameDt, pose, controls.look, s);
    else cam.update(frameDt, pose, controls.ctl.aim, s, controls.look);
    world.update(t, camera);
    hud.setMode(view, view === 'cockpit' ? hudRectFor() : undefined);
    hud.update(camera, pose, controls.ctl.aim, s);
    sound.update(camera, s, view);
  }

  /** The cockpit HUD box: on the model's glass, grown (upward) to a readable size. */
  function hudRectFor() {
    const r = cockpit.hudRect(innerWidth, innerHeight);
    if (!r) return undefined;
    const w = Math.max(r.w, innerWidth * HUD_MIN_W), h = Math.max(r.h, w * 0.55);
    hudBox.x = r.x + r.w / 2 - w / 2; hudBox.y = r.y + r.h - h; hudBox.w = w; hudBox.h = h;   // grows upward: never over the instrument panel
    return hudBox;
  }

  spawn();

  // ---- warm-up: render the scene from a few angles behind the loading screen
  progress(0.85, 'Warming up…');
  const look = (heading, pitch) => () => {   // three's camera looks down -z; heading is clockwise from north (-z)
    camera.position.fromArray(s.pos);
    camera.rotation.set(pitch, -heading, 0, 'YXZ');
    camera.updateMatrixWorld();
    world.update(0, camera);
  };
  await engine.warmUp([0, 1, 2, 3].map((k) => look(k * Math.PI / 2, 0)).concat([look(0, -0.6), look(0, 0.5)]));
  spawn();
  progress(1, 'Ready');

  $('loading').classList.add('hidden');
  const showHud = (on) => $('hud').classList.toggle('hidden', !on);   // the menu sits over the live scene, without the flight HUD
  const start = () => {
    menu.show('none'); showHud(true); playing = true;
    try { $('stage').requestPointerLock()?.catch?.(() => {}); } catch { /* lock refused: the canvas click retries */ }
  };
  const applySettings = (st) => {
    controls.setSensitivity(0.0018 * st.sensitivity);
    controls.setInvertY(st.invertY);
    sound.setVolume(st.volume);
    world.setQuality(st.quality);
    $('fps').classList.toggle('hidden', !st.showFps);
  };
  const menu = createMenu($('menu'), {
    onPlay: (profile) => { jet.paint(profile.color); sound.start(); sound.pause(false); start(); },
    onResume: () => { sound.pause(false); start(); },
    onQuit: () => { playing = false; spawn(); showHud(false); menu.show('start'); },
    onChange: applySettings,
  });
  applySettings(menu.settings);
  engine.onPerf = (st) => { if (menu.settings.showFps) $('fps').textContent = `${Math.round(st.fps)} fps`; };
  showHud(false);
  menu.show('start');
  if (params.has('autoplay')) { jet.paint(menu.profile.color); start(); }
  controls.onLockChange = (locked) => {
    if (locked || !playing || params.has('autoplay')) return;
    playing = false; showHud(false); sound.pause(true); menu.show('pause'); engine.calm();
  };

  window.__game = { engine, world, jet, pilot, controls, menu, sound, get state() { return s; } };
  window.__engine = engine; window.__ready = true;   // tools/perf.mjs reads these
  engine.run(step, frame);
}
