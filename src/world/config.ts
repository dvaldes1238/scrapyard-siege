import { Color3 } from "@babylonjs/core";
import type { SkyParams } from "./skyColor";

/**
 * All world tuning numbers in one place (lighting, post, shadows, props, barrels, ambience).
 * Layout coordinates live in layout.ts / props.ts. Units: metres, seconds, kg, degrees where noted.
 */

export const SUN = {
  elevationDeg: 15, // low golden-hour sun: long shadows (6 m wall ≈ 22 m shadow)
  /** Horizontal direction towards the sun (x, z): WSW, behind-left of the spawn view (side light). */
  azimuth: [-0.9, -0.3] as [number, number],
  intensity: 3.4, // PBR directional intensity
  color: new Color3(1.0, 0.79, 0.56), // warm
  skyDistance: 500, // SkyMaterial sunPosition length (only the direction matters)
};

export const FILL = {
  hemiIntensity: 0.3, // cool sky fill on top of IBL
  hemiSkyBase: [0.35, 0.42, 0.55] as [number, number, number], // + 0.5 × sky colour
  hemiGround: new Color3(0.32, 0.25, 0.18), // warm ground bounce
  envIntensity: 0.75, // scene.environmentIntensity (sky-probe IBL)
};

/** SkyMaterial (tonemapped path); the fog colour is derived from the same model. */
export const SKY: SkyParams & { boxSize: number } = {
  luminance: 0.62, // lower = brighter in this model
  turbidity: 9,
  rayleigh: 3,
  mieCoefficient: 0.006,
  mieDirectionalG: 0.86,
  boxSize: 450, // must stay < 2 × camera.maxZ / √3 so corners aren't clipped
};

export const FOG = {
  density: 0.0075, // EXP2: ~7% at 35 m, ~43% at 100 m
  horizonElevationDeg: 2.5, // where the horizon colour is sampled
  tint: [1.06, 0.98, 0.88] as [number, number, number], // warms the sampled horizon median
};

export const PROBE = {
  size: 128, // cube face size of the sky capture
  readyFrames: 4, // frames with the sky shader ready before freezing the capture
  timeoutFrames: 300, // give up waiting for shader readiness after this many frames
  groundColor: new Color3(0.36, 0.31, 0.27), // probe-only ground disc (IBL lower hemisphere)
};

export const SHADOWS = {
  mapSize: 2048,
  cascades: 3,
  lambda: 0.85, // log/uniform split blend
  maxZ: 95, // metres of shadowed view distance
  cascadeBlend: 0.08,
  bias: 0.0012, // raise if acne, lower if shadows detach
  normalBias: 0.03, // metres
  darkness: 0,
};

export const POST = {
  exposure: 1.05,
  contrast: 1.12,
  bloomThreshold: 0.85, // linear HDR
  bloomWeight: 0.35,
  bloomKernel: 64,
  bloomScale: 0.5,
  fxaa: true,
  msaaSamples: 1, // >1 = MSAA on the HDR target (costly)
  grainIntensity: 6, // Babylon default 30
  chromaticAberration: 7, // Babylon default 30
  chromaticRadial: 0.9,
  vignetteWeight: 1.6,
  vignetteStretch: 0.25,
  vignetteColor: [0.05, 0.02, 0] as [number, number, number], // warm-black corners
  /** Golden-hour split tone (hue degrees, density -100..100). */
  curves: { globalHue: 35, globalDensity: 12, highlightsHue: 40, highlightsDensity: 28, shadowsHue: 205, shadowsDensity: 22 },
};

export const GLOW = {
  intensity: 0.8,
  textureRatio: 0.5,
  blurKernel: 32,
};

/** Only with ?ssao=1. */
export const SSAO = {
  ratio: 0.5,
  radius: 1.4,
  strength: 1.1,
  samples: 16,
  maxZ: 120,
};

export const TEXTURES = {
  normalYSign: 1, // flip to -1 if bumps look inverted in the browser
};

export const BARREL = {
  hp: 25,
  fuse: 0.1, // s between death and detonation (chains never recurse synchronously)
  explosion: { radius: 5.5, force: 13, damage: 80, playerDamageScale: 0.6 },
  debrisColor: new Color3(0.6, 0.07, 0.04),
  debrisCount: 12,
  debrisSize: 0.22,
  debrisForce: 9,
  mass: 30, // kg
};

export const PROPS = {
  /** Upper limits on how many of the placement spots in props.ts are used. */
  maxCrates: 53,
  maxExplosiveBarrels: 12,
  maxBlueDrums: 12,
  drumHeight: 0.9,
  drumRadius: 0.3,
  blueDrumMass: 22, // kg
  woodDensity: 18, // kg per m³ of crate (mass = k × size³)
  metalDensity: 40,
  woodFriction: 0.7,
  metalFriction: 0.55,
  drumFriction: 0.6,
  crateRestitution: 0.12,
  drumRestitution: 0.2,
  linearDamping: 0.05,
  angularDamping: 0.12,
  stackGap: 0.004, // vertical gap in stacks so asleep bodies never start interpenetrating
};

export const AMBIENCE = {
  dustCount: 320,
  dustRate: 40, // per second
  dustLife: [5, 9] as [number, number],
  dustSize: [0.018, 0.05] as [number, number],
  dustAlpha: 0.45,
  dustRadius: 14, // box half-size around the camera
  dustDrift: [0.05, 0.004, 0.02] as [number, number, number], // m/s² slow drift
  steamRate: 26,
  steamLife: [1.6, 2.8] as [number, number],
  steamPower: [1.6, 2.6] as [number, number], // m/s up out of the pipe
  steamSize: [0.18, 1.8] as [number, number], // start → end (m)
  steamAlpha: 0.32,
  steamWind: [0.35, 0.5, 0.15] as [number, number, number], // m/s²
  stackSmokeRate: 4.5,
  stackSmokeLife: [12, 16] as [number, number],
  stackSmokePower: [1.5, 2.5] as [number, number],
  stackSmokeSize: [4, 20] as [number, number], // start → end (m)
  stackSmokeAlpha: 0.55,
  stackSmokeWind: [0.9, 0.05, 0.35] as [number, number, number], // m/s²
  stackSmokePlumes: 2, // how many distant stacks smoke
  beaconPeriod: 1.6, // s
  beaconOnTime: 0.25, // s
};
