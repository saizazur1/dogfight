// node tools/sheet.mjs <outDir> <img...>
// Contact sheet without Python/PIL: writes a temporary HTML grid (3 across, 640x360 cells, filename captions) and screenshots it
// with its own headless Chrome on port 9343 (do not run alongside tools/perf.mjs) -> <outDir>/sheet.png. Kills only that Chrome.
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { pathToFileURL } from 'node:url';

const [outDir, ...imgs] = process.argv.slice(2);
if (!outDir || !imgs.length) { console.error('usage: node tools/sheet.mjs <outDir> <img...>'); process.exit(1); }
mkdirSync(outDir, { recursive: true });
const COLS = 3, CW = 640, CH = 360, CAP = 22, GAP = 8;
const rows = Math.ceil(imgs.length / COLS);
const W = COLS * CW + (COLS + 1) * GAP, H = rows * (CH + CAP) + (rows + 1) * GAP;
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const cells = imgs.map((p) => `<figure><img src="${pathToFileURL(resolve(p)).href}"><figcaption>${esc(basename(p))}</figcaption></figure>`).join('');
const html = `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;background:#111;color:#ddd;font:13px/${CAP}px ui-monospace,Menlo,monospace}
#g{display:grid;grid-template-columns:repeat(${COLS},${CW}px);gap:${GAP}px;padding:${GAP}px;width:${W - 2 * GAP}px}
figure{margin:0;width:${CW}px}img{display:block;width:${CW}px;height:${CH}px;object-fit:contain;background:#000}
figcaption{height:${CAP}px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}</style><div id="g">${cells}</div>`;
const page = join(mkdtempSync(join(tmpdir(), 'sheet-')), 'sheet.html');
writeFileSync(page, html);

const PORT = 9343, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'sheet-prof-'))}`,
  '--hide-scrollbars', '--allow-file-access-from-files', `--window-size=${W},${H}`, 'about:blank'], { stdio: 'ignore' });
try {
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    await sleep(200);
    try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((t) => t.type === 'page'); } catch { /* not up yet */ }
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let id = 0; const pending = new Map();
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); pending.get(m.id)?.(m); });
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: pathToFileURL(page).href });
  for (let i = 0; i < 100; i++) {
    await sleep(200);
    const r = await send('Runtime.evaluate', { expression: 'document.images.length > 0 && [...document.images].every((i) => i.complete)', returnByValue: true });
    if (r.result?.result?.value) break;
  }
  const r = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: W, height: H, scale: 1 } });
  writeFileSync(join(outDir, 'sheet.png'), Buffer.from(r.result.data, 'base64'));
  console.log(`${join(outDir, 'sheet.png')}  ${W}x${H}  ${imgs.length} images`);
  ws.close();
} finally { chrome.kill(); }
