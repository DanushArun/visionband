/**
 * The virtual building.
 *
 * Every element exists to test one requirement from docs/00-requirements.md.
 * Nothing decorative — if it's here, something is being measured against it.
 *
 * Metres, Y up, corridor runs along Z. Head forward is +Z.
 */

import { bakeMeshes, World } from './world.js';
import { BVH } from './bvh.js';

const MAT = {
  plaster:  { color: 0x8a8580, reflectivity: 0.85, label: 'wall' },
  concrete: { color: 0x6e6a66, reflectivity: 0.55, label: 'floor' },
  darkStone:{ color: 0x3a3a3e, reflectivity: 0.30, label: 'pillar' },
  steel:    { color: 0x9aa0a8, reflectivity: 0.25, label: 'beam' },
  glass:    { color: 0x7fb8d0, reflectivity: 0.04, label: 'glass' },
  cloth:    { color: 0xb06a4a, reflectivity: 0.40, label: 'person' },
};

export const WORLD = {
  // Far enough back that an orbiting camera stays inside the building rather
  // than looking at the outside of the end wall.
  zStart: -14,
  zEnd: 14,
  halfWidth: 2.2,
  wallHeight: 3.0,
  pitStart: 7.0,
  pitEnd: 9.5,
  pitDepth: 0.45,
  headHeight: 1.65,
};

function makeMesh(geo, spec, opts = {}) {
  const mat = new THREE.MeshStandardMaterial({
    color: spec.color,
    roughness: opts.roughness ?? 0.85,
    metalness: opts.metalness ?? 0.05,
    transparent: !!opts.opacity,
    opacity: opts.opacity ?? 1,
    side: THREE.DoubleSide,
  });
  const m = new THREE.Mesh(geo, mat);
  m.userData.reflectivity = spec.reflectivity;
  m.userData.label = opts.label || spec.label;
  return m;
}

function box(w, h, d, spec, pos, opts) {
  const m = makeMesh(new THREE.BoxGeometry(w, h, d), spec, opts);
  m.position.set(pos[0], pos[1], pos[2]);
  return m;
}

export function buildWorld() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0e0e11);
  scene.add(new THREE.AmbientLight(0xffffff, 0.45));
  const key = new THREE.DirectionalLight(0xffffff, 0.75);
  key.position.set(4, 8, -3);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0x88aaff, 0.3);
  fill.position.set(-5, 3, 6);
  scene.add(fill);

  const W = WORLD;
  const meshes = [];
  const add = (m) => { scene.add(m); meshes.push(m); return m; };

  // ---- Floor, in three pieces so the drop-off is real geometry, not a texture.
  const floorALen = W.pitStart - W.zStart;
  add(box(W.halfWidth * 2, 0.1, floorALen, MAT.concrete, [0, -0.05, W.zStart + floorALen / 2]));

  const pitLen = W.pitEnd - W.pitStart;
  add(box(W.halfWidth * 2, 0.1, pitLen, MAT.concrete,
    [0, -W.pitDepth - 0.05, W.pitStart + pitLen / 2], { label: 'pit floor' }));
  // The riser — the face a ground sensor should catch before a foot does.
  add(box(W.halfWidth * 2, W.pitDepth, 0.08, MAT.concrete,
    [0, -W.pitDepth / 2, W.pitStart], { label: 'drop-off edge' }));

  const floorBLen = W.zEnd - W.pitEnd;
  add(box(W.halfWidth * 2, 0.1, floorBLen, MAT.concrete, [0, -0.05, W.pitEnd + floorBLen / 2]));

  // ---- Left wall, with a glass section. F3/F7: glass returns almost nothing,
  // so the reconstruction should show a hole where a solid wall actually is.
  const segs = [
    [W.zStart, -7.0, MAT.plaster],
    [-7.0, -4.5, MAT.glass],
    [-4.5, W.zEnd, MAT.plaster],
  ];
  for (const [z0, z1, spec] of segs) {
    const len = z1 - z0;
    add(box(0.15, W.wallHeight, len, spec,
      [-W.halfWidth, W.wallHeight / 2, z0 + len / 2],
      spec === MAT.glass ? { opacity: 0.25, roughness: 0.1 } : undefined));
  }

  // ---- Right wall, with a doorway gap. F1: the gap must be findable by ear.
  const doorZ0 = 2.0;
  const doorZ1 = 3.2;
  for (const [z0, z1] of [[W.zStart, doorZ0], [doorZ1, W.zEnd]]) {
    const len = z1 - z0;
    add(box(0.15, W.wallHeight, len, MAT.plaster, [W.halfWidth, W.wallHeight / 2, z0 + len / 2]));
  }

  // ---- End walls
  add(box(W.halfWidth * 2, W.wallHeight, 0.15, MAT.plaster, [0, W.wallHeight / 2, W.zEnd]));
  add(box(W.halfWidth * 2, W.wallHeight, 0.15, MAT.plaster, [0, W.wallHeight / 2, W.zStart]));

  // ---- Pillar. Mid-corridor obstacle at torso height.
  const pillar = makeMesh(new THREE.CylinderGeometry(0.32, 0.32, W.wallHeight, 20), MAT.darkStone);
  pillar.position.set(-0.95, W.wallHeight / 2, 4.5);
  add(pillar);

  // ---- Overhead beam. F5 — the cane's structural blind spot, and the single
  // clearest argument for putting sensors on the head instead of in the hand.
  add(box(W.halfWidth * 2, 0.22, 0.35, MAT.steel, [0, 1.85, -3.0], { label: 'head-height beam' }));

  // ---- The moving object, on a fixed repeatable path so runs are comparable.
  // Kept out of `meshes`: it moves, so it is brute-forced per tick rather than
  // baked into the static BVH.
  const person = new THREE.Group();
  const torso = makeMesh(new THREE.CylinderGeometry(0.18, 0.22, 1.0, 14), MAT.cloth);
  torso.position.y = 1.05;
  const head = makeMesh(new THREE.SphereGeometry(0.12, 14, 14), MAT.cloth);
  head.position.y = 1.68;
  const legs = makeMesh(new THREE.CylinderGeometry(0.16, 0.14, 0.9, 12), MAT.cloth);
  legs.position.y = 0.45;
  person.add(torso, head, legs);
  scene.add(person);

  markHazards(scene);

  const { positions, indices, triRefl, triLabel } = bakeMeshes(meshes);
  const bvh = new BVH(positions, indices);

  return new World({
    name: 'corridor',
    scene,
    bvh,
    triRefl,
    triLabel,
    dynamic: [torso, head, legs],
    headHeight: W.headHeight,
    bounds: { x: [-W.halfWidth + 0.35, W.halfWidth - 0.35], z: [W.zStart + 0.5, W.pitStart - 0.3] },
    path(t) {
      // Deterministic there-and-back, used only when auto-walk is on.
      const phase = (Math.sin(t * 0.11 - Math.PI / 2) + 1) / 2;
      return new THREE.Vector3(0, W.headHeight, -8 + phase * 15);
    },
    update(t) {
      const phase = (Math.sin(t * 0.22) + 1) / 2;
      person.position.set(0.9, 0, 1.2 + phase * 10);
      person.rotation.y = Math.cos(t * 0.22) > 0 ? Math.PI : 0;
    },
  });
}

/** Faint labelled rings over the things the gates ask you to identify. */
function markHazards(scene) {
  const spots = [
    { pos: [2.2, 1.0, 2.6], name: 'doorway', color: 0x6fd08c },
    { pos: [-0.95, 1.0, 4.5], name: 'pillar', color: 0xe0b34f },
    { pos: [0, 0, 7.0], name: 'drop-off', color: 0xe0785f },
    { pos: [0, 1.85, -3.0], name: 'head beam', color: 0xc98fd6 },
    { pos: [-2.2, 1.2, -5.75], name: 'glass', color: 0x7fb8d0 },
  ];
  const group = new THREE.Group();
  for (const s of spots) {
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.42, 0.02, 8, 28),
      new THREE.MeshBasicMaterial({ color: s.color, transparent: true, opacity: 0.75 })
    );
    ring.position.set(...s.pos);
    ring.userData.name = s.name;
    group.add(ring);
  }
  scene.add(group);
  return group;
}

/** The reconstruction panel: black, no lights, only what the sensors returned. */
export function buildReconScene() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x05070a);

  // A faint ground grid purely so the eye has a horizon; it is not sensed data.
  const grid = new THREE.GridHelper(40, 40, 0x143040, 0x0d1c26);
  grid.position.y = 0.001;
  scene.add(grid);

  return scene;
}

/** Marker for where the wearer is, drawn in both panels. */
export function buildRigMarker(color = 0x4fd0e0) {
  const g = new THREE.Group();
  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.11, 16, 16),
    new THREE.MeshBasicMaterial({ color, wireframe: true })
  );
  g.add(head);
  const nose = new THREE.Mesh(
    new THREE.ConeGeometry(0.05, 0.22, 10),
    new THREE.MeshBasicMaterial({ color })
  );
  nose.rotation.x = Math.PI / 2;
  nose.position.z = 0.18;
  g.add(nose);
  return g;
}
