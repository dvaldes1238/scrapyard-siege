import { Color3, Color4 } from "@babylonjs/core";

/**
 * All FX tuning numbers in one place: pool sizes, particle counts/lifetimes/speeds, colours,
 * tracer and shock-ring timing, the shared explosion light and physical debris.
 * Units: metres, seconds, m/s. [min, max] pairs are random ranges.
 * Particle colours are gamma-space; values > 1 push into HDR bloom.
 */

type Range = [number, number];

export const POOLS = {
  impact: 8, // round-robin systems per impact layer (sparks, flash, dust, chips)
  explosionKits: 4, // smoke + fire + sparks + chunks + flash per kit
  rings: 4, // shock-ring meshes
  tracers: 20, // tracer meshes (≈1-2 live at 11 shots/s)
};

export const IMPACT = {
  farDistance: 70, // beyond this from the camera, bursts are trimmed
  sparks: {
    capacity: 48,
    countEnemy: 14,
    countBarrel: 11,
    countFar: 5,
    power: [3, 10] as Range,
    life: [0.12, 0.35] as Range,
    size: [0.022, 0.045] as Range,
    stretch: [3, 7] as Range, // stretched-billboard length multiplier
    along: 0.7, // bias along the surface normal
    spread: 0.75,
  },
  worldSparks: { count: 3, power: [2, 6] as Range, life: [0.08, 0.2] as Range, along: 0.8, spread: 0.7 },
  flash: { size: [0.28, 0.42] as Range, life: [0.045, 0.07] as Range },
  dust: {
    capacity: 16,
    count: 4,
    countFar: 2,
    power: [0.3, 1.3] as Range,
    life: [0.45, 0.9] as Range,
    sizes: [[0, 0.12], [0.35, 0.45], [1, 0.85]] as Range[], // size over life (gradient, factor)
    spread: 0.35,
    gravity: -0.35,
  },
  chips: {
    capacity: 16,
    count: 6,
    power: [1.8, 4.5] as Range,
    life: [0.35, 0.75] as Range,
    size: [0.018, 0.045] as Range,
    spread: 0.9,
    spin: 14, // rad/s
  },
};

/** Counts are `base + perScale × scale` (scale 1 ≈ 5 m blast radius). */
export const EXPLOSION = {
  scaleRange: [0.3, 2.5] as Range,
  smoke: {
    capacity: 40,
    count: [10, 8] as Range,
    life: [1.6, 3.2] as Range,
    power: [1, 3.5] as Range, // × √scale
    radius: 0.9, // × scale
    sizes: [[0, 1.1], [0.3, 3.0], [1, 5.2]] as Range[],
    drift: [0.3, 1.6, 0.1] as [number, number, number], // wind + buoyancy (m/s²)
  },
  fire: {
    capacity: 40,
    count: [14, 10] as Range,
    life: [0.25, 0.6] as Range,
    power: [2, 6] as Range, // × scale
    radius: 0.6,
    sizes: [[0, 1.2], [0.4, 2.5], [1, 3.1]] as Range[],
    rise: 3, // buoyancy (m/s²)
  },
  sparks: {
    capacity: 64,
    count: [24, 18] as Range,
    life: [0.4, 1.1] as Range,
    power: [8, 21] as Range, // × √scale
    size: [0.035, 0.07] as Range,
    stretch: [4, 9] as Range,
  },
  chunks: {
    capacity: 32,
    count: [10, 8] as Range,
    life: [0.8, 1.6] as Range,
    power: [5, 12] as Range, // × √scale
    size: [0.05, 0.13] as Range,
  },
  flash: { size: [5, 6] as Range, life: [0.11, 0.15] as Range },
  light: {
    life: 0.25, // s, quadratic fade
    peakBase: 10,
    peakPerScale2: 38, // peak = min(max, base + k × scale²)
    peakMax: 90,
    range: 30,
    height: 0.8, // above the blast centre
    color: new Color3(1, 0.62, 0.3),
    specular: new Color3(0.6, 0.4, 0.2),
  },
  ring: {
    groundScale: 11, // final quad size × scale (ring radius ≈ 0.41 × this)
    airScale: 8,
    groundLife: 0.45,
    airLife: 0.32,
    groundProbe: 2.5, // × scale: how far below the blast we look for ground
    color: new Color3(1, 0.72, 0.42),
  },
};

export const TRACER = {
  life: 0.065, // s
  width: 0.028, // m
  widthPerMetre: 0.0004, // long shots get slightly thicker so they stay visible
  widthExtraMax: 0.03,
  minLength: 0.2,
  color: new Color3(1, 0.86, 0.58),
};

export const DEBRIS = {
  max: 80, // live pieces; oldest removed first
  life: [4, 6] as Range, // s
  shrinkTime: 0.6, // s at the end of life
  maxPerShatter: 24,
  defaultCount: 10,
  defaultSize: 0.25,
  defaultForce: 7, // m/s
  defaultColor: new Color3(0.22, 0.23, 0.25),
  density: 900, // kg/m³ → mass, clamped below
  mass: [0.4, 6] as Range,
  friction: 0.6,
  restitution: 0.25,
  linearDamping: 0.05,
  angularDamping: 0.2,
  spin: 14, // rad/s max initial angular velocity per axis
  metallic: 0.55,
  roughness: 0.5,
  killY: -20,
};

export const FX_COLORS = {
  enemySpark1: new Color4(1.2, 1.15, 1.0, 1),
  enemySpark2: new Color4(0.55, 0.85, 1.25, 1),
  enemySparkDead: new Color4(0.3, 0.5, 1, 0),
  hotSpark1: new Color4(1.3, 1.0, 0.6, 1),
  hotSpark2: new Color4(1.2, 0.6, 0.2, 1),
  hotSparkDead: new Color4(0.9, 0.25, 0.05, 0),
  enemyFlash: new Color4(0.9, 1.0, 1.25, 1),
  hotFlash: new Color4(1.3, 0.95, 0.6, 1),
  flashDead: new Color4(1, 0.5, 0.2, 0),
  woodDust1: new Color4(0.62, 0.53, 0.4, 0.5),
  woodDust2: new Color4(0.55, 0.47, 0.36, 0.42),
  woodDustDead: new Color4(0.6, 0.52, 0.42, 0),
  dust1: new Color4(0.6, 0.56, 0.5, 0.55),
  dust2: new Color4(0.5, 0.46, 0.4, 0.45),
  dustDead: new Color4(0.58, 0.54, 0.48, 0),
  woodChip1: new Color4(0.42, 0.3, 0.18, 1),
  woodChip2: new Color4(0.3, 0.22, 0.14, 1),
  chip1: new Color4(0.35, 0.33, 0.3, 1),
  chip2: new Color4(0.2, 0.19, 0.18, 1),
  chipDead: new Color4(0.2, 0.18, 0.15, 0),
  smoke: [
    [0, new Color4(0.16, 0.13, 0.11, 0)],
    [0.06, new Color4(0.18, 0.15, 0.13, 0.85)],
    [0.5, new Color4(0.27, 0.24, 0.21, 0.55)],
    [1, new Color4(0.36, 0.34, 0.32, 0)],
  ] as [number, Color4][],
  fire: [
    [0, new Color4(1.35, 1.15, 0.85, 1)],
    [0.25, new Color4(1.3, 0.7, 0.22, 0.95)],
    [0.65, new Color4(0.8, 0.25, 0.05, 0.5)],
    [1, new Color4(0.25, 0.06, 0.02, 0)],
  ] as [number, Color4][],
  chunk1: new Color4(0.08, 0.07, 0.06, 1),
  chunk2: new Color4(0.18, 0.15, 0.12, 1),
  chunkDead: new Color4(0.1, 0.09, 0.08, 0),
  blastSpark1: new Color4(1.3, 1.1, 0.75, 1),
  blastSpark2: new Color4(1.2, 0.7, 0.3, 1),
  blastSparkDead: new Color4(0.9, 0.25, 0.05, 0),
  blastFlash1: new Color4(1.3, 1.05, 0.75, 1),
  blastFlash2: new Color4(1.3, 0.95, 0.6, 1),
  blastFlashDead: new Color4(1, 0.4, 0.1, 0),
};
