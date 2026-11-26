/**
 * All player tuning numbers in one place (values from DESIGN.md unless marked "feel").
 * Units: metres, seconds, radians (DEG helper for readability).
 */
export const DEG = Math.PI / 180;

export const PLAYER = {
  maxHealth: 100,
  regenDelay: 4, // s without damage before regen starts
  regenRate: 10, // HP/s
  healedEventInterval: 0.25, // throttle for "player:healed"

  radius: 0.4,
  height: 1.8,
  eyeHeight: 1.65,

  walkSpeed: 6,
  sprintSpeed: 9.5,
  jumpVelocity: 6.5,
  gravity: -18,
  coyoteTime: 0.1,
  jumpBuffer: 0.1,
  airControl: 0.3, // fraction of ground acceleration available in the air

  groundAccel: 75, // feel: m/s² towards wish velocity (reaches walk speed in ~0.08 s)
  groundDecel: 55, // feel: m/s² braking with no input
  maxFallSpeed: 50,
  groundStick: 0.6, // feel: small downward bias while grounded so we hug ramps/crests
  ungroundAfterJump: 0.15, // ignore support for this long after jumping / upward knockback
  killY: -10,

  // Havok character controller
  maxStepHeight: 0.35,
  maxSlopeDeg: 55,
  pushStrength: 1400, // N: caps how hard we shove dynamic props (light crates move, heavy stuff doesn't)
  characterMass: 70, // kg: weight pressed onto dynamic props we stand on
  maxSubstep: 1 / 50, // split long frames into substeps for the controller

  landEventMinSpeed: 4.5, // m/s downward speed before "player:land" (jump lands ~6.7; 0.45 m step-off ~4.2)
  strideWalk: 2.1, // metres per footstep at walk speed
  strideSprint: 2.7, // metres per footstep at sprint speed
  footstepMinSpeed: 1.2,
};

/** ?sens=1.5 scales mouse/trackpad look speed (0.1–10). */
const SENS_SCALE = ((): number => {
  const v = Number(new URLSearchParams(location.search).get("sens"));
  return v >= 0.1 && v <= 10 ? v : 1;
})();

export const LOOK = {
  sensitivity: 0.0022 * SENS_SCALE, // rad per pixel
  maxPitch: 89 * DEG,
  spikeFilterPx: 600, // ignore single mousemove events larger than this (Chrome pointer-lock spikes)
  lookGateMs: 60, // ignore look right after (re)locking
  fireGateMs: 200, // ignore fire right after game:start / game:resume
};

export const RIFLE = {
  fireInterval: 0.09,
  magSize: 30,
  reloadTime: 1.6,
  damage: 12,
  range: 200,
  spreadBase: 0.4, // degrees
  spreadPerShot: 0.3,
  spreadMax: 2.5,
  spreadRecovery: 8, // deg/s
  spreadMovingPenalty: 1, // deg while moving fast or airborne
  fastSpeed: 7, // m/s horizontal counts as "moving fast"
  recoilPitch: 0.5 * DEG,
  recoilYaw: 0.18 * DEG, // max random yaw per shot
  recoilRecoverFraction: 0.6,
  impulseSpeed: 2.5, // impulse = dir × 2.5 × min(mass, 25)
  impulseMassCap: 25,
};

export const LAUNCHER = {
  maxCharges: 3,
  rechargeTime: 2.5,
  cooldown: 0.4, // feel: min time between launches
  speed: 30,
  upBoost: 1.2, // m/s added upward on launch
  radius: 0.12,
  mass: 1,
  armTime: 0.05,
  fuse: 2,
  explosion: { radius: 6, force: 14, damage: 90, playerDamageScale: 0.35 },
  eventInterval: 0.1, // "launcher:changed" at most 10×/s while recharging
  recoilPitch: 1.8 * DEG,
  trailFade: 0.3,
};

export const CAMERA_FX = {
  bobWalkY: 0.04, // peak-to-peak vertical head bob at walk speed
  bobSprintY: 0.06,
  bobX: 0.02,
  bobRoll: 0.3 * DEG,
  landDipPerSpeed: 0.011, // m of dip per m/s impact speed
  landDipMax: 0.17,
  sprintFovKick: 0.085, // rad
  strafeRoll: 0.9 * DEG,
  recoilAttack: 38, // 1/s: how fast camera reaches the kicked angle
  recoilRecover: 6, // 1/s: how fast the recoverable part returns
  shakeDecay: 1.6, // trauma per second
  shakeMaxPitch: 2.6 * DEG,
  shakeMaxYaw: 2.6 * DEG,
  shakeMaxRoll: 3.2 * DEG,
  shakeMaxPos: 0.05,
  explosionShakeRange: 4, // × blast radius: beyond this, no shake
  explosionShakeMax: 0.9,
  damageShakeMin: 0.15,
  damageShakeMax: 0.5,
  deathDropTime: 0.9,
  deathEyeHeight: 0.35,
};
