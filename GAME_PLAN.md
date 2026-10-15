# Dogfight — the game we are making

Agreed with the owner on 2026-10-15/16. Phase 0 and 1 are done (fly among the peaks, chase camera, small HUD, crash and respawn).

## The game in one paragraph

You fly a jet low between snowy Karakoram peaks at sunset. First against an AI (1-on-1, best of 3 rounds), later online against up to 8 people in a 5-minute free-for-all. You aim with the mouse, lock on and fire missiles, use the gun up close, and drop flares to dodge. A shot-down jet smokes, the pilot ejects, and a short kill-cam shows the parachute opening. No account: type a name, pick a colour, press PLAY.

## Decisions

| Topic | Decision |
|---|---|
| Controls | Mouse aim (jet flies toward the aim circle, banks by itself). Keyboard extras. Gamepad. Touch on phones/tablets. |
| Flying | Easy: no spin, a gentle stall that recovers, a PULL UP warning. |
| World | 30 × 30 km of real mountains. Fly past the edge and you're turned back. |
| Weapons | 4 missiles, 3 flare bursts, a gun. Missiles reload between rounds. |
| Damage | Health bar. A missile takes about 70%, gun hits chip away. Smoke when damaged. |
| vs AI | 1-on-1, best of 3 rounds. AI skill Easy / Medium / Hard, Medium by default. |
| Online | The goal. Free-for-all, up to 8 jets, 5-minute timed match, back in the air about 3 s after being shot down, most kills wins. |
| Finding a game | Share a room link, or press Quick play. AI fills empty seats after about 20 s. |
| Accounts | None. Type a name (or get a random one). Settings remembered in the browser. |
| Crashing into terrain | Counts as a death. In vs AI you lose the round. Online you lose a point, and whoever chased you gets the kill. |
| Kill moment | Short kill-cam (2–3 s slow motion: hit, smoke, parachute), skippable. |
| Jet colours | Player picks a plain colour (8 choices). No insignia, flags, numbers or brands. |
| Cockpit view | The model's cockpit, a generic pilot's hands on the stick and throttle, the HUD on the glass, head turns with free look. |
| Sound | Yes, from the film (made by code: engines, lock tone, missile warning, bangs). |
| Time of day | Sunset by default, plus morning and noon. |
| Server | Free hosting only (choice made in Phase 6). |

## Built "ready for online" from now on

- Every jet, the player's included, is the same kind of object in one list. The AI and a remote player drive a jet the same way the mouse does: one set of controls per 120 Hz step.
- Things that happen (fire, hit, flare, eject, kill) are small event records. Later they travel over the network unchanged.
- Effects, sounds and HUD work for any number of jets, not just two.

## Phases

The token figures are rough guesses based on Phase 1 (about 1.4 million tokens with the research). The hours are my working time.

| Phase | What you get | Time | Tokens |
|---|---|---|---|
| 2 Shell | Cockpit view, generic pilot, HUD on glass, start screen (name, colour, AI skill, PLAY), pause and settings, sound | 1.5 h | ~0.5 M |
| 3 Fight vs AI | AI pilot, lock-on, missiles, gun, flares, health, missile warning, radar arrow, best of 3, crash = death | 3 h | ~1 M |
| 4 Drama | Hit flash, smoke, debris, ejection and parachute, kill-cam, round and match cards | 2 h | ~0.7 M |
| 5 Polish | Gamepad, morning and noon skies, speed check at full Retina size, review and tuning | 1.5 h | ~0.5 M |
| 6 Online | Free server, rooms and Quick play, up to 8 jets, 5-minute match, kill feed and leaderboard, AI fill-ins | 6–8 h | ~1.5–2 M |
| 7 Phones and tablets | Touch controls, a lighter graphics setting, speed checks on a phone | 3 h | ~0.7 M |

Total still to do: about 5 million tokens. That won't fit in the current week (91% used, resets 2026-10-19). Plan: start Phase 2 after the reset, and check the usage meter after each phase.

## Open questions for later

- **Free hosting (Phase 6):** two candidates.
  - Cloudflare Workers + Durable Objects (free tier, one small "room" server per match).
  - Peer-to-peer WebRTC with one player as host (only a free signalling service is needed, but a cheater host or a slow host hurts everyone).
  - I'll compare them with real limits when we get there.
- **Phones (Phase 7):** this terrain and these clouds are heavy. A phone may need a much simpler look to hold 30–60 fps. We will measure before promising.
- **Cloud sea:** the valley floors sit under the sea of clouds, so in a dive you can't see the ground and must trust PULL UP. Keep it (tense) or thin it (fairer)? Decide after you've flown Phase 3.
