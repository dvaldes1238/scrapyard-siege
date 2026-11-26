import {
  Matrix,
  Mesh,
  PhysicsBody,
  PhysicsMotionType,
  PhysicsShapeBox,
  PhysicsShapeCylinder,
  Quaternion,
  TransformNode,
  Vector3,
  VertexData,
  type PhysicsShape,
  type Scene,
} from "@babylonjs/core";

/**
 * Geometry helpers: a vertex accumulator ("Geo") that merges many boxes/prisms into one mesh
 * per material (few draw calls), with UV mapping callbacks, plus static Havok colliders that
 * live on plain TransformNodes so visuals and physics are decoupled.
 *
 * Babylon front faces: for triangle (a, b, c), cross(b - a, c - a) points AWAY from the
 * outward normal (left-handed, clockwise). Every triangle is checked and flipped if needed.
 */

export type V3 = [number, number, number];

/** One face of a box being built: outward normal, right and up axes, half sizes. */
export interface FaceFrame {
  n: V3;
  r: V3;
  u: V3;
  /** Half extent along r. */
  hw: number;
  /** Half extent along u. */
  hh: number;
  /** "side" faces have u = +Y. */
  kind: "side" | "top" | "bottom";
  /** Full box size (local). */
  size: V3;
}

/** Maps a local corner position (relative to box centre) on a face to UV. */
export type UVFn = (f: FaceFrame, p: V3) => [number, number];

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** World-scaled tiling UVs (texture repeats every `tile` metres). */
export const uvWorld =
  (tile: number, tileV = tile, offU = 0, offV = 0): UVFn =>
  (f, p) => [(dot(p, f.r) + f.hw) / tile + offU, (dot(p, f.u) + f.hh) / tileV + offV];

/** Each face maps the full 0..1 texture (crates). */
export const uvFace: UVFn = (f, p) => [(dot(p, f.r) + f.hw) / (2 * f.hw), (dot(p, f.u) + f.hh) / (2 * f.hh)];

/** Shipping containers: v spans the full height on sides; u tiles every `tile` metres. */
export const uvContainer =
  (tile: number, offU = 0): UVFn =>
  (f, p) => {
    const u = (dot(p, f.r) + f.hw) / tile + offU;
    if (f.kind === "side") return [u, (p[1] + f.hh) / (2 * f.hh)];
    return [u, (dot(p, f.u) + f.hh) / (2 * f.hh) * 0.08 + 0.45];
  };

const FACES: { n: V3; r: V3; u: V3; kind: FaceFrame["kind"] }[] = [
  { n: [0, 0, 1], r: [-1, 0, 0], u: [0, 1, 0], kind: "side" },
  { n: [0, 0, -1], r: [1, 0, 0], u: [0, 1, 0], kind: "side" },
  { n: [1, 0, 0], r: [0, 0, 1], u: [0, 1, 0], kind: "side" },
  { n: [-1, 0, 0], r: [0, 0, -1], u: [0, 1, 0], kind: "side" },
  { n: [0, 1, 0], r: [1, 0, 0], u: [0, 0, 1], kind: "top" },
  { n: [0, -1, 0], r: [-1, 0, 0], u: [0, 0, 1], kind: "bottom" },
];

const tmpM = new Matrix();
const tmpV = new Vector3();
const tmpN = new Vector3();
const FWD = new Vector3(0, 0, 1);

export class Geo {
  positions: number[] = [];
  normals: number[] = [];
  uvs: number[] = [];
  indices: number[] = [];
  colors: number[] | null = null;

  get vertexCount(): number {
    return this.positions.length / 3;
  }

  /** Adds a triangle-list polygon (quad/fan) with a flat normal, fixing winding. */
  private pushPoly(pts: V3[], uvs: [number, number][], n: V3, color?: [number, number, number, number]): void {
    const base = this.vertexCount;
    for (let i = 0; i < pts.length; i++) {
      this.positions.push(pts[i][0], pts[i][1], pts[i][2]);
      this.normals.push(n[0], n[1], n[2]);
      this.uvs.push(uvs[i][0], uvs[i][1]);
      if (this.colors) {
        const c = color ?? [1, 1, 1, 1];
        this.colors.push(c[0], c[1], c[2], c[3]);
      }
    }
    for (let i = 1; i < pts.length - 1; i++) {
      const a = pts[0];
      const b = pts[i];
      const c = pts[i + 1];
      const e1: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const e2: V3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const cr: V3 = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      if (dot(cr, n) < 0) this.indices.push(base, base + i, base + i + 1);
      else this.indices.push(base, base + i + 1, base + i);
    }
  }

  /**
   * Box centred at `center` with full `size`, optional rotation. UVs computed in the box's
   * local frame, so they stay attached when rotated.
   */
  addBox(center: Vector3, size: Vector3 | V3, uv: UVFn, rot?: Quaternion | null, color?: [number, number, number, number]): this {
    const s: V3 = size instanceof Vector3 ? [size.x, size.y, size.z] : size;
    const h: V3 = [s[0] / 2, s[1] / 2, s[2] / 2];
    if (rot) Matrix.FromQuaternionToRef(rot, tmpM);
    for (const f of FACES) {
      const axisN = f.n[0] !== 0 ? 0 : f.n[1] !== 0 ? 1 : 2;
      const axisR = f.r[0] !== 0 ? 0 : f.r[1] !== 0 ? 1 : 2;
      const axisU = f.u[0] !== 0 ? 0 : f.u[1] !== 0 ? 1 : 2;
      const hw = h[axisR];
      const hh = h[axisU];
      const frame: FaceFrame = { n: f.n, r: f.r, u: f.u, hw, hh, kind: f.kind, size: s };
      const c: V3 = [f.n[0] * h[axisN], f.n[1] * h[axisN], f.n[2] * h[axisN]];
      const corners: V3[] = [];
      const uvs: [number, number][] = [];
      for (const [sr, su] of [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ]) {
        const p: V3 = [
          c[0] + f.r[0] * hw * sr + f.u[0] * hh * su,
          c[1] + f.r[1] * hw * sr + f.u[1] * hh * su,
          c[2] + f.r[2] * hw * sr + f.u[2] * hh * su,
        ];
        uvs.push(uv(frame, p));
        if (rot) {
          Vector3.TransformCoordinatesFromFloatsToRef(p[0], p[1], p[2], tmpM, tmpV);
          corners.push([tmpV.x + center.x, tmpV.y + center.y, tmpV.z + center.z]);
        } else {
          corners.push([p[0] + center.x, p[1] + center.y, p[2] + center.z]);
        }
      }
      let n: V3 = f.n;
      if (rot) {
        Vector3.TransformNormalFromFloatsToRef(f.n[0], f.n[1], f.n[2], tmpM, tmpN);
        n = [tmpN.x, tmpN.y, tmpN.z];
      }
      this.pushPoly(corners, uvs, n, color);
    }
    return this;
  }

  /** Square beam of `thickness` from a to b (braces, chords, rails). */
  addBeam(a: Vector3, b: Vector3, thickness: number, uv: UVFn, thicknessY = thickness): this {
    const d = b.subtract(a);
    const len = d.length();
    if (len < 1e-4) return this;
    d.scaleInPlace(1 / len);
    const q = new Quaternion();
    if (Vector3.Dot(d, FWD) < -0.9999) Quaternion.RotationAxisToRef(Vector3.UpReadOnly, Math.PI, q);
    else Quaternion.FromUnitVectorsToRef(FWD, d, q);
    return this.addBox(a.add(b).scaleInPlace(0.5), [thickness, thicknessY, len], uv, q);
  }

  /**
   * Convex profile (points [z, y] in the YZ plane, any winding) extruded along local X by
   * `length`, then rotated by yaw about Y and translated. Flat-shaded, world-scaled UVs.
   */
  addPrism(profile: [number, number][], length: number, center: Vector3, yaw: number, tile: number): this {
    const rot = Quaternion.RotationYawPitchRoll(yaw, 0, 0);
    Matrix.FromQuaternionToRef(rot, tmpM);
    const xf = (p: V3): V3 => {
      Vector3.TransformCoordinatesFromFloatsToRef(p[0], p[1], p[2], tmpM, tmpV);
      return [tmpV.x + center.x, tmpV.y + center.y, tmpV.z + center.z];
    };
    const xn = (n: V3): V3 => {
      Vector3.TransformNormalFromFloatsToRef(n[0], n[1], n[2], tmpM, tmpN);
      return [tmpN.x, tmpN.y, tmpN.z];
    };
    let cz = 0;
    let cy = 0;
    for (const [z, y] of profile) {
      cz += z;
      cy += y;
    }
    cz /= profile.length;
    cy /= profile.length;
    const hl = length / 2;
    let perim = 0;
    for (let i = 0; i < profile.length; i++) {
      const [z0, y0] = profile[i];
      const [z1, y1] = profile[(i + 1) % profile.length];
      const ez = z1 - z0;
      const ey = y1 - y0;
      const el = Math.hypot(ez, ey);
      // Outward normal in the YZ plane.
      let nz = ey / el;
      let ny = -ez / el;
      const mz = (z0 + z1) / 2 - cz;
      const my = (y0 + y1) / 2 - cy;
      if (nz * mz + ny * my < 0) {
        nz = -nz;
        ny = -ny;
      }
      const pts: V3[] = [
        [-hl, y0, z0],
        [hl, y0, z0],
        [hl, y1, z1],
        [-hl, y1, z1],
      ];
      const uvs: [number, number][] = [
        [0, perim / tile],
        [length / tile, perim / tile],
        [length / tile, (perim + el) / tile],
        [0, (perim + el) / tile],
      ];
      perim += el;
      this.pushPoly(pts.map(xf), uvs, xn([0, ny, nz]));
    }
    for (const side of [-1, 1]) {
      const pts: V3[] = profile.map(([z, y]) => xf([side * hl, y, z]));
      const uvs: [number, number][] = profile.map(([z, y]) => [z / tile, y / tile]);
      this.pushPoly(pts, uvs, xn([side, 0, 0]));
    }
    return this;
  }

  /** Builds the mesh (static by default: world matrix frozen by caller when placed). */
  build(name: string, scene: Scene): Mesh {
    const mesh = new Mesh(name, scene);
    const vd = new VertexData();
    vd.positions = this.positions;
    vd.normals = this.normals;
    vd.uvs = this.uvs;
    vd.indices = this.indices;
    if (this.colors) vd.colors = this.colors;
    vd.applyToMesh(mesh, false);
    return mesh;
  }
}

/** Static Havok colliders on bare TransformNodes; box shapes are shared by size. */
export class Colliders {
  private shapes = new Map<string, PhysicsShape>();
  readonly nodes: TransformNode[] = [];
  private count = 0;

  constructor(private scene: Scene) {}

  private boxShape(size: Vector3): PhysicsShape {
    const key = `b${size.x.toFixed(3)}_${size.y.toFixed(3)}_${size.z.toFixed(3)}`;
    let s = this.shapes.get(key);
    if (!s) {
      s = new PhysicsShapeBox(Vector3.Zero(), Quaternion.Identity(), size.clone(), this.scene);
      s.material = { friction: 0.8, restitution: 0.05 };
      this.shapes.set(key, s);
    }
    return s;
  }

  private cylShape(radius: number, height: number): PhysicsShape {
    const key = `c${radius.toFixed(3)}_${height.toFixed(3)}`;
    let s = this.shapes.get(key);
    if (!s) {
      s = new PhysicsShapeCylinder(new Vector3(0, -height / 2, 0), new Vector3(0, height / 2, 0), radius, this.scene);
      s.material = { friction: 0.8, restitution: 0.05 };
      this.shapes.set(key, s);
    }
    return s;
  }

  private body(center: Vector3, rot: Quaternion | null, shape: PhysicsShape): PhysicsBody {
    const node = new TransformNode(`col${this.count++}`, this.scene);
    node.position.copyFrom(center);
    if (rot) node.rotationQuaternion = rot.clone();
    node.computeWorldMatrix(true);
    const body = new PhysicsBody(node, PhysicsMotionType.STATIC, false, this.scene);
    body.shape = shape;
    node.freezeWorldMatrix();
    this.nodes.push(node);
    return body;
  }

  box(center: Vector3, size: Vector3 | V3, yaw = 0, rot?: Quaternion): PhysicsBody {
    const s = size instanceof Vector3 ? size : new Vector3(size[0], size[1], size[2]);
    const q = rot ?? (yaw !== 0 ? Quaternion.RotationYawPitchRoll(yaw, 0, 0) : null);
    return this.body(center, q, this.boxShape(s));
  }

  cylinder(center: Vector3, radius: number, height: number): PhysicsBody {
    return this.body(center, null, this.cylShape(radius, height));
  }
}

/** Scales a mesh's UVs in place (for builder meshes like ground planes). */
export function scaleUVs(mesh: Mesh, su: number, sv: number): void {
  const uvs = mesh.getVerticesData("uv");
  if (!uvs) return;
  for (let i = 0; i < uvs.length; i += 2) {
    uvs[i] *= su;
    uvs[i + 1] *= sv;
  }
  mesh.updateVerticesData("uv", uvs);
}
