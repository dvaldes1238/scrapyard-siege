import {
  Color3,
  Constants,
  Material,
  MeshBuilder,
  PhysicsBody,
  PhysicsMotionType,
  PhysicsShapeSphere,
  Quaternion,
  StandardMaterial,
  TrailMesh,
  TransformNode,
  Vector3,
  type Mesh,
  type Observer,
  type IPhysicsCollisionEvent,
} from "@babylonjs/core";
import type { GameContext } from "../core/context";
import { markNoHit, type Damageable } from "../core/damage";
import type { HitKind } from "../core/events";
import { explode } from "../core/explosion";
import { LAUNCHER } from "./config";
import { PLAYER_COLLISION_BIT } from "./movement";

type GrenadeState = "idle" | "flying" | "fading";

interface Grenade {
  node: TransformNode; // physics node (rotation locked)
  visual: Mesh; // child of node, offset decays from the launcher tube to the body
  trail: TrailMesh;
  body: PhysicsBody | null;
  observer: Observer<IPhysicsCollisionEvent> | null;
  state: GrenadeState;
  age: number;
  fade: number;
  contact: boolean;
  offset: Vector3;
}

const POOL_SIZE = 5;

/**
 * Under-barrel kinetic grenades: pooled visuals + trails, a fresh Havok body per shot.
 * Contacts are flagged in the body's collision observable and resolved after the physics step.
 */
export class Launcher {
  charges = LAUNCHER.maxCharges;
  rechargeProgress = 0;

  private cooldown = 0;
  private lastEmit = -1;
  private lastEmittedCharges = -1;
  private clock = 0;
  private readonly pool: Grenade[] = [];
  /** Emissive meshes (for glow-layer registration if the layer runs in include-only mode). */
  readonly glowMeshes: Mesh[] = [];
  private readonly shape: PhysicsShapeSphere;
  private readonly tmp = new Vector3();

  constructor(private readonly ctx: GameContext) {
    const scene = ctx.scene;

    this.shape = new PhysicsShapeSphere(Vector3.Zero(), LAUNCHER.radius, scene);
    this.shape.material = { friction: 0.4, restitution: 0.35 };
    // Never collide with the player's own capsule.
    this.shape.filterCollideMask = ~PLAYER_COLLISION_BIT;

    const coreMat = new StandardMaterial("grenadeCoreMat", scene);
    coreMat.diffuseColor = new Color3(0.08, 0.05, 0.02);
    coreMat.specularColor = new Color3(0.3, 0.25, 0.2);
    coreMat.emissiveColor = new Color3(1.0, 0.55, 0.15);

    const trailMat = new StandardMaterial("grenadeTrailMat", scene);
    trailMat.disableLighting = true;
    trailMat.diffuseColor = Color3.Black();
    trailMat.specularColor = Color3.Black();
    trailMat.emissiveColor = new Color3(1.0, 0.5, 0.12);
    trailMat.alpha = 0.55;
    trailMat.backFaceCulling = false;
    trailMat.disableDepthWrite = true;
    trailMat.transparencyMode = Material.MATERIAL_ALPHABLEND;
    trailMat.alphaMode = Constants.ALPHA_ADD;

    for (let i = 0; i < POOL_SIZE; i++) {
      const node = new TransformNode(`grenade${i}`, scene);
      node.rotationQuaternion = Quaternion.Identity();
      const visual = MeshBuilder.CreateSphere(`grenadeCore${i}`, { diameter: LAUNCHER.radius * 2, segments: 10 }, scene);
      visual.parent = node;
      visual.material = coreMat;
      markNoHit(visual);
      const trail = new TrailMesh(`grenadeTrail${i}`, visual, scene, { diameter: 0.07, length: 10, autoStart: false });
      trail.material = trailMat;
      markNoHit(trail);
      node.setEnabled(false);
      trail.setEnabled(false);
      this.glowMeshes.push(visual, trail);
      this.pool.push({
        node,
        visual,
        trail,
        body: null,
        observer: null,
        state: "idle",
        age: 0,
        fade: 0,
        contact: false,
        offset: new Vector3(),
      });
    }

    // Resolve contacts right after the physics step that produced them (never inside the callback).
    scene.onAfterPhysicsObservable.add(() => {
      if (this.ctx.state.phase === "paused") return;
      for (const g of this.pool) {
        if (g.state === "flying" && g.contact) this.detonate(g);
      }
    });
  }

  reset(): void {
    for (const g of this.pool) if (g.state !== "idle") this.release(g);
    this.charges = LAUNCHER.maxCharges;
    this.rechargeProgress = 0;
    this.cooldown = 0;
    this.lastEmittedCharges = -1;
  }

  emitState(force = false): void {
    if (!force && this.charges === this.lastEmittedCharges && this.clock - this.lastEmit < LAUNCHER.eventInterval) return;
    this.lastEmit = this.clock;
    this.lastEmittedCharges = this.charges;
    this.ctx.events.emit("launcher:changed", {
      charges: this.charges,
      maxCharges: LAUNCHER.maxCharges,
      rechargeProgress: this.rechargeProgress,
    });
  }

  /** Gameplay tick: recharge and cooldown. */
  update(dt: number): void {
    this.clock += dt;
    this.cooldown = Math.max(0, this.cooldown - dt);
    if (this.charges < LAUNCHER.maxCharges) {
      this.rechargeProgress += dt / LAUNCHER.rechargeTime;
      if (this.rechargeProgress >= 1) {
        this.charges++;
        this.rechargeProgress = this.charges < LAUNCHER.maxCharges ? this.rechargeProgress - 1 : 0;
      }
      this.emitState();
    } else if (this.rechargeProgress !== 0) {
      this.rechargeProgress = 0;
      this.emitState(true);
    }
  }

  /**
   * Try to launch. Returns true if a grenade left the tube.
   * spawn: where the physics body starts (inside the player's capsule is fine: filtered).
   * visualFrom: launcher muzzle in world space; the visible core eases from there onto the body.
   */
  tryFire(spawn: Vector3, dir: Vector3, playerVel: Vector3, visualFrom: Vector3): boolean {
    if (this.cooldown > 0) return false;
    if (this.charges <= 0) {
      this.ctx.events.emit("weapon:empty", { weapon: "launcher" });
      this.cooldown = 0.25;
      return false;
    }
    const g = this.pool.find((p) => p.state === "idle") ?? this.oldestFlying();
    if (!g) return false;
    if (g.state !== "idle") this.release(g);

    this.charges--;
    this.cooldown = LAUNCHER.cooldown;
    this.launch(g, spawn, dir, playerVel, visualFrom);
    this.ctx.events.emit("weapon:fire", { weapon: "launcher" });
    this.emitState(true);
    return true;
  }

  private oldestFlying(): Grenade | undefined {
    let best: Grenade | undefined;
    for (const g of this.pool) if (g.state === "flying" && (!best || g.age > best.age)) best = g;
    return best;
  }

  private launch(g: Grenade, spawn: Vector3, dir: Vector3, playerVel: Vector3, visualFrom: Vector3): void {
    const scene = this.ctx.scene;
    g.node.position.copyFrom(spawn);
    g.node.rotationQuaternion!.copyFromFloats(0, 0, 0, 1);
    g.offset.copyFrom(visualFrom).subtractInPlace(spawn);
    g.visual.position.copyFrom(g.offset);
    g.node.setEnabled(true);
    g.node.computeWorldMatrix(true);
    g.visual.computeWorldMatrix(true);

    const body = new PhysicsBody(g.node, PhysicsMotionType.DYNAMIC, false, scene);
    body.shape = this.shape;
    // Zero inertia locks rotation, so the visual child's offset stays in world space.
    body.setMassProperties({ mass: LAUNCHER.mass, inertia: Vector3.Zero() });
    body.setLinearDamping(0.05);
    const v = dir.scale(LAUNCHER.speed).addInPlace(playerVel);
    v.y += LAUNCHER.upBoost;
    body.setLinearVelocity(v);
    body.setCollisionCallbackEnabled(true);
    g.observer = body.getCollisionObservable().add(() => {
      if (g.state === "flying" && g.age >= LAUNCHER.armTime) g.contact = true;
    });
    g.body = body;
    g.state = "flying";
    g.age = 0;
    g.contact = false;

    this.ctx.dynamicBodies.add(body);
    this.ctx.world.addShadowCaster?.(g.visual);

    g.trail.setEnabled(true);
    g.trail.visibility = 1;
    g.trail.reset();
    g.trail.start();
  }

  /** Cosmetic + fuse tick. Runs every frame except while paused. */
  frame(dt: number): void {
    for (const g of this.pool) {
      if (g.state === "flying") {
        g.age += dt;
        // Ease the visible core from the launcher tube onto the physics body.
        g.offset.scaleInPlace(Math.exp(-28 * dt));
        g.visual.position.copyFrom(g.offset);
        if (g.age >= LAUNCHER.fuse) {
          this.detonate(g);
        } else if (g.node.position.y < -20) {
          this.release(g);
        }
      } else if (g.state === "fading") {
        g.fade -= dt;
        g.trail.visibility = Math.max(0, g.fade / LAUNCHER.trailFade);
        if (g.fade <= 0) {
          g.trail.setEnabled(false);
          g.state = "idle";
        }
      }
    }
  }

  private detonate(g: Grenade): void {
    if (g.state !== "flying") return;
    const pos = this.tmp.copyFrom(g.node.position);
    const { radius, force, damage, playerDamageScale } = LAUNCHER.explosion;

    // Who's in range before the blast (for the hit marker).
    const candidates: Damageable[] = [];
    for (const d of this.ctx.damageables) {
      if (d.alive && Vector3.Distance(d.getPosition(), pos) <= radius) candidates.push(d);
    }

    const at = pos.clone();
    this.release(g, true);
    explode(this.ctx, at, { radius, force, damage, source: "launcher", playerDamageScale });

    if (candidates.length) {
      let kind: HitKind = candidates[0]!.kind;
      let killed = false;
      for (const d of candidates) {
        if (!d.alive) {
          killed = true;
          if (d.kind === "enemy") kind = "enemy";
        }
      }
      this.ctx.events.emit("hit", { kind, point: at, killed });
    }
  }

  /** Remove the body (unregister + dispose); keep the trail fading if requested. */
  private release(g: Grenade, fadeTrail = false): void {
    if (g.body) {
      if (g.observer) {
        g.body.getCollisionObservable().remove(g.observer);
        g.observer = null;
      }
      this.ctx.dynamicBodies.delete(g.body);
      g.body.dispose();
      g.body = null;
      this.ctx.world.removeShadowCaster?.(g.visual);
    }
    g.node.setEnabled(false);
    g.trail.stop();
    g.contact = false;
    if (fadeTrail) {
      g.state = "fading";
      g.fade = LAUNCHER.trailFade;
    } else {
      g.trail.setEnabled(false);
      g.state = "idle";
    }
  }
}
