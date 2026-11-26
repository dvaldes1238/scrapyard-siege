import { DynamicTexture, Texture, type ICanvas, type Scene } from "@babylonjs/core";

/**
 * Procedural particle/FX textures (white, tinted by particle colour), cached per scene.
 * Shared by src/fx and src/world (dust motes, steam, smoke plumes).
 */
export interface FxTextures {
  /** Soft round glow. */
  dot: Texture;
  /** Puffy smoke blob. */
  smoke: Texture;
  /** Turbulent flame blob. */
  fire: Texture;
  /** Thin ring for shockwaves. */
  ring: Texture;
  /** Hard-edged chip. */
  chip: Texture;
  /** Star-burst flare for flashes. */
  flare: Texture;
  /** Tracer streak: soft across v, brighter towards u = 1 (head). */
  streak: Texture;
  /** Opaque grey scuff/noise for debris albedo (tinted by material colour). */
  scuff: Texture;
}

const cache = new WeakMap<Scene, FxTextures>();

function hash(x: number, y: number, s: number): number {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function vnoise(x: number, y: number, s: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash(xi, yi, s);
  const b = hash(xi + 1, yi, s);
  const c = hash(xi, yi + 1, s);
  const d = hash(xi + 1, yi + 1, s);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

function fbm(x: number, y: number, s: number, oct = 4): number {
  let sum = 0;
  let amp = 0.5;
  let f = 1;
  for (let o = 0; o < oct; o++) {
    sum += amp * vnoise(x * f, y * f, s + o * 13);
    amp *= 0.5;
    f *= 2;
  }
  return sum / (1 - Math.pow(0.5, oct));
}

function make(scene: Scene, name: string, w: number, h: number, pixel: (u: number, v: number) => [number, number]): Texture {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d")!;
  const img = g.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [lum, a] = pixel((x + 0.5) / w, (y + 0.5) / h);
      const k = (y * w + x) * 4;
      const l = Math.max(0, Math.min(1, lum)) * 255;
      img.data[k] = l;
      img.data[k + 1] = l;
      img.data[k + 2] = l;
      img.data[k + 3] = Math.max(0, Math.min(1, a)) * 255;
    }
  }
  g.putImageData(img, 0, 0);
  const t = new DynamicTexture(name, c as unknown as ICanvas, scene, true, Texture.TRILINEAR_SAMPLINGMODE);
  t.hasAlpha = true;
  t.wrapU = Texture.CLAMP_ADDRESSMODE;
  t.wrapV = Texture.CLAMP_ADDRESSMODE;
  t.update(true);
  return t;
}

export function getFxTextures(scene: Scene): FxTextures {
  const hit = cache.get(scene);
  if (hit) return hit;
  const radial = (u: number, v: number) => Math.hypot(u - 0.5, v - 0.5) * 2;
  const tex: FxTextures = {
    dot: make(scene, "fxDot", 64, 64, (u, v) => {
      const r = radial(u, v);
      const a = Math.exp(-r * r * 5) * (1 - Math.min(1, r) ** 4);
      return [1, a];
    }),
    smoke: make(scene, "fxSmoke", 128, 128, (u, v) => {
      const r = radial(u, v);
      const n = fbm(u * 5, v * 5, 3, 5);
      const edge = 1 - smoothstep(0.35, 1.0, r + (n - 0.5) * 0.55);
      const lum = 0.7 + n * 0.3 - r * 0.15;
      return [lum, edge * (0.55 + n * 0.45)];
    }),
    fire: make(scene, "fxFire", 128, 128, (u, v) => {
      const r = radial(u, v);
      const n = fbm(u * 6, v * 6, 11, 5);
      const n2 = fbm(u * 14 + 7, v * 14 + 3, 17, 3);
      const body = 1 - smoothstep(0.2, 0.95, r + (n - 0.5) * 0.7);
      return [0.75 + n2 * 0.25, body * (0.6 + n * 0.5)];
    }),
    ring: make(scene, "fxRing", 128, 128, (u, v) => {
      const r = radial(u, v);
      const a = Math.exp(-(((r - 0.82) / 0.07) ** 2)) + Math.exp(-(((r - 0.7) / 0.18) ** 2)) * 0.25;
      return [1, Math.min(1, a) * (r < 1 ? 1 : 0)];
    }),
    chip: make(scene, "fxChip", 32, 32, (u, v) => {
      // Irregular quad.
      const x = u - 0.5;
      const y = v - 0.5;
      const inside = Math.abs(x * 0.9 + y * 0.3) < 0.36 && Math.abs(y * 0.95 - x * 0.25) < 0.3;
      return [0.85 + hash(Math.floor(u * 8), Math.floor(v * 8), 5) * 0.15, inside ? 1 : 0];
    }),
    flare: make(scene, "fxFlare", 128, 128, (u, v) => {
      const x = (u - 0.5) * 2;
      const y = (v - 0.5) * 2;
      const r = Math.hypot(x, y);
      const ang = Math.atan2(y, x);
      const core = Math.exp(-r * r * 18);
      const glow = Math.exp(-r * r * 3.5) * 0.45;
      const rays = Math.pow(Math.abs(Math.cos(ang * 3)), 40) * Math.exp(-r * 2.5) * 0.6;
      return [1, Math.min(1, core + glow + rays) * (1 - Math.min(1, r) ** 6)];
    }),
    streak: make(scene, "fxStreak", 64, 16, (u, v) => {
      const across = Math.exp(-(((v - 0.5) / 0.22) ** 2));
      const along = 0.25 + 0.75 * Math.pow(u, 1.5);
      const tip = 1 - smoothstep(0.92, 1, u) * 0.6;
      return [1, across * along * tip];
    }),
    scuff: make(scene, "fxScuff", 64, 64, (u, v) => {
      const n = fbm(u * 6, v * 6, 23, 4);
      const g = fbm(u * 24, v * 24, 29, 2);
      const edge = Math.max(Math.abs(u - 0.5), Math.abs(v - 0.5)) > 0.44 ? 0.75 : 1;
      return [(0.62 + n * 0.3 + (g - 0.5) * 0.15) * edge, 1];
    }),
  };
  tex.scuff.hasAlpha = false;
  cache.set(scene, tex);
  return tex;
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}
