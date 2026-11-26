import { Ray, Vector3, type PickingInfo } from "@babylonjs/core";
import type { GameContext } from "../core/context";
import { createEnemyAssets, type EnemyAssets } from "./assets";
import { BoltSystem } from "./bolts";
import { Drone } from "./drone";
import type { DroneType } from "./config";
import { worldPredicate } from "./predicates";

/**
 * Owns live drones, the bolt pool and shared helpers (ray casts, LOS, deferred disposal).
 */
export class EnemySystem {
  readonly drones = new Set<Drone>();
  readonly assets: EnemyAssets;
  readonly bolts: BoltSystem;
  /** Arena floor height (altitudes are measured from here). */
  readonly baseY: number;

  private readonly ray = new Ray(Vector3.Zero(), new Vector3(0, 0, 1), 1);
  private readonly tmpDir = new Vector3();
  private disposeQueue: Drone[] = [];
  private idCounter = 0;

  constructor(readonly ctx: GameContext) {
    this.assets = createEnemyAssets(ctx.scene);
    this.bolts = new BoltSystem(this);
    this.baseY = ctx.world.playerSpawn.y;
  }

  nextId(): number {
    return ++this.idCounter;
  }

  /** Nearest world hit along a normalized direction, ignoring drones / noHit meshes. */
  raycast(origin: Vector3, direction: Vector3, length: number): PickingInfo | null {
    this.ray.origin.copyFrom(origin);
    this.ray.direction.copyFrom(direction);
    this.ray.length = length;
    const hit = this.ctx.scene.pickWithRay(this.ray, worldPredicate);
    return hit && hit.hit && hit.pickedPoint ? hit : null;
  }

  /** True when nothing (except drones / noHit meshes) blocks from → to. */
  hasLineOfSight(from: Vector3, to: Vector3, maxRange = Infinity): boolean {
    to.subtractToRef(from, this.tmpDir);
    const dist = this.tmpDir.length();
    if (dist > maxRange) return false;
    // Stop short of the target so the player's own capsule (if it is pickable) never blocks.
    const len = dist - 0.6;
    if (len <= 0) return true;
    this.tmpDir.scaleInPlace(1 / dist);
    return !this.raycast(from, this.tmpDir, len);
  }

  spawnDrone(type: DroneType, position: Vector3): Drone {
    const drone = new Drone(this, type, position);
    this.drones.add(drone);
    this.ctx.events.emit("enemy:spawned", { position: position.clone() });
    return drone;
  }

  /**
   * Unregisters a dead/despawned drone right away (damageables, shadows, physics body) and
   * hides it; meshes are disposed next frame so callers mid-pick never see a disposed mesh.
   */
  retire(drone: Drone): void {
    this.drones.delete(drone);
    this.ctx.damageables.delete(drone);
    this.ctx.world.removeShadowCaster(drone.root);
    drone.root.setEnabled(false);
    drone.disposeBody();
    this.disposeQueue.push(drone);
  }

  /** Removes every drone and bolt without explosions, score or events (restart). */
  clearAll(): void {
    for (const d of [...this.drones]) d.despawn();
    this.bolts.clear();
    this.flushDisposals();
  }

  /** Gameplay tick (only while playing). */
  update(dt: number): void {
    for (const d of [...this.drones]) {
      // A bomber blast can kill the player mid-loop (phase -> "gameover"): stop acting then.
      if (this.ctx.state.phase !== "playing") return;
      if (d.alive) d.update(dt);
    }
    this.bolts.update(dt);
  }

  /** Every frame: cosmetics + deferred disposal. */
  frame(dt: number): void {
    this.flushDisposals();
    const phase = this.ctx.state.phase;
    if (phase === "paused") return;
    for (const d of this.drones) d.frame(dt, phase);
  }

  private flushDisposals(): void {
    if (!this.disposeQueue.length) return;
    for (const d of this.disposeQueue) d.disposeMeshes();
    this.disposeQueue = [];
  }
}
