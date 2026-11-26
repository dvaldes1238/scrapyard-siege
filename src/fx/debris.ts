import {
  Color3,
  MeshBuilder,
  PBRMaterial,
  PhysicsBody,
  PhysicsMotionType,
  PhysicsShapeBox,
  Quaternion,
  Vector3,
  type InstancedMesh,
  type Mesh,
} from "@babylonjs/core";
import type { GameContext } from "../core/context";
import { DEBRIS } from "./config";
import type { FxTextures } from "./textures";

/**
 * Physical debris: small dynamic boxes (instances of one hidden source mesh per colour)
 * thrown outward, registered in ctx.dynamicBodies and as shadow casters, shrinking away after
 * a few seconds (DEBRIS in ./config.ts). Live debris is capped; the oldest pieces go first.
 * Debris stays shootable.
 */

interface Piece {
  mesh: InstancedMesh;
  body: PhysicsBody;
  shape: PhysicsShapeBox;
  age: number;
  life: number;
  base: Vector3;
}

export interface DebrisSystem {
  shatter(position: Vector3, opts?: { color?: Color3; count?: number; size?: number; force?: number }): void;
  readonly liveCount: number;
}

export function createDebris(ctx: GameContext, tex: FxTextures): DebrisSystem {
  const { scene } = ctx;
  const sources = new Map<string, Mesh>();
  const live: Piece[] = [];
  const defaultColor = DEBRIS.defaultColor;
  let serial = 0;

  const sourceFor = (color: Color3): Mesh => {
    const key = color.toHexString();
    let src = sources.get(key);
    if (!src) {
      const mat = new PBRMaterial(`debris_${key}`, scene);
      mat.albedoColor = color.clone();
      mat.albedoTexture = tex.scuff;
      mat.metallic = DEBRIS.metallic;
      mat.roughness = DEBRIS.roughness;
      src = MeshBuilder.CreateBox(`debrisSrc_${key}`, { size: 1 }, scene);
      src.material = mat;
      src.isVisible = false;
      src.receiveShadows = true;
      sources.set(key, src);
    }
    return src;
  };
  // Compile the debris shader up front so the first barrel/drone death doesn't hitch.
  const warm = sourceFor(defaultColor);
  warm.material?.forceCompilation(warm, undefined, { useInstances: true });

  const remove = (idx: number) => {
    const p = live[idx];
    live.splice(idx, 1);
    ctx.dynamicBodies.delete(p.body);
    ctx.world?.removeShadowCaster(p.mesh);
    p.body.dispose();
    p.shape.dispose();
    p.mesh.dispose();
  };

  const tmpDir = new Vector3();
  const tmpAng = new Vector3();

  ctx.onFrame((dt) => {
    if (ctx.state.phase === "paused" || live.length === 0) return;
    for (let i = live.length - 1; i >= 0; i--) {
      const p = live[i];
      p.age += dt;
      if (p.age >= p.life) {
        remove(i);
        continue;
      }
      const left = p.life - p.age;
      if (left < DEBRIS.shrinkTime) {
        const k = Math.max(0.02, left / DEBRIS.shrinkTime);
        p.mesh.scaling.copyFrom(p.base).scaleInPlace(k);
      }
      // Anything that fell out of the world goes immediately.
      if (p.mesh.position.y < DEBRIS.killY) remove(i);
    }
  });

  return {
    get liveCount() {
      return live.length;
    },
    shatter(position, opts = {}) {
      const color = opts.color ?? defaultColor;
      const count = Math.max(1, Math.min(DEBRIS.maxPerShatter, Math.round(opts.count ?? DEBRIS.defaultCount)));
      const size = Math.max(0.05, Math.min(1, opts.size ?? DEBRIS.defaultSize));
      const force = opts.force ?? DEBRIS.defaultForce;
      const src = sourceFor(color);
      for (let i = 0; i < count; i++) {
        while (live.length >= DEBRIS.max) remove(0);
        const dims = new Vector3(size * (0.55 + Math.random() * 0.6), size * (0.3 + Math.random() * 0.45), size * (0.5 + Math.random() * 0.6));
        const inst = src.createInstance(`debris${serial++}`);
        // Random point in a small sphere so pieces don't start fully overlapping.
        tmpDir.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1);
        if (tmpDir.lengthSquared() > 1) tmpDir.normalize();
        inst.position.copyFrom(position).addInPlace(tmpDir.scale(size * 1.3));
        inst.rotationQuaternion = Quaternion.RotationYawPitchRoll(Math.random() * 6.28, Math.random() * 6.28, Math.random() * 6.28);
        inst.scaling.copyFrom(dims);
        inst.computeWorldMatrix(true);

        const shape = new PhysicsShapeBox(Vector3.Zero(), Quaternion.Identity(), dims, scene);
        shape.material = { friction: DEBRIS.friction, restitution: DEBRIS.restitution };
        const body = new PhysicsBody(inst, PhysicsMotionType.DYNAMIC, false, scene);
        body.shape = shape;
        const mass = dims.x * dims.y * dims.z * DEBRIS.density;
        body.setMassProperties({ mass: Math.max(DEBRIS.mass[0], Math.min(DEBRIS.mass[1], mass)) });
        body.setLinearDamping(DEBRIS.linearDamping);
        body.setAngularDamping(DEBRIS.angularDamping);
        // Outward, biased upward.
        tmpDir.y = Math.abs(tmpDir.y) * 0.7 + 0.5;
        tmpDir.normalize().scaleInPlace(force * (0.45 + Math.random() * 0.65));
        body.setLinearVelocity(tmpDir);
        const w = DEBRIS.spin * 2;
        tmpAng.set((Math.random() - 0.5) * w, (Math.random() - 0.5) * w, (Math.random() - 0.5) * w);
        body.setAngularVelocity(tmpAng);

        ctx.dynamicBodies.add(body);
        ctx.world?.addShadowCaster(inst, false);
        const [lo, hi] = DEBRIS.life;
        live.push({ mesh: inst, body, shape, age: 0, life: lo + Math.random() * (hi - lo), base: dims });
      }
    },
  };
}
