// node tools/duo.mjs [maxSeconds=110] [minutes=1] [outDir=shots/net] [base=http://127.0.0.1:8320/]
// Two-browser online test (README "Online contract", lane NET): two headless Chromes (ports 9381 / 9382, own temp profiles, both
// deleted in finally) play one online Chaos match through PeerJS's cloud signalling, robots flying both jets (?bot). The host page
// opens a room (?host&autostart=2), its console gives the code, the client page joins (?joinroom=CODE). Both pages record every
// rendered jet position against the shared wall clock (one machine); afterwards the client's picture of each seat is compared
// with the host's at the best-fitting time lag. Prints: position agreement, kill / death tables, the client's own jet smoothness
// (frame-to-frame residual against its velocity: rubber-banding shows as metre jumps), ping, the host's upload bytes/s, fps on
// both, packet counters. Screenshots of both mid-fight. Exit code 1 if they disagree.
// DUO_LEAVE=1 node tools/duo.mjs ...: also the client leaves mid-match (an AI must take its jet), joins the running match again
// (it must get its seat back), and the host leaves at the end (the client must hear 'host-left'). No screenshots then.
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [maxS = '110', minutes = '1', out = 'shots/net', base = 'http://127.0.0.1:8320/'] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const W = 1280, H = 720, LEAVE = !!process.env.DUO_LEAVE;   // DUO_LEAVE=1: the client leaves and re-joins mid-match, the host leaves at the end

/** one headless Chrome with its own profile; returns a small CDP client for its page */
function launch(port) {
  const profile = mkdtempSync(join(tmpdir(), 'duo-'));
  const proc = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist', '--hide-scrollbars', '--mute-audio', `--window-size=${W},${H}`, '--force-device-scale-factor=1',
    '--disk-cache-size=1048576', '--disable-gpu-shader-disk-cache', '--no-first-run', '--disable-component-update', '--disable-breakpad',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', 'about:blank'], { stdio: 'ignore' });
  return { port, profile, proc };
}
async function connect(c, label) {
  let target;
  for (let i = 0; i < 60 && !target; i++) { await sleep(250); try { target = (await (await fetch(`http://127.0.0.1:${c.port}/json`)).json()).find((t) => t.type === 'page'); } catch { /* starting */ } }
  if (!target) throw new Error(`${label}: Chrome did not start`);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let id = 0; const pending = new Map(); c.logs = []; c.errors = [];
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    pending.get(m.id)?.(m);
    if (m.method === 'Runtime.consoleAPICalled') {
      const line = m.params.args.map((a) => a.value ?? a.description).join(' ');
      c.logs.push(line);
      if (m.params.type === 'error') c.errors.push(line);
    }
    if (m.method === 'Runtime.exceptionThrown') c.errors.push('EXC ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  });
  c.ws = ws;
  c.send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  c.eval = async (expr) => { const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.result?.exceptionDetails) throw new Error(`${label}: ${r.result.exceptionDetails.exception?.description}`); return r.result?.result?.value; };
  c.shot = async (name) => { const r = await c.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(out, name), Buffer.from(r.result.data, 'base64')); };
  await c.send('Runtime.enable');
  return c;
}

// in-page recorder: every frame, wall time + each fighter's RENDERED pose (and visibility); my jet's frame-to-frame residual
const RECORDER = `(() => {
  const R = window.__duo = { hist: [], res: [], resMax: 0, seen: {} };
  let prev = null, pt = 0;
  function loop() {
    const g = window.__game;
    if (g && g.phase === 'play' && g.mode && g.mode.phase === 'fight' && window.__net && window.__net.connected) {
      const w = performance.timeOrigin + performance.now(), row = [w];
      for (const f of g.fighters) row.push(f.id, f.jet.group.visible ? 1 : 0, f.pose.pos[0], f.pose.pos[1], f.pose.pos[2]);
      R.hist.push(row);
      const me = g.fighters[0];
      if (prev && me.alive && me.jet.group.visible && prev.life === me.life) {
        const dt = (w - pt) / 1000;
        if (dt > 0 && dt < 0.1) {   // residual: the rendered move minus velocity * dt (a straight-line guess; turns add ~a*dt^2)
          const r = Math.hypot(me.pose.pos[0] - prev.p[0] - me.s.vel[0] * dt, me.pose.pos[1] - prev.p[1] - me.s.vel[1] * dt, me.pose.pos[2] - prev.p[2] - me.s.vel[2] * dt);
          R.res.push(r); if (r > R.resMax) R.resMax = r;
        }
      }
      prev = { p: me.pose.pos.slice(), life: me.life }; pt = w;
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
  return true;
})()`;

const PROBE = `(async () => {
  const g = window.__game, m = g.mode || {}, n = window.__net, ng = g.netg;
  const roster = (m.roster || []).map((r) => ({ seat: r.f ? r.f.id : -1, name: r.name, kills: r.kills, deaths: r.deaths }));
  const tr = n ? await n.traffic() : null;
  return { phase: g.phase, mphase: m.phase || '', clock: m.clock, roster, fps: Math.round(g.engine.stats.fps), seat: n ? n.seat : -1,
    players: n ? n.players : [], traffic: tr, stats: ng ? ng.stats : null, me: g.fighters[0].id, n: g.fighters.length,
    hist: window.__duo ? window.__duo.hist.length : 0, w: performance.timeOrigin + performance.now() };
})()`;

const A = launch(9381), B = launch(9382);
let code = 1;
try {
  await connect(A, 'host'); await connect(B, 'client');
  const q = `minutes=${minutes}&bot&seed=7`;
  await A.send('Page.navigate', { url: `${base}?host&autostart=2&${q}&name=Hosty` });
  let room = null;
  for (let i = 0; i < 160 && !room; i++) { await sleep(250); const l = A.logs.find((x) => x.startsWith('ROOM ')); if (l) room = l.slice(5).trim(); }
  if (!room) throw new Error(`host: no room code (${A.errors.slice(0, 3).join(' | ') || A.logs.slice(-3).join(' | ')})`);
  console.log(`room ${room}`);
  await B.send('Page.navigate', { url: `${base}?joinroom=${room}&${q}&name=Clienty` });
  const t0 = Date.now();
  let started = false;
  for (let i = 0; i < 200 && !started; i++) {
    await sleep(250);
    try { started = (await A.eval('window.__game?.mode?.id === "chaos" && !!window.__game.netg')) && (await B.eval('!!window.__game?.netg')); } catch { /* loading */ }
  }
  if (!started) throw new Error(`match did not start (host: ${A.errors.slice(0, 2).join(' | ')} client: ${B.errors.slice(0, 2).join(' | ')} ${B.logs.slice(-3).join(' | ')})`);
  console.log(`match started ${((Date.now() - t0) / 1000).toFixed(1)} s after the client opened`);
  await A.eval(RECORDER); await B.eval(RECORDER);
  let shotDone = false, fightT = 0, tr0 = null, a = null, b = null, left = false, leaveOk = true, rejoinOk = true, hostLeftOk = true;
  const log = [];
  while (Date.now() - t0 < maxS * 1000) {
    await sleep(1000);
    [a, b] = [await A.eval(PROBE), await B.eval(PROBE)];
    if (a.mphase === 'fight' && !fightT) { fightT = Date.now(); tr0 = { t: Date.now(), ...a.traffic }; }
    log.push(`host ${a.mphase} ${Math.ceil(a.clock)}s fps ${a.fps} | client ${b.mphase} ${Math.ceil(b.clock)}s fps ${b.fps} snaps ${b.stats?.snapsIn} ping ${b.players.find((p) => p.isMe)?.ping ?? '?'}`);
    if (!shotDone && fightT && Date.now() - fightT > 22000) { shotDone = true; if (!LEAVE) await Promise.all([A.shot('duo-host.png'), B.shot('duo-client.png')]); }
    if (LEAVE && !left && fightT && Date.now() - fightT > 12000) {   // the client drops out mid-match, then joins the running match again
      left = true;
      await B.eval('window.__net.leave(), true');
      await sleep(3000);
      const h = await A.eval('(() => { const f = window.__game.fighters.find((x) => x.id === 1); return f ? { isAI: f.isAI, ai: !!f.ai, net: f.net, alive: f.alive, players: window.__net.players.length } : null; })()');
      leaveOk = !!(h && h.isAI && h.ai && h.net === null && h.players === 1);
      log.push(`client left: host seat 1 = ${JSON.stringify(h)} -> ${leaveOk ? 'an AI took over' : 'NOT taken over'}`);
      await B.eval(`window.__net.join('${room}', { name: 'Clienty' }).then(() => true)`);
      for (let i = 0; i < 40; i++) { await sleep(250); if (await B.eval('!!window.__game.netg && window.__game.fighters.length > 1 && window.__game.fighters[0].alive')) break; }
      const h2 = await A.eval('(() => { const f = window.__game.fighters.find((x) => x.id === 1); return { isAI: f.isAI, net: f.net, name: f.name }; })()');
      rejoinOk = h2.net === 'remote' && !h2.isAI;
      log.push(`client re-joined the running match: host seat 1 = ${JSON.stringify(h2)}, client seat ${await B.eval('window.__net.seat')}`);
    }
    if (a.phase === 'finished' && b.phase === 'finished') break;
  }
  await sleep(1500);
  [a, b] = [await A.eval(PROBE), await B.eval(PROBE)];
  console.log(log.filter((l, i) => i % 5 === 0 || !l.startsWith('host ')).join('\n'));

  // ---- position agreement: the client's rendered seat k vs the host's rendered seat k at the best lag (both on one wall clock)
  const histB = await B.eval('window.__duo.hist.filter((_, i) => i % 6 === 0)');
  const cmp = await A.eval(`(() => {
    const H = window.__duo.hist, B = ${JSON.stringify(histB)}, out = {};
    function hostAt(w, id) {   // the host's rendered pose of seat id at wall time w (linear between its frames)
      let lo = 0, hi = H.length - 1;
      if (hi < 1 || w < H[0][0] || w > H[hi][0]) return null;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (H[mid][0] <= w) lo = mid; else hi = mid; }
      const a = H[lo], b = H[hi], u = (w - a[0]) / ((b[0] - a[0]) || 1), pa = find(a, id), pb = find(b, id);
      if (!pa || !pb || !pa[0] || !pb[0]) return null;
      if (Math.hypot(pb[1] - pa[1], pb[2] - pa[2], pb[3] - pa[3]) > 300) return null;   // a respawn between the frames
      return [pa[1] + (pb[1] - pa[1]) * u, pa[2] + (pb[2] - pa[2]) * u, pa[3] + (pb[3] - pa[3]) * u];
    }
    function find(row, id) { for (let i = 1; i < row.length; i += 5) if (row[i] === id) return [row[i + 1], row[i + 2], row[i + 3], row[i + 4]]; return null; }
    const errs = (lag, mine, meId) => { const e = []; for (const row of B) for (let i = 1; i < row.length; i += 5) {
      const id = row[i]; if (!row[i + 1] || (id === meId) !== mine) continue;
      const h = hostAt(row[0] - lag, id); if (h) e.push(Math.hypot(h[0] - row[i + 2], h[1] - row[i + 3], h[2] - row[i + 4])); } return e.sort((x, y) => x - y); };
    const meId = B.length ? B[0][1] : -1;
    for (const mine of [false, true]) {
      let best = null;
      for (let lag = -400; lag <= 400; lag += 5) {
        const e = errs(mine ? -lag : lag, mine, meId); if (e.length < 20) continue;
        const med = e[e.length >> 1]; if (!best || med < best.med) best = { lag: mine ? -lag : lag, med, p95: e[Math.floor(e.length * 0.95)], n: e.length, max: e[e.length - 1] };
      }
      const z = errs(0, mine, meId);
      out[mine ? 'mine' : 'others'] = best && { ...best, med0: z[z.length >> 1], p95_0: z[Math.floor(z.length * 0.95)] };
    }
    return out;
  })()`);
  const resB = await B.eval('(() => { const r = window.__duo.res.slice().sort((a, b) => a - b); return { n: r.length, med: r[r.length >> 1], p99: r[Math.floor(r.length * 0.99)], max: r[r.length - 1], over5: r.filter((x) => x > 5).length }; })()');
  const resA = await A.eval('(() => { const r = window.__duo.res.slice().sort((a, b) => a - b); return { n: r.length, med: r[r.length >> 1], p99: r[Math.floor(r.length * 0.99)], max: r[r.length - 1] }; })()');

  // ---- kills / deaths
  const table = (x) => Object.fromEntries(x.roster.map((r) => [r.seat, `${r.kills}/${r.deaths}`]));
  const ka = table(a), kb = table(b), seats = [...new Set([...Object.keys(ka), ...Object.keys(kb)])].sort();
  const killsAgree = seats.every((s) => ka[s] === kb[s]);
  const secs = tr0 ? (Date.now() - tr0.t) / 1000 : 1;
  const upA = tr0 && a.traffic ? (a.traffic.sent - tr0.sent) / secs : NaN;
  const ping = b.players.find((p) => p.isMe)?.ping;
  const f1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : '?');
  console.log('\n=== duo result ===');
  console.log(`end: host ${a.phase}/${a.mphase}, client ${b.phase}/${b.mphase}; fighters host ${a.n}, client ${b.n}; client seat ${b.seat}`);
  console.log(`kills/deaths by seat  host:   ${seats.map((s) => `${s}:${ka[s] ?? '-'}`).join('  ')}`);
  console.log(`                      client: ${seats.map((s) => `${s}:${kb[s] ?? '-'}`).join('  ')}   ${killsAgree ? 'AGREE' : 'DISAGREE'}`);
  const o = cmp.others, mi = cmp.mine;
  if (o) console.log(`other jets (client vs host): median ${f1(o.med)} m, p95 ${f1(o.p95)} m at lag ${o.lag} ms (client draws the past); same instant: median ${f1(o.med0)} m (n=${o.n})`);
  if (mi) console.log(`my jet (host vs client):    median ${f1(mi.med)} m, p95 ${f1(mi.p95)} m at lag ${-mi.lag} ms (host behind the client); same instant: median ${f1(mi.med0)} m`);
  console.log(`client's own jet smoothness: frame residual median ${resB.med?.toFixed(2)} m, p99 ${resB.p99?.toFixed(2)} m, max ${resB.max?.toFixed(1)} m, frames > 5 m: ${resB.over5} of ${resB.n}`);
  console.log(`host's own jet (reference):  frame residual median ${resA.med?.toFixed(2)} m, p99 ${resA.p99?.toFixed(2)} m, max ${resA.max?.toFixed(1)} m`);
  console.log(`ping ${ping ?? '?'} ms; host upload ${f1(upA / 1024)} KB/s (data channel payload); host sent ${a.stats?.snapsSent} snapshots, got ${a.stats?.statesIn} states (${a.stats?.bad} bad); client got ${b.stats?.snapsIn} snapshots, ${b.stats?.eventsIn} events (${b.stats?.bad} bad)`);
  const S = a.stats || {};
  if (S.predN) console.log(`host's extrapolation of the client's jet, checked as each state arrives: mean ${f1(S.predSum / S.predN)} m, max ${f1(S.predMax)} m, > 5 m: ${S.predOver5} of ${S.predN}`);
  console.log(`fps host ${a.fps}, client ${b.fps}`);
  const errs = [...new Set([...A.errors, ...B.errors])];
  console.log(errs.length ? `console errors:\n  ${errs.slice(0, 8).join('\n  ')}` : 'console: no errors');
  const good = killsAgree && b.stats?.snapsIn > 100 && o && o.med < 15 && o.p95 < 60 && mi && mi.med < 40 && resB.over5 <= Math.max(2, resB.n * 0.002) && a.mphase === 'over' && b.mphase === 'over' && !(a.stats?.bad || b.stats?.bad);
  if (LEAVE) {   // the host closes the room: the client must hear 'host-left'
    await A.eval('window.__net.leave(), true');
    for (let i = 0; i < 20 && !B.logs.some((l) => l.includes('NETCLOSE host-left')); i++) await sleep(250);
    hostLeftOk = B.logs.some((l) => l.includes('NETCLOSE host-left'));
    console.log(`leave / late join: AI took the leaver's jet ${leaveOk ? 'yes' : 'NO'}; re-join took the seat back ${rejoinOk ? 'yes' : 'NO'}; client heard host-left ${hostLeftOk ? 'yes' : 'NO'}`);
  }
  const all = good && leaveOk && rejoinOk && hostLeftOk;
  console.log(all ? 'DUO: PASS' : 'DUO: FAIL');
  code = all ? 0 : 1;
} catch (e) {
  console.error('duo:', e.message || e);
  console.error('host log:', A.logs?.slice(-6).join(' | '), '\nclient log:', B.logs?.slice(-6).join(' | '));
} finally {
  for (const c of [A, B]) {
    try { c.ws?.close(); } catch { /* closed */ }
    c.proc.kill();
    if (c.proc.exitCode === null && c.proc.signalCode === null) await new Promise((r) => c.proc.once('exit', r));
    rmSync(c.profile, { recursive: true, force: true });
  }
}
process.exit(code);
