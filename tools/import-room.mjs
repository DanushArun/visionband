/**
 * Converts a Wavefront OBJ room scan into the compact binary the simulator
 * raycasts against.
 *
 *   node --max-old-space-size=6144 tools/import-room.mjs <Room.obj> [--cell 0.02] [--out sim/rooms/room]
 *
 * Why not just load the OBJ in three.js:
 *  - 1.7M triangles through three.js's brute-force Raycaster is ~750M triangle
 *    tests per sensor tick. The simulator needs its own BVH, which wants flat
 *    typed arrays, not Mesh objects.
 *  - The file carries one white material and C4D default object names
 *    ("Würfel", "Zylinder"), so surface reflectivity — the property the ToF
 *    dropout model actually consumes — must be inferred from geometry, offline.
 *  - Winding is inconsistent in this export, so face normals cannot be trusted
 *    for direction. Everything here uses |n·y|, and the simulator uses |n·ray|.
 */
import { createReadStream, writeFileSync, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, resolve } from 'node:path';

const args = process.argv.slice(2);
const src = args[0];
if (!src) {
  console.error('usage: node tools/import-room.mjs <Room.obj> [--cell 0.02] [--out sim/rooms/room]');
  process.exit(1);
}
const argVal = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const CELL = Number(argVal('cell', 0.02));  // vertex-clustering grid, metres
const UNIT = Number(argVal('unit', 0.01));  // source units → metres (C4D exports cm)
const OUT = resolve(argVal('out', 'sim/rooms/room'));

/** Reflectivity is the only surface property the ToF dropout model needs. */
const CLASSES = [
  { name: 'floor', reflectivity: 0.55 },
  { name: 'ceiling', reflectivity: 0.70 },
  { name: 'wall', reflectivity: 0.85 },
  { name: 'furniture', reflectivity: 0.40 },
];
const FLOOR = 0, CEILING = 1, WALL = 2, FURNITURE = 3;

// ---------------------------------------------------------------- parse
console.log(`reading ${src}`);
const V = [];
const T = [];
const rl = createInterface({ input: createReadStream(src), crlfDelay: Infinity });
for await (const line of rl) {
  const c0 = line.charCodeAt(0);
  if (c0 === 118 && line.charCodeAt(1) === 32) {
    const p = line.split(/\s+/);
    V.push(+p[1], +p[2], +p[3]);
  } else if (c0 === 102 && line.charCodeAt(1) === 32) {
    const p = line.split(/\s+/);
    const n = p.length - 1;
    const ix = new Array(n);
    for (let i = 0; i < n; i++) {
      const v = parseInt(p[i + 1], 10);
      ix[i] = v > 0 ? v - 1 : V.length / 3 + v;
    }
    // C4D quads are planar and convex, so a fan is safe.
    for (let i = 1; i < n - 1; i++) T.push(ix[0], ix[i], ix[i + 1]);
  }
}
const triCount = T.length / 3;
console.log(`parsed ${V.length / 3} verts, ${triCount} triangles`);

// ---------------------------------------------------------------- geometry stats
let minX = Infinity, minY = Infinity, minZ = Infinity;
let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
for (let i = 0; i < V.length; i += 3) {
  if (V[i] < minX) minX = V[i]; if (V[i] > maxX) maxX = V[i];
  if (V[i + 1] < minY) minY = V[i + 1]; if (V[i + 1] > maxY) maxY = V[i + 1];
  if (V[i + 2] < minZ) minZ = V[i + 2]; if (V[i + 2] > maxZ) maxZ = V[i + 2];
}

/**
 * Locate the floor and ceiling by area.
 *
 * Not by minY: this model has ~2 m of geometry hanging below the floor slab, so
 * "lowest vertex" put the walker underground. Not by normal direction either,
 * since the export's winding is reversed — the floor reports as downward-facing.
 * The robust signal is area: a room's two largest horizontal surfaces are its
 * floor and its ceiling, and the lower of the two is the floor.
 */
const BINS = 1024;
const ySpan = maxY - minY;
const band = new Float64Array(BINS);
const triArea = new Float32Array(triCount);
const triNy = new Float32Array(triCount);
const triMidY = new Float32Array(triCount);

for (let t = 0; t < triCount; t++) {
  const a = T[t * 3] * 3, b = T[t * 3 + 1] * 3, c = T[t * 3 + 2] * 3;
  const ux = V[b] - V[a], uy = V[b + 1] - V[a + 1], uz = V[b + 2] - V[a + 2];
  const vx = V[c] - V[a], vy = V[c + 1] - V[a + 1], vz = V[c + 2] - V[a + 2];
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz);
  const area = len / 2;
  triArea[t] = area;
  if (!(len > 0)) continue;
  const absNy = Math.abs(ny / len);
  triNy[t] = absNy;
  const my = (V[a + 1] + V[b + 1] + V[c + 1]) / 3;
  triMidY[t] = my;
  if (absNy > 0.85) {
    let bin = Math.floor(((my - minY) / ySpan) * (BINS - 1));
    if (bin < 0) bin = 0; else if (bin > BINS - 1) bin = BINS - 1;
    band[bin] += area;
  }
}

const binY = (i) => minY + (ySpan * i) / (BINS - 1);
const ranked = [...band.keys()].sort((i, j) => band[j] - band[i]);
const best = ranked[0];
// The partner slab: the next big band at least 1.8 m away vertically.
const minSep = 1.8 / UNIT;
const partner = ranked.find((i) => Math.abs(binY(i) - binY(best)) > minSep);
if (partner === undefined) {
  console.error('could not find a second horizontal slab — is this a closed room?');
  process.exit(1);
}
const floorRaw = Math.min(binY(best), binY(partner));
const ceilRaw = Math.max(binY(best), binY(partner));
const ceilingH = (ceilRaw - floorRaw) * UNIT;
console.log(
  `floor y=${floorRaw.toFixed(1)} (${(band[best] / 10000).toFixed(1)} m²), ` +
  `ceiling y=${ceilRaw.toFixed(1)} → ${ceilingH.toFixed(2)} m headroom`
);

// ---------------------------------------------------------------- transform
// Metres, floor at y=0, centred on the floor plane. The rig walks at a fixed
// height, so "floor at zero" has to be exactly true.
const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
const P = new Float32Array(V.length);
for (let i = 0; i < V.length; i += 3) {
  P[i] = (V[i] - cx) * UNIT;
  P[i + 1] = (V[i + 1] - floorRaw) * UNIT;
  P[i + 2] = (V[i + 2] - cz) * UNIT;
}
const dims = { x: (maxX - minX) * UNIT, y: ceilingH, z: (maxZ - minZ) * UNIT };
console.log(`room ${dims.x.toFixed(2)} × ${dims.y.toFixed(2)} × ${dims.z.toFixed(2)} m`);

// ---------------------------------------------------------------- cull + decimate
// Vertex clustering: snap to a grid, drop triangles whose corners collapse.
// Crude beside quadric simplification, but it keeps silhouettes and bulk
// occlusion — all the ToF model can resolve anyway, since one 8x8 zone subtends
// ~55 cm at 4 m.
const gx = Math.ceil(dims.x / CELL) + 2;
const gy = Math.ceil((dims.y + 1) / CELL) + 2;
const cellMap = new Map();
const outPosArr = [];
const outIdx = [];
const keptTri = [];
let culledBelow = 0;

const cellIndex = (i) => {
  const ix = Math.round((P[i] + dims.x / 2) / CELL);
  const iy = Math.round((P[i + 1] + 0.5) / CELL);
  const iz = Math.round((P[i + 2] + dims.z / 2) / CELL);
  const key = (iz * gy + iy) * gx + ix;
  let t = cellMap.get(key);
  if (t === undefined) {
    t = outPosArr.length / 3;
    cellMap.set(key, t);
    outPosArr.push(P[i], P[i + 1], P[i + 2]);
  }
  return t;
};

for (let t = 0; t < triCount; t++) {
  const a = T[t * 3] * 3, b = T[t * 3 + 1] * 3, c = T[t * 3 + 2] * 3;
  // Anything wholly beneath the floor slab is not part of the room the walker
  // occupies; keeping it would put phantom returns under the feet.
  if (P[a + 1] < -0.05 && P[b + 1] < -0.05 && P[c + 1] < -0.05) { culledBelow++; continue; }
  const ia = cellIndex(a), ib = cellIndex(b), ic = cellIndex(c);
  if (ia === ib || ib === ic || ia === ic) continue;
  outIdx.push(ia, ib, ic);
  keptTri.push(t);
}
const outPos = new Float32Array(outPosArr);
console.log(
  `culled ${culledBelow} tris below floor; ` +
  `decimated at ${(CELL * 100).toFixed(1)} cm → ${outPos.length / 3} verts, ` +
  `${outIdx.length / 3} tris (${(100 - (outIdx.length / T.length) * 100).toFixed(1)}% reduction)`
);

// ---------------------------------------------------------------- classify
const nTri = outIdx.length / 3;
const cls = new Uint8Array(nTri);
const areaByClass = new Float64Array(CLASSES.length);
const EDGE = 0.45;

const mid = (n) => {
  const a = outIdx[n * 3] * 3, b = outIdx[n * 3 + 1] * 3, c = outIdx[n * 3 + 2] * 3;
  return [
    (outPos[a] + outPos[b] + outPos[c]) / 3,
    (outPos[a + 1] + outPos[b + 1] + outPos[c + 1]) / 3,
    (outPos[a + 2] + outPos[b + 2] + outPos[c + 2]) / 3,
  ];
};

// Pass 1 — floor, and from it the room's actual footprint.
// The bounding box is no use for finding walls here: the ceiling slab overhangs
// and the floor plane runs past the walls, so the walls sit well inside the box.
// The floor's own extent is the room's true envelope.
let fx0 = Infinity, fx1 = -Infinity, fz0 = Infinity, fz1 = -Infinity;
for (let n = 0; n < nTri; n++) {
  const src = keptTri[n];
  const [mx, , mz] = mid(n);
  const y = (triMidY[src] - floorRaw) * UNIT;
  if (triNy[src] > 0.85 && y < 0.12) {
    cls[n] = FLOOR;
    if (mx < fx0) fx0 = mx; if (mx > fx1) fx1 = mx;
    if (mz < fz0) fz0 = mz; if (mz > fz1) fz1 = mz;
  } else {
    cls[n] = 255; // undecided
  }
}
console.log(`floor footprint ${(fx1 - fx0).toFixed(2)} × ${(fz1 - fz0).toFixed(2)} m`);

// Pass 2 — ceiling, then walls against the footprint, then everything else.
for (let n = 0; n < nTri; n++) {
  if (cls[n] !== 255) continue;
  const src = keptTri[n];
  const [mx, , mz] = mid(n);
  const y = (triMidY[src] - floorRaw) * UNIT;
  const horizontal = triNy[src] > 0.85;
  const vertical = triNy[src] < 0.35;
  const atEdge = mx < fx0 + EDGE || mx > fx1 - EDGE || mz < fz0 + EDGE || mz > fz1 - EDGE;

  if (horizontal && y > ceilingH - 0.25) cls[n] = CEILING;
  else if (vertical && atEdge && y > 0.1) cls[n] = WALL;
  else cls[n] = FURNITURE;
}

// Report by area, not triangle count: a flat 40 m² ceiling decimates to a
// handful of triangles, so counts would say it is negligible when it is not.
for (let n = 0; n < nTri; n++) {
  const a = outIdx[n * 3] * 3, b = outIdx[n * 3 + 1] * 3, c = outIdx[n * 3 + 2] * 3;
  const ux = outPos[b] - outPos[a], uy = outPos[b + 1] - outPos[a + 1], uz = outPos[b + 2] - outPos[a + 2];
  const vx = outPos[c] - outPos[a], vy = outPos[c + 1] - outPos[a + 1], vz = outPos[c + 2] - outPos[a + 2];
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  areaByClass[cls[n]] += Math.hypot(nx, ny, nz) / 2;
}
const totalArea = areaByClass.reduce((a, b) => a + b, 0);
console.log('classes by area: ' + CLASSES.map((c, i) =>
  `${c.name} ${areaByClass[i].toFixed(1)} m² (${((areaByClass[i] / totalArea) * 100).toFixed(0)}%)`).join(', '));

// ---------------------------------------------------------------- write
mkdirSync(dirname(OUT), { recursive: true });
const use32 = outPos.length / 3 > 65535;
const idx = use32 ? new Uint32Array(outIdx) : new Uint16Array(outIdx);
const bin = Buffer.concat([
  Buffer.from(outPos.buffer, outPos.byteOffset, outPos.byteLength),
  Buffer.from(idx.buffer, idx.byteOffset, idx.byteLength),
  Buffer.from(cls.buffer, cls.byteOffset, cls.byteLength),
]);
writeFileSync(`${OUT}.bin`, bin);

writeFileSync(`${OUT}.json`, `${JSON.stringify({
  source: src.split('/').pop(),
  vertexCount: outPos.length / 3,
  triangleCount: idx.length / 3,
  indexType: use32 ? 'Uint32' : 'Uint16',
  cellSize: CELL,
  dims,
  ceilingHeight: ceilingH,
  classes: CLASSES,
  // Byte layout, in order, so the loader needs no parser.
  layout: [
    { name: 'positions', type: 'Float32', count: outPos.length },
    { name: 'indices', type: use32 ? 'Uint32' : 'Uint16', count: idx.length },
    { name: 'triangleClass', type: 'Uint8', count: cls.length },
  ],
}, null, 2)}\n`);

console.log(`\nwrote ${OUT}.bin  ${(bin.length / 1024 / 1024).toFixed(2)} MB`);
console.log(`wrote ${OUT}.json`);
