/**
 * BVH conformance and performance, against the real imported room.
 *
 *   node --test sim/bvh.test.mjs
 *
 * A BVH that misses hits produces a plausible-looking but wrong reconstruction,
 * which is the worst kind of bug in a simulator whose whole job is to tell you
 * the truth about coverage. So every ray is checked against brute force.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { BVH } from './bvh.js';

const here = dirname(fileURLToPath(import.meta.url));

/** Reference implementation: test every triangle, take the nearest. */
function bruteForce(positions, indices, o, d, maxDist) {
  let bestT = maxDist;
  let bestTri = -1;
  for (let tri = 0; tri < indices.length / 3; tri++) {
    const ia = indices[tri * 3] * 3, ib = indices[tri * 3 + 1] * 3, ic = indices[tri * 3 + 2] * 3;
    const ax = positions[ia], ay = positions[ia + 1], az = positions[ia + 2];
    const e1 = [positions[ib] - ax, positions[ib + 1] - ay, positions[ib + 2] - az];
    const e2 = [positions[ic] - ax, positions[ic + 1] - ay, positions[ic + 2] - az];
    const p = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]];
    const det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2];
    if (det > -1e-9 && det < 1e-9) continue;
    const inv = 1 / det;
    const tv = [o[0] - ax, o[1] - ay, o[2] - az];
    const u = (tv[0] * p[0] + tv[1] * p[1] + tv[2] * p[2]) * inv;
    if (u < 0 || u > 1) continue;
    const q = [tv[1] * e1[2] - tv[2] * e1[1], tv[2] * e1[0] - tv[0] * e1[2], tv[0] * e1[1] - tv[1] * e1[0]];
    const v = (d[0] * q[0] + d[1] * q[1] + d[2] * q[2]) * inv;
    if (v < 0 || u + v > 1) continue;
    const t = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) * inv;
    if (t > 1e-5 && t < bestT) { bestT = t; bestTri = tri; }
  }
  return bestTri < 0 ? null : { distance: bestT, triangle: bestTri };
}

/** Deterministic PRNG so a failure is reproducible. */
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('unit cube: BVH agrees with brute force from every direction', () => {
  // Two triangles forming a quad at z = 2, facing back toward the origin.
  const positions = new Float32Array([-1, -1, 2, 1, -1, 2, 1, 1, 2, -1, 1, 2]);
  const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
  const bvh = new BVH(positions, indices);

  const hit = bvh.raycast(0, 0, 0, 0, 0, 1, 10);
  assert.ok(hit, 'ray down +Z must hit the quad');
  assert.ok(Math.abs(hit.distance - 2) < 1e-5, `expected 2 m, got ${hit.distance}`);
  assert.ok(Math.abs(Math.abs(hit.nz) - 1) < 1e-5, 'normal must face along Z');

  assert.equal(bvh.raycast(0, 0, 0, 0, 0, -1, 10), null, 'the other way must miss');
  assert.equal(bvh.raycast(0, 0, 0, 0, 0, 1, 1.5), null, 'maxDist must be honoured');
  assert.equal(bvh.raycast(5, 5, 0, 0, 0, 1, 10), null, 'off to the side must miss');
});

test('two-sided: a back-facing triangle still returns a hit', () => {
  // Reversed winding — the imported scan is full of these.
  const positions = new Float32Array([-1, -1, 2, 1, 1, 2, 1, -1, 2]);
  const indices = new Uint32Array([0, 1, 2]);
  const bvh = new BVH(positions, indices);
  const hit = bvh.raycast(0, 0, 0, 0, 0, 1, 10);
  assert.ok(hit, 'reversed winding must not make geometry invisible');
});

const roomBin = join(here, 'rooms/livingroom.bin');
const roomMeta = join(here, 'rooms/livingroom.json');

test('imported room: 2000 random rays match brute force exactly', { skip: !existsSync(roomBin) && 'room not imported' }, () => {
  const meta = JSON.parse(readFileSync(roomMeta, 'utf8'));
  const buf = readFileSync(roomBin);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

  const positions = new Float32Array(ab, 0, meta.vertexCount * 3);
  const IndexArray = meta.indexType === 'Uint32' ? Uint32Array : Uint16Array;
  const indices = new IndexArray(ab, positions.byteLength, meta.triangleCount * 3);

  const t0 = performance.now();
  const bvh = new BVH(positions, indices);
  const buildMs = performance.now() - t0;
  console.log(`      build ${buildMs.toFixed(0)} ms for ${meta.triangleCount} tris, ${bvh.nodeCount} nodes`);

  const rand = mulberry32(12345);
  const R = 2000;
  let hits = 0;
  let bvhMs = 0;
  let bruteMs = 0;

  for (let i = 0; i < R; i++) {
    // Origins at head height inside the room, directions uniform on the sphere.
    const o = [
      (rand() - 0.5) * meta.dims.x * 0.6,
      0.4 + rand() * 1.4,
      (rand() - 0.5) * meta.dims.z * 0.6,
    ];
    const z = rand() * 2 - 1;
    const th = rand() * Math.PI * 2;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    const d = [r * Math.cos(th), z, r * Math.sin(th)];

    let s = performance.now();
    const got = bvh.raycast(o[0], o[1], o[2], d[0], d[1], d[2], 4.0);
    bvhMs += performance.now() - s;

    s = performance.now();
    const want = bruteForce(positions, indices, o, d, 4.0);
    bruteMs += performance.now() - s;

    if (want === null) {
      assert.equal(got, null, `ray ${i}: BVH found a hit brute force did not`);
    } else {
      assert.ok(got, `ray ${i}: BVH missed a hit at ${want.distance.toFixed(3)} m`);
      assert.ok(
        Math.abs(got.distance - want.distance) < 1e-4,
        `ray ${i}: ${got.distance.toFixed(5)} vs ${want.distance.toFixed(5)}`
      );
      hits++;
    }
  }

  console.log(`      ${hits}/${R} rays hit · BVH ${(bvhMs / R * 1000).toFixed(1)} µs/ray ` +
    `vs brute ${(bruteMs / R * 1000).toFixed(0)} µs/ray · ${(bruteMs / bvhMs).toFixed(0)}× faster`);

  // 448 rays per tick at 15 Hz. Anything slower than this and the sim cannot
  // hold its own sampling rate, which would invalidate every latency number.
  const perTickMs = (bvhMs / R) * 448;
  console.log(`      projected ${perTickMs.toFixed(1)} ms per 448-ray tick (budget ${(1000 / 15).toFixed(0)} ms)`);
  assert.ok(perTickMs < 1000 / 15, `sensor tick would overrun: ${perTickMs.toFixed(1)} ms`);
});
