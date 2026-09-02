/**
 * Conformance tests for the reference encoder.
 *
 * The Swift and C++ ports must reproduce vectors.json exactly. A port that
 * drifts from the spec fails here, which is the only thing stopping the phone,
 * the firmware and the simulator from quietly becoming three different devices.
 *
 *   node --test sonification/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { toSectorMap, encode, proximity, bearingToSector, sectorBearing, SECTORS } from './encoder.js';

const here = dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(readFileSync(join(here, 'vectors.json'), 'utf8'));
const D = (deg) => (deg * Math.PI) / 180;
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

test('sector binning wraps correctly and sector 0 straddles straight ahead', () => {
  assert.equal(bearingToSector(D(0)), 0);
  assert.equal(bearingToSector(D(22)), 0);
  assert.equal(bearingToSector(D(23)), 1);
  assert.equal(bearingToSector(D(-23)), 7);
  assert.equal(bearingToSector(D(180)), 4);
  assert.equal(bearingToSector(D(-180)), 4);
  assert.equal(bearingToSector(D(359)), 0);
});

test('sector bearings round-trip through binning', () => {
  for (let k = 0; k < SECTORS; k++) {
    assert.equal(bearingToSector(sectorBearing(k)), k);
  }
});

test('proximity saturates at dMin, zeroes at dMax, and is monotonic', () => {
  assert.ok(near(proximity(0.3), 1));
  assert.ok(near(proximity(0.1), 1));
  assert.ok(near(proximity(4.0), 0));
  assert.equal(proximity(Infinity), 0, 'unknown must be silent, not loud');
  let prev = Infinity;
  for (let d = 0.3; d <= 4.0; d += 0.1) {
    const p = proximity(d);
    assert.ok(p <= prev + 1e-9, `proximity must fall as distance grows (${d})`);
    prev = p;
  }
});

test('an unknown sector is not treated as clear', () => {
  const sm = toSectorMap([]);
  assert.ok(sm.distance.every((d) => d === Infinity));
  assert.equal(encode(sm).audio.length, 0);
});

test('nearest return wins within a sector', () => {
  const sm = toSectorMap([
    { bearing: D(10), distance: 3.0, elevation: 0 },
    { bearing: D(-10), distance: 0.8, elevation: 0 },
  ]);
  assert.ok(near(sm.distance[0], 0.8));
});

test('salience gating caps simultaneous voices', () => {
  const crowded = Array.from({ length: 8 }, (_, k) => ({
    bearing: D(k * 45), distance: 1.0 + k * 0.3, elevation: 0,
  }));
  const sm = toSectorMap(crowded);
  assert.equal(encode(sm).audio.length, 3, 'default nActive is 3');
  assert.equal(encode(sm, { nActive: 8 }).audio.length, 8);
  assert.equal(encode(sm, { nActive: 1 }).audio.length, 1);
});

test('gating keeps the nearest sectors, not arbitrary ones', () => {
  const sm = toSectorMap(Array.from({ length: 8 }, (_, k) => ({
    bearing: D(k * 45), distance: 1.0 + k * 0.3, elevation: 0,
  })));
  const kept = encode(sm).audio.map((v) => v.sector);
  assert.deepEqual(kept, [0, 1, 2], 'the three closest are sectors 0,1,2');
});

test('rear sectors are low-passed to break the front/back pan ambiguity', () => {
  const sm = toSectorMap([
    { bearing: D(0), distance: 1.5, elevation: 0 },
    { bearing: D(180), distance: 1.5, elevation: 0 },
  ]);
  const voices = encode(sm).audio;
  const front = voices.find((v) => v.sector === 0);
  const rear = voices.find((v) => v.sector === 4);
  assert.ok(near(front.pan, rear.pan), 'pan alone cannot separate front from rear');
  assert.ok(rear.lowpassHz < front.lowpassHz, 'so timbre must');
});

test('haptics are coarser than audio and stay silent below the floor', () => {
  const far = toSectorMap([{ bearing: D(0), distance: 3.2, elevation: 0 }]);
  const audible = encode(far).audio.length;
  const buzzing = encode(far).haptics.filter((h) => h.intensity > 0).length;
  assert.ok(audible > 0, 'audio reports a distant object');
  assert.equal(buzzing, 0, 'haptics do not — they are for close things only');
});

test('matches the golden vectors', () => {
  for (const v of golden.vectors) {
    const sm = toSectorMap(v.input.map((r) => ({
      bearing: D(r.bearingDeg), distance: r.distance, elevation: r.elevation,
    })));
    const out = encode(sm);

    assert.equal(out.audio.length, v.audio.length, `${v.name}: voice count`);
    out.audio.forEach((got, i) => {
      const want = v.audio[i];
      assert.equal(got.sector, want.sector, `${v.name}: sector`);
      for (const key of ['gain', 'pan', 'carrierHz', 'tremoloHz', 'tremoloDepth']) {
        assert.ok(near(got[key], want[key], 1e-5), `${v.name}: ${key} ${got[key]} != ${want[key]}`);
      }
      assert.equal(got.lowpassHz, want.lowpassHz, `${v.name}: lowpassHz`);
    });

    out.haptics.forEach((got, i) => {
      assert.ok(near(got.intensity, v.haptics[i], 1e-5), `${v.name}: haptic ${i}`);
    });
  }
});
