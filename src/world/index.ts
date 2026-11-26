import { AbstractMesh, type TransformNode } from "@babylonjs/core";
import type { GameContext, WorldApi } from "../core/context";
import { createAmbience } from "./ambience";
import { createEnvironment } from "./environment";
import { ARENA, buildLayout, ENEMY_SPAWNS, PLAYER_SPAWN } from "./layout";
import { createProps } from "./props";
import { createMaterials } from "./textures";

/**
 * Golden-hour scrapyard arena: lighting + post (environment.ts), procedural PBR materials
 * (textures.ts), static arena and skyline (layout.ts), dynamic props and explosive barrels
 * (props.ts), and ambience (ambience.ts).
 *
 * Tuning numbers: ./config.ts. URL params: ?ssao=1 enables SSAO2 (off by default for perf).
 */
export async function createWorld(ctx: GameContext): Promise<WorldApi> {
  const { scene } = ctx;

  const env = createEnvironment(ctx);
  const mats = createMaterials(scene);
  const layout = buildLayout(scene, env, mats);
  const props = createProps(ctx, env, mats);
  createAmbience(ctx, layout, mats.beacon);

  console.info(`[world] ${props.count} dynamic props, ${layout.meshes.length} static meshes`);

  return {
    playerSpawn: PLAYER_SPAWN.clone(),
    enemySpawnPoints: ENEMY_SPAWNS.map((p) => p.clone()),
    bounds: { minX: -ARENA, maxX: ARENA, minZ: -ARENA, maxZ: ARENA },
    addShadowCaster(mesh: AbstractMesh, includeDescendants = true) {
      // Be forgiving if a bare TransformNode slips through: register its child meshes instead.
      if (mesh instanceof AbstractMesh) env.shadows.addShadowCaster(mesh, includeDescendants);
      else for (const m of (mesh as unknown as TransformNode).getChildMeshes(false)) env.shadows.addShadowCaster(m, false);
    },
    removeShadowCaster(mesh: AbstractMesh) {
      if (mesh instanceof AbstractMesh) env.shadows.removeShadowCaster(mesh, true);
      else for (const m of (mesh as unknown as TransformNode).getChildMeshes(false)) env.shadows.removeShadowCaster(m, false);
    },
    glowLayer: env.glow,
  };
}
