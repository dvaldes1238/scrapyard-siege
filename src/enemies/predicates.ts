import type { AbstractMesh } from "@babylonjs/core";
import { isHittable } from "../core/damage";

/** Every drone sub-mesh carries metadata.enemyPart so bolts / LOS / probes can ignore drones. */
export function isEnemyPart(mesh: AbstractMesh): boolean {
  return !!(mesh.metadata as { enemyPart?: boolean } | null)?.enemyPart;
}

/** Hittable world geometry (props, barrels, walls) excluding drones and noHit meshes. */
export const worldPredicate = (mesh: AbstractMesh): boolean => isHittable(mesh) && !isEnemyPart(mesh);
