import "./ui.css";
import type { GameContext, Phase } from "../core/context";
import { el } from "./dom";
import { createHud } from "./hud";
import { createScreens, type Screens } from "./screens";

/**
 * HTML/CSS overlay: start / pause / game-over screens, the pointer-lock phase
 * machine and the in-game HUD. Everything lives in ctx.uiRoot (pointer-events:
 * none); only buttons and the pause screen opt back into pointer events.
 *
 * URL params: ?fps=1 shows an FPS readout.
 */
export function createUi(ctx: GameContext): void {
  const root = el("div", "ss-root", ctx.uiRoot);
  const hud = createHud(ctx, root);

  // Phase is mutated here (start/pause/resume) and by src/enemies (gameover), so
  // the UI both syncs immediately after its own changes and polls each frame.
  let screens: Screens | null = null;
  let lastPhase: Phase | null = null;
  const sync = (): void => {
    const phase = ctx.state.phase;
    if (phase === lastPhase) return;
    lastPhase = phase;
    root.dataset.phase = phase;
    screens?.onPhase(phase);
  };
  screens = createScreens(ctx, root, { sync, toast: (m) => hud.toast(m) });

  if (new URLSearchParams(location.search).get("fps") === "1") {
    const fps = el("div", "ss-fps", root, "-- FPS");
    let acc = 0;
    ctx.onFrame((dt) => {
      acc += dt;
      if (acc < 0.5) return;
      acc = 0;
      fps.textContent = `${Math.round(ctx.engine.getFps())} FPS`;
    });
  }

  ctx.onFrame((dt) => {
    sync();
    hud.frame(dt);
  });
  sync();
}
