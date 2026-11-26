// src/player headless via createPlayer and synthetic pointer/key events: input gates, look,
// rifle (hits, prop push, reload), launcher, sprint/jump, damage/regen/death, restart.
// Not covered: feel, real pointer lock, rendering (needs a human; see src/player/AGENTS.md).
import { canvas, key, pointer, setPointerLock, dispatch } from "./support/dom.ts";
import { bootHeadless, check, consoleErrors, DT, finish, section } from "./support/headless.ts";
import { GlowLayer, MeshBuilder, PhysicsAggregate, PhysicsShapeType, Vector3 } from "@babylonjs/core";
import { createPlayer } from "../src/player/index.ts";
import { LOOK, PLAYER, RIFLE } from "../src/player/config.ts";
import { setDamageable } from "../src/core/damage.ts";
import type { GameEvents } from "../src/core/events.ts";

const { ctx, scene, camera, step } = await bootHeadless();
const secs = (s: number) => Math.round(s / DT);

const ground = MeshBuilder.CreateBox("ground", { width: 80, height: 1, depth: 80 }, scene);
ground.position.y = -0.5;
new PhysicsAggregate(ground, PhysicsShapeType.BOX, { mass: 0 }, scene);
const crate = MeshBuilder.CreateBox("crate", { size: 1 }, scene);
crate.position.set(0, 0.5, 8);
const crateAgg = new PhysicsAggregate(crate, PhysicsShapeType.BOX, { mass: 20 }, scene);
const drone = MeshBuilder.CreateSphere("drone", { diameter: 1 }, scene);
drone.position.set(0, 1.65, 20);
let droneHp = 30;
const droneTarget = {
  kind: "enemy" as const,
  get alive() {
    return droneHp > 0;
  },
  getPosition: () => drone.position.clone(),
  takeDamage(a: number) {
    droneHp -= a;
  },
};
setDamageable(drone, droneTarget);

const counts: Record<string, number> = {};
const last: Record<string, any> = {};
const names = ["weapon:fire", "weapon:reload", "weapon:empty", "ammo:changed", "launcher:changed", "hit", "player:damaged", "player:healed", "player:died", "player:jump", "player:land", "player:footstep", "explosion"] as const;
for (const n of names) {
  ctx.events.on(n, (p: GameEvents[typeof n]) => {
    counts[n] = (counts[n] ?? 0) + 1;
    last[n] = p;
  });
}
const fired = (weapon: "rifle" | "launcher") => (counts[`fired:${weapon}`] ?? 0);
ctx.events.on("weapon:fire", (p) => (counts[`fired:${p.weapon}`] = fired(p.weapon) + 1));

ctx.damageables.add(droneTarget);
ctx.dynamicBodies.add(crateAgg.body);
ctx.fx = { explosion() {}, impact() {}, tracer() {}, shatter() {} };
ctx.world = {
  playerSpawn: new Vector3(0, 0, 0),
  enemySpawnPoints: [],
  bounds: { minX: -30, maxX: 30, minZ: -10, maxZ: 50 },
  addShadowCaster() {},
  removeShadowCaster() {},
  glowLayer: new GlowLayer("glow", scene),
};
ctx.player = await createPlayer(ctx);

// Bring a held button back to "nothing pressed" between scenarios.
const release = () => pointer("pointerup", { buttons: 0 });
const click = (frames = 1) => {
  pointer("pointerdown", { buttons: 1 });
  step(frames);
  release();
};

section("Start gate");
step(10);
pointer("pointerdown", { buttons: 1 }); // the deploy click, still held as the game starts
ctx.state.phase = "playing";
ctx.events.emit("game:start", {});
setPointerLock(true);
step(3);
check(fired("rifle") === 0, "a click during the start gate does not fire");
step(secs((LOOK.fireGateMs + 100) / 1000));
pointer("pointermove", { buttons: 1, movementX: 1 });
step(3);
check(fired("rifle") === 0, "the deploy click held past the gate does not fire on mouse move");
release();
step(2);

section("Taps and chords");
pointer("pointerdown", { buttons: 1 });
release(); // down + up inside one frame, like trackpad tap-to-click
step(2);
check(fired("rifle") === 1, `a tap within one frame fires one shot (${fired("rifle")})`);
step(10);

section("Look and rifle");
pointer("pointermove", { buttons: 0, movementY: 40 }); // look down at the crate 8 m ahead
step(2);
const crateStart = crate.position.clone();
const hitsBefore = counts["hit"] ?? 0;
click(30);
step(20);
check(fired("rifle") > 3, `holding the trigger fires full auto (${fired("rifle")} shots)`);
check((counts["hit"] ?? 0) > hitsBefore && last["hit"]?.kind === "prop", `rifle hits the crate (${last["hit"]?.kind})`);
check(Vector3.Distance(crate.position, crateStart) > 0.2, `shots push the crate (${Vector3.Distance(crate.position, crateStart).toFixed(2)} m)`);
pointer("pointerdown", { buttons: 1 });
step(secs(4));
release();
check((counts["weapon:empty"] ?? 0) >= 1 && (counts["weapon:reload"] ?? 0) >= 1, "an empty magazine reloads automatically");
check(last["ammo:changed"]?.magSize === RIFLE.magSize, `ammo events report the magazine size (${RIFLE.magSize})`);

const quarterTurnPx = Math.PI / 2 / LOOK.sensitivity;
const yaw0 = camera.rotation.y;
pointer("pointermove", { buttons: 0, movementX: quarterTurnPx / 2 });
step(1);
pointer("pointermove", { buttons: 0, movementX: quarterTurnPx / 2 });
step(30);
const turned = ((camera.rotation.y - yaw0) * 180) / Math.PI;
check(Math.abs(turned - 90) < 4, `mouse look turns 90° for the expected distance (${turned.toFixed(1)}°)`);
pointer("pointermove", { buttons: 0, movementX: -quarterTurnPx / 2 });
step(1);
pointer("pointermove", { buttons: 0, movementX: -quarterTurnPx / 2 });
step(30);
pointer("pointermove", { buttons: 0, movementY: Math.round(-camera.rotation.x / LOOK.sensitivity) });
step(30);

section("Killing a target");
crate.setEnabled(false);
crateAgg.body.dispose();
ctx.dynamicBodies.delete(crateAgg.body);
click(40);
check(droneHp <= 0, `rifle kills the drone target (hp ${droneHp})`);
check(last["hit"]?.kind === "enemy", "hit events report the enemy");

section("Launcher");
const explosionsBefore = counts["explosion"] ?? 0;
pointer("pointerdown", { buttons: 2, button: 2 });
step(2);
release();
step(90);
check(fired("launcher") === 1 && (counts["explosion"] ?? 0) > explosionsBefore, "a right-click grenade launches and explodes");
pointer("pointerdown", { buttons: 1, ctrlKey: true });
step(2);
release();
check(fired("launcher") === 2, "Ctrl+click fires the launcher, not the rifle (macOS right-click)");
step(90);

section("Movement");
key("keydown", "KeyW");
key("keydown", "ShiftLeft");
step(60);
const speed = Math.hypot(ctx.player.getVelocity().x, ctx.player.getVelocity().z);
check(Math.abs(speed - PLAYER.sprintSpeed) < 0.5, `sprint reaches PLAYER.sprintSpeed (${speed.toFixed(2)} m/s)`);
check((counts["player:footstep"] ?? 0) > 0, `footsteps while moving (${counts["player:footstep"]})`);
check(camera.fov > 1.2, `sprint widens the field of view (${camera.fov.toFixed(3)})`);
key("keydown", "Space");
step(60);
key("keyup", "Space");
key("keyup", "KeyW");
key("keyup", "ShiftLeft");
step(30);
check(counts["player:jump"] === 1, "one jump");
check((counts["player:land"] ?? 0) >= 1, `landing reported (impact ${last["player:land"]?.impactSpeed?.toFixed(1)} m/s)`);

section("Pause releases held input");
key("keydown", "KeyW");
ctx.state.phase = "paused";
ctx.events.emit("game:pause", {});
dispatch("window", "blur");
ctx.state.phase = "playing";
ctx.events.emit("game:resume", {});
const before = ctx.player.getFeetPosition();
step(30);
check(Vector3.Distance(before, ctx.player.getFeetPosition()) < 0.2, "a key held through a pause does not keep walking");
key("keyup", "KeyW");

section("Health");
ctx.player.takeDamage(30, new Vector3(5, 1, 0));
check(ctx.player.health === PLAYER.maxHealth - 30, `damage applies (${ctx.player.health})`);
step(secs(PLAYER.regenDelay + 1));
check(ctx.player.health > PLAYER.maxHealth - 30, `health regenerates after PLAYER.regenDelay (${ctx.player.health.toFixed(1)})`);
ctx.player.takeDamage(500);
step(1);
ctx.player.takeDamage(10);
check(!ctx.player.alive && counts["player:died"] === 1, "death fires player:died exactly once");
ctx.state.phase = "gameover";
step(60);
ctx.state.phase = "playing";
ctx.events.emit("game:start", {});
step(30);
check(ctx.player.alive && ctx.player.health === PLAYER.maxHealth, "restart revives at full health");

check(consoleErrors.length === 0, `no console errors (${consoleErrors.length})`);
void canvas;
finish();
