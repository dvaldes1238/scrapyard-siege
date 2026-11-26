import {
  MeshBuilder,
  PhysicsBody,
  PhysicsMotionType,
  PhysicsShapeBox,
  PhysicsShapeCylinder,
  Quaternion,
  Vector3,
  Vector4,
  type InstancedMesh,
  type Mesh,
  type PhysicsShape,
} from "@babylonjs/core";
import type { GameContext } from "../core/context";
import { setDamageable, type Damageable, type DamageInfo } from "../core/damage";
import { explode } from "../core/explosion";
import { BARREL, PROPS } from "./config";
import type { Environment } from "./environment";
import { Geo, uvFace } from "./geometry";
import { DECK_Y } from "./layout";
import { rng } from "./noise";
import { DRUM_LID_UV, DRUM_SIDE_V0, type WorldMaterials } from "./textures";

/**
 * Dynamic props: crate stacks/pyramids, explosive red barrels (Damageable) and blue drums.
 * All are instances of a handful of hidden source meshes (one draw call per type), start
 * asleep so stacks are perfectly stable until disturbed, and are registered in
 * ctx.dynamicBodies and as shadow casters.
 */

const DRUM_H = PROPS.drumHeight;
const DRUM_R = PROPS.drumRadius;

type PropKind = "wood" | "metal" | "red" | "blue";

interface PropDef {
  kind: PropKind;
  pos: Vector3;
  size?: number;
  yaw?: number;
  /** Lying on its side (drums). */
  lying?: boolean;
}

class ExplosiveBarrel implements Damageable {
  readonly kind = "barrel" as const;
  alive = true;
  hp = BARREL.hp;
  fuse = -1;
  constructor(
    readonly mesh: InstancedMesh,
    readonly body: PhysicsBody,
  ) {}
  getPosition(): Vector3 {
    return this.mesh.getAbsolutePosition();
  }
  takeDamage(amount: number, _info: DamageInfo): void {
    if (!this.alive) return;
    this.hp -= amount;
    if (this.hp <= 0) {
      // Detonates on a short fuse: chains never recurse synchronously inside explode().
      this.alive = false;
      this.fuse = BARREL.fuse;
    }
  }
}

export interface Props {
  barrels: Set<ExplosiveBarrel>;
  count: number;
}

export function createProps(ctx: GameContext, env: Environment, mats: WorldMaterials): Props {
  const { scene } = ctx;
  const r = rng(4242);

  // --- Source meshes -------------------------------------------------------------------------
  const unitBox = (name: string, mat: WorldMaterials["woodCrate"]): Mesh => {
    const m = new Geo().addBox(Vector3.Zero(), [1, 1, 1], uvFace).build(name, scene);
    m.material = mat;
    m.receiveShadows = true;
    m.isVisible = false;
    return m;
  };
  const woodSrc = unitBox("crateWoodSrc", mats.woodCrate);
  const metalSrc = unitBox("crateMetalSrc", mats.metalCrate);
  const drumUV = [
    new Vector4(0, 0, DRUM_LID_UV, DRUM_LID_UV),
    new Vector4(0, DRUM_SIDE_V0, 1, 1),
    new Vector4(0, 0, DRUM_LID_UV, DRUM_LID_UV),
  ];
  const redSrc = MeshBuilder.CreateCylinder("barrelRedSrc", { height: DRUM_H, diameter: DRUM_R * 2, tessellation: 24, faceUV: drumUV }, scene);
  redSrc.material = mats.barrelRed;
  redSrc.receiveShadows = true;
  redSrc.isVisible = false;
  const blueSrc = MeshBuilder.CreateCylinder("drumBlueSrc", { height: DRUM_H, diameter: DRUM_R * 2, tessellation: 24, faceUV: drumUV }, scene);
  blueSrc.material = mats.drumBlue;
  blueSrc.receiveShadows = true;
  blueSrc.isVisible = false;

  // --- Shared physics shapes -----------------------------------------------------------------
  const shapes = new Map<string, PhysicsShape>();
  const boxShape = (s: number, friction: number): PhysicsShape => {
    const key = `box${s.toFixed(2)}_${friction}`;
    let sh = shapes.get(key);
    if (!sh) {
      sh = new PhysicsShapeBox(Vector3.Zero(), Quaternion.Identity(), new Vector3(s, s, s), scene);
      sh.material = { friction, restitution: PROPS.crateRestitution };
      shapes.set(key, sh);
    }
    return sh;
  };
  const drumShape = new PhysicsShapeCylinder(new Vector3(0, -DRUM_H / 2, 0), new Vector3(0, DRUM_H / 2, 0), DRUM_R, scene);
  drumShape.material = { friction: PROPS.drumFriction, restitution: PROPS.drumRestitution };

  // --- Layout --------------------------------------------------------------------------------
  const defs: PropDef[] = [];
  const crate = (kind: "wood" | "metal", x: number, y: number, z: number, size: number, yaw = 0) =>
    defs.push({ kind, pos: new Vector3(x, y + size / 2, z), size, yaw });
  const drum = (kind: "red" | "blue", x: number, z: number, y = 0, lying = false, yaw?: number) =>
    defs.push({ kind, pos: new Vector3(x, y + (lying ? DRUM_R : DRUM_H / 2), z), lying, yaw });
  const G = PROPS.stackGap;

  // P1: pyramid of 1 m crates.
  for (let i = 0; i < 3; i++) crate("wood", -5.02 + i * 1.02, 0, -8, 1);
  for (let i = 0; i < 2; i++) crate("wood", -4.51 + i * 1.02, 1 + G, -8, 1);
  crate("wood", -4, 2 + 2 * G, -8, 1, 0.1);
  // P2: 2x2 base of 1.2 m crates, two smaller on top.
  for (const [dx, dz] of [
    [0, 0],
    [1.22, 0],
    [0, 1.22],
    [1.22, 1.22],
  ])
    crate("wood", 12.4 + dx, 0, -3.6 + dz, 1.2, (r() - 0.5) * 0.06);
  crate("wood", 13.0, 1.2 + G, -3.0, 1.0, 0.2);
  crate("wood", 13.0, 2.2 + 2 * G, -3.0, 0.8, -0.3);
  // P3: 4-3-2-1 pyramid of 0.8 m crates.
  for (let row = 0; row < 4; row++) {
    const count = 4 - row;
    for (let i = 0; i < count; i++) crate("wood", -26.2 + row * 0.41 + i * 0.82, row * (0.8 + G), -3, 0.8);
  }
  // P4: metal crates.
  crate("metal", 25, 0, -22, 1.1, 0.05);
  crate("metal", 26.2, 0, -22.1, 1.1, -0.04);
  crate("metal", 25.1, 0, -23.25, 1.1, 0.1);
  crate("metal", 25.6, 1.1 + G, -22.1, 1.1, 0.3);
  // P5: on the platform deck.
  crate("wood", 2.0, DECK_Y, 7.2, 0.8, 0.15);
  crate("wood", 2.95, DECK_Y, 7.3, 0.8, -0.1);
  crate("wood", 2.47, DECK_Y + 0.8 + G, 7.25, 0.8, 0.4);
  crate("metal", -3.5, DECK_Y, 8.8, 0.9, 0.2);
  // P6/P7: by the interior containers.
  crate("wood", -16.5, 0, 12.5, 1, 0.1);
  crate("wood", -16.45, 1 + G, 12.55, 1, -0.25);
  crate("wood", -15.3, 0, 12.2, 0.8, 0.4);
  crate("wood", 15.5, 0, 14, 1.2, 0.05);
  crate("wood", 15.3, 0, 15.5, 1.0, -0.2);
  crate("wood", 15.5, 1.2 + G, 14.05, 0.8, 0.5);
  // P8: under the platform.
  crate("wood", -2, 0, 8, 1, 0.3);
  crate("metal", 3.5, 0, 7.5, 0.9, -0.2);
  // P9: behind the barrier in front of spawn.
  crate("wood", -3, 0, -16.8, 0.8, 0.2);
  crate("wood", -1.9, 0, -16.6, 1.0, -0.1);
  // P10: scattered singles.
  crate("wood", 8.5, 0, 4, 1.0, 0.6);
  crate("wood", -10, 0, 18, 1.0, -0.4);
  crate("wood", 6, 0, 20, 1.2, 0.2);
  crate("wood", -28, 0, 22, 0.8, 0.7);
  crate("metal", 28, 0, -2, 0.9, 0.3);
  crate("metal", -6, 0, 28, 0.9, -0.5);
  crate("wood", 16, 0, -26, 0.8, 0.9);
  // P11: metal stack by the west wall.
  crate("metal", -30, 0, 10, 1.1, 0.02);
  crate("metal", -30, 0, 11.2, 1.1, -0.03);
  crate("metal", -30, 1.1 + G, 10.6, 1.1, 0.15);
  // P12: by the teal container near spawn lane.
  crate("wood", 10.5, 0, -16, 1.0, 0.1);
  crate("wood", 10.55, 1 + G, -16.05, 1.0, -0.2);
  crate("wood", 11.6, 0, -15, 0.8, 0.5);

  // Explosive barrels (12), clustered so chains happen.
  drum("red", -7.5, 3.8);
  drum("red", -6.9, 4.5);
  drum("red", -12, 13.5);
  drum("red", -11.3, 14.1);
  drum("red", 16.2, 9.2);
  drum("red", 16.9, 9.9);
  drum("red", 20.5, -16);
  drum("red", 23.2, -20.5);
  drum("red", 4.6, 9.2, DECK_Y);
  drum("red", 6, -22);
  drum("red", -24, -22);
  drum("red", -23.4, -22.8);
  // Blue non-explosive drums (12).
  drum("blue", -14.5, -6);
  drum("blue", -13.9, -6.6);
  drum("blue", -15.1, -6.7);
  drum("blue", -14.4, -7.9, 0, true, 0.3);
  drum("blue", 2, 25);
  drum("blue", 2.7, 25.4);
  drum("blue", 1.5, 25.7);
  drum("blue", 30.5, -8);
  drum("blue", 30.6, -8.7);
  drum("blue", -30, 28);
  drum("blue", 9.5, -9);
  drum("blue", 10.1, -9.5);

  // --- Spawn (counts capped by config; stacks are listed bottom-up so caps never orphan a top) -
  const limits: Record<PropKind, number> = {
    wood: PROPS.maxCrates,
    metal: PROPS.maxCrates,
    red: PROPS.maxExplosiveBarrels,
    blue: PROPS.maxBlueDrums,
  };
  let crates = 0;
  const used = { red: 0, blue: 0 };
  const spawnDefs = defs.filter((d) => {
    if (d.kind === "wood" || d.kind === "metal") return crates++ < limits.wood;
    return used[d.kind]++ < limits[d.kind];
  });
  const barrels = new Set<ExplosiveBarrel>();
  let n = 0;
  for (const d of spawnDefs) {
    const src = d.kind === "wood" ? woodSrc : d.kind === "metal" ? metalSrc : d.kind === "red" ? redSrc : blueSrc;
    const inst = src.createInstance(`${d.kind}${n++}`);
    inst.position.copyFrom(d.pos);
    const yaw = d.yaw ?? r() * Math.PI * 2;
    inst.rotationQuaternion = d.lying ? Quaternion.RotationYawPitchRoll(yaw, 0, Math.PI / 2) : Quaternion.RotationYawPitchRoll(yaw, 0, 0);
    if (d.size) inst.scaling.setAll(d.size);
    inst.computeWorldMatrix(true);

    const body = new PhysicsBody(inst, PhysicsMotionType.DYNAMIC, true, scene);
    let mass: number;
    if (d.kind === "wood") {
      body.shape = boxShape(d.size!, PROPS.woodFriction);
      mass = PROPS.woodDensity * d.size! ** 3;
    } else if (d.kind === "metal") {
      body.shape = boxShape(d.size!, PROPS.metalFriction);
      mass = PROPS.metalDensity * d.size! ** 3;
    } else {
      body.shape = drumShape;
      mass = d.kind === "red" ? BARREL.mass : PROPS.blueDrumMass;
    }
    body.setMassProperties({ mass });
    body.setLinearDamping(PROPS.linearDamping);
    body.setAngularDamping(PROPS.angularDamping);
    ctx.dynamicBodies.add(body);
    env.shadows.addShadowCaster(inst, false);

    if (d.kind === "red") {
      const b = new ExplosiveBarrel(inst, body);
      setDamageable(inst, b);
      ctx.damageables.add(b);
      barrels.add(b);
    }
  }

  // --- Fuse ticking (every frame except while paused, so chains finish on game over too) ---
  ctx.onFrame((dt) => {
    if (ctx.state.phase === "paused" || barrels.size === 0) return;
    for (const b of barrels) {
      if (b.fuse < 0) continue;
      b.fuse -= dt;
      if (b.fuse > 0) continue;
      barrels.delete(b);
      const pos = b.mesh.getAbsolutePosition().clone();
      ctx.damageables.delete(b);
      ctx.dynamicBodies.delete(b.body);
      env.shadows.removeShadowCaster(b.mesh, false);
      b.body.dispose();
      b.mesh.dispose();
      explode(ctx, pos, { ...BARREL.explosion, source: "explosion" });
      ctx.fx.shatter(pos, { color: BARREL.debrisColor, count: BARREL.debrisCount, size: BARREL.debrisSize, force: BARREL.debrisForce });
    }
  });

  return { barrels, count: spawnDefs.length };
}

export type { ExplosiveBarrel };
