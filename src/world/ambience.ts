import { Color3, Color4, ParticleSystem, Vector3, type PBRMaterial } from "@babylonjs/core";
import type { GameContext } from "../core/context";
import { getFxTextures } from "../fx/textures";
import { AMBIENCE } from "./config";
import type { Layout } from "./layout";

/**
 * Cheap ambience: sunlit dust motes drifting around the camera, a steam vent, smoke plumes on
 * the distant stacks and blinking aviation beacons. ~500 CPU particles total.
 */
export function createAmbience(ctx: GameContext, layout: Layout, beaconMat: PBRMaterial): void {
  const { scene, camera } = ctx;
  const tex = getFxTextures(scene);
  const step = 1 / 60;

  // Dust motes: emitter follows the camera; particles live in world space.
  const dustEmitter = camera.position.clone();
  const dust = new ParticleSystem("dustMotes", AMBIENCE.dustCount, scene);
  dust.particleTexture = tex.dot;
  dust.emitter = dustEmitter;
  const dr = AMBIENCE.dustRadius;
  dust.createBoxEmitter(new Vector3(-0.06, -0.02, -0.06), new Vector3(0.06, 0.05, 0.06), new Vector3(-dr, -1.4, -dr), new Vector3(dr, 5, dr));
  dust.minEmitPower = 1;
  dust.maxEmitPower = 1;
  dust.emitRate = AMBIENCE.dustRate;
  [dust.minLifeTime, dust.maxLifeTime] = AMBIENCE.dustLife;
  [dust.minSize, dust.maxSize] = AMBIENCE.dustSize;
  dust.updateSpeed = step;
  dust.gravity = Vector3.FromArray(AMBIENCE.dustDrift);
  dust.blendMode = ParticleSystem.BLENDMODE_ADD;
  dust.addColorGradient(0, new Color4(1, 0.85, 0.6, 0));
  dust.addColorGradient(0.25, new Color4(1, 0.86, 0.62, AMBIENCE.dustAlpha));
  dust.addColorGradient(0.75, new Color4(1, 0.86, 0.62, AMBIENCE.dustAlpha * 0.9));
  dust.addColorGradient(1, new Color4(1, 0.85, 0.6, 0));
  dust.minAngularSpeed = -1;
  dust.maxAngularSpeed = 1;
  dust.preWarmCycles = 240;
  dust.preWarmStepOffset = 2;
  dust.start();
  ctx.onFrame(() => dustEmitter.copyFrom(camera.globalPosition));

  // Steam vent.
  const steam = new ParticleSystem("steamVent", 90, scene);
  steam.particleTexture = tex.smoke;
  steam.emitter = layout.steamVent.clone();
  steam.createConeEmitter(0.12, 0.35);
  [steam.minEmitPower, steam.maxEmitPower] = AMBIENCE.steamPower;
  steam.emitRate = AMBIENCE.steamRate;
  [steam.minLifeTime, steam.maxLifeTime] = AMBIENCE.steamLife;
  steam.updateSpeed = step;
  steam.gravity = Vector3.FromArray(AMBIENCE.steamWind);
  const [s0, s1] = AMBIENCE.steamSize;
  steam.addSizeGradient(0, s0);
  steam.addSizeGradient(0.4, s0 + (s1 - s0) * 0.35);
  steam.addSizeGradient(1, s1);
  steam.addColorGradient(0, new Color4(0.9, 0.9, 0.9, 0));
  steam.addColorGradient(0.12, new Color4(0.9, 0.88, 0.86, AMBIENCE.steamAlpha));
  steam.addColorGradient(1, new Color4(0.85, 0.82, 0.8, 0));
  steam.addDragGradient(0, 0.0);
  steam.addDragGradient(1, 0.6);
  steam.minAngularSpeed = -0.6;
  steam.maxAngularSpeed = 0.6;
  steam.minInitialRotation = 0;
  steam.maxInitialRotation = Math.PI * 2;
  steam.blendMode = ParticleSystem.BLENDMODE_STANDARD;
  steam.applyFog = true;
  steam.preWarmCycles = 120;
  steam.preWarmStepOffset = 2;
  steam.start();

  // Smoke plumes on two distant stacks.
  for (const top of layout.smokeStacks.slice(0, AMBIENCE.stackSmokePlumes)) {
    const ps = new ParticleSystem("stackSmoke", 70, scene);
    ps.particleTexture = tex.smoke;
    ps.emitter = top.clone();
    ps.createConeEmitter(1.5, 0.3);
    [ps.minEmitPower, ps.maxEmitPower] = AMBIENCE.stackSmokePower;
    ps.emitRate = AMBIENCE.stackSmokeRate;
    [ps.minLifeTime, ps.maxLifeTime] = AMBIENCE.stackSmokeLife;
    ps.updateSpeed = step;
    ps.gravity = Vector3.FromArray(AMBIENCE.stackSmokeWind);
    ps.addSizeGradient(0, AMBIENCE.stackSmokeSize[0]);
    ps.addSizeGradient(1, AMBIENCE.stackSmokeSize[1]);
    ps.addColorGradient(0, new Color4(0.35, 0.33, 0.32, 0));
    ps.addColorGradient(0.08, new Color4(0.4, 0.38, 0.36, AMBIENCE.stackSmokeAlpha));
    ps.addColorGradient(1, new Color4(0.55, 0.52, 0.5, 0));
    ps.minAngularSpeed = -0.1;
    ps.maxAngularSpeed = 0.1;
    ps.minInitialRotation = 0;
    ps.maxInitialRotation = Math.PI * 2;
    ps.blendMode = ParticleSystem.BLENDMODE_STANDARD;
    ps.applyFog = true;
    ps.preWarmCycles = 500;
    ps.preWarmStepOffset = 3;
    ps.start();
  }

  // Blinking aviation beacons (one shared material, cheap).
  const on = beaconMat.emissiveColor.clone();
  const off = new Color3(0.08, 0.005, 0.003);
  let t = 0;
  ctx.onFrame((dt) => {
    t += dt;
    const phase = t % AMBIENCE.beaconPeriod;
    beaconMat.emissiveColor.copyFrom(phase < AMBIENCE.beaconOnTime ? on : off);
  });
}
