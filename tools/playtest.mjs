// node tools/playtest.mjs <url> <outDir> [maxSeconds=240] [w=1512] [h=982]
// Robot play-test: loads the game (use ?autoplay&bot so an AI flies both jets), polls window.__game every 250 ms,
// screenshots the first moment of each interesting state, logs the match. Own Chrome on port 9352, killed at the end.
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [url, out, maxS = '240', w = '1512', h = '982'] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const PORT = 9352;
const profile = mkdtempSync(join(tmpdir(), 'play-'));   // removed again in finally (230 leftovers once filled the disk)
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist', '--hide-scrollbars', '--mute-audio', `--window-size=${w},${h}`, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  let target;
  for (let i = 0; i < 50 && !target; i++) { await sleep(200); try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((t) => t.type === 'page'); } catch {} }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let id = 0; const pending = new Map(), errors = [];
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); pending.get(m.id)?.(m); if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description); if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map((a) => a.value ?? a.description).join(' ')); });
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const evalJ = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result?.result?.value;
  await send('Runtime.enable');
  await send('Page.navigate', { url });
  for (let i = 0; i < 120 && !(await evalJ('!!window.__ready')); i++) await sleep(500);
  const probe = `(() => { const g = window.__game, me = g.fighters[0], en = g.game.nearest || g.fighters[1], m = g.mode || {}, c = g.combat;
    return { t: +c.t.toFixed(1), phase: g.phase + '/' + (m.phase || ''), round: m.round ?? m.wave ?? 0, kills: m.kills, nAI: g.fighters.length - 1,
      clock: m.clock !== undefined ? Math.ceil(m.clock) : '', hpMe: +me.hp.toFixed(2), hpEn: en ? +en.hp.toFixed(2) : -1,
      lockP: me.lock.progress, locked: me.lock.locked, enLocked: !!en && en.lock.locked, warn: me.warn.missile,
      missiles: c.missiles.filter((m) => m.alive).length, bullets: c.bullets.filter((b) => b.alive).length, flares: c.flares.filter((f) => f.alive).length,
      mMe: me.missiles, mEn: en ? en.missiles : -1, fps: Math.round(g.engine.stats.fps) }; })()`;
  const want = { lock: (s) => s.lockP > 0.3 && !s.locked, locked: (s) => s.locked, missile: (s) => s.missiles > 0, warn: (s) => s.warn, guns: (s) => s.bullets > 3, flares: (s) => s.flares > 2,
    roundEnd: (s) => /\/(over|draw|cleared)$/.test(s.phase), wave2: (s) => s.kills !== undefined && s.round >= 2 && s.nAI >= 2, timer: (s) => s.clock !== '' && s.clock <= 100, matchEnd: (s) => s.phase.startsWith('finished') };
  const shot = async (name) => { const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(out, `${name}.png`), Buffer.from(r.result.data, 'base64')); };
  const t0 = Date.now(), log = []; let last = '';
  while (Date.now() - t0 < maxS * 1000) {
    const s = await evalJ(probe);
    if (!s) break;
    const line = `${s.phase} r${s.round}${s.kills !== undefined ? ` k${s.kills} ai${s.nAI}` : ''} hp ${s.hpMe}/${s.hpEn} M ${s.mMe}/${s.mEn}${s.clock !== '' ? ` clock ${Math.floor(s.clock / 10) * 10}` : ''}`;
    if (line !== last) { log.push(`[${s.t}s] ${line} fps ${s.fps}`); last = line; }
    for (const k of Object.keys(want)) if (want[k](s)) { await sleep(k === 'roundEnd' ? 600 : 0); await shot(k); log.push(`  shot ${k} at ${s.t}s`); delete want[k]; }
    if (s.phase.startsWith('finished')) { await sleep(800); await shot('finished'); break; }
    await sleep(250);
  }
  console.log(log.join('\n'));
  console.log(errors.length ? 'ERRORS:\n' + [...new Set(errors)].slice(0, 8).join('\n') : 'console: no errors');
  ws.close();
} finally {
  chrome.kill();
  if (chrome.exitCode === null && chrome.signalCode === null) await new Promise((r) => chrome.once('exit', r));
  rmSync(profile, { recursive: true, force: true });
}
