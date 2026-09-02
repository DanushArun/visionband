/**
 * A "world" is whatever the sensor rig can shoot rays at: a static BVH for the
 * fixed geometry, plus a short list of moving meshes brute-forced each tick.
 *
 * Splitting static from dynamic matters. Rebuilding a 104k-triangle BVH every
 * tick to move one sofa-sized object would cost far more than testing that
 * object's ~200 triangles directly.
 */

import { BVH } from './bvh.js';

/**
 * Flatten three.js meshes into world-space typed arrays.
 * Reflectivity rides along per triangle because it is what the ToF dropout
 * model consumes, and it varies per source mesh.
 */
export function bakeMeshes(meshes) {
  let vertTotal = 0;
  let triTotal = 0;
  for (const m of meshes) {
    const g = m.geometry;
    vertTotal += g.attributes.position.count;
    triTotal += (g.index ? g.index.count : g.attributes.position.count) / 3;
  }

  const positions = new Float32Array(vertTotal * 3);
  const indices = new Uint32Array(triTotal * 3);
  const triRefl = new Float32Array(triTotal);
  const triLabel = new Array(triTotal);

  let vOff = 0;
  let tOff = 0;
  const v = new THREE.Vector3();

  for (const m of meshes) {
    m.updateMatrixWorld(true);
    const g = m.geometry;
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
      positions[(vOff + i) * 3] = v.x;
      positions[(vOff + i) * 3 + 1] = v.y;
      positions[(vOff + i) * 3 + 2] = v.z;
    }
    const refl = m.userData.reflectivity ?? 0.6;
    const label = m.userData.label ?? 'surface';

    if (g.index) {
      for (let i = 0; i < g.index.count; i++) indices[tOff * 3 + i] = vOff + g.index.array[i];
      for (let t = 0; t < g.index.count / 3; t++) { triRefl[tOff + t] = refl; triLabel[tOff + t] = label; }
      tOff += g.index.count / 3;
    } else {
      for (let i = 0; i < pos.count; i++) indices[tOff * 3 + i] = vOff + i;
      for (let t = 0; t < pos.count / 3; t++) { triRefl[tOff + t] = refl; triLabel[tOff + t] = label; }
      tOff += pos.count / 3;
    }
    vOff += pos.count;
  }

  return { positions, indices, triRefl, triLabel };
}

export class World {
  /**
   * @param {object} cfg
   * @param {THREE.Scene} cfg.scene       what the ground-truth panel draws
   * @param {BVH} cfg.bvh                 static geometry
   * @param {Float32Array} cfg.triRefl    reflectivity per static triangle
   * @param {Array} cfg.triLabel          label per static triangle
   * @param {THREE.Mesh[]} cfg.dynamic    moving meshes, re-baked each tick
   * @param {function} cfg.path           t → THREE.Vector3, the rig's walk
   * @param {function} cfg.update         t → void, moves the dynamic meshes
   */
  constructor({
    name, scene, bvh, triRefl, triLabel, dynamic = [], path, update,
    headHeight = 1.65, bounds = null, stats = {},
  }) {
    this.name = name;
    this.scene = scene;
    this.bvh = bvh;
    this.triRefl = triRefl;
    this.triLabel = triLabel;
    this.dynamicMeshes = dynamic;
    this.pathFn = path;
    this.updateFn = update;
    this.headHeight = headHeight;
    /** Walkable rectangle, so manual driving cannot leave the building. */
    this.bounds = bounds;
    this.stats = stats;
    this.dyn = null;
  }

  path(t) { return this.pathFn(t); }

  /** Keep a position inside the walkable rectangle. */
  clamp(v) {
    if (!this.bounds) return v;
    const [x0, x1] = this.bounds.x;
    const [z0, z1] = this.bounds.z;
    v.x = Math.max(x0, Math.min(x1, v.x));
    v.z = Math.max(z0, Math.min(z1, v.z));
    v.y = this.headHeight;
    return v;
  }

  update(t) {
    if (this.updateFn) this.updateFn(t);
    // Re-bake movers in world space. Cheap at a few hundred triangles, and it
    // sidesteps per-ray matrix inversions.
    if (this.dynamicMeshes.length) this.dyn = bakeMeshes(this.dynamicMeshes);
  }

  /** Nearest hit across static and dynamic geometry. */
  raycast(ox, oy, oz, dx, dy, dz, maxDist) {
    let best = this.bvh.raycast(ox, oy, oz, dx, dy, dz, maxDist);
    if (best) {
      best.reflectivity = this.triRefl[best.triangle];
      best.label = this.triLabel[best.triangle];
    }

    const d = this.dyn;
    if (d) {
      const limit = best ? best.distance : maxDist;
      const hit = brutePierce(d.positions, d.indices, ox, oy, oz, dx, dy, dz, limit);
      if (hit) {
        hit.reflectivity = d.triRefl[hit.triangle];
        hit.label = d.triLabel[hit.triangle];
        best = hit;
      }
    }
    return best;
  }
}

/** Möller–Trumbore over a small triangle soup. Two-sided, like the BVH. */
function brutePierce(positions, indices, ox, oy, oz, dx, dy, dz, maxDist) {
  let bestT = maxDist;
  let bestTri = -1;
  const n = indices.length / 3;
  for (let tri = 0; tri < n; tri++) {
    const ia = indices[tri * 3] * 3, ib = indices[tri * 3 + 1] * 3, ic = indices[tri * 3 + 2] * 3;
    const ax = positions[ia], ay = positions[ia + 1], az = positions[ia + 2];
    const e1x = positions[ib] - ax, e1y = positions[ib + 1] - ay, e1z = positions[ib + 2] - az;
    const e2x = positions[ic] - ax, e2y = positions[ic + 1] - ay, e2z = positions[ic + 2] - az;
    const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (det > -1e-9 && det < 1e-9) continue;
    const inv = 1 / det;
    const tx = ox - ax, ty = oy - ay, tz = oz - az;
    const u = (tx * px + ty * py + tz * pz) * inv;
    if (u < 0 || u > 1) continue;
    const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
    const v = (dx * qx + dy * qy + dz * qz) * inv;
    if (v < 0 || u + v > 1) continue;
    const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
    if (t > 1e-5 && t < bestT) { bestT = t; bestTri = tri; }
  }
  if (bestTri < 0) return null;

  const ia = indices[bestTri * 3] * 3, ib = indices[bestTri * 3 + 1] * 3, ic = indices[bestTri * 3 + 2] * 3;
  const e1x = positions[ib] - positions[ia], e1y = positions[ib + 1] - positions[ia + 1], e1z = positions[ib + 2] - positions[ia + 2];
  const e2x = positions[ic] - positions[ia], e2y = positions[ic + 1] - positions[ia + 1], e2z = positions[ic + 2] - positions[ia + 2];
  let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
  const len = Math.hypot(nx, ny, nz) || 1;
  return { distance: bestT, triangle: bestTri, nx: nx / len, ny: ny / len, nz: nz / len };
}

export { BVH };
