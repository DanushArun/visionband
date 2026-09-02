/**
 * Bounding volume hierarchy for ray queries against the imported room mesh.
 *
 * three.js's Raycaster tests every triangle of every mesh. At 104k triangles and
 * 448 rays per sensor tick that is 47M triangle tests per tick — around 700M a
 * second at 15 Hz, which no browser will do. A BVH turns each ray into roughly
 * 30 node tests plus a handful of triangle tests.
 *
 * Flat typed arrays throughout: node objects would allocate 100k+ objects at
 * build time and chase pointers on every traversal.
 */

const STACK_SIZE = 64;

export class BVH {
  /**
   * @param {Float32Array} positions  xyz triples
   * @param {Uint32Array|Uint16Array} indices  triangle corner indices
   */
  constructor(positions, indices) {
    this.positions = positions;
    this.indices = indices;
    this.triCount = indices.length / 3;

    this.triIndex = new Uint32Array(this.triCount);
    this.centroids = new Float32Array(this.triCount * 3);
    this.triBounds = new Float32Array(this.triCount * 6);

    // A binary tree over N leaves needs at most 2N-1 nodes.
    const maxNodes = Math.max(1, 2 * this.triCount - 1);
    this.bounds = new Float32Array(maxNodes * 6);
    this.child = new Int32Array(maxNodes).fill(-1); // left child; right is left+1
    this.start = new Int32Array(maxNodes);
    this.count = new Int32Array(maxNodes);
    this.nodeCount = 0;

    this._stack = new Int32Array(STACK_SIZE);
    this._prepare();
    this._build();
  }

  _prepare() {
    const { positions, indices, centroids, triBounds, triIndex } = this;
    for (let t = 0; t < this.triCount; t++) {
      triIndex[t] = t;
      const a = indices[t * 3] * 3, b = indices[t * 3 + 1] * 3, c = indices[t * 3 + 2] * 3;
      for (let k = 0; k < 3; k++) {
        const p = positions[a + k], q = positions[b + k], r = positions[c + k];
        centroids[t * 3 + k] = (p + q + r) / 3;
        triBounds[t * 6 + k] = Math.min(p, q, r);
        triBounds[t * 6 + 3 + k] = Math.max(p, q, r);
      }
    }
  }

  _build() {
    const LEAF_SIZE = 8;
    const root = this.nodeCount++;
    this.start[root] = 0;
    this.count[root] = this.triCount;
    this._fitBounds(root);

    // Explicit stack — recursion would blow at this depth on some engines.
    const todo = [root];
    while (todo.length) {
      const node = todo.pop();
      const n = this.count[node];
      if (n <= LEAF_SIZE) continue;

      const b = node * 6;
      let axis = 0;
      let extent = this.bounds[b + 3] - this.bounds[b];
      const ey = this.bounds[b + 4] - this.bounds[b + 1];
      const ez = this.bounds[b + 5] - this.bounds[b + 2];
      if (ey > extent) { axis = 1; extent = ey; }
      if (ez > extent) { axis = 2; extent = ez; }
      if (extent <= 0) continue;

      // Split at the centroid midpoint of the longest axis. Cheaper than full
      // SAH and good enough for a static, roughly uniform indoor scan.
      const split = (this.bounds[b + axis] + this.bounds[b + 3 + axis]) / 2;
      const s = this.start[node];
      let mid = this._partition(s, s + n, axis, split);

      // Degenerate split (everything on one side) — fall back to a median cut,
      // otherwise the tree never terminates.
      if (mid === s || mid === s + n) mid = s + (n >> 1);

      const left = this.nodeCount++;
      const right = this.nodeCount++;
      this.child[node] = left;
      this.start[left] = s; this.count[left] = mid - s;
      this.start[right] = mid; this.count[right] = s + n - mid;
      this._fitBounds(left);
      this._fitBounds(right);
      todo.push(left, right);
    }
  }

  _partition(from, to, axis, split) {
    const { triIndex, centroids } = this;
    let i = from;
    let j = to - 1;
    while (i <= j) {
      if (centroids[triIndex[i] * 3 + axis] < split) {
        i++;
      } else {
        const tmp = triIndex[i];
        triIndex[i] = triIndex[j];
        triIndex[j] = tmp;
        j--;
      }
    }
    return i;
  }

  _fitBounds(node) {
    const { triIndex, triBounds } = this;
    const b = node * 6;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity;
    let x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    const s = this.start[node];
    const e = s + this.count[node];
    for (let i = s; i < e; i++) {
      const t = triIndex[i] * 6;
      if (triBounds[t] < x0) x0 = triBounds[t];
      if (triBounds[t + 1] < y0) y0 = triBounds[t + 1];
      if (triBounds[t + 2] < z0) z0 = triBounds[t + 2];
      if (triBounds[t + 3] > x1) x1 = triBounds[t + 3];
      if (triBounds[t + 4] > y1) y1 = triBounds[t + 4];
      if (triBounds[t + 5] > z1) z1 = triBounds[t + 5];
    }
    this.bounds[b] = x0; this.bounds[b + 1] = y0; this.bounds[b + 2] = z0;
    this.bounds[b + 3] = x1; this.bounds[b + 4] = y1; this.bounds[b + 5] = z1;
  }

  /**
   * Nearest hit along a ray.
   * @returns {null|{distance, triangle, nx, ny, nz}} geometric normal, unnormalised
   *   winding (this export's winding is inconsistent, so callers must use |n·d|).
   */
  raycast(ox, oy, oz, dx, dy, dz, maxDist) {
    const invx = 1 / dx, invy = 1 / dy, invz = 1 / dz;
    const stack = this._stack;
    let sp = 0;
    stack[sp++] = 0;

    let bestT = maxDist;
    let bestTri = -1;
    const { bounds, child, start, count, triIndex, indices, positions } = this;

    while (sp > 0) {
      const node = stack[--sp];
      const b = node * 6;

      // Slab test
      let t0 = (bounds[b] - ox) * invx;
      let t1 = (bounds[b + 3] - ox) * invx;
      let tmin = Math.min(t0, t1);
      let tmax = Math.max(t0, t1);
      t0 = (bounds[b + 1] - oy) * invy;
      t1 = (bounds[b + 4] - oy) * invy;
      tmin = Math.max(tmin, Math.min(t0, t1));
      tmax = Math.min(tmax, Math.max(t0, t1));
      t0 = (bounds[b + 2] - oz) * invz;
      t1 = (bounds[b + 5] - oz) * invz;
      tmin = Math.max(tmin, Math.min(t0, t1));
      tmax = Math.min(tmax, Math.max(t0, t1));
      if (tmax < Math.max(tmin, 0) || tmin > bestT) continue;

      const left = child[node];
      if (left >= 0) {
        if (sp + 2 <= STACK_SIZE) { stack[sp++] = left; stack[sp++] = left + 1; }
        continue;
      }

      const s = start[node];
      const e = s + count[node];
      for (let i = s; i < e; i++) {
        const tri = triIndex[i];
        const ia = indices[tri * 3] * 3, ib = indices[tri * 3 + 1] * 3, ic = indices[tri * 3 + 2] * 3;

        // Möller–Trumbore, two-sided: the mesh has reversed windings in places,
        // and a one-sided test would make whole walls invisible.
        const ax = positions[ia], ay = positions[ia + 1], az = positions[ia + 2];
        const e1x = positions[ib] - ax, e1y = positions[ib + 1] - ay, e1z = positions[ib + 2] - az;
        const e2x = positions[ic] - ax, e2y = positions[ic + 1] - ay, e2z = positions[ic + 2] - az;

        const px = dy * e2z - dz * e2y;
        const py = dz * e2x - dx * e2z;
        const pz = dx * e2y - dy * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (det > -1e-9 && det < 1e-9) continue;

        const inv = 1 / det;
        const tx = ox - ax, ty = oy - ay, tz = oz - az;
        const u = (tx * px + ty * py + tz * pz) * inv;
        if (u < 0 || u > 1) continue;

        const qx = ty * e1z - tz * e1y;
        const qy = tz * e1x - tx * e1z;
        const qz = tx * e1y - ty * e1x;
        const v = (dx * qx + dy * qy + dz * qz) * inv;
        if (v < 0 || u + v > 1) continue;

        const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
        if (t > 1e-5 && t < bestT) { bestT = t; bestTri = tri; }
      }
    }

    if (bestTri < 0) return null;

    const ia = indices[bestTri * 3] * 3, ib = indices[bestTri * 3 + 1] * 3, ic = indices[bestTri * 3 + 2] * 3;
    const e1x = positions[ib] - positions[ia], e1y = positions[ib + 1] - positions[ia + 1], e1z = positions[ib + 2] - positions[ia + 2];
    const e2x = positions[ic] - positions[ia], e2y = positions[ic + 1] - positions[ia + 1], e2z = positions[ic + 2] - positions[ia + 2];
    let nx = e1y * e2z - e1z * e2y;
    let ny = e1z * e2x - e1x * e2z;
    let nz = e1x * e2y - e1y * e2x;
    const len = Math.hypot(nx, ny, nz) || 1;
    return { distance: bestT, triangle: bestTri, nx: nx / len, ny: ny / len, nz: nz / len };
  }
}
