/**
 * M0 simulator — wiring.
 *
 * Loop: move the world → cast rays through the world's BVH → accumulate into
 * the voxel map → collapse to a sector map → encode → render both panels and
 * drive audio.
 */

import { buildWorld } from './scene.js';
import { buildRoomWorld, loadRoom } from './room.js';
import { buildReconScene, buildRigMarker } from './scene.js';
import { SensorRig } from './sensor.js';
import { VoxelMap, buildPointCloud, refreshPointCloud } from './reconstruct.js';
import { SoundscapeEngine } from './audio.js';
import { toSectorMap, encodeAudio, proximity, SECTORS } from '../sonification/encoder.js';
import { classForLabel, LEGEND } from './palette.js';

const SECTOR_NAMES = ['front', 'front-R', 'right', 'back-R', 'back', 'back-L', 'left', 'front-L'];

const canvas = document.getElementById('canvas');
const stage = document.getElementById('stage');
const $ = (id) => document.getElementById(id);

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 200);

const reconScene = buildReconScene();
const voxels = new VoxelMap();
const cloud = buildPointCloud(voxels);
reconScene.add(cloud);

const rigRecon = buildRigMarker(0x4fd0e0);
reconScene.add(rigRecon);
const rigTruth = buildRigMarker(0x4fd0e0);

const rig = new SensorRig({ horizontalCount: 6, groundSensor: true, zones: 24 });
const audio = new SoundscapeEngine();

const worlds = { corridor: buildWorld(), room: null };
let world = worlds.corridor;

const state = {
  t: 0,
  playing: true,
  autoWalk: false,
  showTruth: true,
  nActive: 3,
  headPos: new THREE.Vector3(),
  headYaw: 0,
  sampleAccum: 0,
  lastSampleMs: 0,
  metrics: { cast: 0, ret: 0, drop: 0, voices: 0, nearest: Infinity, nearestSector: 0 },
  sectorMap: { distance: new Array(SECTORS).fill(Infinity), elevation: new Array(SECTORS).fill(0) },
  active: [],
};

// ---------------------------------------------------------------- manual driving
const keys = new Set();
const MOVE_SPEED = 1.4;   // m/s, about walking pace
const TURN_SPEED = 1.9;   // rad/s

window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  keys.add(e.key.toLowerCase());
  // Arrows and space would otherwise scroll or re-trigger the focused button.
  if ([' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(e.key.toLowerCase())) {
    e.preventDefault();
  }
});
window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
window.addEventListener('blur', () => keys.clear());

function drive(dt) {
  const fast = keys.has('shift') ? 2 : 1;
  if (keys.has('arrowleft') || keys.has('q')) state.headYaw -= TURN_SPEED * dt;
  if (keys.has('arrowright') || keys.has('e')) state.headYaw += TURN_SPEED * dt;

  let fwd = 0;
  let strafe = 0;
  if (keys.has('w') || keys.has('arrowup')) fwd += 1;
  if (keys.has('s') || keys.has('arrowdown')) fwd -= 1;
  if (keys.has('a')) strafe -= 1;
  if (keys.has('d')) strafe += 1;
  if (!fwd && !strafe) return;

  const len = Math.hypot(fwd, strafe);
  fwd /= len; strafe /= len;
  const cy = Math.cos(state.headYaw);
  const sy = Math.sin(state.headYaw);
  // Head forward is +Z, so forward is (sin yaw, 0, cos yaw).
  state.headPos.x += (fwd * sy + strafe * cy) * MOVE_SPEED * fast * dt;
  state.headPos.z += (fwd * cy - strafe * sy) * MOVE_SPEED * fast * dt;
  world.clamp(state.headPos);
}

// ---------------------------------------------------------------- camera orbit
const orbit = { az: 0, el: 0.62, dist: 6.4, target: new THREE.Vector3() };

function updateCamera() {
  const { az, el, dist, target } = orbit;
  const ce = Math.cos(el);
  // No ceiling clamp: the truth panel omits the ceiling slab, so looking down
  // into the room from above is the useful view rather than a blocked one.
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
  orbit.dist = Math.max(1.6, Math.min(18, orbit.dist + e.deltaY * 0.005));
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

// ---------------------------------------------------------------- legend
const legendEl = document.getElementById('legend');
for (const item of LEGEND) {
  const row = document.createElement('span');
  row.className = 'legend-item';
  const dot = document.createElement('i');
  dot.style.background = item.css;
  row.append(dot, document.createTextNode(item.name));
  legendEl.append(row);
}

// ---------------------------------------------------------------- scene switch
function useWorld(next, force = false) {
  if (!next || (next === world && !force)) return;
  world.scene.remove(rigTruth);
  world = next;
  world.scene.add(rigTruth);
  world.update(state.t);
  state.headPos.copy(world.findSpawn());
  state.headYaw = 0;
  orbit.target.copy(state.headPos);
  // A closed room reads best looked down into; the open corridor reads best
  // from behind the walker.
  orbit.dist = world.ceilingHeight ? 7.0 : 6.4;
  orbit.el = world.ceilingHeight ? 0.85 : 0.62;
  $('tag-truth').textContent = world.ceilingHeight ? 'Ground truth · ceiling hidden' : 'Ground truth';
  voxels.clear();
  $('m-scene').textContent = world.name;
  $('m-tris').textContent = (world.stats.triangles ?? world.bvh.triCount).toLocaleString();
}

// ---------------------------------------------------------------- controls
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
$('sel-scene').addEventListener('change', (e) => {
  useWorld(e.target.value === 'room' ? worlds.room : worlds.corridor);
});
$('sel-sensors').addEventListener('change', (e) => {
  rig.configure(Number(e.target.value), $('chk-ground').checked, rig.zones);
  voxels.clear();
});
$('chk-ground').addEventListener('change', (e) => {
  rig.configure(rig.horizontalCount, e.target.checked, rig.zones);
  voxels.clear();
});
$('sel-zones').addEventListener('change', (e) => {
  rig.configure(rig.horizontalCount, $('chk-ground').checked, Number(e.target.value));
  voxels.clear();
});
$('chk-auto').addEventListener('change', (e) => { state.autoWalk = e.target.checked; });
$('chk-truth').addEventListener('change', (e) => {
  state.showTruth = e.target.checked;
  $('divider').style.display = state.showTruth ? '' : 'none';
  $('tag-truth').style.display = state.showTruth ? '' : 'none';
  $('tag-recon').classList.toggle('full', !state.showTruth);
});
$('rng-active').addEventListener('input', (e) => {
  state.nActive = Number(e.target.value);
  $('val-active').textContent = e.target.value;
});
$('rng-vol').addEventListener('input', (e) => audio.setMasterGain(e.target.value / 200));

// ---------------------------------------------------------------- loop
const clock = new THREE.Clock();

function sample() {
  const t0 = performance.now();
  const { returns, cast, hit, dropped, rays, rayCount } = rig.sample(world, state.headPos, state.headYaw);

  // Carve first, then write hits. The other order would erase the returns this
  // very tick produced, since neighbouring rays pass close by a surface.
  const { x: ox, y: oy, z: oz } = state.headPos;
  for (let i = 0; i < rayCount; i++) {
    const o = i * 4;
    const d = rays[o + 3];
    // Negative distance marks a ray that returned nothing — ambiguous, so it
    // erodes the map only weakly. See VoxelMap.missWeak.
    voxels.carve(ox, oy, oz, rays[o], rays[o + 1], rays[o + 2], Math.abs(d), d < 0);
  }
  for (const r of returns) voxels.add(r.worldPoint, classForLabel(r.label));
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
  state.lastSampleMs = performance.now() - t0;
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
  $('m-scan').textContent = `${state.lastSampleMs.toFixed(1)} ms`;
  $('row-scan').classList.toggle('warn', state.lastSampleMs > 1000 / rig.rateHz);
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
    col.classList.toggle('gated', p > 0.02 && !activeSet.has(k));
    fill.style.background = p > 0.02
      ? `rgb(${Math.round(90 + p * 150)},${Math.round(70 + p * 90)},${Math.round(140 + p * 70)})`
      : '#2a2833';
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

  if (state.autoWalk) {
    state.headPos.copy(world.path(t));
    state.headYaw = Math.sin(t * 0.55) * 0.75;
  } else if (state.playing) {
    drive(dt);
  }

  rigTruth.position.copy(state.headPos);
  rigTruth.rotation.y = state.headYaw;
  rigRecon.position.copy(state.headPos);
  rigRecon.rotation.y = state.headYaw;

  orbit.target.lerp(state.headPos, 0.1);
  updateCamera();

  // The real sensor tops out near 15 Hz at 8x8; the sim is rate-limited to
  // match, because latency is a requirement (N1) and free frames would flatter it.
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

// ---------------------------------------------------------------- boot
useWorld(worlds.corridor, true);
updateCamera();
resize();
frame();

// The scanned room is ~1.3 MB and needs a BVH built over 104k triangles, so it
// loads in the background — the corridor is usable immediately.
loadRoom('./rooms/livingroom')
  .then(({ buffer, meta }) => {
    worlds.room = buildRoomWorld(buffer, meta);
    const opt = $('opt-room');
    opt.disabled = false;
    opt.textContent = `Living room (${(meta.triangleCount / 1000).toFixed(0)}k tris)`;
    // #room opens straight into the scan — handy for repeat trials, and the
    // only way to preselect a scene in a headless render.
    if (location.hash === '#room') {
      $('sel-scene').value = 'room';
      useWorld(worlds.room);
    }
  })
  .catch((err) => {
    console.warn('room unavailable:', err);
    $('opt-room').textContent = 'Living room (unavailable)';
  });
