import { PhysicsMotionType, Vector3 } from "@babylonjs/core";
import type { GameContext } from "./context";
import type { DamageSource } from "./damage";

export interface ExplosionOptions {
  /** Blast radius in metres. */
  radius: number;
  /** Velocity change (m/s) given to a body at the centre; falls off linearly to 0 at radius. */
  force: number;
  /** Damage at the centre; falls off to 25% at the edge. */
  damage: number;
  source: DamageSource;
  /** Fraction of damage applied to the player (self-damage from own grenades). Default 0.5. */
  playerDamageScale?: number;
}

const tmpCenter = new Vector3();
const tmpDir = new Vector3();

/**
 * The single explosion routine for grenades, barrels and drones:
 * visuals + sound + event, physics impulses, damage to Damageables and the player.
 */
export function explode(ctx: GameContext, position: Vector3, opts: ExplosionOptions): void {
  const pos = position.clone();
  const { radius, force, damage } = opts;

  ctx.fx.explosion(pos, radius / 5);
  ctx.audio.play("explosion", { position: pos });
  ctx.events.emit("explosion", { position: pos, radius });

  // Push dynamic bodies. Impulse is scaled by mass so every object gets a similar kick.
  for (const body of ctx.dynamicBodies) {
    if (body.isDisposed) {
      ctx.dynamicBodies.delete(body);
      continue;
    }
    if (body.getMotionType() !== PhysicsMotionType.DYNAMIC) continue;
    body.getObjectCenterWorldToRef(tmpCenter);
    const dist = Vector3.Distance(tmpCenter, pos);
    if (dist > radius) continue;
    const falloff = 1 - dist / radius;
    tmpCenter.subtractToRef(pos, tmpDir);
    if (tmpDir.lengthSquared() < 1e-6) tmpDir.set(0, 1, 0);
    tmpDir.normalize();
    tmpDir.y += 0.45; // bias upward so things fly, not just slide
    tmpDir.normalize();
    const mass = body.getMassProperties().mass ?? 1;
    const impulse = tmpDir.scale(force * falloff * mass);
    // Slightly off-centre application point adds spin.
    const at = tmpCenter.add(new Vector3((Math.random() - 0.5) * 0.3, (Math.random() - 0.5) * 0.3, (Math.random() - 0.5) * 0.3));
    body.applyImpulse(impulse, at);
  }

  // Damage shootables (copy: damage may remove entries or trigger chain explosions).
  for (const d of [...ctx.damageables]) {
    if (!d.alive) continue;
    const dist = Vector3.Distance(d.getPosition(), pos);
    if (dist > radius) continue;
    const falloff = 1 - dist / radius;
    const dir = d.getPosition().subtract(pos);
    if (dir.lengthSquared() > 1e-6) dir.normalize();
    d.takeDamage(damage * (0.25 + 0.75 * falloff), { source: "explosion", point: pos, direction: dir });
  }

  // Player damage + knockback.
  const player = ctx.player;
  if (player && player.alive) {
    const chest = player.getFeetPosition().add(new Vector3(0, player.height * 0.5, 0));
    const dist = Vector3.Distance(chest, pos);
    if (dist < radius) {
      const falloff = 1 - dist / radius;
      const scale = opts.playerDamageScale ?? 0.5;
      const amount = damage * scale * (0.25 + 0.75 * falloff);
      if (amount > 0.5) player.takeDamage(amount, pos);
      const kick = chest.subtract(pos);
      kick.y = Math.max(kick.y, 0) + 0.6;
      kick.normalize().scaleInPlace(force * 0.6 * falloff);
      player.applyKnockback(kick);
    }
  }
}
