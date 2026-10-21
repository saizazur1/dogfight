# Dogfight.io

A browser jet dogfight game. Three.js 0.186, plain ES modules from the jsDelivr CDN through an import map, no build step.

Serve the folder and open the game:

```bash
python3 tools/serve.py
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

## Phase 3 contract: the fight

Every jet (the player's, the AI's, later remote players') is the same **fighter** record. Its pilot (mouse, AI, network) only writes `f.ctl`, once per 120 Hz step. Everything that happens is an **event** record (later sent over the network as is).

```js
fighter = {
  id: 0,                // small integer, unique in the match
  name: 'Falcon 427', color: '#c8362c', isAI: false,
  s,                    // flight.js JetState (pos, vel, q, speed, crashed, ...)
  ctl,                  // flight.js ctl + { gun: bool (held), missile: bool (edge: true for one step), flare: bool (edge) }
  // combat.js owns and writes these:
  hp: 1,                // 0..1; 0 = shot down
  alive: true,
  missiles: 4, flares: 3, gunAmmo: 400,
  lock: { target: -1, progress: 0, locked: false },   // seeker on the nose
  warn: { missile: false, dir: [0, 0, 0], dist: 0 },  // nearest missile chasing this fighter
};
```

### combat.js (pure, no Three.js, runs in node; `combat.check.mjs`)

```js
const combat = createCombat({ terrainHeightAt, seed, onEvent });
combat.add(fighter);  combat.reset(fighter);           // reset = full hp, ammo, lock cleared (new round)
combat.step(dt);                                        // AFTER every fighter's stepJet for this step
combat.missiles  // [{ id, owner, target, pos[3], vel[3], age, motor 0..1, alive, decoy: -1|flareIndex }]
combat.bullets   // [{ owner, pos[3], vel[3], age, alive }]  (tracers)
combat.flares    // [{ owner, pos[3], vel[3], age, burn 0..1, alive }]
combat.TUNE      // every weapon number in one place
```

Events (`onEvent(e)`, `e.t` = sim time): `missileFired {owner, missile}`, `missileHit {missile, owner, target, pos}`, `missileGone {missile, reason: 'decoyed'|'fuel'|'ground'}`, `gunFired {owner}` (≤ 10 Hz, for sound), `gunHit {owner, target, pos}`, `flare {owner, pos}`, `lockOn {owner, target}`, `lockLost {owner}`, `warning {target, on}`, `kill {killer, victim, cause: 'missile'|'gun'|'crash'}`.

### ai.js (pure, runs in node; `ai.check.mjs`)

```js
const ai = createAI(fighter, { skill: 'easy'|'medium'|'hard', env, combat, seed });
ai.think(dt, target);   // every step, BEFORE stepJet: writes fighter.ctl (aim, throttle, ab, gun, missile, flare)
```

### weaponfx.js (Three.js), hud.js, sound.js

```js
const wfx = createWeaponFx(scene, { buildMissile: jet.buildMissile, world });
wfx.onEvent(e);  wfx.update(frameDt, combat, camera);
hud.setFight({ me, enemy, combat, score: { me: 0, enemy: 0, round: 1 } });   // then hud.update as before
sound.onEvent(e, meId);  // lock growl / lock tone / missile warning / launch / gun / hits
cards.show('round'|'roundWin'|'roundLose'|'win'|'lose', { text, sub })   // big centred round cards, hide()
```

## Modes contract (after Phase 3)

`js/game.js` owns the session: engine loop glue, the fighter pool (up to 8 jets), views, HUD, sound, effects, combat, cards.
A **mode** is a small controller plugged into it. `main.js` only boots and calls `createGame(...)`.

```js
// game.js gives every mode this object:
game = {
  world, scene, camera, env, combat, controls, hud, cards, sound, wfx, params, profile,  // profile = menu.profile {name, color, skill}
  me,                                   // fighters[0], the player (always present)
  fighters,                             // live list (me first)
  spawnAI({ pos, heading, speed, skill, name, color }) -> fighter,   // pooled; joins combat; returns the fighter
  despawn(fighter),                     // returns it to the pool (hidden, out of combat)
  respawnMe({ pos, heading, speed }),   // fresh JetState + full hp/ammo for the player
  safeSpawn(i, n, radius?) -> { pos, heading, speed },   // n well-spread, terrain-safe starts on a ring (i-th)
  setBanner(text|null),                 // small persistent top-centre line (mode info: timer, wave, rings)
  finish({ title, sub, won }),          // ends the mode: big card, "Space: again · Esc: menu"
  t,                                    // sim time
}
// a mode:
createXMode(game) -> {
  id: 'duel'|'survival'|'race'|'tutorial', title,
  start(),               // called on PLAY (and on "again")
  step(dt),              // every 120 Hz step, AFTER stepJet + combat.step
  frame(frameDt),        // every display frame (visuals, HUD bits)
  onEvent(e),            // combat events (kill, missileHit, lockOn, ...)
  stop(),                // leaving the mode: remove its objects/AIs
}
```

Rules: modes never touch the engine or renderer; they create Three.js objects only under their own `THREE.Group` added to `game.scene` and removed in `stop()`. AI fighters are driven by `game` (it calls `ai.think` for every AI fighter, targeting `fighter.target` — default `game.me`). Everything per-step is allocation-free.

## Hooks contract (the "catchy" pass)

Owner feedback: the game had nothing that grabs a Gen Z / Gen Alpha player. Agreed: juice, a hype announcer, unlocks, power-ups
and supply drops, and a Chaos mode. Tone: **hype but clean** (W, L, CLUTCH, SKILL ISSUE, GG; nothing rude). No real meme sounds or
clips: everything is our own, made in code. Jets: still no insignia, flags, numbers or brands; unlockable **trails** and **finishes**
(gloss, matte, chrome, neon glow …) are allowed.

`js/points.js` is the one score table: `POINTS.gunHit 5, missileHit 50, kill 100, pickup 15, ring 20, wave 50, roundWin 150, matchWin 300, played 50`.
`engine.timeScale` (1; < 1 = slow motion) scales the sim and frameDt.

New events (same `onEvent` stream as combat's, `e.t` = sim time):
`pickup {owner, kind, pos}` · `dropIncoming {id, pos}` (a supply drop starts falling) · `shieldHit {target, pos}` (damage stopped by
a shield) · `match {result: 'win'|'lose'|'draw', place?, modeId}` (game.finish sends it) · `round {result: 'win'|'lose'}` (duel) ·
`wave {n}` (survival, a wave cleared) · `ring {n}` (race, a ring passed).

`game.js` (integration) loads each file below if present, calls it, and swallows its errors (a lane's bug never stops the game).
Per frame order: `cam.update` → `hype.frame` (shake / fov kick on top) → `trails.update` → `pfx.update` → HUD.

### hype.js (lane HYPE) — juice + announcer, DOM + camera only, never writes the sim

```js
const hype = createHype(root, { sound });   // root = #hud's parent (document.body)
hype.onEvent(e, ctx)        // ctx = { meId, byId(id) -> fighter|null, me, modeId } — every event above and combat's
hype.frame(frameDt, camera, me, view)   // after the camera is placed: screen shake, fov kick on afterburner (chase only), speed lines
hype.say(text, { sub, tone: 'gold'|'red'|'white'|'cyan', voice: true })   // a big callout (+ optional spoken line)
hype.popup(text, tone)      // a small "+100" that floats up from the crosshair
hype.slowmo                 // 1, or < 1 for ~0.8 s after MY kill (game copies it to engine.timeScale)
hype.reset()                // a new mode / match (streaks, feed)
hype.setVoice(on)           // the spoken announcer (speechSynthesis) on/off
```
Kill feed (top right, every kill: "Viper ✈ Falcon 427", coloured names), multi-kills (DOUBLE / TRIPLE / QUAD KILL within 4 s),
streaks (3 ON FIRE, 5 UNSTOPPABLE, 7 LEGENDARY), CLUTCH (my kill with hp < 25 %), REVENGE (kill the last one who killed me),
FIRST BLOOD (first kill of a Chaos match), SKILL ISSUE (I crash on my own), "+N" pop-ups from `POINTS`, a hit tick sound on my hits.
Lane HYPE also owns `cards.js` (new looks: big **W** / **L**) and `sound.js` / `audio.js` (new `oneShot` kinds: `tick`, `kill`,
`stinger`, `levelup`, `pickup`, `drop`, `shield`).

### progress.js, trails.js, locker.js (lane UNLOCKS)

```js
const prog = createProgress(storage = localStorage);   // pure, no DOM (progress.check.mjs runs it in node with a fake storage)
prog.state   // { xp, level, rank, equipped: { trail, finish }, unlocked: { trails: [], finishes: [] }, daily: { date, list: [{ id, text, goal, n, done }] } }
prog.matchStart(modeId);  prog.onEvent(e, meId, modeId);   // counts POINTS + daily challenge progress
prog.matchEnd({ modeId, won }) -> { xp, before: { level, xp }, after: { level, xp }, levelUp, rank, unlocked: [{ kind, id, name }], challenges: [...] }
prog.equip(kind 'trail'|'finish', id);  prog.ITEMS  // every trail / finish: { kind, id, name, level } (level 1 = free)

const trails = createTrails(scene, world);   // wingtip ribbons, one draw per jet, allocation-free per frame, logdepth in its shader
trails.set(fighter, styleId);  trails.clear(fighter);   // clear on respawn (no streak across a teleport)
trails.update(frameDt, fighters, camera);

const locker = createLocker(document.body, prog, { onEquip });   // the trails / finishes picker (opened from the start screen)
locker.open(); locker.close();
locker.showResult(summary)   // under the end card: XP bar filling, LEVEL UP!, new unlocks, challenges done
```
`jet.finish(id)` (jetmodel.js, lane UNLOCKS): changes the paint material only (roughness / metalness / emissive), never per frame.
menu.js (lane UNLOCKS): level + rank badge and XP bar on the start screen, a LOCKER button, the daily challenges, and a fifth
mode tile `['chaos', 'Chaos', '2-min free-for-all']`. `menu.profile.mode` may be `'chaos'`.

### powerups.js, powerupfx.js, chaos.js (lane CHAOS)

```js
const pu = createPowerups({ terrainHeightAt, playArea, seed, onEvent, combat });   // pure, runs in node (powerups.check.mjs)
pu.start({ count, dropEvery, kinds })   // count floating pick-ups kept in the sky; a supply drop every dropEvery s (0 = never)
pu.step(dt, fighters)                   // after combat.step: collect (radius ~45 m), timers, falling drops
pu.items   // [{ id, kind, pos[3], alive, drop: bool, chute: bool }]   fixed pool
pu.stop()
// kinds: 'repair' (+50 % hp), 'missiles' (refill), 'boost' (6 s more thrust), 'shield' (6 s no damage), drop = all of them
// writes fighter.shield (s left) and fighter.s.boost (s left); flight.js reads s.boost, combat.js skips damage while shield > 0
const pfx = createPowerupFx(scene, world);  pfx.update(frameDt, pu, fighters, camera);   // glowing icons, drop beacon + parachute, shield bubble
```
`createChaosMode(game)`: 2-minute free-for-all, me + 7 AIs, back in 3 s after a death, most kills wins, AIs pick targets among
everyone, a live top-3 banner and a final leaderboard. A mode may declare `powerups: { count, dropEvery }` (false / missing = none);
`game.powerups` is the live `pu` (or null). Chaos uses lots; duel and survival a few plus a drop each minute.
Defaults game.js uses: trail style `'vapor'` (thin white wingtip vapour, free, also every AI's) and `'none'`; finish `'gloss'` (today's look).
As built: `missileHit` / `gunHit` on a shielded jet carry `shielded: true` (game.js keeps them from the hype and the XP). Chaos is
arcade: one missile kills and the gun hits 1.5x harder (combat.TUNE, put back in its stop()); pick-ups stay within ARENA_R + 1.5 km
(`pu.start({ radius })`); AI targets are sticky (kept unless another jet is under half as far). `?nohooks` (test only) runs the
game without the hooks, to A/B their cost.

## Online contract (Phase 6: play with friends)

Owner's choices: **peer-to-peer** (one player's browser hosts the match, free, no server account) and **GitHub Pages** for the
game itself (publishing only after the owner says yes). Plan: free-for-all, up to 8 jets, AIs fill empty seats, room link, no accounts.

- **Transport:** PeerJS 1.5.4 (`https://cdn.jsdelivr.net/npm/peerjs@1.5.4/+esm` in the import map) with its free cloud signalling
  server and its default STUN/TURN. Room code: 5 letters/digits without look-alikes (no 0/O/1/I/L); the host's peer id is
  `dogfightio-<code>`. Link: `<page url>?room=<CODE>`. Star topology: every client talks only to the host.
- **Authority:** the HOST runs the match exactly as today (combat, AIs, power-ups, kills, the clock). Each CLIENT flies its own jet
  locally (stepJet with its own controls, so steering feels instant) and sends its jet state + weapon triggers ~30 Hz; the host
  writes them onto that player's fighter (no stepJet for remote humans) and its combat fires their weapons. The host sends a
  snapshot ~20 Hz (every fighter, missiles, pick-ups, clock, scores) and every event (reliable, in order), so the client's HUD,
  sound, hype, radar and XP run off the same `onEvent` stream. Damage, kills and pick-ups are decided only by the host.
  ponytail: friends-only trust (a client could lie about its position); a server can take over later without changing the records.
- **Seats:** fighter id = seat (0..7). The host is seat 0 on the host; on a client its own seat is `game.me` (fighters list
  re-indexed so `me` is still `fighters[0]` locally, ids stay the host's seat ids).
- **Mode:** the Chaos rules (free-for-all, most kills, back in 3 s, power-ups, leaderboard), 3 or 5 minutes, AIs filling to 8
  (host's choice). Leaving: a client's jet is taken over by an AI; the host leaving ends the match for everyone ("Host left").
  No pausing online (Esc opens the menu, the match goes on).

```js
// net.js (lane NET)
const net = createNet();
const code = await net.host({ name, color });      // opens a room
await net.join(code, { name, color });              // throws { code: 'not-found'|'full'|'failed'|'started' }
net.code, net.isHost, net.seat, net.players         // players: [{ seat, name, color, ping, isHost, isMe }]
net.onPlayers = (players) => {};  net.onStart = (cfg) => {};  net.onClose = (reason) => {};
net.start({ minutes: 3|5, bots: true|false });      // host only: everyone's game starts
net.leave();
// game.js (lane NET): game.playOnline(net, cfg) starts the synced match on host and clients alike
// lobby.js (lane LOBBY): createLobby(document.body, { net, game, menu }) → open(), openJoin(code), close()
```

### As built (lane NET)

Files: `js/net.js` (rooms), `js/netgame.js` (the sync: codec, snapshot buffer, trigger counts, host / client controller, pure,
`js/net.check.mjs` runs it in node), `js/game.js` (`playOnline`), `js/chaos.js` (online host / client variants), `tools/duo.mjs`.

- **net.js extras** (for game.js; the lobby only needs the API above): `net.listen(fn) -> off` (`fn(type, data, seat)`: `'msg'`
  game messages, `'join'` a player joined a running match, `'leave'` a seat left; game messages that arrive before anyone listens
  are kept for the next listener), `net.send(to, msg)` (host: a seat or -1 = all; client: the host), `net.endMatch()`,
  `net.connected`, `net.started`, `net.cfg`, `await net.traffic()` (data-channel bytes). `net.onClose` reasons: `'host-left'`
  (the host left or closed the room) and `'lost'` (10 s of silence); never for our own `leave()`. `leave()` is safe twice.
  cfg = `{ minutes, bots, seed, players: [{ seat, name, color, ping }] }`. Names are cleaned (no `<>&"'`, ≤ 20 chars), colours
  must be `#rrggbb`; a colour already in the room is swapped for the next free one so friends can tell each other apart.
- **Joining a running match** is allowed (no `'started'` error): the joiner takes the lowest free seat, an AI's when AIs fill the
  field (its score starts at 0), and is in the air at the farthest start slot. `'full'` = 8 people. Leaving mid-match: an AI flies
  the jet on (score kept with the seat).
- **Leaving / ending** (lobby contract): Quit in the pause menu, or Space / Esc on the end card → `game.quit()` →
  `game.onOnlineEnd?.()` (back to the room; the net stays open). A client's quit hands its jet to an AI; the HOST's quit ends the
  match for everyone (`abort`: every client goes back to the room). `game.quit()` also works when the lobby calls it after
  `host-left` (then no `onOnlineEnd`). No pause online: Esc opens the menu over the running match; Resume returns.
- **Sync** (details in netgame.js's header): host → clients a 20 Hz binary snapshot (~0.6–1.2 KB with 8 jets: pose, hp, ammo,
  lock, warn, shield, boost, kills / deaths, life; live missiles; live pick-ups; clock, phase) right after that tick's events
  (`{k:'ev', l}`; every event but `match`); client → host a 30 Hz 64-byte state (pose + model bits, `life`, crashed, gun held,
  missile / flare press COUNTS: each new count becomes one rising edge in the host's combat, so a press is never lost or doubled).
  `fighter.life` (bumped by every placement) keeps an old life's packets away from a respawned jet. Respawns: the host sends
  `{k:'respawn', pos, heading, speed, life}` and the client places its own jet.
- **What a client sees:** its own jet flown and crashed locally (instant steering); other jets 100 ms behind the host's clock,
  Hermite-interpolated between snapshots (extrapolated if the buffer runs dry; `?netdelay=ms` changes the delay, 0 = present
  time); missiles from the newest snapshot moved along their velocity to that same time (mine to "now", so they leave my rails);
  tracers and flares made locally (the jets' gun bits / the host's flare events, my own from my trigger at once) with no damage.
  HUD, sound, hype, radar, XP all run off the host's events with `meId` = my seat. Host's events apply on arrival (a hit shows as
  soon as it lands on the host). Ids = seats on every machine; a client's pool is re-mapped so `me` stays `pool[0]`.
- **Host side:** remote players' jets are set every step from their states at the player's own clock "now" (extrapolated with
  the velocity and spin), so what the host shoots at is where they are drawn. No slow motion online.
- **Known limits:** friends-only trust (positions and crashes are the client's word); one reliable ordered channel (PeerJS's
  "unreliable" is only unordered and needs its own WebRTC connection: a lost packet stalls the stream by one round trip); a client's
  guns aim at a picture ~100 ms + half a ping old, so crossing gun shots favour the host (missiles lock and are unaffected); the
  host's browser tab must stay in front (a hidden tab pauses its loop and so the match); strict NATs need PeerJS's free TURN.
- **Test only:** `?host[&autostart=N][&minutes=M][&nobots]` opens a room (console `ROOM <code>`) and starts when N people are in;
  `?joinroom=CODE` joins it (main.js's `?room=CODE` is the human invite link); `?bot` lets an AI fly this browser's jet; `?name=`.
  `node tools/duo.mjs [maxSeconds] [minutes] [outDir]`: two headless Chromes (ports 9381 / 9382) play a match and compare;
  `DUO_LEAVE=1` adds leave / re-join / host-left.
Relay (TURN): PeerJS's free relay and Metered's old public one both stopped answering (2026-10-21), and a friend at home could
not join a host on an office LAN. `js/config.js` `RELAY = { app, apiKey }` (a Metered Open Relay app, free 20 GB/month) adds
its TURN servers to every Peer; empty = direct connections only.
