import type { GameContext, Phase } from "../core/context";
import { clamp, el, Flag, fmt, q } from "./dom";

export interface ScreensHooks {
  /** Re-apply UI state after this module changes ctx.state.phase. */
  sync(): void;
  toast(message: string): void;
}

export interface Screens {
  onPhase(phase: Phase): void;
}

const CONTROLS: [string, string][] = [
  ["Mouse", "Look"],
  ["WASD", "Move"],
  ["Shift", "Sprint"],
  ["Space", "Jump"],
  ["LMB", "Pulse rifle · hold"],
  ["RMB", "Kinetic grenade"],
  ["R", "Reload"],
  ["Esc", "Pause"],
];

const BEST_KEY = "scrapyard-siege:best";
const GAMEOVER_DELAY_MS = 1100;
/** Chrome refuses re-locking for ~1 s after Esc; failures later than this are "real". */
const RELOCK_COOLDOWN_MS = 2500;

/**
 * Start / pause / game-over screens and the phase + pointer-lock state machine:
 *   menu --click--> playing <--lock lost / regained--> paused
 *   any --game:over--> gameover (exit lock, stats, reload to replay)
 */
export function createScreens(ctx: GameContext, root: HTMLElement, hooks: ScreensHooks): Screens {
  const { canvas, events, state } = ctx;
  const keyRows = CONTROLS.map(([k, a]) => `<span class="ss-key">${k}</span><span class="ss-ctl">${a}</span>`).join("");

  // ------------------------------------------------------------ start
  const start = el("section", "ss-screen ss-start", root);
  start.innerHTML = `
    <div class="ss-start-inner">
      <div class="ss-eyebrow ss-anim" style="--d:0">Sector 7 salvage yard &nbsp;//&nbsp; hostile</div>
      <h1 class="ss-title ss-anim" style="--d:1" aria-label="Scrapyard Siege"><span>Scrapyard</span><span class="ss-accent">Siege</span></h1>
      <div class="ss-hazard ss-anim" style="--d:2"></div>
      <p class="ss-tagline ss-anim" style="--d:3">Hold the yard. Break everything.</p>
      <div class="ss-controls ss-anim" style="--d:4">${keyRows}</div>
      <div class="ss-btn-wrap ss-anim" style="--d:5"><button class="ss-btn ss-deploy" type="button">Click to deploy</button></div>
      <div class="ss-footnote ss-anim" style="--d:6">Headphones recommended &nbsp;·&nbsp; Chain the barrels</div>
    </div>`;
  const startVisible = new Flag(start, "is-visible");

  // ------------------------------------------------------------ pause
  const pause = el("section", "ss-screen ss-pause", root);
  pause.innerHTML = `
    <div class="ss-pause-inner">
      <h2 class="ss-pause-title">PAUSED</h2>
      <div class="ss-hazard"></div>
      <div class="ss-pause-cta">Click to resume</div>
      <div class="ss-pause-hint"></div>
      <div class="ss-pause-keys">${CONTROLS.map(([k, a]) => `<div><span class="ss-key">${k}</span><span class="ss-ctl">${a}</span></div>`).join("")}</div>
    </div>`;
  const pauseVisible = new Flag(pause, "is-visible");
  const pauseInner = q(pause, ".ss-pause-inner");
  const hintEl = q(pause, ".ss-pause-hint");
  const hintOn = new Flag(hintEl, "is-on");

  // ------------------------------------------------------------ game over
  const over = el("section", "ss-screen ss-over", root);
  over.innerHTML = `
    <div class="ss-over-inner">
      <div class="ss-eyebrow ss-anim" style="--d:0">Signal lost</div>
      <h2 class="ss-over-title ss-anim" style="--d:1">GAME OVER</h2>
      <p class="ss-over-sub ss-anim" style="--d:2">The yard has fallen.</p>
      <div class="ss-stats ss-anim" style="--d:3">
        <div class="ss-stat"><span class="ss-label">Score</span><span class="ss-stat-val ss-o-score">0</span></div>
        <div class="ss-stat"><span class="ss-label">Wave reached</span><span class="ss-stat-val ss-o-wave">0</span></div>
        <div class="ss-stat"><span class="ss-label">Kills</span><span class="ss-stat-val ss-o-kills">0</span></div>
      </div>
      <div class="ss-label ss-best ss-anim" style="--d:4"></div>
      <div class="ss-btn-wrap ss-anim" style="--d:5"><button class="ss-btn ss-again" type="button">Play again</button></div>
    </div>`;
  const overVisible = new Flag(over, "is-visible");
  const bestEl = q(over, ".ss-best");

  // ------------------------------------------------------------ pointer lock
  const lockApi = typeof canvas.requestPointerLock === "function" && "pointerLockElement" in document;
  /** True when pointer lock is missing or refused: the game runs unlocked and Esc pauses via keydown. */
  let lockBroken = !lockApi;
  let lastErrorAt = 0;
  let pausedAt = 0;
  let lateFailures = 0;
  let toldBroken = false;
  const isLocked = (): boolean => lockApi && document.pointerLockElement === canvas;

  function requestLock(): void {
    if (!lockApi) return;
    try {
      // Returns a Promise in modern Chrome/Firefox, undefined in older Safari.
      const r: unknown = canvas.requestPointerLock();
      if (r instanceof Promise) r.catch(onLockError);
    } catch {
      onLockError();
    }
  }

  function onLockError(): void {
    const now = performance.now();
    if (now - lastErrorAt < 150) return; // the event and the rejected promise both report it
    lastErrorAt = now;
    if (state.phase === "paused") {
      if (now - pausedAt > RELOCK_COOLDOWN_MS) lateFailures++;
      if (lateFailures >= 2) {
        // The browser keeps refusing: carry on without mouse capture rather than trap the player.
        lockBroken = true;
        resume();
        tellBroken();
        return;
      }
      showHint(
        now - pausedAt < RELOCK_COOLDOWN_MS
          ? "The browser needs a moment after Esc. Click again."
          : "Mouse capture was refused. Click again.",
      );
    } else if (state.phase === "menu" || state.phase === "playing") {
      lockBroken = true;
      tellBroken();
    }
  }

  function tellBroken(): void {
    if (toldBroken) return;
    toldBroken = true;
    hooks.toast("Mouse capture unavailable · Esc pauses");
  }

  document.addEventListener("pointerlockerror", onLockError);
  document.addEventListener("pointerlockchange", () => {
    if (isLocked()) {
      lockBroken = false;
      lateFailures = 0;
      hintOn.set(false);
      if (state.phase === "paused") resume();
    } else if (state.phase === "playing") {
      pauseGame();
    }
  });

  // Unlocked fallback: pause on Esc / focus loss; clicking the canvas tries to (re)capture.
  window.addEventListener("blur", () => {
    if (state.phase === "playing" && !isLocked()) pauseGame();
  });
  // pointerdown, not mousedown: Babylon cancels canvas pointerdown, which suppresses mousedown.
  canvas.addEventListener("pointerdown", () => {
    if (state.phase === "playing" && lockApi && !isLocked()) requestLock();
  });
  window.addEventListener("keydown", (e) => {
    if (e.repeat) return;
    if (e.key === "Enter") {
      if (state.phase === "menu") {
        e.preventDefault();
        deploy();
      } else if (state.phase === "paused") {
        e.preventDefault();
        tryResume();
      } else if (state.phase === "gameover" && overShown) {
        e.preventDefault();
        location.reload();
      }
    } else if (e.key === "Escape" && state.phase === "playing" && !isLocked()) {
      pauseGame();
    }
  });

  // ------------------------------------------------------------ phase transitions
  function deploy(): void {
    if (state.phase !== "menu") return;
    ctx.audio.unlock();
    requestLock();
    state.phase = "playing";
    hooks.sync();
    events.emit("game:start", {});
  }

  function pauseGame(): void {
    if (state.phase !== "playing") return;
    state.phase = "paused";
    pausedAt = performance.now();
    lateFailures = 0;
    hintOn.set(false);
    hooks.sync();
    events.emit("game:pause", {});
  }

  function resume(): void {
    if (state.phase !== "paused") return;
    state.phase = "playing";
    hintOn.set(false);
    hooks.sync();
    events.emit("game:resume", {});
  }

  function tryResume(): void {
    if (state.phase !== "paused") return;
    ctx.audio.unlock(); // also resumes a context the browser suspended
    if (lockApi && !lockBroken) {
      requestLock(); // resume() runs on pointerlockchange
      return;
    }
    requestLock(); // best effort; works unlocked either way
    resume();
  }

  function showHint(message: string): void {
    hintEl.textContent = message;
    hintOn.set(true);
    pauseInner.animate(
      [
        { transform: "translateX(-8px)" },
        { transform: "translateX(7px)", offset: 0.25 },
        { transform: "translateX(-4px)", offset: 0.5 },
        { transform: "translateX(2px)", offset: 0.75 },
        { transform: "none" },
      ],
      { duration: 320, easing: "ease-out" },
    );
  }

  q(start, ".ss-deploy").addEventListener("click", deploy);
  pause.addEventListener("click", tryResume);
  q(over, ".ss-again").addEventListener("click", () => location.reload());

  // ------------------------------------------------------------ game over
  let result: { score: number; wave: number; kills: number } | null = null;
  let overTimer = 0;
  let overShown = false;

  events.on("game:over", (p) => {
    result = { score: p.score, wave: p.wave, kills: p.kills };
    if (state.phase !== "gameover") state.phase = "gameover";
    try {
      if (document.pointerLockElement && typeof document.exitPointerLock === "function") document.exitPointerLock();
    } catch {
      /* ignore */
    }
    hooks.sync();
  });

  function showGameOver(): void {
    const r = result ?? { score: state.score, wave: state.wave, kills: state.kills };
    let best = 0;
    try {
      best = Number(localStorage.getItem(BEST_KEY)) || 0;
    } catch {
      /* storage unavailable */
    }
    const isNew = r.score > best && r.score > 0;
    if (isNew) {
      try {
        localStorage.setItem(BEST_KEY, String(r.score));
      } catch {
        /* storage unavailable */
      }
    }
    bestEl.textContent = isNew ? "New best score" : best > 0 ? `Best  ${fmt(best)}` : "";
    bestEl.classList.toggle("is-new", isNew);
    overVisible.set(true);
    overShown = true;
    countUp(
      [
        [q(over, ".ss-o-score"), r.score],
        [q(over, ".ss-o-wave"), r.wave],
        [q(over, ".ss-o-kills"), r.kills],
      ],
      400,
      1100,
    );
  }

  return {
    onPhase(phase: Phase): void {
      startVisible.set(phase === "menu");
      pauseVisible.set(phase === "paused");
      if (phase !== "paused") hintOn.set(false);
      if (phase === "gameover" && !overTimer) overTimer = window.setTimeout(showGameOver, GAMEOVER_DELAY_MS);
    },
  };
}

/** Ease-out count-up for the game-over stats. */
function countUp(items: [HTMLElement, number][], delayMs: number, durationMs: number): void {
  for (const [e] of items) e.textContent = "0";
  const t0 = performance.now() + delayMs;
  const step = (now: number): void => {
    const k = clamp((now - t0) / durationMs, 0, 1);
    const e = 1 - Math.pow(1 - k, 3);
    for (const [node, value] of items) node.textContent = fmt(value * e);
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
