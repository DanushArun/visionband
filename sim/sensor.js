/**
 * Ray-bundle model of a multizone time-of-flight sensor (VL53L5CX-shaped).
 *
 * A perfect sensor proves nothing, so this deliberately models the ways ToF
 * fails: finite range, distance-dependent noise, and dropout on dark, specular
 * and grazing-angle surfaces. See ADR 0001 for the effects it still cannot model.
 *
 * Convention: head forward is +Z, Y is up, metres.
 */

const _origin = new THREE.Vector3();
const _dir = new THREE.Vector3();

export class ToFSensor {
  /**
   * @param {object} cfg
   * @param {number} cfg.yaw    mount yaw about Y, radians, 0 = head forward
   * @param {number} cfg.pitch  mount pitch, radians, negative = aimed at the ground
   * @param {number} cfg.zones  zones per axis (8 → 8x8 = 64 rays)
   * @param {number} cfg.fov    total field of view, radians
   */
  constructor({ id, yaw = 0, pitch = 0, zones = 8, fov = (63 * Math.PI) / 180, maxRange = 4.0 }) {
    this.id = id;
    this.yaw = yaw;
    this.pitch = pitch;
    this.zones = zones;
    this.fov = fov;
    this.maxRange = maxRange;
    this.dirs = this._buildZoneDirections();
  }

  /**
   * Pinhole-style zone grid: equal angular steps across the FOV on both axes,
   * matching how a VL53L5CX lays out its 8x8 SPAD zones.
   * Directions are head-relative (mount rotation applied, head rotation not).
   */
  _buildZoneDirections() {
    const dirs = [];
    const half = this.fov / 2;
    const cy = Math.cos(this.yaw);
    const sy = Math.sin(this.yaw);
    const cp = Math.cos(this.pitch);
    const sp = Math.sin(this.pitch);

    for (let iy = 0; iy < this.zones; iy++) {
      for (let ix = 0; ix < this.zones; ix++) {
        const ax = -half + ((ix + 0.5) / this.zones) * this.fov;
        const ay = -half + ((iy + 0.5) / this.zones) * this.fov;
        // Sensor-local, looking down +Z
        const x = Math.tan(ax);
        const y = Math.tan(ay);
        const z = 1;
        // Pitch about X. Signed so that negative pitch aims at the floor:
        // (0,0,1) with pitch −35° must give a downward y, not an upward one.
        const y1 = y * cp + z * sp;
        const z1 = -y * sp + z * cp;
        // yaw about Y
        const x2 = x * cy + z1 * sy;
        const z2 = -x * sy + z1 * cy;

        const v = new THREE.Vector3(x2, y1, z2).normalize();
        dirs.push({ v, ix, iy });
      }
    }
    return dirs;
  }
}

export class SensorRig {
  constructor({ horizontalCount = 4, groundSensor = true, maxRange = 4.0, rateHz = 15 } = {}) {
    this.maxRange = maxRange;
    this.rateHz = rateHz; // VL53L5CX tops out near 15 Hz at 8x8 — a real constraint
    this.configure(horizontalCount, groundSensor);
  }

  configure(horizontalCount, groundSensor) {
    this.horizontalCount = horizontalCount;
    this.groundSensor = groundSensor;
    this.sensors = [];
    for (let i = 0; i < horizontalCount; i++) {
      this.sensors.push(
        new ToFSensor({
          id: `h${i}`,
          yaw: (i * Math.PI * 2) / horizontalCount,
          maxRange: this.maxRange,
        })
      );
    }
    if (groundSensor) {
      // Aimed down and forward. Without this a drop-off is simply invisible:
      // horizontal sensors see nothing where the floor stops, and "no return"
      // is indistinguishable from open space.
      this.sensors.push(
        new ToFSensor({ id: 'ground', yaw: 0, pitch: (-35 * Math.PI) / 180, maxRange: this.maxRange })
      );
    }
  }

  /**
   * Angular width a sensor actually *samples*, in degrees.
   * Not the nominal FOV: an 8x8 grid samples zone centres, so the outermost ray
   * sits half a zone inside the cone edge. Quoting the nominal 63° would make
   * the coverage numbers flattering by ~8°, which is exactly the kind of
   * optimism this simulator exists to avoid.
   */
  effectiveFovDeg() {
    const s = this.sensors[0];
    if (!s) return 0;
    return ((s.fov * 180) / Math.PI) * (1 - 1 / s.zones);
  }

  /** Fraction of the 360° horizontal circle actually sampled, 0..1. */
  coverage() {
    return Math.min(1, (this.effectiveFovDeg() * this.horizontalCount) / 360);
  }

  /** Widest unsampled horizontal gap, in degrees. Requirement F3 allows ≤15°. */
  worstGapDeg() {
    return Math.max(0, 360 / this.horizontalCount - this.effectiveFovDeg());
  }

  /**
   * Cast every zone of every sensor into the scene.
   * @returns {{returns: Array, cast: number, hit: number, dropped: number}}
   */
  sample(world, headPos, headYaw) {
    const returns = [];
    let cast = 0;
    let hit = 0;
    let dropped = 0;

    const cy = Math.cos(headYaw);
    const sy = Math.sin(headYaw);

    for (const sensor of this.sensors) {
      for (const zone of sensor.dirs) {
        cast++;
        const lv = zone.v;
        // Head-relative bearing/elevation, before world rotation
        const bearing = Math.atan2(lv.x, lv.z);
        const elevation = Math.asin(Math.max(-1, Math.min(1, lv.y)));

        // Rotate into world by head yaw
        _dir.set(lv.x * cy + lv.z * sy, lv.y, -lv.x * sy + lv.z * cy).normalize();
        _origin.copy(headPos);

        const h = world.raycast(
          _origin.x, _origin.y, _origin.z, _dir.x, _dir.y, _dir.z, sensor.maxRange
        );
        if (!h) continue;
        hit++;

        if (!this._returns(h, _dir, sensor.maxRange)) {
          dropped++;
          continue;
        }

        // Distance-dependent noise: roughly 1 cm + 2% of range
        const sigma = 0.01 + 0.02 * h.distance;
        const noisy = Math.max(0.02, h.distance + gaussian() * sigma);

        returns.push({
          distance: noisy,
          bearing,
          // Elevation expressed in semitones for the encoder: ±12 over ±45°
          elevation: Math.max(-12, Math.min(12, (elevation / (Math.PI / 4)) * 12)),
          worldPoint: _origin.clone().addScaledVector(_dir, noisy),
          sensorId: sensor.id,
          label: h.label,
        });
      }
    }
    return { returns, cast, hit, dropped };
  }

  /**
   * Does enough light come back? Combines surface reflectivity, incidence angle
   * and range. This is the model's most important piece of pessimism — a sim
   * without it will tell you glass walls and black cloth are solid returns.
   */
  _returns(h, dir, maxRange) {
    const refl = h.reflectivity ?? 0.6;

    // Absolute value throughout: the imported scan has inconsistent winding, so
    // normal *direction* means nothing — only the angle to the ray does.
    const cosInc = Math.abs(h.nx * dir.x + h.ny * dir.y + h.nz * dir.z);

    // Grazing angles scatter the beam away from the receiver. The exponent sets
    // how unforgiving that is; 1.2 keeps corridor walls (nearly all grazing hits)
    // returning something, which matches bench behaviour better than a harsher
    // curve. Tune against real VL53L5CX data at M2 — this is a guess until then.
    const angleTerm = Math.pow(cosInc, 1.2);
    // Returned energy falls off with distance; not inverse-square, because the
    // sensor's own AGC compensates, but the trend is real.
    const rangeTerm = 1 - 0.55 * (h.distance / maxRange);

    const p = refl * angleTerm * rangeTerm;
    return Math.random() < p;
  }
}

/** Box–Muller, so noise is actually Gaussian rather than uniform. */
function gaussian() {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
