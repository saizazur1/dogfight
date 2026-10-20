// cockpitcam.js -- the first-person cockpit camera (COCKPIT lane, phase 2).
//
//   const cock = createCockpitCam(camera, { jet });   // jet = buildJet()'s return (for the HUD glass)
//   cock.enter([pilot.head]);                        // near 0.03, fov 70, hides the given objects (the pilot's head)
//   cock.update(frameDt, pose, look, s);             // once per display frame, the interpolated pose; look = controls.look
//   cock.exit();                                     // restores near / fov and shows the hidden objects
//   cock.hudRect(w, h)                               // { x, y, w, h, pts[8] }: the HUD glass on screen, CSS px (call after update)
//
// The lens sits at ANCHORS.eye (jet space) and turns with the head about the neck pivot, so a free look moves the eye a few cm
// like a real head. It rolls with the jet (the horizon tilts). A small sag under g.

import * as THREE from 'three';
import { ANCHORS } from './jetspec.js';

const D2R = Math.PI / 180;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** Every cockpit-camera number in one place. */
export const COCKPIT = {
  fov: 70, near: 0.03,
  yawMax: 160 * D2R, pitchUp: 85 * D2R, pitchDown: 55 * D2R,   // free-look limits (deg)
  neck: [0, -0.13, -0.09],      // the head pivot relative to the eye (jet space; pilot.js uses the same)
  lean: [0.11, 0.04, 0.12],      // m (out to the side, down, forward) at a full look back
  sagPerG: 0.004, sagMax: 0.03, // m the eye drops per g over 1
};

/**
 * @param {THREE.PerspectiveCamera} camera
 * @param {{jet?:{group:THREE.Object3D}}} [opts]
 */
export function createCockpitCam(camera, opts = {}) {
  const qJet = new THREE.Quaternion(), qLook = new THREE.Quaternion(), qFlip = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
  const eul = new THREE.Euler(0, 0, 0, 'YXZ'), off = new THREE.Vector3(), neck = new THREE.Vector3();
  const glass = opts.jet ? opts.jet.group.getObjectByName('hud-glass') : null;
  const corner = new THREE.Vector3(), rect = { x: 0, y: 0, w: 0, h: 0, pts: new Array(8).fill(0) };
  let saved = null, hidden = [], sag = 0;

  function enter(hide = []) {
    if (!saved) saved = { near: camera.near, fov: camera.fov };
    camera.near = COCKPIT.near; camera.fov = COCKPIT.fov; camera.updateProjectionMatrix();
    hidden = hide; for (const o of hidden) o.visible = false;
  }
  function exit() {
    if (saved) { camera.near = saved.near; camera.fov = saved.fov; camera.updateProjectionMatrix(); saved = null; }
    for (const o of hidden) o.visible = true;
    hidden = [];
  }

  function update(frameDt, pose, look, s) {
    const yaw = look ? clamp(look.yaw, -COCKPIT.yawMax, COCKPIT.yawMax) : 0;
    const pitch = look ? clamp(look.pitch, -COCKPIT.pitchDown, COCKPIT.pitchUp) : 0;
    const g = s ? s.gLoad || 1 : 1, k = 1 - Math.exp(-6 * clamp(frameDt, 0, 0.1));
    sag += (clamp((g - 1) * COCKPIT.sagPerG, -COCKPIT.sagMax, COCKPIT.sagMax) - sag) * k;
    // the head's turn in JET space (+z forward, +x left): + yaw = right = about +y by -yaw; + pitch = up = about +x by -pitch
    eul.set(-pitch, -yaw, 0); qLook.setFromEuler(eul);
    // the eye = neck pivot + the turned (eye - neck) offset, in jet space
    neck.set(ANCHORS.eye[0] + COCKPIT.neck[0], ANCHORS.eye[1] + COCKPIT.neck[1] - sag, ANCHORS.eye[2] + COCKPIT.neck[2]);
    off.set(-COCKPIT.neck[0], -COCKPIT.neck[1], -COCKPIT.neck[2]).applyQuaternion(qLook).add(neck);
    // checking six: past ~60 deg the pilot leans forward and out to the look side (else the headbox fills the view)
    const lean = clamp((Math.abs(yaw) - 60 * D2R) / (90 * D2R), 0, 1);
    off.x -= Math.sign(yaw) * COCKPIT.lean[0] * lean; off.y -= COCKPIT.lean[1] * lean; off.z += COCKPIT.lean[2] * lean;
    qJet.fromArray(pose.q);
    off.applyQuaternion(qJet);
    camera.position.set(pose.pos[0] + off.x, pose.pos[1] + off.y, pose.pos[2] + off.z);
    // the lens looks down its -z: jet * look * (half turn so -z = the nose)
    camera.quaternion.copy(qJet).multiply(qLook).multiply(qFlip);
    camera.updateMatrixWorld();
  }

  /** The HUD glass (jetmodel 'hud-glass', a 0.16 x 0.13 m plane) projected to the screen: the bounding box and its 4 corners
   *  (pts = [x0,y0, x1,y1, x2,y2, x3,y3], CSS px, y down). Needs the jet's world matrix current (after the pose is written). */
  function hudRect(w = innerWidth, h = innerHeight) {
    if (!glass) return null;
    glass.updateWorldMatrix(true, false);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < 4; i++) {
      corner.set(i & 1 ? 0.08 : -0.08, i & 2 ? 0.065 : -0.065, 0).applyMatrix4(glass.matrixWorld).project(camera);
      const x = (corner.x * 0.5 + 0.5) * w, y = (0.5 - corner.y * 0.5) * h;
      rect.pts[i * 2] = x; rect.pts[i * 2 + 1] = y;
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
    rect.x = x0; rect.y = y0; rect.w = x1 - x0; rect.h = y1 - y0;
    return rect;
  }

  return { update, enter, exit, hudRect };
}
