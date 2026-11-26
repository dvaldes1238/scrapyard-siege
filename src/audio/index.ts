import type { AudioApi, GameContext, SoundId } from "../core/context";
import { AudioEngine, type PlayOptions } from "./engine";

/**
 * Pure WebAudio synthesis (no files). The module owns all sound triggering:
 * gameplay modules emit events, this subscribes and plays. The only direct
 * caller of play() is explode() in core (so nothing here listens to "explosion").
 *
 * URL params: ?mute=1 silences all output.
 */
export function createAudio(ctx: GameContext): AudioApi {
  const params = new URLSearchParams(location.search);
  const engine = new AudioEngine(ctx.camera, params.get("mute") === "1");

  const api: AudioApi = {
    play(sound: SoundId, opts?: PlayOptions) {
      engine.play(sound, opts);
    },
    unlock() {
      engine.unlock();
    },
  };

  // Browsers may suspend the context (tab switch, Safari interruptions); any gesture brings it back.
  const wake = () => engine.resumeIfSuspended();
  window.addEventListener("pointerdown", wake, true);
  window.addEventListener("keydown", wake, true);

  wireEvents(ctx, api);
  return api;
}

function wireEvents(ctx: GameContext, audio: AudioApi): void {
  const ev = ctx.events;
  const now = () => performance.now() / 1000;

  /** Returns a guard that is true at most once per `interval` seconds. */
  const throttle = (interval: number) => {
    let last = -Infinity;
    return () => {
      const t = now();
      if (t - last < interval) return false;
      last = t;
      return true;
    };
  };

  ev.on("weapon:fire", ({ weapon }) => audio.play(weapon === "launcher" ? "launcher" : "rifle"));
  ev.on("weapon:reload", () => audio.play("reload"));
  ev.on("weapon:switch", () => audio.play("switch"));

  const emptyGate = throttle(0.16);
  ev.on("weapon:empty", () => {
    if (emptyGate()) audio.play("empty");
  });

  const hitGate = throttle(0.035);
  ev.on("hit", ({ kind }) => {
    if ((kind === "enemy" || kind === "barrel") && hitGate()) audio.play("hitmarker");
  });

  // Chained kills climb in pitch (+2 semitones each, up to 6) — multi-kill feedback.
  let streak = 0;
  let lastKill = -Infinity;
  let lastKillSound = -Infinity;
  ev.on("enemy:killed", () => {
    const t = now();
    streak = t - lastKill < 1.2 ? Math.min(streak + 1, 6) : 0;
    lastKill = t;
    if (t - lastKillSound < 0.06) return; // several kills in one blast: one ding
    lastKillSound = t;
    audio.play("kill", { pitch: Math.pow(2, (streak * 2) / 12) });
  });

  ev.on("enemy:fired", ({ position }) => audio.play("enemyShot", { position }));

  const hurtGate = throttle(0.1);
  ev.on("player:damaged", ({ amount }) => {
    if (!hurtGate()) return;
    audio.play("playerHurt", { volume: clamp(0.55 + amount / 40, 0.55, 1) });
  });

  ev.on("player:jump", () => audio.play("jump"));
  ev.on("player:land", ({ impactSpeed }) => {
    if (!(impactSpeed > 1.5)) return;
    const volume = clamp((impactSpeed - 1.5) / 10, 0.12, 1);
    audio.play("land", { volume, pitch: 1 - Math.min(0.15, impactSpeed * 0.01) });
  });
  ev.on("player:footstep", () => audio.play("footstep", { volume: 0.8 + Math.random() * 0.3 }));

  ev.on("wave:start", () => audio.play("waveStart"));
  ev.on("wave:cleared", () => audio.play("waveClear"));
  ev.on("game:over", () => audio.play("gameOver"));
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}
