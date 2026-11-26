import { Vector3 } from "@babylonjs/core";
import type { GameContext } from "../core/context";
import type { DroneType } from "./config";
import type { Drone } from "./drone";
import { EnemySystem } from "./system";
import { WaveDirector } from "./waves";

/** Debug/test handle (also exposed as window.enemies). */
export interface EnemiesApi {
  spawn(type?: DroneType, distance?: number): void;
  killAll(): void;
  /** End the current wave and start wave n next (0.5 s countdown). */
  skipTo(wave: number): void;
  drones(): Iterable<Drone>;
}

/**
 * Drones, plasma bolts, wave schedule, score and game over.
 * Gameplay runs in ctx.onUpdate (pauses automatically); idle cosmetics in ctx.onFrame.
 */
export function createEnemies(ctx: GameContext): EnemiesApi {
  const system = new EnemySystem(ctx);
  const director = new WaveDirector(system);

  ctx.events.on("game:start", () => director.start());

  ctx.events.on("player:died", () => {
    if (ctx.state.phase === "gameover") return;
    ctx.state.phase = "gameover";
    director.stop();
    system.bolts.clear();
    ctx.events.emit("game:over", { score: ctx.state.score, wave: ctx.state.wave, kills: ctx.state.kills });
  });

  ctx.onUpdate((dt) => {
    director.update(dt);
    system.update(dt);
  });
  ctx.onFrame((dt) => system.frame(dt));

  const api: EnemiesApi = {
    spawn(type: DroneType = "seeker", distance = 12): void {
      const eye = ctx.player.getEyePosition();
      const fwd = ctx.camera.getDirection(Vector3.Forward());
      fwd.y = 0;
      if (fwd.lengthSquared() < 1e-4) fwd.set(0, 0, 1);
      fwd.normalize();
      system.spawnDrone(type, new Vector3(eye.x + fwd.x * distance, system.baseY + 5, eye.z + fwd.z * distance));
    },
    killAll(): void {
      for (const d of [...system.drones]) d.takeDamage(1e6, { source: "rifle" });
    },
    skipTo(wave: number): void {
      director.skipTo(wave);
    },
    drones: () => system.drones,
  };

  // Debug handle for the browser console: enemies.spawn("brute"), enemies.killAll(), enemies.skipTo(5).
  (window as unknown as { enemies: unknown }).enemies = { ...api, system, director };
  return api;
}
