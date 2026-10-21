/**
 * main.js — boots the game (README "Files and owners", "Modes contract"): loading screen → engine → world → menu →
 * createGame (game.js: the jets, views, HUD, combat, the modes and the loop). Everything after booting lives in game.js.
 * URL: ?seed=N  ?view=cockpit  ?autoplay (start the menu's mode at once)  ?mode=duel|survival|race|tutorial (start that mode
 * at once)  ?bot (an AI flies the player's jet too: robot play-tests)  ?room=CODE (an invite link: opens the lobby's join
 * screen instead of the start screen; README "Online contract").
 */
import { createEngine } from './engine.js';
import { buildJetWorld } from './jetworld.js';
import { createMenu } from './menu.js';
import { createGame } from './game.js';
import { createLobby } from './lobby.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const progress = (frac, text) => { $('loadBar').style.width = `${Math.round(frac * 100)}%`; if (text) $('loadText').textContent = text; };
const fail = (e) => { console.error(e); $('loadText').textContent = `Could not start: ${e?.message || e}`; $('loadText').style.color = '#ff4d3d'; };
// Not fail(): boot() errors are caught below; a stray rejection (often a browser extension, e.g. "reading 'M_ID'") must
// not paint "Could not start" over a game that is loading fine.
addEventListener('unhandledrejection', (e) => console.warn('unhandled rejection (ignored):', e.reason));

try {
  await boot();
} catch (e) {
  fail(e);
}

/** Builds the engine, the world and the menu, then hands over to the game. */
async function boot() {
  progress(0.05, 'Starting the engine…');
  const engine = await createEngine({ canvas: $('stage'), params });

  progress(0.15, 'Loading the mountains…');
  const world = await buildJetWorld(engine.scene, engine.renderer, { seed: +(params.get('seed') || 7) });
  engine.configure({ bloom: world.bloom, exposure: world.exposure, toneMapping: world.toneMapping });
  $('credit').textContent = world.credit || '';

  let game = null, lobby = null;   // the menu's buttons only work once the game exists (the menu is hidden until then)
  const menu = createMenu($('menu'), {
    onPlay: () => game?.play(),
    onResume: () => game?.resume(),
    onQuit: () => game?.quit(),
    onChange: (st) => game?.applySettings(st),
    onLocker: () => game?.openLocker(),
    onFriends: () => lobby?.open(),
  });
  game = await createGame({ engine, world, menu, params, progress });
  // net.js (lane NET) loads on the first CREATE / JOIN, so a missing or broken file never stops the game booting
  lobby = createLobby(document.body, { net: async () => (await import('./net.js')).createNet(), game, menu });
  game.onOnlineEnd = () => lobby.open();   // game.js calls this after an online match (Esc / Space on the end card): back to the room
  if (params.get('room')) lobby.openJoin(params.get('room'));
}
