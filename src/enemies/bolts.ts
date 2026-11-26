import {
  PhysicsMotionType,
  Quaternion,
  Ray,
  Vector3,
  type AbstractMesh,
  type InstancedMesh,
  type Node,
  type PhysicsBody,
  type PickingInfo,
  type TransformNode,
} from "@babylonjs/core";
import type { HitKind } from "../core/events";
import { findDamageable, markNoHit } from "../core/damage";
import { BOLT } from "./config";
import { worldPredicate } from "./predicates";
import type { EnemySystem } from "./system";

interface Bolt {
  core: InstancedMesh;
  trail: InstancedMesh;
  pos: Vector3;
  dir: Vector3;
  age: number;
  traveled: number;
}

const tmpNext = new Vector3();
const tmpHit = new Vector3();
const tmpA = new Vector3();
const tmpB = new Vector3();
const tmpImpulse = new Vector3();

/**
 * Closest distance² between segments p1→q1 and p2→q2 (Ericson, RTCD 5.1.9).
 * Returns the parameter s along the first segment in `out.s`.
 */
function segmentSegment(p1: Vector3, q1: Vector3, p2: Vector3, q2: Vector3, out: { s: number; distSq: number }): void {
  const d1x = q1.x - p1.x, d1y = q1.y - p1.y, d1z = q1.z - p1.z;
  const d2x = q2.x - p2.x, d2y = q2.y - p2.y, d2z = q2.z - p2.z;
  const rx = p1.x - p2.x, ry = p1.y - p2.y, rz = p1.z - p2.z;
  const a = d1x * d1x + d1y * d1y + d1z * d1z;
  const e = d2x * d2x + d2y * d2y + d2z * d2z;
  const f = d2x * rx + d2y * ry + d2z * rz;
  const EPS = 1e-9;
  let s = 0;
  let t = 0;
  if (a <= EPS && e <= EPS) {
    s = t = 0;
  } else if (a <= EPS) {
    t = Math.min(1, Math.max(0, f / e));
  } else {
    const c = d1x * rx + d1y * ry + d1z * rz;
    if (e <= EPS) {
      s = Math.min(1, Math.max(0, -c / a));
    } else {
      const b = d1x * d2x + d1y * d2y + d1z * d2z;
      const denom = a * e - b * b;
      s = denom > EPS ? Math.min(1, Math.max(0, (b * f - c * e) / denom)) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = Math.min(1, Math.max(0, -c / a));
      } else if (t > 1) {
        t = 1;
        s = Math.min(1, Math.max(0, (b - c) / a));
      }
    }
  }
  const cx = p1.x + d1x * s - (p2.x + d2x * t);
  const cy = p1.y + d1y * s - (p2.y + d2y * t);
  const cz = p1.z + d1z * s - (p2.z + d2z * t);
  out.s = s;
  out.distSq = cx * cx + cy * cy + cz * cz;
}

function findBody(mesh: AbstractMesh): PhysicsBody | null {
  let n: Node | null = mesh;
  while (n) {
    const body = (n as TransformNode).physicsBody;
    if (body) return body;
    n = n.parent;
  }
  return null;
}

/**
 * Pooled plasma bolts: glowing core + additive streak, swept-segment hit tests against the
 * world (scene pick) and the player capsule (segment/segment distance).
 */
export class BoltSystem {
  private readonly free: Bolt[] = [];
  private readonly active: Bolt[] = [];
  private total = 0;
  private readonly ray = new Ray(Vector3.Zero(), new Vector3(0, 0, 1), 1);
  private readonly seg = { s: 0, distSq: 0 };

  constructor(private readonly sys: EnemySystem) {
    for (let i = 0; i < BOLT.pool; i++) this.free.push(this.create());
  }

  get activeCount(): number {
    return this.active.length;
  }

  private create(): Bolt {
    const i = this.total++;
    const { boltCore, boltTrail } = this.sys.assets;
    const core = boltCore.createInstance(`enemy-bolt-${i}`);
    core.rotationQuaternion = new Quaternion();
    markNoHit(core);
    const trail = boltTrail.createInstance(`enemy-bolt-trail-${i}`);
    trail.parent = core;
    markNoHit(trail);
    core.setEnabled(false);
    return { core, trail, pos: new Vector3(), dir: new Vector3(0, 0, 1), age: 0, traveled: 0 };
  }

  /** Launches a bolt from origin along a normalized direction and emits enemy:fired. */
  fire(origin: Vector3, direction: Vector3): void {
    let b = this.free.pop();
    if (!b) {
      if (this.total < BOLT.maxPool) b = this.create();
      else {
        b = this.active.shift()!; // recycle the oldest
      }
    }
    b.pos.copyFrom(origin);
    b.dir.copyFrom(direction).normalize();
    b.age = 0;
    b.traveled = 0;
    b.core.position.copyFrom(origin);
    Quaternion.RotationYawPitchRollToRef(Math.atan2(b.dir.x, b.dir.z), -Math.asin(Math.max(-1, Math.min(1, b.dir.y))), 0, b.core.rotationQuaternion!);
    b.trail.scaling.set(1, 1, 0.01);
    b.core.setEnabled(true);
    this.active.push(b);
    this.sys.ctx.events.emit("enemy:fired", { position: origin.clone() });
  }

  /** Releases every active bolt (game over / restart). */
  clear(): void {
    for (let i = this.active.length - 1; i >= 0; i--) this.release(i);
  }

  private release(i: number): void {
    const b = this.active[i];
    const last = this.active.pop()!;
    if (i < this.active.length) this.active[i] = last;
    b.core.setEnabled(false);
    this.free.push(b);
  }

  update(dt: number): void {
    if (!this.active.length) return;
    const ctx = this.sys.ctx;
    const player = ctx.player;
    const alive = player.alive;
    const feet = player.getFeetPosition();
    const pr = player.radius;
    // Capsule axis.
    tmpA.set(feet.x, feet.y + pr, feet.z);
    tmpB.set(feet.x, feet.y + player.height - pr, feet.z);
    const hitR = pr + BOLT.radius;
    const hitR2 = hitR * hitR;
    const step = BOLT.speed * dt;

    // Iterate backwards: release() swaps the (already processed) last bolt into slot i.
    // Hits release the bolt BEFORE applying damage: damage can kill the player, which ends the
    // game and clear()s this pool re-entrantly, so re-check the slot every iteration.
    for (let i = this.active.length - 1; i >= 0; i--) {
      if (ctx.state.phase !== "playing") return;
      const b = this.active[i];
      if (!b) continue;
      b.age += dt;
      if (b.age >= BOLT.life) {
        this.release(i);
        continue;
      }
      b.dir.scaleToRef(step, tmpNext).addInPlace(b.pos);

      // World: swept pick from previous to next position.
      this.ray.origin.copyFrom(b.pos);
      this.ray.direction.copyFrom(b.dir);
      this.ray.length = step + BOLT.radius * 0.5;
      let hit: PickingInfo | null = ctx.scene.pickWithRay(this.ray, worldPredicate);
      if (hit && (!hit.hit || !hit.pickedPoint)) hit = null;
      let worldDist = hit ? hit.distance : Infinity;

      // Player capsule.
      let playerDist = Infinity;
      if (alive) {
        segmentSegment(b.pos, tmpNext, tmpA, tmpB, this.seg);
        if (this.seg.distSq < hitR2) playerDist = this.seg.s * step;
        // If the player's own body mesh is pickable, a world hit on it counts as a player hit.
        if (hit && this.nearPlayer(hit.pickedPoint!, feet, pr, player.height)) {
          playerDist = Math.min(playerDist, worldDist);
          worldDist = Infinity;
        }
      }

      if (playerDist < Infinity && playerDist <= worldDist) {
        const at = b.dir.scaleToRef(playerDist, tmpHit).addInPlace(b.pos).clone();
        this.release(i);
        player.takeDamage(BOLT.damage, at);
        continue;
      }
      if (hit && worldDist < Infinity) {
        const dir = b.dir.clone();
        this.release(i);
        this.onWorldHit(hit, dir);
        continue;
      }

      b.pos.copyFrom(tmpNext);
      b.core.position.copyFrom(tmpNext);
      b.traveled += step;
      b.trail.scaling.z = Math.max(0.01, Math.min(BOLT.trailLength, b.traveled));
    }
  }

  private nearPlayer(point: Vector3, feet: Vector3, radius: number, height: number): boolean {
    const dx = point.x - feet.x;
    const dz = point.z - feet.z;
    const r = radius + 0.2;
    return dx * dx + dz * dz < r * r && point.y > feet.y - 0.1 && point.y < feet.y + height + 0.1;
  }

  private onWorldHit(hit: PickingInfo, dir: Vector3): void {
    const ctx = this.sys.ctx;
    const point = hit.pickedPoint!.clone();
    const normal = hit.getNormal(true, false) ?? dir.negate();
    let kind: HitKind = "world";
    const mesh = hit.pickedMesh;
    if (mesh) {
      const target = findDamageable(mesh);
      if (target && target.kind === "barrel") {
        kind = "barrel";
        // Stray plasma can cook off barrels: emergent chain reactions.
        if (target.alive) target.takeDamage(BOLT.damage, { source: "enemy", point, direction: dir.clone() });
      } else {
        const body = findBody(mesh);
        if (body && !body.isDisposed && body.getMotionType() === PhysicsMotionType.DYNAMIC) {
          kind = "prop";
          const mass = body.getMassProperties().mass ?? 1;
          dir.scaleToRef(BOLT.propPush * Math.min(mass, 10), tmpImpulse);
          body.applyImpulse(tmpImpulse, point);
        }
      }
    }
    ctx.fx.impact(point, normal, kind);
  }
}
