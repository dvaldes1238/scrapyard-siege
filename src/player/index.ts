import { Vector3, type AbstractMesh, type Mesh } from "@babylonjs/core";
import type { GameContext, PlayerApi } from "../core/context";
import { CameraRig, type RigState } from "./cameraRig";
import { CAMERA_FX, DEG, LAUNCHER, LOOK, PLAYER, RIFLE } from "./config";
import { PlayerInput } from "./input";
import { Launcher } from "./launcher";
import { Movement } from "./movement";
import { Rifle } from "./rifle";
import { clamp } from "./util";
import { Viewmodel } from "./viewmodel";

/**
 * First-person player: Havok character controller movement, camera rig,
 * procedural viewmodel, pulse rifle + kinetic grenade launcher, health.
 * Tuning lives in ./config.ts.
 */
export async function createPlayer(ctx: GameContext): Promise<PlayerApi> {
  const spawn = ctx.world.playerSpawn.clone();
  const b = ctx.world.bounds ?? { minX: -1, maxX: 1, minZ: spawn.z + 1, maxZ: spawn.z + 3 };
  const arenaCentre = new Vector3((b.minX + b.maxX) / 2, spawn.y + PLAYER.eyeHeight, (b.minZ + b.maxZ) / 2);

  const input = new PlayerInput(ctx);
  const move = new Movement(ctx, spawn);
  const rig = new CameraRig(ctx.camera);
  const vm = new Viewmodel(ctx);
  const rifle = new Rifle(ctx, rig, vm);
  const launcher = new Launcher(ctx);

  const state = {
    health: PLAYER.maxHealth,
    alive: true,
    sinceDamage: 99,
    healTimer: 0,
    diedEmitted: false,
    hudSync: true,
  };

  const eye = new Vector3();
  const look = { x: 0, y: 0 };
  const tmpDir = new Vector3();
  const tmpVel = new Vector3();
  const tmpSpawn = new Vector3();
  const tmpMuzzle = new Vector3();
  const rigState: RigState = {
    eye,
    grounded: false,
    speedH: 0,
    strafeSpeed: 0,
    sprinting: false,
    stepPhase: 0,
    alive: true,
  };

  const faceArenaCentre = (): void => {
    move.getEyeToRef(eye);
    const dx = arenaCentre.x - eye.x;
    const dz = arenaCentre.z - eye.z;
    if (dx * dx + dz * dz > 0.01) rig.lookAt(eye, arenaCentre);
    else rig.lookAt(eye, eye.add(new Vector3(0, 0, 1)));
  };

  // ---------------------------------------------------------------- glow
  // Emissive meshes glow by default. If another module switches the glow layer to
  // include-only (addIncludedOnlyMesh / excludeByDefault), register ours too.
  const glowMeshes: AbstractMesh[] = [...vm.glowMeshes, ...launcher.glowMeshes];
  let glowRegistered = false;
  let glowCheckTimer = 0;
  const ensureGlow = (): void => {
    const glow = ctx.world.glowLayer;
    if (!glow || glowRegistered) return;
    const thin = (glow as unknown as { _thinEffectLayer?: { _includedOnlyMeshes?: number[]; _options?: { excludeByDefault?: boolean } } })
      ._thinEffectLayer;
    const includeOnly = (thin?._includedOnlyMeshes?.length ?? 0) > 0 || !!thin?._options?.excludeByDefault;
    if (!includeOnly) return;
    for (const m of glowMeshes) glow.addIncludedOnlyMesh(m as Mesh);
    glowRegistered = true;
  };
  ensureGlow();

  // ---------------------------------------------------------------- movement hooks
  move.onJump = () => ctx.events.emit("player:jump", {});
  move.onFootstep = () => ctx.events.emit("player:footstep", {});
  move.onLand = (impactSpeed) => {
    if (impactSpeed < PLAYER.landEventMinSpeed) return;
    ctx.events.emit("player:land", { impactSpeed });
    rig.land(impactSpeed);
    vm.landKick(impactSpeed);
  };

  // ---------------------------------------------------------------- health
  const die = (): void => {
    if (!state.alive) return;
    state.alive = false;
    state.health = 0;
    input.enabled = false;
    input.releaseAll();
    rifle.cancelReload();
    rig.startDeath();
    if (!state.diedEmitted) {
      state.diedEmitted = true;
      ctx.events.emit("player:died", {});
    }
  };

  const takeDamage = (amount: number, from?: Vector3): void => {
    if (!state.alive || ctx.state.phase !== "playing" || !(amount > 0)) return;
    state.health = Math.max(0, state.health - amount);
    state.sinceDamage = 0;
    state.healTimer = 0;
    ctx.events.emit("player:damaged", { amount, health: state.health, maxHealth: PLAYER.maxHealth, from });
    move.getEyeToRef(eye);
    rig.addTrauma(clamp(amount / 45, CAMERA_FX.damageShakeMin, CAMERA_FX.damageShakeMax));
    rig.flinch(clamp(amount / 25, 0.3, 1.2), from, eye);
    vm.damageKick();
    if (state.health <= 0) die();
  };

  const updateHealth = (dt: number): void => {
    state.sinceDamage += dt;
    if (!state.alive || state.health >= PLAYER.maxHealth || state.sinceDamage < PLAYER.regenDelay) return;
    state.health = Math.min(PLAYER.maxHealth, state.health + PLAYER.regenRate * dt);
    state.healTimer += dt;
    if (state.healTimer >= PLAYER.healedEventInterval || state.health >= PLAYER.maxHealth) {
      state.healTimer = 0;
      ctx.events.emit("player:healed", { health: state.health, maxHealth: PLAYER.maxHealth });
    }
  };

  // ---------------------------------------------------------------- reset / events
  const resetPlayer = (): void => {
    state.health = PLAYER.maxHealth;
    state.alive = true;
    state.sinceDamage = 99;
    state.healTimer = 0;
    state.diedEmitted = false;
    state.hudSync = true;
    input.enabled = true;
    move.respawn();
    rifle.reset();
    launcher.reset();
    rig.resetEffects();
    faceArenaCentre();
    vm.snapLowered(); // gun rises into view: a little "equip" beat
  };

  ctx.events.on("game:start", resetPlayer);

  ctx.events.on("explosion", ({ position, radius }) => {
    move.getEyeToRef(eye);
    const d = Vector3.Distance(position, eye);
    const range = radius * CAMERA_FX.explosionShakeRange;
    if (d >= range) return;
    const k = 1 - d / range;
    rig.addTrauma(CAMERA_FX.explosionShakeMax * k * Math.sqrt(k));
  });

  // ---------------------------------------------------------------- weapons
  const fireLauncher = (): void => {
    rig.getForwardToRef(tmpDir);
    tmpSpawn.copyFrom(ctx.camera.position);
    tmpSpawn.addInPlaceFromFloats(tmpDir.x * 0.3, tmpDir.y * 0.3 - 0.06, tmpDir.z * 0.3);
    move.getVelocityToRef(tmpVel);
    vm.getMuzzleWorldToRef(tmpMuzzle, true);
    if (launcher.tryFire(tmpSpawn, tmpDir, tmpVel, tmpMuzzle)) {
      vm.launcherKick();
      rig.kick(LAUNCHER.recoilPitch, (Math.random() - 0.5) * 0.6 * DEG, 0.75);
      rig.addTrauma(0.12);
      rig.fovPunchBy(0.035);
    }
  };

  // ---------------------------------------------------------------- per frame
  const fillRigState = (playing: boolean): void => {
    move.getEyeToRef(eye);
    rigState.grounded = playing ? move.grounded : true;
    rigState.speedH = playing ? move.speedH : 0;
    rigState.strafeSpeed = playing ? move.strafeSpeed : 0;
    rigState.sprinting = playing && state.alive && move.sprinting && rifle.sinceShot > 0.3;
    rigState.stepPhase = move.stepPhase;
    rigState.alive = state.alive;
  };

  const updateViewmodel = (dt: number): void => {
    vm.update({
      dt,
      lookYaw: rig.lookDeltaYaw,
      lookPitch: rig.lookDeltaPitch,
      stepPhase: move.stepPhase,
      bobAmount: rig.bobAmount,
      grounded: move.grounded || ctx.state.phase !== "playing",
      sprintPose:
        ctx.state.phase === "playing" &&
        state.alive &&
        move.sprinting &&
        move.grounded &&
        move.speedH > PLAYER.walkSpeed + 0.5 &&
        rifle.sinceShot > 0.3 &&
        !rifle.reloading,
      strafeSpeed: ctx.state.phase === "playing" ? move.strafeSpeed : 0,
      reloadProgress: rifle.reloadProgress,
      ammoFraction: rifle.ammo / RIFLE.magSize,
      charges: launcher.charges,
      maxCharges: LAUNCHER.maxCharges,
      rechargeProgress: launcher.rechargeProgress,
      lowered: !state.alive,
    });
  };

  // Gameplay (only while playing).
  ctx.onUpdate((rawDt) => {
    const dt = Math.min(Math.max(rawDt, 0), 0.05);
    if (dt <= 0) return;
    rig.beginFrame();
    if (state.hudSync) {
      state.hudSync = false;
      rifle.emitAmmo();
      launcher.emitState(true);
      ctx.events.emit("player:healed", { health: state.health, maxHealth: PLAYER.maxHealth });
    }

    input.consumeLook(look);
    if (state.alive) rig.addLook(look.x * LOOK.sensitivity, look.y * LOOK.sensitivity);

    move.update(dt, {
      forward: input.forward,
      strafe: input.strafe,
      sprint: input.sprint,
      jump: input.consumeJump(),
      yaw: rig.yaw,
    });

    updateHealth(dt);

    fillRigState(true);
    rig.update(dt, rigState);

    const reloadPressed = input.consumeReload();
    const launcherPressed = input.consumeLauncher();
    const fireTapped = input.consumeFireTap();
    if (state.alive) {
      rifle.update(dt, {
        triggerHeld: input.fireHeld || fireTapped,
        reloadPressed,
        unsteady: !move.grounded || move.speedH > RIFLE.fastSpeed,
      });
      launcher.update(dt);
      if (launcherPressed) fireLauncher();
    }

    updateViewmodel(dt);
  });

  // Cosmetic (every frame): grenade visuals, plus camera/viewmodel when not playing.
  ctx.onFrame((rawDt) => {
    const dt = Math.min(Math.max(rawDt, 0), 0.05);
    const phase = ctx.state.phase;
    glowCheckTimer -= dt;
    if (glowCheckTimer <= 0) {
      glowCheckTimer = 1;
      ensureGlow();
    }
    if (phase !== "paused") launcher.frame(dt);
    if (phase === "playing" || phase === "paused") return; // onUpdate drives these while playing
    rig.beginFrame();
    fillRigState(false);
    rig.update(dt, rigState);
    updateViewmodel(dt);
  });

  // Initial placement so the very first frame (menu) already looks right.
  faceArenaCentre();
  fillRigState(false);
  rig.update(0, rigState);

  const api: PlayerApi = {
    get health() {
      return state.health;
    },
    maxHealth: PLAYER.maxHealth,
    get alive() {
      return state.alive;
    },
    radius: PLAYER.radius,
    height: PLAYER.height,
    getEyePosition: () => move.getEyeToRef(new Vector3()),
    getFeetPosition: () => move.getFeetToRef(new Vector3()),
    getVelocity: () => move.getVelocityToRef(new Vector3()),
    takeDamage,
    applyKnockback: (dv: Vector3) => {
      if (dv && isFinite(dv.x) && isFinite(dv.y) && isFinite(dv.z)) move.addKnockback(dv);
    },
  };
  return api;
}
