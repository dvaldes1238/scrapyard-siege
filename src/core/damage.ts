import type { AbstractMesh, Node, Vector3 } from "@babylonjs/core";

export type DamageSource = "rifle" | "launcher" | "explosion" | "enemy";

export interface DamageInfo {
  source: DamageSource;
  /** World-space point of impact, if known. */
  point?: Vector3;
  /** Normalized direction the damage travelled in (e.g. bullet direction). */
  direction?: Vector3;
}

/**
 * Anything that can be shot or blown up (drones, explosive barrels).
 * The player is NOT a Damageable: use ctx.player.takeDamage instead.
 */
export interface Damageable {
  readonly kind: "enemy" | "barrel";
  readonly alive: boolean;
  /** Current world-space centre, used for explosion falloff. */
  getPosition(): Vector3;
  takeDamage(amount: number, info: DamageInfo): void;
}

/** Tag a node (usually the root of a drone/barrel) so hit tests can find its Damageable. */
export function setDamageable(node: Node, d: Damageable): void {
  node.metadata = { ...(node.metadata ?? {}), damageable: d };
}

/** Walk up the parent chain of a picked mesh and return its Damageable, if any. */
export function findDamageable(mesh: AbstractMesh | null | undefined): Damageable | null {
  let n: Node | null | undefined = mesh;
  while (n) {
    const d = (n.metadata as { damageable?: Damageable } | null)?.damageable;
    if (d) return d;
    n = n.parent;
  }
  return null;
}

/**
 * Meshes with metadata.noHit = true are ignored by weapon ray picks
 * (viewmodel, particles, tracers, sky, invisible helpers).
 */
export function markNoHit(mesh: AbstractMesh): void {
  mesh.metadata = { ...(mesh.metadata ?? {}), noHit: true };
  mesh.isPickable = false;
}

/** Standard predicate for weapon ray picks. */
export function isHittable(mesh: AbstractMesh): boolean {
  return (
    mesh.isPickable &&
    mesh.isEnabled() &&
    mesh.isVisible &&
    !(mesh.metadata as { noHit?: boolean } | null)?.noHit
  );
}
