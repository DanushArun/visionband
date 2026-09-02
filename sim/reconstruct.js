/**
 * Occupancy accumulation — the "Batman picture".
 *
 * Individual ToF returns are sparse and noisy. Voxelising them and letting
 * confidence build with repeat hits (and decay without them) is what turns a
 * scatter of points into a readable room. It is also the honest answer to
 * "is one 63° sensor enough": you watch the map fill in as the head sweeps,
 * and you see exactly which surfaces never fill in at all.
 */

export class VoxelMap {
  constructor({ cell = 0.09, decay = 0.985, capacity = 45000, minConfidence = 0.06 } = {}) {
    this.cell = cell;
    this.decay = decay;
    this.capacity = capacity;
    this.minConfidence = minConfidence;
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

  /** Fold one return into the map. Repeat hits on the same cell build confidence. */
  add(p) {
    const c = this.cell;
    const ix = Math.round(p.x / c);
    const iy = Math.round(p.y / c);
    const iz = Math.round(p.z / c);
    const k = this.key(ix, iy, iz);

    const existing = this.voxels.get(k);
    if (existing) {
      existing.c = Math.min(1, existing.c + 0.35);
      // Nudge toward the new sample so noise averages out rather than smears.
      existing.x += (p.x - existing.x) * 0.25;
      existing.y += (p.y - existing.y) * 0.25;
      existing.z += (p.z - existing.z) * 0.25;
    } else {
      this.voxels.set(k, { x: p.x, y: p.y, z: p.z, c: 0.35 });
    }
  }

  /**
   * Age the map. Without decay the reconstruction is a permanent record and
   * moving objects leave smears; with it, the map reflects what is there *now*.
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

      // Cold blue at low confidence through to hot white at high — the point
      // cloud then reads as "how sure am I" rather than just "something here".
      const c = v.c;
      col[i] = 0.25 + 0.75 * c * c;
      col[i + 1] = 0.55 + 0.45 * c;
      col[i + 2] = 0.7 + 0.3 * c;
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
    size: 0.055,
    vertexColors: true,
    transparent: true,
    opacity: 0.95,
    blending: THREE.AdditiveBlending,
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
