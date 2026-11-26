/** Small math helpers shared by the player module. */

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Frame-rate independent exponential smoothing towards target. */
export function damp(current: number, target: number, rate: number, dt: number): number {
  return target + (current - target) * Math.exp(-rate * dt);
}

export function smoothstep(t: number): number {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

export function easeOutCubic(t: number): number {
  const x = 1 - clamp(t, 0, 1);
  return 1 - x * x * x;
}

export function easeInCubic(t: number): number {
  const x = clamp(t, 0, 1);
  return x * x * x;
}

/**
 * Damped spring around 0 (value is an offset). Kick it by adding to velocity.
 * Sub-steps internally so large frames stay stable.
 */
export class Spring {
  value = 0;
  velocity = 0;
  constructor(
    public stiffness: number,
    public damping: number,
  ) {}

  update(dt: number): number {
    const steps = Math.max(1, Math.ceil(dt / (1 / 120)));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      const a = -this.stiffness * this.value - this.damping * this.velocity;
      this.velocity += a * h;
      this.value += this.velocity * h;
    }
    return this.value;
  }

  reset(): void {
    this.value = 0;
    this.velocity = 0;
  }
}

/**
 * Smooth pseudo-random noise in [-1, 1] built from incommensurate sines.
 * Cheap and good enough for camera shake.
 */
export function shakeNoise(t: number, seed: number): number {
  return (
    Math.sin(t * 23.1 + seed * 1.7) * 0.5 +
    Math.sin(t * 37.7 + seed * 3.1) * 0.3 +
    Math.sin(t * 61.3 + seed * 5.3) * 0.2
  );
}
