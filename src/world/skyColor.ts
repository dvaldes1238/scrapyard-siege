/**
 * CPU port of the @babylonjs/materials SkyMaterial fragment shader (tonemapped, non-raw path).
 * Used to pick a fog colour that matches the sky's horizon haze exactly, and to tint the
 * hemispheric fill light. Pure math: no Babylon imports so it can be unit-tested in node.
 */

export interface SkyParams {
  luminance: number;
  turbidity: number;
  rayleigh: number;
  mieCoefficient: number;
  mieDirectionalG: number;
}

export type Vec3 = [number, number, number];

const PI = Math.PI;
const LAMBDA: Vec3 = [680e-9, 550e-9, 450e-9];
const K: Vec3 = [0.686, 0.678, 0.666];
const V = 4.0;
const RAYLEIGH_ZENITH_LENGTH = 8.4e3;
const MIE_ZENITH_LENGTH = 1.25e3;
const EE = 1000.0;
const SUN_ANGULAR_DIAMETER_COS = 0.999956676946448;
const CUTOFF_ANGLE = PI / 1.95;
const STEEPNESS = 1.5;
const W = 1000.0;

function uncharted2(x: number): number {
  const A = 0.15, B = 0.5, C = 0.1, D = 0.2, E = 0.02, F = 0.3;
  return (x * (A * x + C * B) + D * E) / (x * (A * x + B) + D * F) - E / F;
}

function norm(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/**
 * Sky colour (gamma space, 0..1) seen along `dir` with the sun towards `toSun`.
 * Mirrors skyPixelShader for up = +Y, cameraOffset = 0, cloudiness = 0.
 */
export function skyColor(dirIn: Vec3, toSunIn: Vec3, p: SkyParams): Vec3 {
  const dir = norm(dirIn);
  const sunDir = norm(toSunIn);
  const sunfade = 1.0 - Math.min(1, Math.max(0, 1.0 - Math.exp((sunDir[1] * 500) / 450000.0)));
  const rayleighCoefficient = p.rayleigh - 1.0 * (1.0 - sunfade);
  const zenithCos = sunDir[1];
  const sunE = EE * Math.max(0, 1 - Math.exp(-(CUTOFF_ANGLE - Math.acos(zenithCos)) / STEEPNESS));

  const betaR: Vec3 = [0.0005 / 94, 0.0005 / 40, 0.0005 / 18].map((b) => b * rayleighCoefficient) as Vec3;
  const c = 0.2 * p.turbidity * 10e-18;
  const betaM: Vec3 = [0, 1, 2].map(
    (i) => 0.434 * c * PI * Math.pow((2 * PI) / LAMBDA[i], V - 2) * K[i] * p.mieCoefficient,
  ) as Vec3;

  const zenithAngle = Math.acos(Math.max(0, dir[1]));
  const denom = Math.cos(zenithAngle) + 0.15 * Math.pow(93.885 - (zenithAngle * 180) / PI, -1.253);
  const sR = RAYLEIGH_ZENITH_LENGTH / denom;
  const sM = MIE_ZENITH_LENGTH / denom;
  const Fex: Vec3 = [0, 1, 2].map((i) => Math.exp(-(betaR[i] * sR + betaM[i] * sM))) as Vec3;

  const cosTheta = dir[0] * sunDir[0] + dir[1] * sunDir[1] + dir[2] * sunDir[2];
  const rc = cosTheta * 0.5 + 0.5;
  const rPhase = (3 / (16 * PI)) * (1 + rc * rc);
  const g = p.mieDirectionalG;
  const mPhase = (1 / (4 * PI)) * ((1 - g * g) / Math.pow(1 - 2 * g * cosTheta + g * g, 1.5));

  const mixT = Math.min(1, Math.max(0, Math.pow(1 - sunDir[1], 5)));
  const out: Vec3 = [0, 0, 0];
  const lumScale = Math.log2(2 / Math.pow(p.luminance, 4));
  const whiteScale = 1 / uncharted2(W);
  const sundisk = smoothstep(SUN_ANGULAR_DIAMETER_COS, SUN_ANGULAR_DIAMETER_COS + 0.00002, cosTheta);
  const tint = [0, 0.001 * 0.3, 0.0025 * 0.3];
  for (let i = 0; i < 3; i++) {
    const ratio = (betaR[i] * rPhase + betaM[i] * mPhase) / (betaR[i] + betaM[i]);
    let lin = Math.pow(sunE * ratio * (1 - Fex[i]), 1.5);
    lin *= 1 + (Math.pow(sunE * ratio * Fex[i], 0.5) - 1) * mixT;
    let l0 = 0.1 * Fex[i];
    l0 += sunE * 19000 * Fex[i] * sundisk;
    const tex = (lin + l0) * 0.04 + tint[i];
    out[i] = Math.min(1, Math.max(0, uncharted2(lumScale * tex) * whiteScale));
  }
  return out;
}

/**
 * Typical horizon colour (gamma space) a few degrees above the horizon: the per-channel median
 * over all azimuths, so the small, very bright sun-side arc doesn't dominate the haze colour.
 */
export function horizonColor(toSun: Vec3, p: SkyParams, elevationDeg = 2.5, samples = 48): Vec3 {
  const e = (elevationDeg * PI) / 180;
  const ch: number[][] = [[], [], []];
  for (let i = 0; i < samples; i++) {
    const a = (i / samples) * PI * 2;
    const col = skyColor([Math.cos(a) * Math.cos(e), Math.sin(e), Math.sin(a) * Math.cos(e)], toSun, p);
    for (let k = 0; k < 3; k++) ch[k].push(col[k]);
  }
  return ch.map((v) => v.sort((x, y) => x - y)[samples >> 1]) as Vec3;
}
