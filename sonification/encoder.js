/**
 * VisionBand sonification encoder — reference implementation of docs/01-encoding-spec.md
 *
 * Pure functions, no audio API, no DOM. This is deliberate: it is the one component
 * that gets ported to Swift and C++, and it must be testable headlessly against
 * vectors.json on all three platforms.
 */

export const SECTORS = 8;
export const SECTOR_WIDTH = (Math.PI * 2) / SECTORS;

export const DEFAULTS = {
  dMin: 0.3,
  dMax: 4.0,
  gamma: 1.6,
  nActive: 3,
  fBase: 220,
  rMin: 2,
  rMax: 14,
  quietFloor: 0.02,
  hapticGamma: 2.2,
  hapticFloor: 0.25,
  rearCutoffHz: 1200,
};

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Sector index for a head-relative bearing in radians. Sector 0 straddles 0. */
export function bearingToSector(bearing) {
  const t = bearing / SECTOR_WIDTH + 0.5;
  return ((Math.floor(t) % SECTORS) + SECTORS) % SECTORS;
}

/** Centre bearing of a sector, in radians, wrapped to (-pi, pi]. */
export function sectorBearing(k) {
  const b = k * SECTOR_WIDTH;
  return b > Math.PI ? b - Math.PI * 2 : b;
}

/**
 * Collapse raw sensor returns into a sector map of nearest distances.
 * `returns` is an array of { bearing, distance, elevation }, head-relative.
 * Sectors with no return stay Infinity — "unknown", which is not "clear".
 */
export function toSectorMap(returns) {
  const map = new Array(SECTORS).fill(Infinity);
  const elev = new Array(SECTORS).fill(0);
  for (const r of returns) {
    if (!Number.isFinite(r.distance)) continue;
    const k = bearingToSector(r.bearing);
    if (r.distance < map[k]) {
      map[k] = r.distance;
      elev[k] = r.elevation || 0;
    }
  }
  return { distance: map, elevation: elev };
}

/** Stage 1 — normalised proximity, non-linear so near objects dominate. */
export function proximity(d, opts = DEFAULTS) {
  if (!Number.isFinite(d)) return 0;
  const n = clamp01((opts.dMax - d) / (opts.dMax - opts.dMin));
  return Math.pow(n, opts.gamma);
}

/**
 * Stages 1–3. Returns one voice per audible sector.
 * Silent sectors are omitted entirely rather than returned at zero gain,
 * so a caller can cheaply see how many voices are live.
 */
export function encodeAudio(sectorMap, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const { distance, elevation } = sectorMap;

  const candidates = [];
  for (let k = 0; k < SECTORS; k++) {
    const p = proximity(distance[k], o);
    if (p > o.quietFloor) candidates.push({ sector: k, p });
  }

  // Stage 2 — salience gating. Sonifying every sector is unlistenable.
  candidates.sort((a, b) => b.p - a.p);
  const kept = candidates.slice(0, o.nActive);

  return kept.map(({ sector, p }) => {
    const bearing = sectorBearing(sector);
    const isRear = Math.abs(bearing) > Math.PI / 2;
    return {
      sector,
      bearing,
      distance: distance[sector],
      gain: p,
      pan: Math.sin(bearing),
      carrierHz: o.fBase * Math.pow(2, (elevation[sector] || 0) / 12),
      tremoloHz: o.rMin + p * (o.rMax - o.rMin),
      tremoloDepth: 0.35 + 0.45 * p,
      // Rear sources are dulled to break the front/back pan ambiguity —
      // pan alone cannot distinguish 45° from 135°.
      lowpassHz: isRear ? o.rearCutoffHz : 20000,
    };
  });
}

/** Stage 4 — haptics. Coarser and steeper than audio; speaks only when close. */
export function encodeHaptics(sectorMap, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const quadrants = [
    [7, 0, 1], // front
    [1, 2, 3], // right
    [3, 4, 5], // back
    [5, 6, 7], // left
  ];
  return quadrants.map((sectors, m) => {
    let best = 0;
    for (const k of sectors) best = Math.max(best, proximity(sectorMap.distance[k], o));
    const p = Math.pow(best, o.hapticGamma);
    return { motor: m, intensity: p < o.hapticFloor ? 0 : p };
  });
}

export function encode(sectorMap, options) {
  return {
    audio: encodeAudio(sectorMap, options),
    haptics: encodeHaptics(sectorMap, options),
  };
}
