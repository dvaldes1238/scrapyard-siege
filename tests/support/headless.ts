// Shared harness: real Babylon (NullEngine, no GPU) + real Havok WASM + a GameContext,
// stepped at a fixed 1/60 s with a fake clock, plus tiny check()/finish() helpers.
import { canvas } from "./dom.ts";
import { readFileSync } from "node:fs";
import { HavokPlugin, NullEngine, Scene, UniversalCamera, Vector3 } from "@babylonjs/core";
import HavokPhysics from "@babylonjs/havok";
import { EventBus, type GameEvents } from "../../src/core/events.ts";
import type { GameContext } from "../../src/core/context.ts";

export const DT = 1 / 60;

// Fake clock: src/ uses performance.now() for input gates; tests advance it in step().
let simNow = 1000;
(performance as any).now = () => simNow;

const errors: string[] = [];
const originalError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  errors.push(args.map(String).join(" "));
  originalError(...args);
};
/** Everything logged with console.error so far (src/ reports caught handler errors there). */
export const consoleErrors: readonly string[] = errors;

export interface Headless {
  ctx: GameContext;
  scene: Scene;
  engine: NullEngine;
  camera: UniversalCamera;
  /** Sounds requested through ctx.audio.play, in order. */
  sounds: string[];
  /** Advance n frames like main.ts's tick(): onFrame, onUpdate (if playing), render (steps physics). */
  step(n?: number): void;
}

/**
 * Boot a headless scene with the same physics setup as main.ts. ctx.fx, ctx.world and
 * ctx.player are left unset: create the real module or assign a mock in the test.
 */
export async function bootHeadless(): Promise<Headless> {
  const wasm = readFileSync(new URL("../../node_modules/@babylonjs/havok/lib/esm/HavokPhysics.wasm", import.meta.url));
  const hk = await HavokPhysics({ wasmBinary: wasm });
  const engine = new NullEngine();
  // NullEngine reports ~0 ms frames, so physics would barely move: pin it to 1/60 s.
  (engine as any).getDeltaTime = () => 1000 * DT;
  const scene = new Scene(engine);
  const havok = new HavokPlugin(true, hk);
  scene.enablePhysics(new Vector3(0, -9.81, 0), havok);

  const camera = new UniversalCamera("playerCam", new Vector3(0, 1.7, 0), scene);
  camera.inputs.clear();
  camera.minZ = 0.05;
  camera.maxZ = 500;
  camera.fov = 1.2;
  scene.activeCamera = camera;

  const updateFns = new Set<(dt: number) => void>();
  const frameFns = new Set<(dt: number) => void>();
  const sounds: string[] = [];
  const ctx = {
    engine,
    scene,
    canvas,
    uiRoot: null,
    havok,
    camera,
    events: new EventBus<GameEvents>(),
    state: { phase: "menu", score: 0, kills: 0, wave: 0 },
    onUpdate(fn: (dt: number) => void) {
      updateFns.add(fn);
      return () => updateFns.delete(fn);
    },
    onFrame(fn: (dt: number) => void) {
      frameFns.add(fn);
      return () => frameFns.delete(fn);
    },
    damageables: new Set(),
    dynamicBodies: new Set(),
    audio: { play: (sound: string) => sounds.push(sound), unlock() {} },
  } as unknown as GameContext;

  const step = (n = 1): void => {
    for (let i = 0; i < n; i++) {
      simNow += 1000 * DT;
      scene.physicsEnabled = ctx.state.phase !== "paused";
      for (const fn of frameFns) fn(DT);
      if (ctx.state.phase === "playing") for (const fn of updateFns) fn(DT);
      scene.render();
    }
  };

  return { ctx, scene, engine, camera, sounds, step };
}

let passed = 0;
let failed = 0;

export function check(condition: unknown, message: string): void {
  if (condition) {
    passed++;
    console.log(`  ok    ${message}`);
  } else {
    failed++;
    console.log(`  FAIL  ${message}`);
  }
}

export function section(title: string): void {
  console.log(`\n${title}`);
}

/** Print the tally and exit (non-zero on any failure). */
export function finish(): never {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
