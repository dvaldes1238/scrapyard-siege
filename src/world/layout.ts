import {
  Matrix,
  Mesh,
  MeshBuilder,
  Quaternion,
  Vector3,
  VertexBuffer,
  type Material,
  type Scene,
} from "@babylonjs/core";
import { markNoHit } from "../core/damage";
import type { Environment } from "./environment";
import { Colliders, Geo, scaleUVs, uvContainer, uvFace, uvWorld } from "./geometry";
import { rng, valueNoise } from "./noise";
import { CONTAINER_TILE, type WorldMaterials } from "./textures";

/** Arena dimensions (metres). Walkable area is ±ARENA; walls' inner faces sit at ±WALL_IN. */
export const ARENA = 34;
export const WALL_IN = 36.4;
const WALL_T = 1.0;
const WALL_H = 6;
export const C20 = 6.06;
export const C40 = 12.19;
export const CW = 2.44;
export const CH = 2.59;

/** Player feet position: open ground on the south side, facing north (+Z) into the arena. */
export const PLAYER_SPAWN = new Vector3(0, 0, -28);

/** Drone entry points high up near the walls (inside the bounds, clear of container stacks). */
export const ENEMY_SPAWNS = [
  new Vector3(-30, 7.5, 30),
  new Vector3(-8, 8.5, 31),
  new Vector3(12, 8, 31),
  new Vector3(30, 7, 30),
  new Vector3(31, 8, 8),
  new Vector3(30, 7, -18),
  new Vector3(-31, 8.5, 6),
  new Vector3(-30, 7, -20),
];

/** Platform deck top height and footprint. */
export const DECK_Y = 3.0;
export const DECK = { x0: -6, x1: 6, z0: 6, z1: 10 };

interface GroupOpts {
  cast?: boolean;
  pickable?: boolean;
  receive?: boolean;
}

/** One merged mesh per material (+flags). */
class GeoSet {
  private groups = new Map<string, { geo: Geo; mat: Material; opts: GroupOpts }>();
  constructor(
    private scene: Scene,
    private env: Environment,
  ) {}
  get(key: string, mat: Material, opts: GroupOpts = {}): Geo {
    let g = this.groups.get(key);
    if (!g) {
      g = { geo: new Geo(), mat, opts };
      this.groups.set(key, g);
    }
    return g.geo;
  }
  build(): Mesh[] {
    const out: Mesh[] = [];
    for (const [key, { geo, mat, opts }] of this.groups) {
      if (geo.vertexCount === 0) continue;
      const mesh = geo.build(key, this.scene);
      mesh.material = mat;
      mesh.receiveShadows = opts.receive ?? true;
      if (opts.cast ?? true) this.env.shadows.addShadowCaster(mesh, false);
      if (opts.pickable === false) markNoHit(mesh);
      mesh.freezeWorldMatrix();
      mesh.doNotSyncBoundingInfo = true;
      out.push(mesh);
    }
    return out;
  }
}

export interface Layout {
  meshes: Mesh[];
  steamVent: Vector3;
  smokeStacks: Vector3[];
  beaconMeshes: Mesh[];
}

export function buildLayout(scene: Scene, env: Environment, mats: WorldMaterials): Layout {
  const geos = new GeoSet(scene, env);
  const col = new Colliders(scene);
  const r = rng(1337);
  const meshes: Mesh[] = [];

  // ---------------------------------------------------------------------------------------------
  // Ground: thick static box for physics, textured floor with vertex-colour variation on top.
  col.box(new Vector3(0, -1, 0), [400, 2, 400]);

  const floorSize = 80;
  const floor = MeshBuilder.CreateGround("floor", { width: floorSize, height: floorSize, subdivisions: 32 }, scene);
  scaleUVs(floor, floorSize / 5, floorSize / 5);
  const pos = floor.getVerticesData(VertexBuffer.PositionKind)!;
  const colors = new Float32Array((pos.length / 3) * 4);
  for (let i = 0; i < pos.length / 3; i++) {
    const x = pos[i * 3];
    const z = pos[i * 3 + 2];
    const n1 = valueNoise(x / 9 + 50, z / 9 + 50, 1024, 5);
    const n2 = valueNoise(x / 3.5 + 10, z / 3.5 + 10, 1024, 9);
    const edge = Math.max(Math.abs(x), Math.abs(z));
    let v = 0.78 + n1 * 0.32 + (n2 - 0.5) * 0.12;
    v *= 1 - Math.max(0, Math.min(1, (edge - 30) / 6)) * 0.25;
    colors[i * 4] = v * 1.02;
    colors[i * 4 + 1] = v;
    colors[i * 4 + 2] = v * 0.96;
    colors[i * 4 + 3] = 1;
  }
  floor.setVerticesData(VertexBuffer.ColorKind, colors);
  floor.material = mats.ground;
  floor.receiveShadows = true;
  floor.freezeWorldMatrix();
  meshes.push(floor);

  const outer = MeshBuilder.CreateGround("outerGround", { width: 640, height: 640, subdivisions: 4 }, scene);
  scaleUVs(outer, 640 / 5, 640 / 5);
  outer.position.y = -0.05;
  outer.material = mats.ground;
  outer.receiveShadows = true;
  outer.isPickable = false;
  outer.freezeWorldMatrix();
  meshes.push(outer);

  // ---------------------------------------------------------------------------------------------
  // Perimeter: precast concrete panels, chain-link fence on top, colliders per side.
  const wallGeo = geos.get("walls", mats.concrete);
  const fenceGeo = geos.get("fence", mats.fence, { cast: true, pickable: false });
  const fencePostGeo = geos.get("fencePosts", mats.steelDark, { pickable: false });
  const span = WALL_IN + WALL_T;
  const panelW = 4.2;
  const panels = Math.ceil((span * 2) / panelW);
  const sides: { axis: "x" | "z"; sign: number }[] = [
    { axis: "z", sign: 1 },
    { axis: "z", sign: -1 },
    { axis: "x", sign: 1 },
    { axis: "x", sign: -1 },
  ];
  for (const side of sides) {
    const along = side.axis === "z" ? "x" : "z";
    const c = side.sign * (WALL_IN + WALL_T / 2);
    for (let k = 0; k < panels; k++) {
      const a = -span + panelW * (k + 0.5);
      const h = WALL_H + (r() - 0.5) * 0.5;
      const center = along === "x" ? new Vector3(a, h / 2, c) : new Vector3(c, h / 2, a);
      const size: [number, number, number] = along === "x" ? [panelW - 0.05, h, WALL_T] : [WALL_T, h, panelW - 0.05];
      wallGeo.addBox(center, size, uvWorld(3, 3, r(), r()));
      // Fence post.
      const pc = along === "x" ? new Vector3(a - panelW / 2, WALL_H + 0.85, c) : new Vector3(c, WALL_H + 0.85, a - panelW / 2);
      fencePostGeo.addBox(pc, [0.08, 1.7, 0.08], uvWorld(1));
    }
    // Fence mesh: a thin sheet; rail on top.
    const fc = along === "x" ? new Vector3(0, WALL_H + 0.8, c) : new Vector3(c, WALL_H + 0.8, 0);
    const fs: [number, number, number] = along === "x" ? [span * 2, 1.6, 0.01] : [0.01, 1.6, span * 2];
    fenceGeo.addBox(fc, fs, uvWorld(0.6));
    const ra = along === "x" ? new Vector3(-span, WALL_H + 1.65, c) : new Vector3(c, WALL_H + 1.65, -span);
    const rb = along === "x" ? new Vector3(span, WALL_H + 1.65, c) : new Vector3(c, WALL_H + 1.65, span);
    fencePostGeo.addBeam(ra, rb, 0.06, uvWorld(1));
    // Collider (tall enough that nothing escapes).
    const cc = along === "x" ? new Vector3(0, 4, c) : new Vector3(c, 4, 0);
    col.box(cc, along === "x" ? [span * 2 + 2, 8, WALL_T] : [WALL_T, 8, span * 2 + 2]);
  }

  // ---------------------------------------------------------------------------------------------
  // Shipping containers.
  const postGeo = geos.get("containerPosts", mats.steelDark, { pickable: false });
  const colorKeys = ["red", "teal", "mustard", "blue"];
  const addContainer = (x: number, z: number, yaw: number, len: number, level: number, color?: string) => {
    const key = color ?? colorKeys[Math.floor(r() * colorKeys.length)];
    const g = geos.get(`container_${key}`, mats.containers[key]);
    const y = CH / 2 + level * (CH + 0.003);
    const center = new Vector3(x, y, z);
    const flip = r() < 0.5 ? Math.PI : 0;
    const q = Quaternion.RotationYawPitchRoll(yaw + flip, 0, 0);
    g.addBox(center, [len, CH, CW], uvContainer(CONTAINER_TILE, Math.floor(r() * 4) * 0.25), q);
    // Corner posts (protrude 1 cm) and door locking bars on one end.
    const hx = len / 2 - 0.09;
    const hz = CW / 2 - 0.09;
    for (const [px, pz] of [
      [hx, hz],
      [-hx, hz],
      [hx, -hz],
      [-hx, -hz],
    ]) {
      const p = rotateY(new Vector3(px, 0, pz), yaw + flip);
      postGeo.addBox(center.add(p), [0.2, CH + 0.004, 0.2], uvWorld(1), q);
    }
    for (const bz of [-0.85, -0.35, 0.35, 0.85]) {
      const local = new Vector3(len / 2 + 0.03, 0, bz);
      const p = rotateY(local, yaw + flip);
      postGeo.addBox(center.add(p), [0.05, CH * 0.92, 0.05], uvWorld(1), q);
    }
    col.box(center, [len, CH, CW], 0, q);
  };

  // Perimeter stacks: [position along side, length, levels].
  const perimeter: { side: "N" | "S" | "E" | "W"; at: number; len: number; levels: number }[] = [
    { side: "N", at: -27, len: C20, levels: 2 },
    { side: "N", at: -20.5, len: C20, levels: 1 },
    { side: "N", at: -8, len: C40, levels: 2 },
    { side: "N", at: 6, len: C20, levels: 3 },
    { side: "N", at: 14, len: C20, levels: 1 },
    { side: "N", at: 24, len: C40, levels: 2 },
    { side: "E", at: -26, len: C20, levels: 1 },
    { side: "E", at: -18, len: C40, levels: 2 },
    { side: "E", at: -4, len: C20, levels: 2 },
    { side: "E", at: 3, len: C20, levels: 1 },
    { side: "E", at: 16, len: C20, levels: 3 },
    { side: "E", at: 25.5, len: C40, levels: 2 },
    { side: "S", at: -27, len: C40, levels: 2 },
    { side: "S", at: -14, len: C20, levels: 1 },
    { side: "S", at: 12, len: C20, levels: 2 },
    { side: "S", at: 20, len: C20, levels: 1 },
    { side: "S", at: 28.5, len: C20, levels: 3 },
    { side: "W", at: -25, len: C20, levels: 2 },
    { side: "W", at: -12, len: C40, levels: 1 },
    { side: "W", at: 2, len: C20, levels: 3 },
    { side: "W", at: 9, len: C20, levels: 1 },
    { side: "W", at: 22, len: C40, levels: 2 },
  ];
  const edge = WALL_IN - CW / 2 - 0.02;
  for (const s of perimeter) {
    for (let lv = 0; lv < s.levels; lv++) {
      const jitter = lv === 0 ? 0 : (r() - 0.5) * 0.5;
      const yawJ = lv === 0 ? 0 : (r() - 0.5) * 0.05;
      // Upper boxes are pulled slightly towards the wall so they never overhang the arena.
      const inset = lv === 0 ? 0 : 0.05;
      let x = 0;
      let z = 0;
      let yaw = 0;
      if (s.side === "N") [x, z, yaw] = [s.at + jitter, edge + inset, 0];
      if (s.side === "S") [x, z, yaw] = [s.at + jitter, -edge - inset, 0];
      if (s.side === "E") [x, z, yaw] = [edge + inset, s.at + jitter, Math.PI / 2];
      if (s.side === "W") [x, z, yaw] = [-edge - inset, s.at + jitter, Math.PI / 2];
      addContainer(x, z, yaw + yawJ, s.len, lv);
    }
  }

  // Interior cover stacks.
  addContainer(-22, 15, Math.PI / 2, C20, 0, "teal");
  addContainer(-19.4, 15, Math.PI / 2, C20, 0, "red");
  addContainer(-20.7, 15.3, Math.PI / 2 + 0.035, C20, 1, "mustard");
  addContainer(19, 17, Math.PI / 2, C40, 0, "mustard");
  addContainer(19, 20, Math.PI / 2 - 0.035, C20, 1, "red");
  addContainer(22, -11, 0.35, C20, 0, "blue");
  addContainer(22.2, -11.1, 0.4, C20, 1, "teal");
  addContainer(-17, -14, -0.52, C20, 0, "red");
  addContainer(7, -15, 1.31, C20, 0, "teal");

  // ---------------------------------------------------------------------------------------------
  // Jersey barriers (precast concrete) as low cover.
  const jersey: [number, number][] = [
    [-0.305, 0],
    [0.305, 0],
    [0.305, 0.075],
    [0.18, 0.33],
    [0.075, 0.81],
    [-0.075, 0.81],
    [-0.18, 0.33],
    [-0.305, 0.075],
  ];
  const barrierGeo = geos.get("barriers", mats.concrete);
  const barrierStripeGeo = geos.get("barrierStripes", mats.hazard, { cast: false });
  const barriers: [number, number, number][] = [
    [-4.5, -19, 0],
    [-1.4, -19.3, 0.14],
    [12, -22, 1.05],
    [-13, -3, Math.PI / 2],
    [-13, 0.1, Math.PI / 2],
    [10, 1.5, 0.44],
    [-27, 3, 0],
    [27, 2, Math.PI / 2],
    [27, 5.1, Math.PI / 2],
    [-3, 22, 0],
    [0.1, 22, 0],
    [26, 27, -0.7],
    [-27, -27, 0.79],
  ];
  for (const [x, z, yaw] of barriers) {
    const c = new Vector3(x, 0, z);
    barrierGeo.addPrism(jersey, 3.0, c, yaw, 2);
    // Reflective hazard band on both slopes near the top.
    const q = Quaternion.RotationYawPitchRoll(yaw, 0, 0);
    for (const sgn of [-1, 1]) {
      const local = new Vector3(0, 0.62, sgn * 0.124);
      const p = rotateY(local, yaw);
      const tilt = Quaternion.RotationYawPitchRoll(yaw, sgn * -0.22, 0);
      barrierStripeGeo.addBox(c.add(p), [2.2, 0.16, 0.012], uvWorld(0.6), tilt);
    }
    col.box(new Vector3(x, 0.41, z), [3.0, 0.82, 0.5], 0, q);
  }

  // ---------------------------------------------------------------------------------------------
  // Raised steel platform with a ramp (verticality) — deck at y = 3.
  const plateGeo = geos.get("plate", mats.plate);
  const steelGeo = geos.get("steelDark", mats.steelDark);
  const yellowGeo = geos.get("steelYellow", mats.steelYellow, { pickable: false });
  const hazardGeo = geos.get("hazardTrim", mats.hazard);
  const deckT = 0.2;
  const deckC = new Vector3((DECK.x0 + DECK.x1) / 2, DECK_Y - deckT / 2, (DECK.z0 + DECK.z1) / 2);
  const deckS = new Vector3(DECK.x1 - DECK.x0, deckT, DECK.z1 - DECK.z0);
  plateGeo.addBox(deckC, deckS, uvWorld(1.2));
  col.box(deckC, deckS);
  // Hazard trim around the deck edge.
  hazardGeo.addBox(new Vector3(0, DECK_Y - 0.11, DECK.z0 - 0.03), [deckS.x + 0.06, 0.24, 0.06], uvWorld(0.6));
  hazardGeo.addBox(new Vector3(0, DECK_Y - 0.11, DECK.z1 + 0.03), [deckS.x + 0.06, 0.24, 0.06], uvWorld(0.6));
  hazardGeo.addBox(new Vector3(DECK.x1 + 0.03, DECK_Y - 0.11, deckC.z), [0.06, 0.24, deckS.z], uvWorld(0.6));
  // Support posts, beams and bracing.
  const postXs = [DECK.x0 + 0.15, 0, DECK.x1 - 0.15];
  const postZs = [DECK.z0 + 0.15, DECK.z1 - 0.15];
  for (const px of postXs) {
    for (const pz of postZs) {
      const c = new Vector3(px, (DECK_Y - deckT) / 2, pz);
      steelGeo.addBox(c, [0.3, DECK_Y - deckT, 0.3], uvWorld(1));
      col.box(c, [0.3, DECK_Y - deckT, 0.3]);
    }
  }
  for (const pz of postZs) {
    steelGeo.addBox(new Vector3(0, DECK_Y - deckT - 0.12, pz), [deckS.x, 0.24, 0.18], uvWorld(1));
  }
  for (const px of postXs) steelGeo.addBox(new Vector3(px, DECK_Y - deckT - 0.12, deckC.z), [0.16, 0.24, deckS.z - 0.3], uvWorld(1));
  // X-bracing on the north face (with a collider so it reads as a wall).
  const bz = DECK.z1 - 0.15;
  for (let k = 0; k < postXs.length - 1; k++) {
    const x0 = postXs[k];
    const x1 = postXs[k + 1];
    steelGeo.addBeam(new Vector3(x0, 0.2, bz), new Vector3(x1, DECK_Y - 0.4, bz), 0.1, uvWorld(1));
    steelGeo.addBeam(new Vector3(x0, DECK_Y - 0.4, bz), new Vector3(x1, 0.2, bz), 0.1, uvWorld(1));
  }
  col.box(new Vector3(0, (DECK_Y - deckT) / 2, bz), [deckS.x, DECK_Y - deckT, 0.12]);
  // Railings: north edge and east end (south side open to drop down).
  const railH = 1.05;
  const railN = DECK.z1 - 0.06;
  const railE = DECK.x1 - 0.06;
  for (let x = DECK.x0 + 0.1; x <= DECK.x1 + 0.01; x += 2) {
    yellowGeo.addBox(new Vector3(x, DECK_Y + railH / 2, railN), [0.06, railH, 0.06], uvWorld(1));
  }
  for (const z of [DECK.z0 + 0.1, deckC.z, railN]) yellowGeo.addBox(new Vector3(railE, DECK_Y + railH / 2, z), [0.06, railH, 0.06], uvWorld(1));
  for (const hy of [railH, railH * 0.5]) {
    yellowGeo.addBeam(new Vector3(DECK.x0 + 0.1, DECK_Y + hy, railN), new Vector3(railE, DECK_Y + hy, railN), 0.055, uvWorld(1));
    yellowGeo.addBeam(new Vector3(railE, DECK_Y + hy, railN), new Vector3(railE, DECK_Y + hy, DECK.z0 + 0.1), 0.055, uvWorld(1));
  }
  col.box(new Vector3(0, DECK_Y + 0.55, railN), [deckS.x, 1.1, 0.12]);
  col.box(new Vector3(railE, DECK_Y + 0.55, deckC.z), [0.12, 1.1, deckS.z]);

  // Ramp down to the west.
  const rampRun = 7.5;
  const rampAngle = Math.atan2(DECK_Y, rampRun);
  const rampLen = Math.hypot(DECK_Y, rampRun) + 0.12;
  const rampW = 2.6;
  const rampQ = Quaternion.RotationYawPitchRoll(0, 0, rampAngle);
  const rampMidTop = new Vector3(DECK.x0 - rampRun / 2, DECK_Y / 2, deckC.z);
  const rampN = new Vector3(-Math.sin(rampAngle), Math.cos(rampAngle), 0);
  const rampC = rampMidTop.subtract(rampN.scale(0.1));
  plateGeo.addBox(rampC, [rampLen, 0.2, rampW], uvWorld(1.2), rampQ);
  col.box(rampC, new Vector3(rampLen, 0.2, rampW), 0, rampQ);
  for (const sz of [-1, 1]) {
    const off = new Vector3(0, 0.08, sz * (rampW / 2 + 0.04));
    hazardGeo.addBox(rampC.add(off), [rampLen, 0.3, 0.08], uvWorld(0.6), rampQ);
  }
  steelGeo.addBox(new Vector3(DECK.x0 - rampRun / 2, 0.7, deckC.z - 1), [0.2, 1.4, 0.2], uvWorld(1));
  steelGeo.addBox(new Vector3(DECK.x0 - rampRun / 2, 0.7, deckC.z + 1), [0.2, 1.4, 0.2], uvWorld(1));

  // ---------------------------------------------------------------------------------------------
  // Crushed car bales and tyre stacks.
  const baleGeo = geos.get("bales", mats.bale);
  const bales: [number, number, number, number, number][] = [
    // x, y-level, z, yaw, (unused)
    [-27.5, 0, -14, 0.05, 0],
    [-25.6, 0, -14.1, -0.04, 0],
    [-29.4, 0, -13.9, 0.1, 0],
    [-26.6, 1, -14.05, 0.03, 0],
    [-28.5, 1, -14.0, -0.06, 0],
    [-27.5, 2, -14.1, 0.12, 0],
    [9.2, 0, 26.5, 0.3, 0],
    [11.0, 0, 27.4, 0.25, 0],
    [10.2, 1, 26.9, 0.35, 0],
    [8.4, 0, 28.2, -0.2, 0],
  ];
  const baleS: [number, number, number] = [1.8, 0.95, 1.3];
  for (const [x, lv, z, yaw] of bales) {
    const c = new Vector3(x, baleS[1] / 2 + lv * (baleS[1] + 0.002), z);
    const q = Quaternion.RotationYawPitchRoll(yaw, 0, 0);
    baleGeo.addBox(c, baleS, uvWorld(1.6, 1.6, r(), r()), q);
    col.box(c, baleS, 0, q);
  }
  const tyreStacks: [number, number, number][] = [
    [-9, -29, 4],
    [-9.9, -27.9, 3],
    [29, 14, 5],
    [-31, -6, 4],
  ];
  const tyre = MeshBuilder.CreateTorus("tyreSrc", { diameter: 0.56, thickness: 0.26, tessellation: 18 }, scene);
  tyre.material = mats.rubber;
  tyre.receiveShadows = true;
  tyre.isVisible = false;
  scaleUVs(tyre, 4, 1);
  for (const [x, z, count] of tyreStacks) {
    for (let k = 0; k < count; k++) {
      const t = tyre.createInstance(`tyre${x}_${k}`);
      t.position.set(x + (r() - 0.5) * 0.06, 0.13 + k * 0.255, z + (r() - 0.5) * 0.06);
      t.rotation.y = r() * Math.PI;
      t.freezeWorldMatrix();
      env.shadows.addShadowCaster(t, false);
    }
    col.cylinder(new Vector3(x, (count * 0.255) / 2, z), 0.42, count * 0.255);
  }

  // Steam vent pipe (ambience hooks onto it).
  const steamVent = new Vector3(-8, 0.95, 26.5);
  steelGeo.addBox(new Vector3(steamVent.x, 0.45, steamVent.z), [0.36, 0.9, 0.36], uvWorld(1));
  steelGeo.addBox(new Vector3(steamVent.x, 0.88, steamVent.z), [0.5, 0.08, 0.5], uvWorld(1));
  hazardGeo.addBox(new Vector3(steamVent.x + 0.3, 0.6, steamVent.z), [0.18, 0.18, 0.18], uvWorld(0.6));
  col.box(new Vector3(steamVent.x, 0.45, steamVent.z), [0.5, 0.9, 0.5]);

  // ---------------------------------------------------------------------------------------------
  // Floodlight towers just outside the corners (emissive lamps feed the glow layer).
  const towerGeo = geos.get("towers", mats.steelDark, { cast: false, pickable: false });
  const lampGeo = geos.get("lamps", mats.lamp, { cast: false, pickable: false, receive: false });
  const beaconGeo = geos.get("beacons", mats.beacon, { cast: false, pickable: false, receive: false });
  for (const [sx, sz] of [
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ]) {
    const base = new Vector3(sx * 39.5, 0, sz * 39.5);
    const top = base.add(new Vector3(0, 17, 0));
    towerGeo.addBeam(base, top, 0.4, uvWorld(1));
    const yaw = Math.atan2(-base.x, -base.z);
    const q = Quaternion.RotationYawPitchRoll(yaw, 0.35, 0);
    const head = top.add(rotateY(new Vector3(0, 0.4, 0.5), yaw));
    towerGeo.addBox(head, [3.0, 1.5, 0.3], uvWorld(1), q);
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 2; j++) {
        const local = new Vector3((i - 1) * 0.95, (j - 0.5) * 0.7, 0.18);
        const m = Vector3.TransformCoordinates(local, q.toRotationMatrix(new Matrix()));
        lampGeo.addBox(head.add(m), [0.75, 0.5, 0.06], uvWorld(1), q);
      }
    }
    beaconGeo.addBox(top.add(new Vector3(0, 1.4, 0)), [0.3, 0.3, 0.3], uvWorld(1));
  }

  // ---------------------------------------------------------------------------------------------
  // Skyline: tower cranes, a gantry crane, smokestacks, tanks and warehouses.
  const craneGeo = geos.get("cranes", mats.crane, { cast: false, pickable: false });
  const craneSolid = geos.get("craneSolid", mats.steelWhite, { cast: false, pickable: false });
  const counterGeo = geos.get("counterweights", mats.concrete, { cast: false, pickable: false });
  const cableGeo = geos.get("cables", mats.steelDark, { cast: false, pickable: false });
  const towerCrane = (bx: number, bz: number, height: number, jibYaw: number, jibLen: number, trolley: number) => {
    const w = 2;
    const hw = w / 2;
    const seg = 2.5;
    const corners = [
      [-hw, -hw],
      [hw, -hw],
      [hw, hw],
      [-hw, hw],
    ];
    for (const [cx, cz] of corners) craneGeo.addBeam(new Vector3(bx + cx, 0, bz + cz), new Vector3(bx + cx, height, bz + cz), 0.22, uvWorld(1));
    const segs = Math.floor(height / seg);
    for (let s = 0; s < segs; s++) {
      const y0 = s * seg;
      const y1 = y0 + seg;
      for (let f = 0; f < 4; f++) {
        const [ax, az] = corners[f];
        const [cx2, cz2] = corners[(f + 1) % 4];
        craneGeo.addBeam(new Vector3(bx + ax, y1, bz + az), new Vector3(bx + cx2, y1, bz + cz2), 0.12, uvWorld(1));
        const up = s % 2 === 0;
        craneGeo.addBeam(new Vector3(bx + ax, up ? y0 : y1, bz + az), new Vector3(bx + cx2, up ? y1 : y0, bz + cz2), 0.1, uvWorld(1));
      }
    }
    // Slewing unit, cab, apex.
    const top = new Vector3(bx, height, bz);
    craneSolid.addBox(top.add(new Vector3(0, 0.6, 0)), [2.6, 1.2, 2.6], uvWorld(1), Quaternion.RotationYawPitchRoll(jibYaw, 0, 0));
    const dir = rotateY(new Vector3(0, 0, 1), jibYaw);
    const side = rotateY(new Vector3(1, 0, 0), jibYaw);
    craneSolid.addBox(top.add(new Vector3(0, 1.8, 0)).add(dir.scale(1.6)).add(side.scale(1.4)), [1.6, 1.8, 1.8], uvWorld(1), Quaternion.RotationYawPitchRoll(jibYaw, 0, 0));
    const jy = height + 1.4;
    const apex = top.add(new Vector3(0, 9, 0));
    for (const [sx, sz] of [
      [-0.6, -0.6],
      [0.6, -0.6],
      [0.6, 0.6],
      [-0.6, 0.6],
    ]) {
      craneGeo.addBeam(new Vector3(bx + sx, jy, bz + sz), apex, 0.18, uvWorld(1));
    }
    // Jib: triangular lattice.
    const jw = 0.7;
    const jibEnd = top.add(new Vector3(0, 1.4, 0)).add(dir.scale(jibLen));
    const jibStart = top.add(new Vector3(0, 1.4, 0));
    const tri = [side.scale(-jw), side.scale(jw), new Vector3(0, 1.5, 0)];
    for (const o of tri) craneGeo.addBeam(jibStart.add(o), jibEnd.add(o), 0.16, uvWorld(1));
    const jsegs = Math.floor(jibLen / 3);
    for (let s = 0; s < jsegs; s++) {
      const p0 = jibStart.add(dir.scale(s * 3));
      const p1 = jibStart.add(dir.scale((s + 1) * 3));
      for (let f = 0; f < 3; f++) {
        const a = tri[f];
        const b = tri[(f + 1) % 3];
        craneGeo.addBeam(p1.add(a), p1.add(b), 0.08, uvWorld(1));
        craneGeo.addBeam(p0.add(a), p1.add(b), 0.07, uvWorld(1));
      }
    }
    // Counter-jib with concrete counterweights.
    const cjEnd = jibStart.subtract(dir.scale(jibLen * 0.32));
    for (const o of [side.scale(-0.9), side.scale(0.9)]) craneGeo.addBeam(jibStart.add(o), cjEnd.add(o), 0.25, uvWorld(1));
    for (let k = 0; k < 3; k++) {
      counterGeo.addBox(cjEnd.add(dir.scale(1 + k * 1.1)).add(new Vector3(0, -1.1, 0)), [2.2, 2.2, 1.0], uvWorld(2), Quaternion.RotationYawPitchRoll(jibYaw, 0, 0));
    }
    // Pendant ties and the hook line.
    cableGeo.addBeam(apex, jibEnd.add(new Vector3(0, 1.5, 0)), 0.06, uvWorld(1));
    cableGeo.addBeam(apex, cjEnd, 0.06, uvWorld(1));
    const trolleyP = jibStart.add(dir.scale(trolley));
    const hookY = Math.max(6, height * 0.45);
    cableGeo.addBeam(trolleyP, new Vector3(trolleyP.x, hookY, trolleyP.z), 0.04, uvWorld(1));
    craneSolid.addBox(new Vector3(trolleyP.x, hookY - 0.4, trolleyP.z), [0.6, 0.8, 0.4], uvWorld(1));
    beaconGeo.addBox(apex.add(new Vector3(0, 0.3, 0)), [0.35, 0.35, 0.35], uvWorld(1));
    beaconGeo.addBox(jibEnd.add(new Vector3(0, 1.8, 0)), [0.35, 0.35, 0.35], uvWorld(1));
  };
  towerCrane(-62, 70, 46, 2.3, 44, 26);
  towerCrane(85, 35, 52, -0.9, 48, 30);
  towerCrane(25, -95, 40, 0.6, 38, 18);

  // Gantry (portal) crane.
  {
    const gx = 35;
    const gz = -58;
    const gh = 26;
    const legs: [number, number][] = [
      [-14, -5],
      [14, -5],
      [-14, 5],
      [14, 5],
    ];
    for (const [lx, lz] of legs) {
      craneGeo.addBeam(new Vector3(gx + lx, 0, gz + lz), new Vector3(gx + lx * 0.95, gh, gz + lz * 0.6), 1.0, uvWorld(2));
    }
    craneGeo.addBox(new Vector3(gx, gh + 1.2, gz - 3), [38, 2.4, 1.6], uvWorld(2));
    craneGeo.addBox(new Vector3(gx, gh + 1.2, gz + 3), [38, 2.4, 1.6], uvWorld(2));
    craneGeo.addBox(new Vector3(gx - 13.5, gh / 2, gz), [1.0, 1.0, 10], uvWorld(2));
    craneGeo.addBox(new Vector3(gx + 13.5, gh / 2, gz), [1.0, 1.0, 10], uvWorld(2));
    craneSolid.addBox(new Vector3(gx + 4, gh + 3.2, gz), [5, 3, 7.5], uvWorld(2));
    cableGeo.addBeam(new Vector3(gx + 4, gh, gz), new Vector3(gx + 4, 9, gz), 0.08, uvWorld(1));
    beaconGeo.addBox(new Vector3(gx - 18.5, gh + 2.7, gz), [0.4, 0.4, 0.4], uvWorld(1));
    beaconGeo.addBox(new Vector3(gx + 18.5, gh + 2.7, gz), [0.4, 0.4, 0.4], uvWorld(1));
  }

  // Warehouses (corrugated, fogged into silhouettes) with roof clutter.
  const whGeo = geos.get("warehouses", mats.distant, { cast: false, pickable: false });
  const roofGeo = geos.get("roofs", mats.steelDark, { cast: false, pickable: false });
  const warehouses: [number, number, number, number, number, number][] = [
    [-75, -30, 40, 25, 16, 0.1],
    [-70, 40, 30, 50, 20, 0],
    [0, 85, 60, 22, 14, 0],
    [60, 80, 30, 30, 22, 0.3],
    [85, -10, 25, 45, 18, 0],
    [70, -75, 40, 30, 15, -0.2],
    [-10, -82, 50, 25, 12, 0],
    [-80, -85, 30, 30, 24, 0.5],
    [125, 40, 40, 30, 28, 0],
    [-135, 60, 50, 40, 30, 0.2],
    [-40, 120, 45, 30, 26, -0.1],
    [40, 135, 60, 35, 32, 0.15],
  ];
  for (const [x, z, w, d, h, yaw] of warehouses) {
    const q = Quaternion.RotationYawPitchRoll(yaw, 0, 0);
    whGeo.addBox(new Vector3(x, h / 2, z), [w, h, d], uvContainer(CONTAINER_TILE, r()), q);
    roofGeo.addBox(new Vector3(x, h + 0.25, z), [w + 0.6, 0.5, d + 0.6], uvWorld(4), q);
    const units = 2 + Math.floor(r() * 3);
    for (let k = 0; k < units; k++) {
      const off = rotateY(new Vector3((r() - 0.5) * w * 0.7, 0, (r() - 0.5) * d * 0.7), yaw);
      const s = 1.5 + r() * 2.5;
      roofGeo.addBox(new Vector3(x + off.x, h + 0.5 + s / 2, z + off.z), [s * 1.4, s, s], uvWorld(2), q);
    }
  }

  // Tanks.
  for (const [x, z, rad, h] of [
    [-55, 8, 7, 11],
    [-58, -9, 5.5, 9],
    [105, -42, 8, 12],
  ] as [number, number, number, number][]) {
    const t = MeshBuilder.CreateCylinder(`tank${x}`, { diameter: rad * 2, height: h, tessellation: 28 }, scene);
    t.position.set(x, h / 2, z);
    t.material = mats.steelWhite;
    scaleUVs(t, rad * 2, h / 4);
    markNoHit(t);
    t.freezeWorldMatrix();
    meshes.push(t);
    const capC = MeshBuilder.CreateCylinder(`tankCap${x}`, { diameterTop: rad * 0.6, diameterBottom: rad * 2, height: 1.6, tessellation: 28 }, scene);
    capC.position.set(x, h + 0.8, z);
    capC.material = mats.steelDark;
    markNoHit(capC);
    capC.freezeWorldMatrix();
    meshes.push(capC);
  }

  // Smokestacks.
  const smokeStacks: Vector3[] = [];
  for (const [x, z, h, rad] of [
    [-110, -30, 60, 3],
    [-118, -8, 52, 2.6],
    [120, 95, 58, 3.2],
  ] as [number, number, number, number][]) {
    const s = MeshBuilder.CreateCylinder(`stack${x}`, { diameterTop: rad * 1.6, diameterBottom: rad * 2.2, height: h, tessellation: 24 }, scene);
    s.position.set(x, h / 2, z);
    s.material = mats.stack;
    markNoHit(s);
    s.freezeWorldMatrix();
    meshes.push(s);
    smokeStacks.push(new Vector3(x, h + 0.5, z));
    beaconGeo.addBox(new Vector3(x, h + 0.6, z + rad * 0.8), [0.6, 0.6, 0.6], uvWorld(1));
  }

  const built = geos.build();
  meshes.push(...built);
  const beaconMeshes = built.filter((m) => m.name === "beacons");
  return { meshes, steamVent, smokeStacks, beaconMeshes };
}

export function rotateY(v: Vector3, yaw: number): Vector3 {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  // Babylon (left-handed): yaw +90° maps +z -> +x and +x -> -z.
  return new Vector3(v.x * c + v.z * s, v.y, -v.x * s + v.z * c);
}
