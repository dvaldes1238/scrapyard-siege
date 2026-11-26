// src/world + src/fx headless: props settle, spawn is clear, barrels are shootable and chain,
// effects don't leak, debris respects its cap and expires. (Not checked here: how it looks.)
import { bootHeadless, check, consoleErrors, finish, section } from "./support/headless.ts";
import { Color3, MeshBuilder, Ray, Vector3 } from "@babylonjs/core";
import { createFx } from "../src/fx/index.ts";
import { createWorld } from "../src/world/index.ts";
import { findDamageable, isHittable } from "../src/core/damage.ts";
import { BARREL } from "../src/world/config.ts";
import { DEBRIS } from "../src/fx/config.ts";
import type { HitKind } from "../src/core/events.ts";

const { ctx, scene, camera, sounds, step } = await bootHeadless();
ctx.fx = createFx(ctx);
ctx.world = await createWorld(ctx);

let playerDamage = 0;
const spawn = ctx.world.playerSpawn;
ctx.player = {
  health: 100,
  maxHealth: 100,
  alive: true,
  radius: 0.4,
  height: 1.8,
  getEyePosition: () => spawn.add(new Vector3(0, 1.65, 0)),
  getFeetPosition: () => spawn.clone(),
  getVelocity: () => Vector3.Zero(),
  takeDamage: (amount: number) => {
    playerDamage += amount;
  },
  applyKnockback() {},
};
camera.position.copyFrom(spawn.add(new Vector3(0, 1.65, 0)));

section("Arena");
step(20);
const barrels = [...ctx.damageables].filter((d) => d.kind === "barrel");
check(ctx.dynamicBodies.size > 50, `dynamic props registered (${ctx.dynamicBodies.size})`);
check(barrels.length > 0, `explosive barrels registered as damageables (${barrels.length})`);
const { bounds } = ctx.world;
const inBounds = (p: Vector3) => p.x > bounds.minX && p.x < bounds.maxX && p.z > bounds.minZ && p.z < bounds.maxZ;
check(inBounds(spawn), `player spawn inside bounds ${spawn}`);
check(
  ctx.world.enemySpawnPoints.length > 0 && ctx.world.enemySpawnPoints.every((p) => inBounds(p) && p.y > 5),
  `enemy spawn points inside bounds and above the containers (${ctx.world.enemySpawnPoints.length})`,
);

section("Props settle");
step(180);
const bodies = [...ctx.dynamicBodies];
const moving = bodies.filter((b) => b.getLinearVelocity().length() > 0.05).length;
const fallen = bodies.filter((b) => b.transformNode.getAbsolutePosition().y < -0.5).length;
check(moving === 0, `props at rest after 3 s (${moving} moving)`);
check(fallen === 0, `no prop fell through the ground (${fallen})`);
const nearSpawn = bodies.filter((b) => Vector3.Distance(b.transformNode.getAbsolutePosition(), spawn) < 3).length;
check(nearSpawn === 0, `no prop within 3 m of the player spawn (${nearSpawn})`);

section("Barrels");
// A pick straight down onto some barrel must resolve to its Damageable.
const pickable = barrels.find((b) => {
  const hit = scene.pickWithRay(new Ray(b.getPosition().add(new Vector3(0, 3, 0)), new Vector3(0, -1, 0), 10), isHittable);
  return findDamageable(hit?.pickedMesh) === b;
});
check(!!pickable, "weapon pick from above finds a barrel's Damageable");

// Pick the barrel with the closest neighbour so the chain reaction is exercised.
const nearest = (b: (typeof barrels)[number]) =>
  Math.min(...barrels.filter((o) => o !== b).map((o) => Vector3.Distance(o.getPosition(), b.getPosition())));
const target = [...barrels].sort((a, b) => nearest(a) - nearest(b))[0];
ctx.state.phase = "playing";
target.takeDamage(BARREL.hp - 1, { source: "rifle" });
check(target.alive, `barrel survives ${BARREL.hp - 1} damage`);
target.takeDamage(1, { source: "rifle" });
check(!target.alive, `barrel dies at ${BARREL.hp} damage`);
const damageablesBefore = ctx.damageables.size;
check(ctx.damageables.has(target), "barrel stays registered while its fuse burns");
step(40);
const explosions = sounds.filter((s) => s === "explosion").length;
check(!ctx.damageables.has(target), "barrel unregistered after detonating");
check(explosions >= 1, `barrel exploded (${explosions} explosion sounds)`);
if (nearest(target) < 2) check(explosions >= 2, `neighbouring barrel chained (${explosions} explosions)`);
check(ctx.damageables.size < damageablesBefore, "detonated barrels removed from damageables");

section("Effects and debris");
step(400); // let chain debris expire
const baseline = ctx.dynamicBodies.size;
const kinds: HitKind[] = ["enemy", "barrel", "prop", "world"];
for (let i = 0; i < 200; i++) {
  const p = new Vector3(Math.random() * 20 - 10, 1, Math.random() * 20 - 10);
  ctx.fx.impact(p, new Vector3(0, 1, 0), kinds[i % 4]);
  ctx.fx.tracer(camera.position, p);
  if (i % 20 === 0) ctx.fx.explosion(p, 1.2);
  if (i % 30 === 0) ctx.fx.shatter(p, { color: new Color3(0.2, 0.2, 0.25), count: 12 });
  step(1);
}
const meshesDuringSpam = scene.meshes.length;
step(400);
check(ctx.dynamicBodies.size <= baseline, `debris expired (${ctx.dynamicBodies.size} bodies, baseline ${baseline})`);
check(scene.meshes.length <= meshesDuringSpam, `no mesh growth after effects (${scene.meshes.length} meshes)`);
for (let i = 0; i < 10; i++) ctx.fx.shatter(new Vector3(0, 2, 0), { count: 24 });
step(1);
check(ctx.dynamicBodies.size - baseline <= DEBRIS.max, `debris capped at DEBRIS.max (${ctx.dynamicBodies.size - baseline} live)`);

section("World API");
const probe = MeshBuilder.CreateBox("probe", {}, scene);
let apiOk = true;
try {
  ctx.world.addShadowCaster(probe);
  ctx.world.removeShadowCaster(probe);
} catch {
  apiOk = false;
}
check(apiOk, "addShadowCaster/removeShadowCaster");
check(consoleErrors.length === 0, `no console errors (${consoleErrors.length})`);
console.log(`  (player took ${playerDamage.toFixed(0)} damage from blasts near spawn)`);
finish();
