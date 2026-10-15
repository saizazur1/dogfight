# Dogfight.io

A browser jet dogfight game. Three.js 0.186, plain ES modules from the jsDelivr CDN through an import map, no build step.

Serve the folder and open the game:

```bash
python3 -m http.server 8320 --bind 127.0.0.1
```

Then open http://localhost:8320/ in Chrome. Add `?perf=1` for the fps readout.

The terrain is Copernicus GLO-30 data. Its credit line must stay on screen (see `assets/terrain/CREDITS.md`).

## Origin

Code was copied (never edited in place) from the jet film in `~/SalesLeagueBoxingProto`: `jetworld.js`, `jetmodel.js`, `jetspec.js` (and its `kartspec.js` helpers) and `rng.js`. The film's pilot used real people's face scans; it is NOT used here, and the film's `models/*.glb` must never be copied in.

## Rules

- No real insignia, flags, squadron marks, tail numbers or brand names. Plain colours only.
- Every custom shader includes Three's `logdepthbuf` chunks (the log depth buffer is on). Guard every `pow()`/`sqrt()` against negative input (a NaN goes black through the bloom).
- No allocations in the per-frame / per-step path (`new Vector3`, array literals, closures). Never share one material between skinned/morphed and plain meshes.
- Simulation runs at a fixed 120 Hz step; rendering interpolates between the last two steps.
- Verify by looking: `tools/shot.mjs` takes screenshots with its own headless Chrome (set `PORT` to a debugging port of your own).

## Axes and units

World: metres, x east, y up, z south. World y 0 = 4,500 m above sea level (`DATUM`). Origin = the film's anchor (36.2627 N, 75.1483 E).
Jet body space (jetspec convention): +z forward, +y up, +x the pilot's LEFT. A pose is `{ pos:[x,y,z], q:[x,y,z,w] }`; `poseMatrix(pos, q)` from `jetspec.js` gives the Three.js matrix. `quatFromEuler(heading, pitch, bank)` / `eulerOf(q)`: heading clockwise from north (−z), bank + = right wing down.

## Files and owners (phase 1)

| File | What | Contract |
|---|---|---|
| `index.html`, `js/main.js` | Boot, loading screen, game loop glue | integration step |
| `js/engine.js` | Renderer, composer, half-res bloom, pixel cap, adaptive resolution, shader warm-up, `?perf=1`, fixed-step loop | below |
| `js/jetworld.js` | Terrain, sky, clouds, `terrainHeightAt`, play area, spawn | below |
| `js/flight.js` (+ `flight.check.mjs`) | Pure flight model (no Three.js, runs in node) | below |
| `js/controls.js` | Keyboard, mouse aim, pointer lock | below |
| `js/chasecam.js` | Chase camera | below |
| `js/hud.js` | Phase-1 HUD: aim circle, nose marker, speed, altitude, throttle, PULL UP / STALL | below |
| `tools/*.mjs` | Screenshots, contact sheets, perf measurement | — |

### engine.js

```js
const engine = await createEngine({ canvas, params });   // params = URLSearchParams
engine.renderer, engine.scene, engine.camera, engine.composer
engine.configure({ bloom: { strength, radius, threshold }, exposure, toneMapping })   // from the world
engine.setBusy(bool)       // true during action: adaptive resolution never changes while busy
engine.calm()              // a calm moment (respawn, pause, menu): apply any pending resolution change now
await engine.warmUp(fns)   // each fn sets up a state; the engine renders it once (low res, through the composer)
engine.run(step, frame)    // step(dt = 1/120) fixed; frame(alpha 0..1, frameDt) once per display frame, then renders
engine.stats               // { fps, frameMs, gpuMs, pixelRatio, w, h }
```

### jetworld.js

`buildJetWorld(scene, renderer, { seed })` returns `world` with (existing) `update(t)`, `terrainHeightAt(x, z)`, `sunDir`, `sunLight`, `applyEnv(obj)`, `bloom`, `exposure`, `toneMapping`, `credit`, plus (new):

- `world.playArea = { cx, cz, half, ceiling }`: a 30 × 30 km square (half ≈ 15000 m) inside the detailed map.
- `world.spawn = { pos:[x,y,z], heading, speed }`: low in a valley, peaks around, a long clear run ahead.
- `world.update(t, camera)`: anything that must follow the camera (near terrain, cloud culling) updates here.

### flight.js

```js
const s = createJet({ pos, heading, speed });   // JetState
stepJet(s, ctl, dt, env);                       // one fixed step; env = { terrainHeightAt, playArea }
jetModelState(s, out);                          // fills the object for jetmodel's setState()
```

- JetState: `pos[3] vel[3] q[4] speed throttle ab aoa gLoad stall(0..1) crashed crashPoint warn:{pullUp, stall, boundary} t`.
- `ctl`: `aim[3]` (unit world direction the player wants to fly toward, mouse aim) or null, `pitch roll yaw` (−1..1 keyboard overrides added on top), `throttle` (0..1 target), `ab` (bool), `brake` (bool).

### controls.js

```js
const controls = createControls({ canvas });
controls.ctl                  // the object passed to stepJet (updated live)
controls.update(frameDt, s)   // keyboard ramps, keeps aim sensible
controls.reset(heading, pitch)
controls.view                 // 'chase' | 'cockpit' (V toggles)
controls.locked               // pointer lock state
```

### chasecam.js / hud.js

```js
const cam = createChaseCam(camera);  cam.update(frameDt, pose, aim, s);  cam.snap();
const hud = createHud(root);         hud.update(camera, pose, aim, s);
```
