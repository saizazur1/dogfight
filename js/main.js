/**
 * main.js — boots the game and glues the lanes together (README "Files and owners").
 *
 * Flow: loading screen → build engine, world and jet → warm up shaders → PLAY menu → fly.
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
  world.applyEnv(jet.group, 1);
  scene.add(jet.group);

  const env = { terrainHeightAt: world.terrainHeightAt, playArea: world.playArea };
  const controls = createControls({ canvas: $('stage') });
  const cam = createChaseCam(camera); cam.setEnv(env);
  const hud = createHud($('hud')); hud.setEnv(env);

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
    cam.update(frameDt, pose, controls.ctl.aim, s, controls.look);
    world.update(t, camera);
    hud.update(camera, pose, controls.ctl.aim, s);
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
  $('menu').classList.remove('hidden');
  $('hud').classList.add('hidden');   // the menu sits over the live scene, without the flight HUD
  const start = () => {
    $('menu').classList.add('hidden'); $('hud').classList.remove('hidden'); playing = true;
    try { $('stage').requestPointerLock()?.catch?.(() => {}); } catch { /* lock refused: the canvas click retries */ }
  };
  $('play').addEventListener('click', start);
  if (params.has('autoplay')) start();
  controls.onLockChange = (locked) => { if (!locked && playing && !params.has('autoplay')) { playing = false; $('menu').classList.remove('hidden'); $('hud').classList.add('hidden'); $('play').textContent = 'RESUME'; engine.calm(); } };

  window.__game = { engine, world, jet, controls, get state() { return s; } };
  window.__engine = engine; window.__ready = true;   // tools/perf.mjs reads these
  engine.run(step, frame);
}
