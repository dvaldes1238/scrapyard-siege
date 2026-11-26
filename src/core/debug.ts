import { Matrix, PhysicsViewer, UniversalCamera, Vector3, type Engine, type PhysicsBody, type Scene } from "@babylonjs/core";
import type { GameContext, PlayerApi } from "./context";
import type { GameEvents } from "./events";

/**
 * Developer URL options (see DESIGN.md):
 *   ?debug=1     physics shapes (P), drone AI labels, info panel, free camera (` key)
 *   ?god=1       player takes no damage
 *   ?wave=N      start at wave N
 *   ?capture=1   no render loop; window.step(n) advances n fixed 16 ms steps (main.ts)
 *   ?selftest=1  scripted 10 s session, report shown on page + POSTed to /__selftest
 */
const params = new URLSearchParams(location.search);

/** All Havok bodies (the scene getter is typed as the v1/v2 union). */
function physicsBodies(scene: Scene): PhysicsBody[] {
  const engine = scene.getPhysicsEngine() as unknown as { getBodies(): PhysicsBody[] } | null;
  return engine?.getBodies() ?? [];
}
export const DEV = {
  debug: params.get("debug") === "1",
  god: params.get("god") === "1",
  wave: Math.max(0, Math.floor(Number(params.get("wave")) || 0)),
  capture: params.get("capture") === "1",
  selftest: params.get("selftest") === "1",
};

/** What the debug tools need from src/enemies (structural, keeps core independent). */
export interface DebugEnemies {
  skipTo(wave: number): void;
  killAll(): void;
  drones(): Iterable<{ readonly alive: boolean; getPosition(): Vector3; debugInfo(): string }>;
}

export function installDevTools(ctx: GameContext, enemies: DebugEnemies): void {
  if (DEV.god || DEV.selftest) {
    (ctx.player as { takeDamage: PlayerApi["takeDamage"] }).takeDamage = () => {};
  }
  if (DEV.wave > 1) {
    // Registered after createEnemies, so this runs after the director's own start().
    ctx.events.on("game:start", () => enemies.skipTo(DEV.wave));
  }
  if (DEV.debug) installDebugView(ctx, enemies);
}

// ---------------------------------------------------------------------------------------------
// ?debug=1
// ---------------------------------------------------------------------------------------------

function installDebugView(ctx: GameContext, enemies: DebugEnemies): void {
  const { scene, engine, canvas } = ctx;

  const layer = document.createElement("div");
  layer.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:50;font:11px/1.35 ui-monospace,Menlo,monospace;";
  document.body.appendChild(layer);
  const panel = document.createElement("div");
  panel.style.cssText =
    "position:absolute;left:8px;top:8px;padding:6px 8px;background:rgba(0,0,0,.6);color:#9ef;white-space:pre;border-radius:4px;";
  layer.appendChild(panel);

  // --- Physics shapes (toggle with P) ---
  let viewer: PhysicsViewer | null = null;
  const shown = new Set<PhysicsBody>();
  let syncTimer = 0;
  const syncViewer = (): void => {
    if (!viewer) return;
    for (const b of shown) {
      if (b.isDisposed) {
        viewer.hideBody(b);
        shown.delete(b);
      }
    }
    for (const b of physicsBodies(scene)) {
      if (!shown.has(b) && !b.isDisposed) {
        viewer.showBody(b);
        shown.add(b);
      }
    }
  };
  const toggleViewer = (): void => {
    if (viewer) {
      viewer.dispose();
      viewer = null;
      shown.clear();
    } else {
      viewer = new PhysicsViewer(scene);
      syncViewer();
    }
  };
  toggleViewer();

  // --- Free camera (toggle with `) ---
  const freeCam = new UniversalCamera("debugFreeCam", Vector3.Zero(), scene);
  freeCam.inputs.clear();
  freeCam.minZ = 0.05;
  freeCam.maxZ = 800;
  let free = false;
  const flyKeys = new Set<string>();
  const BLOCKED = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "KeyQ", "KeyE", "Space", "ShiftLeft", "ShiftRight", "KeyR"]);
  const toggleFree = (): void => {
    free = !free;
    flyKeys.clear();
    if (free) {
      freeCam.position.copyFrom(ctx.camera.globalPosition);
      freeCam.rotation.copyFrom(ctx.camera.rotation);
      freeCam.rotation.z = 0;
      freeCam.fov = ctx.camera.fov;
      scene.activeCamera = freeCam;
    } else {
      scene.activeCamera = ctx.camera;
    }
  };

  // Capture phase on window runs before the player's listeners, so the player stays put while flying.
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.code === "Backquote") {
        e.preventDefault();
        if (!e.repeat) toggleFree();
        return;
      }
      if (e.code === "KeyP" && !e.repeat) toggleViewer();
      if (free && BLOCKED.has(e.code)) {
        flyKeys.add(e.code);
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    },
    true,
  );
  window.addEventListener("keyup", (e) => flyKeys.delete(e.code), true);
  // While flying, the player must see no pointer input at all: it reads presses from pointermove's
  // button mask as well as pointerdown, and turns its own camera on pointermove.
  window.addEventListener(
    "pointerdown",
    (e) => {
      if (free) e.stopImmediatePropagation();
    },
    true,
  );
  window.addEventListener(
    "pointermove",
    (e) => {
      if (!free) return;
      e.stopImmediatePropagation();
      const locked = document.pointerLockElement === canvas;
      if (!locked && !(e.buttons & 1)) return; // unlocked: drag to look
      freeCam.rotation.y += e.movementX * 0.0025;
      freeCam.rotation.x = Math.max(-1.55, Math.min(1.55, freeCam.rotation.x + e.movementY * 0.0025));
    },
    true,
  );

  // --- Drone labels ---
  const labels = new Map<object, HTMLDivElement>();
  const viewport = { x: 0, y: 0, width: 0, height: 0 };
  const tmp = new Vector3();

  let fpsAvg = 60;
  ctx.onFrame((dt) => {
    if (free) {
      const speed = flyKeys.has("ShiftLeft") || flyKeys.has("ShiftRight") ? 24 : 8;
      const move = new Vector3(
        (flyKeys.has("KeyD") ? 1 : 0) - (flyKeys.has("KeyA") ? 1 : 0),
        (flyKeys.has("KeyE") || flyKeys.has("Space") ? 1 : 0) - (flyKeys.has("KeyQ") ? 1 : 0),
        (flyKeys.has("KeyW") ? 1 : 0) - (flyKeys.has("KeyS") ? 1 : 0),
      );
      if (move.lengthSquared() > 0) {
        const world = Vector3.TransformNormal(move.normalize(), freeCam.getWorldMatrix());
        freeCam.position.addInPlace(world.scaleInPlace(speed * dt));
      }
    }

    syncTimer -= dt;
    if (syncTimer <= 0) {
      syncTimer = 0.5;
      syncViewer();
    }

    // Labels: project drone centres to CSS pixels.
    const cam = scene.activeCamera ?? ctx.camera;
    const rw = engine.getRenderWidth();
    const rh = engine.getRenderHeight();
    const vp = cam.viewport.toGlobal(rw, rh);
    viewport.x = vp.x;
    viewport.y = vp.y;
    viewport.width = vp.width;
    viewport.height = vp.height;
    const toCss = canvas.clientWidth / rw;
    const transform = scene.getTransformMatrix();
    const seen = new Set<object>();
    for (const d of enemies.drones()) {
      if (!d.alive) continue;
      seen.add(d);
      let el = labels.get(d);
      if (!el) {
        el = document.createElement("div");
        el.style.cssText =
          "position:absolute;transform:translate(-50%,-140%);padding:1px 4px;background:rgba(0,0,0,.55);color:#ffb547;white-space:nowrap;border-radius:3px;";
        layer.appendChild(el);
        labels.set(d, el);
      }
      Vector3.ProjectToRef(d.getPosition(), Matrix.IdentityReadOnly, transform, viewport as never, tmp);
      const visible = tmp.z > 0 && tmp.z < 1;
      el.style.display = visible ? "block" : "none";
      if (visible) {
        el.style.left = `${tmp.x * toCss}px`;
        el.style.top = `${tmp.y * toCss}px`;
        el.textContent = d.debugInfo();
      }
    }
    for (const [d, el] of labels) {
      if (!seen.has(d)) {
        el.remove();
        labels.delete(d);
      }
    }

    const fpsNow = engine.getFps();
    if (Number.isFinite(fpsNow)) fpsAvg += (fpsNow - fpsAvg) * Math.min(1, dt * 2);
    const p = ctx.player.getFeetPosition();
    panel.textContent =
      `DEBUG  fps ${fpsAvg.toFixed(0)}  ${engine.getRenderWidth()}×${engine.getRenderHeight()}\n` +
      `phase ${ctx.state.phase}  wave ${ctx.state.wave}  score ${ctx.state.score}  kills ${ctx.state.kills}\n` +
      `drones ${labels.size}  bodies ${physicsBodies(scene).length}  meshes ${scene.meshes.length}\n` +
      `player ${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}  hp ${Math.ceil(ctx.player.health)}${DEV.god ? " (god)" : ""}\n` +
      `[\`] free cam ${free ? "ON  WASD/QE, Shift fast" : "off"}   [P] physics shapes ${viewer ? "on" : "off"}`;
  });
}

// ---------------------------------------------------------------------------------------------
// ?selftest=1 — unattended smoke test (works in any browser, no user gesture needed)
// ---------------------------------------------------------------------------------------------

export async function runSelfTest(ctx: GameContext, enemies: DebugEnemies): Promise<void> {
  const errors: string[] = [];
  window.addEventListener("error", (e) => errors.push(`error: ${e.message}`));
  window.addEventListener("unhandledrejection", (e) => errors.push(`rejection: ${String(e.reason)}`));
  const origError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" ").slice(0, 300));
    origError(...args);
  };

  const counts: Record<string, number> = {};
  const watch: Array<keyof GameEvents> = [
    "weapon:fire",
    "hit",
    "explosion",
    "enemy:spawned",
    "enemy:fired",
    "enemy:killed",
    "wave:start",
  ];
  for (const name of watch) ctx.events.on(name, () => (counts[name] = (counts[name] ?? 0) + 1));

  const fps: number[] = [];
  const fpsTimer = window.setInterval(() => fps.push(ctx.engine.getFps()), 500);
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const canvas = ctx.canvas;
  const pointer = (type: string, buttons: number, button = 0): void => {
    canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, buttons, button, pointerType: "mouse", pointerId: 1 }));
  };

  const t0 = performance.now();
  await wait(500);
  ctx.state.phase = "playing";
  ctx.events.emit("game:start", {});
  await wait(600);
  enemies.skipTo(3);
  pointer("pointerdown", 1, 0); // hold the rifle trigger
  await wait(1500);
  pointer("pointerup", 0, 0);
  for (let i = 0; i < 2; i++) {
    pointer("pointerdown", 2, 2); // grenade
    await wait(80);
    pointer("pointerup", 0, 2);
    await wait(500);
  }
  await wait(4500); // drones warp in and fight
  enemies.killAll();
  await wait(1500);
  window.clearInterval(fpsTimer);

  const sorted = [...fps].sort((a, b) => a - b);
  const engine = ctx.engine as Engine;
  const gl = engine.getGlInfo();
  const report = {
    ok:
      errors.length === 0 &&
      (counts["weapon:fire"] ?? 0) > 5 &&
      (counts["explosion"] ?? 0) > 0 &&
      (counts["enemy:spawned"] ?? 0) > 0 &&
      (counts["enemy:killed"] ?? 0) > 0,
    userAgent: navigator.userAgent,
    renderer: gl.renderer,
    webgl: engine.webGLVersion,
    seconds: Math.round((performance.now() - t0) / 100) / 10,
    fps: { median: Math.round(sorted[Math.floor(sorted.length / 2)] ?? 0), min: Math.round(sorted[0] ?? 0) },
    phase: ctx.state.phase,
    wave: ctx.state.wave,
    kills: ctx.state.kills,
    physicsBodies: physicsBodies(ctx.scene).length,
    meshes: ctx.scene.meshes.length,
    counts,
    errors: errors.slice(0, 20),
  };
  (window as unknown as { selftestReport: unknown }).selftestReport = report;

  const box = document.createElement("pre");
  box.style.cssText = `position:fixed;right:12px;top:12px;z-index:60;max-width:46vw;max-height:80vh;overflow:auto;margin:0;padding:10px 12px;font:12px/1.4 ui-monospace,Menlo,monospace;color:#eee;background:rgba(0,0,0,.8);border:2px solid ${report.ok ? "#3c6" : "#e44"};border-radius:6px;`;
  box.textContent = `SELFTEST ${report.ok ? "PASS" : "FAIL"}\n` + JSON.stringify(report, null, 2);
  document.body.appendChild(box);
  fetch("/__selftest", { method: "POST", body: JSON.stringify(report) }).catch(() => {});
}
