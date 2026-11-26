// src/enemies headless, against mocked fx/world/player: wave timing and composition, kinematic
// bodies, bolts, damage/death, kill credit, the alive cap, the flight envelope, game over, restart.
// LEAD_EXP=1 npm test -- enemies  re-runs the aim-lead experiment (see src/enemies/AGENTS.md).
import { bootHeadless, check, consoleErrors, DT, finish, section } from "./support/headless.ts";
import { Color3, MeshBuilder, PhysicsAggregate, PhysicsShapeType, Vector3 } from "@babylonjs/core";
import { createEnemies } from "../src/enemies/index.ts";
import { BOLT, DRONES, FLIGHT, WAVES, waveComposition } from "../src/enemies/config.ts";
import { setDamageable } from "../src/core/damage.ts";
import type { GameEvents } from "../src/core/events.ts";

const { ctx, scene, step: rawStep } = await bootHeadless();
const total = (n: number) => {
  const c = waveComposition(n);
  return c.seekers + c.bombers + c.brutes;
};

// World stand-ins: ground, one container, one barrel.
const ground = MeshBuilder.CreateGround("ground", { width: 80, height: 80 }, scene);
new PhysicsAggregate(ground, PhysicsShapeType.BOX, { mass: 0 }, scene);
const container = MeshBuilder.CreateBox("container", { width: 6, height: 2.6, depth: 2.5 }, scene);
container.position.set(8, 1.3, 0);
new PhysicsAggregate(container, PhysicsShapeType.BOX, { mass: 0 }, scene);
const barrel = MeshBuilder.CreateCylinder("barrel", { height: 1, diameter: 0.6 }, scene);
barrel.position.set(-4, 0.5, 3);
let barrelDamage = 0;
setDamageable(barrel, {
  kind: "barrel",
  alive: true,
  getPosition: () => barrel.position.clone(),
  takeDamage: (a: number) => {
    barrelDamage += a;
  },
});

const counts: Record<string, number> = {};
const bump = (k: string) => (counts[k] = (counts[k] ?? 0) + 1);
const log: { name: string; payload: any }[] = [];
for (const n of ["enemy:spawned", "enemy:fired", "enemy:killed", "wave:start", "wave:cleared", "score:changed", "game:over", "explosion"] as const) {
  ctx.events.on(n, (p: GameEvents[typeof n]) => {
    bump(n);
    log.push({ name: n, payload: p });
  });
}

const player = {
  health: 100,
  maxHealth: 100,
  alive: true,
  radius: 0.4,
  height: 1.8,
  feet: new Vector3(0, 0, 0),
  vel: new Vector3(),
  damage: 0,
  hits: 0,
  getEyePosition() {
    return this.feet.add(new Vector3(0, 1.65, 0));
  },
  getFeetPosition() {
    return this.feet.clone();
  },
  getVelocity() {
    return this.vel.clone();
  },
  takeDamage(a: number) {
    this.hits++;
    this.damage += a;
  },
  applyKnockback() {},
};
const shadowCasters = new Set<any>();
ctx.fx = {
  explosion: () => bump("fx.explosion"),
  impact: (_p, _n, k) => bump(`fx.impact.${k}`),
  tracer() {},
  shatter: (_p, o) => {
    bump("fx.shatter");
    if (!(o?.color instanceof Color3)) bump("fx.shatter.badcolor");
  },
};
ctx.world = {
  playerSpawn: new Vector3(0, 0, 0),
  enemySpawnPoints: [new Vector3(-25, 7, 25), new Vector3(25, 7, 25), new Vector3(25, 8, -25), new Vector3(-25, 6, -25), new Vector3(0, 9, 30)],
  bounds: { minX: -34, maxX: 34, minZ: -34, maxZ: 34 },
  addShadowCaster: (m: any, inc?: boolean) => {
    shadowCasters.add(m);
    if (inc) for (const c of m.getChildMeshes(false)) shadowCasters.add(c);
  },
  removeShadowCaster: (m: any) => {
    shadowCasters.delete(m);
    for (const c of m.getChildMeshes?.(false) ?? []) shadowCasters.delete(c);
  },
  glowLayer: {} as any,
};
ctx.player = player;

const api = createEnemies(ctx);
const sys = (globalThis as any).enemies.system;

// Envelope and smoothness monitors, sampled every frame.
let envelopeViolations = 0;
let maxAccelRatio = 0;
const lastVel = new Map<any, Vector3>();
const altMax = FLIGHT.altMax;
function step(n: number) {
  for (let i = 0; i < n; i++) {
    rawStep(1);
    for (const d of sys.drones) {
      const p = d.position;
      const b = ctx.world.bounds;
      if (p.x < b.minX || p.x > b.maxX || p.z < b.minZ || p.z > b.maxZ || p.y < FLIGHT.altMin - 1e-6 || p.y > altMax + 1e-6) envelopeViolations++;
      const lv = lastVel.get(d);
      if (lv && ctx.state.phase === "playing" && d.flashTimer <= 0) {
        maxAccelRatio = Math.max(maxAccelRatio, d.velocity.subtract(lv).length() / DT / d.spec.accel);
      }
      lastVel.set(d, d.velocity.clone());
    }
  }
}
const secs = (s: number) => Math.round(s / DT);

section("Wave 1");
ctx.state.phase = "playing";
ctx.events.emit("game:start", {});
step(secs(WAVES.firstDelay) - 10);
check(!counts["wave:start"], `no wave before ${WAVES.firstDelay} s`);
step(20);
check(counts["wave:start"] === 1 && ctx.state.wave === 1, `wave 1 started (wave=${ctx.state.wave})`);
check(log.find((e) => e.name === "wave:start")?.payload.enemies === total(1), `wave 1 has ${total(1)} drones`);
step(secs(3));
check(sys.drones.size === total(1), `all wave 1 drones alive after staggered warp-in (${sys.drones.size})`);
check(counts["enemy:spawned"] === total(1) && ctx.damageables.size === total(1), "enemy:spawned and damageables match");
const tooClose = log.filter((e) => e.name === "enemy:spawned").some((e) => Math.hypot(e.payload.position.x, e.payload.position.z) < WAVES.minSpawnDistance - WAVES.spawnJitter - 0.5);
check(!tooClose, "drones spawn away from the player");

section("Kinematic bodies");
const d0 = [...sys.drones][0] as any;
const body = d0.root.physicsBody;
check(!!body && body.getMotionType() === 1, "drone has an ANIMATED body");
step(1);
const centre = new Vector3();
body.getObjectCenterWorldToRef(centre);
check(Vector3.Distance(centre, d0.position) < 0.05, `body follows the root (err ${Vector3.Distance(centre, d0.position).toFixed(4)} m)`);
check(shadowCasters.has(d0.root), "drone registered as a shadow caster");

section("Seekers fight");
step(secs(12));
check(
  [...sys.drones].every((d: any) => {
    const r = Math.hypot(d.position.x, d.position.z);
    return r > 7 && r < 19;
  }),
  "seekers orbit at roughly their configured range",
);
check((counts["enemy:fired"] ?? 0) > 5, `seekers fire (${counts["enemy:fired"]} bolts)`);
check(player.hits > 0, `bolts hit a standing player (${player.hits} hits)`);
{
  const h0 = player.hits;
  const f0 = counts["enemy:fired"] ?? 0;
  for (let i = 0, t = 0; i < 600; i++) {
    t += DT;
    const ang = t * 0.6;
    player.vel.set(-Math.sin(ang) * 6, 0, Math.cos(ang) * 6);
    player.feet.set(Math.cos(ang) * 10 - 10, 0, Math.sin(ang) * 10);
    step(1);
  }
  player.vel.setAll(0);
  player.feet.setAll(0);
  const shots = (counts["enemy:fired"] ?? 0) - f0;
  const hits = player.hits - h0;
  console.log(`  (circling player: ${hits}/${shots} bolts hit)`);
  check(shots > 0 && hits < shots, "a moving player can dodge some bolts");
}

if (process.env.LEAD_EXP) {
  for (const lead of [0.5, 0.7, 0.85]) {
    (BOLT as any).lead = lead;
    for (const mode of ["linear", "circle"]) {
      const h0 = player.hits;
      const f0 = counts["enemy:fired"] ?? 0;
      for (let i = 0, t = 0; i < secs(25); i++) {
        t += DT;
        if (mode === "circle") {
          const ang = t * 0.6;
          player.vel.set(-Math.sin(ang) * 6, 0, Math.cos(ang) * 6);
          player.feet.set(Math.cos(ang) * 10 - 10, 0, Math.sin(ang) * 10);
        } else {
          const dir = Math.sin(t * 0.45) >= 0 ? 1 : -1;
          player.vel.set(6 * dir, 0, 0);
          player.feet.x += 6 * dir * DT;
        }
        step(1);
      }
      const shots = (counts["enemy:fired"] ?? 0) - f0;
      const hits = player.hits - h0;
      console.log(`  lead ${lead} ${mode}: ${hits}/${shots} = ${shots ? Math.round((100 * hits) / shots) : 0}%`);
    }
  }
  finish();
}

section("Grenade vs drone");
ctx.state.phase = "menu"; // freeze AI so the target holds still
step(30);
const target = [...sys.drones][0] as any;
const g = MeshBuilder.CreateSphere("grenade", { diameter: 0.24 }, scene);
g.position.copyFrom(target.position.add(new Vector3(-3, 0, 0)));
const ga = new PhysicsAggregate(g, PhysicsShapeType.SPHERE, { mass: 1, radius: 0.12 }, scene);
ga.body.setGravityFactor(0);
ga.body.setLinearVelocity(new Vector3(25, 0, 0));
ga.body.setCollisionCallbackEnabled(true);
let grenadeHit = false;
ga.body.getCollisionObservable().add((e: any) => {
  if (e.collidedAgainst === target.root.physicsBody) grenadeHit = true;
});
step(30);
check(grenadeHit, "a dynamic sphere collides with a drone's animated body");
ga.dispose();
g.dispose();
ctx.state.phase = "playing";

section("Damage and death");
const victim = [...sys.drones][0] as any;
const v0 = victim.velocity.clone();
victim.takeDamage(12, { source: "rifle", direction: new Vector3(1, 0, 0), point: victim.position.clone() });
check(victim.flash.isVisible === true, "hit flash on");
check(victim.velocity.x - v0.x > 0.5, "knockback along the shot");
step(5);
check(victim.flash.isVisible === false, "hit flash off again");
const killsBefore = ctx.state.kills;
const scoreBefore = ctx.state.score;
const alive = sys.drones.size;
api.killAll();
check(ctx.state.kills === killsBefore + alive, `kills +${alive} (${ctx.state.kills})`);
check(ctx.state.score === scoreBefore + alive * DRONES.seeker.points, `score +${alive * DRONES.seeker.points} (${ctx.state.score})`);
check(ctx.damageables.size === 0 && sys.drones.size === 0, "dead drones unregistered");
check(counts["fx.shatter"] === alive && !counts["fx.shatter.badcolor"], "one coloured shatter per death");
check(!shadowCasters.has(victim.root), "shadow caster removed");
check(!victim.root.physicsBody, "body disposed at death");
const meshesBefore = scene.meshes.length;
step(2);
check(scene.meshes.length < meshesBefore, `meshes disposed the next frame (${meshesBefore} → ${scene.meshes.length})`);
check(counts["wave:cleared"] === 1, "wave 1 cleared");
check(log.find((e) => e.name === "wave:cleared")?.payload.bonus === WAVES.clearBonusPerWave, "clear bonus for wave 1");
step(secs(WAVES.intermission) + 10);
check(ctx.state.wave === 2, `wave 2 after the intermission (${ctx.state.wave})`);

section("Double-death guard");
step(secs(4));
const [a, b] = [...sys.drones] as any[];
if (a && b) {
  b.position.copyFrom(a.position.add(new Vector3(1, 0, 0)));
  b.hp = 1;
  const k0 = ctx.state.kills;
  a.takeDamage(1e6, { source: "rifle" });
  a.takeDamage(1e6, { source: "rifle" });
  check(ctx.state.kills === k0 + 2, `a chain kill is counted once per drone (+${ctx.state.kills - k0})`);
} else check(false, "wave 2 has two drones to test the chain");

section("Bombers");
api.skipTo(3);
const killsAt3 = ctx.state.kills;
const bomberBlastsBefore = log.filter((e) => e.name === "explosion" && e.payload.radius === 4).length;
step(secs(14));
const bomberBlasts = log.filter((e) => e.name === "explosion" && e.payload.radius === 4).length - bomberBlastsBefore;
check(bomberBlasts >= 1, `a bomber detonated on the player (${bomberBlasts})`);
check(ctx.state.kills === killsAt3, "a bomber's self-detonation is not a kill");

section("Wave 5 and the cap");
api.skipTo(5);
step(secs(2));
check(log.filter((e) => e.name === "wave:start").pop()?.payload.enemies === total(5), `wave 5 has ${total(5)} drones`);
step(secs(8));
check([...sys.drones].some((d: any) => d.type === "brute"), "a brute spawned");
const fired5 = counts["enemy:fired"];
step(secs(6));
check(counts["enemy:fired"] > fired5, "wave 5 drones fire");
check(sys.drones.size <= WAVES.maxAlive, `at most ${WAVES.maxAlive} alive (${sys.drones.size})`);
api.skipTo(12);
step(secs(20));
check(sys.drones.size <= WAVES.maxAlive, `cap holds on wave 12 (${sys.drones.size} alive)`);
console.log(`  (stray bolts did ${barrelDamage} damage to the test barrel)`);

section("Game over and restart");
player.alive = false;
ctx.events.emit("player:died", {});
check(ctx.state.phase === "gameover", "phase → gameover");
const over = log.find((e) => e.name === "game:over");
check(!!over && over.payload.wave === 12, `game:over payload ${JSON.stringify(over?.payload)}`);
check(sys.bolts.activeCount === 0, "bolts cleared on game over");
const someDrone = [...sys.drones][0] as any;
const rot0 = someDrone?.rotors[0].ring.rotation.y;
step(120);
check(!!someDrone && someDrone.rotors[0].ring.rotation.y !== rot0, "rotors keep spinning on the game-over screen");
player.alive = true;
ctx.state.phase = "playing";
ctx.events.emit("game:start", {});
check(sys.drones.size === 0 && ctx.state.score === 0 && ctx.state.kills === 0 && ctx.damageables.size === 0, "restart clears drones and score");
step(secs(WAVES.firstDelay + 1));
check(ctx.state.wave === 1, "wave 1 again after restart");

section("Whole run");
check(consoleErrors.length === 0, `no console errors (${consoleErrors.length})`);
check(envelopeViolations === 0, `drones stayed inside bounds and the altitude band (${envelopeViolations} violations)`);
console.log(`  (max accel ratio outside knockback frames: ${maxAccelRatio.toFixed(2)})`);
finish();
