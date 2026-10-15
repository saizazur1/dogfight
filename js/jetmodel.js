// jetmodel.js -- the procedural fighter for the dogfight (?jet=1). MODEL lane (jetspec.js section 9). Everything is code.
//
//   import { buildJet, buildMissile } from './jetmodel.js';
//   const jet = buildJet(side, { color });   // side 0 = light two-tone grey + LANE_COLORS[0]; 1 = dark grey + LANE_COLORS[1]
//   scene.add(jet.group);                    // JET SPACE (jetspec section 1): +z nose, +y up, +x the pilot's LEFT.
//                                            // group.matrixAutoUpdate is off: GLUE writes poseMatrix(s.pos, s.q)
//   jet.setState(s /* JetState */, fit);     // surfaces, stick, throttle, pedals, nozzles, afterburner, brake, rails,
//                                            // damage/fire -> the tail damage; fit = { seatAdjust }; allocation-free
//   jet.anchors                              // Object3Ds named as jetspec ANCHORS, at ANCHORS within 1 cm (the harness checks)
//   jet.canopy, jet.seat                     // children of group (canopy origin = CANOPY.hinge, seat origin = SEAT.ref, both
//                                            // with the jet's axes); GLUE re-parents them to the scene at canopyOff / eject
//   jet.buildMissile(kind)                   // 'short' (MISSILE) | 'medium'; origin at the body's centre, nose +z
//
// SIGNS (jetspec section 1; radians): aileron + = roll right (left TE down); elevator + = nose up (stabilators' TE up),
// and the stabilators add half the aileron as a differential; rudderDef + = both rudders' TE to the pilot's right; flap +
// = TE down; lef + = droop; brake 0..1 -> 0..45 deg; nozzle 0..1 opens the petals (dry -> ab radius); ab 0..1 the flame.
// No text, number, serial or insignia anywhere on the airframe: the fin-tip and fin leading-edge bands are the identity.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { JET, ANCHORS, SEAT, STICK, THROTTLE, CANOPY, MISSILE, LANE_COLORS, RAIL_KIND, stickGrip, throttleGrip, poseMatrix } from './jetspec.js';

const V3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const DEG = Math.PI / 180;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const spow = (v, p) => Math.sign(v) * Math.abs(v) ** p;

export const LIVERY = Object.freeze([
    { upper: '#7b828a', lower: '#a5abb1', radome: '#676d73', accent: LANE_COLORS[0] },   // A: light two-tone grey
    { upper: '#535a62', lower: '#7a8188', radome: '#474d53', accent: LANE_COLORS[1] },   // B: dark two-tone grey
]);
export const MEDIUM = Object.freeze({ length: 3.66, diameter: 0.178 });                     // the pylon missile (RAIL_KIND 'medium')

// ---------------------------------------------------------------------------------------------------- small maths
function pchip(xs, ys) {   // monotone cubic through (xs ascending, ys)
    const n = xs.length, d = [], m = new Array(n);
    for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
    m[0] = d[0]; m[n - 1] = d[n - 2];
    for (let i = 1; i < n - 1; i++) {
        if (d[i - 1] * d[i] <= 0) { m[i] = 0; continue; }
        const w1 = 2 * (xs[i + 1] - xs[i]) + (xs[i] - xs[i - 1]), w2 = (xs[i + 1] - xs[i]) + 2 * (xs[i] - xs[i - 1]);
        m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
    }
    return (x) => {
        if (x <= xs[0]) return ys[0];
        if (x >= xs[n - 1]) return ys[n - 1];
        let i = 0; while (x > xs[i + 1]) i++;
        const h = xs[i + 1] - xs[i], t = (x - xs[i]) / h, t2 = t * t, t3 = t2 * t;
        return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
    };
}
function stationFns(rows, keys) {   // rows [z, ...values] -> z -> { key: value }
    const s = rows.slice().sort((a, b) => a[0] - b[0]), zs = s.map((r) => r[0]);
    const fns = keys.map((k, i) => pchip(zs, s.map((r) => r[i + 1])));
    return (z) => { const o = {}; keys.forEach((k, i) => (o[k] = fns[i](z))); return o; };
}

// ---------------------------------------------------------------------------------------------------- geometry helpers
function gridGeo(rings, { closed = false, uv = null, skip = null } = {}) {
    const R = rings.length, K = rings[0].length, pos = new Float32Array(R * K * 3), uvs = new Float32Array(R * K * 2), idx = [];
    for (let i = 0; i < R; i++) for (let j = 0; j < K; j++) {
        const p = rings[i][j], o = i * K + j;
        pos[o * 3] = p.x; pos[o * 3 + 1] = p.y; pos[o * 3 + 2] = p.z;
        const t = uv ? uv(i, j, p) : [-p.z / 4, j / K];
        uvs[o * 2] = t[0]; uvs[o * 2 + 1] = t[1];
    }
    const J = closed ? K : K - 1;
    for (let i = 0; i < R - 1; i++) for (let j = 0; j < J; j++) {
        if (skip && skip(i, j)) continue;
        const j2 = (j + 1) % K, a = i * K + j, b = i * K + j2, c = (i + 1) * K + j, d = (i + 1) * K + j2;
        idx.push(a, b, c, b, d, c);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    g.setIndex(idx);
    return g;
}
function capGeo(ring, uvScale = 0.25) {   // fan over a (convex-ish) ring
    const c = V3(); ring.forEach((p) => c.add(p)); c.multiplyScalar(1 / ring.length);
    const pos = [], uvs = [];
    for (let j = 0; j < ring.length; j++) {
        const a = ring[j], b = ring[(j + 1) % ring.length];
        pos.push(c.x, c.y, c.z, a.x, a.y, a.z, b.x, b.y, b.z);
        uvs.push(c.z * uvScale, c.x * uvScale, a.z * uvScale, a.x * uvScale, b.z * uvScale, b.x * uvScale);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    return g;
}
function flipWinding(g) {
    if (g.index) { const a = g.index.array; for (let i = 0; i < a.length; i += 3) { const t = a[i + 1]; a[i + 1] = a[i + 2]; a[i + 2] = t; } g.index.needsUpdate = true; return g; }
    for (const name of Object.keys(g.attributes)) {
        const at = g.attributes[name], s = at.itemSize, arr = at.array;
        for (let i = 0; i < at.count; i += 3) for (let k = 0; k < s; k++) { const t = arr[(i + 1) * s + k]; arr[(i + 1) * s + k] = arr[(i + 2) * s + k]; arr[(i + 2) * s + k] = t; }
        at.needsUpdate = true;
    }
    return g;
}
/** turn the triangles to face away from `centre` on balance (closed or open convex-ish shells) */
function orientOutward(g, centre) {
    const p = g.attributes.position, idx = g.index ? g.index.array : null, n = idx ? idx.length : p.count;
    const a = V3(), b = V3(), c = V3(), e1 = V3(), e2 = V3(); let s = 0;
    for (let i = 0; i < n; i += 3) {
        a.fromBufferAttribute(p, idx ? idx[i] : i); b.fromBufferAttribute(p, idx ? idx[i + 1] : i + 1); c.fromBufferAttribute(p, idx ? idx[i + 2] : i + 2);
        e1.subVectors(b, a); e2.subVectors(c, a); e1.cross(e2);
        s += e1.dot(a.add(b).add(c).multiplyScalar(1 / 3).sub(centre));
    }
    if (s < 0) flipWinding(g);
    return g;
}
function mirrorX(g) { const m = g.clone(); m.scale(-1, 1, 1); flipWinding(m); m.computeVertexNormals(); return m; }
/** merge a mix of indexed / non-indexed geometries (keeps position, normal, uv) */
function merge(list) {
    const gs = list.map((g) => {
        const n = g.index ? g.toNonIndexed() : g.clone();
        if (!n.attributes.normal) n.computeVertexNormals();
        if (!n.attributes.uv) n.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n.attributes.position.count * 2), 2));
        for (const k of Object.keys(n.attributes)) if (!['position', 'normal', 'uv'].includes(k)) n.deleteAttribute(k);
        n.morphAttributes = {};
        return n;
    });
    return mergeGeometries(gs, false);
}
const _Y = V3(0, 1, 0), _q = new THREE.Quaternion(), _m4 = new THREE.Matrix4();
function tube(a, b, r, radial = 10, cap = true) {
    const d = V3().subVectors(b, a), len = d.length();
    const g = new THREE.CylinderGeometry(r, r, len, radial, 1, !cap);
    _q.setFromUnitVectors(_Y, d.normalize());
    g.applyMatrix4(_m4.compose(V3().addVectors(a, b).multiplyScalar(0.5), _q, V3(1, 1, 1)));
    return g;
}
function polyTube(pts, r, radial = 8) {
    const out = [];
    for (let i = 0; i < pts.length - 1; i++) out.push(tube(pts[i], pts[i + 1], r, radial, false));
    for (const p of pts) out.push(new THREE.SphereGeometry(r, radial, 4).translate(p.x, p.y, p.z));
    return out;
}
const box = (w, h, d, x, y, z) => new THREE.BoxGeometry(w, h, d).translate(x, y, z);
const rbox = (w, h, d, x, y, z, r = 0.02) => new RoundedBoxGeometry(w, h, d, 2, Math.min(r, w / 2 - 1e-3, h / 2 - 1e-3, d / 2 - 1e-3)).translate(x, y, z);

// ---------------------------------------------------------------------------------------------------- airfoil lofts
const NACA = (x, t) => 5 * t * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1036 * x ** 4);
/** A lifting surface (or the chord slice f0..f1 of one) lofted spanwise.
 *  stations [{ s, zLE, c, t }], frame { o, span, thick }: point = o + span*s + thick*h, z = o.z + zLE - f*c */
function surfaceGeo(stations, f0, f1, frame, { K = 12, caps = [true, true], tile = 4 } = {}) {
    const fr = [];
    for (let i = 0; i <= K; i++) { const u = (1 - Math.cos((Math.PI * i) / K)) / 2; fr.push(f0 + (f1 - f0) * u); }
    const ringFor = (st) => {
        const pts = [];
        const at = (f, sgn) => {
            const z = st.zLE - f * st.c, h = Math.max(NACA(clamp(f, 0, 1), st.t) * st.c, 0.0018);
            return V3().copy(frame.o).addScaledVector(frame.span, st.s).addScaledVector(frame.thick, sgn * h).setZ(frame.o.z + z);
        };
        for (let i = 0; i <= K; i++) pts.push(at(fr[i], 1));
        for (let i = K; i >= 0; i--) pts.push(at(fr[i], -1));
        return pts;
    };
    const rings = stations.map(ringFor);
    const parts = [gridGeo(rings, { closed: true, uv: (i, j, p) => [-p.z / tile, stations[i].s / tile] })];
    if (caps[0]) parts.push(capGeo(rings[0]));
    if (caps[1]) parts.push(capGeo(rings[rings.length - 1]));
    const out = merge(parts);
    const c = V3(); for (const r of rings) for (const p of r) c.add(p); c.multiplyScalar(1 / (rings.length * rings[0].length));
    orientOutward(out, c); out.computeVertexNormals();
    return out;
}
function planAt(root, tip, s) {
    const f = (s - root.s) / (tip.s - root.s);
    return { s, zLE: root.zLE + (tip.zLE - root.zLE) * f, c: root.c + (tip.c - root.c) * f, t: root.t + (tip.t - root.t) * f };
}
function stationsBetween(root, tip, s0, s1, n) { const out = []; for (let i = 0; i <= n; i++) out.push(planAt(root, tip, s0 + ((s1 - s0) * i) / n)); return out; }
function hingePt(root, tip, frame, s, f) {
    const st = planAt(root, tip, s);
    return V3().copy(frame.o).addScaledVector(frame.span, s).setZ(frame.o.z + st.zLE - f * st.c);
}

// ---------------------------------------------------------------------------------------------------- textures (shared)
let _tex = null;
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return [c, c.getContext('2d')]; }
function sharedTextures() {
    if (_tex || typeof document === 'undefined') return _tex;
    const S = 1024, r = rng(11);
    const panels = [];
    const split = (x, y, w, h, d) => {
        if (d > 4 || (w < 170 && h < 170) || (d > 1 && r() < 0.16)) { panels.push([x, y, w, h]); return; }
        if (w > h ? r() < 0.82 : r() < 0.18) { const k = Math.round(w * (0.3 + r() * 0.4)); split(x, y, k, h, d + 1); split(x + k, y, w - k, h, d + 1); }
        else { const k = Math.round(h * (0.3 + r() * 0.4)); split(x, y, w, k, d + 1); split(x, y + k, w, h - k, d + 1); }
    };
    split(0, 0, S, S, 0);
    const lines = (g, style, lw) => { g.strokeStyle = style; g.lineWidth = lw; for (const [x, y, w, h] of panels) g.strokeRect(x + 0.5, y + 0.5, w, h); };
    const rivets = (g, style) => {
        g.fillStyle = style;
        for (const [x, y, w, h] of panels) {
            if (r() < 0.5) continue;
            for (let i = 1; i < Math.floor(w / 20); i++) { g.fillRect(x + i * 20, y + 6, 2, 2); g.fillRect(x + i * 20, y + h - 7, 2, 2); }
            for (let i = 1; i < Math.floor(h / 20); i++) { g.fillRect(x + 6, y + i * 20, 2, 2); g.fillRect(x + w - 7, y + i * 20, 2, 2); }
        }
    };
    // colour: near-white so the vertex colours carry the paint; faint panel lines, touch-up patches, grime streaking AFT
    // (u = -z / 4 on every part, so a horizontal streak in the texture runs along the airflow)
    const [cc, gc] = canvas(S, S);
    gc.fillStyle = '#f0f0f0'; gc.fillRect(0, 0, S, S);
    for (const [x, y, w, h] of panels) if (r() < 0.14) { gc.fillStyle = `rgba(${r() < 0.5 ? '255,255,255' : '200,205,210'},${0.05 + r() * 0.05})`; gc.fillRect(x, y, w, h); }
    gc.save(); gc.filter = 'blur(26px)';
    for (let i = 0; i < 50; i++) { gc.fillStyle = `rgba(40,36,30,${0.015 + r() * 0.035})`; gc.beginPath(); gc.ellipse(r() * S, r() * S, 60 + r() * 200, 25 + r() * 70, 0, 0, 7); gc.fill(); }
    gc.filter = 'blur(2.5px)';
    for (let i = 0; i < 300; i++) { gc.fillStyle = `rgba(35,30,25,${0.02 + r() * 0.05})`; gc.fillRect(r() * S, r() * S, 80 + r() * 320, 1 + r() * 3); }
    gc.restore();
    for (let i = 0; i < 12000; i++) { gc.fillStyle = `rgba(${r() < 0.5 ? '255,255,255' : '0,0,0'},${0.02 + r() * 0.03})`; gc.fillRect(r() * S, r() * S, 1 + r() * 2, 1 + r() * 2); }
    lines(gc, 'rgba(45,45,45,0.2)', 1.2); rivets(gc, 'rgba(70,70,70,0.16)');
    const [cb, gb] = canvas(S, S);
    gb.fillStyle = '#ffffff'; gb.fillRect(0, 0, S, S); lines(gb, '#303030', 2.2); rivets(gb, '#9a9a9a');
    const [cr, gr] = canvas(S, S);
    gr.fillStyle = 'rgb(0,160,0)'; gr.fillRect(0, 0, S, S);                       // roughness ~0.63 in G
    gr.save(); gr.filter = 'blur(24px)';
    for (let i = 0; i < 60; i++) { gr.fillStyle = `rgba(0,${r() < 0.5 ? 205 : 120},0,${0.3 + r() * 0.4})`; gr.beginPath(); gr.ellipse(r() * S, r() * S, 60 + r() * 200, 30 + r() * 90, 0, 0, 7); gr.fill(); }
    gr.restore(); lines(gr, 'rgb(0,215,0)', 2);
    const mk = (c, srgb) => { const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8; if (srgb) t.colorSpace = THREE.SRGBColorSpace; return t; };
    _tex = { col: mk(cc, true), bump: mk(cb, false), rough: mk(cr, false) };

    const [cp, gp] = canvas(256, 256);   // console tops: switches and knobs
    gp.fillStyle = '#25282c'; gp.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 40; i++) { gp.fillStyle = r() < 0.5 ? '#3a3e44' : '#18191c'; gp.fillRect(Math.floor(r() * 8) * 32 + 4, Math.floor(r() * 8) * 32 + 4, 10 + r() * 14, 6 + r() * 10); }
    for (let i = 0; i < 30; i++) { gp.fillStyle = ['#c9c9c0', '#d8b23a', '#8fb08a'][Math.floor(r() * 3)]; gp.beginPath(); gp.arc(r() * 256, r() * 256, 2 + r() * 3, 0, 7); gp.fill(); }
    _tex.console = mk(cp, true);

    const [cm, gm] = canvas(256, 256);   // an MFD: shapes only, no text
    gm.fillStyle = '#05100a'; gm.fillRect(0, 0, 256, 256);
    gm.strokeStyle = '#46d867'; gm.lineWidth = 3; gm.strokeRect(14, 14, 228, 228);
    gm.beginPath(); gm.arc(128, 150, 72, Math.PI, 2 * Math.PI); gm.stroke();
    gm.beginPath(); gm.moveTo(128, 150); gm.lineTo(172, 96); gm.stroke();
    gm.fillStyle = '#46d867'; for (let i = 0; i < 6; i++) gm.fillRect(30 + i * 34, 26, 20, 6);
    for (let i = 0; i < 5; i++) gm.fillRect(30, 200 + i * 7, 40 + r() * 60, 3);
    _tex.mfd = mk(cm, true);

    const [ch, gh] = canvas(256, 256);   // HUD symbols: flight-path marker, pitch ladder, two tapes (no text)
    gh.strokeStyle = 'rgba(120,255,140,0.95)'; gh.lineWidth = 3;
    gh.beginPath(); gh.arc(128, 128, 14, 0, 7); gh.moveTo(100, 128); gh.lineTo(114, 128); gh.moveTo(142, 128); gh.lineTo(156, 128); gh.moveTo(128, 114); gh.lineTo(128, 104); gh.stroke();
    for (let i = -2; i <= 2; i++) if (i) { gh.beginPath(); gh.moveTo(66, 128 + i * 42); gh.lineTo(106, 128 + i * 42); gh.moveTo(150, 128 + i * 42); gh.lineTo(190, 128 + i * 42); gh.stroke(); }
    gh.strokeRect(18, 60, 26, 136); gh.strokeRect(212, 60, 26, 136);
    _tex.hud = mk(ch, true);

    const [cs, gs] = canvas(64, 64);     // yellow-and-black handle stripes
    gs.fillStyle = '#e3bd1f'; gs.fillRect(0, 0, 64, 64); gs.fillStyle = '#141414';
    for (let i = -4; i < 8; i++) { gs.beginPath(); gs.moveTo(i * 16, 0); gs.lineTo(i * 16 + 8, 0); gs.lineTo(i * 16 + 72, 64); gs.lineTo(i * 16 + 64, 64); gs.fill(); }
    _tex.stripes = mk(cs, true);
    _tex.loop = mk(cs, true); _tex.loop.repeat.set(7, 1);            // the firing loop: stripes along its length

    const [cu, gu] = canvas(256, 256);   // worn dark-olive seat fabric: mottled, rubbed lighter on the edges, quilted seams
    gu.fillStyle = '#3d4130'; gu.fillRect(0, 0, 256, 256);
    gu.save(); gu.filter = 'blur(10px)';
    for (let i = 0; i < 60; i++) { gu.fillStyle = `rgba(${r() < 0.5 ? '96,100,78' : '28,30,22'},${0.12 + r() * 0.2})`; gu.beginPath(); gu.ellipse(r() * 256, r() * 256, 10 + r() * 40, 8 + r() * 30, 0, 0, 7); gu.fill(); }
    gu.restore();
    for (let i = 0; i < 4000; i++) { gu.fillStyle = `rgba(${r() < 0.5 ? '255,255,240' : '0,0,0'},${0.03 + r() * 0.04})`; gu.fillRect(r() * 256, r() * 256, 1, 1 + r() * 2); }
    gu.strokeStyle = 'rgba(18,19,14,0.7)'; gu.lineWidth = 2; for (const x of [64, 128, 192]) { gu.beginPath(); gu.moveTo(x, 0); gu.lineTo(x, 256); gu.stroke(); }
    gu.strokeStyle = 'rgba(120,124,98,0.25)'; gu.lineWidth = 1; for (const x of [67, 131, 195]) { gu.beginPath(); gu.moveTo(x, 0); gu.lineTo(x, 256); gu.stroke(); }
    _tex.cushion = mk(cu, true);

    const [cf, gf] = canvas(128, 64);    // flare dispenser: a grid of tube mouths
    gf.fillStyle = '#3a3d41'; gf.fillRect(0, 0, 128, 64);
    for (let i = 0; i < 8; i++) for (let j = 0; j < 4; j++) { gf.fillStyle = '#0d0e0f'; gf.beginPath(); gf.arc(10 + i * 15.5, 9 + j * 15, 5.5, 0, 7); gf.fill(); }
    _tex.flare = mk(cf, true);

    const [cz, gz] = canvas(512, 512);   // scorch: soot + streaks running aft, alpha falling off from the hit
    gz.save(); gz.filter = 'blur(20px)';
    for (let i = 0; i < 90; i++) { const a = r() * 7, d = r() ** 0.7 * 190; gz.fillStyle = `rgba(${10 + r() * 18},${9 + r() * 8},8,${0.25 + r() * 0.35})`; gz.beginPath(); gz.ellipse(256 + Math.cos(a) * d * 1.2, 256 + Math.sin(a) * d * 0.8, 30 + r() * 60, 18 + r() * 40, r() * 3, 0, 7); gz.fill(); }
    gz.filter = 'blur(4px)';
    for (let i = 0; i < 140; i++) { gz.fillStyle = `rgba(10,9,8,${0.2 + r() * 0.4})`; gz.fillRect(256 + r() * 20, 170 + r() * 170, 60 + r() * 200, 2 + r() * 5); }
    gz.restore();
    _tex.scorch = mk(cz, true); _tex.scorch.wrapS = _tex.scorch.wrapT = THREE.ClampToEdgeWrapping;

    const [ck, gk] = canvas(512, 512);   // missing panels: dark cavities with ribs, torn bare edges, a few embers
    for (const [hx, hy, hw, hh] of [[250, 250, 92, 62], [372, 300, 48, 36], [140, 300, 42, 30], [300, 160, 36, 26], [190, 190, 30, 22]]) {
        const pts = [];
        for (let i = 0; i < 16; i++) { const a = (i / 16) * Math.PI * 2, k = 0.8 + r() * 0.25; pts.push([hx + Math.cos(a) * hw * k, hy + Math.sin(a) * hh * k]); }
        const path = () => { gk.beginPath(); pts.forEach(([x, y], i) => (i ? gk.lineTo(x, y) : gk.moveTo(x, y))); gk.closePath(); };
        path(); gk.fillStyle = '#080706'; gk.fill();
        gk.save(); path(); gk.clip();
        gk.strokeStyle = '#2d2824'; gk.lineWidth = 5; for (let x = hx - hw; x < hx + hw; x += 22) { gk.beginPath(); gk.moveTo(x, hy - hh); gk.lineTo(x, hy + hh); gk.stroke(); }
        gk.strokeStyle = '#1d1a17'; gk.lineWidth = 3; for (let i = 0; i < 6; i++) { gk.beginPath(); gk.moveTo(hx - hw + r() * hw * 2, hy - hh); gk.bezierCurveTo(hx, hy, hx + r() * 30, hy, hx - hw + r() * hw * 2, hy + hh); gk.stroke(); }
        gk.restore();
        path(); gk.strokeStyle = '#a39c92'; gk.lineWidth = 3; gk.stroke();
        gk.strokeStyle = 'rgba(255,120,30,0.9)'; gk.lineWidth = 1.5; gk.setLineDash([4, 9]); path(); gk.stroke(); gk.setLineDash([]);
    }
    _tex.holes = mk(ck, true); _tex.holes.wrapS = _tex.holes.wrapT = THREE.ClampToEdgeWrapping;
    return _tex;
}

// ---------------------------------------------------------------------------------------------------- materials
/** Glass: alpha rises with a fresnel term towards the silhouette (the sky's reflection lives there), and the lit colour is capped
 *  so the sun's highlight on a smooth sheet never blows out. Guarded: no normalize(0), pow on a clamped base. */
function glassShader(mat, fres, maxA, cap) {
    mat.onBeforeCompile = (sh) => {
        if (!sh.fragmentShader.includes('#include <opaque_fragment>')) return;     // an unknown three: plain glass, never a broken one
        sh.fragmentShader = sh.fragmentShader.replace('#include <opaque_fragment>', `{
            vec3 gV = vViewPosition; gV = dot(gV, gV) > 1e-12 ? normalize(gV) : vec3(0.0, 0.0, 1.0);
            vec3 gN = dot(normal, normal) > 1e-12 ? normalize(normal) : gV;
            float gF = pow(clamp(1.0 - abs(dot(gN, gV)), 0.0, 1.0), 4.0);
            diffuseColor.a = clamp(diffuseColor.a + ${fres.toFixed(3)} * gF, 0.0, ${maxA.toFixed(3)});
            outgoingLight = clamp(outgoingLight, vec3(0.0), vec3(${cap.toFixed(3)}));
        }
        #include <opaque_fragment>`);
    };
    mat.customProgramCacheKey = () => `jetglass-${fres}-${maxA}-${cap}`;
    return mat;
}
/** perf2: three draws a transparent DoubleSide material in two passes (back faces, then front) by flipping material.side and
 *  setting needsUpdate on EVERY draw, so its program parameters are re-derived twice per draw (the PERF lane's "shared
 *  material" garbage, ~4 MB/s). The same two passes, in the same order, as two meshes: this one keeps the back faces and a
 *  child at identity (higher id, same depth and renderOrder, so the transparent sort draws it right after) the front faces.
 *  Geometry, uniforms and shader hooks are shared; flags are copied, so call it after they are set. A skinned mesh's child
 *  is bound to the same skeleton and borrows the parent's bounding sphere (same sort depth). */
function twoPass(mesh) {
    const m = mesh.material;
    if (!mesh.isMesh || Array.isArray(m) || !m.transparent || m.side !== THREE.DoubleSide || m.forceSinglePass) return mesh;
    const sided = (s) => { const x = m.clone(); x.side = s; x.onBeforeCompile = m.onBeforeCompile; x.customProgramCacheKey = m.customProgramCacheKey; if (m.uniforms) x.uniforms = m.uniforms; return x; };
    const front = sided(THREE.FrontSide);
    mesh.material = sided(THREE.BackSide);
    const f = mesh.isSkinnedMesh ? new THREE.SkinnedMesh(mesh.geometry, front) : new THREE.Mesh(mesh.geometry, front);
    if (mesh.isSkinnedMesh) {
        f.bind(mesh.skeleton, mesh.bindMatrix);
        f.computeBoundingSphere = function () { if (mesh.boundingSphere === null) mesh.computeBoundingSphere(); this.boundingSphere = mesh.boundingSphere; };
    }
    f.name = mesh.name + '-front'; f.renderOrder = mesh.renderOrder; f.frustumCulled = mesh.frustumCulled;
    f.castShadow = mesh.castShadow; f.receiveShadow = mesh.receiveShadow; f.userData.twoPassOf = mesh;
    mesh.add(f);
    return mesh;
}
function makeMaterials(liv) {
    const T = sharedTextures();
    const mkMetal = () => new THREE.MeshStandardMaterial({ color: '#8b8f94', roughness: 0.35, metalness: 0.9 });
    return {
        paint: new THREE.MeshStandardMaterial({ color: '#ffffff', vertexColors: true, roughness: 0.62, metalness: 0.1,
            map: T?.col ?? null, bumpMap: T?.bump ?? null, bumpScale: 0.6, roughnessMap: T?.rough ?? null }),
        radome: new THREE.MeshStandardMaterial({ color: liv.radome, roughness: 0.48, metalness: 0.05, map: T?.col ?? null }),
        accent: new THREE.MeshStandardMaterial({ color: liv.accent, roughness: 0.55, metalness: 0.08, map: T?.col ?? null, bumpMap: T?.bump ?? null, bumpScale: 1.2 }),
        dark: new THREE.MeshStandardMaterial({ color: '#16171a', roughness: 0.8, metalness: 0.1 }),
        duct: new THREE.MeshStandardMaterial({ color: '#33363a', roughness: 0.75, metalness: 0.1, side: THREE.BackSide }),
        cockpit: new THREE.MeshStandardMaterial({ color: '#2b2f34', roughness: 0.72, metalness: 0.15, side: THREE.DoubleSide }),
        console: new THREE.MeshStandardMaterial({ color: '#ffffff', map: T?.console ?? null, roughness: 0.6, metalness: 0.2 }),
        coaming: new THREE.MeshStandardMaterial({ color: '#131416', roughness: 0.95, metalness: 0 }),
        mfd: new THREE.MeshStandardMaterial({ color: '#000000', emissive: '#ffffff', emissiveMap: T?.mfd ?? null, emissiveIntensity: 1.15, roughness: 0.25 }),
        // r6: faint symbols (the review saw a solid black block with a sun glint where the HUD should be)
        hud: new THREE.MeshBasicMaterial({ map: T?.hud ?? null, color: '#9fe0ae', transparent: true, opacity: 0.42, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }),
        hudGlass: glassShader(new THREE.MeshPhysicalMaterial({ color: '#8fb8a2', roughness: 0.22, transparent: true, opacity: 0.2, depthWrite: false, side: THREE.DoubleSide,
            envMapIntensity: 0.35, specularIntensity: 0.35 }), 0.2, 0.4, 1.6),
        // GREY glass (research B2: never gold). r6: 0.06 read as no canopy at all; now 0.12 with a cool tint, a fresnel rise towards the
        // silhouette (where real glass reflects the sky) and the sun's highlight capped so it never blows out under the bloom
        glass: glassShader(new THREE.MeshPhysicalMaterial({ color: '#c3ced6', roughness: 0.1, metalness: 0, transparent: true, opacity: 0.12, depthWrite: false,
            side: THREE.DoubleSide, envMapIntensity: 1.0, specularIntensity: 0.7 }), 0.22, 0.32, 2.0),
        // perf2: three keys a program on the OBJECT too (morph targets), so one material on a morphed and an unmorphed mesh is
        // re-derived on every draw that alternates them. The same metal, its own copy for the nozzle lips (morphed; toggles and
        // pedals are not):
        metalMorph: mkMetal(),
        pad: new THREE.MeshStandardMaterial({ color: '#1d1e21', roughness: 0.95, metalness: 0 }),                    // coaming and sill padding
        sill: new THREE.MeshStandardMaterial({ color: '#3b3f45', roughness: 0.5, metalness: 0.45 }),               // the sill rails: read against the paint
        frame: new THREE.MeshStandardMaterial({ color: '#2a2d31', roughness: 0.55, metalness: 0.4 }),
        seat: new THREE.MeshStandardMaterial({ color: '#2e3134', roughness: 0.7, metalness: 0.25 }),
        cushion: new THREE.MeshStandardMaterial({ color: '#ffffff', map: T?.cushion ?? null, roughness: 0.93, metalness: 0 }),
        loop: new THREE.MeshStandardMaterial({ color: '#ffffff', map: T?.loop ?? null, roughness: 0.5 }),
        buckle: new THREE.MeshStandardMaterial({ color: '#a7abb0', roughness: 0.3, metalness: 0.95 }),
        rubber: new THREE.MeshStandardMaterial({ color: '#1a1b1d', roughness: 0.85, metalness: 0 }),
        strap: new THREE.MeshStandardMaterial({ color: '#4a4e3a', roughness: 0.9, metalness: 0 }),
        stripes: new THREE.MeshStandardMaterial({ color: '#ffffff', map: T?.stripes ?? null, roughness: 0.6 }),
        metal: mkMetal(),
        rail: new THREE.MeshStandardMaterial({ color: '#4a4e53', roughness: 0.62, metalness: 0.5 }),               // r6: the seat rails glinted beside the neck
        nozzle: new THREE.MeshStandardMaterial({ color: '#ffffff', vertexColors: true, roughness: 0.42, metalness: 0.85 }),
        nozzleIn: new THREE.MeshStandardMaterial({ color: '#2e2620', roughness: 0.6, metalness: 0.6, emissive: '#ff5a14', emissiveIntensity: 0, side: THREE.BackSide }),
        turbine: new THREE.MeshStandardMaterial({ color: '#141210', roughness: 0.8, emissive: '#ff6a1a', emissiveIntensity: 0 }),
        holder: new THREE.MeshStandardMaterial({ color: '#2a2622', roughness: 0.7, emissive: '#ffb050', emissiveIntensity: 0 }),
        missile: new THREE.MeshStandardMaterial({ color: '#d4d6d2', roughness: 0.5, metalness: 0.1, map: T?.col ?? null }),
        seeker: new THREE.MeshPhysicalMaterial({ color: '#2a2622', roughness: 0.05, metalness: 0.3, clearcoat: 1 }),
        bandY: new THREE.MeshStandardMaterial({ color: '#d0a21c', roughness: 0.5 }),
        bandB: new THREE.MeshStandardMaterial({ color: '#6b4a2b', roughness: 0.6 }),
        flare: new THREE.MeshStandardMaterial({ color: '#ffffff', map: T?.flare ?? null, roughness: 0.7, metalness: 0.3, side: THREE.DoubleSide }),
        scorch: new THREE.MeshStandardMaterial({ map: T?.scorch ?? null, transparent: true, opacity: 0, roughness: 0.95, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
        holes: new THREE.MeshStandardMaterial({ map: T?.holes ?? null, transparent: true, roughness: 0.85, metalness: 0.2, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }),
        torn: new THREE.MeshStandardMaterial({ color: '#2a2724', roughness: 0.9, metalness: 0.3, side: THREE.DoubleSide }),
        red: new THREE.MeshBasicMaterial({ color: '#ff3a2a' }),
        green: new THREE.MeshBasicMaterial({ color: '#39ff6a' }),
    };
}
/** counter-shading: upper surfaces darker, lower lighter, a soft blend on the sides (vertex colours from the normals) */
function counterShade(g, upper, lower) {
    if (!g.attributes.normal) g.computeVertexNormals();
    const n = g.attributes.normal, col = new Float32Array(n.count * 3), U = new THREE.Color(upper), L = new THREE.Color(lower), c = new THREE.Color();
    for (let i = 0; i < n.count; i++) {
        const t = clamp((n.getY(i) + 0.25) / 0.6, 0, 1), k = t * t * (3 - 2 * t);
        c.copy(L).lerp(U, k); col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    return g;
}

// ---------------------------------------------------------------------------------------------------- the fuselage
// [z, w (half width), yc, top, bot, nt, nb] -- superellipse sections; nose tip z = JET.noseZ; the body ends at BODY_Z1
const BODY_ROWS = [
    [8.50, 0.015, 0.03, 0.015, 0.015, 2.0, 2.0],
    [8.30, 0.13, 0.035, 0.13, 0.125, 2.0, 2.0],
    [7.90, 0.26, 0.045, 0.255, 0.245, 2.0, 2.1],
    [7.20, 0.40, 0.065, 0.39, 0.37, 2.1, 2.4],
    [6.40, 0.52, 0.09, 0.53, 0.46, 2.3, 2.9],
    [5.70, 0.60, 0.11, 0.74, 0.53, 2.8, 3.3],
    [4.80, 0.65, 0.12, 0.81, 0.58, 3.1, 3.5],
    [3.80, 0.68, 0.12, 0.83, 0.61, 3.1, 3.5],
    [2.90, 0.74, 0.11, 0.88, 0.63, 3.0, 3.4],
    [2.00, 0.80, 0.09, 0.84, 0.63, 3.0, 3.4],
    [0.80, 0.80, 0.07, 0.74, 0.61, 3.1, 3.5],
    [-0.60, 0.78, 0.05, 0.66, 0.60, 3.2, 3.6],
    [-2.00, 0.88, 0.03, 0.60, 0.58, 3.4, 3.4],
    [-3.60, 1.06, 0.01, 0.56, 0.56, 3.8, 3.2],
    [-5.20, 1.12, 0.00, 0.52, 0.55, 4.0, 3.2],
    [-6.60, 1.10, 0.00, 0.46, 0.52, 4.0, 3.2],
    [-7.55, 1.06, 0.00, 0.40, 0.47, 3.8, 3.0],
];
const bodyAt = stationFns(BODY_ROWS, ['w', 'yc', 'top', 'bot', 'nt', 'nb']);
const BODY_Z1 = -7.55;
const SILL = CANOPY.sill, HOLE = [CANOPY.z[0], CANOPY.windscreenZ[1]];   // the cockpit opening: canopy + windscreen footprint
function bodyPoint(b, th, lift = 0) {
    const c = Math.cos(th), s = Math.sin(th), n = s >= 0 ? b.nt : b.nb, h = s >= 0 ? b.top : b.bot;
    return [(b.w + lift) * spow(c, 2 / n), b.yc + (h + lift) * spow(s, 2 / n)];
}
/** the body's half-width at height y (upper half) at z */
export function bodyHalfWidthAt(z, y) {
    const b = bodyAt(z), up = y >= b.yc, r = (y - b.yc) / (up ? b.top : b.bot), n = up ? b.nt : b.nb;
    return Math.abs(r) >= 1 ? 0 : b.w * (1 - Math.abs(r) ** n) ** (1 / n);
}
const N_AROUND = 72;
function buildFuselage() {
    const zs = new Set();
    for (let z = 8.5; z > 6.4; z -= 0.07) zs.add(+z.toFixed(3));
    for (let z = 6.4; z > BODY_Z1; z -= 0.14) zs.add(+z.toFixed(3));
    for (const z of [...HOLE, BODY_Z1]) zs.add(z);
    const Z = [...zs].sort((a, b) => b - a);
    const rings = Z.map((z) => { const b = bodyAt(z), ring = []; for (let j = 0; j <= N_AROUND; j++) { const [x, y] = bodyPoint(b, -Math.PI / 2 + (2 * Math.PI * j) / N_AROUND); ring.push(V3(x, y, z)); } return ring; });
    // the cockpit opening: one column each side, in every ring of the opening, is pulled exactly onto the sill; the quads
    // between them (over the top) are dropped. The windscreen and canopy rings start from the same sill points.
    const inHole = (z) => z <= HOLE[1] + 1e-6 && z >= HOLE[0] - 1e-6, mid = (HOLE[0] + HOLE[1]) / 2;
    const xs = bodyHalfWidthAt(mid, SILL);
    let jL = N_AROUND / 2, best = Infinity;
    rings[Z.findIndex((z) => z <= mid)].forEach((p, j) => { if (j < N_AROUND / 2 && p.y > 0 && Math.abs(p.x - xs) < best) { best = Math.abs(p.x - xs); jL = j; } });
    const jR = N_AROUND - jL;
    Z.forEach((z, i) => { if (inHole(z)) { const x = bodyHalfWidthAt(z, SILL); rings[i][jL].set(x, SILL, z); rings[i][jR].set(-x, SILL, z); } });
    const arc = rings.map((r) => { const a = [0]; for (let j = 1; j < r.length; j++) a.push(a[j - 1] + r[j].distanceTo(r[j - 1])); return a; });
    const split = Z.findIndex((z) => z <= 6.85);                   // the radome is the part ahead of this ring
    const mk = (i0, i1) => {
        const g = gridGeo(rings.slice(i0, i1 + 1), { uv: (i, j, p) => [-p.z / 4, arc[i + i0][j] / 4], skip: (i, j) => inHole(Z[i + i0]) && inHole(Z[i + i0 + 1]) && j >= jL && j < jR });
        orientOutward(g, V3(0, 0.05, (Z[i0] + Z[i1]) / 2)); g.computeVertexNormals();
        const nn = g.attributes.normal, K = N_AROUND + 1;          // weld the belly seam (columns 0 and N are the same points)
        for (let i = 0; i <= i1 - i0; i++) {
            const a = i * K, b = a + N_AROUND, x = nn.getX(a) + nn.getX(b), y = nn.getY(a) + nn.getY(b), z = nn.getZ(a) + nn.getZ(b), l = Math.hypot(x, y, z) || 1;
            nn.setXYZ(a, x / l, y / l, z / l); nn.setXYZ(b, x / l, y / l, z / l);
        }
        return g;
    };
    const rear = capGeo(rings[rings.length - 1]); orientOutward(rear, V3(0, 0, BODY_Z1 + 1));
    return { radome: mk(0, split), body: mk(split, rings.length - 1), rear };
}
/** a strip over the body surface: theta in [a0(z), a1(z)] (0 = the left side, +pi/2 = the top), lifted `lift` m */
function bodyStrip(z0, z1, a0, a1, lift = 0.006, nz = 30, na = 8) {
    const rings = [];
    for (let i = 0; i <= nz; i++) {
        const z = z1 + ((z0 - z1) * i) / nz, b = bodyAt(z), ring = [];
        for (let j = 0; j <= na; j++) { const [x, y] = bodyPoint(b, a0(z) + ((a1(z) - a0(z)) * j) / na, lift); ring.push(V3(x, y, z)); }
        rings.push(ring);
    }
    const g = gridGeo(rings, { uv: (i, j, p) => [-p.z / 4, j / na] });
    orientOutward(g, V3(0, bodyAt((z0 + z1) / 2).yc, (z0 + z1) / 2)); g.computeVertexNormals();
    return g;
}

// side intakes under the LERX, the mouth raked (top-outer corner leading, caret-style); they become the engine bulges
const INTAKE_ROWS = [
    [3.55, 1.02, -0.26, 0.33, 0.43, 5.5],
    [2.60, 1.02, -0.25, 0.34, 0.44, 5.0],
    [1.20, 0.99, -0.22, 0.35, 0.45, 4.6],
    [-0.40, 0.92, -0.17, 0.36, 0.47, 4.0],
    [-2.00, 0.80, -0.11, 0.38, 0.49, 3.4],
    [-3.40, 0.66, -0.07, 0.40, 0.52, 3.0],
];
const intakeAt = stationFns(INTAKE_ROWS, ['cx', 'cy', 'hw', 'hh', 'n']);
const INTAKE_Z0 = 3.55;
function intakeRing(z, inset = 0, around = 32) {
    const t = intakeAt(z), ring = [], k = clamp((z - (INTAKE_Z0 - 1.0)) / 1.0, 0, 1);       // the rake fades out 1 m in
    for (let j = 0; j <= around; j++) {
        const th = (2 * Math.PI * j) / around, c = Math.cos(th), s = Math.sin(th);
        const xx = (t.hw - inset) * spow(c, 2 / t.n), yy = (t.hh - inset) * spow(s, 2 / t.n);
        ring.push(V3(t.cx + xx, t.cy + yy, z + k * (0.15 * (yy / t.hh - 1) + 0.08 * (xx / t.hw - 1))));
    }
    return ring;
}
function buildIntakeL() {
    const zs = []; for (let z = INTAKE_Z0; z > -3.4; z -= 0.17) zs.push(z); zs.push(-3.4);
    const outer = zs.map((z) => intakeRing(z));
    const og = gridGeo(outer, { uv: (i, j, p) => [-p.z / 4, j / 8] });
    orientOutward(og, V3(intakeAt(0).cx, intakeAt(0).cy, 0)); og.computeVertexNormals();
    const izs = []; for (let z = INTAKE_Z0; z > 1.6; z -= 0.15) izs.push(z);
    const inner = izs.map((z) => intakeRing(z, 0.045));
    const ig = gridGeo(inner, { uv: (i, j, p) => [-p.z / 4, j / 8] });
    orientOutward(ig, V3(intakeAt(2.6).cx, intakeAt(2.6).cy, 2.6)); ig.computeVertexNormals();   // + a BackSide material = seen from inside
    const lip = gridGeo([outer[0], inner[0]], { uv: (i, j) => [i * 0.02, j / 8] });
    orientOutward(lip, V3(intakeAt(2.8).cx, intakeAt(2.8).cy, 2.8)); lip.computeVertexNormals();
    const face = capGeo(inner[inner.length - 1]);
    return { outer: og, inner: ig, lip, face };
}
const NAC = { x: ANCHORS.nozzles[0][0], y: ANCHORS.nozzles[0][1] };     // the left engine's axis (the right one mirrored)
function buildNacelleL() {
    const rows = [[-7.6, 0.51], [-7.0, 0.54], [-5.8, 0.57], [-4.0, 0.56], [-2.6, 0.48]], f = pchip(rows.map((r) => r[0]), rows.map((r) => r[1]));
    const zs = []; for (let z = -2.6; z >= -7.6; z -= 0.2) zs.push(z);
    const rings = zs.map((z) => { const r = f(z), ring = []; for (let j = 0; j <= 28; j++) { const a = (2 * Math.PI * j) / 28; ring.push(V3(NAC.x + r * Math.cos(a), NAC.y + r * Math.sin(a), z)); } return ring; });
    const g = gridGeo(rings, { uv: (i, j, p) => [-p.z / 4, j / 10] });
    orientOutward(g, V3(NAC.x, NAC.y, -5)); g.computeVertexNormals();
    return g;
}

// ---------------------------------------------------------------------------------------------------- nozzles + flame
const NZR = ANCHORS.nozzleR, NZ_OPEN = NZR.ab / NZR.dry - 1, NZ_Z = ANCHORS.nozzle[2];
/** a relative morph target that widens the exit from nozzleR.dry to .ab, fading to nothing at the root */
function nozzleMorph(g, cx) {
    const p = g.attributes.position, d = new Float32Array(p.count * 3), z0 = BODY_Z1 - 0.05;
    for (let i = 0; i < p.count; i++) {
        const f = clamp((z0 - p.getZ(i)) / (z0 - NZ_Z), 0, 1), k = NZ_OPEN * f * f;
        d[i * 3] = (p.getX(i) - cx) * k; d[i * 3 + 1] = (p.getY(i) - NAC.y) * k;
    }
    g.morphAttributes.position = [new THREE.BufferAttribute(d, 3)]; g.morphTargetsRelative = true;
    return g;
}
function buildNozzle(cx) {   // one nozzle on the axis (cx, NAC.y); petals (polygonal), heat tint, liner, flameholder, turbine
    const sides = 18, ringR = (z, r, wob = 0) => { const ring = []; for (let j = 0; j <= sides; j++) { const a = (2 * Math.PI * j) / sides, rr = r * (j % 2 ? 1 : 1 - wob); ring.push(V3(cx + rr * Math.cos(a), NAC.y + rr * Math.sin(a), z)); } return ring; };
    const rows = [[BODY_Z1 + 0.02, 0.50], [-7.85, 0.48], [-8.15, 0.445], [NZ_Z, NZR.dry]];
    const outer = rows.map(([z, r]) => ringR(z, r, 0.014));
    const og = gridGeo(outer, { uv: (i, j) => [i / 3, j / sides] });
    orientOutward(og, V3(cx, NAC.y, -8)); og.computeVertexNormals();
    const col = [], tint = ['#6f6d69', '#6c665c', '#7b6248', '#525a6e'].map((c) => new THREE.Color(c));   // grey -> bronze -> blue
    for (let i = 0; i < rows.length; i++) for (let j = 0; j <= sides; j++) { const c = tint[i], k = 0.9 + ((j * 7) % 5) * 0.035; col.push(c.r * k, c.g * k, c.b * k); }
    og.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    const inner = [[NZ_Z, NZR.dry - 0.02], [-8.15, NZR.dry - 0.045], [-7.8, NZR.dry - 0.07], [-7.5, NZR.dry - 0.06]].map(([z, r]) => ringR(z, r));
    const ig = gridGeo(inner, { uv: (i, j) => [i / 3, j / sides] });
    orientOutward(ig, V3(cx, NAC.y, -8)); ig.computeVertexNormals();
    const lip = gridGeo([outer[outer.length - 1], inner[0]]);
    orientOutward(lip, V3(cx, NAC.y, -7.5)); lip.computeVertexNormals();
    [og, ig, lip].forEach((g) => nozzleMorph(g, cx));
    const face = new THREE.CircleGeometry(NZR.dry - 0.06, 24).rotateY(Math.PI).translate(cx, NAC.y, -7.5);
    const holder = merge([new THREE.TorusGeometry(0.19, 0.016, 6, 24), new THREE.TorusGeometry(0.09, 0.013, 6, 18)]).translate(cx, NAC.y, -7.56);
    return { outer: og, inner: ig, lip, face, holder };
}
// the afterburner: two additive cones (an outer plume and a core with shock diamonds). Log-depth chunks included: GLUE's
// renderer runs with logarithmicDepthBuffer in jet mode (WORLD_FRAME.logDepth).
const FLAME_VS = `#include <common>
#include <logdepthbuf_pars_vertex>
varying vec2 vUv; varying vec3 vN; varying vec3 vV;
void main(){ vUv = uv; vec4 mv = modelViewMatrix * vec4(position,1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv;
#include <logdepthbuf_vertex>
}`;
const FLAME_FS = `#include <logdepthbuf_pars_fragment>
uniform float uAB; uniform float uTime; uniform float uCore; uniform float uSeed;
varying vec2 vUv; varying vec3 vN; varying vec3 vV;
void main(){
#include <logdepthbuf_fragment>
  float s = 1.0 - vUv.y;
  float face = abs(dot(normalize(vN + 1e-6), normalize(vV + 1e-6)));      // NaN guards: normalize(0) and pow(<0) made NaN pixels that the bloom pass spread over the frame
  float body = pow(max(face, 1e-6), uCore > 0.5 ? 1.2 : 2.4);
  float fall = pow(max(1.0 - s, 0.0), uCore > 0.5 ? 1.0 : 1.8);
  float fl = 0.86 + 0.14 * sin(uTime * 53.0 + uSeed + s * 9.0) * sin(uTime * 31.0 + vUv.x * 12.0);
  float dia = uCore > 0.5 ? 0.3 + 0.7 * pow(abs(cos(s * 3.14159 * 4.5)), 10.0) * (1.0 - s * 0.7) : 1.0;
  vec3 hot = vec3(1.0, 0.93, 0.8), mid = vec3(1.0, 0.52, 0.2), tail = vec3(0.6, 0.38, 0.95);
  vec3 col = uCore > 0.5 ? mix(hot, vec3(1.0, 0.78, 0.5), s) : mix(mix(mid, hot, fall * 0.4), tail, smoothstep(0.4, 1.0, s) * 0.7);
  float a = clamp(fall * body * dia * fl * uAB * (uCore > 0.5 ? 1.5 : 0.8), 0.0, 1.0);
  gl_FragColor = vec4(col * 1.25, a);    // straight alpha: AdditiveBlending (SRC_ALPHA, ONE) applies it once
}`;
function flameMaterial(core, seed) {
    return new THREE.ShaderMaterial({ uniforms: { uAB: { value: 0 }, uTime: { value: 0 }, uCore: { value: core ? 1 : 0 }, uSeed: { value: seed } },
        vertexShader: FLAME_VS, fragmentShader: FLAME_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
}
function buildFlame(cx, seed) {
    const g = new THREE.Group(); g.name = 'afterburner'; g.position.set(cx, NAC.y, NZ_Z);
    const cone = (r0, r1) => new THREE.CylinderGeometry(r0, r1, 1, 28, 8, true).translate(0, -0.5, 0).rotateX(Math.PI / 2);
    const outer = new THREE.Mesh(cone(NZR.dry * 0.95, 0.08), flameMaterial(false, seed)), core = new THREE.Mesh(cone(NZR.dry * 0.65, 0.03), flameMaterial(true, seed + 1.7));
    outer.renderOrder = core.renderOrder = 10; outer.frustumCulled = core.frustumCulled = false;
    g.add(outer, core);
    const dm = new THREE.MeshBasicMaterial({ color: '#fff0d4', transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
    const diamonds = [];
    for (let i = 0; i < 5; i++) { const d = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), dm); d.renderOrder = 11; d.userData.f = 0.11 + i * 0.17; d.userData.r = 0.12 * (1 - i * 0.14); g.add(d); diamonds.push(d); }
    g.visible = false;
    return { group: g, outer, core, diamonds, dm };
}

// ---------------------------------------------------------------------------------------------------- missiles
/** 'short' (MISSILE: four canards, four tail fins, dark glass seeker) or 'medium' (MEDIUM: ogive radome, long mid wings).
 *  Origin at the body's centre, nose +z. White-grey, two small bands, no text. */
export function buildMissile(kind = 'short', m = null) {
    const own = !m; if (own) m = makeMaterials(LIVERY[0]);
    const short = kind !== 'medium', L = short ? MISSILE.length : MEDIUM.length, R = (short ? MISSILE.diameter : MEDIUM.diameter) / 2;
    const g = new THREE.Group(); g.name = `missile-${short ? 'short' : 'medium'}`;
    const noseL = short ? 0.12 : 0.55, prof = [new THREE.Vector2(0.0001, -L / 2), new THREE.Vector2(R * 0.82, -L / 2), new THREE.Vector2(R, -L / 2 + 0.05), new THREE.Vector2(R, L / 2 - noseL)];
    for (let i = 1; i <= 8; i++) { const f = i / 8; prof.push(new THREE.Vector2(short ? R * (1 - 0.18 * f * f) : R * Math.sqrt(1 - f * f) + 0.002, L / 2 - noseL + (short ? 0.1 : noseL) * f)); }
    const parts = [new THREE.Mesh(new THREE.LatheGeometry(prof, 20).rotateX(Math.PI / 2), m.missile)];   // lathe +y -> +z
    if (short) parts.push(new THREE.Mesh(new THREE.SphereGeometry(R * 0.82, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2).rotateX(Math.PI / 2).translate(0, 0, L / 2 - noseL + 0.08), m.seeker));
    const band = (z, mat) => parts.push(new THREE.Mesh(new THREE.CylinderGeometry(R * 1.006, R * 1.006, 0.045, 20, 1, true).rotateX(Math.PI / 2).translate(0, 0, z), mat));
    band(L / 2 - (short ? 0.62 : 0.95), m.bandY); band(-L / 2 + (short ? 1.2 : 1.5), m.bandB);
    const fin = (span, root, tip, sweep, zFront) => {      // four fins in an X, leading edge at zFront
        const s = new THREE.Shape(); s.moveTo(0, 0); s.lineTo(span, -sweep); s.lineTo(span, -sweep - tip); s.lineTo(0, -root); s.closePath();
        const geo = new THREE.ExtrudeGeometry(s, { depth: 0.005, bevelEnabled: false }).translate(R * 0.92, 0, -0.0025).rotateX(-Math.PI / 2);
        const out = []; for (let k = 0; k < 4; k++) out.push(geo.clone().rotateZ(Math.PI / 4 + (k * Math.PI) / 2).translate(0, 0, zFront));
        return out;
    };
    const fins = short ? [...fin(0.11, 0.17, 0.07, 0.08, L / 2 - 0.3), ...fin(0.16, 0.3, 0.12, 0.17, -L / 2 + 0.32)]
        : [...fin(0.1, 0.6, 0.12, 0.42, 0.55), ...fin(0.2, 0.32, 0.16, 0.14, -L / 2 + 0.36)];
    parts.push(new THREE.Mesh(merge(fins), m.missile));
    parts.forEach((x) => { x.castShadow = true; g.add(x); });
    return { group: g, kind: short ? 'short' : 'medium', length: L, radius: R, dispose: () => { g.traverse((o) => o.geometry?.dispose()); if (own) Object.values(m).forEach((x) => x.dispose?.()); } };
}

// ---------------------------------------------------------------------------------------------------- the jet
export function buildJet(side = 0, opts = {}) {
    const liv = { ...LIVERY[side % 2] };
    if (opts.color) liv.accent = opts.color;
    const m = makeMaterials(liv);
    const shade = (g) => counterShade(g, liv.upper, liv.lower);
    const group = new THREE.Group(); group.name = `jet-${side}`; group.matrixAutoUpdate = false;
    const mesh = (geo, mat, parent = group, name = '') => { const x = new THREE.Mesh(geo, mat); x.name = name; x.castShadow = true; x.receiveShadow = true; parent.add(x); return x; };
    const paintL = [], paintBoth = [], darkBoth = [];

    // --- fuselage, radome, pitot, the rear cap between the engines
    const F = buildFuselage();
    mesh(shade(F.body), m.paint, group, 'fuselage');
    mesh(F.radome, m.radome, group, 'radome');
    darkBoth.push(F.rear, tube(V3(0, 0.03, JET.noseZ - 0.02), V3(0, 0.03, JET.noseZ + 0.45), 0.011, 6));

    // --- intakes (+ dark ducts and compressor faces) and the engine bulges
    const IN = buildIntakeL();
    paintL.push(IN.outer, IN.lip, buildNacelleL());
    mesh(merge([IN.inner, mirrorX(IN.inner)]), m.duct, group, 'intake-ducts');
    darkBoth.push(IN.face, mirrorX(IN.face));

    // --- LERX: a thin wedge from beside the cockpit out to the wing root's leading edge
    {
        const pts = [[0.60, 5.2], [0.95, 3.4], [1.25, 1.9], [1.55, 0.95], [1.66, 0.55], [0.75, -0.6]];
        const sg = new THREE.ShapeGeometry(new THREE.Shape(pts.map(([x, z]) => new THREE.Vector2(x, z))), 8);
        const p = sg.attributes.position, top = [], bot = [], uv = [];
        const y0 = (z) => 0.20 - 0.10 * clamp((3.4 - z) / 3.4, 0, 1);
        for (let i = 0; i < p.count; i++) {
            const x = p.getX(i), z = p.getY(i), t = 0.075 * (1 - clamp((x - 0.55) / 1.1, 0, 1)) + 0.004;
            top.push(x, y0(z) + t / 2, z); bot.push(x, y0(z) - t / 2, z); uv.push(-z / 4, x / 4);
        }
        const idx = Array.from(sg.index ? sg.index.array : [...Array(p.count).keys()]);
        const mk = (arr, up) => {
            const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx.slice()); g.computeVertexNormals();
            if ((g.attributes.normal.getY(0) > 0) !== up) { flipWinding(g); g.computeVertexNormals(); }
            return g;
        };
        paintL.push(mk(top, true), mk(bot, false));
    }

    // --- the wing: ~40 deg leading-edge sweep, 1 deg anhedral; full-span LEF; flap inboard, aileron outboard
    const anh = -1 * DEG;
    const WF = { o: V3(0, 0.02, 0), span: V3(Math.cos(anh), Math.sin(anh), 0), thick: V3(-Math.sin(anh), Math.cos(anh), 0) };
    const tipS = JET.wingtips[0][0] / Math.cos(anh);
    const WT = { s: tipS, zLE: JET.wingtips[0][2], c: 1.5, t: 0.04 }, WR = { s: 1.0, zLE: 0.9, c: 4.9, t: 0.05 };
    const LE0 = 1.75, LE1 = tipS - 0.25, LEF_F = 0.15, FL = { s0: 1.75, s1: 3.45, f: 0.75 }, AI = { s0: 3.55, s1: 5.35, f: 0.77 };
    const W = (s0, s1, n, f0, f1, caps = [false, false]) => surfaceGeo(stationsBetween(WR, WT, s0, s1, n), f0, f1, WF, { caps });
    paintL.push(W(WR.s, LE0, 2, 0, 1, [true, false]), W(FL.s0, FL.s1, 4, LEF_F, FL.f), W(FL.s1, AI.s0, 1, LEF_F, 1),
        W(AI.s0, AI.s1, 4, LEF_F, AI.f), W(AI.s1, LE1, 1, LEF_F, 1), W(LE1, WT.s, 1, 0, 1, [false, true]));
    const surfaces = {};
    // a moving surface: its geometry (jet space) goes into a pivot at hinge point a. The axis points +x (or +y when the hinge
    // is mostly vertical), so one sign rule serves both sides: a positive angle lifts what is behind a horizontal hinge,
    // and swings what is behind a vertical hinge to the pilot's right (-x).
    function pivotFor(geo, a, b, name) {
        const axis = V3().subVectors(b, a).normalize();
        if (Math.abs(axis.x) >= 0.5 ? axis.x < 0 : axis.y < 0) axis.negate();
        const piv = new THREE.Group(); piv.name = name; piv.position.copy(a); piv.userData.axis = axis; group.add(piv);
        mesh(shade(geo.translate(-a.x, -a.y, -a.z)), m.paint, piv, name + '-mesh');
        return piv;
    }
    const pair = (geo, a, b, nameL, nameR) => [pivotFor(geo.clone(), a, b, nameL), pivotFor(mirrorX(geo), a.clone().setX(-a.x), b.clone().setX(-b.x), nameR)];
    {
        const g = 0.015;   // a gap at each end of a moving surface
        [surfaces.lefL, surfaces.lefR] = pair(W(LE0 + g, LE1 - g, 8, 0, LEF_F - 0.004), hingePt(WR, WT, WF, LE0 + g, LEF_F), hingePt(WR, WT, WF, LE1 - g, LEF_F), 'lefL', 'lefR');
        [surfaces.flapL, surfaces.flapR] = pair(W(FL.s0 + g, FL.s1 - g, 4, FL.f + 0.004, 1), hingePt(WR, WT, WF, FL.s0 + g, FL.f), hingePt(WR, WT, WF, FL.s1 - g, FL.f), 'flapL', 'flapR');
        [surfaces.aileronL, surfaces.aileronR] = pair(W(AI.s0 + g, AI.s1 - g, 4, AI.f + 0.004, 1), hingePt(WR, WT, WF, AI.s0 + g, AI.f), hingePt(WR, WT, WF, AI.s1 - g, AI.f), 'aileronL', 'aileronR');
    }

    // --- stabilators, all-moving, spindle at 38 % root chord
    {
        const frame = { o: V3(0, -0.04, 0), span: V3(1, 0, 0), thick: V3(0, 1, 0) };
        const SR = { s: 1.0, zLE: -5.45, c: 2.85, t: 0.045 }, ST = { s: 4.15, zLE: -7.35, c: 1.15, t: 0.04 };
        const zp = SR.zLE - 0.38 * SR.c, a = V3(SR.s, -0.04, zp), b = V3(SR.s + 1, -0.04, zp);
        const CH = 3.3;     // the left stab's outboard trailing corner beyond this span is the piece the hit takes
        const whole = merge([surfaceGeo(stationsBetween(SR, ST, SR.s, CH, 5), 0, 1, frame, { caps: [true, false] }),
            surfaceGeo(stationsBetween(SR, ST, CH, ST.s, 2), 0, 0.55, frame, { caps: [false, true] })]);
        const chunk = surfaceGeo(stationsBetween(SR, ST, CH, ST.s, 2), 0.55, 1, frame, { caps: [false, true] });
        [surfaces.stabL, surfaces.stabR] = pair(whole, a, b, 'stabL', 'stabR');
        surfaces.stabChunkL = mesh(shade(chunk.clone().translate(-a.x, -a.y, -a.z)), m.paint, surfaces.stabL, 'stab-chunk');
        mesh(shade(mirrorX(chunk).translate(a.x, -a.y, -a.z)), m.paint, surfaces.stabR, 'stab-chunk-R');
        paintL.push(new THREE.SphereGeometry(1, 12, 8).scale(0.12, 0.1, 0.6).translate(1.08, -0.04, zp));    // spindle fairing
    }

    // --- twin fins canted out JET.finCantDeg; rudders on the lower trailing edge; LANE colour on the tips and leading edges
    const fins = {};
    {
        const cant = JET.finCantDeg * DEG;
        const frame = { o: V3(0.84, 0.42, 0), span: V3(Math.sin(cant), Math.cos(cant), 0), thick: V3(Math.cos(cant), -Math.sin(cant), 0) };
        const FR = { s: 0, zLE: -3.35, c: 3.4, t: 0.05 }, FT = { s: 2.5, zLE: JET.finTips[0][2], c: 1.15, t: 0.045 };
        const RU = { s0: 0.25, s1: 1.65, f: 0.72 }, TIP = 2.08, BREAK = 1.25, LE = 0.09;
        const P = (s0, s1, n, f0, f1, caps = [false, false]) => surfaceGeo(stationsBetween(FR, FT, s0, s1, n), f0, f1, frame, { caps });
        const baseLow = merge([P(0, RU.s0, 1, LE, 1, [true, false]), P(RU.s0, BREAK, 3, LE, RU.f)]);
        const top = merge([P(BREAK, RU.s1, 2, LE, RU.f), P(RU.s1, TIP, 2, LE, 1)]);
        const leLow = P(0, BREAK, 4, 0, LE, [true, false]), leTop = P(BREAK, TIP, 3, 0, LE), tip = P(TIP, FT.s, 2, 0, 1, [false, true]);
        const finL = new THREE.Group(); finL.name = 'finL'; group.add(finL);
        mesh(shade(baseLow.clone()), m.paint, finL, 'finL-base'); mesh(leLow.clone(), m.accent, finL, 'finL-le');
        const finLTop = new THREE.Group(); finLTop.name = 'finL-top'; finL.add(finLTop);
        mesh(shade(top.clone()), m.paint, finLTop, 'finL-top-paint'); mesh(merge([leTop.clone(), tip.clone()]), m.accent, finLTop, 'finL-tip');
        const finR = new THREE.Group(); finR.name = 'finR'; group.add(finR);
        mesh(shade(mirrorX(merge([baseLow, top]))), m.paint, finR, 'finR'); mesh(mirrorX(merge([leLow, leTop, tip])), m.accent, finR, 'finR-accent');
        [surfaces.rudderL, surfaces.rudderR] = pair(P(RU.s0 + 0.02, RU.s1 - 0.02, 4, RU.f + 0.004, 1, [true, true]),
            hingePt(FR, FT, frame, RU.s0 + 0.02, RU.f), hingePt(FR, FT, frame, RU.s1 - 0.02, RU.f), 'rudderL', 'rudderR');
        // the torn stub left when the top goes: a jagged dark edge at BREAK
        const st = planAt(FR, FT, BREAK), pts = [], n = 14;
        for (let i = 0; i <= n; i++) { const f = (i / n) * RU.f, jag = (i % 2 ? 0.08 : -0.03) * (0.6 + 0.4 * Math.sin(i * 2.3)); pts.push(V3().copy(frame.o).addScaledVector(frame.span, BREAK + jag).setZ(st.zLE - f * st.c)); }
        const tri = [];
        for (let i = 0; i < n; i++) { const a = pts[i], b = pts[i + 1], c = V3().copy(frame.o).addScaledVector(frame.span, BREAK - 0.1).setZ((a.z + b.z) / 2); tri.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z); }
        const tg = new THREE.BufferGeometry(); tg.setAttribute('position', new THREE.Float32BufferAttribute(tri, 3)); tg.computeVertexNormals();
        fins.torn = mesh(tg, m.torn, finL, 'finL-torn'); fins.torn.visible = false;
        fins.top = finLTop;
        fins.tip = V3().copy(frame.o).addScaledVector(frame.span, FT.s).setZ(FT.zLE);
    }

    // --- dorsal speed brake on the spine behind the canopy, hinged at its front edge, opens 45 deg
    {
        const z0 = 0.95, z1 = 2.45, hw = 0.32, hz = z1 - 0.02, hb = bodyAt(hz), hy = hb.yc + hb.top + 0.006;
        mesh(bodyStrip(z0 + 0.03, z1 - 0.03, () => Math.PI / 2 - hw + 0.03, () => Math.PI / 2 + hw - 0.03, 0.002, 8, 8), m.dark, group, 'brake-well');
        surfaces.brake = pivotFor(bodyStrip(z0, z1, () => Math.PI / 2 - hw, () => Math.PI / 2 + hw, 0.006, 12, 10), V3(0, hy, hz), V3(1, hy, hz), 'speedBrake');
    }

    // --- nozzles (ANCHORS.nozzles) and afterburners
    const morphed = [], flames = [];
    for (const cx of [NAC.x, -NAC.x]) {
        const N = buildNozzle(cx);
        morphed.push(mesh(N.outer, m.nozzle, group, 'nozzle'), mesh(N.inner, m.nozzleIn, group, 'nozzle-liner'), mesh(N.lip, m.metalMorph, group, 'nozzle-lip'));
        mesh(N.face, m.turbine, group, 'turbine-face'); mesh(N.holder, m.holder, group, 'flameholder');
        const f = buildFlame(cx, cx > 0 ? 0.3 : 2.1); group.add(f.group); flames.push(f);
    }

    // --- the cockpit (jetspec SEAT, STICK, THROTTLE, CANOPY numbers)
    const [cz0, cz1] = HOLE, bow = CANOPY.windscreenZ[0];
    {
        const cw = bodyHalfWidthAt((cz0 + cz1) / 2, SILL) - 0.02;
        const tub = new THREE.BoxGeometry(cw * 2, 0.95, cz1 - cz0 + 0.2).translate(0, SILL - 0.47, (cz0 + cz1) / 2);
        tub.groups.forEach((gr, i) => (gr.materialIndex = i === 2 ? 1 : 0));                // no lid: the box's +y face is invisible
        mesh(tub, [m.cockpit, new THREE.MeshBasicMaterial({ visible: false })], group, 'tub');
        // side consoles (the throttle runs in a slot on the left one); their tops at y 0.64
        for (const sx of [1, -1]) {
            mesh(box(0.13, 0.08, 1.2, sx * (cw - 0.07), 0.6, 4.3), m.console, group, 'console');
            mesh(box(0.13, 0.22, 0.04, sx * (cw - 0.07), 0.45, 4.9).rotateX(0), m.cockpit, group, 'console-front');
            for (let i = 0; i < 5; i++) mesh(new THREE.CylinderGeometry(0.009, 0.011, 0.018, 8).translate(sx * (cw - 0.07) + ((i % 2) - 0.5) * 0.05, 0.649, 3.85 + i * 0.07 + (sx > 0 ? 0.45 : 0)), m.rubber, group, 'knob');
        }
        // r6: the consoles were bare slabs -- raised sub-panels in dark bezels, toggle switches and a small display. The left one keeps
        // clear of the throttle's run (x 0.33, z 4.15-4.45)
        {
            const bez = [], top = [], tog = [], scr = [];
            for (const sx of [1, -1]) {
                const x = sx * (cw - 0.07), zs = sx > 0 ? [[3.78, 0.3], [4.56, 0.3]] : [[3.78, 0.26], [4.1, 0.3], [4.48, 0.34]];
                for (const [z0, len] of zs) {
                    bez.push(box(0.12, 0.012, len, x, 0.646, z0 + len / 2));
                    top.push(box(0.1, 0.006, len - 0.02, x, 0.655, z0 + len / 2));
                    for (let i = 0; i < 3; i++) tog.push(new THREE.CylinderGeometry(0.0035, 0.0035, 0.022, 6).rotateX(-0.35).translate(x + (i - 1) * 0.03, 0.668, z0 + 0.06));
                }
                scr.push(new THREE.PlaneGeometry(0.075, 0.06).rotateX(-Math.PI / 2).translate(x, 0.6595, sx > 0 ? 4.78 : 4.7));
                // the sidewall above the console: a frame rib and a padded sill along the cockpit's edge
                const pad = []; for (let z = cz0 + 0.12; z <= cz1 + 0.01; z += 0.3) pad.push(V3(sx * (bodyHalfWidthAt(z, SILL) - 0.045), SILL - 0.015, z));
                pad.push(V3(sx * (bodyHalfWidthAt(cz1 + 0.01, SILL) - 0.045), SILL - 0.015, cz1 + 0.01));
                mesh(merge(polyTube(pad, 0.028, 8)), m.pad, group, 'sill-pad');
                bez.push(box(0.02, 0.025, 1.3, sx * (cw - 0.01), 0.76, 4.3));
            }
            mesh(merge(bez), m.coaming, group, 'console-bezels');
            mesh(merge(top), m.console, group, 'console-panels');
            mesh(merge(tog), m.metal, group, 'toggles');
            mesh(merge(scr), m.mfd, group, 'console-screens');
        }
        mesh(box(cw * 2 - 0.02, 0.02, 1.6, 0, 0.06, 4.55), m.rubber, group, 'floor');
        mesh(box(0.035, 0.01, 0.2, THROTTLE.grip0[0], 0.645, THROTTLE.grip0[2] + THROTTLE.travel / 2), m.dark, group, 'throttle-slot');
        // the canopy rails along the sill (ANCHORS.canopyRail)
        const rails = [];
        for (const sx of [1, -1]) {
            const pts = []; for (let z = cz0 + 0.05; z <= cz1 - 0.02; z += 0.25) pts.push(V3(sx * (bodyHalfWidthAt(z, SILL) - 0.015), SILL + 0.012, z));
            pts.push(V3(sx * (bodyHalfWidthAt(cz1 - 0.02, SILL) - 0.015), SILL + 0.012, cz1 - 0.02));
            rails.push(...polyTube(pts, 0.022, 8));
        }
        mesh(merge(rails), m.sill, group, 'sill-rails');
        // the instrument panel (tilted back 12 deg), three MFDs, the glare shield and the HUD
        const ip = new THREE.Group(); ip.position.set(0, 0.62, 5.42); ip.rotation.x = -12 * DEG; group.add(ip);
        mesh(box(0.74, 0.46, 0.06, 0, 0, 0), m.cockpit, ip, 'panel');
        mesh(box(0.16, 0.08, 0.02, 0, 0.19, -0.03), m.console, ip, 'key-pad');
        if (opts.screenLight !== false) {     // the screens' soft green-white spill on the pilot's chest and face
            const glow = new THREE.PointLight('#cdeed6', 0.45, 1.7, 2); glow.position.set(0, 0.05, -0.12); ip.add(glow);
        }
        for (const [x, y, s] of [[-0.21, 0.04, 0.17], [0.21, 0.04, 0.17], [0, -0.15, 0.15]]) {
            mesh(box(s + 0.04, s + 0.04, 0.02, x, y, -0.03), m.coaming, ip, 'mfd-bezel');
            const scr = new THREE.Mesh(new THREE.PlaneGeometry(s, s).rotateY(Math.PI), m.mfd); scr.position.set(x, y, -0.042); ip.add(scr);
        }
        const coam = new THREE.Group(); coam.position.set(0, SILL + 0.05, 5.32); group.add(coam);
        // the glare shield over the panel, a padded lip along its edge facing the pilot, and the coaming running back along both sills
        mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.52, 24, 1, false, -Math.PI / 2, Math.PI).rotateX(Math.PI / 2).scale(1, 0.32, 1), m.coaming, coam, 'glare-shield');
        { const lip = []; for (let i = 0; i <= 12; i++) { const a = (Math.PI * i) / 12; lip.push(V3(0.36 * Math.cos(a), 0.115 * Math.sin(a), -0.26)); } mesh(merge(polyTube(lip, 0.02, 8)), m.pad, coam, 'coaming-lip'); }
        // r6: the HUD -- a low projector housing sunk in the shield (its top only a couple of cm proud), a thin tinted combiner plate on two slim
        // posts with a slim top frame, and faint green symbols on it. The old 20 cm black box read as a block in every shoulder shot.
        mesh(rbox(0.16, 0.05, 0.15, 0, 0.1, 0.0, 0.012), m.coaming, coam, 'hud-body');
        mesh(box(0.11, 0.004, 0.07, 0, 0.1255, -0.02), m.hudGlass, coam, 'hud-lens');
        const hudGlass = mesh(new THREE.PlaneGeometry(0.16, 0.13), m.hudGlass, coam, 'hud-glass'); hudGlass.position.set(0, 0.2, -0.035); hudGlass.rotation.x = -28 * DEG; hudGlass.renderOrder = 4; hudGlass.castShadow = false;
        const sym = mesh(new THREE.PlaneGeometry(0.12, 0.1), m.hud, coam, 'hud-symbols'); sym.position.set(0, 0.2, -0.033); sym.rotation.x = -28 * DEG; sym.renderOrder = 5; sym.castShadow = false;
        { const c = Math.cos(28 * DEG), sn = Math.sin(28 * DEG), top = V3(0, 0.2 + 0.065 * c, -0.035 + 0.065 * sn);     // the plate's top edge
          mesh(merge([box(0.007, 0.15, 0.007, 0.083, 0.195, -0.03), box(0.007, 0.15, 0.007, -0.083, 0.195, -0.03), tube(top.clone().setX(-0.083), top.clone().setX(0.083), 0.004, 6)]), m.frame, coam, 'hud-posts'); }
        // the rear bulkhead and the seat's guide rails, along SEAT.rail (15 deg back)
        mesh(box(cw * 2, 0.9, 0.04, 0, SILL - 0.45, cz0 + 0.38), m.cockpit, group, 'bulkhead');
        const R0 = V3(0, 0.2, 3.6), RU = V3(...SEAT.rail);
        mesh(merge([0.17, -0.17].map((sx) => tube(R0.clone().setX(sx), R0.clone().setX(sx).addScaledVector(RU, 0.95), 0.025))), m.rail, group, 'seat-rails');
    }
    // the centre stick (pivot at the floor; a pivot whose +y is the stick's axis), the throttle (slides in z), the pedals
    const stick = new THREE.Group(); stick.name = 'stick'; stick.position.fromArray(STICK.pivot); group.add(stick);
    const SL = STICK.grip[1] - STICK.pivot[1];
    // v2: STICK.pivot is a VIRTUAL point 0.54 m below the grip; the drawn stick is rigid and bent, rising from a rubber
    // boot on the floor ahead of the seat pan (its foot swings a few cm inside the boot as the grip moves +-8 / +-6 cm)
    const bootZ = 0.29, shaft = [V3(0, 0.07 - STICK.pivot[1], bootZ), V3(0, 0.2, bootZ - 0.04), V3(0, 0.4, 0.07), V3(0, SL - 0.06, 0.008)];
    mesh(merge([...polyTube(shaft, STICK.r, 10),
        rbox(0.042, 0.13, 0.05, 0, SL, 0.004, 0.018).rotateX(0.12),                                  // the grip, canted forward a little
        rbox(0.012, 0.035, 0.016, 0, SL - 0.012, 0.035, 0.005),                                      // trigger
        new THREE.CylinderGeometry(0.009, 0.009, 0.012, 8).translate(0, SL + 0.07, 0.008)]), m.coaming, stick, 'stick');
    const boot = V3(STICK.pivot[0], 0.07, STICK.pivot[2] + bootZ);
    mesh(merge([0, 1, 2, 3].map((i) => new THREE.TorusGeometry(0.055 - i * 0.008, 0.013, 6, 14).rotateX(Math.PI / 2).translate(boot.x, boot.y + 0.012 + i * 0.022, boot.z))), m.rubber, group, 'stick-boot');
    mesh(new THREE.CylinderGeometry(0.08, 0.09, 0.02, 14).translate(boot.x, boot.y, boot.z), m.frame, group, 'stick-base');
    const throttle = new THREE.Group(); throttle.name = 'throttle'; throttle.position.fromArray(THROTTLE.grip0); group.add(throttle);
    mesh(merge([rbox(0.02, 0.06, 0.03, 0, -0.035, -0.01, 0.006),                                     // the lever out of the slot
        rbox(0.05, 0.055, 0.1, 0.004, 0.005, 0, 0.02).rotateZ(-0.18),                                   // the grip head, leaning inboard
        new THREE.CylinderGeometry(0.007, 0.007, 0.012, 8).rotateZ(Math.PI / 2).translate(-0.024, 0.02, 0.02)]), m.coaming, throttle, 'throttle-grip');
    const pedals = [1, -1].map((sx) => { const p = mesh(box(0.09, 0.16, 0.03, 0, 0, 0), m.metal, group, 'pedal'); p.position.set(sx * SEAT.pedals.x, SEAT.pedals.y, SEAT.pedals.z); return p; });

    // --- windscreen (fixed) and the canopy (CHILD of group, origin at CANOPY.hinge, jet axes; GLUE re-parents it)
    const cH = pchip([2.95, 3.3, 3.8, 4.2, 4.6, 5.0, 5.4, 5.62], [0.17, 0.52, 0.73, 0.77, 0.74, 0.6, 0.33, 0.085]);   // top ~1.62: >= 10 cm over the v2 helmet (CANOPY.topY 1.53 is v1's; change request)
    const canopyRing = (z, lift = 0, K = 28) => {
        const x0 = bodyHalfWidthAt(z, SILL), h = cH(z), ring = [];
        for (let j = 0; j <= K; j++) { const th = (Math.PI * j) / K, c = Math.cos(th), s = Math.sin(th); ring.push(V3((x0 + lift) * spow(c, 2 / 2.3), SILL + (h + lift) * spow(s, 2 / 2.3), z)); }
        return ring;
    };
    const glassRings = (za, zb, n, lift = 0) => { const out = []; for (let i = 0; i <= n; i++) out.push(canopyRing(za + ((zb - za) * i) / n, lift)); return out; };
    {
        const ws = gridGeo(glassRings(cz1, bow, 10)); ws.computeVertexNormals();
        const w = mesh(ws, m.glass, group, 'windscreen'); w.renderOrder = 6; w.castShadow = false;
        mesh(merge(polyTube(canopyRing(bow + 0.012, 0.007), 0.013, 8)), m.frame, group, 'windscreen-bow');      // the bow (r6: thicker, so the glass has an edge)
    }
    const canopy = new THREE.Group(); canopy.name = `canopy-${side}`; canopy.position.fromArray(CANOPY.hinge); group.add(canopy);
    const H = V3(...CANOPY.hinge);
    {
        const zr = 3.32;                                          // glass ahead of this, a painted fairing behind it
        const glass = gridGeo(glassRings(zr, bow - 0.01, 26)); glass.computeVertexNormals(); glass.translate(-H.x, -H.y, -H.z);
        const gm = mesh(glass, m.glass, canopy, 'canopy-glass'); gm.renderOrder = 7; gm.castShadow = false; gm.receiveShadow = false;
        const rear = gridGeo(glassRings(cz0, zr + 0.02, 5, 0.004)); orientOutward(rear, V3(0, SILL, 3.1)); rear.computeVertexNormals(); shade(rear); rear.translate(-H.x, -H.y, -H.z);
        mesh(rear, m.paint, canopy, 'canopy-rear');
        // the rear bow behind the seat and (r6) side rails thick enough to read as the canopy's frame on the sill
        const fr = [...polyTube(canopyRing(zr + 0.02, 0.007), 0.014, 8)];
        for (const sx of [1, -1]) { const pts = []; for (let z = cz0 + 0.02; z <= bow - 0.02; z += 0.2) pts.push(V3(sx * (bodyHalfWidthAt(z, SILL) + 0.006), SILL + 0.03, z)); fr.push(...polyTube(pts, 0.019, 8)); }
        const back = capGeo(canopyRing(cz0 + 0.02)); orientOutward(back, V3(0, SILL + 0.1, cz0 + 0.5));
        mesh(merge(fr).translate(-H.x, -H.y, -H.z), m.frame, canopy, 'canopy-frame');
        mesh(back.translate(-H.x, -H.y, -H.z), m.cockpit, canopy, 'canopy-back');
        mesh(box(0.16, 0.025, 0.02, 0, SILL + cH(bow - 0.08) - 0.05, bow - 0.08).translate(-H.x, -H.y, -H.z), m.frame, canopy, 'mirror');
    }

    // --- the ejection seat (CHILD of group, origin SEAT.ref with the jet's axes; the cushions recline SEAT.backDeg inside)
    const seat = new THREE.Group(); seat.name = `seat-${side}`; seat.position.fromArray(SEAT.ref); group.add(seat);
    {
        // two frames under the seat (origin = SRP, jet axes): `pan` turned SEAT.panDeg (front up; +z along the pan's top,
        // +y its normal) and `back` turned SEAT.backDeg (+y up the back, +z out of its face). The v2 eye sits ~31 cm in front
        // of the back's face, so the headrest pads stand forward of the headbox, ~5 cm behind a helmet.
        const pan = new THREE.Group(); pan.rotation.x = -SEAT.panDeg * DEG; seat.add(pan);
        const back = new THREE.Group(); back.rotation.x = -SEAT.backDeg * DEG; seat.add(back);
        const pm = (g, mat, name) => mesh(g, mat, pan, name), bm = (g, mat, name) => mesh(g, mat, back, name);
        pm(rbox(0.42, 0.07, 0.42, 0, -0.035, 0.22, 0.03), m.cushion, 'pan-cushion');
        bm(merge([rbox(0.39, 0.6, 0.07, 0, 0.33, -0.035, 0.03), rbox(0.12, 0.16, 0.05, 0.065, 0.8, 0.025, 0.018), rbox(0.12, 0.16, 0.05, -0.065, 0.8, 0.025, 0.018)]), m.cushion, 'back-cushions');
        pm(merge([
            rbox(0.025, 0.14, 0.44, 0.235, 0.0, 0.21, 0.01), rbox(0.025, 0.14, 0.44, -0.235, 0.0, 0.21, 0.01),     // the pan's side walls
            rbox(0.46, 0.15, 0.46, 0, -0.145, 0.21, 0.025),                                                    // survival kit under the pan
        ]), m.seat, 'pan-structure');
        bm(merge([
            rbox(0.43, 0.72, 0.05, 0, 0.31, -0.1, 0.015),                                                      // back plate
            rbox(0.36, 0.32, 0.2, 0, 0.87, -0.1, 0.05),                                                        // the parachute pack
            new THREE.CylinderGeometry(0.04, 0.04, 0.85, 12).translate(0, 0.35, -0.17),                        // catapult
        ]), m.seat, 'back-structure');
        bm(merge([rbox(0.045, 0.98, 0.07, 0.235, 0.39, -0.1, 0.012), rbox(0.045, 0.98, 0.07, -0.235, 0.39, -0.1, 0.012)]), m.frame, 'side-beams');
        bm(rbox(0.3, 0.2, 0.012, 0, 0.88, -0.205, 0.005), m.strap, 'pack-cover');                            // the parachute pack's fabric back
        // r6: the HEADBOX -- the review found no block behind the helmet. A wide dark padded box over the pack, its top about level with
        // the helmet's, with padded cheeks reaching forward either side of the head so a face lens 0.6 m ahead sees it frame the helmet.
        // All behind the headrest pads' face (back z <= 0.06), so the man's fit is unchanged. It rides its own frame (`headbox`), which
        // setState slides DOWN the rail by fit.seatAdjust: every man's eye is fitted to the same design eye, so the box stays in the same
        // place round every head and under the canopy (a man fitted 7.5 cm up the rail would otherwise put it into the glass).
        const hbF = new THREE.Group(); hbF.name = 'headbox-frame'; seat.add(hbF);
        const hbB = new THREE.Group(); hbB.rotation.x = -SEAT.backDeg * DEG; hbF.add(hbB);
        mesh(merge([rbox(0.46, 0.3, 0.2, 0, 0.94, -0.075, 0.075),                                            // the box
            rbox(0.075, 0.26, 0.17, 0.2, 0.92, -0.03, 0.03), rbox(0.075, 0.26, 0.17, -0.2, 0.92, -0.03, 0.03),   // the cheeks
            rbox(0.3, 0.05, 0.05, 0, 0.8, 0.02, 0.02)]), m.pad, hbB, 'headbox');                               // a padded roll under the pads
        seat.userData.headbox = hbF;
        // harness lying on the cushions: two shoulder straps, the lap belt halves, a rotary quick-release buckle, leg loops
        const strap = (a, b, w) => { const d = V3().subVectors(b, a), g = new THREE.BoxGeometry(w, d.length(), 0.008); _q.setFromUnitVectors(_Y, d.normalize()); return g.applyMatrix4(_m4.compose(V3().addVectors(a, b).multiplyScalar(0.5), _q, V3(1, 1, 1))); };
        bm(merge([strap(V3(0.09, 0.64, 0.006), V3(0.035, 0.36, 0.008), 0.045), strap(V3(-0.09, 0.64, 0.006), V3(-0.035, 0.36, 0.008), 0.045),
            ...[0.09, -0.09].map((x) => rbox(0.05, 0.03, 0.012, x * 0.55, 0.42, 0.012, 0.004))]), m.strap, 'shoulder-straps');
        pm(merge([strap(V3(0.21, 0.035, 0.12), V3(0.03, 0.04, 0.2), 0.045), strap(V3(-0.21, 0.035, 0.12), V3(-0.03, 0.04, 0.2), 0.045),
            strap(V3(0.09, 0.005, 0.38), V3(0.03, 0.04, 0.22), 0.035), strap(V3(-0.09, 0.005, 0.38), V3(-0.03, 0.04, 0.22), 0.035)]), m.strap, 'lap-belt');
        pm(new THREE.CylinderGeometry(0.035, 0.035, 0.016, 16).rotateX(0.25).translate(0, 0.05, 0.21), m.buckle, 'buckle');
        const sm = pm;
        sm(merge([box(0.025, 0.025, 0.1, 0.25, 0.08, 0.3), box(0.025, 0.025, 0.1, -0.25, 0.08, 0.3)]), m.stripes, 'side-handles');
        // the yellow-and-black firing loop at the pan's front, between the thighs: a half ring (1.4 cm tube, 13 cm across) whose TOP is
        // SEAT.ejectHandle, leaning SEAT.ejectLoop.tiltDeg back toward the man. r8: 8 cm further back than r6 and tilted 37 deg (was
        // 14): the stick's shaft rises from its boot ahead of the pan and leans back over the loop, and at r6's place it cut through
        // the loop for every seat set at mid-rail or higher. jetspec.check.mjs reads THIS line (the stick sweep and the contract match).
        const eh = SEAT.ejectHandle, EL = SEAT.ejectLoop, et = EL.tiltDeg * DEG;
        mesh(new THREE.TorusGeometry(EL.R, EL.r, 8, 22, Math.PI).rotateX(-et).translate(eh[0], eh[1] - EL.R * Math.cos(et), eh[2] + EL.R * Math.sin(et)), m.loop, seat, 'eject-handle');
    }

    // --- missiles (ANCHORS.missileRails = the missile CENTRE; RAIL_KIND), wingtip launchers, pylons
    const missiles = [], railNodes = [];
    {
        for (const sx of [1, -1]) {
            const t = ANCHORS.missileRails[sx > 0 ? 0 : 3], R = MISSILE.diameter / 2, x0 = JET.wingtips[0][0] - 0.03, x1 = Math.abs(t[0]) - R * 0.5;
            paintBoth.push(box(x1 - x0, 0.1, 2.6, sx * (x0 + x1) / 2, t[1] + 0.015, t[2] - 0.75));        // the wingtip launcher rail
            const p = ANCHORS.missileRails[sx > 0 ? 1 : 2], st = planAt(WR, WT, Math.abs(p[0]) / Math.cos(anh));
            const ybot = WF.o.y + Math.sin(anh) * Math.abs(p[0]) - NACA(0.4, st.t) * st.c * 0.8, ytop = p[1] + MEDIUM.diameter / 2 + 0.07, zc = p[2] + 0.2;
            paintBoth.push(new THREE.SphereGeometry(1, 14, 8).scale(0.05, (ybot - ytop) / 2 + 0.06, 1.1).translate(p[0], (ybot + ytop) / 2, zc));   // pylon
            paintBoth.push(box(0.08, 0.06, 2.2, p[0], p[1] + MEDIUM.diameter / 2 + 0.03, p[2] + 0.1));                                             // launcher
        }
        ANCHORS.missileRails.forEach((r, i) => {
            const n = new THREE.Object3D(); n.name = `missileRail${i}`; n.position.fromArray(r); n.userData.kind = RAIL_KIND[i]; group.add(n); railNodes.push(n);
            const ms = buildMissile(RAIL_KIND[i], m); n.add(ms.group); missiles.push(ms);
        });
    }

    // --- flare dispensers, antennas, nav lights
    for (const d of ANCHORS.flareDispensers) {
        const plate = mesh(new THREE.PlaneGeometry(0.26, 0.12), m.flare, group, 'flare-dispenser');
        plate.position.fromArray(d.p); plate.lookAt(plate.position.clone().add(V3(...d.dir)));
    }
    paintBoth.push(rbox(0.014, 0.16, 0.24, 0, bodyAt(0.7).yc + bodyAt(0.7).top + 0.07, 0.7, 0.006), rbox(0.012, 0.13, 0.2, 0, bodyAt(1.2).yc - bodyAt(1.2).bot - 0.055, 1.2, 0.005));   // blade antennas
    {
        const t = hingePt(WR, WT, WF, WT.s, 0.2);
        const l1 = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 6), m.red); l1.position.set(t.x - 0.02, t.y + 0.07, t.z); group.add(l1);       // left = red
        const l2 = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 6), m.green); l2.position.set(-t.x + 0.02, t.y + 0.07, t.z); group.add(l2);    // right = green
    }

    // --- tail damage: a soot shell and a holes shell over the left rear body around ANCHORS.tailHitPoint
    const dmg = {};
    {
        const hz = ANCHORS.tailHitPoint[2], z0 = hz - 1.2, z1 = hz + 1.9;
        const strip = bodyStrip(z0, z1, () => -0.35, () => 1.25, 0.008, 24, 14);
        const p = strip.attributes.position, uv = strip.attributes.uv;
        for (let i = 0; i < p.count; i++) uv.setXY(i, (z1 - p.getZ(i)) / (z1 - z0), (Math.atan2(p.getY(i), p.getX(i)) + 0.35) / 1.6);
        dmg.scorch = mesh(strip, m.scorch, group, 'scorch'); dmg.scorch.castShadow = false; dmg.scorch.renderOrder = 3;
        const hs = strip.clone(), q = hs.attributes.position;
        for (let i = 0; i < q.count; i++) { const x = q.getX(i), y = q.getY(i), l = Math.hypot(x, y) || 1; q.setXY(i, x + (x / l) * 0.003, y + (y / l) * 0.003); }
        dmg.holes = mesh(hs, m.holes, group, 'holes'); dmg.holes.castShadow = false; dmg.holes.renderOrder = 4; dmg.holes.visible = false;
    }

    // --- merge the static parts
    const both = (list) => [...list, ...list.map(mirrorX)];
    mesh(shade(merge([...both(paintL), ...paintBoth])), m.paint, group, 'airframe');
    mesh(merge(darkBoth), m.dark, group, 'dark-parts');

    // --- anchors: Object3Ds named as ANCHORS. stick / throttle ride their controls; the rest are fixed in jet space
    const node = (name, p, parent = group) => { const o = new THREE.Object3D(); o.name = name; o.position.fromArray(p); parent.add(o); return o; };
    const anchors = {
        seatRef: node('seatRef', SEAT.ref),
        eye: node('eye', ANCHORS.eye),
        stick: node('stickGrip', [0, SL, 0], stick),
        throttle: node('throttleGrip', [0, 0, 0], throttle),
        canopyHinge: node('canopyHinge', CANOPY.hinge),
        canopyRail: node('canopyRail', [0, SILL, (CANOPY.z[0] + CANOPY.z[1]) / 2]),
        nozzles: [NAC.x, -NAC.x].map((x, i) => node(`nozzle${i ? 'R' : 'L'}`, [x, NAC.y, NZ_Z])),
        nozzle: node('nozzle', [0, NAC.y, NZ_Z]),
        missileRails: railNodes,
        flareDispensers: ANCHORS.flareDispensers.map((d, i) => { const o = node(`flare${i ? 'R' : 'L'}`, d.p); o.userData.dir = d.dir.slice(); return o; }),
        tailHitPoint: node('tailHitPoint', ANCHORS.tailHitPoint),
        wingtipL: node('wingtipL', V3().copy(WF.o).addScaledVector(WF.span, WT.s).setZ(WT.zLE).toArray()),
        wingtipR: null,
        finTips: [node('finTipL', fins.tip.toArray()), node('finTipR', fins.tip.clone().setX(-fins.tip.x).toArray())],
    };
    anchors.wingtipR = node('wingtipR', [-anchors.wingtipL.position.x, anchors.wingtipL.position.y, anchors.wingtipL.position.z]);

    // ------------------------------------------------------------------------------------------------ state
    const LIM = JET.limits;
    const rot = (piv, a) => piv.quaternion.setFromAxisAngle(piv.userData.axis, a);
    const _sg = { c: [0, 0, 0], axis: [0, 0, 0] }, _tg = [0, 0, 0], _ax = V3(), yAxis = V3(0, 1, 0), _pm = new Array(16), _tm = new THREE.Matrix4();
    function setState(s = {}, fit = null) {
        const ail = clamp(s.aileron || 0, -LIM.aileron, LIM.aileron), ele = clamp(s.elevator || 0, -LIM.elevator, LIM.elevator);
        rot(surfaces.aileronL, -ail); rot(surfaces.aileronR, ail);                       // roll right: left TE down, right TE up
        rot(surfaces.stabL, ele - 0.5 * ail); rot(surfaces.stabR, ele + 0.5 * ail);       // nose up: TE up; + half the roll as differential
        const rd = clamp(s.rudderDef ?? s.rudder ?? 0, -LIM.rudderDef, LIM.rudderDef);
        rot(surfaces.rudderL, rd); rot(surfaces.rudderR, rd);                             // nose right: both TEs to the pilot's right
        const fl = clamp(s.flap || 0, 0, LIM.flap); rot(surfaces.flapL, -fl); rot(surfaces.flapR, -fl);
        const lf = clamp(s.lef || 0, 0, LIM.lef); rot(surfaces.lefL, lf); rot(surfaces.lefR, lf);
        rot(surfaces.brake, clamp(s.brake || 0, 0, 1) * LIM.brakeDeg * DEG);
        // stick (jetspec stickGrip's axis), throttle (throttleGrip), pedals (+ = the RIGHT one forward)
        stickGrip(s.stickX || 0, s.stickY || 0, _sg); stick.quaternion.setFromUnitVectors(yAxis, _ax.fromArray(_sg.axis));
        throttleGrip(s.throttle ?? 0.5, _tg); throttle.position.fromArray(_tg);
        const pr = clamp(s.pedal || 0, -1, 1) * SEAT.pedals.travel;
        pedals[0].position.z = SEAT.pedals.z - pr; pedals[1].position.z = SEAT.pedals.z + pr;
        // nozzles and afterburner
        const nz = clamp(s.nozzle || 0, 0, 1), rK = 1 + NZ_OPEN * nz;
        for (const x of morphed) x.morphTargetInfluences[0] = nz;
        const ab = clamp(s.ab || 0, 0, 1), len = 1.0 + 3.8 * ab, t = s.tRace ?? s.t ?? 0;     // <= ~5 m: never a cartoon flame
        for (const f of flames) {
            f.group.visible = ab > 0.01;
            f.outer.scale.set(rK * (0.85 + 0.2 * ab), rK * (0.85 + 0.2 * ab), len); f.core.scale.set(rK, rK, len * 0.6);
            for (const mm of [f.outer.material, f.core.material]) { mm.uniforms.uAB.value = ab; mm.uniforms.uTime.value = t; }
            for (const d of f.diamonds) { d.position.set(0, 0, -d.userData.f * len * 0.6); const r = d.userData.r * rK * (0.8 + 0.2 * ab); d.scale.set(r, r, r * 2.6); }
            f.dm.opacity = 0.13 * ab;
        }
        m.nozzleIn.emissiveIntensity = 2.4 * ab; m.turbine.emissiveIntensity = 3.2 * ab; m.holder.emissiveIntensity = 4 * ab;
        for (let i = 0; i < 4; i++) missiles[i].group.visible = !s.rails || s.rails[i] !== 0;
        // tail damage: the plan steps `damage` 0 -> 1 at the hit and ramps `fire`; either one shows it
        const d = clamp(Math.max(s.damage || 0, s.fire || 0, s.tailDamage || 0), 0, 1);
        m.scorch.opacity = Math.min(1, d * 1.6); dmg.scorch.visible = d > 0.01;
        dmg.holes.visible = d >= 0.45;
        fins.top.visible = d < 0.7; fins.torn.visible = d >= 0.7;
        surfaces.rudderL.visible = d < 0.7; surfaces.stabChunkL.visible = d < 0.7;
        // the seat's height fit, only while it is still installed (after the eject GLUE places it from seatPose)
        const a = fit?.seatAdjust || 0;
        seat.userData.headbox.position.set(-SEAT.rail[0] * a, -SEAT.rail[1] * a, -SEAT.rail[2] * a);          // r6: the headbox keeps its place
        if (seat.parent === group) seat.position.set(SEAT.ref[0] + SEAT.rail[0] * a, SEAT.ref[1] + SEAT.rail[1] * a, SEAT.ref[2] + SEAT.rail[2] * a);
        // r6: once GLUE has moved the canopy / seat to the scene (matrixAutoUpdate off), place them from the sample's WORLD poses here too.
        // The review's frames had no canopy and no seat round the man: the real-model path in jetmode.js adds both to the scene at load
        // but only its stand-in ever writes their matrices, so they sat at the world origin. Writing the same pose twice is harmless.
        if (canopy.parent !== group && !canopy.matrixAutoUpdate && s.canopyPose) { canopy.matrix.fromArray(poseMatrix(s.canopyPose.pos, s.canopyPose.q, _pm)); canopy.matrixWorldNeedsUpdate = true; }
        if (seat.parent !== group && !seat.matrixAutoUpdate && s.seatPose) {
            seat.matrix.fromArray(poseMatrix(s.seatPose.pos, s.seatPose.q, _pm)).multiply(_tm.makeTranslation(SEAT.rail[0] * a, SEAT.rail[1] * a, SEAT.rail[2] * a));   // the man's fit rides the rail too
            seat.matrixWorldNeedsUpdate = true;
        }
    }
    setState({});

    let triangles = 0;
    group.traverse((o) => { if (o.isMesh && o.geometry) { const g = o.geometry; triangles += (g.index ? g.index.count : g.attributes.position.count) / 3; } });
    {   // perf2: every transparent double-sided mesh as two one-sided passes (twoPass); after the count, which is unchanged
        const two = new Set();
        for (const root of [group, canopy, seat]) root.traverse((o) => { if (o.isMesh && !o.userData.twoPassOf) two.add(o); });
        two.forEach(twoPass);
    }
    function dispose() {
        const seen = new Set();
        for (const root of [group, canopy, seat]) root.traverse((o) => {
            if (o.geometry && !seen.has(o.geometry)) { seen.add(o.geometry); o.geometry.dispose(); }
            for (const mt of Array.isArray(o.material) ? o.material : o.material ? [o.material] : []) if (!seen.has(mt)) { seen.add(mt); mt.dispose(); }
        });
    }
    return { group, canopy, seat, setState, anchors, surfaces, missiles, buildMissile: (kind) => buildMissile(kind, m), triangles: Math.round(triangles), side, livery: liv, dispose };
}
