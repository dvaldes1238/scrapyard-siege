import { Matrix, PhysicsMotionType, Ray, Vector3, type AbstractMesh, type Node, type PhysicsBody, type TransformNode } from "@babylonjs/core";
import type { GameContext } from "../core/context";
import { findDamageable, isHittable } from "../core/damage";
import type { HitKind } from "../core/events";
import type { CameraRig } from "./cameraRig";
import { DEG, RIFLE } from "./config";
import type { Viewmodel } from "./viewmodel";

export interface RifleInput {
  triggerHeld: boolean;
  reloadPressed: boolean;
  /** Moving fast or airborne: adds the movement spread penalty. */
  unsteady: boolean;
}

/** Walk up the parent chain to the first node that owns a physics body. */
export function findPhysicsBody(mesh: AbstractMesh): PhysicsBody | null {
  let n: Node | null = mesh;
  while (n) {
    const body = (n as TransformNode).physicsBody;
    if (body) return body;
    n = n.parent;
  }
  return null;
}

/** Full-auto hitscan pulse rifle. */
export class Rifle {
  ammo = RIFLE.magSize;
  reloading = false;
  /** Seconds since last shot (for sprint pose etc.). */
  sinceShot = 99;

  private reloadT = 0;
  private cooldown = 0;
  private bloom = 0; // extra spread in degrees on top of the base

  private readonly ray = new Ray(Vector3.Zero(), Vector3.Forward(), RIFLE.range);
  private readonly rotMat = new Matrix();
  private readonly localDir = new Vector3();
  private readonly dir = new Vector3();
  private readonly muzzle = new Vector3();
  private readonly impulse = new Vector3();

  constructor(
    private readonly ctx: GameContext,
    private readonly rig: CameraRig,
    private readonly vm: Viewmodel,
  ) {}

  get reloadProgress(): number {
    return this.reloading ? Math.min(1, this.reloadT / RIFLE.reloadTime) : -1;
  }

  reset(): void {
    this.ammo = RIFLE.magSize;
    this.reloading = false;
    this.reloadT = 0;
    this.cooldown = 0;
    this.bloom = 0;
    this.sinceShot = 99;
  }

  emitAmmo(): void {
    this.ctx.events.emit("ammo:changed", { ammo: this.ammo, magSize: RIFLE.magSize, reloading: this.reloading });
  }

  cancelReload(): void {
    if (!this.reloading) return;
    this.reloading = false;
    this.reloadT = 0;
    this.emitAmmo();
  }

  private startReload(): void {
    if (this.reloading || this.ammo >= RIFLE.magSize) return;
    this.reloading = true;
    this.reloadT = 0;
    this.ctx.events.emit("weapon:reload", { weapon: "rifle" });
    this.emitAmmo();
  }

  update(dt: number, input: RifleInput): void {
    this.sinceShot += dt;
    this.bloom = Math.max(0, this.bloom - RIFLE.spreadRecovery * dt);

    if (this.reloading) {
      this.reloadT += dt;
      if (this.reloadT >= RIFLE.reloadTime) {
        this.reloading = false;
        this.reloadT = 0;
        this.ammo = RIFLE.magSize;
        this.emitAmmo();
      }
    }

    if (input.reloadPressed) this.startReload();

    if (!input.triggerHeld) {
      this.cooldown = Math.max(0, this.cooldown - dt);
      return;
    }

    this.cooldown -= dt;
    if (this.reloading) {
      this.cooldown = Math.max(0, this.cooldown);
      return;
    }
    if (this.ammo <= 0) {
      // Dry trigger: click + automatic reload (reloading short-circuits above, so this fires once).
      this.cooldown = Math.max(0, this.cooldown);
      this.ctx.events.emit("weapon:empty", { weapon: "rifle" });
      this.startReload();
      return;
    }
    // At most 2 shots per frame so hitches don't dump the mag.
    let shots = 0;
    while (this.cooldown <= 0 && this.ammo > 0 && shots < 2) {
      this.fire(input.unsteady);
      this.cooldown += RIFLE.fireInterval;
      shots++;
    }
    if (this.cooldown < 0) this.cooldown = 0;
  }

  private fire(unsteady: boolean): void {
    const ctx = this.ctx;
    this.ammo--;
    this.sinceShot = 0;

    // Spread cone (degrees), centre-weighted sample.
    const spreadDeg = Math.min(RIFLE.spreadBase + this.bloom, RIFLE.spreadMax) + (unsteady ? RIFLE.spreadMovingPenalty : 0);
    this.bloom = Math.min(this.bloom + RIFLE.spreadPerShot, RIFLE.spreadMax - RIFLE.spreadBase);
    const r = Math.tan(spreadDeg * DEG * Math.random());
    const a = Math.random() * Math.PI * 2;
    this.localDir.set(Math.cos(a) * r, Math.sin(a) * r, 1).normalize();
    this.rig.getRotationMatrixToRef(this.rotMat);
    Vector3.TransformNormalToRef(this.localDir, this.rotMat, this.dir);
    this.dir.normalize();

    const origin = ctx.camera.position;
    this.ray.origin.copyFrom(origin);
    this.ray.direction.copyFrom(this.dir);
    this.ray.length = RIFLE.range;

    this.vm.getMuzzleWorldToRef(this.muzzle);
    const pick = ctx.scene.pickWithRay(this.ray, isHittable);

    if (pick && pick.hit && pick.pickedPoint && pick.pickedMesh) {
      const point = pick.pickedPoint;
      const mesh = pick.pickedMesh;
      let normal = pick.getNormal(true, false);
      if (!normal || !isFinite(normal.x)) normal = this.dir.scale(-1);
      if (Vector3.Dot(normal, this.dir) > 0) normal.scaleInPlace(-1);

      let kind: HitKind = "world";
      let killed = false;
      const d = findDamageable(mesh);
      if (d) {
        kind = d.kind;
        if (d.alive) {
          d.takeDamage(RIFLE.damage, { source: "rifle", point: point.clone(), direction: this.dir.clone() });
          killed = !d.alive;
        }
      }

      const body = findPhysicsBody(mesh);
      if (body && !body.isDisposed) {
        const idx = pick.thinInstanceIndex >= 0 && body.transformNode === mesh ? pick.thinInstanceIndex : undefined;
        if (body.getMotionType(idx) === PhysicsMotionType.DYNAMIC) {
          const mass = body.getMassProperties(idx).mass ?? 1;
          this.dir.scaleToRef(RIFLE.impulseSpeed * Math.min(mass, RIFLE.impulseMassCap), this.impulse);
          body.applyImpulse(this.impulse, point, idx);
          if (!d) kind = "prop";
        }
      }

      ctx.fx.tracer(this.muzzle.clone(), point.clone());
      ctx.fx.impact(point.clone(), normal, kind);
      ctx.events.emit("hit", { kind, point, killed });
    } else {
      const far = origin.add(this.dir.scale(RIFLE.range));
      ctx.fx.tracer(this.muzzle.clone(), far);
    }

    // Recoil: pitch kick + small random yaw; ~60% springs back.
    const pitchKick = RIFLE.recoilPitch * (0.85 + Math.random() * 0.3);
    const yawKick = (Math.random() * 2 - 1) * RIFLE.recoilYaw;
    this.rig.kick(pitchKick, yawKick, RIFLE.recoilRecoverFraction);
    this.vm.fireKick();

    ctx.events.emit("weapon:fire", { weapon: "rifle" });
    this.emitAmmo();
  }
}
