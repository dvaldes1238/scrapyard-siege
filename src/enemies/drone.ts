import {
  Mesh,
  PhysicsBody,
  PhysicsMotionType,
  PhysicsPrestepType,
  Quaternion,
  TransformNode,
  Vector3,
  type InstancedMesh,
} from "@babylonjs/core";
import type { Phase } from "../core/context";
import { markNoHit, setDamageable, type Damageable, type DamageInfo } from "../core/damage";
import { explode } from "../core/explosion";
import {
  APPEAR_TIME,
  BOLT,
  BOMBER_AI,
  BOMBER_BLAST,
  BRUTE_AI,
  DEATH_BLAST,
  DRONES,
  FLIGHT,
  HIT_FLASH_TIME,
  SEEKER_AI,
  type DroneSpec,
  type DroneType,
} from "./config";
import type { EnemySystem } from "./system";

const TAU = Math.PI * 2;
const DOWN = new Vector3(0, -1, 0);

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);
const smooth = (rate: number, dt: number) => 1 - Math.exp(-rate * dt);

function lerpAngle(from: number, to: number, t: number): number {
  let d = (to - from) % TAU;
  if (d > Math.PI) d -= TAU;
  else if (d < -Math.PI) d += TAU;
  return from + d * t;
}

function easeOutBack(t: number): number {
  const c = 1.9;
  const u = t - 1;
  return 1 + (c + 1) * u * u * u + c * u * u;
}

// Scratch vectors (drones update sequentially, never re-entrantly for these).
const tmpA = new Vector3();
const tmpB = new Vector3();
const tmpMuzzle = new Vector3();

interface Rotor {
  spinner: TransformNode;
  ring: InstancedMesh;
  spin: number;
  precess: number;
}

/**
 * One hover drone. Root = empty Mesh carrying the ANIMATED Havok sphere and the Damageable tag;
 * pivot child carries bob / bank / yaw; all visible parts are instances of shared templates.
 */
export class Drone implements Damageable {
  readonly kind = "enemy" as const;
  readonly type: DroneType;
  readonly spec: DroneSpec;
  readonly root: Mesh;
  /** Authoritative AI position (this is root.position). */
  readonly position: Vector3;
  readonly velocity = new Vector3();

  private readonly sys: EnemySystem;
  private readonly pivot: TransformNode;
  private readonly eye: InstancedMesh;
  private readonly flash: InstancedMesh;
  private readonly thruster: InstancedMesh;
  private readonly rotors: Rotor[] = [];
  private readonly muzzles: Vector3[];
  private readonly eyeLocal: Vector3;
  private body: PhysicsBody | null;
  private hp: number;
  private _alive = true;

  // Cosmetic state.
  private time = Math.random() * 10;
  private readonly bobPhase = Math.random() * TAU;
  private yaw = 0;
  private pitch = 0;
  private roll = 0;
  private flashTimer = 0;
  private appear = 0;
  private blink = 0;
  /** 0..1 eye flare before a shot. */
  private charge = 0;
  private shotKick = 0;

  // Steering state.
  private readonly desired = new Vector3();
  private readonly avoid = new Vector3();
  private avoidTimer = 0;
  private probeTimer = Math.random() * FLIGHT.probeInterval;
  private floorY: number;

  // Behaviour state.
  private orbitDir = Math.random() < 0.5 ? 1 : -1;
  private orbitRadius = rand(SEEKER_AI.orbitMin, SEEKER_AI.orbitMax);
  private altitude: number;
  private retargetTimer: number;
  private strafeTimer = rand(SEEKER_AI.strafeMin, SEEKER_AI.strafeMax);
  private strafeTime = 0;
  private strafeSign = 1;
  private strafeLift = 0;
  private fireTimer: number;
  private burstLeft = 0;
  private burstTimer = 0;
  private muzzleIndex = 0;
  private diving = false;

  constructor(sys: EnemySystem, type: DroneType, spawnPosition: Vector3) {
    this.sys = sys;
    this.type = type;
    this.spec = DRONES[type];
    this.hp = this.spec.hp;
    const ctx = sys.ctx;
    const scene = ctx.scene;
    const tpl = sys.assets.drones[type];
    const id = sys.nextId();

    // --- Hierarchy -------------------------------------------------------------------------
    this.root = new Mesh(`drone-${type}-${id}`, scene);
    this.root.isPickable = false; // no geometry; children are the hit surfaces
    this.root.position.copyFrom(spawnPosition);
    this.root.rotationQuaternion = Quaternion.Identity();
    this.position = this.root.position;

    this.pivot = new TransformNode(`drone-pivot-${id}`, scene);
    this.pivot.parent = this.root;
    this.pivot.rotationQuaternion = Quaternion.Identity();
    this.pivot.scaling.setAll(0.01);

    const part = (template: Mesh, parent: TransformNode, name: string): InstancedMesh => {
      const inst = template.createInstance(`${name}-${id}`);
      inst.parent = parent;
      inst.isPickable = true;
      inst.metadata = { enemyPart: true };
      return inst;
    };
    part(tpl.hull, this.pivot, "drone-hull");
    part(tpl.plates, this.pivot, "drone-plates");
    this.flash = part(tpl.flash, this.pivot, "drone-flash");
    this.flash.isVisible = false;
    this.eye = part(tpl.eye, this.pivot, "drone-eye");
    this.eye.position.copyFrom(tpl.eyePosition);
    this.eyeLocal = tpl.eyePosition;
    this.thruster = part(tpl.thruster, this.pivot, "drone-thruster");
    this.thruster.position.copyFrom(tpl.thrusterPosition);
    markNoHit(this.thruster); // the flame is not a hitbox
    for (const r of tpl.rotors) {
      const spinner = new TransformNode(`drone-rotor-${id}`, scene);
      spinner.parent = this.pivot;
      spinner.position.copyFrom(r.position);
      spinner.rotation.y = Math.random() * TAU;
      const tilt = new TransformNode(`drone-rotor-tilt-${id}`, scene);
      tilt.parent = spinner;
      tilt.rotation.copyFrom(r.tilt);
      const ring = part(r.mesh, tilt, "drone-rotor-ring");
      ring.scaling.setAll(r.scale);
      ring.rotation.y = Math.random() * TAU;
      this.rotors.push({ spinner, ring, spin: r.spin * rand(0.9, 1.1), precess: r.precess });
    }
    this.muzzles = tpl.muzzles;

    // --- Physics: kinematic sphere that follows the root (ACTION prestep = setTargetTransform
    // every step, so the body has a real velocity and grenades bounce/detonate on it). ---------
    this.root.computeWorldMatrix(true);
    this.body = new PhysicsBody(this.root, PhysicsMotionType.ANIMATED, false, scene);
    this.body.shape = sys.assets.shapes[type];
    this.body.setPrestepType(PhysicsPrestepType.ACTION);
    this.body.disableSync = true; // node drives body, never the other way round

    // --- Registration --------------------------------------------------------------------------
    setDamageable(this.root, this);
    ctx.damageables.add(this);
    ctx.world.addShadowCaster(this.root, true);
    ctx.world.removeShadowCaster(this.thruster);

    // --- Behaviour init ------------------------------------------------------------------------
    this.floorY = sys.baseY;
    if (type === "brute") {
      this.altitude = sys.baseY + rand(BRUTE_AI.altMin, BRUTE_AI.altMax);
      this.fireTimer = rand(BRUTE_AI.firstBurstMin, BRUTE_AI.firstBurstMax);
      this.retargetTimer = rand(4, 7);
    } else {
      this.altitude = sys.baseY + rand(SEEKER_AI.altMin, SEEKER_AI.altMax);
      this.fireTimer = rand(SEEKER_AI.firstShotMin, SEEKER_AI.firstShotMax);
      this.retargetTimer = rand(SEEKER_AI.retargetMin, SEEKER_AI.retargetMax);
    }
    const eyePos = ctx.player.getEyePosition();
    this.yaw = Math.atan2(eyePos.x - spawnPosition.x, eyePos.z - spawnPosition.z);
  }

  // ===========================================================================================
  // Damageable
  // ===========================================================================================

  get alive(): boolean {
    return this._alive;
  }

  /** One-line AI state for the ?debug=1 overlay. */
  debugInfo(): string {
    const mode = this.diving
      ? "dive"
      : this.burstLeft > 0
        ? `burst×${this.burstLeft}`
        : this.strafeTime > 0
          ? "strafe"
          : this.type === "seeker"
            ? `orbit r${this.orbitRadius.toFixed(0)}`
            : "approach";
    const fire = this.type === "bomber" ? "" : ` · fire ${Math.max(0, this.fireTimer).toFixed(1)}s`;
    return `${this.type} ${Math.ceil(this.hp)}hp · ${mode}${fire}`;
  }

  getPosition(): Vector3 {
    return this.position.clone();
  }

  takeDamage(amount: number, info: DamageInfo): void {
    if (!this._alive || !(amount > 0)) return;
    this.hp -= amount;
    this.flashTimer = HIT_FLASH_TIME;
    this.flash.isVisible = true;

    // Slight knockback along the shot (or away from the blast).
    let dir: Vector3 | null = null;
    if (info.direction && info.direction.lengthSquared() > 1e-6) dir = tmpA.copyFrom(info.direction);
    else if (info.point) dir = this.position.subtractToRef(info.point, tmpA);
    if (dir && dir.lengthSquared() > 1e-6) {
      const k = info.source === "explosion" ? this.spec.knockback * 3 : this.spec.knockback;
      dir.normalize().scaleInPlace(k);
      this.velocity.addInPlace(dir);
    }

    if (this.hp <= 0) this.die(false);
  }

  // ===========================================================================================
  // Death / cleanup
  // ===========================================================================================

  /**
   * Death is guarded by _alive: explode() below can re-enter takeDamage on this drone (or chain
   * into others) and must never kill it twice.
   */
  private die(detonated: boolean): void {
    if (!this._alive) return;
    this._alive = false;
    const ctx = this.sys.ctx;
    const pos = this.position.add(this.pivot.position);
    this.sys.retire(this);

    // Kills from any source count (rifle, grenades, barrels, other drones' blasts);
    // a bomber blowing itself up on the player does not.
    if (!detonated && ctx.state.phase === "playing") {
      ctx.state.kills += 1;
      ctx.state.score += this.spec.points;
      ctx.events.emit("enemy:killed", { position: pos.clone(), points: this.spec.points });
      ctx.events.emit("score:changed", { score: ctx.state.score, kills: ctx.state.kills });
    }

    explode(ctx, pos, detonated ? BOMBER_BLAST : DEATH_BLAST);
    ctx.fx.shatter(pos, { color: this.spec.color.clone(), count: this.spec.debrisCount, size: this.spec.debrisSize });
  }

  /** Silent removal (restart): no explosion, score or events. */
  despawn(): void {
    if (!this._alive) return;
    this._alive = false;
    this.sys.retire(this);
  }

  disposeBody(): void {
    if (this.body && !this.body.isDisposed) this.body.dispose();
    this.body = null;
  }

  disposeMeshes(): void {
    this.disposeBody();
    this.root.dispose(false, false);
  }

  // ===========================================================================================
  // Gameplay tick
  // ===========================================================================================

  update(dt: number): void {
    if (!this._alive) return;

    this.probeTimer -= dt;
    if (this.probeTimer <= 0) {
      this.probeTimer = FLIGHT.probeInterval * rand(0.8, 1.2);
      this.probe();
    }
    this.avoidTimer -= dt;

    this.desired.setAll(0);
    const feet = this.sys.ctx.player.getFeetPosition();
    if (this.type === "seeker") this.thinkSeeker(dt, feet);
    else if (this.type === "bomber") {
      this.thinkBomber(feet);
      if (!this._alive) return; // detonated
    } else this.thinkBrute(dt, feet);

    this.applyConstraints();

    // Accelerate toward the desired velocity (bounded acceleration = smooth, no jitter).
    const dv = this.desired.subtractToRef(this.velocity, tmpA);
    const maxDv = this.spec.accel * dt;
    const len = dv.length();
    if (len > maxDv) dv.scaleInPlace(maxDv / len);
    this.velocity.addInPlace(dv);

    this.integrate(dt);
  }

  private integrate(dt: number): void {
    const p = this.position;
    const v = this.velocity;
    p.x += v.x * dt;
    p.y += v.y * dt;
    p.z += v.z * dt;

    // Hard envelope: inside bounds, altitude band above the arena floor.
    const b = this.sys.ctx.world.bounds;
    const m = 0.5 + this.spec.hitRadius * 0.5;
    if (p.x < b.minX + m) (p.x = b.minX + m), (v.x = Math.max(v.x, 0));
    else if (p.x > b.maxX - m) (p.x = b.maxX - m), (v.x = Math.min(v.x, 0));
    if (p.z < b.minZ + m) (p.z = b.minZ + m), (v.z = Math.max(v.z, 0));
    else if (p.z > b.maxZ - m) (p.z = b.maxZ - m), (v.z = Math.min(v.z, 0));
    const minY = this.sys.baseY + FLIGHT.altMin;
    const maxY = this.sys.baseY + FLIGHT.altMax;
    if (p.y < minY) (p.y = minY), (v.y = Math.max(v.y, 0));
    else if (p.y > maxY) (p.y = maxY), (v.y = Math.min(v.y, 0));

    // Keep the world matrix current: the ACTION prestep reads absolutePosition.
    this.root.computeWorldMatrix(true);
  }

  /** Periodic floor + obstacle probes (cheap ray picks, staggered per drone). */
  private probe(): void {
    const p = this.position;
    const down = this.sys.raycast(p, DOWN, 40);
    this.floorY = down ? Math.max(down.pickedPoint!.y, this.sys.baseY) : this.sys.baseY;

    const speed = this.velocity.length();
    if (speed < 0.5) return;
    const dir = this.velocity.scaleToRef(1 / speed, tmpB);
    const hit = this.sys.raycast(p, dir, this.spec.hitRadius + speed * 0.6 + 0.6);
    if (!hit) return;
    const n = hit.getNormal(true, false);
    // Ground-like surfaces are handled by the altitude rules (and bombers must be able to dive).
    if (!n || n.y > 0.7) return;
    this.avoid.copyFrom(n);
    this.avoid.y = Math.max(this.avoid.y, 0) + 0.6;
    this.avoid.normalize();
    this.avoidTimer = 0.5;
  }

  private applyConstraints(): void {
    const p = this.position;
    const d = this.desired;
    const s = this.spec.speed;

    // Separation from other drones.
    let sx = 0;
    let sy = 0;
    let sz = 0;
    for (const o of this.sys.drones) {
      if (o === this || !o.alive) continue;
      const ox = p.x - o.position.x;
      const oy = p.y - o.position.y;
      const oz = p.z - o.position.z;
      const min = this.spec.hitRadius + o.spec.hitRadius + FLIGHT.separationGap;
      const d2 = ox * ox + oy * oy + oz * oz;
      if (d2 >= min * min) continue;
      if (d2 < 1e-6) {
        sx += Math.random() - 0.5;
        sz += Math.random() - 0.5;
        continue;
      }
      const dist = Math.sqrt(d2);
      const w = (1 - dist / min) / dist;
      sx += ox * w;
      sy += oy * w * 0.5;
      sz += oz * w;
    }
    const sepScale = s * FLIGHT.separationStrength * (this.diving ? 0.3 : 1);
    d.x += sx * sepScale;
    d.y += sy * sepScale;
    d.z += sz * sepScale;

    // Obstacle avoidance from the last forward probe.
    if (this.avoidTimer > 0) {
      const k = s * 1.3;
      d.x += this.avoid.x * k;
      d.y += this.avoid.y * k;
      d.z += this.avoid.z * k;
    }

    // Altitude band (soft) relative to whatever is underneath (containers, stacks).
    const minY = Math.max(this.floorY, this.sys.baseY) + FLIGHT.altMin + this.spec.hitRadius * 0.5;
    const maxY = this.sys.baseY + FLIGHT.altMax;
    if (p.y < minY + 0.5) d.y = Math.max(d.y, (minY + 0.5 - p.y) * 3);
    if (p.y > maxY - 0.5) d.y = Math.min(d.y, (maxY - 0.5 - p.y) * 3);

    // Bounds (soft).
    const b = this.sys.ctx.world.bounds;
    const m = FLIGHT.boundsMargin;
    if (p.x < b.minX + m) d.x += (b.minX + m - p.x) * 1.5;
    else if (p.x > b.maxX - m) d.x -= (p.x - (b.maxX - m)) * 1.5;
    if (p.z < b.minZ + m) d.z += (b.minZ + m - p.z) * 1.5;
    else if (p.z > b.maxZ - m) d.z -= (p.z - (b.maxZ - m)) * 1.5;
  }

  // ===========================================================================================
  // Behaviours
  // ===========================================================================================

  /** Orbit the player at 10–16 m / 3–8 m altitude, juke sideways, shoot with LOS. */
  private thinkSeeker(dt: number, feet: Vector3): void {
    const ai = SEEKER_AI;
    const s = this.spec.speed;
    const p = this.position;

    this.retargetTimer -= dt;
    if (this.retargetTimer <= 0) {
      this.retargetTimer = rand(ai.retargetMin, ai.retargetMax);
      if (Math.random() < ai.reverseChance) this.orbitDir *= -1;
      this.orbitRadius = rand(ai.orbitMin, ai.orbitMax);
      this.altitude = this.sys.baseY + rand(ai.altMin, ai.altMax);
    }
    this.strafeTimer -= dt;
    if (this.strafeTimer <= 0) {
      this.strafeTimer = rand(ai.strafeMin, ai.strafeMax);
      this.strafeTime = ai.strafeTime;
      this.strafeSign = Math.random() < 0.5 ? 1 : -1;
      this.strafeLift = rand(-0.35, 0.35);
    }
    this.strafeTime -= dt;

    const dx = feet.x - p.x;
    const dz = feet.z - p.z;
    const dist = Math.hypot(dx, dz) || 0.001;
    const rx = dx / dist;
    const rz = dz / dist;
    const tx = -rz * this.orbitDir;
    const tz = rx * this.orbitDir;
    const radial = clamp((dist - this.orbitRadius) * 0.9, -s, s);
    let vx = tx * s * 0.7 + rx * radial;
    let vz = tz * s * 0.7 + rz * radial;
    const h = Math.hypot(vx, vz);
    if (h > s) {
      vx *= s / h;
      vz *= s / h;
    }
    let vy = clamp((this.altitude - p.y) * 1.2, -s * 0.6, s * 0.6);
    if (this.strafeTime > 0) {
      const boost = s * ai.strafeBoost * this.strafeSign;
      vx += tx * boost;
      vz += tz * boost;
      vy += this.strafeLift * s;
    }
    this.desired.set(vx, vy, vz);

    this.fireTimer -= dt;
    this.charge = 1 - clamp(this.fireTimer / ai.chargeTime, 0, 1);
    if (this.fireTimer <= 0) {
      if (this.canShoot()) {
        this.shoot(ai.spreadDeg);
        this.fireTimer = rand(ai.fireMin, ai.fireMax);
      } else {
        this.fireTimer = rand(0.25, 0.4);
      }
    }
  }

  /** Cruise in at altitude, then dive at the player (with lead) and detonate within 2.2 m. */
  private thinkBomber(feet: Vector3): void {
    const ai = BOMBER_AI;
    const s = this.spec.speed;
    const p = this.position;
    const player = this.sys.ctx.player;
    const dx = feet.x - p.x;
    const dy = feet.y + player.height * 0.55 - p.y;
    const dz = feet.z - p.z;
    const hd = Math.hypot(dx, dz) || 0.001;
    const dist = Math.sqrt(hd * hd + dy * dy);

    if (player.alive && dist <= ai.triggerDistance) {
      this.die(true);
      return;
    }

    if (hd > ai.diveDistance) {
      this.diving = false;
      const vy = clamp((this.sys.baseY + ai.cruiseAlt - p.y) * 1.5, -s * 0.5, s * 0.5);
      this.desired.set((dx / hd) * s, vy, (dz / hd) * s);
    } else {
      this.diving = true;
      const pv = player.getVelocity();
      const t = Math.min(dist / s, 1.2) * ai.lead;
      const ax = dx + pv.x * t;
      const az = dz + pv.z * t;
      const l = Math.hypot(ax, dy, az) || 0.001;
      this.desired.set((ax / l) * s, (dy / l) * s, (az / l) * s);
    }
  }

  /** Advance slowly to ~11 m, drift sideways, fire 3-bolt bursts every 3 s with LOS. */
  private thinkBrute(dt: number, feet: Vector3): void {
    const ai = BRUTE_AI;
    const s = this.spec.speed;
    const p = this.position;

    this.retargetTimer -= dt;
    if (this.retargetTimer <= 0) {
      this.retargetTimer = rand(4, 7);
      if (Math.random() < 0.5) this.orbitDir *= -1;
      this.altitude = this.sys.baseY + rand(ai.altMin, ai.altMax);
    }

    const dx = feet.x - p.x;
    const dz = feet.z - p.z;
    const dist = Math.hypot(dx, dz) || 0.001;
    const rx = dx / dist;
    const rz = dz / dist;
    const radial = clamp((dist - ai.preferredDistance) * 0.6, -s, s);
    const drift = s * ai.drift * this.orbitDir;
    const vy = clamp((this.altitude - p.y) * 0.8, -s * 0.5, s * 0.5);
    this.desired.set(rx * radial - rz * drift, vy, rz * radial + rx * drift);

    if (this.burstLeft > 0) {
      this.charge = 1;
      this.burstTimer -= dt;
      if (this.burstTimer <= 0) {
        if (this.sys.ctx.player.alive) this.shoot(ai.spreadDeg);
        this.burstLeft--;
        this.burstTimer = ai.burstGap;
      }
      return;
    }
    this.fireTimer -= dt;
    this.charge = 1 - clamp(this.fireTimer / ai.chargeTime, 0, 1);
    if (this.fireTimer <= 0) {
      if (this.canShoot()) {
        this.burstLeft = ai.burstCount;
        this.burstTimer = 0;
        this.fireTimer = Math.max(0.5, ai.burstInterval - ai.burstCount * ai.burstGap);
      } else {
        this.fireTimer = rand(0.3, 0.5);
      }
    }
  }

  // ===========================================================================================
  // Shooting
  // ===========================================================================================

  private localToWorld(local: Vector3, out: Vector3): Vector3 {
    this.pivot.computeWorldMatrix(true);
    return Vector3.TransformCoordinatesToRef(local, this.pivot.getWorldMatrix(), out);
  }

  private canShoot(): boolean {
    const player = this.sys.ctx.player;
    if (!player.alive) return false;
    const from = this.localToWorld(this.eyeLocal, tmpMuzzle);
    return this.sys.hasLineOfSight(from, player.getEyePosition(), FLIGHT.fireRange);
  }

  private shoot(spreadDeg: number): void {
    const player = this.sys.ctx.player;
    const muzzle = this.localToWorld(this.muzzles[this.muzzleIndex++ % this.muzzles.length], tmpMuzzle);
    const feet = player.getFeetPosition();
    const target = tmpB.set(feet.x, feet.y + player.height * 0.62, feet.z);
    // Lead the player a little.
    const t = Vector3.Distance(muzzle, target) / BOLT.speed;
    const pv = player.getVelocity();
    target.x += pv.x * t * BOLT.lead;
    target.y += pv.y * t * BOLT.lead * 0.3;
    target.z += pv.z * t * BOLT.lead;
    const dir = target.subtractInPlace(muzzle).normalize();
    const spread = Math.tan((spreadDeg * Math.PI) / 180);
    dir.x += (Math.random() + Math.random() - 1) * spread;
    dir.y += (Math.random() + Math.random() - 1) * spread;
    dir.z += (Math.random() + Math.random() - 1) * spread;
    dir.normalize();
    this.sys.bolts.fire(muzzle, dir);
    this.shotKick = 1;
  }

  // ===========================================================================================
  // Cosmetics (every frame except paused; keeps drones alive-looking on the game-over screen)
  // ===========================================================================================

  frame(dt: number, phase: Phase): void {
    if (!this._alive) return;
    const spec = this.spec;
    const player = this.sys.ctx.player;
    this.time += dt;

    if (phase !== "playing") {
      // Coast to a hover once gameplay stops.
      this.velocity.scaleInPlace(Math.exp(-2.5 * dt));
      this.charge = Math.max(0, this.charge - dt * 2);
      this.integrate(dt);
    }

    // Warp-in pop.
    if (this.appear < 1) {
      this.appear = Math.min(1, this.appear + dt / APPEAR_TIME);
      this.pivot.scaling.setAll(Math.max(0.01, easeOutBack(this.appear)));
    }

    // Hover bob + slight sway.
    const w = this.time * TAU * spec.bobFreq + this.bobPhase;
    this.pivot.position.set(Math.sin(w * 0.53) * spec.bobAmp * 0.35 * spec.scale, Math.sin(w) * spec.bobAmp * spec.scale, 0);

    // Face the player (bombers face where they fly).
    const eye = player.getEyePosition();
    const p = this.position;
    const v = this.velocity;
    let lx = eye.x - p.x;
    let lz = eye.z - p.z;
    if (this.type === "bomber" && v.x * v.x + v.z * v.z > 1) {
      lx = v.x;
      lz = v.z;
    }
    if (lx * lx + lz * lz > 1e-4) this.yaw = lerpAngle(this.yaw, Math.atan2(lx, lz), smooth(spec.turnRate, dt));

    // Bank / tilt into the velocity (local frame), smoothed.
    const sn = Math.sin(this.yaw);
    const cs = Math.cos(this.yaw);
    const fwd = v.x * sn + v.z * cs;
    const right = v.x * cs - v.z * sn;
    const k = smooth(5, dt);
    this.pitch += (clamp(fwd * 0.05, -0.4, 0.4) - this.pitch) * k;
    this.roll += (clamp(-right * 0.07, -0.5, 0.5) - this.roll) * k;
    Quaternion.RotationYawPitchRollToRef(this.yaw, this.pitch, this.roll, this.pivot.rotationQuaternion!);

    // Rotors.
    for (const r of this.rotors) {
      r.ring.rotation.y += r.spin * dt;
      if (r.precess) r.spinner.rotation.y += r.precess * dt;
    }

    // Thruster flicker; longer flame when climbing.
    const climb = clamp(v.y / spec.speed, -1, 1);
    const f = 0.92 + Math.random() * 0.16;
    this.thruster.scaling.set(f, (0.8 + Math.random() * 0.35) * (1 + climb * 0.45), f);

    // Eye: flare before shots, kick on fire; bomber blinks faster as it closes in.
    this.shotKick = Math.max(0, this.shotKick - dt * 8);
    let eyeScale = 1 + this.charge * 0.6 + this.shotKick * 0.5;
    if (this.type === "bomber") {
      const feet = player.getFeetPosition();
      const d = Math.hypot(feet.x - p.x, feet.y + player.height * 0.55 - p.y, feet.z - p.z);
      const near = 1 - clamp((d - BOMBER_AI.triggerDistance) / 18, 0, 1);
      const period = phase === "playing" ? 0.65 - 0.56 * near : 0.9;
      this.blink = (this.blink + dt / period) % 1;
      this.eye.isVisible = this.blink < 0.5;
      eyeScale = 1 + near * 0.45;
    }
    this.eye.scaling.setAll(eyeScale);

    // Hit flash.
    if (this.flashTimer > 0) {
      this.flashTimer -= dt;
      if (this.flashTimer <= 0) this.flash.isVisible = false;
    }
  }
}
