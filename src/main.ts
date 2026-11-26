import { Color4, Engine, HavokPlugin, Scene, UniversalCamera, Vector3 } from "@babylonjs/core";
import HavokPhysics from "@babylonjs/havok";
import type { GameContext } from "./core/context";
import { DEV, installDevTools, runSelfTest } from "./core/debug";
import { EventBus, type GameEvents } from "./core/events";
import { createAudio } from "./audio";
import { createFx } from "./fx";
import { createWorld } from "./world";
import { createPlayer } from "./player";
import { createEnemies } from "./enemies";
import { createUi } from "./ui";

/** Fixed step for ?capture=1. Matches Scene.useConstantAnimationDeltaTime (16 ms). */
const CAPTURE_DT = 0.016;

declare global {
  interface Window {
    /** True once shaders are compiled and the first frame has rendered. */
    gameReady?: boolean;
    /** ?capture=1 only: advance n fixed steps (gameplay + physics), rendering each. */
    step?: (n?: number) => void;
  }
}

async function boot(): Promise<void> {
  const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
  const uiRoot = document.getElementById("ui") as HTMLElement;

  const engine = new Engine(canvas, true, { stencil: true, antialias: true, powerPreference: "high-performance" }, false);
  // Render at up to 1.5x device pixels: sharp on retina without melting the GPU.
  const params = new URLSearchParams(location.search);
  const pixelRatio = Math.min(window.devicePixelRatio || 1, Number(params.get("dpr")) || 1.5);
  engine.setHardwareScalingLevel(1 / pixelRatio);

  const renderer = engine.getGlInfo().renderer;
  console.info(`[boot] ${engine.description} · ${renderer}`);
  if (/swiftshader|llvmpipe|softpipe|software/i.test(renderer)) {
    console.warn(`[boot] Software renderer detected (${renderer}): expect very low frame rates. Enable hardware acceleration.`);
  }

  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.04, 0.05, 0.06, 1);
  if (DEV.capture) scene.useConstantAnimationDeltaTime = true;

  const hk = await HavokPhysics();
  // true = step by frame delta (Babylon clamps it to <= 0.1 s). Pause via scene.physicsEnabled.
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

  const ctx = {
    engine,
    scene,
    canvas,
    uiRoot,
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
  } as unknown as GameContext;

  ctx.audio = createAudio(ctx);
  ctx.fx = createFx(ctx);
  ctx.world = await createWorld(ctx);
  ctx.player = await createPlayer(ctx);
  const enemies = createEnemies(ctx);
  createUi(ctx);
  installDevTools(ctx, enemies);

  // Handy for debugging from the browser console.
  (window as unknown as { game: GameContext }).game = ctx;

  /** One frame: cosmetic + gameplay callbacks, then render (which also steps physics). */
  const tick = (dt: number): void => {
    // Physics keeps running in the menu and game-over screens (props settle, debris falls);
    // it only freezes while paused. (setTimeStep(0) does NOT pause: HavokPlugin(true)
    // steps by frame delta, so toggle the scene flag instead.)
    scene.physicsEnabled = ctx.state.phase !== "paused";
    for (const fn of frameFns) fn(dt);
    if (ctx.state.phase === "playing") for (const fn of updateFns) fn(dt);
    scene.render();
  };

  // Never hold rendering back on readiness: start drawing immediately and only flag
  // gameReady once shaders/textures are ready and a frame has been rendered after that.
  // (whenReadyAsync polls on timers, which background tabs throttle heavily.)
  if (DEV.capture) {
    window.step = (n = 1) => {
      for (let i = 0; i < Math.max(1, Math.floor(n)); i++) tick(CAPTURE_DT);
    };
    window.step(1);
    console.info("[capture] render loop stopped: call step(n) to advance n × 16 ms");
    void scene.whenReadyAsync().then(() => {
      window.step!(1);
      window.gameReady = true;
    });
  } else {
    engine.runRenderLoop(() => tick(Math.min(engine.getDeltaTime() / 1000, 1 / 20)));
    void scene.whenReadyAsync().then(() =>
      scene.onAfterRenderObservable.addOnce(() => {
        window.gameReady = true;
        if (DEV.selftest) void runSelfTest(ctx, enemies);
      }),
    );
  }

  window.addEventListener("resize", () => {
    engine.resize();
    if (DEV.capture) scene.render();
  });
  document.getElementById("boot")?.remove();
}

boot().catch((err) => {
  console.error(err);
  const el = document.getElementById("boot");
  if (el) el.textContent = `Failed to start: ${err instanceof Error ? err.message : String(err)}`;
});
