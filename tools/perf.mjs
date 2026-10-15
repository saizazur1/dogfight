// node tools/perf.mjs <url> [seconds=20] [w=1512] [h=982] [dpr=2] [--headed] [--settle=3]
// Launches its OWN Chrome on debugging port 9343 (headless=new by default; --headed = a visible window parked off-screen at
// -2400,0 with --app so there is no tab strip), waits for window.__ready, then samples for N seconds:
//   * every requestAnimationFrame interval (median / p95 / max frame ms, fps)
//   * engine.stats every 250 ms (gpuMs median, pixelRatio, buffer size, resolution changes)
// and prints a summary. Kills only that Chrome. Needs the page to expose window.__engine and window.__ready (engine.html does).
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2), flags = args.filter((a) => a.startsWith('--')), pos = args.filter((a) => !a.startsWith('--'));
const [url, secs = '20', w = '1512', h = '982', dpr = '2'] = pos;
if (!url) { console.error('usage: node tools/perf.mjs <url> [seconds] [w] [h] [dpr] [--headed] [--settle=3]'); process.exit(1); }
const headed = flags.includes('--headed');
const settle = +(flags.find((f) => f.startsWith('--settle='))?.slice(9) ?? 3);
const PORT = 9343;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chromeArgs = [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'perf-'))}`,
  '--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist', '--hide-scrollbars', '--mute-audio',
  '--no-first-run', '--no-default-browser-check',
  // an off-screen / background window must keep rendering at full rate
  '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
  '--disable-features=CalculateNativeWinOcclusion',
  `--force-device-scale-factor=${dpr}`,
];
if (headed) chromeArgs.push('--window-position=-2400,0', `--window-size=${w},${+h + 28}`, '--app=about:blank');   // +28: the macOS title bar
else chromeArgs.push('--headless=new', `--window-size=${w},${h}`, 'about:blank');
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', chromeArgs, { stdio: 'ignore' });

const pct = (a, p) => a[Math.min(a.length - 1, Math.floor(a.length * p))];
try {
  let target;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(250);
    try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((t) => t.type === 'page'); } catch { /* not up yet */ }
  }
  if (!target) throw new Error('Chrome did not come up on port ' + PORT);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let id = 0; const pending = new Map(), logs = [];
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id) pending.get(m.id)?.(m);
    if (m.method === 'Runtime.consoleAPICalled') logs.push(m.params.type + ': ' + m.params.args.map((a) => a.value ?? a.description).join(' '));
    if (m.method === 'Runtime.exceptionThrown') logs.push('EXC: ' + m.params.exceptionDetails.exception?.description);
  });
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text + ' ' + (r.result.exceptionDetails.exception?.description || '')); return r.result?.result?.value; };
  await send('Runtime.enable');
  await send('Page.navigate', { url });

  let ready = false;
  for (let i = 0; i < 360 && !ready; i++) { await sleep(500); ready = await ev('!!window.__ready').catch(() => false); }
  if (!ready) throw new Error('page never set window.__ready\n' + logs.slice(-10).join('\n'));
  await sleep(settle * 1000);   // let the adaptive level settle, discard

  const data = await ev(`(async (sec) => {
    const E = window.__engine, dts = [], samples = [], c0 = E.stats.resChanges;
    const iv = setInterval(() => samples.push({ gpu: E.stats.gpuMs, pr: E.stats.pixelRatio, w: E.stats.w, h: E.stats.h, rw: E.stats.rw, rh: E.stats.rh, ch: E.stats.resChanges, hidden: document.hidden }), 250);
    let last = performance.now(); const t0 = last;
    await new Promise((res) => { const tick = (n) => { dts.push(n - last); last = n; if (n - t0 >= sec * 1000) res(); else requestAnimationFrame(tick); }; requestAnimationFrame(tick); });
    clearInterval(iv);
    return { dts: dts.slice(1), samples, changes: E.stats.resChanges - c0, dropped: E.stats.dropped, inner: [innerWidth, innerHeight, devicePixelRatio], canvas: [E.renderer.domElement.width, E.renderer.domElement.height], timer: window.__engine.stats.gpuMs !== null, tone: E.renderer.toneMapping };
  })(${+secs})`);

  const dts = data.dts.slice().sort((a, b) => a - b), med = pct(dts, 0.5), p95 = pct(dts, 0.95);
  const gpus = data.samples.map((s) => s.gpu).filter((g) => g !== null).sort((a, b) => a - b);
  const last = data.samples[data.samples.length - 1] ?? {};
  const prs = [...new Set(data.samples.map((s) => s.pr))];
  console.log(`mode            ${headed ? 'headed (off-screen --app window)' : 'headless=new'}`);
  console.log(`viewport        ${data.inner[0]}x${data.inner[1]} css @dpr ${data.inner[2]}   canvas ${data.canvas[0]}x${data.canvas[1]}   render ${last.rw}x${last.rh}`);
  console.log(`frames          ${dts.length} in ${secs} s   hidden samples: ${data.samples.filter((s) => s.hidden).length}`);
  console.log(`frame ms        median ${med.toFixed(1)}   p95 ${p95.toFixed(1)}   max ${dts[dts.length - 1].toFixed(1)}   (${(1000 / med).toFixed(1)} fps median, ${(dts.length / +secs).toFixed(1)} fps mean)`);
  console.log(`gpu ms          ${gpus.length ? `median ${pct(gpus, 0.5).toFixed(1)}   p95 ${pct(gpus, 0.95).toFixed(1)}   (${gpus.length} samples)` : 'timer query unavailable'}`);
  console.log(`pixel ratio     now ${last.pr}   seen ${prs.join(', ')}   buffer ${last.w}x${last.h}`);
  console.log(`res changes     ${data.changes} during the sample   dropped steps ${data.dropped}`);
  if (logs.some((l) => /error|EXC/i.test(l))) console.log('console errors:\n' + logs.filter((l) => /error|EXC/i.test(l)).slice(-5).join('\n'));
  ws.close();
} finally { chrome.kill(); }
