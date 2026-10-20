// pilot.js -- the generic procedural pilot (COCKPIT lane, phase 2). No face, no names, no text, no insignia: a helmet with
// its dark visor DOWN and an oxygen mask, a plain flight suit, a harness, gloves and boots.
//
//   import { buildPilot } from './pilot.js';
//   const pilot = buildPilot(jet, { helmetColor });   // parented to jet.seat (so he leaves with the seat on ejection)
//   pilot.update(ms, look);   // once per display frame; ms = jetModelState(...) (stickX, stickY, throttle), look = controls.look
//   pilot.head                // the head group (hide it for the cockpit view: cockpitcam.enter([pilot.head]))
//   pilot.eye                 // an Object3D at his eye (= ANCHORS.eye at rest)
//   pilot.triangles, pilot.dispose()
//
// Frames: everything is in the SEAT frame (origin SEAT.ref + the seat's fit, the jet's axes: +z forward, +x the pilot's LEFT,
// y up). Arms: a 2-bone IK from each shoulder to a wrist just behind the grip (right hand on stickGrip, left on throttleGrip),
// the elbow pushed out, down and back. Legs are solved once (feet on the pedals). The head turns with the free look (clamped).

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { ANCHORS, SEAT, stickGrip, throttleGrip } from './jetspec.js';

const D2R = Math.PI / 180;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const HEAD = { yaw: 95 * D2R, up: 60 * D2R, down: 40 * D2R };   // how far the head itself turns (the camera may go further)
const ARM = { upper: 0.31, fore: 0.27, wrist: 0.055 };          // m; wrist = wrist -> grip centre
const LEG = { thigh: 0.46, shin: 0.47 };

/** a capsule spanning 0..len along +y (one per limb segment; placed by setSeg) */
const seg = (r, len, rs = 10) => new THREE.CapsuleGeometry(r, Math.max(0.001, len - 2 * r), 3, rs).translate(0, len / 2, 0);
const _yUp = new THREE.Vector3(0, 1, 0), _d = new THREE.Vector3();
/** put a seg() mesh from a to b (Vector3s, seat frame) */
function setSeg(mesh, a, b) { mesh.position.copy(a); mesh.quaternion.setFromUnitVectors(_yUp, _d.subVectors(b, a).normalize()); }

/** 2-bone IK: the elbow / knee for root S, target T, bone lengths a, b, pole direction P (all Vector3). Writes `mid` and
 *  the reachable end `end` (T, or short of it when out of reach). Allocation-free. */
const _dir = new THREE.Vector3(), _perp = new THREE.Vector3();
export function ik2(S, T, a, b, P, mid, end) {
  _dir.subVectors(T, S);
  const d = clamp(_dir.length(), Math.abs(a - b) + 1e-3, a + b - 1e-3);
  _dir.normalize();
  const cosA = clamp((a * a + d * d - b * b) / (2 * a * d), -1, 1), sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
  _perp.copy(P).addScaledVector(_dir, -P.dot(_dir)).normalize();
  mid.copy(S).addScaledVector(_dir, a * cosA).addScaledVector(_perp, a * sinA);
  end.copy(S).addScaledVector(_dir, d);
}

/**
 * @param {{group:THREE.Group, seat:THREE.Group}} jet   buildJet()'s return
 * @param {{helmetColor?:string, suitColor?:string}} [opts]
 * @returns {{group:THREE.Group, head:THREE.Group, eye:THREE.Object3D, triangles:number,
 *            update:(ms:{stickX?:number,stickY?:number,throttle?:number}, look?:{yaw:number,pitch:number})=>void, dispose:()=>void}}
 */
export function buildPilot(jet, opts = {}) {
  const M = {   // plain meshes only: shared freely
    suit: new THREE.MeshStandardMaterial({ color: opts.suitColor ?? '#5d6447', roughness: 0.92 }),
    harness: new THREE.MeshStandardMaterial({ color: '#2b2e26', roughness: 0.85 }),
    vest: new THREE.MeshStandardMaterial({ color: '#4a4f3c', roughness: 0.9 }),
    glove: new THREE.MeshStandardMaterial({ color: '#1e1c1a', roughness: 0.8 }),
    boot: new THREE.MeshStandardMaterial({ color: '#141414', roughness: 0.7 }),
    // a hint of emission so the shell does not go grey when the low sun is behind it (film lesson)
    helmet: new THREE.MeshStandardMaterial({ color: opts.helmetColor ?? '#d8d9db', roughness: 0.45, metalness: 0.05, emissive: opts.helmetColor ?? '#d8d9db', emissiveIntensity: 0.12 }),
    visor: new THREE.MeshStandardMaterial({ color: '#0b0c0e', roughness: 0.08, metalness: 0.6 }),
    mask: new THREE.MeshStandardMaterial({ color: '#3b3d40', roughness: 0.75 }),
    metal: new THREE.MeshStandardMaterial({ color: '#9a9ea3', roughness: 0.35, metalness: 0.9 }),
  };
  const group = new THREE.Group(); group.name = 'pilot';
  jet.seat.add(group);
  const add = (geo, mat, parent = group, name = '') => { const o = new THREE.Mesh(geo, mat); o.name = name; o.castShadow = true; parent.add(o); return o; };
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  // the seat frame's origin in jet space (SEAT.ref + the fit); the grips are jet space, so seat-local = jet - this
  const seatOrigin = () => jet.seat.position;
  const jetToLocal = (p, out) => out.set(p[0], p[1], p[2]).sub(seatOrigin());

  // ---- the design eye and the neck pivot (seat frame, at the seat's rest position)
  const eye0 = jetToLocal(ANCHORS.eye, V());
  const neck = eye0.clone().add(V(0, -0.13, -0.09));             // head pivot: top of the neck, behind and below the eye

  // ---- torso (static): hips on the pan, the back along the seat's 20 deg recline but a little more upright
  const hip = V(0, 0.11, 0.1), chest = V(0, 0.5, -0.06), shoulderC = V(0, 0.6, -0.1);
  const torso = add(new THREE.CapsuleGeometry(0.15, 0.36, 4, 12).scale(1.2, 1, 0.78), M.suit, group, 'torso');
  torso.position.lerpVectors(hip, shoulderC, 0.5).add(V(0, -0.02, 0)); torso.quaternion.setFromUnitVectors(_yUp, _d.subVectors(shoulderC, hip).normalize());
  const vest = add(new THREE.CapsuleGeometry(0.155, 0.16, 3, 12).scale(1.22, 1, 0.82), M.vest, group, 'vest');   // the survival vest over the chest
  vest.position.copy(chest).add(V(0, -0.03, 0.012)); vest.quaternion.copy(torso.quaternion);
  const pelvis = add(new THREE.CapsuleGeometry(0.13, 0.16, 3, 10).rotateZ(Math.PI / 2).scale(1, 0.8, 1), M.suit, group, 'pelvis');
  pelvis.position.copy(hip);
  // harness: two shoulder straps down the chest, the lap belt, the buckle
  const strapG = [];
  for (const sx of [1, -1]) {
    const a = V(sx * 0.1, 0.66, -0.13), b = V(sx * 0.07, 0.22, 0.12), L = a.distanceTo(b);
    const g = new THREE.BoxGeometry(0.045, L, 0.012).translate(0, L / 2, 0);
    g.applyMatrix4(new THREE.Matrix4().compose(a, new THREE.Quaternion().setFromUnitVectors(_yUp, _d.subVectors(b, a).normalize()), V(1, 1, 1)));
    // pushed out onto the vest's front surface
    g.translate(0, 0, 0.11); strapG.push(g);
  }
  strapG.push(new THREE.BoxGeometry(0.34, 0.045, 0.012).translate(0, 0.17, 0.23).rotateX(-0.25));
  add(mergeGeometries(strapG), M.harness, group, 'harness');
  add(new THREE.CylinderGeometry(0.035, 0.035, 0.015, 12).rotateX(Math.PI / 2).translate(0, 0.27, 0.21), M.metal, group, 'buckle');

  // ---- legs (static IK: hips -> knees -> feet on the pedals)
  const mid = V(), end = V();
  for (const sx of [1, -1]) {
    const H = V(sx * 0.1, hip.y, hip.z + 0.04);
    const F = jetToLocal([sx * SEAT.pedals.x, SEAT.pedals.y + 0.05, SEAT.pedals.z - 0.1], V());
    ik2(H, F, LEG.thigh, LEG.shin, V(sx * 0.15, 1, 0.2), mid, end);
    setSeg(add(seg(0.072, LEG.thigh), M.suit, group, 'thigh'), H, mid);
    setSeg(add(seg(0.056, LEG.shin), M.suit, group, 'shin'), mid, end);
    const boot = add(new THREE.CapsuleGeometry(0.05, 0.16, 3, 8).rotateX(Math.PI / 2), M.boot, group, 'boot');
    boot.position.copy(end).add(V(0, -0.02, 0.07));
  }

  // ---- head (turns about the neck pivot): helmet shell, visor down, oxygen mask and hose
  const neckMesh = add(seg(0.055, 0.14), M.suit, group, 'neck');
  setSeg(neckMesh, V(0, shoulderC.y - 0.03, shoulderC.z + 0.02), neck);
  const head = new THREE.Group(); head.name = 'pilot-head'; head.position.copy(neck); head.rotation.order = 'YXZ'; group.add(head);
  const E = eye0.clone().sub(neck);                               // the eye in the head frame
  const hc = E.clone().add(V(0, 0.03, -0.075));                   // the helmet's centre: above and behind the eye
  add(new THREE.SphereGeometry(0.142, 22, 14).scale(0.93, 1, 1.1).translate(hc.x, hc.y, hc.z), M.helmet, head, 'helmet');
  // the visor: a front band of a slightly larger sphere, from brow to below the eyes
  add(new THREE.SphereGeometry(0.148, 22, 8, Math.PI * 0.5 - 1.05, 2.1, Math.PI * 0.36, Math.PI * 0.26).scale(0.95, 1, 1.12).translate(hc.x, hc.y, hc.z), M.visor, head, 'visor');
  add(new THREE.BoxGeometry(0.2, 0.03, 0.05).translate(hc.x, hc.y + 0.085, hc.z + 0.12), M.helmet, head, 'visor-cover');
  const maskC = E.clone().add(V(0, -0.075, 0.035));
  add(new THREE.CylinderGeometry(0.035, 0.05, 0.075, 12).rotateX(Math.PI / 2).translate(maskC.x, maskC.y, maskC.z), M.mask, head, 'mask');
  add(new THREE.CylinderGeometry(0.014, 0.014, 0.2, 8).translate(0, -0.1, 0).rotateX(0.5).translate(maskC.x - 0.02, maskC.y - 0.02, maskC.z + 0.02), M.mask, head, 'hose');
  const eye = new THREE.Object3D(); eye.name = 'pilot-eye'; eye.position.copy(E); head.add(eye);

  // ---- arms (per frame): upper arm, forearm, glove
  const arms = [1, -1].map((sx) => ({
    sx, S: V(sx * 0.2, shoulderC.y - 0.02, shoulderC.z), pole: V(sx * 0.8, -0.6, -0.5),
    up: add(seg(0.052, ARM.upper), M.suit, group, 'upper-arm'), fo: add(seg(0.044, ARM.fore), M.suit, group, 'forearm'),
    hand: add(new THREE.SphereGeometry(0.048, 10, 8).scale(0.9, 1.1, 1.25), M.glove, group, 'glove'),
    sh: add(new THREE.SphereGeometry(0.068, 12, 8), M.suit, group, 'shoulder'),
  }));
  for (const a of arms) a.sh.position.copy(a.S);
  const _sg = { c: [0, 0, 0], axis: [0, 0, 0] }, _tg = [0, 0, 0], G = V(), W = V(), elbow = V(), wr = V();

  function update(ms = {}, look = null) {
    // the grips only mean something while the seat is in the jet
    if (jet.seat.parent === jet.group) {
      stickGrip(ms.stickX || 0, ms.stickY || 0, _sg);
      throttleGrip(ms.throttle ?? 0.5, _tg);
      for (const a of arms) {
        jetToLocal(a.sx < 0 ? _sg.c : _tg, G);                    // right hand (x < 0) on the stick, left on the throttle
        W.subVectors(a.S, G).normalize().multiplyScalar(ARM.wrist).add(G);   // the wrist sits just behind the grip
        ik2(a.S, W, ARM.upper, ARM.fore, a.pole, elbow, wr);
        setSeg(a.up, a.S, elbow); setSeg(a.fo, elbow, wr);
        a.hand.position.lerpVectors(wr, G, 0.7); a.hand.quaternion.copy(a.fo.quaternion);
      }
    }
    const yaw = look ? clamp(look.yaw, -HEAD.yaw, HEAD.yaw) : 0, pitch = look ? clamp(look.pitch, -HEAD.down, HEAD.up) : 0;
    head.rotation.set(-pitch, -yaw, 0);                           // controls.look: + yaw = right (-x), + pitch = up
  }
  update({});

  let triangles = 0;
  group.traverse((o) => { if (o.isMesh) { const g = o.geometry; triangles += (g.index ? g.index.count : g.attributes.position.count) / 3; } });
  function dispose() {
    group.traverse((o) => o.geometry?.dispose());
    Object.values(M).forEach((m) => m.dispose());
    group.removeFromParent();
  }
  return { group, head, eye, update, triangles: Math.round(triangles), dispose };
}

