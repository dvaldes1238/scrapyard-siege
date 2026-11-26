// src/player/movement.ts headless: step-up and blocking heights at walk and sprint speed.
// Guards SteppingCharacterController's override of Babylon's protected _tryStepUp
// (see src/player/AGENTS.md, "Step-up"): re-run after every Babylon upgrade.
import { bootHeadless, check, consoleErrors, DT, finish, section } from "./support/headless.ts";
import { MeshBuilder, PhysicsAggregate, PhysicsShapeType, Vector3 } from "@babylonjs/core";
import { Movement, type MoveIntent } from "../src/player/movement.ts";

const { ctx, scene, step } = await bootHeadless();

const box = (w: number, h: number, d: number, x: number, y: number, z: number) => {
  const m = MeshBuilder.CreateBox("box", { width: w, height: h, depth: d }, scene);
  m.position.set(x, y, z);
  new PhysicsAggregate(m, PhysicsShapeType.BOX, { mass: 0, friction: 0.6, restitution: 0.1 }, scene);
};
box(120, 1, 80, 0, -0.5, 0); // ground, top at y = 0

// One lane per height: a 2×2 m step 4 m ahead of each start point (walking +z).
const climbable = [0.2, 0.3, 0.35];
const blocking = [0.4, 0.45];
const heights = [...climbable, ...blocking];
heights.forEach((h, i) => box(2, h, 2, i * 4, h / 2, 4));

const move = new Movement(ctx, new Vector3(0, 0, 0));
const idle: MoveIntent = { forward: 0, strafe: 0, sprint: false, jump: false, yaw: 0 };
const frame = (intent: Partial<MoveIntent>) => {
  move.update(DT, { ...idle, ...intent });
  step(1);
};

/** Walk into the step for ~0.8 s; true if the feet ended up on top of it. */
function climbs(laneIndex: number, h: number, sprint: boolean): boolean {
  move.cc.setPosition(new Vector3(laneIndex * 4, 0.95, 0));
  move.cc.setVelocity(Vector3.Zero());
  for (let i = 0; i < 24; i++) frame({});
  let maxFeetY = -Infinity;
  const feet = new Vector3();
  for (let i = 0; i < 50; i++) {
    frame({ forward: 1, sprint });
    maxFeetY = Math.max(maxFeetY, move.getFeetToRef(feet).y);
  }
  return maxFeetY > h * 0.6;
}

for (const sprint of [false, true]) {
  section(sprint ? "Sprinting" : "Walking");
  heights.forEach((h, i) => {
    const climbed = climbs(i, h, sprint);
    if (climbable.includes(h)) check(climbed, `climbs a ${h} m step`);
    else check(!climbed, `is blocked by a ${h} m step`);
  });
}

check(consoleErrors.length === 0, `no console errors (${consoleErrors.length})`);
finish();
