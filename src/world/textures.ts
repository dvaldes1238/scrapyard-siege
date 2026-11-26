import { Color3, DynamicTexture, PBRMaterial, Texture, type ICanvas, type Scene } from "@babylonjs/core";
import { TEXTURES } from "./config";
import { clamp01, fbmField, lerp, rng, smooth, worleyField, type Field } from "./noise";

/**
 * Procedural PBR surfaces. Every texture is generated on a 2D canvas (≤ 512 px) and uploaded
 * once as a DynamicTexture: albedo (sRGB), ORM (R = AO, G = roughness, B = metallic, linear)
 * and a tangent-space normal map derived from a height field (OpenGL convention).
 */

export interface Surface {
  albedo: Texture;
  orm: Texture;
  normal: Texture;
}

const NORMAL_Y_SIGN = TEXTURES.normalYSign;

// ---------------------------------------------------------------------------------------------
// Shared noise fields (computed once, ~0.3 s total)

interface Fields {
  low: Field;
  mid: Field;
  hi: Field;
  grain: Field;
  cells: { dist: Field; id: Field };
  coarse: { dist: Field; id: Field };
}

let fieldsCache: Fields | null = null;
function fields(): Fields {
  if (!fieldsCache) {
    fieldsCache = {
      low: fbmField(512, 3, 5, 11),
      mid: fbmField(512, 8, 5, 23),
      hi: fbmField(512, 32, 3, 37),
      grain: fbmField(512, 128, 2, 41),
      cells: worleyField(512, 40, 53),
      coarse: worleyField(512, 10, 67),
    };
  }
  return fieldsCache;
}

// ---------------------------------------------------------------------------------------------
// Pixel buffers and canvas helpers

class Px {
  readonly col: Float32Array;
  readonly rough: Float32Array;
  readonly metal: Float32Array;
  readonly ao: Float32Array;
  readonly h: Float32Array;
  constructor(readonly n: number) {
    const c = n * n;
    this.col = new Float32Array(c * 3);
    this.rough = new Float32Array(c).fill(0.8);
    this.metal = new Float32Array(c);
    this.ao = new Float32Array(c).fill(1);
    this.h = new Float32Array(c);
  }
  setCol(i: number, r: number, g: number, b: number): void {
    this.col[i * 3] = r;
    this.col[i * 3 + 1] = g;
    this.col[i * 3 + 2] = b;
  }
  mixCol(i: number, r: number, g: number, b: number, t: number): void {
    if (t <= 0) return;
    const k = i * 3;
    this.col[k] += (r - this.col[k]) * t;
    this.col[k + 1] += (g - this.col[k + 1]) * t;
    this.col[k + 2] += (b - this.col[k + 2]) * t;
  }
  mulCol(i: number, f: number): void {
    const k = i * 3;
    this.col[k] *= f;
    this.col[k + 1] *= f;
    this.col[k + 2] *= f;
  }
}

function makeCanvas(w: number, h = w): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

/** Draw white-on-black with the 2D API and read it back as a 0..1 mask. */
function drawMask(n: number, draw: (g: CanvasRenderingContext2D) => void): Float32Array {
  const c = makeCanvas(n);
  const g = c.getContext("2d", { willReadFrequently: true })!;
  g.fillStyle = "#000";
  g.fillRect(0, 0, n, n);
  g.fillStyle = "#fff";
  g.strokeStyle = "#fff";
  draw(g);
  const d = g.getImageData(0, 0, n, n).data;
  const out = new Float32Array(n * n);
  for (let i = 0; i < out.length; i++) out[i] = d[i * 4] / 255;
  return out;
}

/** Draw a colour decal layer (transparent background) and read back RGBA (0..1). */
function drawDecal(n: number, draw: (g: CanvasRenderingContext2D) => void): Float32Array {
  const c = makeCanvas(n);
  const g = c.getContext("2d", { willReadFrequently: true })!;
  g.clearRect(0, 0, n, n);
  draw(g);
  const d = g.getImageData(0, 0, n, n).data;
  const out = new Float32Array(n * n * 4);
  for (let i = 0; i < out.length; i++) out[i] = d[i] / 255;
  return out;
}

/** Separable box blur with wrap-around. */
function blur(src: Float32Array, n: number, r: number): Float32Array {
  const tmp = new Float32Array(n * n);
  const out = new Float32Array(n * n);
  const w = 2 * r + 1;
  for (let y = 0; y < n; y++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[y * n + ((k + n) % n)];
    for (let x = 0; x < n; x++) {
      tmp[y * n + x] = acc / w;
      acc += src[y * n + ((x + r + 1) % n)] - src[y * n + ((x - r + n) % n)];
    }
  }
  for (let x = 0; x < n; x++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += tmp[((k + n) % n) * n + x];
    for (let y = 0; y < n; y++) {
      out[y * n + x] = acc / w;
      acc += tmp[((y + r + 1) % n) * n + x] - tmp[((y - r + n) % n) * n + x];
    }
  }
  return out;
}

function upload(scene: Scene, name: string, canvas: HTMLCanvasElement, linear: boolean, wrap = true, hasAlpha = false): DynamicTexture {
  const t = new DynamicTexture(name, canvas as unknown as ICanvas, scene, true, Texture.TRILINEAR_SAMPLINGMODE);
  t.wrapU = wrap ? Texture.WRAP_ADDRESSMODE : Texture.CLAMP_ADDRESSMODE;
  t.wrapV = wrap ? Texture.WRAP_ADDRESSMODE : Texture.CLAMP_ADDRESSMODE;
  t.anisotropicFilteringLevel = 8;
  t.hasAlpha = hasAlpha;
  t.gammaSpace = !linear;
  t.update(true);
  return t;
}

function albedoCanvas(p: Px, alpha?: Float32Array): HTMLCanvasElement {
  const n = p.n;
  const c = makeCanvas(n);
  const g = c.getContext("2d")!;
  const img = g.createImageData(n, n);
  const d = img.data;
  for (let i = 0; i < n * n; i++) {
    d[i * 4] = clamp01(p.col[i * 3]) * 255;
    d[i * 4 + 1] = clamp01(p.col[i * 3 + 1]) * 255;
    d[i * 4 + 2] = clamp01(p.col[i * 3 + 2]) * 255;
    d[i * 4 + 3] = alpha ? clamp01(alpha[i]) * 255 : 255;
  }
  g.putImageData(img, 0, 0);
  return c;
}

function ormCanvas(p: Px): HTMLCanvasElement {
  const n = p.n;
  const c = makeCanvas(n);
  const g = c.getContext("2d")!;
  const img = g.createImageData(n, n);
  const d = img.data;
  for (let i = 0; i < n * n; i++) {
    d[i * 4] = clamp01(p.ao[i]) * 255;
    d[i * 4 + 1] = clamp01(p.rough[i]) * 255;
    d[i * 4 + 2] = clamp01(p.metal[i]) * 255;
    d[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return c;
}

function normalCanvas(h: Float32Array, n: number, strength: number): HTMLCanvasElement {
  const c = makeCanvas(n);
  const g = c.getContext("2d")!;
  const img = g.createImageData(n, n);
  const d = img.data;
  for (let y = 0; y < n; y++) {
    const yu = ((y - 1 + n) % n) * n;
    const yd = ((y + 1) % n) * n;
    const yr = y * n;
    for (let x = 0; x < n; x++) {
      const xl = (x - 1 + n) % n;
      const xr = (x + 1) % n;
      const dx = (h[yr + xr] - h[yr + xl]) * 0.5 * strength;
      const dy = (h[yd + x] - h[yu + x]) * 0.5 * strength * NORMAL_Y_SIGN;
      const inv = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const k = (yr + x) * 4;
      d[k] = (-dx * inv * 0.5 + 0.5) * 255;
      d[k + 1] = (dy * inv * 0.5 + 0.5) * 255;
      d[k + 2] = (inv * 0.5 + 0.5) * 255;
      d[k + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

function finish(scene: Scene, name: string, p: Px, normalStrength: number, wrap = true): Surface {
  return {
    albedo: upload(scene, `${name}Albedo`, albedoCanvas(p), false, wrap),
    orm: upload(scene, `${name}Orm`, ormCanvas(p), true, wrap),
    normal: upload(scene, `${name}Normal`, normalCanvas(p.h, p.n, normalStrength), true, wrap),
  };
}

/** Random thin scratch lines. */
function scratchMask(n: number, count: number, seed: number, maxLen = 40): Float32Array {
  const r = rng(seed);
  return drawMask(n, (g) => {
    g.lineCap = "round";
    for (let i = 0; i < count; i++) {
      const x = r() * n;
      const y = r() * n;
      const a = r() * Math.PI * 2;
      const len = 6 + r() * maxLen;
      g.globalAlpha = 0.35 + r() * 0.65;
      g.lineWidth = 0.6 + r() * 1.1;
      g.beginPath();
      g.moveTo(x, y);
      g.quadraticCurveTo(x + Math.cos(a + 0.3) * len * 0.5, y + Math.sin(a + 0.3) * len * 0.5, x + Math.cos(a) * len, y + Math.sin(a) * len);
      g.stroke();
    }
  });
}

type RGB = [number, number, number];

// ---------------------------------------------------------------------------------------------
// Recipes

/** Weathered concrete, tile ≈ 3 m. Vertical water streaks for walls. */
function concrete(scene: Scene): Surface {
  const F = fields();
  const n = 512;
  const p = new Px(n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      const lo = F.low.at(x, y);
      const mi = F.mid.at(x + 71, y + 13);
      const hi = F.hi.at(x, y);
      const gr = F.grain.at(x, y);
      const streak = smooth(0.55, 0.85, F.mid.at(x * 3, y >> 2)) * (0.6 + 0.4 * lo);
      const cd = F.cells.dist.at(x * 2, y * 2);
      const cid = F.cells.id.at(x * 2, y * 2);
      const pit = cid > 0.62 ? smooth(0.16, 0.05, cd) : 0;
      const stain = smooth(0.5, 0.85, lo);
      let v = 0.56 + (mi - 0.5) * 0.14 + (hi - 0.5) * 0.08 + (gr - 0.5) * 0.07;
      v -= stain * 0.11 + streak * 0.08;
      p.setCol(i, v * 1.0, v * 0.975, v * 0.93);
      p.mixCol(i, 0.28, 0.25, 0.21, pit * 0.8);
      // Faint rust bleed from rebar.
      p.mixCol(i, 0.45, 0.3, 0.2, smooth(0.78, 0.92, F.mid.at(x + 300, y + 200)) * 0.35);
      p.rough[i] = 0.86 + hi * 0.1 - stain * 0.08;
      p.ao[i] = 1 - pit * 0.6;
      p.h[i] = mi * 0.5 + hi * 0.35 + gr * 0.2 - pit * 1.2;
    }
  }
  return finish(scene, "concrete", p, 3.5);
}

/** Packed dirt and gravel with oil stains, tile ≈ 5 m. */
function ground(scene: Scene): Surface {
  const F = fields();
  const n = 512;
  const p = new Px(n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      const lo = F.low.at(x, y);
      const lo2 = F.low.at(y + 150, x + 90);
      const mi = F.mid.at(x, y);
      const hi = F.hi.at(x + 17, y + 5);
      const gr = F.grain.at(x, y);
      const sd = F.cells.dist.at(x * 2, y * 2);
      const sid = F.cells.id.at(x * 2, y * 2);
      const cluster = smooth(0.3, 0.7, F.mid.at(x + 211, y + 97));
      const stone = smooth(0.55, 0.3, sd) * cluster * (sid > 0.3 ? 1 : 0);
      const damp = smooth(0.55, 0.75, lo);
      const oil = smooth(0.76, 0.84, lo2) * (0.7 + 0.3 * mi);
      // Dirt base.
      const dv = 0.92 + (mi - 0.5) * 0.25 + (gr - 0.5) * 0.12;
      let r = 0.4 * dv;
      let g = 0.345 * dv;
      let b = 0.29 * dv;
      r = lerp(r, r * 0.68, damp);
      g = lerp(g, g * 0.68, damp);
      b = lerp(b, b * 0.7, damp);
      p.setCol(i, r, g, b);
      const sv = 0.3 + sid * 0.18 + (hi - 0.5) * 0.08;
      p.mixCol(i, sv * 1.04, sv * 0.98, sv * 0.9, stone * 0.85);
      p.mixCol(i, 0.08, 0.075, 0.07, oil * 0.7);
      p.rough[i] = 0.93 - damp * 0.12 - oil * 0.55 - stone * 0.1;
      p.ao[i] = 1 - (1 - stone) * cluster * 0.3;
      p.h[i] = stone * 0.9 + mi * 0.25 + hi * 0.2 + gr * 0.12;
    }
  }
  return finish(scene, "ground", p, 3.0);
}

/** Corrugated shipping-container steel. One tile = 6.06 m (a 20 ft box), v spans the height. */
export const CONTAINER_TILE = 6.06;
export const CONTAINER_COLORS: Record<string, RGB> = {
  red: [0.5, 0.15, 0.1],
  teal: [0.1, 0.36, 0.38],
  mustard: [0.72, 0.52, 0.13],
  blue: [0.15, 0.25, 0.42],
  gray: [0.5, 0.5, 0.48],
};

function containers(scene: Scene): { orm: Texture; normal: Texture; albedo: Record<string, Texture> } {
  const F = fields();
  const n = 512;
  const p = new Px(n);
  const ribs = 20;
  const railTop = 13;
  const railBot = n - 17;
  const scratch = scratchMask(n, 140, 5, 30);
  const rust = new Float32Array(n * n);
  const streak = new Float32Array(n * n);
  const grime = new Float32Array(n * n);
  const fade = new Float32Array(n * n);
  const shade = new Float32Array(n * n);
  for (let y = 0; y < n; y++) {
    const v = 1 - y / n;
    const isRail = y < railTop || y >= railBot;
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      const t = ((x * ribs) / n) % 1;
      let rib: number;
      let slope = 0;
      if (t < 0.12) {
        rib = smooth(0, 1, t / 0.12);
        slope = 1;
      } else if (t < 0.5) rib = 1;
      else if (t < 0.62) {
        rib = 1 - smooth(0, 1, (t - 0.5) / 0.12);
        slope = 1;
      } else rib = 0;
      const mi = F.mid.at(x + 97, y + 31);
      const hi = F.hi.at(x, y);
      const gr = F.grain.at(x, y);
      const edge = isRail ? 0.22 : slope * 0.08;
      const bottom = smooth(0.2, 0, v) * 0.2 + smooth(0.97, 1, v) * 0.12;
      const rr = smooth(0.7, 0.8, mi * 0.7 + hi * 0.3 + edge + bottom);
      rust[i] = rr;
      // Drip streaks from the top rail.
      const col = F.hi.at(x * 3, 7);
      const len = 0.15 + F.mid.at(x * 3, 50) * 0.7;
      const s = smooth(0.62, 0.85, col) * smooth(len, 0, 1 - v) * (0.6 + 0.4 * F.hi.at(x, y >> 2));
      streak[i] = s;
      grime[i] = Math.pow(1 - v, 2.5) * 0.55 + F.mid.at(x + 400, y + 77) * 0.12;
      fade[i] = smooth(0.45, 0.9, F.low.at(x + 200, y + 50)) * 0.28;
      shade[i] = isRail ? 0.82 : 1 - (1 - rib) * 0.12;
      p.rough[i] = 0.5 + hi * 0.12 + rr * 0.4 + grime[i] * 0.12 - scratch[i] * 0.25;
      p.metal[i] = scratch[i] * 0.75 * (1 - rr);
      p.ao[i] = (isRail ? 0.85 : 1 - (1 - rib) * 0.22) * (1 - rr * 0.1);
      const railH = isRail ? 0.55 + (y < railTop ? smooth(0, 4, y) * 0.2 : smooth(n, n - 4, y) * 0.2) : rib;
      p.h[i] = railH + rr * (hi - 0.5) * 0.25 + (gr - 0.5) * 0.04;
    }
  }
  const orm = upload(scene, "containerOrm", ormCanvas(p), true);
  const normal = upload(scene, "containerNormal", normalCanvas(p.h, n, 2.6), true);
  const albedo: Record<string, Texture> = {};
  for (const [key, base] of Object.entries(CONTAINER_COLORS)) {
    for (let i = 0; i < n * n; i++) {
      const lo = F.low.at(i % n, (i / n) | 0);
      const k = 0.85 + lo * 0.3;
      let r = base[0] * k;
      let g = base[1] * k;
      let b = base[2] * k;
      // Sun-bleached, chalky paint.
      const lum = (r + g + b) / 3;
      const f = fade[i];
      r = lerp(r, lum * 1.15 + 0.05, f);
      g = lerp(g, lum * 1.12 + 0.05, f);
      b = lerp(b, lum * 1.05 + 0.04, f);
      const gm = grime[i];
      r = lerp(r, r * 0.55 + 0.03, gm);
      g = lerp(g, g * 0.55 + 0.025, gm);
      b = lerp(b, b * 0.5 + 0.015, gm);
      p.setCol(i, r * shade[i], g * shade[i], b * shade[i]);
      const hi = F.hi.at((i % n) + 13, ((i / n) | 0) + 3);
      p.mixCol(i, lerp(0.3, 0.5, hi), lerp(0.14, 0.26, hi), lerp(0.07, 0.11, hi), rust[i]);
      p.mixCol(i, 0.36, 0.19, 0.09, streak[i] * 0.55);
      p.mixCol(i, 0.52, 0.52, 0.53, scratch[i] * 0.7);
    }
    albedo[key] = upload(scene, `container_${key}`, albedoCanvas(p), false);
  }
  return { orm, normal, albedo };
}

/** Wooden crate face (each box face maps 0..1). */
function woodCrate(scene: Scene): Surface {
  const F = fields();
  const n = 512;
  const p = new Px(n);
  const fw = 62;
  const frameH = drawMask(n, (g) => {
    g.fillRect(0, 0, n, fw);
    g.fillRect(0, n - fw, n, fw);
  });
  const frameV = drawMask(n, (g) => {
    g.fillRect(0, fw, fw, n - 2 * fw);
    g.fillRect(n - fw, fw, fw, n - 2 * fw);
  });
  const brace = drawMask(n, (g) => {
    g.save();
    g.beginPath();
    g.rect(fw, fw, n - 2 * fw, n - 2 * fw);
    g.clip();
    g.lineWidth = 66;
    g.beginPath();
    g.moveTo(fw - 20, n - fw + 20);
    g.lineTo(n - fw + 20, fw - 20);
    g.stroke();
    g.restore();
  });
  const planks = 5;
  const gaps = drawMask(n, (g) => {
    for (let k = 1; k < planks; k++) {
      const y = fw + (k * (n - 2 * fw)) / planks;
      g.fillRect(0, y - 1.5, n, 3);
    }
    // Seams between frame boards and planks.
    g.fillRect(fw - 2, fw - 2, n - 2 * fw + 4, 3);
    g.fillRect(fw - 2, n - fw - 1, n - 2 * fw + 4, 3);
    g.fillRect(fw - 2, fw, 3, n - 2 * fw);
    g.fillRect(n - fw - 1, fw, 3, n - 2 * fw);
  });
  const nails = drawMask(n, (g) => {
    const pts = [
      [fw / 2, fw / 2],
      [n - fw / 2, fw / 2],
      [fw / 2, n - fw / 2],
      [n - fw / 2, n - fw / 2],
      [n / 2, fw / 2],
      [n / 2, n - fw / 2],
      [fw / 2, n / 2],
      [n - fw / 2, n / 2],
    ];
    for (const [x, y] of pts) {
      for (const o of [-12, 12]) {
        g.beginPath();
        g.arc(x + o, y + (o > 0 ? 6 : -6), 4.5, 0, Math.PI * 2);
        g.fill();
      }
    }
  });
  const stencil = drawMask(n, (g) => {
    g.font = "bold 44px Impact, 'Arial Black', sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText("SCRAPYARD", n / 2, n * 0.33);
    g.font = "bold 30px 'Arial Black', sans-serif";
    g.fillText("HANDLE WITH CARE", n / 2, n * 0.66);
    // "This way up" arrows.
    for (const ax of [n * 0.27, n * 0.73]) {
      g.beginPath();
      g.moveTo(ax, n * 0.43);
      g.lineTo(ax - 18, n * 0.5);
      g.lineTo(ax - 7, n * 0.5);
      g.lineTo(ax - 7, n * 0.57);
      g.lineTo(ax + 7, n * 0.57);
      g.lineTo(ax + 7, n * 0.5);
      g.lineTo(ax + 18, n * 0.5);
      g.closePath();
      g.fill();
    }
  });
  const boards = new Float32Array(n * n);
  for (let i = 0; i < boards.length; i++) boards[i] = Math.max(frameH[i], frameV[i], brace[i]);
  const boardBlur = blur(boards, n, 7);
  const r = rng(77);
  const plankTint = Array.from({ length: planks + 4 }, () => 0.85 + r() * 0.3);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      const lo = F.low.at(x, y);
      const gr = F.grain.at(x, y);
      let grain: number;
      let tint: number;
      if (frameV[i] > 0.5) {
        grain = F.hi.at(x * 2 + 300, y >> 3);
        tint = plankTint[x < n / 2 ? planks : planks + 1];
      } else if (frameH[i] > 0.5) {
        grain = F.hi.at(x >> 3, y * 2 + 100);
        tint = plankTint[y < n / 2 ? planks + 2 : planks + 3];
      } else if (brace[i] > 0.5) {
        const a = ((x + y) * 0.7071) | 0;
        const b = ((x - y + n) * 0.7071) | 0;
        grain = F.hi.at(b * 2, a >> 3);
        tint = 0.95;
      } else {
        grain = F.hi.at(x >> 3, y * 2);
        const k = Math.min(planks - 1, Math.max(0, Math.floor(((y - fw) / (n - 2 * fw)) * planks)));
        tint = plankTint[k];
      }
      const ridge = Math.pow(Math.abs(grain * 2 - 1), 0.6);
      const isBoard = boards[i] > 0.5;
      const wv = tint * (0.78 + 0.22 * ridge) * (0.92 + gr * 0.16) * (isBoard ? 0.9 : 1);
      p.setCol(i, 0.6 * wv, 0.45 * wv, 0.29 * wv);
      // Weathered silvery wood.
      p.mixCol(i, 0.5, 0.48, 0.44, smooth(0.5, 0.9, lo) * 0.55);
      // Dirty edges where planks meet the frame.
      const edgeAO = isBoard ? 1 : 1 - Math.max(0, boardBlur[i] - boards[i]) * 1.1;
      p.mulCol(i, edgeAO);
      p.mixCol(i, 0.12, 0.1, 0.08, stencil[i] * 0.82 * smooth(0.25, 0.6, F.mid.at(x + 50, y)));
      p.mulCol(i, 1 - gaps[i] * 0.7);
      p.mixCol(i, 0.32, 0.32, 0.33, nails[i]);
      p.rough[i] = 0.74 + grain * 0.14 + gaps[i] * 0.1 - nails[i] * 0.35;
      p.metal[i] = nails[i] * 0.85;
      p.ao[i] = edgeAO * (1 - gaps[i] * 0.6);
      p.h[i] = (isBoard ? 1 : 0.62) - gaps[i] * 0.5 + ridge * 0.06 + nails[i] * 0.2 + gr * 0.04;
    }
  }
  // Soften board edges slightly (bevel).
  const hb = blur(p.h, n, 1);
  p.h.set(hb);
  return finish(scene, "woodCrate", p, 4.0, false);
}

/** Painted steel supply crate (olive) with stamped X, rivets and worn edges. */
function metalCrate(scene: Scene): Surface {
  const F = fields();
  const n = 512;
  const p = new Px(n);
  const bw = 40;
  const border = drawMask(n, (g) => {
    g.fillRect(0, 0, n, bw);
    g.fillRect(0, n - bw, n, bw);
    g.fillRect(0, 0, bw, n);
    g.fillRect(n - bw, 0, bw, n);
  });
  const ribs = drawMask(n, (g) => {
    g.lineWidth = 26;
    g.lineCap = "round";
    g.beginPath();
    g.moveTo(bw + 30, bw + 30);
    g.lineTo(n - bw - 30, n - bw - 30);
    g.moveTo(n - bw - 30, bw + 30);
    g.lineTo(bw + 30, n - bw - 30);
    g.stroke();
  });
  const rivets = drawMask(n, (g) => {
    for (let k = 0; k < 8; k++) {
      const t = (k + 0.5) / 8;
      for (const [x, y] of [
        [t * n, bw / 2],
        [t * n, n - bw / 2],
        [bw / 2, t * n],
        [n - bw / 2, t * n],
      ]) {
        g.beginPath();
        g.arc(x, y, 5.5, 0, Math.PI * 2);
        g.fill();
      }
    }
  });
  const stencil = drawMask(n, (g) => {
    g.font = "bold 40px 'Arial Black', Impact, sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText("PARTS 07", n / 2, n * 0.5 - 0);
    g.font = "bold 22px 'Arial Black', sans-serif";
    g.fillText("NET 38 KG", n / 2, n * 0.5 + 40);
  });
  const shape = new Float32Array(n * n);
  for (let i = 0; i < shape.length; i++) shape[i] = Math.max(border[i], ribs[i] * 0.7);
  const hs = blur(shape, n, 3);
  const hs2 = blur(shape, n, 8);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      const mi = F.mid.at(x, y + 40);
      const hi = F.hi.at(x + 9, y);
      const lo = F.low.at(x + 60, y + 60);
      // Edge wear: where the bevelled height changes, plus random chipping.
      const grad = Math.abs(hs[i] - hs2[i]) * 4;
      const outer = Math.min(x, y, n - 1 - x, n - 1 - y) < 6 ? 1 : 0;
      const wear = clamp01(smooth(0.35, 0.7, grad + (mi - 0.5) * 0.6) + outer * 0.8 + smooth(0.78, 0.86, mi * 0.6 + hi * 0.4));
      const k = 0.9 + lo * 0.2;
      p.setCol(i, 0.27 * k, 0.3 * k, 0.19 * k);
      p.mixCol(i, 0.85, 0.82, 0.7, stencil[i] * smooth(0.3, 0.6, F.hi.at(x, y + 200)));
      p.mixCol(i, 0.48, 0.48, 0.5, wear);
      p.mixCol(i, 0.33, 0.2, 0.11, smooth(0.72, 0.82, F.mid.at(x + 300, y + 11)) * 0.7);
      p.mixCol(i, 0.42, 0.42, 0.44, rivets[i]);
      p.mulCol(i, 1 - smooth(0.6, 1, lo) * 0.25);
      p.rough[i] = 0.5 + hi * 0.15 - wear * 0.18 + smooth(0.6, 1, lo) * 0.2;
      p.metal[i] = Math.max(wear * 0.9, rivets[i] * 0.7);
      p.ao[i] = 1 - Math.max(0, hs2[i] - hs[i]) * 0.6;
      p.h[i] = hs[i] + rivets[i] * 0.4 + (hi - 0.5) * 0.05;
    }
  }
  return finish(scene, "metalCrate", p, 5.0, false);
}

/**
 * Steel drum. Rows 0..383 = side (v 1 → 0.25), bottom-left 128 px square = lid.
 * Returns shared ORM/normal and two albedos: explosive red and blue drum.
 */
export const DRUM_SIDE_V0 = 0.25;
export const DRUM_LID_UV = 0.25;

function drums(scene: Scene): { orm: Texture; normal: Texture; red: Texture; blue: Texture } {
  const F = fields();
  const n = 512;
  const sideRows = 384;
  const p = new Px(n);
  const scratch = scratchMask(n, 160, 9, 24);
  const rimWear = new Float32Array(n * n);
  const dirt = new Float32Array(n * n);
  const rustA = new Float32Array(n * n);
  const lidCx = 64;
  const lidCy = sideRows + 64;
  const bungs: [number, number, number][] = [
    [36, lidCy - 8, 11],
    [94, lidCy + 14, 7],
  ];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      const mi = F.mid.at(x, y);
      const hi = F.hi.at(x + 5, y + 9);
      const gr = F.grain.at(x, y);
      let h = 0.5;
      let wearEdge = 0;
      let d = 0;
      if (y < sideRows) {
        const sv = 1 - y / sideRows;
        const rim = sv < 0.04 || sv > 0.96 ? 1 : 0;
        const hoop = Math.max(smooth(0.03, 0, Math.abs(sv - 0.333)), smooth(0.03, 0, Math.abs(sv - 0.667)));
        // Low-frequency dents.
        const dent = (F.low.at(x, y) - 0.5) * 0.25;
        h = 0.5 + hoop * 0.45 + rim * 0.6 + dent;
        wearEdge = Math.max(rim * 0.7, hoop * 0.25);
        d = smooth(0.25, 0, sv) * 0.6 + smooth(0.92, 1, sv) * 0.3;
      } else if (x < 128) {
        const dx = x - lidCx;
        const dy = y - lidCy;
        const rr = Math.hypot(dx, dy);
        const ring = smooth(5, 0, Math.abs(rr - 54));
        let bung = 0;
        for (const [bx, by, br] of bungs) bung = Math.max(bung, smooth(br, br - 2, Math.hypot(x - bx, y - by)));
        h = 0.5 + ring * 0.5 + bung * 0.4 + (rr > 60 ? 0.6 : 0);
        wearEdge = Math.max(ring * 0.4, bung * 0.8, rr > 59 ? 0.8 : 0);
        d = smooth(0.4, 0.9, mi) * 0.5;
      }
      const ra = smooth(0.72, 0.82, mi * 0.6 + hi * 0.4 + wearEdge * 0.25 + d * 0.3);
      rustA[i] = ra;
      rimWear[i] = clamp01(wearEdge * smooth(0.35, 0.65, hi) + scratch[i] * 0.8);
      dirt[i] = d;
      p.rough[i] = 0.42 + hi * 0.15 + ra * 0.45 + d * 0.2 - rimWear[i] * 0.15;
      p.metal[i] = rimWear[i] * 0.85 * (1 - ra);
      p.ao[i] = 1 - d * 0.25;
      p.h[i] = h + ra * (hi - 0.5) * 0.2 + (gr - 0.5) * 0.03;
    }
  }
  const orm = upload(scene, "drumOrm", ormCanvas(p), true);
  const normal = upload(scene, "drumNormal", normalCanvas(blur(p.h, n, 1), n, 4.0), true);

  const sideDecal = (blue: boolean) =>
    drawDecal(n, (g) => {
      const svToY = (sv: number) => (1 - sv) * sideRows;
      if (!blue) {
        // Hazard stripe band near the top.
        g.save();
        g.beginPath();
        g.rect(0, svToY(0.9), n, svToY(0.82) - svToY(0.9));
        g.clip();
        g.fillStyle = "#e0a713";
        g.fillRect(0, 0, n, sideRows);
        g.fillStyle = "#151412";
        for (let k = -n; k < n * 2; k += 32) {
          g.beginPath();
          g.moveTo(k, svToY(0.9));
          g.lineTo(k + 16, svToY(0.9));
          g.lineTo(k + 16 - 30, svToY(0.82));
          g.lineTo(k - 30, svToY(0.82));
          g.closePath();
          g.fill();
        }
        g.restore();
        // Flammable diamonds on opposite sides.
        for (const cx of [n * 0.25, n * 0.75]) {
          const cy = svToY(0.53);
          const s = 58;
          g.save();
          g.translate(cx, cy);
          g.rotate(Math.PI / 4);
          g.fillStyle = "#efe6d0";
          g.fillRect(-s * 0.7, -s * 0.7, s * 1.4, s * 1.4);
          g.strokeStyle = "#b01a10";
          g.lineWidth = 5;
          g.strokeRect(-s * 0.6, -s * 0.6, s * 1.2, s * 1.2);
          g.restore();
          // Flame pictogram.
          g.fillStyle = "#141210";
          g.beginPath();
          g.moveTo(cx, cy - 34);
          g.bezierCurveTo(cx + 22, cy - 10, cx + 18, cy + 14, cx, cy + 16);
          g.bezierCurveTo(cx - 20, cy + 14, cx - 20, cy - 6, cx - 6, cy - 18);
          g.bezierCurveTo(cx - 6, cy - 6, cx + 2, cy - 4, cx, cy - 34);
          g.fill();
          g.fillRect(cx - 20, cy + 20, 40, 4);
          g.font = "bold 11px 'Arial Black', sans-serif";
          g.textAlign = "center";
          g.fillText("FLAMMABLE", cx, cy + 36);
        }
        g.font = "bold 22px 'Arial Black', Impact, sans-serif";
        g.textAlign = "center";
        g.fillStyle = "#f2ead8";
        g.fillText("DANGER", n * 0.5, svToY(0.48));
        g.fillText("DANGER", 0, svToY(0.48));
        g.fillText("DANGER", n, svToY(0.48));
      } else {
        g.fillStyle = "#e9e6dc";
        g.fillRect(0, svToY(0.58), n, svToY(0.44) - svToY(0.58));
        g.font = "bold 26px 'Arial Black', Impact, sans-serif";
        g.textAlign = "center";
        g.textBaseline = "middle";
        g.fillStyle = "#1d3a6e";
        for (const cx of [n * 0.25, n * 0.75]) g.fillText("NON-HAZ", cx, svToY(0.51));
      }
    });

  const build = (paint: RGB, blue: boolean): Texture => {
    const decal = sideDecal(blue);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const i = y * n + x;
        const lo = F.low.at(x + 20, y);
        const k = 0.88 + lo * 0.24;
        p.setCol(i, paint[0] * k, paint[1] * k, paint[2] * k);
        const a = decal[i * 4 + 3] * smooth(0.22, 0.5, F.mid.at(x + 140, y + 70) * 0.7 + F.grain.at(x, y) * 0.3);
        p.mixCol(i, decal[i * 4], decal[i * 4 + 1], decal[i * 4 + 2], a);
        const hi = F.hi.at(x, y + 30);
        p.mixCol(i, lerp(0.28, 0.46, hi), lerp(0.14, 0.24, hi), lerp(0.07, 0.1, hi), rustA[i]);
        p.mixCol(i, 0.2, 0.16, 0.12, dirt[i] * 0.6);
        p.mixCol(i, 0.5, 0.5, 0.52, rimWear[i] * 0.85);
        // Fade drips from the top rim.
        const drip = smooth(0.7, 0.9, F.hi.at(x * 4, 3)) * (y < sideRows ? smooth(0.4, 0.0, y / sideRows) : 0);
        p.mixCol(i, paint[0] * 0.45, paint[1] * 0.45, paint[2] * 0.45, drip * 0.5);
      }
    }
    return upload(scene, blue ? "drumBlueAlbedo" : "drumRedAlbedo", albedoCanvas(p), false, false);
  };
  return { orm, normal, red: build([0.56, 0.06, 0.035], false), blue: build([0.08, 0.2, 0.48], true) };
}

/** Diamond tread plate, tile ≈ 1.2 m. */
function diamondPlate(scene: Scene): Surface {
  const F = fields();
  const n = 512;
  const p = new Px(n);
  const cell = 32;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      const cx = Math.floor(x / cell);
      const cy = Math.floor(y / cell);
      const lx = (x % cell) / cell - 0.5;
      const ly = (y % cell) / cell - 0.5;
      const flip = (cx + cy) % 2 === 0 ? 1 : -1;
      const a = (lx + flip * ly) * 0.7071;
      const b = (lx - flip * ly) * 0.7071;
      const e = (a / 0.4) ** 2 + (b / 0.085) ** 2;
      const bar = e < 1 ? Math.sqrt(1 - e) : 0;
      const lo = F.low.at(x, y);
      const mi = F.mid.at(x + 33, y + 66);
      const hi = F.hi.at(x, y);
      const grime = (1 - smooth(0, 0.4, bar)) * smooth(0.35, 0.8, lo) * 0.8;
      const rust = smooth(0.74, 0.84, mi * 0.7 + hi * 0.3 + grime * 0.2);
      const v = 0.42 + (mi - 0.5) * 0.1 + bar * 0.12;
      p.setCol(i, v, v * 1.01, v * 1.03);
      p.mixCol(i, 0.17, 0.15, 0.12, grime);
      p.mixCol(i, 0.36, 0.2, 0.1, rust);
      p.rough[i] = 0.48 - bar * 0.15 + grime * 0.35 + rust * 0.4 + hi * 0.08;
      p.metal[i] = 0.9 * (1 - rust) * (1 - grime * 0.6);
      p.ao[i] = 1 - grime * 0.3;
      p.h[i] = bar * 0.8 + rust * (hi - 0.5) * 0.2;
    }
  }
  return finish(scene, "diamondPlate", p, 3.0);
}

/** Worn yellow/black hazard stripes, tile 0.6 m. */
function hazard(scene: Scene): Surface {
  const F = fields();
  const n = 256;
  const p = new Px(n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      const stripe = (x + y) % 64 < 32;
      const mi = F.mid.at(x * 2, y * 2);
      const hi = F.hi.at(x * 2, y * 2);
      const chip = smooth(0.7, 0.76, mi * 0.65 + hi * 0.35);
      if (stripe) p.setCol(i, 0.86, 0.64, 0.08);
      else p.setCol(i, 0.06, 0.06, 0.055);
      p.mulCol(i, 0.85 + F.low.at(x * 2, y * 2) * 0.25);
      p.mixCol(i, 0.42, 0.41, 0.4, chip);
      p.mixCol(i, 0.15, 0.12, 0.09, smooth(0.6, 0.9, F.low.at(x * 2 + 100, y * 2)) * 0.5);
      p.rough[i] = 0.55 + hi * 0.15 - chip * 0.15;
      p.metal[i] = chip * 0.8;
      p.h[i] = 1 - chip * 0.5 + hi * 0.05;
    }
  }
  return finish(scene, "hazard", p, 2.0);
}

/** Generic painted steel in a given colour (beams, rails, tanks), tile 1 m. */
function paintedSteel(scene: Scene, name: string, paint: RGB, seed: number): Surface {
  const F = fields();
  const n = 256;
  const p = new Px(n);
  const scratch = scratchMask(n, 50, seed, 20);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      const ox = x * 2 + seed * 31;
      const oy = y * 2 + seed * 17;
      const lo = F.low.at(ox, oy);
      const mi = F.mid.at(ox, oy);
      const hi = F.hi.at(ox, oy);
      const k = 0.88 + mi * 0.2;
      p.setCol(i, paint[0] * k, paint[1] * k, paint[2] * k);
      const rust = smooth(0.75, 0.85, mi * 0.6 + hi * 0.4);
      const grime = smooth(0.5, 0.95, lo) * 0.6;
      p.mixCol(i, paint[0] * 0.35 + 0.03, paint[1] * 0.35 + 0.025, paint[2] * 0.35 + 0.02, grime);
      p.mixCol(i, 0.36, 0.19, 0.09, rust);
      p.mixCol(i, 0.5, 0.5, 0.52, scratch[i] * 0.8);
      p.rough[i] = 0.45 + hi * 0.15 + rust * 0.4 + grime * 0.2 - scratch[i] * 0.15;
      p.metal[i] = scratch[i] * 0.8;
      p.h[i] = rust * hi * 0.4 + hi * 0.1;
    }
  }
  return finish(scene, name, p, 2.0);
}

/** Crushed car bales: crumpled patches of old paint, tile 1.6 m. */
function bale(scene: Scene): Surface {
  const F = fields();
  const n = 512;
  const p = new Px(n);
  const cellsB = worleyField(n, 5, 91);
  const palette: RGB[] = [
    [0.55, 0.08, 0.06],
    [0.1, 0.2, 0.45],
    [0.75, 0.74, 0.7],
    [0.45, 0.46, 0.47],
    [0.12, 0.3, 0.16],
    [0.06, 0.06, 0.07],
    [0.75, 0.55, 0.1],
    [0.3, 0.12, 0.25],
  ];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      // Cells squashed vertically: crushed cars compress into horizontal layers.
      const d = cellsB.dist.at(x, y * 2);
      const id = cellsB.id.at(x, y * 2);
      const hi = F.hi.at(x, y);
      const crumple = F.mid.at(x + 77, y * 4) * 0.65 + F.hi.at(x, y * 2) * 0.35;
      const mi = F.mid.at(x + 50, y + 50);
      const crease = smooth(0.42, 0.72, d) + smooth(0.58, 0.72, crumple) * 0.55;
      const c = palette[Math.floor(id * palette.length) % palette.length];
      const bare = id > 0.86 ? 1 : 0;
      const k = 0.55 + hi * 0.4;
      // Faded, chalky old paint.
      const lum = (c[0] + c[1] + c[2]) / 3;
      p.setCol(i, lerp(c[0], lum, 0.35) * k, lerp(c[1], lum, 0.35) * k, lerp(c[2], lum, 0.35) * k);
      p.mixCol(i, 0.4, 0.39, 0.38, bare);
      const rust = smooth(0.55, 0.72, mi * 0.6 + hi * 0.2 + crease * 0.25);
      p.mixCol(i, 0.32, 0.16, 0.08, rust * 0.85);
      p.mixCol(i, 0.14, 0.12, 0.1, smooth(0.6, 0.9, F.low.at(x, y)) * 0.4);
      p.mulCol(i, 1 - Math.min(1, crease) * 0.6);
      p.rough[i] = 0.5 + hi * 0.2 + rust * 0.35;
      p.metal[i] = bare * 0.85 + (1 - rust) * 0.15;
      p.ao[i] = 1 - Math.min(1, crease) * 0.5;
      p.h[i] = (1 - d) * 0.5 + crumple * 0.6 + hi * 0.2 - crease * 0.3;
    }
  }
  return finish(scene, "bale", p, 5.0);
}

/** Tyre rubber with tread grooves (u = around the tread). */
function rubber(scene: Scene): Surface {
  const F = fields();
  const n = 128;
  const p = new Px(n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      const groove = (x % 16 < 4 ? 1 : 0) * (y % 32 < 26 ? 1 : 0);
      const hi = F.hi.at(x * 4, y * 4);
      const v = 0.055 + hi * 0.03;
      p.setCol(i, v, v, v * 1.05);
      p.mixCol(i, 0.18, 0.15, 0.12, smooth(0.6, 0.9, F.low.at(x * 4, y * 4)) * 0.5);
      p.rough[i] = 0.82 + hi * 0.1;
      p.h[i] = 1 - groove * 0.8 + hi * 0.1;
    }
  }
  return finish(scene, "rubber", p, 3.0);
}

/** Chain-link fence (alpha-tested), tile 0.6 m. */
function chainLink(scene: Scene): Texture {
  const n = 256;
  const p = new Px(n);
  const alpha = new Float32Array(n * n);
  const per = 32;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      const a = (x + y) % per;
      const b = (x - y + n * 4) % per;
      const da = Math.min(a, per - a);
      const db = Math.min(b, per - b);
      const w = Math.max(smooth(2.6, 1.2, da), smooth(2.6, 1.2, db));
      alpha[i] = w;
      const v = 0.55 + F_grain(x, y) * 0.1;
      p.setCol(i, v, v, v * 1.02);
    }
  }
  return upload(scene, "chainLink", albedoCanvas(p, alpha), false, true, true);
}

function F_grain(x: number, y: number): number {
  return fields().grain.at(x, y);
}

/** Smokestack: concrete with red/white bands and soot at the top (v up). */
function stackBands(scene: Scene): Texture {
  const F = fields();
  const n = 256;
  const p = new Px(n);
  for (let y = 0; y < n; y++) {
    const v = 1 - y / n;
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      const k = 0.85 + F.mid.at(x * 2, y * 2) * 0.25;
      let c: RGB = [0.55 * k, 0.53 * k, 0.5 * k];
      if (v > 0.78 && v < 0.96) {
        const band = Math.floor((v - 0.78) / 0.045) % 2 === 0;
        c = band ? [0.62 * k, 0.1 * k, 0.07 * k] : [0.82 * k, 0.8 * k, 0.76 * k];
      }
      p.setCol(i, c[0], c[1], c[2]);
      p.mixCol(i, 0.05, 0.045, 0.04, smooth(0.9, 1, v) * 0.9 + smooth(0.55, 0.9, F.low.at(x * 2, y)) * 0.25 * v);
    }
  }
  return upload(scene, "stackBands", albedoCanvas(p), false);
}

// ---------------------------------------------------------------------------------------------
// Materials

export interface WorldMaterials {
  ground: PBRMaterial;
  concrete: PBRMaterial;
  containers: Record<string, PBRMaterial>;
  woodCrate: PBRMaterial;
  metalCrate: PBRMaterial;
  barrelRed: PBRMaterial;
  drumBlue: PBRMaterial;
  plate: PBRMaterial;
  hazard: PBRMaterial;
  steelYellow: PBRMaterial;
  steelDark: PBRMaterial;
  steelWhite: PBRMaterial;
  bale: PBRMaterial;
  rubber: PBRMaterial;
  fence: PBRMaterial;
  stack: PBRMaterial;
  distant: PBRMaterial;
  crane: PBRMaterial;
  lamp: PBRMaterial;
  beacon: PBRMaterial;
}

function pbr(scene: Scene, name: string, s: Surface | null, opts: { bump?: number; tint?: RGB } = {}): PBRMaterial {
  const m = new PBRMaterial(name, scene);
  if (s) {
    m.albedoTexture = s.albedo;
    m.metallicTexture = s.orm;
    m.useAmbientOcclusionFromMetallicTextureRed = true;
    m.useRoughnessFromMetallicTextureGreen = true;
    m.useMetallnessFromMetallicTextureBlue = true;
    m.metallic = 1;
    m.roughness = 1;
    m.bumpTexture = s.normal;
    s.normal.level = opts.bump ?? 1;
  }
  if (opts.tint) m.albedoColor = new Color3(opts.tint[0], opts.tint[1], opts.tint[2]);
  m.enableSpecularAntiAliasing = true;
  return m;
}

export function createMaterials(scene: Scene): WorldMaterials {
  const t0 = performance.now();
  const conc = concrete(scene);
  const gnd = ground(scene);
  const cont = containers(scene);
  const wood = woodCrate(scene);
  const mcrate = metalCrate(scene);
  const drum = drums(scene);
  const plate = diamondPlate(scene);
  const haz = hazard(scene);
  const yellow = paintedSteel(scene, "steelYellow", [0.8, 0.58, 0.1], 1);
  const dark = paintedSteel(scene, "steelDark", [0.2, 0.21, 0.22], 2);
  const white = paintedSteel(scene, "steelWhite", [0.78, 0.77, 0.73], 3);
  const baleS = bale(scene);
  const rub = rubber(scene);
  const fenceTex = chainLink(scene);
  const stackTex = stackBands(scene);

  const containersMat: Record<string, PBRMaterial> = {};
  for (const key of Object.keys(cont.albedo)) {
    containersMat[key] = pbr(scene, `container_${key}`, { albedo: cont.albedo[key], orm: cont.orm, normal: cont.normal }, { bump: 1 });
  }

  const fence = new PBRMaterial("fence", scene);
  fence.albedoTexture = fenceTex;
  fence.useAlphaFromAlbedoTexture = true;
  fence.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHATEST;
  fence.alphaCutOff = 0.4;
  fence.metallic = 0.85;
  fence.roughness = 0.45;
  fence.backFaceCulling = false;
  fence.twoSidedLighting = true;

  const stack = pbr(scene, "stack", null);
  stack.albedoTexture = stackTex;
  stack.metallic = 0;
  stack.roughness = 0.9;

  const distant = pbr(scene, "distant", { albedo: cont.albedo.gray, orm: cont.orm, normal: cont.normal }, { bump: 0.6 });

  const crane = pbr(scene, "crane", yellow, { bump: 0.5 });

  const lamp = new PBRMaterial("lamp", scene);
  lamp.albedoColor = new Color3(0.9, 0.85, 0.75);
  lamp.emissiveColor = new Color3(1.0, 0.82, 0.55);
  lamp.emissiveIntensity = 2.2;
  lamp.metallic = 0;
  lamp.roughness = 0.4;

  const beacon = new PBRMaterial("beacon", scene);
  beacon.albedoColor = new Color3(0.3, 0.02, 0.02);
  beacon.emissiveColor = new Color3(1, 0.08, 0.04);
  beacon.emissiveIntensity = 3;
  beacon.metallic = 0;
  beacon.roughness = 0.3;

  const mats: WorldMaterials = {
    ground: pbr(scene, "ground", gnd, { bump: 0.9 }),
    concrete: pbr(scene, "concrete", conc, { bump: 0.8 }),
    containers: containersMat,
    woodCrate: pbr(scene, "woodCrate", wood, { bump: 1 }),
    metalCrate: pbr(scene, "metalCrate", mcrate, { bump: 1 }),
    barrelRed: pbr(scene, "barrelRed", { albedo: drum.red, orm: drum.orm, normal: drum.normal }, { bump: 1 }),
    drumBlue: pbr(scene, "drumBlue", { albedo: drum.blue, orm: drum.orm, normal: drum.normal }, { bump: 1 }),
    plate: pbr(scene, "plate", plate, { bump: 1 }),
    hazard: pbr(scene, "hazard", haz, { bump: 0.6 }),
    steelYellow: pbr(scene, "steelYellow", yellow, { bump: 0.6 }),
    steelDark: pbr(scene, "steelDark", dark, { bump: 0.6 }),
    steelWhite: pbr(scene, "steelWhite", white, { bump: 0.6 }),
    bale: pbr(scene, "bale", baleS, { bump: 1 }),
    rubber: pbr(scene, "rubber", rub, { bump: 1 }),
    fence,
    stack,
    distant,
    crane,
    lamp,
    beacon,
  };
  // Metal surfaces benefit from a slightly darker diffuse IBL so they read as metal.
  console.info(`[world] procedural textures generated in ${(performance.now() - t0).toFixed(0)} ms`);
  return mats;
}
