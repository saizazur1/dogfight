// chasecam.js -- the War Thunder-style chase camera (lane FLIGHT). README "chasecam.js".
//
// The camera sits behind and a little above the jet and LOOKS ALONG THE AIM (not the nose): the aim circle stays at the
// screen's centre and the jet visibly rolls and pulls toward it. Exponential damping everywhere (frame-rate independent),
// a slight speed-based pull-back and FOV widening, a little of the jet's bank in the horizon (mostly level), a free-look
// orbit while C is held, and never under the ground (env.terrainHeightAt + a margin).

import * as THREE from 'three';

const D2R = Math.PI / 180;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** Every camera feel number in one place. */
export const CAM = {
  dist: 27,              // m behind the jet's centre (along the look direction) at 200 m/s
  distPerMs: 0.03,       // + m per m/s over 200 (pulls back as it speeds up)
  height: 5.5,           // m above the jet (world up)
  fov: 68, fovPerMs: 0.06, fovMax: 80,   // deg; widening with speed over 200 m/s
  aimRate: 30,           // 1/s: how tightly the view follows the aim (high = the aim circle stays dead centre)
  rollShare: 0.18,       // the fraction of the jet's bank the horizon takes
  rollRate: 4, zoomRate: 2,
  groundMargin: 6,       // m the lens keeps over the ground
};

const WUP = new THREE.Vector3(0, 1, 0);

/**
 * @param {THREE.PerspectiveCamera} camera
 * @returns {{update:(frameDt:number, pose:{pos:number[],q:number[]}, aim:number[], s:object, look?:{yaw:number,pitch:number})=>void,
 *            snap:()=>void, setEnv:(env:{terrainHeightAt?:(x:number,z:number)=>number})=>void, dir:THREE.Vector3}}
 *   update once per display frame with the interpolated pose; look = controls.look (the free-look orbit, rad).
 */
export function createChaseCam(camera) {
  const dir = new THREE.Vector3(0, 0, -1), want = new THREE.Vector3(), eye = new THREE.Vector3(), tgt = new THREE.Vector3();
  const upv = new THREE.Vector3(), m = new THREE.Matrix4(), side = new THREE.Vector3();
  let roll = 0, zoom = 0, snapNext = true, env = null;

  function update(frameDt, pose, aim, s, look) {
    const dt = clamp(frameDt, 0, 0.1), k = (r) => (snapNext ? 1 : 1 - Math.exp(-r * dt));
    // the look direction: the aim, turned by the free-look orbit
    want.set(aim[0], aim[1], aim[2]);
    if (look && (look.yaw || look.pitch)) {
      const yaw = Math.atan2(want.x, -want.z) + look.yaw, h = Math.hypot(want.x, want.z);
      const pitch = clamp(Math.atan2(want.y, h) + look.pitch, -85 * D2R, 85 * D2R), cp = Math.cos(pitch);
      want.set(Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp);
    }
    dir.lerp(want, k(CAM.aimRate)).normalize();
    // the horizon takes a little of the jet's bank (bank from q: atan2(left.y, up.y))
    const q = pose.q, x = q[0], y = q[1], z = q[2], w = q[3];
    const lY = 2 * (x * y + w * z), uY = 1 - 2 * (x * x + z * z);
    const bank = Math.atan2(lY, uY);
    roll += (bank * CAM.rollShare - roll) * k(CAM.rollRate);
    const sp = s ? s.speed : 200;
    zoom += (clamp(sp - 200, -80, 200) - zoom) * k(CAM.zoomRate);
    camera.fov = Math.min(CAM.fovMax, CAM.fov + Math.max(0, zoom) * CAM.fovPerMs);
    camera.updateProjectionMatrix();

    const d = CAM.dist + zoom * CAM.distPerMs;
    eye.set(pose.pos[0] - dir.x * d, pose.pos[1] - dir.y * d + CAM.height, pose.pos[2] - dir.z * d);
    if (env && env.terrainHeightAt) eye.y = Math.max(eye.y, env.terrainHeightAt(eye.x, eye.z) + CAM.groundMargin);
    // orient: look along dir (from the eye, parallel to the aim, so the aim stays at the centre), up = world up rolled
    side.crossVectors(dir, WUP).normalize();
    upv.copy(WUP).multiplyScalar(Math.cos(roll)).addScaledVector(side, Math.sin(roll));
    camera.position.copy(eye);
    tgt.copy(eye).add(dir);
    m.lookAt(eye, tgt, upv);
    camera.quaternion.setFromRotationMatrix(m);
    camera.updateMatrixWorld();
    snapNext = false;
  }
  return { update, snap() { snapNext = true; }, setEnv(e) { env = e; }, dir };
}
