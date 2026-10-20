/**
 * points.js — the one score table (README "Hooks contract"): the hype pop-ups ("+100") and the XP (progress.js) both read it,
 * so what the player sees fly up is what lands on the XP bar.
 */
export const POINTS = Object.freeze({
  gunHit: 5, missileHit: 50, kill: 100, pickup: 15, ring: 20, wave: 50, roundWin: 150, matchWin: 300, played: 50,
});
