/**
 * Regenerates vectors.json — the golden file every port of the encoder must match.
 *
 * Run after a deliberate spec change, never to make a failing test pass:
 *   node sonification/generate-vectors.mjs
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { toSectorMap, encode } from './encoder.js';

const D = (deg) => (deg * Math.PI) / 180;

const CASES = [
  {
    name: 'empty — nothing in range',
    returns: [],
  },
  {
    name: 'single obstacle dead ahead at 1 m',
    returns: [{ bearing: D(0), distance: 1.0, elevation: 0 }],
  },
  {
    name: 'front/back pair — the pan ambiguity case',
    returns: [
      { bearing: D(0), distance: 1.5, elevation: 0 },
      { bearing: D(180), distance: 1.5, elevation: 0 },
    ],
  },
  {
    name: 'hard left at 0.5 m — should saturate and pan fully',
    returns: [{ bearing: D(-90), distance: 0.5, elevation: 0 }],
  },
  {
    name: 'corridor — all eight sectors occupied, gating must cut to three',
    returns: Array.from({ length: 8 }, (_, k) => ({
      bearing: D(k * 45),
      distance: 1.0 + k * 0.3,
      elevation: 0,
    })),
  },
  {
    name: 'head-height beam — elevated return raises carrier pitch',
    returns: [{ bearing: D(0), distance: 2.0, elevation: 9 }],
  },
  {
    name: 'out of range — 4.5 m is silent',
    returns: [{ bearing: D(45), distance: 4.5, elevation: 0 }],
  },
  {
    name: 'nearest-of-sector — two returns in one sector, nearest wins',
    returns: [
      { bearing: D(10), distance: 3.0, elevation: 0 },
      { bearing: D(-10), distance: 0.8, elevation: 0 },
    ],
  },
];

const round = (x) => (Number.isFinite(x) ? Number(x.toFixed(6)) : null);

const vectors = CASES.map((c) => {
  const sectorMap = toSectorMap(c.returns);
  const out = encode(sectorMap);
  return {
    name: c.name,
    input: c.returns.map((r) => ({
      bearingDeg: Number(((r.bearing * 180) / Math.PI).toFixed(3)),
      distance: r.distance,
      elevation: r.elevation,
    })),
    sectorMap: sectorMap.distance.map(round),
    audio: out.audio.map((v) => ({
      sector: v.sector,
      gain: round(v.gain),
      pan: round(v.pan),
      carrierHz: round(v.carrierHz),
      tremoloHz: round(v.tremoloHz),
      tremoloDepth: round(v.tremoloDepth),
      lowpassHz: v.lowpassHz,
    })),
    haptics: out.haptics.map((h) => round(h.intensity)),
  };
});

const here = dirname(fileURLToPath(import.meta.url));
writeFileSync(
  join(here, 'vectors.json'),
  `${JSON.stringify({ spec: '0.1', generated: 'deterministic', vectors }, null, 2)}\n`
);
console.log(`wrote ${vectors.length} vectors`);
