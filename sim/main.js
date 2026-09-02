/**
 * M0 simulator — wiring.
 *
 * Loop: move the world → cast rays → accumulate into the voxel map →
 * collapse to a sector map → encode → render both panels and drive audio.
 */

import { buildWorld, buildReconScene, buildRigMarker, WORLD } from './scene.js';
import { SensorRig } from './sensor.js';
import { VoxelMap, buildPointCloud, refreshPointCloud } from './reconstruct.js';
import { SoundscapeEngine } from './audio.js';
import { toSectorMap, encodeAudio, proximity, SECTORS } from '../sonification/encoder.js';

const SECTOR_NAMES = ['front', 'front-R', 'right', 'back-R', 'back', 'back-L', 'left', 'front-L'];

const canvas = document.getElementById('canvas');
const stage = document.getElementById('stage');

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 200);

const world = buildWorld();
const reconScene = buildReconScene();

const voxels = new VoxelMap();
const cloud = buildPointCloud(voxels);
reconScene.add(cloud);

// The wearer, drawn in both panels so the two views are spatially comparable.
const rigTruth = buildRigMarker(0x4fd0e0);
const rigRecon = buildRigMarker(0x4fd0e0);
world.scene.add(rigTruth);
reconScene.add(rigRecon);

const rig = new SensorRig({ horizontalCount: 6, groundSensor: true });
const raycaster = new THREE.Raycaster();
const audio = new SoundscapeEngine();

const state = {
  t: 0,
  playing: true,
  autoScan: true,
  showTruth: true,
  nActive: 3,
  headPos: new THREE.Vector3(0, WORLD.headHeight, -9),
  headYaw: 0,
  sampleAccum: 0,
  metrics: { cast: 0, ret: 0, drop: 0, voices: 0, nearest: Infinity, nearestSector: 0 },
  sectorMap: { distance: new Array(SECTORS).fill(Infinity), elevation: new Array(SECTORS).fill(0) },
  active: [],
};

// ---------------------------------------------------------------- camera orbit
// Elevated and behind, looking down into the corridor. The walls are 3 m and
// there is no ceiling, so a high camera sees in; a low one just sees the
// outside of the end wall.
const orbit = { az: 0, el: 0.72, dist: 7.0, target: new THREE.Vector3(0, 1.2, -8) };

function updateCamera() {
  const { az, el, dist, target } = orbit;
  const ce = Math.cos(el);
  camera.position.set(
    target.x + Math.sin(az) * ce * dist,
    target.y + Math.sin(el) * dist,
    target.z - Math.cos(az) * ce * dist
  );
  camera.lookAt(target);
}

let dragging = false;
let px = 0;
let py = 0;
stage.addEventListener('pointerdown', (e) => {
  dragging = true; px = e.clientX; py = e.clientY; stage.classList.add('dragging');
});
window.addEventListener('pointerup', () => { dragging = false; stage.classList.remove('dragging'); });
window.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  orbit.az -= (e.clientX - px) * 0.006;
  orbit.el = Math.max(0.12, Math.min(1.35, orbit.el + (e.clientY - py) * 0.005));
  px = e.clientX; py = e.clientY;
});
stage.addEventListener('wheel', (e) => {
  e.preventDefault();
  orbit.dist = Math.max(2.2, Math.min(18, orbit.dist + e.deltaY * 0.005));
}, { passive: false });

// ---------------------------------------------------------------- bars
const barsEl = document.getElementById('bars');
const barCols = [];
for (let k = 0; k < SECTORS; k++) {
  const col = document.createElement('div');
  col.className = 'bar-col';
  const fill = document.createElement('div');
  fill.className = 'bar-fill';
  const label = document.createElement('div');
  label.className = 'bar-label';
  label.textContent = SECTOR_NAMES[k];
  col.append(fill, label);
  barsEl.append(col);
  barCols.push({ col, fill });
}

// ---------------------------------------------------------------- controls
const $ = (id) => document.getElementById(id);

$('btn-audio').addEventListener('click', async (e) => {
  if (audio.running) {
    audio.stop();
    e.target.textContent = 'Enable sound';
    e.target.classList.add('primary');
  } else {
    await audio.start();
    audio.setMasterGain($('rng-vol').value / 200);
    e.target.textContent = 'Mute';
    e.target.classList.remove('primary');
  }
});
$('btn-play').addEventListener('click', (e) => {
  state.playing = !state.playing;
  e.target.textContent = state.playing ? 'Pause' : 'Play';
});
$('btn-reset').addEventListener('click', () => voxels.clear());
$('sel-sensors').addEventListener('change', (e) => {
  rig.configure(Number(e.target.value), $('chk-ground').checked);
  voxels.clear();
});
$('chk-ground').addEventListener('change', (e) => {
  rig.configure(rig.horizontalCount, e.target.checked);
  voxels.clear();
});
$('chk-scan').addEventListener('change', (e) => { state.autoScan = e.target.checked; });
$('chk-truth').addEventListener('change', (e) => {
  state.showTruth = e.target.checked;
  document.getElementById('divider').style.display = state.showTruth ? '' : 'none';
  document.getElementById('tag-truth').style.display = state.showTruth ? '' : 'none';
  document.getElementById('tag-recon').classList.toggle('full', !state.showTruth);
});
$('rng-active').addEventListener('input', (e) => {
  state.nActive = Number(e.target.value);
  $('val-active').textContent = e.target.value;
});
$('rng-vol').addEventListener('input', (e) => audio.setMasterGain(e.target.value / 200));

// ---------------------------------------------------------------- loop
const clock = new THREE.Clock();

function walk(t) {
  // Deterministic there-and-back along the corridor, so every run is comparable.
  // Ends at the drop-off edge (z = 7) rather than short of it — F6 is the point.
  const phase = (Math.sin(t * 0.11 - Math.PI / 2) + 1) / 2;
  return -8 + phase * 15;
}

function sample() {
  // Raycasting reads matrixWorld, and three.js only refreshes it during render.
  // Without this the moving object is sampled a frame stale — and on the very
  // first tick, at the origin.
  world.scene.updateMatrixWorld(true);

  const { returns, cast, hit, dropped } = rig.sample(
    raycaster, world.meshes, state.headPos, state.headYaw
  );

  for (const r of returns) voxels.add(r.worldPoint);
  voxels.step();
  refreshPointCloud(cloud, voxels);

  state.sectorMap = toSectorMap(returns);
  state.active = encodeAudio(state.sectorMap, { nActive: state.nActive });
  audio.update(state.active);

  let nearest = Infinity;
  let nearestSector = 0;
  for (let k = 0; k < SECTORS; k++) {
    if (state.sectorMap.distance[k] < nearest) {
      nearest = state.sectorMap.distance[k];
      nearestSector = k;
    }
  }
  Object.assign(state.metrics, {
    cast, ret: returns.length, drop: hit > 0 ? dropped / hit : 0,
    voices: state.active.length, nearest, nearestSector,
  });
}

function updateHUD() {
  const m = state.metrics;
  $('m-cast').textContent = m.cast;
  $('m-ret').textContent = m.ret;
  $('m-drop').textContent = `${(m.drop * 100).toFixed(0)}%`;
  $('m-cov').textContent = `${(rig.coverage() * 100).toFixed(0)}%`;

  const gap = rig.worstGapDeg();
  $('m-gap').textContent = gap > 0.5 ? `${gap.toFixed(0)}°` : 'none';
  $('row-gap').classList.toggle('warn', gap > 15); // requirement F3
  $('m-vox').textContent = voxels.count.toLocaleString();
  $('m-voice').textContent = m.voices;
  $('m-near').textContent = Number.isFinite(m.nearest)
    ? `${m.nearest.toFixed(2)} m ${SECTOR_NAMES[m.nearestSector]}`
    : '—';

  const activeSet = new Set(state.active.map((v) => v.sector));
  for (let k = 0; k < SECTORS; k++) {
    const p = proximity(state.sectorMap.distance[k]);
    const { col, fill } = barCols[k];
    fill.style.height = `${3 + p * 97}%`;
    const gated = p > 0.02 && !activeSet.has(k);
    col.classList.toggle('gated', gated);
    const i = Math.round(90 + p * 150);
    fill.style.background = p > 0.02 ? `rgb(${i},${Math.round(70 + p * 90)},${Math.round(140 + p * 70)})` : '#2a2833';
  }
}

let lastW = 0;
let lastH = 0;
function resize() {
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  if (w === lastW && h === lastH) return;
  lastW = w; lastH = h;
  renderer.setSize(w, h, false);
}
window.addEventListener('resize', resize);

function render() {
  const w = stage.clientWidth;
  const h = stage.clientHeight;

  if (!state.showTruth) {
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.render(reconScene, camera);
    return;
  }

  const half = Math.floor(w / 2);
  camera.aspect = half / h;
  camera.updateProjectionMatrix();
  renderer.setScissorTest(true);

  renderer.setViewport(0, 0, half, h);
  renderer.setScissor(0, 0, half, h);
  renderer.render(world.scene, camera);

  renderer.setViewport(half, 0, w - half, h);
  renderer.setScissor(half, 0, w - half, h);
  renderer.render(reconScene, camera);
}

function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, clock.getDelta());
  if (state.playing) state.t += dt;
  const t = state.t;

  world.update(t);
  state.headPos.set(0, WORLD.headHeight, walk(t));
  state.headYaw = state.autoScan ? Math.sin(t * 0.55) * 0.75 : 0;

  rigTruth.position.copy(state.headPos);
  rigTruth.rotation.y = state.headYaw;
  rigRecon.position.copy(state.headPos);
  rigRecon.rotation.y = state.headYaw;

  orbit.target.lerp(new THREE.Vector3(0, 1.2, state.headPos.z), 0.08);
  updateCamera();

  // The real sensor tops out near 15 Hz at 8×8; the sim is rate-limited to match,
  // because feedback latency is a requirement (N1) and free frames would flatter it.
  state.sampleAccum += dt;
  const period = 1 / rig.rateHz;
  if (state.sampleAccum >= period) {
    state.sampleAccum %= period;
    sample();
    updateHUD();
  }

  resize();
  render();
}

updateCamera();
resize();
frame();
