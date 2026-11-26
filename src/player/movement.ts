import {
  CharacterSupportedState,
  PhysicsCharacterController,
  Vector3,
  type CharacterSurfaceInfo,
} from "@babylonjs/core";
import type { GameContext } from "../core/context";
import { DEG, PLAYER } from "./config";
import { clamp } from "./util";

/** Collision-filter bit for the player capsule. Grenades exclude it so they never hit their owner. */
export const PLAYER_COLLISION_BIT = 1 << 12;

/**
 * Babylon's step-up probes forward by only speed × dt (≈0.1 m at walk speed), but a
 * 0.4 m capsule must travel ~0.17 m past the blocking edge before the landing on top
 * counts as walkable, so steps only worked above ~10 m/s. Widen the probe to a minimum
 * distance (only when actually moving). Overrides a protected method: re-check on upgrades.
 */
class SteppingCharacterController extends PhysicsCharacterController {
  minStepProbe = 0.2;
  private readonly probeVel = new Vector3();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected override _tryStepUp(remainingTime: number, inputVelocity: Vector3, simplexOutput: any, constraints: any): number {
    const up = this.up;
    const vUp = Vector3.Dot(inputVelocity, up);
    const hx = inputVelocity.x - up.x * vUp;
    const hy = inputVelocity.y - up.y * vUp;
    const hz = inputVelocity.z - up.z * vUp;
    const hLen = Math.sqrt(hx * hx + hy * hy + hz * hz);
    const dist = hLen * remainingTime;
    if (hLen < 1 || dist <= 0 || dist >= this.minStepProbe) {
      return super._tryStepUp(remainingTime, inputVelocity, simplexOutput, constraints);
    }
    inputVelocity.scaleToRef(this.minStepProbe / dist, this.probeVel);
    return super._tryStepUp(remainingTime, this.probeVel, simplexOutput, constraints);
  }
}

const DOWN = new Vector3(0, -1, 0);
const HALF_HEIGHT = PLAYER.height / 2;

export interface MoveIntent {
  /** -1..1 forward/back and strafe, relative to yaw. */
  forward: number;
  strafe: number;
  sprint: boolean;
  jump: boolean;
  yaw: number;
}

/**
 * Walk / sprint / jump on top of Havok's PhysicsCharacterController.
 * Gravity, ground acceleration, coyote time and jump buffer are ours;
 * the controller does collision, slopes, step-up and pushing dynamic props.
 */
export class Movement {
  readonly cc: PhysicsCharacterController;

  grounded = false;
  sprinting = false;
  /** Horizontal speed relative to the ground we stand on. */
  speedH = 0;
  /** Velocity along the camera's right axis (for strafe lean). */
  strafeSpeed = 0;
  /** Footstep phase: increments by 1 per step while grounded and moving. */
  stepPhase = 0;
  /** Seconds since we last left the ground (0 while grounded). */
  airTime = 0;

  private readonly gravity = new Vector3(0, PLAYER.gravity, 0);
  private readonly contactGravity = new Vector3(0, -9.81, 0);
  private readonly surface: CharacterSurfaceInfo = {
    isSurfaceDynamic: false,
    supportedState: CharacterSupportedState.UNSUPPORTED,
    averageSurfaceNormal: new Vector3(),
    averageSurfaceVelocity: new Vector3(),
    averageAngularSurfaceVelocity: new Vector3(),
  };
  private readonly vel = new Vector3();
  private readonly pendingKnock = new Vector3();
  private coyote = 0;
  private jumpBuffer = 0;
  private unground = 0;
  private lastAirVy = 0;

  /** Called with downward impact speed when we touch down. */
  onLand: (impactSpeed: number) => void = () => {};
  onJump: () => void = () => {};
  onFootstep: () => void = () => {};

  constructor(
    ctx: GameContext,
    private readonly spawnFeet: Vector3,
  ) {
    const start = spawnFeet.add(new Vector3(0, HALF_HEIGHT + 0.05, 0));
    this.cc = new SteppingCharacterController(
      start,
      { capsuleHeight: PLAYER.height, capsuleRadius: PLAYER.radius },
      ctx.scene,
    );
    const cc = this.cc;
    cc.maxStepHeight = PLAYER.maxStepHeight;
    cc.maxSlopeCosine = Math.cos(PLAYER.maxSlopeDeg * DEG);
    cc.characterStrength = PLAYER.pushStrength;
    cc.characterMass = PLAYER.characterMass;
    cc.maxCharacterSpeedForSolver = 40;
    // Our capsule lives in its own collision category so our grenades can ignore it.
    cc.shape.filterMembershipMask = PLAYER_COLLISION_BIT;
  }

  /** Capsule centre (live reference: do not mutate). */
  get center(): Vector3 {
    return this.cc.getPosition();
  }

  getFeetToRef(out: Vector3): Vector3 {
    const c = this.cc.getPosition();
    return out.set(c.x, c.y - HALF_HEIGHT, c.z);
  }

  getEyeToRef(out: Vector3): Vector3 {
    const c = this.cc.getPosition();
    return out.set(c.x, c.y - HALF_HEIGHT + PLAYER.eyeHeight, c.z);
  }

  getVelocityToRef(out: Vector3): Vector3 {
    return out.copyFrom(this.cc.getVelocity());
  }

  addKnockback(dv: Vector3): void {
    this.pendingKnock.addInPlace(dv);
  }

  /** Teleport to spawn and stop. */
  respawn(): void {
    this.cc.setPosition(this.spawnFeet.add(new Vector3(0, HALF_HEIGHT + 0.05, 0)));
    this.cc.setVelocity(Vector3.ZeroReadOnly);
    this.pendingKnock.setAll(0);
    this.grounded = false;
    this.coyote = 0;
    this.jumpBuffer = 0;
    this.unground = 0;
    this.lastAirVy = 0;
    this.airTime = 0;
    this.speedH = 0;
    this.strafeSpeed = 0;
  }

  update(dt: number, intent: MoveIntent): void {
    if (dt <= 0) return;
    if (intent.jump) this.jumpBuffer = PLAYER.jumpBuffer;
    const steps = Math.max(1, Math.ceil(dt / PLAYER.maxSubstep));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) this.step(h, intent);

    if (this.cc.getPosition().y < PLAYER.killY) this.respawn();
  }

  private step(dt: number, intent: MoveIntent): void {
    const cc = this.cc;
    const surf = this.surface;
    cc.checkSupportToRef(dt, DOWN, surf);

    const v = this.vel.copyFrom(cc.getVelocity());
    this.unground = Math.max(0, this.unground - dt);
    const supported = surf.supportedState === CharacterSupportedState.SUPPORTED && this.unground <= 0;

    // Wish direction in world space from yaw (Babylon: yaw 0 looks down +Z).
    const sin = Math.sin(intent.yaw);
    const cos = Math.cos(intent.yaw);
    let wx = intent.forward * sin + intent.strafe * cos;
    let wz = intent.forward * cos - intent.strafe * sin;
    const wishLen = Math.hypot(wx, wz);
    if (wishLen > 1) {
      wx /= wishLen;
      wz /= wishLen;
    }
    const hasWish = wishLen > 0.01;
    this.sprinting = intent.sprint && intent.forward > 0 && hasWish;
    const targetSpeed = this.sprinting ? PLAYER.sprintSpeed : PLAYER.walkSpeed;

    if (supported) {
      if (!this.grounded) {
        this.grounded = true;
        const impact = Math.max(0, -this.lastAirVy);
        this.lastAirVy = 0;
        this.airTime = 0;
        this.onLand(impact);
      }
      this.coyote = PLAYER.coyoteTime;

      // Accelerate relative to the surface (moving platforms / props we stand on).
      const sv = surf.averageSurfaceVelocity;
      let rx = v.x - sv.x;
      let rz = v.z - sv.z;
      const tx = wx * targetSpeed;
      const tz = wz * targetSpeed;
      const maxDelta = (hasWish ? PLAYER.groundAccel : PLAYER.groundDecel) * dt;
      const dx = tx - rx;
      const dz = tz - rz;
      const dLen = Math.hypot(dx, dz);
      if (dLen <= maxDelta || dLen < 1e-6) {
        rx = tx;
        rz = tz;
      } else {
        rx += (dx / dLen) * maxDelta;
        rz += (dz / dLen) * maxDelta;
      }
      // Follow the ground plane, keeping horizontal speed (walk up/down ramps at full speed).
      const n = surf.averageSurfaceNormal;
      let vy = 0;
      if (n.y > 0.2) vy = -(n.x * rx + n.z * rz) / n.y;
      v.set(rx + sv.x, vy + sv.y - PLAYER.groundStick, rz + sv.z);
    } else {
      if (this.grounded) this.grounded = false;
      this.coyote = Math.max(0, this.coyote - dt);
      this.airTime += dt;
      if (hasWish) {
        const curH = Math.hypot(v.x, v.z);
        const maxDelta = PLAYER.groundAccel * PLAYER.airControl * dt;
        const dx = wx * targetSpeed - v.x;
        const dz = wz * targetSpeed - v.z;
        const dLen = Math.hypot(dx, dz);
        let nx = v.x;
        let nz = v.z;
        if (dLen <= maxDelta) {
          nx += dx;
          nz += dz;
        } else {
          nx += (dx / dLen) * maxDelta;
          nz += (dz / dLen) * maxDelta;
        }
        // Air control steers but never adds speed beyond what we had (or the target).
        const cap = Math.max(curH, targetSpeed);
        const nLen = Math.hypot(nx, nz);
        if (nLen > cap) {
          nx *= cap / nLen;
          nz *= cap / nLen;
        }
        v.x = nx;
        v.z = nz;
      }
      v.y = Math.max(v.y + this.gravity.y * dt, -PLAYER.maxFallSpeed);
    }

    // Jump (buffered, with coyote time).
    if (this.jumpBuffer > 0 && (this.grounded || this.coyote > 0)) {
      const sv = this.grounded ? surf.averageSurfaceVelocity.y : 0;
      v.y = PLAYER.jumpVelocity + Math.max(0, sv);
      this.grounded = false;
      this.coyote = 0;
      this.jumpBuffer = 0;
      this.unground = PLAYER.ungroundAfterJump;
      this.onJump();
    }
    this.jumpBuffer = Math.max(0, this.jumpBuffer - dt);

    // Explosion knockback.
    if (this.pendingKnock.lengthSquared() > 0) {
      v.addInPlace(this.pendingKnock);
      if (this.pendingKnock.y > 0.5) {
        this.grounded = false;
        this.coyote = 0;
        this.unground = PLAYER.ungroundAfterJump;
      }
      this.pendingKnock.setAll(0);
    }

    if (!this.grounded) this.lastAirVy = v.y;

    cc.setVelocity(v);
    cc.integrate(dt, surf, this.contactGravity);

    // Post-solve bookkeeping for camera bob / footsteps.
    const out = cc.getVelocity();
    const sv = supported ? surf.averageSurfaceVelocity : Vector3.ZeroReadOnly;
    const relX = out.x - sv.x;
    const relZ = out.z - sv.z;
    this.speedH = Math.hypot(relX, relZ);
    this.strafeSpeed = relX * cos - relZ * sin;

    if (this.grounded && this.speedH > PLAYER.footstepMinSpeed) {
      const t = clamp((this.speedH - PLAYER.walkSpeed) / (PLAYER.sprintSpeed - PLAYER.walkSpeed), 0, 1);
      const stride = PLAYER.strideWalk + (PLAYER.strideSprint - PLAYER.strideWalk) * t;
      const before = Math.floor(this.stepPhase);
      this.stepPhase += (this.speedH * dt) / stride;
      if (Math.floor(this.stepPhase) !== before) this.onFootstep();
    }
  }

  dispose(): void {
    this.cc.dispose();
  }
}
