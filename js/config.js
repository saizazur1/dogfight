/**
 * config.js — the game's public settings (README "Online contract").
 * RELAY: a Metered "Open Relay" TURN app (free 20 GB/month). When two players can't connect directly (office / school
 * networks, phone carriers), the game data goes through this relay instead. The apiKey is a browser key by design
 * (Metered's TURN credentials API); lock it to saizazur1.github.io in the Metered dashboard. Empty = direct connections only.
 */
export const RELAY = { app: '', apiKey: '' };
