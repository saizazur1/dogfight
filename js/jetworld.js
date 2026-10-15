// jetworld.js — the jet dogfight's world: a sunset over the snowy Karakoram (lane WORLD of the jet scene).
//
// Frames (jetspec.js WORLD_FRAME, contract v3 -- every number below is read from it). x = east, z = south, y = up, metres.
// World y = metres above sea level - 4,500, so the fight box (x, z +-3 km, y 1,000-4,000; PLAN's floor 1,740) is 5,500-8,500 m
// above the sea, in a deep valley among the high peaks SE of Hispar (36.2627 N, 75.1483 E; pixel 3723, 2189 -- SPEC's v3
// scan, 2026-10-15): the box's highest ground 6,107 m (terrainMaxInBox 1,607), summits to ~7,810 m within 10 km, standing
// over the fight on most bearings. The map's east edge is only 10.9 km east of the fight: past it the ground is CONTINUED
// (a wiggly fold of the last kilometres crossfading into the range ~100 km west, so no edge, stripe or mirror line shows).
//
// What is on screen:
//   * the sky: a single-scattering atmosphere (Rayleigh, dust, ozone, the earth's curve) seen from 7 km, the sun 7 deg up at
//     252 deg (WSW), a golden band low toward the sun, thin pink-gold cirrus, the disc held at a fixed radiance (30) so bloom
//     gives a glare and never a white-out. Baked ONCE into a cube; calibrated so the zenith reads 0.075.
//   * the sun: its colour is what that atmosphere lets through at 7 deg, pushed deeper amber for the owner's "sunset, golden light" ->
//     (1, 0.53, 0.27); irradiance 7, so a grey (albedo 0.35) facing it reads 0.65 (luminance, linear) at the fight centre.
//   * the mountains: the REAL ground from the climb's Copernicus GLO-30 heightmap (assets/climb/), decoded here at its full
//     29 m in a 30 km window and at 58 m over the whole 120 km tile (continued past it, see contH), plus ridged relief below
//     29 m (detailH, the same on the CPU), drawn by two GPU-displaced meshes: a graded square grid (22-34 m) under the fight,
//     a polar mesh (1,536 around) to 260 km. The earth's curve is in. Sun shadows (also at the cloud sea's height) and valley
//     sky occlusion are baked once by a GPU march toward the sun. Snow by height and slope, rock on the steep faces,
//     glaciers with moraines in the flat valley floors.
//   * a sea of cloud BELOW the fight (WORLD_FRAME.cloudDeck, y 200-650): a ray-marched volume (a 2-D field for where and how
//     high, the 3-D Perlin-Worley noise for billows), lit by the sun (Beer + scattering octaves), shadowed by the mountains.
//   * cumulus AROUND the fight: 32 volumes (6 near, 6-11 km out; 26 to 50 km; bases ride with the plan floor), each a box ray-marched through domain-warped
//     blobs eroded by the same noise, lit gold on the sun side, grey-violet in the body, a silver rim against the sun.
//   * haze: Rayleigh + dust with height, integrated exactly along each ray, its colour from the sky at each azimuth: far
//     ranges go blue and soft, the air toward the sun gold.
// Everything that moves (cloud drift, 4 m/s) is a pure function of t; the sun, the light and the shadows stay still.
//
// API (jetspec.js section 9, WORLD):
//   buildJetWorld(scene, renderer, opts) -> Promise<world>         opts: { seed = 7, noAssets = false }
//     world.update(t, sample?)    t in seconds (cloud drift); the plan sample is accepted and unused
//     world.sunDir                Vector3, unit, toward the sun (world)
//     world.sunColor, world.sunIntensity   the DirectionalLight values that match the terrain's lighting (MeshStandard units)
//     world.sunLight              that DirectionalLight (in world.group, aimed at the fight centre, no shadow; GLUE may set one)
//     world.skyEnv                PMREM texture: the real world seen from the fight centre (sky, mountains, cloud sea)
//     world.applyEnv(obj, k=1)    puts skyEnv on every standard material under obj (scene.environment stays null, as the climb)
//     world.toneMapping, world.exposure   ACES (research B6), 0.8
//     world.bloom                 { strength, radius, threshold: 3.0 } -- only the sun disc and the brightest cloud rims pass it
//     world.fightBox              { min, max, centre, floorY } (world)
//     world.terrainHeightAt(x,z)  world y of the ground (the same heights, relief and curve the GPU draws)
//     world.sunVisibilityAt(x,y,z) 0..1, a point in a mountain's shadow or in sun (CPU twin of the bake): PLAN keeps jets at 1
//     world.deck                  { base, top } world y of the cloud sea (cameras stay above its top: the march starts there)
//     world.cloudsAt(t)           [{ c: [x,y,z], half: [hx,hy,hz] }] each cumulus's box (centre, half sizes) at t: keep lenses out
//     world.credit                the Copernicus line (show it on screen when the DEM is used), or null
//     world.stats                 timings, triangles, clouds, terrainMaxInBox
//     world.dispose()
//   Renderer: { logarithmicDepthBuffer: true } (WORLD_FRAME.logDepth); every shader here carries three's logdepth chunks.
//   Clouds and jets: a cloud box is drawn after the opaque jets with no knowledge of their depth, so a jet INSIDE a cloud's
//   box but in front of its density would be painted over -- PLAN keeps jets out of cloudsAt() boxes (ponytail: pass a jet
//   depth texture to the cloud shader if a shot ever needs a jet threading a cloud).
//
// Copied (climbarena.js is NOT edited): the 16-bit PNG decoder (loadDem, lines 98-118), the haze model (GLSL_HAZE 193-210),
// vnoise3/noised3 (GLSL_NOISE 152-180), the horizon-LUT bake (966-993). gradedAxis from kartworld.js. Imported: mulberry32
// (rng.js), WORLD_FRAME (jetspec.js).

import * as THREE from 'three';
import { mulberry32 } from './rng.js';
import { WORLD_FRAME } from './jetspec.js';

const DEG = Math.PI / 180;
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// ================================================================== the place, the sun, the levels
export const DATUM = WORLD_FRAME.datum;     // world y 0 = 4,500 m above the sea (jetspec.js contract v1)
// The site (contract v3): pixel (3723, 2189) of the 4,096² tile, 36.2627 N 75.1483 E, a valley among peaks to ~7,810 m. Chosen
// by SPEC over ~6,700 centres with PLAN's 100 real fights placed in each (summits beside the jets, every jet sunlit). r7.
const SITE = { px: WORLD_FRAME.anchor.demPx[0], py: WORLD_FRAME.anchor.demPx[1] };
const SUN_EL = WORLD_FRAME.sun.elevDeg * DEG, SUN_AZ = WORLD_FRAME.sun.azDeg * DEG;   // 7°, 252°: mid-October, ~25 min before sunset
export const SUN = Object.freeze({ elevDeg: WORLD_FRAME.sun.elevDeg, azDeg: WORLD_FRAME.sun.azDeg, dir: [Math.sin(SUN_AZ) * Math.cos(SUN_EL), Math.sin(SUN_EL), -Math.cos(SUN_AZ) * Math.cos(SUN_EL)] });
// The sun's colour: what the same atmosphere as the sky (SKY_FS: Rayleigh, dust, ozone) lets through from 7 km at 7°.
// Normalised so its brightest channel is 1.
const SUN_COL = (() => {
    const RP = 6371e3, RA = 6471e3, o = [0, RP + 7000, 0], d = SUN.dir, n = 400;
    const b = o[1] * d[1], c = o[1] * o[1] - RA * RA, L = -b + Math.sqrt(b * b - c);
    let oR = 0, oM = 0, oO = 0;
    for (let i = 0; i < n; i++) { const t = (i + 0.5) * L / n, h = Math.hypot(d[0] * t, o[1] + d[1] * t, d[2] * t) - RP; oR += Math.exp(-h / 8000) * L / n; oM += Math.exp(-h / 2000) * L / n; oO += Math.max(0, 1 - Math.abs(h - 25000) / 15000) * L / n; }
    const T = [[5.8e-6, 0.65e-6], [13.5e-6, 1.88e-6], [33.1e-6, 0.085e-6]].map(([br, bo]) => Math.exp(-(br * oR + 3.5e-5 * 1.1 * oM + bo * oO)));
    // pure single scattering gives (1, 0.72, 0.53) here, which reads as white noon under ACES; the research's sunset sun is
    // ~2,700 K (#ffb070). Take the model's hue pushed to that warmth (the extra is the low dust a 1-D model leaves out).
    const g = T.map((v, i) => v * [1.0, 0.74, 0.5][i]), m = Math.max(...g);
    return new THREE.Color(g[0] / m, g[1] / m, g[2] / m);
})();
const SUN_E = 7.0;                         // irradiance; a sunlit grey (0.35) facing the sun ≈ 0.7 before tone mapping (research B6); snow on a typical slope ≈ 1.1
const ZENITH = 0.075;                      // the zenith's mean radiance (the sky is scaled to it): sunlit snow : zenith ≈ 12 : 1
const DISC = 30.0;                         // the sun disc's radiance: well over the bloom threshold, never a white-out
const CURVE = 0.87 / (2 * 6371000);        // the earth's curve with standard refraction (h − d²·CURVE)
const FB = WORLD_FRAME.fightBox;
const FIGHT = { min: [FB.x[0], FB.y[0], FB.z[0]], max: [FB.x[1], FB.y[1], FB.z[1]], centre: [(FB.x[0] + FB.x[1]) / 2, (FB.y[0] + FB.y[1]) / 2, (FB.z[0] + FB.z[1]) / 2], floorY: WORLD_FRAME.planFloorY };
const DECK = { base: WORLD_FRAME.cloudDeck.base, thick: WORLD_FRAME.cloudDeck.top - WORLD_FRAME.cloudDeck.base };   // 4,700-5,150 m: the valleys fill, ridges stand through
const WIND = [4.0, 1.5];                   // m/s, clouds drift ENE-ish (pure in t)

const DEM_FILE = '../assets/climb/hunza_cop30_n36e074.png';

// r7: THE GROUND PAST THE MAP'S EAST EDGE. The v3 site is 372 pixels (10.9 km) from the tile's east edge, and the face shots
// look ENE, so the old clamp (140 near columns repeating the edge column) and the far mirror (a straight N-S crease and the
// peaks by the edge doubled) were in shot. Past a fold line 0.3-1.1 km inside the edge (wiggly, so it never reads as a straight
// line) the ground is the fold's mirror, crossfading over 3 km into a copy of the range 3,400 px west and 760 px north (the
// best height match to the edge band, lanes/jet-world/tools/contscan.mjs). Nothing within 9.8 km of the fight changes; the
// mirror's crease is the only kink and it meanders like a ridge or a gully. CPU (contH) and GPU (farH) share the formula.
const CONT_PX = [3400, -760];
const foldX = (C, z) => C.e0 + C.a * (0.6 * Math.sin(z / 2300 + 1.3) + 0.4 * Math.sin(z / 970 + 0.4));
function contH(C, x, z, s) {
    if (x <= C.e0 - C.a) return s(x, z);
    const E = foldX(C, z);
    if (x <= E) return s(x, z);
    const k = smooth(E, E + 3000, x);
    return s(2 * E - x, z) * (1 - k) + s(x - C.sx, z - C.sz) * k;
}
const NO_CONT = Object.freeze({ e0: 1e9, a: 0, sx: 0, sz: 0 });

// ================================================================== the DEM (decoder copied from climbarena.js loadDem)
async function loadHeights() {
    const meta = await (await fetch(DEM_FILE.replace(/\.png$/, '.json'), { cache: 'no-store' })).json();
    const buf = new Uint8Array(await (await fetch(DEM_FILE)).arrayBuffer());
    const dv = new DataView(buf.buffer);
    let p = 8, W = 0, H = 0;
    const idat = [];
    while (p < buf.length) {
        const len = dv.getUint32(p), type = String.fromCharCode(buf[p + 4], buf[p + 5], buf[p + 6], buf[p + 7]);
        if (type === 'IHDR') { W = dv.getUint32(p + 8); H = dv.getUint32(p + 12); if (buf[p + 16] !== 16 || buf[p + 17] !== 0 || buf[p + 20]) throw new Error('not a 16-bit grey PNG'); }
        else if (type === 'IDAT') idat.push(buf.subarray(p + 8, p + 8 + len));
        else if (type === 'IEND') break;
        p += 12 + len;
    }
    const raw = new Uint8Array(await new Response(new Blob(idat).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
    const st = W * 2, img = new Uint8Array(H * st);
    for (let y = 0; y < H; y++) {
        const f = raw[y * (st + 1)], r0 = y * (st + 1) + 1, o = y * st, u = o - st;
        for (let i = 0; i < st; i++) {
            const x = raw[r0 + i], a = i >= 2 ? img[o + i - 2] : 0, b = y ? img[u + i] : 0, c = i >= 2 && y ? img[u + i - 2] : 0;
            let v;
            if (f === 0) v = x; else if (f === 1) v = x + a; else if (f === 2) v = x + b; else if (f === 3) v = x + ((a + b) >> 1);
            else { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
            img[o + i] = v & 255;
        }
    }
    const k = (meta.max_m - meta.min_m) / 65535, base = meta.min_m - DATUM;
    const hAt = (x, y) => base + ((img[(y * W + x) * 2] << 8) | img[(y * W + x) * 2 + 1]) * k;
    const lat0 = meta.north_lat - (SITE.py / (H - 1)) * (meta.north_lat - meta.south_lat);
    const dx = (111320 * Math.cos(lat0 * DEG) * (meta.east_lon - meta.west_lon)) / (W - 1), dz = (110574 * (meta.north_lat - meta.south_lat)) / (H - 1);
    // the continuation past the east edge (contH); the fold sits 0.3-1.1 km inside the edge
    const edge = (W - 1 - SITE.px) * dx, cont = { e0: edge - 700, a: 400, sx: CONT_PX[0] * dx, sz: -CONT_PX[1] * dz };
    // the full-resolution tile at a world point (bilinear, mirrored past its edges like the far texture), for the near window
    const mi = (i, n) => { i = ((i % (2 * n)) + 2 * n) % (2 * n); return i < n ? i : 2 * n - 1 - i; };
    const hBil = (x, z) => {
        const fx = x / dx + SITE.px, fz = z / dz + SITE.py, i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j;
        const i0 = mi(i, W), i1 = mi(i + 1, W), j0 = mi(j, H), j1 = mi(j + 1, H);
        return (hAt(i0, j0) * (1 - u) + hAt(i1, j0) * u) * (1 - v) + (hAt(i0, j1) * (1 - u) + hAt(i1, j1) * u) * v;
    };
    // near: 1,024² at full resolution around the site (its east 140 columns are past the map: the continuation); far: the
    // whole tile, 2x2 averaged (continued on the GPU, farH)
    const NN = 1024, nx0 = SITE.px - NN / 2, ny0 = SITE.py - NN / 2, near = new Float32Array(NN * NN);
    for (let y = 0; y < NN; y++) for (let x = 0; x < NN; x++) {
        const px = nx0 + x, py = ny0 + y;
        near[y * NN + x] = px >= 0 && px < W && py >= 0 && py < H && (px - SITE.px) * dx <= cont.e0 - cont.a ? hAt(px, py) : contH(cont, (px - SITE.px) * dx, (py - SITE.py) * dz, hBil);
    }
    const FN = W / 2, far = new Float32Array(FN * FN);
    for (let y = 0; y < FN; y++) for (let x = 0; x < FN; x++) far[y * FN + x] = 0.25 * (hAt(2 * x, 2 * y) + hAt(2 * x + 1, 2 * y) + hAt(2 * x, 2 * y + 1) + hAt(2 * x + 1, 2 * y + 1));
    return {
        near: { data: near, n: NN, x0: (nx0 - SITE.px) * dx, z0: (ny0 - SITE.py) * dz, dx, dz },
        far: { data: far, n: FN, x0: (0.5 - SITE.px) * dx, z0: (0.5 - SITE.py) * dz, dx: 2 * dx, dz: 2 * dz },
        credit: meta.credit, cont,
    };
}
// A stand-in when the DEM is missing (noAssets): ridged ranges of the same scale, so the page still works.
function proceduralHeights() {
    const N = 512, data = new Float32Array(N * N), rnd = mulberry32(11), g = new Float32Array(66 * 66);
    for (let i = 0; i < g.length; i++) g[i] = rnd();
    const vn = (x, y) => { const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j, ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy), G = (a, b) => g[((b & 63) * 66) + (a & 63)];
        return (G(i, j) * (1 - ux) + G(i + 1, j) * ux) * (1 - uy) + (G(i, j + 1) * (1 - ux) + G(i + 1, j + 1) * ux) * uy; };
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        let s = 0, a = 1, f = 1 / 24;
        for (let o = 0; o < 6; o++) { const n = 1 - Math.abs(vn(x * f, y * f) * 2 - 1); s += a * n * n; a *= 0.5; f *= 2; }
        data[y * N + x] = -1400 + s * 2600;
    }
    const d = 120;
    return { near: null, far: { data, n: N, x0: -N / 2 * d, z0: -N / 2 * d, dx: d, dz: d }, credit: null, cont: NO_CONT };
}

// CPU twins of the GPU sampling (LinearFilter; far = MirroredRepeat, near = ClampToEdge)
function sampler(T, mirror) {
    const n = T.n, m = (i) => { if (!mirror) return clamp(i, 0, n - 1); i = ((i % (2 * n)) + 2 * n) % (2 * n); return i < n ? i : 2 * n - 1 - i; };
    return (x, z) => {
        const fx = (x - T.x0) / T.dx, fz = (z - T.z0) / T.dz, i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j;
        const i0 = m(i), i1 = m(i + 1), j0 = m(j), j1 = m(j + 1), D = T.data;
        return (D[j0 * n + i0] * (1 - u) + D[j0 * n + i1] * u) * (1 - v) + (D[j1 * n + i0] * (1 - u) + D[j1 * n + i1] * u) * v;
    };
}

// ================================================================== GLSL
const GLSL_COMMON = /* glsl */`
#define PI_ 3.14159265
uniform sampler2D uHNear, uHFar, uShNear, uShFar, uNoise;
uniform vec4 uNearR, uFarR;     // x0, z0 (texel 0's centre, world m), 1/dx, 1/dz
uniform float uNearN, uFarN, uNearOn;
uniform vec4 uShFarR; uniform float uShFarN;   // r7: the far shadow bake has its own square, centred on the site (+-60 km)
uniform vec4 uCont;             // r7: the ground past the map's east edge (contH): fold mean x, wiggle, copy shift x, z
uniform vec3 uSunDir, uSunCol; uniform float uSunE;
uniform vec3 uAmbUp, uAmbHor;
uniform vec3 uHazeLUT[32];
uniform vec3 uBetaR, uBetaM;
uniform float uTime; uniform vec2 uWind;
uniform float uDeckY, uDeckT;
const float DATUM_ = ${DATUM.toFixed(1)};
const float CURVE_ = ${CURVE.toExponential(6)};

vec2 nearUV(vec2 p) { return ((p - uNearR.xy) * uNearR.zw + 0.5) / uNearN; }
vec2 farUV(vec2 p) { return ((p - uFarR.xy) * uFarR.zw + 0.5) / uFarN; }
float nearW(vec2 un) { vec2 e = min(un, 1.0 - un); return uNearOn * smoothstep(0.0, 0.06, min(e.x, e.y)); }
float tn(vec2 p);
// relief below the DEM's 29 m (ridged, 170 m and 63 m, plus 23 m grit): jagged crests instead of 30 m blobs. The CPU twin is
// detailAt() in buildJetWorld (the same texels of the same noise), so terrainHeightAt() matches what is drawn.
float detailH(vec2 p) {
    float r1 = 1.0 - abs(tn(p / 170.0) * 2.0 - 1.0); r1 = r1 * r1 * r1;      // knife-edge crests
    float r2 = 1.0 - abs(tn(p / 63.0 + 40.0) * 2.0 - 1.0); r2 = r2 * r2 * r2;
    float g3 = 1.0 - abs(tn(p / 95.0 + 77.0) * 2.0 - 1.0); g3 = g3 * g3 * g3;   // couloirs: sharp grooves cut down the faces
    return 46.0 * (r1 - 0.3) + 14.0 * (r2 - 0.3) * (0.5 + r1) - 16.0 * (g3 - 0.3) + 2.0 * (tn(p / 23.0 + 90.0) - 0.5);
}
// the far DEM, continued past the map's east edge (GPU twin of contH + foldX)
float farH(vec2 p) {
    float h = textureLod(uHFar, farUV(p), 0.0).r;
    if (p.x > uCont.x - uCont.y) {
        float E = uCont.x + uCont.y * (0.6 * sin(p.y / 2300.0 + 1.3) + 0.4 * sin(p.y / 970.0 + 0.4));
        if (p.x > E) h = mix(textureLod(uHFar, farUV(vec2(2.0 * E - p.x, p.y)), 0.0).r, textureLod(uHFar, farUV(p - uCont.zw), 0.0).r, smoothstep(E, E + 3000.0, p.x));
    }
    return h;
}
float terrainH(vec2 p) {
    float h = farH(p);
    vec2 un = nearUV(p); float w = nearW(un);
    if (w > 0.0) h = mix(h, textureLod(uHNear, un, 0.0).r, w);
    return h + detailH(p) - dot(p, p) * CURVE_;
}
// r6: the DEM alone, no relief and no curve -- only the terrain shader's snow uses it, for the slope a snowfield sees
float demH(vec2 p) {
    float h = farH(p);
    vec2 un = nearUV(p); float w = nearW(un);
    if (w > 0.0) h = mix(h, textureLod(uHNear, un, 0.0).r, w);
    return h;
}
// x: sun visibility on the ground (soft), y: sky visibility (valley occlusion), z: sun visibility at the cloud sea's height
vec3 shadowAt(vec2 p) {
    vec2 uf = ((p - uShFarR.xy) * uShFarR.zw + 0.5) / uShFarN, ef = min(uf, 1.0 - uf);
    vec3 s = ef.x < 0.0 || ef.y < 0.0 ? vec3(1.0) : textureLod(uShFar, uf, 0.0).rgb;
    vec2 un = nearUV(p); float w = nearW(un);
    if (w > 0.0) s = mix(s, textureLod(uShNear, un, 0.0).rgb, w);
    return s;
}

// smooth value noise from a 256² random texture (p in texels)
float tn(vec2 p) { p += 0.5; vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f); return textureLod(uNoise, (i + f - 0.5) / 256.0, 0.0).r; }
float hash13(vec3 p3) { p3 = fract(p3 * 0.1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
float vnoise3(vec3 x) {
    vec3 i = floor(x), f = fract(x), u = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash13(i), hash13(i + vec3(1, 0, 0)), u.x), mix(hash13(i + vec3(0, 1, 0)), hash13(i + vec3(1, 1, 0)), u.x), u.y),
               mix(mix(hash13(i + vec3(0, 0, 1)), hash13(i + vec3(1, 0, 1)), u.x), mix(hash13(i + vec3(0, 1, 1)), hash13(i + vec3(1, 1, 1)), u.x), u.y), u.z);
}
vec4 noised3(vec3 x) {
    vec3 i = floor(x), f = fract(x), u = f * f * (3.0 - 2.0 * f), du = 6.0 * f * (1.0 - f);
    float a = hash13(i), b = hash13(i + vec3(1, 0, 0)), c = hash13(i + vec3(0, 1, 0)), d = hash13(i + vec3(1, 1, 0));
    float e = hash13(i + vec3(0, 0, 1)), f1 = hash13(i + vec3(1, 0, 1)), g = hash13(i + vec3(0, 1, 1)), h = hash13(i + vec3(1, 1, 1));
    float k1 = b - a, k2 = c - a, k3 = e - a, k4 = a - b - c + d, k5 = a - c - e + g, k6 = a - b - e + f1, k7 = -a + b + c - d + e - f1 - g + h;
    return vec4(a + k1 * u.x + k2 * u.y + k3 * u.z + k4 * u.x * u.y + k5 * u.y * u.z + k6 * u.z * u.x + k7 * u.x * u.y * u.z,
        du * vec3(k1 + k4 * u.y + k6 * u.z + k7 * u.y * u.z, k2 + k5 * u.z + k4 * u.x + k7 * u.z * u.x, k3 + k6 * u.x + k5 * u.y + k7 * u.x * u.y));
}
float hg(float c, float g) { float g2 = g * g; return (1.0 - g2) / (4.0 * PI_ * pow(1.0 + g2 - 2.0 * g * c, 1.5)); }

// the haze (climbarena.js GLSL_HAZE, integrated exactly over the ray's height change, colour per azimuth)
vec3 hazeSky(vec3 dir) {
    float f = (atan(dir.x, -dir.z) / 6.2831853 + 0.5) * 32.0, i = floor(f);
    return mix(uHazeLUT[int(mod(i, 32.0))], uHazeLUT[int(mod(i + 1.0, 32.0))], f - i);
}
float odExp(float y0, float y1, float d, float H) {   // ∫ exp(-y/H) ds along a straight ray, heights above the sea
    float dy = y1 - y0;
    return abs(dy) < 1.0 ? d * exp(-0.5 * (y0 + y1) / H) : d * H * (exp(-y0 / H) - exp(-y1 / H)) / dy;
}
vec3 applyHaze(vec3 col, vec3 wp, vec3 cam) {
    vec3 v = wp - cam; float d = length(v);
    float y0 = cam.y + DATUM_, y1 = wp.y + DATUM_;
    vec3 tau = uBetaR * odExp(y0, y1, d, 8000.0) + uBetaM * odExp(y0, y1, d, 2000.0);
    vec3 T = exp(-tau);
    // r6: a valley haze, dense low (scale height 700 m over 3,500 m: exp(3500/700) = 148.41), thin at the fight height
    vec3 Tv = exp(-vec3(0.75e-4, 0.85e-4, 1.0e-4) * 148.41 * odExp(y0, y1, d, 700.0));
    vec3 dir = v / max(d, 1e-3);
    float sw = dot(normalize(dir.xz + 1e-5), normalize(uSunDir.xz)) * 0.5 + 0.5;
    vec3 ins = hazeSky(dir) * mix(vec3(0.82, 0.86, 1.12), vec3(1.12, 0.95, 0.78), sw * sw) + uSunCol * uSunE * 0.011 * hg(dot(dir, uSunDir), 0.75);
    vec3 insV = hazeSky(dir) * mix(vec3(0.42, 0.5, 0.78), vec3(1.0, 0.82, 0.62), sw * sw * sw);
    return (col * Tv + insV * (1.0 - Tv)) * T + ins * (1.0 - T);
}

// the cloud sea: its top above the deck base, metres (<= 0: clear air). oct = octaves (fewer far away)
float deckField(vec2 xz, float oct) {
    vec2 q = xz - uWind * uTime;
    float big = tn(q / 7000.0 + 31.0);
    float f = 0.0, a = 0.5, norm = 0.0; vec2 s = q / 1300.0;
    for (int i = 0; i < 5; i++) { float w = clamp(oct - float(i), 0.0, 1.0); f += a * mix(0.5, tn(s), w); norm += a; s = s * 2.07 + 17.3; a *= 0.5; }
    f = (f / norm - 0.5) * 1.9 + 0.5;   // value-noise fbm huddles round 0.5: stretch it to 0..1
    float cov = mix(0.15, 0.8, smoothstep(0.25, 0.75, big));   // r6: a sea that fills the valleys, not a field of puffs
    return f - (1.0 - cov);
}
float deckTop(vec2 xz, float oct) {
    float m = deckField(xz, oct);
    return m > 0.0 ? uDeckT * smoothstep(0.0, 0.45, m) : m * uDeckT * 3.2;   // r6: broad flat tops, sloping edges (no mesa walls)
}
`;
const LOGV = '#include <common>\n#include <logdepthbuf_pars_vertex>\n';
const LOGF = '#include <common>\n#include <logdepthbuf_pars_fragment>\n';

// --- terrain
const TERRAIN_VS = /* glsl */`
${LOGV}${GLSL_COMMON}
uniform float uDiscard;   // the far mesh skips the square the near mesh covers
varying vec3 vW;
void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    float sk = position.y;           // the near mesh's skirt: y < 0 marks a skirt vertex (hangs 250 m)
    w.y = terrainH(w.xz) + min(sk, 0.0) * 250.0;
    vW = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
    #include <logdepthbuf_vertex>
}`;
const TERRAIN_FS = /* glsl */`
${LOGF}${GLSL_COMMON}
uniform float uDiscard;
varying vec3 vW;
void main() {
    if (uDiscard > 0.0 && max(abs(vW.x), abs(vW.z)) < uDiscard) discard;
    #include <logdepthbuf_fragment>
    vec3 cam = cameraPosition;
    float dist = length(vW - cam);
    float e = max(14.0, dist * 0.0022);
    vec2 p = vW.xz;
    float hxp = terrainH(p + vec2(e, 0.0)), hxm = terrainH(p - vec2(e, 0.0)), hzp = terrainH(p + vec2(0.0, e)), hzm = terrainH(p - vec2(0.0, e));
    float hx = hxp - hxm, hz = hzp - hzm;
    vec3 N0 = normalize(vec3(-hx, 2.0 * e, -hz));
    float slope = 1.0 - N0.y;   // 0.18 = 35 deg, 0.23 = 40 deg
    float alt = vW.y + DATUM_;
    // r6: detail by the pixel's footprint, not by distance: the long lenses see a face 2 km off at half a metre a pixel, and
    // a distance fade left it a smooth relief map. An octave of wavelength L is kept while it spans more than ~3 pixels.
    float px = max(length(dFdx(vW)), length(dFdy(vW)));
    #define KEEP(L) (1.0 - smoothstep((L) / 6.0, (L) / 2.5, px))
    float n1 = tn(p / 260.0), n2 = mix(0.5, tn(p / 47.0 + 9.0), KEEP(47.0)), n3 = mix(0.5, tn(p / 9.0 + 4.0), KEEP(9.0));
    float n4 = mix(0.5, tn(p / 2.7 + 13.0), KEEP(2.7));   // grit
    // r7: the normal detail fades by the pixel's footprint too (it faded by distance, 2.5-14 km): the same as before through a
    // 55 deg lens (1.9 m a pixel at 2.5 km, 10.5 m at 14 km), but DIRECT's 2.5-12 deg ridge lenses look 8-12 km off at 0.3-1 m a
    // pixel, and there the faces had gone to smooth clay
    float fd = 1.0 - smoothstep(1.9, 10.5, px), fn = KEEP(11.0);
    // the slope a snowfield sees: the DEM over +-45 m. The 29 m bumps and the relief broke every snowfield into camouflage blobs.
    float eL = max(45.0, e * 2.0);
    float dxm = demH(p - vec2(eL, 0.0)), dxp = demH(p + vec2(eL, 0.0)), dzm = demH(p - vec2(0.0, eL)), dzp = demH(p + vec2(0.0, eL));
    float slopeL = 1.0 - normalize(vec3(dxm - dxp, 2.0 * eL, dzm - dzp)).y;
    float slopeS = mix(slopeL, slope, 0.2);   // the relief's own steep flanks still bare a little rock
    float cvL = clamp((dxm + dxp + dzm + dzp - 4.0 * demH(p)) / (4.0 * eL), -0.5, 0.5);   // the DEM's hollows and crests
    // r6: the form of the ground, not only its slope. cv > 0 in a gully or a hollow (snow collects), < 0 on a crest or a rib
    // (the wind strips it to rock): the mean rise of the four neighbours over e, so a ~1-in-20 dent reads.
    float cv = clamp((hxp + hxm + hzp + hzm - 4.0 * terrainH(p)) / (4.0 * e), -0.5, 0.5);
    // the fall line: flutings, ribs and couloirs run straight down a face (the signature of a Himalayan wall seen from the air).
    // Drawn biplanar -- streaks in (x, height) on faces looking north or south, (z, height) on faces looking east or west -- so
    // they stay straight; projected along the local gradient instead they curled into whorls on every rounded crest.
    float wx = N0.x * N0.x / max(N0.x * N0.x + N0.z * N0.z, 1e-4);
    float fl1 = mix(0.5, mix(tn(vec2(p.x / 11.0, vW.y / 90.0) + 21.0), tn(vec2(p.y / 11.0, vW.y / 90.0) + 23.0), wx), fn);   // fades before it sparkles
    float fl2 = mix(tn(vec2(p.x / 34.0, vW.y / 300.0) + 57.0), tn(vec2(p.y / 34.0, vW.y / 300.0) + 59.0), wx);
    float flute = fl1 * 0.45 + fl2 * 0.55;
    vec2 gd = normalize(vec2(hx, hz) + 1e-4), across = vec2(-gd.y, gd.x);   // (the glaciers' moraines still run with the flow)
    // snow holds only below ~35-40 deg; hollows hold it steeper, crests lose it sooner; on a steep face it survives in flutes
    float rockM = smoothstep(0.19, 0.27, slopeS + 0.07 * (n2 - 0.5) + 0.05 * (n3 - 0.5) + 0.05 * (n4 - 0.5) + 0.1 * (flute - 0.5) - 0.5 * cvL - 0.15 * cv);   // edges run down the fall line; the relief's worms no longer pattern the snow
    float flutes = smoothstep(0.56, 0.7, flute) * (1.0 - smoothstep(0.3, 0.46, slopeS)) * rockM;   // snow left in the flutes
    vec3 N = N0;
    if (fd > 0.0) {
        vec4 r1 = noised3(vW / 28.0 + 1.7), r2 = noised3(vW / 7.0 + 3.1), r3 = noised3(vW / 2.2 + 5.3), s1 = noised3(vW / 60.0), s2 = noised3(vW / 14.0 + 8.1);
        // ribs across the fall line (the flutes' own relief) plus the rock's grain; snow keeps a soft wind-sculpted swell
        float ribZ = (tn(vec2(p.x / 11.0 + 0.35, vW.y / 90.0) + 21.0) - tn(vec2(p.x / 11.0 - 0.35, vW.y / 90.0) + 21.0)) * 1.4 * fn
                   + (tn(vec2(p.x / 34.0 + 0.35, vW.y / 300.0) + 57.0) - tn(vec2(p.x / 34.0 - 0.35, vW.y / 300.0) + 57.0)) * 0.9;
        float ribX = (tn(vec2(p.y / 11.0 + 0.35, vW.y / 90.0) + 23.0) - tn(vec2(p.y / 11.0 - 0.35, vW.y / 90.0) + 23.0)) * 1.4 * fn
                   + (tn(vec2(p.y / 34.0 + 0.35, vW.y / 300.0) + 59.0) - tn(vec2(p.y / 34.0 - 0.35, vW.y / 300.0) + 59.0)) * 0.9;
        vec3 ribG = vec3(ribZ * (1.0 - wx), 0.0, ribX * wx) * smoothstep(0.08, 0.2, slope);
        vec3 g = (r1.yzw * 0.6 * KEEP(28.0) + r2.yzw * 0.45 * KEEP(7.0) + r3.yzw * 0.35 * KEEP(2.2)) * rockM
               + (s1.yzw * 0.16 + s2.yzw * 0.08 * KEEP(14.0)) * (1.0 - rockM) + ribG * (0.35 + 0.65 * rockM);
        N = normalize(N0 - fd * (g - N0 * dot(g, N0)));
    }
    vec3 rock = mix(vec3(0.065, 0.063, 0.062), vec3(0.135, 0.128, 0.122), n2) * (0.75 + 0.5 * n3);   // dark gneiss and granite (r6: greyer)
    // (r6: the strata bands are gone -- on the DEM's smooth slopes their fract() drew contour lines, a wood grain on the rock)
    rock *= (0.8 + 0.4 * fl1) * (0.75 + 0.5 * n4);   // dark wet streaks down the rock between the flutes, and its grit
    vec3 scree = mix(vec3(0.18, 0.16, 0.14), vec3(0.25, 0.22, 0.19), n1);
    vec3 base = mix(scree, rock, smoothstep(0.12, 0.22, slopeS + 0.2 * (n2 - 0.5)));
    float north = clamp(-N0.z, 0.0, 1.0);
    float line = 4050.0 + 500.0 * (n1 - 0.5) - 350.0 * north - 250.0 * clamp(cvL * 4.0, -1.0, 1.0);
    float snow = smoothstep(line, line + 300.0, alt) * max(1.0 - rockM, flutes * 0.85);
    // r6: 0.68, not 0.84: sunlit snow at ~0.8 before tone mapping keeps its rose-gold under ACES instead of going white
    vec3 snowC = vec3(0.67, 0.69, 0.73) * (0.93 + 0.1 * n3) * (0.97 + 0.06 * n4);
    // glaciers in the flat valley floors: grey ice under dark medial moraines that run with the flow (down the slope)
    float mor = tn(vec2(dot(p, across) / 35.0, dot(p, gd) / 900.0) + 70.0);
    float glac = (1.0 - smoothstep(0.05, 0.16, slope)) * smoothstep(2700.0, 3200.0, alt) * (1.0 - smoothstep(4300.0, 4600.0, alt));
    vec3 ice = mix(vec3(0.42, 0.44, 0.46), vec3(0.11, 0.10, 0.095), smoothstep(0.5, 0.75, mor) * (1.0 - smoothstep(4000.0, 4600.0, alt)));
    base = mix(base, ice, glac);
    snow *= 1.0 - glac * (1.0 - smoothstep(3900.0, 4500.0, alt));
    vec3 alb = mix(base, snowC, snow);
    // light
    vec3 sh = shadowAt(p);
    float vis = sh.x;
    if (vW.y < uDeckY + uDeckT) {   // the cloud sea's shadow on the ground under it
        vec2 sxz = normalize(uSunDir.xz); float tE = uSunDir.y / length(uSunDir.xz);
        vec2 q = p + sxz * ((uDeckY + 0.5 * uDeckT - vW.y) / tE);
        vis *= 1.0 - 0.85 * smoothstep(0.0, 0.08, deckField(q, 3.0));
    }
    float ndl = max(dot(N, uSunDir), 0.0);
    // alpenglow: sunlit snow goes pink-orange; the shade stays cool blue-violet (the sunset's warm/cool split, research A7)
    vec3 sun = uSunCol * mix(vec3(1.0), vec3(1.0, 0.8, 0.72), snow) * uSunE * ndl * vis / PI_;   // r6: rose-gold, not lavender
    // r6: the shade is lit by the blue-violet sky, not by the warm horizon average: cool blue shadows against the warm sun
    vec3 Nh = normalize(vec3(N.x, 0.0, N.z) + vec3(1e-4, 0.0, 0.0)), hN = hazeSky(Nh);
    hN /= max(1.0, max(hN.r, max(hN.g, hN.b)) / 0.6);                               // the sky the face looks at, its hue kept
    float fs = dot(Nh.xz, normalize(uSunDir.xz)) * 0.5 + 0.5;
    vec3 skyH = hN * mix(vec3(0.6, 0.72, 1.15), vec3(1.0), fs * fs) * 0.45;          // a face toward the glow takes it warm
    // an upward face sees the whole dome, horizon included, not only the zenith: with the zenith alone, flat snow in the shade
    // was darker than the slopes round it and every shaded snowfield read as rippled water
    vec3 skyUp = mix(uAmbUp, uAmbHor * vec3(0.6, 0.72, 1.15) * 0.5, 0.6) * vec3(0.9, 0.95, 1.15);
    vec3 sky = mix(skyH, skyUp, clamp(N.y * 0.6 + 0.4, 0.0, 1.0)) * 1.2 * (0.3 + 0.7 * sh.y);
    vec3 bounce = vec3(0.30, 0.27, 0.25) * 0.18 * (1.0 - N.y) * 0.5;   // light off the sunlit snow opposite
    vec3 col = alb * (sun + sky + bounce);
    col = applyHaze(col, vW, cam);
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
}`;

// --- the sky: single scattering through a real atmosphere (Rayleigh + Mie, the earth's curve), seen from 7 km; baked once
const SKY_VS = /* glsl */`varying vec3 vDir; void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const SKY_FS = /* glsl */`
uniform vec3 uSunDir, uSunCol; uniform float uScale, uDisc, uObsH, uRaw; uniform vec2 uSeedSky;
varying vec3 vDir;
const float RP = 6371e3, RA = 6471e3, HR = 8000.0, HM = 2000.0;
const vec3 BR = vec3(5.8e-6, 13.5e-6, 33.1e-6); const float BM = 3.5e-5;
const vec3 BO = vec3(0.65e-6, 1.88e-6, 0.085e-6);   // ozone (absorbs; a layer round 25 km): the deep blue overhead, the saturated band
float ozone(float h) { return max(0.0, 1.0 - abs(h - 25000.0) / 15000.0); }
vec2 rsi(vec3 o, vec3 d, float r) { float b = dot(o, d), c = dot(o, o) - r * r, h = b * b - c; if (h < 0.0) return vec2(1e9, -1e9); h = sqrt(h); return vec2(-b - h, -b + h); }
float hash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vn(vec2 p) { vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f); return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y); }
void main() {
    vec3 rd = normalize(vDir), ro = vec3(0.0, RP + uObsH, 0.0);
    vec2 pa = rsi(ro, rd, RA), pg = rsi(ro, rd, RP);
    float t1 = pa.y; if (pg.x > 0.0) t1 = min(t1, pg.x);
    float ds = t1 / 40.0, odR = 0.0, odM = 0.0, odO = 0.0, mu = dot(rd, uSunDir);
    vec3 sR = vec3(0.0), sM = vec3(0.0);
    for (int i = 0; i < 40; i++) {
        vec3 x = ro + rd * (ds * (float(i) + 0.5));
        float h = length(x) - RP, dR = exp(-h / HR) * ds, dM = exp(-h / HM) * ds;
        odR += dR; odM += dM; odO += ozone(h) * ds;
        if (rsi(x, uSunDir, RP).x > 0.0) continue;   // the earth's shadow
        float dl = rsi(x, uSunDir, RA).y / 12.0, lR = 0.0, lM = 0.0, lO = 0.0;
        for (int j = 0; j < 12; j++) { float hl = length(x + uSunDir * (dl * (float(j) + 0.5))) - RP; lR += exp(-hl / HR) * dl; lM += exp(-hl / HM) * dl; lO += ozone(hl) * dl; }
        vec3 att = exp(-(BR * (odR + lR) + BM * 1.1 * (odM + lM) + BO * (odO + lO)));
        sR += dR * att; sM += dM * att;
    }
    float g = 0.78, pR = 0.0596831 * (1.0 + mu * mu), pM = 0.1193662 * (1.0 - g * g) * (1.0 + mu * mu) / ((2.0 + g * g) * pow(1.0 + g * g - 2.0 * g * mu, 1.5));
    vec3 col = 20.0 * (pR * BR * sR + pM * BM * sM);
    vec3 Tv = exp(-(BR * odR + BM * 1.1 * odM + BO * odO));   // what the air lets through to the eye along this direction
    col *= uScale;
    if (uRaw > 0.5) { gl_FragColor = vec4(col, 1.0); return; }   // r6: the calibration reads the physical zenith, before the grade
    // r6: the sunset is PAINTED, in absolute radiance, and the physical sky kept only as a fifth of the mix. Graded from the
    // physics (lum-relative bands, review r5) it stayed a pale "pink afternoon": the single-scattering sky at 7 deg is bright
    // and white nearly everywhere. The photograph's gradient instead: deep orange at the line toward the sun, gold, peach, a
    // violet dusk band, deep blue overhead; opposite, the blue-grey shadow of the earth under the pink Belt of Venus.
    vec2 hs = normalize(uSunDir.xz), hd = normalize(rd.xz + 1e-5);
    float ca = dot(hs, hd), sw = clamp(ca * 0.5 + 0.5, 0.0, 1.0), sunward = pow(max(ca, 0.0), 1.3), anti = pow(max(-ca, 0.0), 1.2), el = max(rd.y + 0.035, 0.0);
    float ang = acos(clamp(mu, -1.0, 1.0));
    vec3 hor = mix(mix(vec3(0.13, 0.13, 0.22), vec3(0.46, 0.29, 0.22), smoothstep(0.45, 0.85, sw)), vec3(1.45, 0.62, 0.16), pow(sw, 4.0));   // blue-grey, peach, orange
    vec3 lowB = mix(vec3(0.95, 0.42, 0.14), vec3(0.75, 0.3, 0.08), exp(-el / 0.02));   // the band's deep orange right at the line
    hor = mix(hor, lowB, pow(sw, 8.0) * exp(-el / 0.05) * 0.6);
    vec3 midC = mix(vec3(0.05, 0.07, 0.17), vec3(0.2, 0.13, 0.19), pow(sw, 3.0));   // ~15-25 deg: blue, violet toward the sun
    vec3 art = mix(hor, midC, smoothstep(0.0, mix(0.16, 0.34, pow(sw, 2.0)), el));
    art = mix(art, vec3(0.022, 0.036, 0.095), smoothstep(0.25, 0.9, el));                 // deep blue overhead
    float belt = smoothstep(0.05, 0.1, el) * (1.0 - smoothstep(0.16, 0.28, el)), eshadow = 1.0 - smoothstep(0.0, 0.06, el);
    art = mix(art, vec3(0.44, 0.22, 0.3), belt * anti * 0.85);                             // the Belt of Venus
    art = mix(art, vec3(0.07, 0.09, 0.2), eshadow * anti * 0.7);                            // the earth's shadow under it
    // the physical sky, its low sunward light reddened by the same dust that reddens SUN_COL (x (1, 0.74, 0.5))
    float dw = exp(-el / 0.22) * (0.35 + 0.65 * sunward) + 0.75 * exp(-ang / 0.3);
    col *= mix(vec3(1.0), vec3(1.0, 0.6, 0.3), clamp(dw, 0.0, 1.0));
    col = mix(art, col * vec3(0.8, 0.85, 1.0), 0.12);
    // the glow round the low sun: ~3.5 next to the disc (over the bloom threshold, so the bloom draws the glare), ~0.8 five
    // degrees out, a warm wash ~25 degrees round; gold near the disc, orange further out
    float lowk = 0.6 + 0.4 * exp(-el / 0.12);
    vec3 gIn = vec3(1.0, 0.64, 0.3), gOut = vec3(1.0, 0.38, 0.1);
    col += gIn * 2.6 * exp(-ang / 0.02) + mix(gIn, gOut, 0.6) * 0.8 * exp(-ang / 0.07) * lowk + gOut * 0.3 * exp(-ang / 0.28) * lowk;
    // high cirrus (~10 km above): thin streaks lit by the low sun, warm, brightest toward it
    if (rd.y > 0.0) {
        vec2 q = rd.xz / (rd.y + 0.04) * 3.2 + uSeedSky;
        vec2 qs = vec2(q.x * 0.45 + q.y * 0.25, q.y * 1.6 - q.x * 0.5);   // stretched along the jet stream
        float c = vn(qs) * 0.55 + vn(qs * 2.3 + 7.0) * 0.3 + vn(qs * 5.1 + 3.0) * 0.15;
        c = smoothstep(0.52, 0.85, c) * smoothstep(0.0, 0.08, rd.y) * smoothstep(0.85, 0.35, rd.y) * smoothstep(0.25, 0.6, vn(q * 0.18 + 11.0));
        float pc = 0.64 / (12.566 * pow(1.36 - 1.2 * mu, 1.5));
        vec3 lit = uSunCol * mix(vec3(1.0, 0.9, 0.95), vec3(1.0, 1.1, 1.9), anti) * (0.6 + 1.2 * pc) * mix(vec3(1.0), Tv, 0.4);   // pink opposite the sun   // ice crystals lit pink-gold: brighter than the sky
        col = mix(col, lit, c * 0.5);
    }
    // the disc, held to a fixed radiance with a darker limb
    float cd = ang / 0.0095;   // drawn ~1.1 deg across: a low sun on a long lens looks big
    if (cd < 1.0) col += mix(vec3(1.0, 0.86, 0.6), uSunCol, 0.4) * uDisc * (0.55 + 0.45 * sqrt(max(1.0 - cd * cd, 0.0)));
    gl_FragColor = vec4(col, 1.0);
}`;

// --- the shadow / occlusion bake (one full-screen pass per texture)
const BAKE_VS = /* glsl */`varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const BAKE_FS = /* glsl */`
${GLSL_COMMON}
uniform vec4 uR; uniform float uN, uStep;
varying vec2 vUv;
void main() {
    vec2 p = uR.xy + (vUv * uN - 0.5) / uR.zw;
    float hg0 = terrainH(p), h0 = hg0 + 3.0, hd = max(hg0, uDeckY + 0.6 * uDeckT);
    vec2 sxz = normalize(uSunDir.xz); float tE = uSunDir.y / length(uSunDir.xz);
    // the sun: the lowest angle between the ray and the ground ahead, as a soft disc (~0.6° penumbra); the same from the cloud
    // sea's height (B). Steps of 10 m growing to 2.5% of the distance: a coarser march left streaks behind thin ridges.
    float m = 1.0, md = 1.0, t = 12.0;
    for (int i = 0; i < 300; i++) {
        float g = terrainH(p + sxz * t);
        m = min(m, (h0 + tE * t - g) / t);
        md = min(md, (hd + tE * t - g) / t);
        t += clamp(t * uStep, 10.0, 600.0);
        if (t > 60000.0) break;
    }
    float sunV = smoothstep(-0.006, 0.008, m), deckV = smoothstep(-0.006, 0.008, md);
    // the sky: mean horizon height over 8 directions, out to 2.5 km
    float occ = 0.0;
    for (int k = 0; k < 8; k++) {
        float ang = float(k) * 0.785398 + 0.3;
        vec2 dir = vec2(cos(ang), sin(ang));
        float hm = 0.0, s = 40.0;
        for (int j = 0; j < 12; j++) { hm = max(hm, (terrainH(p + dir * s) - h0) / s); s *= 1.32; }
        occ += atan(hm) / 1.5708;
    }
    gl_FragColor = vec4(sunV, clamp(1.0 - occ / 8.0 * 1.3, 0.0, 1.0), deckV, 1.0);
}`;

// --- the cloud sea
const DECK_VS = /* glsl */`
${LOGV}${GLSL_COMMON}
varying vec3 vW;
void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w;
    #include <logdepthbuf_vertex>
}`;
const DECK_FS = /* glsl */`
precision highp sampler3D;
${LOGF}${GLSL_COMMON}
uniform sampler3D uN3;
varying vec3 vW;
// the cloud sea's density: the 2D field sets where it is and how high its top rises, the 3D noise erodes it into billows
float deckD(vec3 p, float oct, bool fine) {
    float y = p.y - uDeckY;
    if (y < 0.0 || y > uDeckT) return 0.0;
    float top = deckTop(p.xz, oct);
    if (top <= 0.0) return 0.0;
    float s = clamp((top - y) / 140.0, 0.0, 1.0) * smoothstep(0.0, 90.0, y);
    if (s <= 0.0) return 0.0;
    vec3 q = p - vec3(uWind.x, 0.0, uWind.y) * uTime;
    float n = texture(uN3, q / 700.0).r;
    s = clamp((s - (1.0 - n) * 0.38) / 0.62, 0.0, 1.0);   // r6: gentler billows (0.45 made it lumps)
    if (fine && s > 0.0) { float w = texture(uN3, q / 140.0 + 0.61).g; float e = mix(1.0 - w, w, smoothstep(0.0, 1.0, y / max(top, 1.0))) * 0.4; s = clamp((s - e) / (1.0 - e), 0.0, 1.0); }
    return s;
}
void main() {
    #include <logdepthbuf_fragment>
    vec3 ro = cameraPosition, rd = normalize(vW - ro);
    if (rd.y > -1e-4) discard;
    float d0 = length(vW - ro);
    float oct = d0 < 12000.0 ? 5.0 : mix(5.0, 3.0, clamp((d0 - 12000.0) / 40000.0, 0.0, 1.0));
    float L = min((uDeckT + 2.0) / -rd.y, 4500.0);   // a grazing ray stops at 4.5 km in the slab: past that the haze has it
    float dt = max(L / 64.0, 8.0), jit = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    float t = dt * jit, T = 1.0, tw = 0.0, wsum = 0.0, c = dot(rd, uSunDir);
    vec3 Lc = vec3(0.0);
    for (int i = 0; i < 80; i++) {
        if (t > L || T < 0.02) break;
        vec3 p = vW + rd * t;
        if (p.y < terrainH(p.xz)) break;   // the ground: what is in front of it stays, it shows through behind
        float d = deckD(p, oct, d0 + t < 25000.0);
        if (d > 0.002) {
            float od = 0.0, s = 25.0; vec3 lp = p;
            for (int k = 0; k < 4; k++) { lp += uSunDir * s; od += deckD(lp, 3.0, false) * s; s *= 2.4; }
            vec3 S = vec3(0.0); float a = 1.0, b = 1.0, g = 1.0;
            for (int o = 0; o < 3; o++) { S += vec3(a * exp(-0.03 * od * b) * (mix(hg(c, 0.72 * g), hg(c, -0.2 * g), 0.3) + 0.06)); a *= 0.45; b *= 0.35; g *= 0.3; }
            float hf = clamp((p.y - uDeckY) / uDeckT, 0.0, 1.0), shT = shadowAt(p.xz).z;
            vec3 Ls = uSunCol * mix(vec3(1.0, 0.85, 1.0), vec3(1.0, 0.92, 0.85), hf) * uSunE * S * 0.75 * shT + mix(min(hazeSky(-normalize(vec3(uSunDir.x, 0.0, uSunDir.z))), vec3(0.5)) * vec3(0.72, 0.78, 1.05) * 0.55, uAmbUp * vec3(1.0, 1.1, 1.4), hf) * (0.45 + 0.55 * hf);   // r6: cool shade, dim enough that the lit rims carry the gold
            float al = 1.0 - exp(-d * 0.03 * dt);
            Lc += T * al * Ls; tw += T * al * t; wsum += T * al;
            T *= 1.0 - al;
        }
        t += dt;
    }
    float alpha = 1.0 - T;
    if (alpha < 0.004) discard;
    vec3 col = applyHaze(Lc / alpha, vW + rd * (tw / max(wsum, 1e-4)), ro);
    gl_FragColor = vec4(col, alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
}`;

// --- the cumulus: each cloud is a box ray-marched through a density field (a few blobs for its shape, eroded by a tiling
// Perlin-Worley 3D texture), lit by a short march toward the sun (Beer's law, three scattering octaves, a forward and a back
// lobe), the sky for ambient. Real volume: it has thickness, a dark base, a gold lit side, wisps and a silver rim.
const CUM_VS = /* glsl */`
${LOGV}${GLSL_COMMON}
varying vec3 vW, vOrg;
void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; vOrg = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz; gl_Position = projectionMatrix * viewMatrix * w;
    #include <logdepthbuf_vertex>
}`;
const CUM_FS = /* glsl */`
precision highp sampler3D;
${LOGF}${GLSL_COMMON}
uniform sampler3D uN3;
uniform vec4 uBlobs[10];
uniform vec3 uHalf, uOff;
uniform float uBaseY, uSig, uFlat;   // uFlat: a blob's height over its width (r6: flat, wide cells, not balls)
varying vec3 vW, vOrg;
const float NOISE_SCALE = 1.0;
float shapeD(vec3 p) {
    float s = 0.0;
    for (int i = 0; i < 10; i++) {
        vec4 b = uBlobs[i];
        if (b.w <= 0.0) break;
        vec3 d = (p - b.xyz) / b.w;
        d.y /= uFlat; d.y *= d.y < 0.0 ? 1.5 : 1.0;   // blobs are wide and flat, flatter still underneath
        s = max(s, 1.0 - dot(d, d));
    }
    return s * smoothstep(uBaseY, uBaseY + 45.0, p.y);   // the flat base at the condensation level
}
float densAt(vec3 p, bool fine) {
    vec3 wp = (texture(uN3, (p + uOff) / 1100.0).rgr - 0.5) * vec3(260.0, 140.0, 260.0);
    float s = shapeD(p + wp);
    if (s <= 0.0) return 0.0;
    vec3 q = p + uOff;
    vec2 n = texture(uN3, q / 480.0).rg;   // r6: billows scaled to the bigger cells (300 / 85 m read as grain)
    float lo = (1.0 - n.r) * 0.85;
    float b = clamp((s - lo) / (1.0 - lo), 0.0, 1.0);
    if (fine && b > 0.0) {
        float w = texture(uN3, q / 150.0 + 0.37).g;
        // erosion: wispy at the edges and the base, billowed (inverted) on the top
        float e = mix(1.0 - w, w, smoothstep(uBaseY, uBaseY + 200.0, p.y)) * 0.55;
        b = clamp((b - e) / (1.0 - e), 0.0, 1.0);
    }
    return b;
}
vec2 boxHit(vec3 ro, vec3 rd, vec3 h) {
    vec3 inv = 1.0 / rd, t0 = (-h - ro) * inv, t1 = (h - ro) * inv, mn = min(t0, t1), mx = max(t0, t1);
    return vec2(max(max(mn.x, mn.y), mn.z), min(min(mx.x, mx.y), mx.z));
}
void main() {
    #include <logdepthbuf_fragment>
    vec3 ro = cameraPosition - vOrg, rd = normalize(vW - cameraPosition);
    vec2 th = boxHit(ro, rd, uHalf);
    th.x = max(th.x, 0.0);
    if (th.x >= th.y) discard;
    float len = th.y - th.x, dt = max(len / 90.0, 7.0);   // r6: the cells are wide and thin -- 56 steps left a grain on their edges
    float jit = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    float t = th.x + dt * jit, T = 1.0, tw = 0.0, wsum = 0.0;
    vec3 L = vec3(0.0);
    float c = dot(rd, uSunDir);
    for (int i = 0; i < 100; i++) {
        if (t > th.y || T < 0.015) break;
        vec3 p = ro + rd * t;
        float d = densAt(p, true);
        if (d > 0.002) {
            float od = 0.0, s = 16.0; vec3 lp = p;
            for (int k = 0; k < 5; k++) { lp += uSunDir * s; od += densAt(lp, k < 2) * s; s *= 1.9; }
            vec3 S = vec3(0.0); float a = 1.0, b = 1.0, g = 1.0;
            for (int o = 0; o < 3; o++) { S += vec3(a * exp(-uSig * od * b) * (mix(hg(c, 0.72 * g), hg(c, -0.2 * g), 0.3) + 0.06)); a *= 0.45; b *= 0.35; g *= 0.3; }
            float hf = clamp((p.y - uBaseY) / (uHalf.y * 2.0 - 30.0), 0.0, 1.0);
            float powder = 1.0 - 0.35 * exp(-d * uSig * 90.0);   // the dark-edged look of a lit cauliflower (r6: softer -- it browned the bodies)
            vec3 Ls = uSunCol * mix(vec3(1.0, 0.85, 1.0), vec3(1.0, 0.92, 0.85), hf) * uSunE * S * 0.75 * powder + mix(min(hazeSky(-normalize(vec3(uSunDir.x, 0.0, uSunDir.z))), vec3(0.5)) * vec3(0.7, 0.78, 1.15) * 0.8, uAmbUp * vec3(1.0, 1.1, 1.5), hf) * (0.4 + 0.6 * hf);   // r6: the shade side blue-violet, never grey-brown; a darker base
            float al = 1.0 - exp(-d * uSig * dt);
            L += T * al * Ls; tw += T * al * t; wsum += T * al;
            T *= 1.0 - al;
        }
        t += dt;
    }
    float alpha = 1.0 - T;
    if (alpha < 0.004) discard;
    vec3 col = L / alpha;
    vec3 hp = cameraPosition + rd * (tw / max(wsum, 1e-4));
    col = applyHaze(col, hp, cameraPosition);
    gl_FragColor = vec4(col, alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
}`;

// --- r8: the clouds at HALF resolution. PERF measured the two cloud marches at 4-9 ms each, and the deck at ~23-37 ms on the
// ridge's long lens: their cost is per pixel. So the deck and the cumulus are ray-marched (the shaders above, unchanged) into
// half-size targets just before the scene draws (scene.onBeforeRender), and composited here at full size:
//   * the deck: its own plane, depth-tested exactly as before (the jets, the chutes and any peak in front of it cut it at full
//     resolution); it reads the half-size picture bilinearly. That picture holds no occluder at all, only cloud, so there is
//     nothing to halo against: a peak's or a jet's edge is the full-size depth test's.
//   * the cumulus: the boxes are depth-tested in the half-size pass against a depth-only copy of the terrain (so a cloud behind
//     a ridge stays hidden even where a nearer box overlaps it), then one full-screen pass writes, per pixel, the depth of the
//     nearest box face (what the boxes' own depth test used) and reads the four half-size texels round it, dropping any whose
//     terrain stood in front of that face (depth-aware upsampling: no dark rim round a peak). Jets are never in the half pass.
// The colour targets hold premultiplied light; the composites un-premultiply and blend as the marches did (normal blending).
const COMP_VS = /* glsl */`
${LOGV}
void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    #include <logdepthbuf_vertex>
}`;
const DECKC_FS = /* glsl */`
${LOGF}
uniform sampler2D uTex; uniform vec2 uFull;
void main() {
    #include <logdepthbuf_fragment>
    vec4 c = texture(uTex, gl_FragCoord.xy / uFull);
    if (c.a < 0.004) discard;
    gl_FragColor = vec4(c.rgb / c.a, c.a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
}`;
const CUMC_VS = /* glsl */`void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const CUMC_FS = /* glsl */`
#include <common>
#if defined( USE_LOGARITHMIC_DEPTH_BUFFER )
uniform float logDepthBufFC;
#else
uniform mat4 projectionMatrix;
#endif
uniform sampler2D uTex, uDep; uniform vec2 uFull; uniform ivec2 uHalfN;
uniform mat3 uCamRot; uniform vec4 uProj;   // the camera's world rotation; projection (p0, p5, p8, p9)
uniform vec3 uBC[32], uBH[32]; uniform int uNB;
void main() {
    vec2 ndc = gl_FragCoord.xy / uFull * 2.0 - 1.0;
    vec3 dv = vec3((ndc.x + uProj.z) / uProj.x, (ndc.y + uProj.w) / uProj.y, -1.0);   // view space, depth 1
    vec3 rd = normalize(uCamRot * dv);
    float tn = 1e30;
    for (int i = 0; i < 32; i++) {
        if (i >= uNB) break;
        vec3 ro = cameraPosition - uBC[i], inv = 1.0 / rd, t0 = (-uBH[i] - ro) * inv, t1 = (uBH[i] - ro) * inv, mn = min(t0, t1), mx = max(t0, t1);
        float a = max(max(mn.x, mn.y), mn.z), b = min(min(mx.x, mx.y), mx.z);
        if (b > max(a, 0.0)) tn = min(tn, max(a, 0.0));
    }
    if (tn > 1e29) discard;
    float w = max(tn / length(dv), 0.0);   // the face's view depth (gl_Position.w)
    float z;
#if defined( USE_LOGARITHMIC_DEPTH_BUFFER )
    z = log2(1.0 + w) * logDepthBufFC * 0.5;
#else
    vec4 cp = projectionMatrix * viewMatrix * vec4(cameraPosition + rd * tn, 1.0); z = clamp(0.5 * cp.z / max(cp.w, 1e-6) + 0.5, 0.0, 1.0);
#endif
    gl_FragDepth = z;
    vec2 h = gl_FragCoord.xy * vec2(uHalfN) / uFull - 0.5, f = fract(h);
    ivec2 i0 = ivec2(floor(h));
    vec4 acc = vec4(0.0); float ws = 0.0;
    for (int k = 0; k < 4; k++) {
        ivec2 o = ivec2(k & 1, k >> 1), q = clamp(i0 + o, ivec2(0), uHalfN - 1);
        float wb = (o.x == 1 ? f.x : 1.0 - f.x) * (o.y == 1 ? f.y : 1.0 - f.y);
        float ok = texelFetch(uDep, q, 0).r >= z - 2e-5 ? 1.0 : 0.0;   // the terrain at that texel stood behind the face
        acc += texelFetch(uTex, q, 0) * wb * ok; ws += wb * ok;
    }
    if (ws < 1e-4) discard;
    vec4 c = acc / ws;
    if (c.a < 0.004) discard;
    gl_FragColor = vec4(c.rgb / c.a, c.a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
}`;
// the terrain's depth alone, for the cumulus' half-size pass (the far chunks still skip the near square)
const TDEPTH_FS = /* glsl */`
${LOGF}
uniform float uDiscard;
varying vec3 vW;
void main() {
    if (uDiscard > 0.0 && max(abs(vW.x), abs(vW.z)) < uDiscard) discard;
    #include <logdepthbuf_fragment>
    gl_FragColor = vec4(0.0);
}`;

// ================================================================== geometry
function gradedAxis(d0, g, R) {   // (kartworld.js gradedAxis)
    const pos = [0];
    for (let x = 0; x < R;) { x = Math.min(R, x + d0 + g * x); pos.push(x); }
    return [...pos.slice(1).map((x) => -x).reverse(), ...pos];
}
// the square under the fight: graded grid + a skirt one ring wide (y = −1 on the skirt)
function nearGeometry(R) {
    const ax = gradedAxis(22, 0.002, R), n = ax.length, m = n + 2;
    const pos = new Float32Array(m * m * 3), idx = [];
    for (let j = 0; j < m; j++) for (let i = 0; i < m; i++) {
        const ii = clamp(i - 1, 0, n - 1), jj = clamp(j - 1, 0, n - 1), sk = i === 0 || j === 0 || i === m - 1 || j === m - 1;
        const k = (j * m + i) * 3; pos[k] = ax[ii]; pos[k + 1] = sk ? -1 : 0; pos[k + 2] = ax[jj];
    }
    for (let j = 0; j < m - 1; j++) for (let i = 0; i < m - 1; i++) { const a = j * m + i, b = a + 1, c = a + m, d = c + 1; idx.push(a, c, b, b, c, d); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setIndex(idx);
    return g;
}
// the rest of the world: rings from r0 to r1, 1,536 around, the ring step growing from 0.6% to 2%.
// r8: cut into chunks (24 sectors x 4 bands) that share ONE vertex buffer, each with a bounding sphere that holds its displaced
// heights, so the frustum drops the ones off screen (PERF: the whole 1.16 M-triangle ring ran its vertex shader every frame,
// ~15 ms; ~39 ms on the 2.5 deg ridge lens, which sees one sector). The vertices, the triangles and so the picture are unchanged:
// neighbouring chunks share their edge vertices, so no crack can open. (PERF also suggested 768 around past ~60 km; not done --
// the ridge lens sees 60-100 km ranges ~18 segments across at 1,536, and halving that faceted their silhouettes.)
// yLo/yHi: the world y range the vertex shader can reach before the curve (the DEM's range plus the relief).
function farChunks(r0, r1, S, yLo, yHi, sectors = 24, bands = [12000, 30000, 80000]) {
    const rs = [];
    for (let r = r0; r < r1;) { rs.push(r); r *= 1 + (r < 20000 ? 0.006 : r < 60000 ? 0.012 : 0.022); }
    rs.push(r1);
    const pos = new Float32Array(rs.length * S * 3);
    let k = 0;
    for (const r of rs) for (let s = 0; s < S; s++) { const a = (s / S) * Math.PI * 2; pos[k++] = Math.cos(a) * r; pos[k++] = 0; pos[k++] = Math.sin(a) * r; }
    const attr = new THREE.BufferAttribute(pos, 3);
    const cuts = [0, ...bands.map((b) => rs.findIndex((r) => r >= b)).filter((i) => i > 0), rs.length - 1];
    const per = S / sectors, out = [];
    for (let bi = 0; bi < cuts.length - 1; bi++) for (let sc = 0; sc < sectors; sc++) {
        const i0 = cuts[bi], i1 = cuts[bi + 1], idx = new Uint32Array((i1 - i0) * per * 6);
        let q = 0, xa = 1e9, xb = -1e9, za = 1e9, zb = -1e9;
        for (let i = i0; i < i1; i++) for (let s = sc * per; s < (sc + 1) * per; s++) {
            const a = i * S + s, b = i * S + ((s + 1) % S), c = a + S, d = b + S;
            idx[q++] = a; idx[q++] = b; idx[q++] = c; idx[q++] = b; idx[q++] = d; idx[q++] = c;   // counter-clockwise from above
            for (const v of [a, b, c, d]) { xa = Math.min(xa, pos[v * 3]); xb = Math.max(xb, pos[v * 3]); za = Math.min(za, pos[v * 3 + 2]); zb = Math.max(zb, pos[v * 3 + 2]); }
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', attr); g.setIndex(new THREE.BufferAttribute(idx, 1));
        // the y the shader can draw here: the DEM's range, lowered by the earth's curve between the band's radii
        const ya = yLo - rs[i1] * rs[i1] * CURVE, yb = yHi - rs[i0] * rs[i0] * CURVE;
        const box = new THREE.Box3(new THREE.Vector3(xa, ya, za), new THREE.Vector3(xb, yb, zb));
        g.boundingBox = box; g.boundingSphere = box.getBoundingSphere(new THREE.Sphere());
        out.push(g);
    }
    return out;
}

// A tiling 64³ cloud noise (RG8): R = Perlin-Worley (value fbm lifted by inverted Worley: round billows), G = Worley fbm (the
// erosion). Made once on the CPU, ~0.2 s.
function makeNoise3D(seed) {
    const N = 64, rnd = mulberry32(seed * 31337 + 5), out = new Uint8Array(N * N * N * 2);
    const lat = (P) => { const g = new Float32Array(P * P * P); for (let i = 0; i < g.length; i++) g[i] = rnd(); return g; };
    const pts = (P) => { const g = new Float32Array(P * P * P * 3); for (let i = 0; i < g.length; i++) g[i] = rnd(); return g; };
    const L = [4, 8, 16].map((P) => ({ P, g: lat(P) })), W = [4, 8, 16].map((P) => ({ P, g: pts(P) }));
    const value = (o, x, y, z) => {   // x,y,z in [0,1)
        const P = o.P, fx = x * P, fy = y * P, fz = z * P, i = Math.floor(fx), j = Math.floor(fy), k = Math.floor(fz);
        let u = fx - i, v = fy - j, w = fz - k; u = u * u * (3 - 2 * u); v = v * v * (3 - 2 * v); w = w * w * (3 - 2 * w);
        const G = (a, b, c) => o.g[(((c % P) + P) % P) * P * P + (((b % P) + P) % P) * P + (((a % P) + P) % P)];
        const l = (a, b, t) => a + (b - a) * t;
        return l(l(l(G(i, j, k), G(i + 1, j, k), u), l(G(i, j + 1, k), G(i + 1, j + 1, k), u), v), l(l(G(i, j, k + 1), G(i + 1, j, k + 1), u), l(G(i, j + 1, k + 1), G(i + 1, j + 1, k + 1), u), v), w);
    };
    const worley = (o, x, y, z) => {
        const P = o.P, fx = x * P, fy = y * P, fz = z * P, i = Math.floor(fx), j = Math.floor(fy), k = Math.floor(fz);
        let d = 9;
        for (let c = -1; c <= 1; c++) for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) {
            const ii = (((i + a) % P) + P) % P, jj = (((j + b) % P) + P) % P, kk = (((k + c) % P) + P) % P, q = (kk * P * P + jj * P + ii) * 3;
            const dx = i + a + o.g[q] - fx, dy = j + b + o.g[q + 1] - fy, dz = k + c + o.g[q + 2] - fz;
            d = Math.min(d, dx * dx + dy * dy + dz * dz);
        }
        return 1 - Math.min(1, Math.sqrt(d));
    };
    for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        const X = x / N, Y = y / N, Z = z / N;
        const f = value(L[0], X, Y, Z) * 0.55 + value(L[1], X, Y, Z) * 0.3 + value(L[2], X, Y, Z) * 0.15;
        const w = worley(W[0], X, Y, Z) * 0.625 + worley(W[1], X, Y, Z) * 0.25 + worley(W[2], X, Y, Z) * 0.125;
        const pw = clamp((f - 0.5) * 1.6 + 0.5, 0, 1);
        const r = clamp(pw + (1 - pw) * (w - 0.35) * 0.9, 0, 1);   // Perlin-Worley: the value field, dented by cells
        const i = ((z * N + y) * N + x) * 2;
        out[i] = Math.round(r * 255); out[i + 1] = Math.round(clamp((w - 0.2) / 0.7, 0, 1) * 255);
    }
    const t = new THREE.Data3DTexture(out, N, N, N);
    t.format = THREE.RGFormat; t.type = THREE.UnsignedByteType;
    t.wrapS = t.wrapT = t.wrapR = THREE.RepeatWrapping; t.magFilter = t.minFilter = THREE.LinearFilter; t.unpackAlignment = 1;
    t.needsUpdate = true;
    return t;
}

function floatTex(T, mirror) {
    const t = new THREE.DataTexture(T.data, T.n, T.n, THREE.RedFormat, THREE.FloatType);
    t.magFilter = t.minFilter = THREE.LinearFilter; t.generateMipmaps = false;
    t.wrapS = t.wrapT = mirror ? THREE.MirroredRepeatWrapping : THREE.ClampToEdgeWrapping;
    t.needsUpdate = true;
    return t;
}

// ================================================================== the world
export async function buildJetWorld(scene, renderer, { seed = 7, noAssets = false } = {}) {
    const T0 = performance.now(), ms = {};
    let t = T0;
    const lap = (k) => { ms[k] = Math.round(performance.now() - t); t = performance.now(); };
    const group = new THREE.Group(); group.name = 'jetWorld'; scene.add(group);
    const disposables = [];
    const own = (x) => (disposables.push(x), x);
    const sunDir = V(...SUN.dir);

    // ---------------------------------------------------------------- heights
    let H = null;
    if (!noAssets) { try { H = await loadHeights(); } catch (e) { console.info(`[jet] DEM not used: ${e.message}`); } }
    H ??= proceduralHeights();
    const farM = sampler(H.far, true), farS = (x, z) => contH(H.cont, x, z, farM), nearS = H.near ? sampler(H.near, false) : null;
    // the noise texture (seeded) the GPU's tn() reads, and its CPU twin
    const rnd = mulberry32(seed * 7919 + 13), nz = new Uint8Array(256 * 256 * 4);
    for (let i = 0; i < nz.length; i++) nz[i] = Math.floor(rnd() * 256);
    const tnC = (x, y) => {   // = GLSL tn(): smoothstep weights, LinearFilter on texels i-1, i
        x += 0.5; y += 0.5;
        const i = Math.floor(x) - 1, j = Math.floor(y) - 1;
        let fx = x - i - 1, fy = y - j - 1; fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
        const a = (ii, jj) => nz[((jj & 255) * 256 + (ii & 255)) * 4];
        return ((a(i, j) * (1 - fx) + a(i + 1, j) * fx) * (1 - fy) + (a(i, j + 1) * (1 - fx) + a(i + 1, j + 1) * fx) * fy) / 255;
    };
    const detailAt = (x, z) => {   // = GLSL detailH()
        let r1 = 1 - Math.abs(tnC(x / 170, z / 170) * 2 - 1); r1 = r1 * r1 * r1;
        let r2 = 1 - Math.abs(tnC(x / 63 + 40, z / 63 + 40) * 2 - 1); r2 = r2 * r2 * r2;
        let g3 = 1 - Math.abs(tnC(x / 95 + 77, z / 95 + 77) * 2 - 1); g3 = g3 * g3 * g3;
        return 46 * (r1 - 0.3) + 14 * (r2 - 0.3) * (0.5 + r1) - 16 * (g3 - 0.3) + 2 * (tnC(x / 23 + 90, z / 23 + 90) - 0.5);
    };
    const terrainHeightAt = (x, z) => {
        let h = farS(x, z) + detailAt(x, z);
        if (nearS) {
            const ux = ((x - H.near.x0) / H.near.dx + 0.5) / H.near.n, uz = ((z - H.near.z0) / H.near.dz + 0.5) / H.near.n;
            const w = smooth(0, 0.06, Math.min(ux, 1 - ux, uz, 1 - uz));
            if (w > 0) h += (nearS(x, z) - h) * w;
        }
        return h - (x * x + z * z) * CURVE;
    };
    lap('dem');

    const noiseTex = own(new THREE.DataTexture(nz, 256, 256, THREE.RGBAFormat));
    noiseTex.wrapS = noiseTex.wrapT = THREE.RepeatWrapping; noiseTex.magFilter = noiseTex.minFilter = THREE.LinearFilter; noiseTex.needsUpdate = true;

    const hNear = H.near ? own(floatTex(H.near, false)) : own(new THREE.DataTexture(new Float32Array([0]), 1, 1, THREE.RedFormat, THREE.FloatType));
    hNear.needsUpdate = true;
    const hFar = own(floatTex(H.far, true));
    const rectOf = (T) => new THREE.Vector4(T.x0, T.z0, 1 / T.dx, 1 / T.dz);
    const U = {
        uHNear: { value: hNear }, uHFar: { value: hFar }, uShNear: { value: null }, uShFar: { value: null }, uNoise: { value: noiseTex },
        uNearR: { value: H.near ? rectOf(H.near) : new THREE.Vector4(0, 0, 1, 1) }, uFarR: { value: rectOf(H.far) },
        uNearN: { value: H.near ? H.near.n : 1 }, uFarN: { value: H.far.n }, uNearOn: { value: H.near ? 1 : 0 },
        uShFarR: { value: null }, uShFarN: { value: 1 }, uCont: { value: new THREE.Vector4(H.cont.e0, H.cont.a, H.cont.sx, H.cont.sz) },
        uSunDir: { value: sunDir.clone() }, uSunCol: { value: SUN_COL.clone() }, uSunE: { value: SUN_E },
        uAmbUp: { value: V(0.1, 0.13, 0.2) }, uAmbHor: { value: V(0.2, 0.2, 0.22) },
        uHazeLUT: { value: Array.from({ length: 32 }, () => V(0.4, 0.45, 0.55)) },
        // Rayleigh at sea level (5.8, 13.5, 33.1)e-6 /m, scale height 8 km; a thin dust layer (scale height 1.4 km, floor 1.5 km)
        // dense enough at 4-5 km that the ranges 30-80 km out go blue-grey and soft (the brief's aerial perspective)
        uBetaR: { value: V(5.8e-6, 13.5e-6, 33.1e-6) }, uBetaM: { value: V(3.8e-5, 3.8e-5, 3.8e-5) },
        uTime: { value: 0 }, uWind: { value: new THREE.Vector2(...WIND) },
        uDeckY: { value: DECK.base }, uDeckT: { value: DECK.thick },
    };
    lap('textures');

    // ---------------------------------------------------------------- the sky: cube, LUT, ambient
    const skyU = { uSunDir: { value: sunDir }, uSunCol: { value: SUN_COL }, uScale: { value: 1 }, uDisc: { value: DISC }, uObsH: { value: DATUM + FIGHT.centre[1] }, uSeedSky: { value: new THREE.Vector2(seed * 3.7 % 50, seed * 1.3 % 50) }, uRaw: { value: 0 } };
    const sky = new THREE.Mesh(own(new THREE.SphereGeometry(300000, 64, 32)), own(new THREE.ShaderMaterial({ uniforms: skyU, vertexShader: SKY_VS, fragmentShader: SKY_FS, side: THREE.BackSide, depthWrite: false })));
    const skyScene = new THREE.Scene(); skyScene.add(sky);
    skyU.uRaw.value = 1;
    for (let pass = 0; pass < 2; pass++) {
        const rt = new THREE.WebGLRenderTarget(4, 4, { type: THREE.FloatType });
        const cam = new THREE.PerspectiveCamera(8, 1, 1, 400000), buf = new Float32Array(16 * 4), avg = V();
        const read = () => { renderer.setRenderTarget(rt); renderer.render(skyScene, cam); renderer.readRenderTargetPixels(rt, 1, 1, 2, 2, buf);
            return V(buf[0] + buf[4] + buf[8] + buf[12], buf[1] + buf[5] + buf[9] + buf[13], buf[2] + buf[6] + buf[10] + buf[14]).multiplyScalar(0.25); };
        for (let i = 0; i < 32; i++) {
            const a = ((i + 0.5) / 32 - 0.5) * Math.PI * 2;
            cam.position.set(0, 0, 0); cam.lookAt(Math.sin(a), Math.tan(3 * DEG), -Math.cos(a));
            const c = read(); U.uHazeLUT.value[i].copy(c); avg.add(c);
        }
        cam.lookAt(0, 1, 0.001);
        const zen = read();
        renderer.setRenderTarget(null); rt.dispose();
        if (pass === 0) { skyU.uScale.value = ZENITH / Math.max(1e-6, (zen.x + zen.y + zen.z) / 3); skyU.uRaw.value = 0; continue; }
        U.uAmbUp.value.copy(zen);
        U.uAmbHor.value.copy(avg.multiplyScalar(0.5 / 32));
    }
    const bgRT = own(new THREE.WebGLCubeRenderTarget(1024, { type: THREE.HalfFloatType, generateMipmaps: false }));
    new THREE.CubeCamera(1, 400000, bgRT).update(renderer, skyScene);
    scene.background = bgRT.texture; scene.backgroundIntensity = 1; scene.environment = null; scene.fog = null;
    lap('sky');

    // ---------------------------------------------------------------- shadows and sky occlusion, baked once
    const bake = (T, n, step) => {
        const rt = own(new THREE.WebGLRenderTarget(n, n, { type: THREE.UnsignedByteType, magFilter: THREE.LinearFilter, minFilter: THREE.LinearFilter, generateMipmaps: false }));
        const mat = new THREE.ShaderMaterial({ uniforms: { ...U, uR: { value: rectOf(T) }, uN: { value: T.n }, uStep: { value: step } }, vertexShader: BAKE_VS, fragmentShader: BAKE_FS, depthTest: false, depthWrite: false });
        const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat), sc = new THREE.Scene(); sc.add(quad);
        renderer.setRenderTarget(rt); renderer.render(sc, new THREE.Camera()); renderer.setRenderTarget(null);
        mat.dispose(); quad.geometry.dispose();
        return rt.texture;
    };
    // r7: the far bake is a 2,048² square centred on the site (+-60 km at the far texture's 58.7 m), not the tile: the tile
    // ends 10.9 km east of the v3 site, and past it shadowAt() answered "all sun"
    const shR = H.near ? { n: 2048, dx: H.far.dx, dz: H.far.dz, x0: -1023.5 * H.far.dx, z0: -1023.5 * H.far.dz } : H.far;
    U.uShFarR.value = rectOf(shR); U.uShFarN.value = shR.n;
    U.uShFar.value = bake(shR, shR.n, 0.045);
    U.uShNear.value = H.near ? bake(H.near, H.near.n, 0.025) : U.uShFar.value;
    lap('shadowBake');

    // ---------------------------------------------------------------- terrain meshes
    const NEAR_R = 6000;
    const tMat = (discard) => own(new THREE.ShaderMaterial({ uniforms: { ...U, uDiscard: { value: discard } }, vertexShader: TERRAIN_VS, fragmentShader: TERRAIN_FS }));
    const nearMesh = new THREE.Mesh(own(nearGeometry(NEAR_R)), tMat(0));
    nearMesh.frustumCulled = false; nearMesh.renderOrder = -2; nearMesh.name = 'terrainNear'; group.add(nearMesh);
    // r8: the far ring in frustum-culled chunks (farChunks). The y range their spheres must hold: the far DEM's range + relief
    let fLo = 1e9, fHi = -1e9; for (const D of [H.far.data, H.near?.data || []]) for (const v of D) { if (v < fLo) fLo = v; if (v > fHi) fHi = v; }
    const farGeos = farChunks(5400, 260000, 1536, fLo - 120, fHi + 120).map(own), farMat = tMat(NEAR_R - 1);
    const farMeshes = farGeos.map((g) => { const m = new THREE.Mesh(g, farMat); m.renderOrder = -2; m.name = 'terrainFar'; group.add(m); return m; });
    const tris = { near: nearMesh.geometry.index.count / 3, far: farGeos.reduce((a, g) => a + g.index.count / 3, 0), farChunks: farGeos.length };
    lap('terrain');

    // ---------------------------------------------------------------- the cloud sea
    const n3 = own(makeNoise3D(seed));
    const deckMat = own(new THREE.ShaderMaterial({ uniforms: { ...U, uN3: { value: n3 } }, vertexShader: DECK_VS, fragmentShader: DECK_FS, transparent: true, depthWrite: false }));
    const deckGeo = own(new THREE.PlaneGeometry(320000, 320000, 1, 1).rotateX(-Math.PI / 2).translate(0, DECK.base + DECK.thick, 0));
    // r8: the march draws into a half-size target (deckScene, see the half-size pass below); the scene gets the composite
    const halfRT = (depth) => {
        const rt = own(new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType, depthBuffer: depth, magFilter: depth ? THREE.NearestFilter : THREE.LinearFilter, minFilter: depth ? THREE.NearestFilter : THREE.LinearFilter, generateMipmaps: false }));
        if (depth) rt.depthTexture = new THREE.DepthTexture(2, 2, THREE.FloatType);
        return rt;
    };
    const deckRT = halfRT(false), cumRT = halfRT(true);
    const deckScene = new THREE.Scene(), deckMarch = new THREE.Mesh(deckGeo, deckMat);
    deckMarch.frustumCulled = false; deckScene.add(deckMarch);
    const deckComp = own(new THREE.ShaderMaterial({ uniforms: { uTex: { value: deckRT.texture }, uFull: { value: new THREE.Vector2(1, 1) } }, vertexShader: COMP_VS, fragmentShader: DECKC_FS, transparent: true, depthWrite: false }));
    const deck = new THREE.Mesh(deckGeo, deckComp);
    deck.frustumCulled = false; deck.renderOrder = 1; deck.name = 'cloudSea';
    group.add(deck);

    // ---------------------------------------------------------------- cumulus around the fight
    const rc = mulberry32(seed * 104729 + 3);
    const clusters = [], cumulus = [];
    // r8: the boxes live in their own scene, marched at half size over a depth-only copy of the terrain (same chunks, culled)
    const cumScene = new THREE.Scene();
    const tDepth = (discard) => own(new THREE.ShaderMaterial({ uniforms: { ...U, uDiscard: { value: discard } }, vertexShader: TERRAIN_VS, fragmentShader: TDEPTH_FS, colorWrite: false }));
    { const n = new THREE.Mesh(nearMesh.geometry, tDepth(0)); n.frustumCulled = false; n.renderOrder = -2; cumScene.add(n);
      const fd = tDepth(NEAR_R - 1); for (const g of farGeos) { const m = new THREE.Mesh(g, fd); m.renderOrder = -2; cumScene.add(m); } }
    // r6: flat-based cumulus and stratocumulus, clearly bigger than a jet: R the half width of the cell field (0.9-3 km), Hh
    // its depth (0.25-1.8 km), a base at one condensation level. Each is placed by trial: a cloud whose base comes within 450 m
    // of the ground under it (a "column rooted on a peak", seed 7 review) or whose box comes within 600 m of the fight box
    // (PLAN's note: a box edge inside it) is not made. The draws are seeded, so the same seed gives the same sky.
    const groundMaxUnder = (cx, cz, hx, hz) => { let m = -1e9; for (let i = -10; i <= 10; i++) for (let j = -10; j <= 10; j++) m = Math.max(m, terrainHeightAt(cx + i * hx / 10, cz + j * hz / 10)); return m; };   // r7: 21x21 (13x13 at v2): the v3 ring stands over sharper peaks
    const FB_KEEP = 600;
    const addCluster = (cx, cz, yb, R, Hh) => {
        // the shape: a field of wide flat cells over one base, the middle ones a little deeper, a tower or two on a deep one
        const blobs = [], nb = 7 + Math.floor(rc() * 4);
        for (let k = 0; k < nb; k++) {
            const a = rc() * Math.PI * 2, rr = R * 0.62 * Math.sqrt(rc());
            const r = R * (0.32 + 0.22 * rc()) * (1 - 0.35 * rr / R);
            const yc = Hh * (0.12 + 0.3 * rc() * (1 - rr / R));
            blobs.push([Math.cos(a) * rr, yc, Math.sin(a) * rr, r]);
        }
        const flat = Math.min(0.9, (Hh * 0.75) / (R * 0.45));
        let mn = [1e9, 0, 1e9], mx = [-1e9, -1e9, -1e9];
        for (const b of blobs) { for (const ax of [0, 2]) { mn[ax] = Math.min(mn[ax], b[ax] - b[3]); mx[ax] = Math.max(mx[ax], b[ax] + b[3]); } mx[1] = Math.max(mx[1], b[1] + b[3] * flat); }
        mn[1] = 0;
        const half = [0, 1, 2].map((ax) => (mx[ax] - mn[ax]) / 2 + 20), mid = [0, 1, 2].map((ax) => (mx[ax] + mn[ax]) / 2);
        const centre = [cx + mid[0], yb + mid[1], cz + mid[2]];
        if (groundMaxUnder(centre[0], centre[2], half[0] + 200, half[2] + 200) > yb - 450) return false;   // its whole box, and a margin
        // keep out of the fight box (x and z only: the box is +-3 km; drift over 35 s is ~150 m, inside the margin)
        const outX = Math.abs(centre[0]) - half[0] > FIGHT.max[0] + FB_KEEP, outZ = Math.abs(centre[2]) - half[2] > FIGHT.max[2] + FB_KEEP;
        if (!outX && !outZ) return false;
        const arr = Array.from({ length: 10 }, (_, i) => blobs[i] ? new THREE.Vector4(blobs[i][0] - mid[0], blobs[i][1] - mid[1], blobs[i][2] - mid[2], blobs[i][3]) : new THREE.Vector4(0, 0, 0, 0));
        const mat = own(new THREE.ShaderMaterial({
            uniforms: { ...U, uN3: { value: n3 }, uBlobs: { value: arr }, uHalf: { value: V(...half) }, uOff: { value: V(rc() * 5000, rc() * 5000, rc() * 5000) }, uBaseY: { value: -mid[1] - 0 }, uSig: { value: 0.042 }, uFlat: { value: flat } },
            vertexShader: CUM_VS, fragmentShader: CUM_FS, transparent: true, depthWrite: false,
        }));
        const box = new THREE.Mesh(own(new THREE.BoxGeometry(half[0] * 2, half[1] * 2, half[2] * 2)), mat);
        box.renderOrder = 2; box.name = 'cumulusBox';   // r8: frustum-culled (a box round the camera always meets the frustum)
        box.position.set(...centre);
        box.userData = { c0: centre, half };
        // the camera inside the box: draw its back faces, unoccluded (the march starts at the lens)
        box.onBeforeRender = (r, s, cam) => {
            const p = cam.position, o = box.position, inside = Math.abs(p.x - o.x) < half[0] + 2 && Math.abs(p.y - o.y) < half[1] + 2 && Math.abs(p.z - o.z) < half[2] + 2;
            mat.side = inside ? THREE.BackSide : THREE.FrontSide; mat.depthTest = !inside;
        };
        cumScene.add(box); cumulus.push(box);
        clusters.push({ c: [cx, yb, cz], r: Math.max(half[0], half[2]), h: half[1] * 2, centre });
        return true;
    };
    // r7: every base rides with the plan floor (v3 lifted it 440 m with the ground: at v2's heights most of the near ring sat
    // on the new peaks and was refused, 26-29 clouds a seed instead of 32)
    const LIFT = FIGHT.floorY - 1300;
    // near: a ring of broad cells 6-11 km out (14 km where peaks wall a slot; a speed reference past the box, never in it), bases 6,140-7,140 m
    let nNear = 0;
    for (let i = 0, tries = 0; i < 6 && tries < 240; tries++) {   // r7: 240 tries (60 at v2): the ring now stands among peaks
        const a = (i / 6) * Math.PI * 2 + rc() * 0.7, d = 6000 + rc() * (tries < 120 ? 5000 : 8000);   // r7: a slot walled by peaks looks further out
        if (addCluster(Math.cos(a) * d, Math.sin(a) * d, LIFT + 1200 + rc() * 1000, 1000 + rc() * 1000, 250 + rc() * 400)) { i++; nNear++; }
    }
    // the sky around: stratocumulus fields and, far off, a few big cumulus congestus with flat bases, 12-50 km
    for (let i = 0, tries = 0; i < 26 && tries < 200; tries++) {
        const a = rc() * Math.PI * 2, d = 12000 + Math.pow(rc(), 0.8) * 38000, big = i % 5 === 4;
        if (addCluster(Math.cos(a) * d, Math.sin(a) * d, LIFT + 1300 + rc() * 2200, big ? 1800 + rc() * 1200 : 1200 + rc() * 1800, big ? 1100 + rc() * 700 : 250 + rc() * 450)) i++;
    }
    const NP = cumulus.length;
    lap('clouds');

    // ---------------------------------------------------------------- the sun light for the jets, and the environment
    const sunLight = new THREE.DirectionalLight(SUN_COL, SUN_E);
    sunLight.position.set(...FIGHT.centre).addScaledVector(sunDir, 20000);
    sunLight.target.position.set(...FIGHT.centre);
    group.add(sunLight, sunLight.target);
    let skyEnv;
    {
        // (the cumulus are not in the group -- a cloud at the lens would fill half the cube; r8: the deck is baked by its march)
        deck.material = deckMat;
        const envScene = new THREE.Scene(); envScene.background = bgRT.texture;
        scene.remove(group); envScene.add(group);
        const small = new THREE.WebGLCubeRenderTarget(256, { type: THREE.HalfFloatType });
        const cc = new THREE.CubeCamera(5, 400000, small); cc.position.set(...FIGHT.centre);
        cc.update(renderer, envScene);
        envScene.remove(group); scene.add(group); deck.material = deckComp;
        const pmrem = new THREE.PMREMGenerator(renderer);
        skyEnv = own(pmrem.fromCubemap(small.texture).texture);
        pmrem.dispose(); small.dispose();
    }
    lap('env');

    // ---------------------------------------------------------------- r8: the half-size cloud pass and the cumulus composite
    const cumGeo = own(new THREE.BufferGeometry());
    cumGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));   // one triangle over the screen
    const cumComp = own(new THREE.ShaderMaterial({
        uniforms: { uTex: { value: cumRT.texture }, uDep: { value: cumRT.depthTexture }, uFull: { value: new THREE.Vector2(1, 1) }, uHalfN: { value: new THREE.Vector2(1, 1) },
            uCamRot: { value: new THREE.Matrix3() }, uProj: { value: new THREE.Vector4(1, 1, 0, 0) },
            uBC: { value: cumulus.map(() => V()) }, uBH: { value: cumulus.map((b) => V(...b.userData.half)) }, uNB: { value: cumulus.length } },
        vertexShader: CUMC_VS, fragmentShader: CUMC_FS, transparent: true, depthWrite: false,
    }));
    if (!cumulus.length) { cumComp.uniforms.uBC.value = [V()]; cumComp.uniforms.uBH.value = [V()]; }
    const cumC = new THREE.Mesh(cumGeo, cumComp);
    cumC.frustumCulled = false; cumC.renderOrder = 2; cumC.name = 'cumulus';
    group.add(cumC);
    const _fr = new THREE.Frustum(), _m4 = new THREE.Matrix4(), _sp = new THREE.Sphere(), _v2 = new THREE.Vector2(), _cc = new THREE.Color();
    for (const b of cumulus) b.geometry.computeBoundingSphere();
    const fitRT = (rt, w, h) => { if (rt.width !== w || rt.height !== h) rt.setSize(w, h); };
    // Runs at the start of every render of the scene, before anything is drawn into its target (three calls scene.onBeforeRender
    // before it builds its lists), so the two marches never interrupt the scene's own (MSAA) target mid-pass.
    const cloudPass = (r, cam, target) => {
        if (!group.parent || !group.visible || !cam.isPerspectiveCamera) { cumGeo.setDrawRange(0, 0); return; }
        let w, h;
        if (target) { w = Math.floor(target.width); h = Math.floor(target.height); } else { r.getDrawingBufferSize(_v2); w = _v2.x; h = _v2.y; }
        const hw = Math.max(1, Math.ceil(w / 2)), hh = Math.max(1, Math.ceil(h / 2));
        _fr.setFromProjectionMatrix(_m4.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
        let anyBox = false;
        cumScene.updateMatrixWorld();
        if (cumC.visible) for (const b of cumulus) if (_fr.intersectsSphere(_sp.copy(b.geometry.boundingSphere).applyMatrix4(b.matrixWorld))) { anyBox = true; break; }
        if (!deck.visible && !anyBox) { cumGeo.setDrawRange(0, 0); return; }
        const prev = r.getRenderTarget(), face = r.getActiveCubeFace(), mip = r.getActiveMipmapLevel();
        r.getClearColor(_cc); const ca = r.getClearAlpha(), ac = r.autoClear;
        r.setClearColor(0x000000, 0); r.autoClear = false;
        if (deck.visible) {
            fitRT(deckRT, hw, hh); r.setRenderTarget(deckRT); r.clear(true, false, false); r.render(deckScene, cam);
            deckComp.uniforms.uFull.value.set(w, h);
        }
        if (anyBox) {
            fitRT(cumRT, hw, hh); r.setRenderTarget(cumRT); r.clear(true, true, false); r.render(cumScene, cam);
            const u = cumComp.uniforms, P = cam.projectionMatrix.elements;
            u.uFull.value.set(w, h); u.uHalfN.value.set(hw, hh);
            u.uCamRot.value.setFromMatrix4(cam.matrixWorld); u.uProj.value.set(P[0], P[5], P[8], P[9]);
            cumulus.forEach((b, i) => u.uBC.value[i].copy(b.position));
            cumGeo.setDrawRange(0, 3);
        } else cumGeo.setDrawRange(0, 0);
        r.setRenderTarget(prev, face, mip); r.setClearColor(_cc, ca); r.autoClear = ac;
    };
    const prevHook = scene.onBeforeRender;
    scene.onBeforeRender = function (r, sc, cam, target) { prevHook.call(this, r, sc, cam, target); cloudPass(r, cam, target); };

    const applyEnv = (obj, k = 1) => obj.traverse((o) => {
        for (const m of [].concat(o.material || [])) if (m.isMeshStandardMaterial) { m.envMap = skyEnv; m.envMapIntensity = k; m.needsUpdate = true; }
    });
    // sun visibility of a point in the air (0 in a mountain's shadow, 1 in sun; soft over ~0.6°): the CPU twin of the bake, so
    // PLAN can keep the jets in sunlit air (research B6) and GLUE can dim the jets' sun if one dips into shadow
    const sxz = Math.hypot(sunDir.x, sunDir.z), sx = sunDir.x / sxz, sz = sunDir.z / sxz, tE = sunDir.y / sxz;
    const sunVisibilityAt = (x, y, z) => {
        let m = 1;
        for (let t = 15; t < 60000; t += Math.min(600, Math.max(12, t * 0.03))) m = Math.min(m, (y + tE * t - terrainHeightAt(x + sx * t, z + sz * t)) / t);
        return smooth(-0.006, 0.008, m);
    };
    let terrainMaxInBox = -1e9;
    for (let x = FIGHT.min[0]; x <= FIGHT.max[0]; x += 25) for (let z = FIGHT.min[2]; z <= FIGHT.max[2]; z += 25) terrainMaxInBox = Math.max(terrainMaxInBox, terrainHeightAt(x, z));
    const cloudsAt = (tt) => cumulus.map((b) => ({ c: [b.userData.c0[0] + WIND[0] * tt, b.userData.c0[1], b.userData.c0[2] + WIND[1] * tt], half: b.userData.half.slice() }));

    const world = {
        group,
        update(tt /* , sample: unused */) { U.uTime.value = tt; for (const c of cumulus) c.position.set(c.userData.c0[0] + WIND[0] * tt, c.userData.c0[1], c.userData.c0[2] + WIND[1] * tt); },
        sunDir, sunColor: SUN_COL.clone(), sunIntensity: SUN_E, sunLight, skyEnv, applyEnv,
        exposure: 0.8,
        toneMapping: THREE.ACESFilmicToneMapping,   // research B6 (ACES); jetworld.js was tuned under it
        bloom: { strength: 0.3, radius: 0.55, threshold: 3.0 },   // r6: a wider glare round the disc (the threshold, so what blooms, unchanged)
        fightBox: FIGHT,
        deck: { base: DECK.base, top: DECK.base + DECK.thick },
        terrainHeightAt, sunVisibilityAt, cloudsAt,
        credit: H.credit,
        stats: { ms: { ...ms, total: Math.round(performance.now() - T0) }, tris: { ...tris, total: tris.near + tris.far + 2 + NP * 12 }, cumulus: NP, clusters: clusters.length, nearRing: nNear, dem: !!H.near, terrainMaxInBox: Math.round(terrainMaxInBox), amb: { up: U.uAmbUp.value.toArray().map((v) => +v.toFixed(3)), hor: U.uAmbHor.value.toArray().map((v) => +v.toFixed(3)) } },
        dispose() {
            scene.remove(group); scene.onBeforeRender = prevHook;
            if (scene.background === bgRT.texture) scene.background = null;
            for (const d of disposables) d.dispose?.();
        },
    };
    return world;
}
