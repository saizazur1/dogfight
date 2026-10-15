// engine.js — renderer, composer, half-res bloom, adaptive resolution, shader warm-up, ?perf=1 and the fixed-step loop.
//
// Lessons from the jet film (~/SalesLeagueBoxingProto/web/js/main.js L79-114 and jetmode.js L268-322, L486-566), baked in:
//   1. Retina kills frame rate. The canvas pixel ratio is capped at 1.5 and then set ONCE, at load, to the ratio that fits a 2.4 MP
//      budget. After that only the composer's targets change (adaptive resolution, below); the canvas is never resized by it,
//      because resizing the canvas costs ~150 ms (measured by the film; a visible freeze). A WINDOW resize still has to resize
//      the canvas: it is debounced and does it once. Bloom runs at half the CSS size.
//   2. Every shader is compiled behind the loading screen by RENDERING it once through the composer (warmUp), at a low ratio.
//      Not compileAsync: only a real render through the same targets/passes makes the programs match the live ones.
//   3. A NaN in a shader turns the screen black through the bloom's blur. The bloom's high-pass is patched to drop NaN/Inf
//      (the bad pixel stays a dot instead of the whole screen). Custom shaders must still guard pow()/sqrt().
//   4. Logarithmic depth buffer on (the cockpit lens is 5 cm away, the mountains 260 km).
//   5. Fixed 120 Hz simulation, interpolated rendering.
//
// Shadow map: NOT enabled. jetworld bakes its own sun/valley shadows and its DirectionalLight casts none; jetmodel's castShadow
// flags are inert while renderer.shadowMap.enabled is false. Enable it only if a future effect needs it (it costs a depth pass).
//
// URL parameters: ?perf=1 (readout)  ?pr=<ratio> (pin the pixel ratio, no adaptation)  ?adapt=0 (keep the start level)
//                 ?msaa=0|2|4 (composer samples, default 4)  ?tone=agx|aces (default agx)  ?nanguard=0 (debug: no NaN guard)
//
// API (README):
//   const engine = await createEngine({ canvas, params });
//   engine.renderer / scene / camera / composer
//   engine.configure({ bloom, exposure, toneMapping })   engine.setBusy(bool)   engine.calm()
//   await engine.warmUp(fns)   engine.run(step, frame)   engine.stop()   engine.stats   engine.onPerf

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

/** Fixed simulation step, seconds (120 Hz). */
export const STEP = 1 / 120;
const MAX_CATCHUP = 0.25;   // a longer stall is not jumped over (a tab switch, a debugger)
const MAX_STEPS = 8;        // steps per displayed frame; the rest of the backlog is dropped (the game slows below ~15 fps)
const PIXEL_CAP = 1.5;
const PR_LEVELS = [1.5, 1.33, 1.2, 1.1, 1, 0.9, 0.8, 0.75];   // the film's levels; the floor is 0.75 of the CSS pixels
const PX_BUDGET = 2.4e6;   // drawing-buffer pixels to start from (1512x982 CSS at DPR 2 -> ratio 1.2)
const WARM_PR = 0.25;      // warm-up ratio: the compile is the cost, not the pixels
const RING = 32;           // frame monitor window (frames)
const REPORT_MS = 250;     // stats / adaptive decision / readout cadence
const RESIZE_DEBOUNCE_MS = 150;

/**
 * @typedef {Object} EngineStats
 * @property {number} fps         median of the last 32 frames, frames per second (0 until measured)
 * @property {number} frameMs     median wall interval between displayed frames, ms
 * @property {number|null} gpuMs  median GPU time of the composer render (EXT_disjoint_timer_query_webgl2), or null
 * @property {number} pixelRatio  the composer's current render ratio (the adaptive one)
 * @property {number} w           drawing-buffer width (the canvas)
 * @property {number} h           drawing-buffer height
 * @property {number} rw          composer (scene) render width = CSS width * pixelRatio
 * @property {number} rh          composer render height
 * @property {number} resChanges  how many adaptive resolution changes have been applied
 * @property {number} level       current adaptive level index (0 = the start level)
 * @property {number} steps       fixed steps taken by the last displayed frame
 * @property {number} dropped     steps dropped so far because a frame needed more than 8
 * @property {boolean} busy       setBusy state
 */

/** @param {THREE.WebGLRenderer} renderer */
function createGpuTimer(renderer) {
  const gl = renderer.getContext();
  const ext = renderer.capabilities.isWebGL2 ? gl.getExtension('EXT_disjoint_timer_query_webgl2') : null;
  let query = null, busy = false;
  const ring = new Float32Array(RING);
  let n = 0;
  return {
    available: !!ext,
    get count() { return n; },
    ring,
    /** read a finished query (call once per frame, before begin) */
    poll() {
      if (!ext || !busy || !gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) return;
      if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) { ring[n % RING] = gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6; n++; }
      busy = false;
    },
    /** @returns {boolean} true when a query was started (pair with end()) */
    begin() {
      if (!ext || busy) return false;
      query ||= gl.createQuery();
      gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
      return true;
    },
    end() { gl.endQuery(ext.TIME_ELAPSED_EXT); busy = true; },
    reset() { n = 0; },
  };
}

/**
 * Adaptive resolution (the film's makeRenderScale, jetmode.js L268-322). Starts from a pixel budget, steps down one level when frames
 * run slow and back up when the GPU has room, never more than one step a second; an up-step followed by a down-step within 4 s bans
 * further ups for 15 s (no pumping). A decided change is PENDING until engine.calm() (or, when not busy, 2.5 s).
 * Differences from the film: levels above the start level are not used (the canvas is fixed at the start level, so a higher composer
 * ratio would only be supersampled away by the output pass), and "camera cut" is engine.calm().
 */
function makeRenderScale({ renderer, composer, bloom, canvas, view, params }) {
  const P = (k) => params.get(k);
  const top = () => Math.min(window.devicePixelRatio || 1, PIXEL_CAP);
  const allLevels = () => { const t = top(); return [t, ...PR_LEVELS.filter((x) => x < t - 0.01)]; };
  const pin = Number(P('pr')) > 0 ? Math.min(Number(P('pr')), 3) : 0;
  const adapt = !pin && P('adapt') !== '0';
  let L = allLevels(), base = 0, lv = 0, pr = 1, canvasPR = 1;
  let pending = -1, lastChange = -1e9, lastUp = -1e9, banUpUntil = 0;

  const startIndex = () => { const i = L.findIndex((r) => view.w * view.h * r * r <= PX_BUDGET); return i < 0 ? L.length - 1 : i; };
  /** composer targets only: the canvas keeps its size and the output pass scales into it */
  const apply = (ratio) => {
    pr = ratio;
    composer.setPixelRatio(ratio); composer.setSize(view.w, view.h);
    bloom.setSize(view.w / 2, view.h / 2);   // half-resolution bloom: CSS / 2 whatever the ratio (the film's convention)
  };
  const S = {
    adapt, pin,
    get pr() { return pr; },
    get canvasPR() { return canvasPR; },
    get level() { return lv - base; },
    /** (re)choose the canvas ratio and level from the current view size: load and window resize. Resizes the canvas (slow). */
    layout() {
      L = allLevels();
      base = pin ? 0 : startIndex();
      lv = base; pending = -1;
      canvasPR = pin || L[base];
      if (renderer.getPixelRatio() !== canvasPR || canvas.width !== Math.floor(view.w * canvasPR) || canvas.height !== Math.floor(view.h * canvasPR)) {
        renderer.setPixelRatio(canvasPR); renderer.setSize(view.w, view.h, false);
      }
      apply(canvasPR);
      lastChange = performance.now();
    },
    /** temporary composer ratio (warm-up) */
    temp(ratio) { apply(ratio); },
    /** back to the current level after temp() */
    restore() { apply(pin || L[lv]); },
    /**
     * one monitor reading (>= 20 frames in the ring)
     * @returns {boolean} true when a change was decided (it is applied by flush())
     */
    decide(now, wallMed, gpuMed, n) {
      if (!adapt || pending >= 0 || n < 20 || now - lastChange < 1000) return false;
      // The GPU timer spans other programs' GPU work on a loaded Mac; a reading above the frame interval is that, not this page.
      // Without a usable reading a 60 Hz screen shows no headroom, so after 4 s at full rate one step up is TRIED.
      const gpuOk = gpuMed !== null && gpuMed < wallMed * 1.2;
      const slow = wallMed > 20 || (gpuOk && gpuMed > 15);
      const fast = wallMed < 18.5 && (gpuOk ? gpuMed < 9.5 : wallMed < 17.5 && now - lastChange > 4000);
      if (slow && lv < L.length - 1) { if (now - lastUp < 4000) banUpUntil = now + 15000; lv++; }
      else if (fast && lv > base && now > banUpUntil) { lv--; lastUp = now; }
      else return false;
      lastChange = now; pending = now;
      return true;
    },
    get pending() { return pending >= 0; },
    /** apply a pending level. @returns {boolean} true when it changed the targets */
    flush(now) { if (pending < 0) return false; pending = -1; lastChange = now; apply(L[lv]); return true; },
    get pendingAge() { return pending; },
  };
  return S;
}

/**
 * Create the renderer, scene, camera and composer.
 * @param {{ canvas: HTMLCanvasElement, params?: URLSearchParams }} opts
 * @returns {Promise<Object>} the engine (see the file header)
 */
export async function createEngine({ canvas, params = new URLSearchParams(location.search) }) {
  const P = (k) => params.get(k);
  const view = { w: 1, h: 1 };

  // ---- renderer (main.js L79-114): no canvas MSAA (the composer's target has it), log depth, sRGB out, AgX
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', logarithmicDepthBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, PIXEL_CAP));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const TONES = { aces: THREE.ACESFilmicToneMapping, agx: THREE.AgXToneMapping };
  const toneParam = TONES[(P('tone') || '').toLowerCase()];   // ?tone= always wins over configure()
  renderer.toneMapping = toneParam ?? THREE.AgXToneMapping;
  renderer.toneMappingExposure = 1.0;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.5, 4e5);   // far 4e5: the log depth buffer makes it free

  // ---- composer: half-float 4x MSAA target, bloom (only what is far past white glows, gently), output pass (tone map + sRGB)
  const msaaP = P('msaa'), msaa = msaaP !== null && [0, 2, 4].includes(Number(msaaP)) ? Number(msaaP) : 4;
  const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: msaa });
  const composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.15, 0.4, 3.0);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  // NaN guard (lesson 3): the high-pass feeds the blur chain; drop NaN/Inf there so one bad pixel cannot blacken the screen.
  if (P('nanguard') !== '0') {
    const hp = bloom.materialHighPassFilter, probe = 'vec4 texel = texture2D( tDiffuse, vUv );';
    if (hp.fragmentShader.includes(probe)) {
      hp.fragmentShader = hp.fragmentShader.replace(probe, `${probe}\n\t\t\tif ( any( isnan( texel ) ) || any( isinf( texel ) ) ) texel = vec4( 0.0 );`);
      hp.needsUpdate = true;
    } else console.warn('[engine] NaN guard not applied: three changed LuminosityHighPassShader');
  }

  const scale = makeRenderScale({ renderer, composer, bloom, canvas, view, params });
  const gpu = createGpuTimer(renderer);

  /** @type {EngineStats} */
  const stats = { fps: 0, frameMs: 0, gpuMs: null, pixelRatio: 1, w: 0, h: 0, rw: 0, rh: 0, resChanges: 0, level: 0, steps: 0, dropped: 0, busy: false };
  const gl = renderer.getContext();

  /** measure the canvas's CSS box, size everything. Resizes the canvas (~150 ms: only at load and on a debounced window resize). */
  function layout() {
    view.w = canvas.clientWidth || window.innerWidth; view.h = canvas.clientHeight || window.innerHeight;
    scale.layout();
    camera.aspect = view.w / view.h; camera.updateProjectionMatrix();
    refreshSizes();
  }
  function refreshSizes() {
    stats.pixelRatio = scale.pr; stats.level = scale.level;
    stats.w = gl.drawingBufferWidth; stats.h = gl.drawingBufferHeight;
    stats.rw = Math.floor(view.w * scale.pr); stats.rh = Math.floor(view.h * scale.pr);
  }
  layout();
  let resizeTimer = 0;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { layout(); nWall = 0; gpu.reset(); }, RESIZE_DEBOUNCE_MS); });

  // ---- frame monitor (no allocation): wall interval + GPU time of the last 32 frames; medians at 4 Hz
  const wallR = new Float32Array(RING), scratch = new Float32Array(RING);
  let nWall = 0, busy = false, running = false, raf = 0, lastT = 0, acc = 0, reportAt = 0;
  const median = (r, n) => {
    const k = Math.min(n, RING);
    if (!k) return null;
    scratch.set(r); for (let i = k; i < RING; i++) scratch[i] = Infinity;
    scratch.sort();
    return scratch[k >> 1];
  };

  const perfEl = P('perf') === '1' ? Object.assign(document.createElement('div'), { id: 'enginePerf' }) : null;
  if (perfEl) {
    perfEl.style.cssText = 'position:fixed;top:8px;right:8px;z-index:50;font:12px/1.35 ui-monospace,Menlo,monospace;color:#e8ffe8;background:rgba(0,0,0,.72);padding:4px 8px;border-radius:4px;pointer-events:none;white-space:pre';
    perfEl.textContent = 'perf: waiting for frames';
    document.body.appendChild(perfEl);
  }

  const applyPending = (now) => {
    if (!scale.flush(now)) return;
    stats.resChanges++; refreshSizes(); nWall = 0; gpu.reset();
  };

  /** the 4 Hz job: medians -> stats -> adaptive decision -> readout */
  const report = (now) => {
    const wm = median(wallR, nWall), gm = gpu.count >= 5 ? median(gpu.ring, gpu.count) : null;
    stats.frameMs = wm ?? 0; stats.fps = wm ? 1000 / wm : 0; stats.gpuMs = gm;
    if (wm !== null) scale.decide(now, wm, gm, nWall);
    // no camera cut here: a pending change waits for calm(), or, when not busy, 2.5 s
    if (!busy && scale.pending && now - scale.pendingAge > 2500) applyPending(now);
    stats.busy = busy;
    if (perfEl) {
      perfEl.textContent = `${wm ? stats.fps.toFixed(0) : '--'} fps  ${wm ? wm.toFixed(1) : '--'} ms${gm !== null ? `  gpu ${gm.toFixed(1)} ms` : ''}\n` +
        `${stats.w}x${stats.h} render ${stats.rw}x${stats.rh} @${scale.pr.toFixed(2)}${scale.pin ? ' pinned' : scale.adapt ? ' auto' : ''}${scale.pending ? ' (change pending)' : ''}\n` +
        `changes ${stats.resChanges}${busy ? '  busy' : ''}`;
    }
    if (engine.onPerf) engine.onPerf(stats);
  };

  /** the displayed frame */
  const tick = (now) => {
    raf = requestAnimationFrame(tick);
    const dtReal = lastT ? (now - lastT) / 1000 : 0; lastT = now;
    acc += Math.min(dtReal, MAX_CATCHUP);
    let n = 0;
    while (acc >= STEP && n < MAX_STEPS) { engine._step(STEP); acc -= STEP; n++; }
    if (acc >= STEP) { acc %= STEP; stats.dropped += 1; }   // spiral guard: a backlog beyond 8 steps is dropped, not chased
    stats.steps = n;
    engine._frame(acc / STEP, Math.min(dtReal, MAX_CATCHUP));
    gpu.poll();
    const timing = gpu.begin();
    composer.render();
    if (timing) gpu.end();
    if (dtReal > 0 && dtReal < 1) { wallR[nWall % RING] = dtReal * 1000; nWall++; }
    if (now - reportAt >= REPORT_MS) { reportAt = now; report(now); }
  };
  document.addEventListener('visibilitychange', () => { lastT = 0; });   // no catch-up after the tab was hidden (rAF is paused meanwhile)

  const macrotask = () => new Promise((r) => setTimeout(r, 0));

  const engine = {
    renderer, scene, camera, composer, bloom, stats, onPerf: null,
    _step: null, _frame: null,

    /**
     * Apply the world's look. Call BEFORE warmUp: a tone-mapping change rebuilds the output pass's program.
     * @param {{ bloom?: {strength?:number, radius?:number, threshold?:number}, exposure?: number, toneMapping?: number }} o
     *        (?tone= on the URL overrides toneMapping)
     */
    configure(o = {}) {
      if (o.exposure !== undefined) renderer.toneMappingExposure = o.exposure;
      if (o.toneMapping !== undefined && toneParam === undefined) renderer.toneMapping = o.toneMapping;
      if (o.bloom) {
        if (o.bloom.strength !== undefined) bloom.strength = o.bloom.strength;
        if (o.bloom.radius !== undefined) bloom.radius = o.bloom.radius;
        if (o.bloom.threshold !== undefined) bloom.threshold = o.bloom.threshold;
      }
    },

    /** true during action: a pending adaptive resolution change is held (no 2.5 s fallback either) */
    setBusy(b) { busy = !!b; stats.busy = busy; },

    /** a calm moment (respawn, pause, menu): apply any pending resolution change now */
    calm() { applyPending(performance.now()); },

    /**
     * Render each state once through the composer at a low ratio so every program is compiled and every texture uploaded behind the
     * loading screen. Each fn must leave the scene/camera showing the effect (an object outside the frustum is not compiled).
     * Yields to the event loop between renders so the loading screen can update. Resolves after the GPU has finished.
     * @param {Array<() => (void|Promise<void>)>} fns   empty -> one render of the current state
     */
    async warmUp(fns = []) {
      const t0 = performance.now(), list = fns.length ? fns : [null];
      scale.temp(WARM_PR);
      for (const fn of list) {
        try { if (fn) await fn(); composer.render(); } catch (e) { console.info(`[engine] warm-up state threw: ${e.message}`); }
        await macrotask();
      }
      gl.finish();   // the first live frame must not pay for the last compile
      scale.restore();
      console.info(`[engine] warm-up: ${list.length} states, ${renderer.info.programs.length} programs, ${Math.round(performance.now() - t0)} ms`);
    },

    /**
     * Start the loop. step(dt = 1/120) is fixed; frame(alpha 0..1, frameDt) runs once per displayed frame (interpolate between the
     * last two steps with alpha), then the engine renders. At most 0.25 s of catch-up and 8 steps per frame. Paused while the tab is hidden.
     * @param {(dt:number)=>void} step
     * @param {(alpha:number, frameDt:number)=>void} frame
     */
    run(step, frame) {
      engine.stop();
      engine._step = step; engine._frame = frame;
      running = true; lastT = 0; acc = 0; nWall = 0; reportAt = 0;
      raf = requestAnimationFrame(tick);
    },

    /** stop the loop */
    stop() { if (running) { cancelAnimationFrame(raf); running = false; } },

    /** @returns {number} the canvas pixel ratio (fixed at load) */
    get canvasRatio() { return scale.canvasPR; },
  };
  return engine;
}
