import { Matrix, Vector3, type UniversalCamera } from "@babylonjs/core";
import { CAMERA_FX, LOOK, PLAYER } from "./config";
import { clamp, damp, easeOutCubic, shakeNoise, Spring } from "./util";

export interface RigState {
  /** Stable eye position (feet + eye height), world space. */
  eye: Vector3;
  grounded: boolean;
  speedH: number;
  strafeSpeed: number;
  sprinting: boolean;
  stepPhase: number;
  alive: boolean;
}

const tmpMat = new Matrix();
const LOCAL_FWD = new Vector3(0, 0, 1);

/**
 * Drives ctx.camera: base yaw/pitch from the mouse plus layered cosmetic offsets
 * (recoil, head bob, landing dip, strafe lean, shake, damage flinch, sprint FOV, death drop).
 */
export class CameraRig {
  /** Base look angles (radians). Pitch positive = looking down (Babylon convention). */
  yaw = 0;
  pitch = 0;

  /** Final angles applied to the camera this frame (incl. recoil/shake). */
  readonly finalRot = new Vector3();

  /** Look delta applied this frame in radians (for viewmodel sway). */
  lookDeltaYaw = 0;
  lookDeltaPitch = 0;

  /** 0..1 head-bob amplitude (smoothed). Shared with the viewmodel. */
  bobAmount = 0;
  sprintBlend = 0;

  private readonly baseFov: number;
  private time = 0;

  // Recoil: current offset chases target quickly; target decays (the recoverable part).
  private recoilP = 0;
  private recoilY = 0;
  private recoilPT = 0;
  private recoilYT = 0;

  private trauma = 0;
  private readonly landSpring = new Spring(140, 15);
  private readonly flinchPitch = new Spring(160, 14);
  private readonly flinchRoll = new Spring(120, 12);
  private fovPunch = 0;
  private strafeRoll = 0;

  private deathT = -1;
  private deathRollDir = 1;

  constructor(private readonly camera: UniversalCamera) {
    this.baseFov = camera.fov;
    // Keep the up vector in sync with roll; otherwise a stale up vector skews the view as yaw changes.
    camera.updateUpVectorFromRotation = true;
  }

  /** Point the base look at a world position. */
  lookAt(from: Vector3, target: Vector3): void {
    const dx = target.x - from.x;
    const dz = target.z - from.z;
    const dy = target.y - from.y;
    this.yaw = Math.atan2(dx, dz);
    this.pitch = clamp(-Math.atan2(dy, Math.hypot(dx, dz)), -LOOK.maxPitch, LOOK.maxPitch);
  }

  /** Reset per-frame look deltas. Call at the start of every frame. */
  beginFrame(): void {
    this.lookDeltaYaw = 0;
    this.lookDeltaPitch = 0;
  }

  addLook(dYaw: number, dPitch: number): void {
    this.yaw += dYaw;
    this.pitch = clamp(this.pitch + dPitch, -LOOK.maxPitch, LOOK.maxPitch);
    // Keep yaw bounded to avoid precision drift over long sessions.
    if (this.yaw > Math.PI) this.yaw -= Math.PI * 2;
    else if (this.yaw < -Math.PI) this.yaw += Math.PI * 2;
    this.lookDeltaYaw += dYaw;
    this.lookDeltaPitch += dPitch;
  }

  /** Weapon recoil. pitchKick > 0 kicks the view up. recoverFraction of it springs back. */
  kick(pitchKick: number, yawKick: number, recoverFraction: number): void {
    const keep = 1 - recoverFraction;
    this.pitch = clamp(this.pitch - pitchKick * keep, -LOOK.maxPitch, LOOK.maxPitch);
    this.yaw += yawKick * keep;
    this.recoilPT += pitchKick * recoverFraction;
    this.recoilYT += yawKick * recoverFraction;
  }

  addTrauma(amount: number): void {
    this.trauma = clamp(this.trauma + amount, 0, 1);
  }

  fovPunchBy(amount: number): void {
    this.fovPunch += amount;
  }

  /** Landing dip, scaled by impact speed. */
  land(impactSpeed: number): void {
    const dip = Math.min(impactSpeed * CAMERA_FX.landDipPerSpeed, CAMERA_FX.landDipMax);
    this.landSpring.velocity -= dip * 14;
  }

  /** Damage flinch: small pitch jolt and a roll away from the source. */
  flinch(strength: number, from: Vector3 | undefined, eye: Vector3): void {
    this.flinchPitch.velocity -= 0.35 * strength;
    let side = Math.random() < 0.5 ? -1 : 1;
    if (from) {
      const dx = from.x - eye.x;
      const dz = from.z - eye.z;
      // Right vector = (cos yaw, 0, -sin yaw).
      const right = dx * Math.cos(this.yaw) - dz * Math.sin(this.yaw);
      side = right >= 0 ? 1 : -1;
    }
    this.flinchRoll.velocity += side * 0.5 * strength;
    this.deathRollDir = side;
  }

  startDeath(): void {
    if (this.deathT < 0) this.deathT = 0;
  }

  resetEffects(): void {
    this.recoilP = this.recoilY = this.recoilPT = this.recoilYT = 0;
    this.trauma = 0;
    this.landSpring.reset();
    this.flinchPitch.reset();
    this.flinchRoll.reset();
    this.fovPunch = 0;
    this.strafeRoll = 0;
    this.deathT = -1;
    this.bobAmount = 0;
    this.sprintBlend = 0;
    this.camera.fov = this.baseFov;
  }

  /** World-space forward of the final camera orientation. */
  getForwardToRef(out: Vector3): Vector3 {
    Matrix.RotationYawPitchRollToRef(this.finalRot.y, this.finalRot.x, this.finalRot.z, tmpMat);
    return Vector3.TransformNormalToRef(LOCAL_FWD, tmpMat, out);
  }

  /** Rotation matrix of the final camera orientation (for spread cones). */
  getRotationMatrixToRef(out: Matrix): Matrix {
    Matrix.RotationYawPitchRollToRef(this.finalRot.y, this.finalRot.x, this.finalRot.z, out);
    return out;
  }

  /** Place the camera for this frame. Call once per frame after movement. */
  update(dt: number, s: RigState): void {
    this.time += dt;
    const cam = this.camera;

    // --- recoil (fast attack, slow recovery of the recoverable part)
    const atk = 1 - Math.exp(-CAMERA_FX.recoilAttack * dt);
    this.recoilP += (this.recoilPT - this.recoilP) * atk;
    this.recoilY += (this.recoilYT - this.recoilY) * atk;
    const rec = Math.exp(-CAMERA_FX.recoilRecover * dt);
    this.recoilPT *= rec;
    this.recoilYT *= rec;

    // --- head bob
    const bobTarget = s.alive && s.grounded ? clamp(s.speedH / PLAYER.walkSpeed, 0, 1.4) : 0;
    this.bobAmount = damp(this.bobAmount, bobTarget, 10, dt);
    const theta = s.stepPhase * Math.PI;
    const sprintT = clamp((s.speedH - PLAYER.walkSpeed) / (PLAYER.sprintSpeed - PLAYER.walkSpeed), 0, 1);
    const bobAmpY = CAMERA_FX.bobWalkY + (CAMERA_FX.bobSprintY - CAMERA_FX.bobWalkY) * sprintT;
    const bobAmt = Math.min(this.bobAmount, 1);
    // Lowest at each footfall (stepPhase integer), highest mid-stride.
    const bobY = -Math.cos(2 * theta) * 0.5 * bobAmpY * bobAmt;
    const bobX = Math.sin(theta) * CAMERA_FX.bobX * bobAmt;
    const bobRoll = Math.sin(theta) * CAMERA_FX.bobRoll * bobAmt;

    // --- strafe lean
    this.strafeRoll = damp(this.strafeRoll, -clamp(s.strafeSpeed / PLAYER.sprintSpeed, -1, 1) * CAMERA_FX.strafeRoll, 8, dt);

    // --- springs
    const landY = this.landSpring.update(dt);
    const fP = this.flinchPitch.update(dt);
    const fR = this.flinchRoll.update(dt);

    // --- shake (trauma²)
    this.trauma = Math.max(0, this.trauma - CAMERA_FX.shakeDecay * dt);
    const sh = this.trauma * this.trauma;
    const t = this.time;
    const shakeP = sh * CAMERA_FX.shakeMaxPitch * shakeNoise(t, 1);
    const shakeY = sh * CAMERA_FX.shakeMaxYaw * shakeNoise(t, 7);
    const shakeR = sh * CAMERA_FX.shakeMaxRoll * shakeNoise(t, 13);
    const shakePos = sh * CAMERA_FX.shakeMaxPos;

    // --- sprint FOV kick + punches
    this.sprintBlend = damp(this.sprintBlend, s.sprinting && s.grounded && s.speedH > PLAYER.walkSpeed + 0.5 ? 1 : 0, 6, dt);
    this.fovPunch = damp(this.fovPunch, 0, 9, dt);
    cam.fov = this.baseFov + CAMERA_FX.sprintFovKick * this.sprintBlend + this.fovPunch;

    // --- death drop
    let deathDrop = 0;
    let deathRoll = 0;
    let deathPitch = 0;
    if (this.deathT >= 0) {
      this.deathT = Math.min(1, this.deathT + dt / CAMERA_FX.deathDropTime);
      const e = easeOutCubic(this.deathT);
      deathDrop = (PLAYER.eyeHeight - CAMERA_FX.deathEyeHeight) * e;
      deathRoll = 0.55 * this.deathRollDir * e;
      deathPitch = -0.12 * e;
    }

    // --- compose
    const pitch = clamp(this.pitch - this.recoilP + shakeP + fP + deathPitch, -LOOK.maxPitch, LOOK.maxPitch);
    const yaw = this.yaw + this.recoilY + shakeY;
    const roll = bobRoll + shakeR + fR + this.strafeRoll + deathRoll;
    this.finalRot.set(pitch, yaw, roll);
    cam.rotation.copyFrom(this.finalRot);

    const rx = Math.cos(yaw);
    const rz = -Math.sin(yaw);
    const px = shakePos * shakeNoise(t * 0.9, 21);
    const py = shakePos * shakeNoise(t * 0.9, 29);
    cam.position.set(
      s.eye.x + rx * (bobX + px),
      s.eye.y + bobY + landY + py - deathDrop,
      s.eye.z + rz * (bobX + px),
    );
  }
}
