/**
 * Loads an imported room scan (tools/import-room.mjs output) into a World.
 *
 * The binary is three concatenated blocks — positions, indices, per-triangle
 * class — described by the sidecar JSON. No parser, no format library: the
 * loader is a few typed-array views over one ArrayBuffer.
 */

import { BVH } from './bvh.js';
import { World } from './world.js';

/** Display colours per class. Deliberately flat and unlit — this panel is a
 *  reference for "what is really there", not a render. */
const CLASS_COLOR = [
  0x5d5a54, // floor
  0x46454a, // ceiling
  0x8a857c, // wall
  0xa86f52, // furniture
];

export function decodeRoom(buffer, meta) {
  const IndexArray = meta.indexType === 'Uint32' ? Uint32Array : Uint16Array;
  let off = 0;

  const positions = new Float32Array(buffer, off, meta.vertexCount * 3);
  off += positions.byteLength;

  const indices = new IndexArray(buffer, off, meta.triangleCount * 3);
  off += indices.byteLength;

  const triClass = new Uint8Array(buffer, off, meta.triangleCount);
  off += triClass.byteLength;

  if (off !== buffer.byteLength) {
    console.warn(`room binary: read ${off} of ${buffer.byteLength} bytes — metadata may be stale`);
  }
  return { positions, indices, triClass };
}

export function buildRoomWorld(buffer, meta) {
  const { positions, indices, triClass } = decodeRoom(buffer, meta);

  const triRefl = new Float32Array(meta.triangleCount);
  const triLabel = new Array(meta.triangleCount);
  for (let t = 0; t < meta.triangleCount; t++) {
    const c = meta.classes[triClass[t]];
    triRefl[t] = c.reflectivity;
    triLabel[t] = c.name;
  }

  const t0 = performance.now();
  // The BVH indexes only static geometry, so it is built once and reused for
  // every tick and every sensor configuration.
  const bvh = new BVH(positions, indices);
  const buildMs = performance.now() - t0;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0e0e11);
  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  const key = new THREE.DirectionalLight(0xffffff, 0.7);
  key.position.set(3, 6, 2);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0x88aaff, 0.28);
  fill.position.set(-4, 2, -5);
  scene.add(fill);

  // One mesh, vertex-coloured by class, rather than four meshes — the classes
  // interleave triangle-by-triangle after decimation.
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));

  const colors = new Float32Array(meta.vertexCount * 3);
  const col = new THREE.Color();
  for (let t = 0; t < meta.triangleCount; t++) {
    col.setHex(CLASS_COLOR[triClass[t]] ?? 0x808080);
    for (let k = 0; k < 3; k++) {
      const v = indices[t * 3 + k] * 3;
      colors[v] = col.r; colors[v + 1] = col.g; colors[v + 2] = col.b;
    }
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();

  scene.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.9,
    metalness: 0.02,
    // The scan's winding is inconsistent; single-sided would punch holes in walls.
    side: THREE.DoubleSide,
  })));

  // A person-sized mover on a fixed path, so runs are comparable and the
  // reconstruction has something non-static to smear or track.
  const person = new THREE.Group();
  const cloth = { reflectivity: 0.4, label: 'person' };
  const mk = (geoP, y) => {
    const m = new THREE.Mesh(geoP, new THREE.MeshStandardMaterial({ color: 0xb06a4a, roughness: 0.9 }));
    m.position.y = y;
    Object.assign(m.userData, cloth);
    person.add(m);
    return m;
  };
  const dynamic = [
    mk(new THREE.CylinderGeometry(0.18, 0.22, 1.0, 12), 1.05),
    mk(new THREE.SphereGeometry(0.12, 12, 10), 1.68),
    mk(new THREE.CylinderGeometry(0.16, 0.14, 0.9, 10), 0.45),
  ];
  scene.add(person);

  // Walk the long axis of the room, staying off the walls.
  const halfZ = meta.dims.z / 2;
  const halfX = meta.dims.x / 2;
  const zNear = -halfZ + 1.2;
  const zFar = halfZ - 1.2;
  const headHeight = Math.min(1.65, meta.ceilingHeight - 0.5);

  return new World({
    name: meta.source || 'room',
    scene,
    bvh,
    triRefl,
    triLabel,
    dynamic,
    headHeight,
    bounds: { x: [-halfX + 0.6, halfX - 0.6], z: [zNear, zFar] },
    path(t) {
      const phase = (Math.sin(t * 0.11 - Math.PI / 2) + 1) / 2;
      return new THREE.Vector3(0, headHeight, zNear + phase * (zFar - zNear));
    },
    update(t) {
      const phase = (Math.sin(t * 0.19) + 1) / 2;
      person.position.set(0.9, 0, zNear + phase * (zFar - zNear));
      person.rotation.y = Math.cos(t * 0.19) > 0 ? Math.PI : 0;
    },
    stats: { buildMs, triangles: meta.triangleCount },
  });
}

/**
 * Fetch the room from sibling files (dev server), or decode an inlined base64
 * payload when the page was bundled into a single file for publishing.
 */
export async function loadRoom(basePath) {
  if (typeof window !== 'undefined' && window.__VISIONBAND_ROOM__) {
    const { meta, base64 } = window.__VISIONBAND_ROOM__;
    return { buffer: base64ToArrayBuffer(base64), meta };
  }
  const [meta, buffer] = await Promise.all([
    fetch(`${basePath}.json`).then((r) => r.json()),
    fetch(`${basePath}.bin`).then((r) => r.arrayBuffer()),
  ]);
  return { buffer, meta };
}

function base64ToArrayBuffer(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}
