/** Small deterministic noise toolkit for procedural textures and layout jitter. */

/** Seeded PRNG (mulberry32). Returns floats in [0, 1). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash2(ix: number, iy: number, seed: number): number {
  let h = Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

/** Tileable value noise: lattice wraps every `period` cells. Output in [0, 1]. */
export function valueNoise(x: number, y: number, period: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = fade(x - xi);
  const fy = fade(y - yi);
  const x0 = ((xi % period) + period) % period;
  const y0 = ((yi % period) + period) % period;
  const x1 = (x0 + 1) % period;
  const y1 = (y0 + 1) % period;
  const a = hash2(x0, y0, seed);
  const b = hash2(x1, y0, seed);
  const c = hash2(x0, y1, seed);
  const d = hash2(x1, y1, seed);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

/** A square scalar field with wrap-around sampling. */
export class Field {
  constructor(
    readonly size: number,
    readonly data: Float32Array,
  ) {}
  /** Sample at integer texel coords (wrapping). */
  at(x: number, y: number): number {
    const s = this.size;
    return this.data[(((y % s) + s) % s) * s + (((x % s) + s) % s)];
  }
  /** Sample at normalized coords (nearest). */
  uv(u: number, v: number): number {
    return this.at(Math.floor(u * this.size), Math.floor(v * this.size));
  }
}

/** Tileable fBm field in [0, 1] (approximately), `baseFreq` cells across the texture. */
export function fbmField(size: number, baseFreq: number, octaves: number, seed: number, gain = 0.5): Field {
  const data = new Float32Array(size * size);
  let norm = 0;
  let amp = 1;
  for (let o = 0; o < octaves; o++) {
    norm += amp;
    amp *= gain;
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let sum = 0;
      let a = 1;
      let f = baseFreq;
      for (let o = 0; o < octaves; o++) {
        sum += a * valueNoise((x / size) * f, (y / size) * f, f, seed + o * 101);
        a *= gain;
        f *= 2;
      }
      data[y * size + x] = sum / norm;
    }
  }
  // Stretch contrast to roughly fill [0, 1].
  let mn = Infinity;
  let mx = -Infinity;
  for (let i = 0; i < data.length; i++) {
    if (data[i] < mn) mn = data[i];
    if (data[i] > mx) mx = data[i];
  }
  const inv = 1 / Math.max(1e-6, mx - mn);
  for (let i = 0; i < data.length; i++) data[i] = (data[i] - mn) * inv;
  return new Field(size, data);
}

/** Tileable Worley (F1 distance, normalized) field; also returns a per-cell random id field. */
export function worleyField(size: number, cells: number, seed: number): { dist: Field; id: Field } {
  const pts = new Float32Array(cells * cells * 2);
  const ids = new Float32Array(cells * cells);
  const r = rng(seed);
  for (let i = 0; i < cells * cells; i++) {
    pts[i * 2] = r();
    pts[i * 2 + 1] = r();
    ids[i] = r();
  }
  const dist = new Float32Array(size * size);
  const idOut = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const fx = (x / size) * cells;
      const fy = (y / size) * cells;
      const cx = Math.floor(fx);
      const cy = Math.floor(fy);
      let best = 9;
      let bestId = 0;
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const gx = cx + ox;
          const gy = cy + oy;
          const wx = ((gx % cells) + cells) % cells;
          const wy = ((gy % cells) + cells) % cells;
          const k = wy * cells + wx;
          const px = gx + pts[k * 2];
          const py = gy + pts[k * 2 + 1];
          const d = (px - fx) * (px - fx) + (py - fy) * (py - fy);
          if (d < best) {
            best = d;
            bestId = ids[k];
          }
        }
      }
      dist[y * size + x] = Math.min(1, Math.sqrt(best));
      idOut[y * size + x] = bestId;
    }
  }
  return { dist: new Field(size, dist), id: new Field(size, idOut) };
}

export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smooth = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
