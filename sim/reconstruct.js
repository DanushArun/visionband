/**
 * Occupancy accumulation — the "Batman picture".
 *
 * Individual ToF returns are sparse and noisy. Voxelising them and letting
 * confidence build with repeat hits (and decay without them) is what turns a
 * scatter of points into a readable room. It is also the honest answer to
 * "is one 63° sensor enough": you watch the map fill in as the head sweeps,
 * and you see exactly which surfaces never fill in at all.
 */

import { CLASS_RGB } from './palette.js';

export class VoxelMap {
  /**
   * @param {number} miss multiplier applied to a voxel a ray passed straight
   *   through. Must be gentle enough that a real surface survives the sensor's
   *   dropout rate: at 65% dropout a wall gets one hit per two misses, which
   *   settles around 0.8 confidence with miss = 0.8. Too aggressive and real
   *   walls flicker out; too gentle and stale returns never clear.
   */
  constructor({
    cell = 0.02, decay = 0.999, capacity = 420000, minConfidence = 0.04,
    miss = 0.75, missWeak = 0.95,
  } = {}) {
    this.cell = cell;
    this.decay = decay;
    this.capacity = capacity;
    this.minConfidence = minConfidence;
    this.miss = miss;
    /**
     * Applied when a ray returned *nothing*. Such a reading is ambiguous — the
     * space may be empty, or the surface may simply have absorbed or deflected
     * the beam — so it is weak evidence of emptiness. Occupancy mappers
     * conventionally down-weight or discard max-range readings for exactly this
     * reason. Treating them as confidently as a real distance reading erodes
     * every wall the sensor drops out on, which at 65% dropout is all of them.
     */
    this.missWeak = missWeak;
    this.voxels = new Map();

    this.positions = new Float32Array(capacity * 3);
    this.colors = new Float32Array(capacity * 3);
    this.count = 0;
  }

  clear() {
    this.voxels.clear();
    this.count = 0;
  }

  key(ix, iy, iz) {
    return ix * 4194304 + iy * 2048 + iz;
  }

  /**
   * Fold one return into the map. Repeat hits on the same cell build confidence.
   * @param {number} cls surface class, for colouring — see palette.js
   */
  add(p, cls = 3) {
    const c = this.cell;
    const ix = Math.round(p.x / c);
    const iy = Math.round(p.y / c);
    const iz = Math.round(p.z / c);
    const k = this.key(ix, iy, iz);

    const existing = this.voxels.get(k);
    if (existing) {
      existing.c = Math.min(1, existing.c + 0.3);
      // Nudge toward the new sample so noise averages out rather than smears.
      existing.x += (p.x - existing.x) * 0.25;
      existing.y += (p.y - existing.y) * 0.25;
      existing.z += (p.z - existing.z) * 0.25;
      existing.k = cls;
    } else {
      this.voxels.set(k, { x: p.x, y: p.y, z: p.z, c: 0.3, k: cls });
    }
  }

  /**
   * Free-space carving: weaken every voxel the ray passed *through* on its way
   * to `dist`. Seeing through a place is evidence nothing is there.
   *
   * This is what stops a moving object leaving a permanent trail. Decay alone
   * cannot do it — decay is blind, so it fades the walls you are still looking
   * at at the same rate as the space someone just walked out of. Carving is
   * targeted: only the voxels actually observed to be empty lose confidence.
   *
   * A ray that returned nothing carves its whole range, which is why glass
   * genuinely disappears from the map. That is a true property of the sensor,
   * not a bug in the simulation.
   *
   * 3D DDA (Amanatides & Woo). Voxel i spans [(i-0.5)·cell, (i+0.5)·cell].
   */
  carve(ox, oy, oz, dx, dy, dz, dist, weak = false) {
    const c = this.cell;
    // Stop short of the hit so the surface itself is never carved.
    const limit = dist - c * 0.75;
    if (limit <= 0) return;

    let ix = Math.round(ox / c);
    let iy = Math.round(oy / c);
    let iz = Math.round(oz / c);

    const sx = dx > 0 ? 1 : -1;
    const sy = dy > 0 ? 1 : -1;
    const sz = dz > 0 ? 1 : -1;

    const bound = (i, o, d, s) => (d === 0 ? Infinity : ((i + 0.5 * s) * c - o) / d);
    let tX = bound(ix, ox, dx, sx);
    let tY = bound(iy, oy, dy, sy);
    let tZ = bound(iz, oz, dz, sz);
    const dX = dx === 0 ? Infinity : c / Math.abs(dx);
    const dY = dy === 0 ? Infinity : c / Math.abs(dy);
    const dZ = dz === 0 ? Infinity : c / Math.abs(dz);

    const { voxels, minConfidence } = this;
    const miss = weak ? this.missWeak : this.miss;
    // 4 m of 2 cm voxels is 200 steps; the cap only guards against a degenerate
    // direction producing an unbounded walk.
    for (let n = 0; n < 260; n++) {
      let t;
      if (tX < tY && tX < tZ) { ix += sx; t = tX; tX += dX; }
      else if (tY < tZ) { iy += sy; t = tY; tY += dY; }
      else { iz += sz; t = tZ; tZ += dZ; }
      if (t >= limit) return;

      const k = this.key(ix, iy, iz);
      const v = voxels.get(k);
      if (v !== undefined) {
        v.c *= miss;
        if (v.c < minConfidence) voxels.delete(k);
      }
    }
  }

  /**
   * Age the map. A slow backstop for voxels nothing has looked at recently —
   * carving handles everything actually observed.
   */
  step() {
    for (const [k, v] of this.voxels) {
      v.c *= this.decay;
      if (v.c < this.minConfidence) this.voxels.delete(k);
    }
    if (this.voxels.size > this.capacity) this._prune();
  }

  _prune() {
    const entries = [...this.voxels.entries()].sort((a, b) => a[1].c - b[1].c);
    const drop = this.voxels.size - this.capacity;
    for (let i = 0; i < drop; i++) this.voxels.delete(entries[i][0]);
  }

  /** Repack into the typed arrays the Points geometry draws from. */
  bake() {
    let n = 0;
    const pos = this.positions;
    const col = this.colors;
    for (const v of this.voxels.values()) {
      if (n >= this.capacity) break;
      const i = n * 3;
      pos[i] = v.x;
      pos[i + 1] = v.y;
      pos[i + 2] = v.z;

      // Hue = what it hit, brightness = how strong the return is. Floor at 0.3
      // so a single weak return is still visible rather than black-on-black,
      // and a slight lift toward white at full confidence so dense surfaces
      // read as solid.
      const b = 0.3 + 0.7 * v.c;
      const w = 0.25 * v.c * v.c;
      const cRGB = v.k * 3;
      col[i] = Math.min(1, CLASS_RGB[cRGB] * b + w);
      col[i + 1] = Math.min(1, CLASS_RGB[cRGB + 1] * b + w);
      col[i + 2] = Math.min(1, CLASS_RGB[cRGB + 2] * b + w);
      n++;
    }
    this.count = n;
    return n;
  }
}

export function buildPointCloud(voxelMap) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(voxelMap.positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(voxelMap.colors, 3));
  geo.setDrawRange(0, 0);

  const mat = new THREE.PointsMaterial({
    // Roughly two-thirds of a voxel: small enough that adjacent returns read as
    // separate samples and an object's silhouette survives, rather than merging
    // into a blob that hides its shape.
    size: 0.014,
    vertexColors: true,
    transparent: true,
    opacity: 0.95,
    // Normal blending, not additive: additive washes overlapping returns toward
    // white, which destroys the class hue exactly where the cloud is densest.
    blending: THREE.NormalBlending,
    depthWrite: false,
    sizeAttenuation: true,
  });

  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  return points;
}

export function refreshPointCloud(points, voxelMap) {
  const n = voxelMap.bake();
  points.geometry.attributes.position.needsUpdate = true;
  points.geometry.attributes.color.needsUpdate = true;
  points.geometry.setDrawRange(0, n);
  return n;
}
