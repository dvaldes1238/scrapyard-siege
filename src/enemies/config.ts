import { Color3 } from "@babylonjs/core";
import type { ExplosionOptions } from "../core/explosion";

/**
 * All enemy tuning lives here (numbers from DESIGN.md plus feel constants).
 * Units: metres, seconds, m/s, m/s².
 */

export type DroneType = "seeker" | "bomber" | "brute";

export interface DroneSpec {
  readonly type: DroneType;
  readonly hp: number;
  /** Cruise speed (m/s). */
  readonly speed: number;
  /** Max steering acceleration (m/s²): higher = snappier turns. */
  readonly accel: number;
  readonly points: number;
  /** Visual scale of the procedural model. */
  readonly scale: number;
  /** Radius of the ANIMATED physics sphere (grenade collisions) and AI spacing. */
  readonly hitRadius: number;
  /** Eye / accent / shatter colour. */
  readonly color: Color3;
  /** Velocity kick (m/s) per rifle hit along the shot direction. */
  readonly knockback: number;
  /** Cosmetic hover bob amplitude (m) and frequency (Hz). */
  readonly bobAmp: number;
  readonly bobFreq: number;
  /** How fast the drone yaws to face its target (1/s, exponential). */
  readonly turnRate: number;
  /** fx.shatter debris on death. */
  readonly debrisCount: number;
  readonly debrisSize: number;
}

export const DRONES: Record<DroneType, DroneSpec> = {
  seeker: {
    type: "seeker",
    hp: 60,
    speed: 7,
    accel: 10,
    points: 100,
    scale: 1,
    hitRadius: 0.55,
    color: new Color3(0.15, 0.9, 1.0),
    knockback: 1.1,
    bobAmp: 0.09,
    bobFreq: 0.9,
    turnRate: 6,
    debrisCount: 10,
    debrisSize: 0.18,
  },
  bomber: {
    type: "bomber",
    hp: 40,
    speed: 11,
    accel: 15,
    points: 150,
    scale: 1,
    hitRadius: 0.5,
    color: new Color3(1.0, 0.45, 0.05),
    knockback: 1.4,
    bobAmp: 0.05,
    bobFreq: 1.6,
    turnRate: 9,
    debrisCount: 8,
    debrisSize: 0.16,
  },
  brute: {
    type: "brute",
    hp: 300,
    speed: 3.5,
    accel: 4,
    points: 500,
    scale: 1.9,
    hitRadius: 1.0,
    color: new Color3(1.0, 0.1, 0.05),
    knockback: 0.18,
    bobAmp: 0.07,
    bobFreq: 0.5,
    turnRate: 2.5,
    debrisCount: 18,
    debrisSize: 0.32,
  },
};

/** Shared flight envelope for every drone. */
export const FLIGHT = {
  /** Altitude band above the arena floor (world.playerSpawn.y). */
  altMin: 1.5,
  altMax: 12,
  /** Soft push starts this far inside world.bounds; hard clamp at 0.5 m inside. */
  boundsMargin: 4,
  /** Extra gap (beyond both hit radii) that separation tries to keep between drones. */
  separationGap: 1.8,
  separationStrength: 1.6,
  /** Obstacle / floor probe interval (s). */
  probeInterval: 0.2,
  /** Max range to open fire (m). */
  fireRange: 38,
};

export const SEEKER_AI = {
  orbitMin: 10,
  orbitMax: 16,
  altMin: 3,
  altMax: 8,
  fireMin: 1.6,
  fireMax: 2.6,
  /** Delay before the first shot after warp-in. */
  firstShotMin: 1.0,
  firstShotMax: 2.0,
  /** Time between orbit direction / radius / altitude changes. */
  retargetMin: 2.5,
  retargetMax: 5,
  /** Chance to reverse orbit direction on retarget. */
  reverseChance: 0.4,
  /** Sideways juke: interval, duration, speed multiplier. */
  strafeMin: 1.4,
  strafeMax: 3.0,
  strafeTime: 0.45,
  strafeBoost: 1.5,
  /** Eye flare before a shot (s). */
  chargeTime: 0.35,
  /** Aim spread (degrees). */
  spreadDeg: 1.4,
};

export const BOMBER_AI = {
  /** Detonates when this close to the player's chest. */
  triggerDistance: 2.2,
  /** Approach altitude above the floor while far away. */
  cruiseAlt: 4.5,
  /** Horizontal distance at which it stops cruising and dives. */
  diveDistance: 13,
  /** Lead on the dive (fraction of player velocity × time to impact). */
  lead: 0.45,
};

export const BRUTE_AI = {
  /** Keeps roughly this horizontal distance from the player. */
  preferredDistance: 11,
  altMin: 2.6,
  altMax: 5,
  burstInterval: 3,
  burstCount: 3,
  burstGap: 0.16,
  firstBurstMin: 1.5,
  firstBurstMax: 2.5,
  chargeTime: 0.5,
  spreadDeg: 2.2,
  /** Lateral drift speed as a fraction of max speed. */
  drift: 0.35,
};

export const BOLT = {
  speed: 22,
  damage: 8,
  /** Collision radius (m). */
  radius: 0.25,
  life: 4,
  /** Fraction of the player's velocity × flight time added to the aim point. */
  lead: 0.65,
  /** Initial pool size (grows if exhausted, up to maxPool). */
  pool: 48,
  maxPool: 128,
  /** Visual streak length (m). */
  trailLength: 1.3,
  /** Impulse (m/s × min(mass, 10)) given to dynamic props a bolt hits. */
  propPush: 1.2,
  core: new Color3(1.0, 0.55, 0.78),
  glow: new Color3(1.0, 0.1, 0.38),
};

export const DEATH_BLAST: ExplosionOptions = {
  radius: 3.5,
  force: 8,
  damage: 20,
  source: "explosion",
  playerDamageScale: 0.2,
};

export const BOMBER_BLAST: ExplosionOptions = {
  radius: 4,
  force: 12,
  damage: 35,
  source: "enemy",
  playerDamageScale: 1,
};

/** Seconds the white hit flash stays on. */
export const HIT_FLASH_TIME = 0.06;
/** Seconds for the post-warp scale-in pop. */
export const APPEAR_TIME = 0.2;

export const WAVES = {
  /** Wave 1 starts this long after game:start. */
  firstDelay: 2,
  intermission: 4,
  spawnInterval: 0.7,
  telegraphTime: 0.6,
  maxAlive: 12,
  clearBonusPerWave: 250,
  /** Spawn points closer than this (horizontal) to the player are skipped. */
  minSpawnDistance: 16,
  /** Random offset applied around the chosen spawn point. */
  spawnJitter: 2.5,
};

export interface WaveComposition {
  seekers: number;
  bombers: number;
  brutes: number;
}

/** DESIGN.md: seekers 2+n; bombers ⌊(n−1)/2⌋ from wave 3; brutes on every 5th wave, +1 from wave 8. */
export function waveComposition(n: number): WaveComposition {
  return {
    seekers: 2 + n,
    bombers: n >= 3 ? Math.floor((n - 1) / 2) : 0,
    brutes: (n >= 5 && n % 5 === 0 ? 1 : 0) + (n >= 8 ? 1 : 0),
  };
}
