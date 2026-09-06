/**
 * Colour for the reconstruction point cloud.
 *
 * Hue encodes *what* the return came off; brightness encodes *how strong* the
 * return is. Both are needed: a single-hue cloud tells you something is there
 * but not whether it is a wall, a sofa or a person, and colour alone would hide
 * which returns are confident and which are one stray photon.
 *
 * The user never sees any of this — it is a debugging instrument. But being
 * able to tell a mis-classified wall from real furniture at a glance is the
 * difference between diagnosing the sensor model and guessing at it.
 */

export const CLASSES = [
  { id: 0, name: 'floor', color: [0.85, 0.64, 0.25] },      // amber
  { id: 1, name: 'ceiling', color: [0.56, 0.49, 0.79] },    // violet
  { id: 2, name: 'wall', color: [0.31, 0.82, 0.88] },       // cyan
  { id: 3, name: 'furniture', color: [0.44, 0.82, 0.55] },  // green
  { id: 4, name: 'person', color: [0.91, 0.40, 0.29] },     // coral
  { id: 5, name: 'glass', color: [0.50, 0.72, 0.82] },      // pale blue
  { id: 6, name: 'hazard', color: [1.00, 0.30, 0.35] },     // red
];

/**
 * Surface labels → class. Covers both the synthetic corridor and the imported
 * scan, so the legend means the same thing whichever scene is loaded.
 */
const LABEL_CLASS = {
  floor: 0,
  'pit floor': 0,
  ceiling: 1,
  wall: 2,
  furniture: 3,
  pillar: 3,
  person: 4,
  glass: 5,
  // The two hazards the white cane structurally cannot catch, called out in red.
  'drop-off edge': 6,
  'head-height beam': 6,
};

export function classForLabel(label) {
  const c = LABEL_CLASS[label];
  return c === undefined ? 3 : c;
}

export const LEGEND = CLASSES.map((c) => ({
  name: c.name,
  css: `rgb(${c.color.map((v) => Math.round(v * 255)).join(',')})`,
}));

/** Flat [r,g,b] triples, indexed by class — cheap to read in the bake loop. */
export const CLASS_RGB = new Float32Array(CLASSES.flatMap((c) => c.color));
