import type { GameContext } from "../core/context";
import { LOOK } from "./config";

const TRACKED_KEYS = new Set([
  "KeyW",
  "KeyA",
  "KeyS",
  "KeyD",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "ShiftLeft",
  "ShiftRight",
  "Space",
  "KeyR",
]);

/**
 * Raw input for the player: keys, mouse buttons, pointer-lock mouse look.
 * Pointer lock itself is owned by the UI module; we only read it.
 */
export class PlayerInput {
  /** False once the player is dead: all queries return "nothing pressed". */
  enabled = true;

  private keys = new Set<string>();
  private fire = false;
  private launcherQueued = false;
  private jumpQueued = false;
  private reloadQueued = false;
  private dx = 0;
  private dy = 0;
  private fireGateUntil = 0;
  private lookGateUntil = 0;
  private readonly disposers: Array<() => void> = [];

  constructor(private readonly ctx: GameContext) {
    const canvas = ctx.canvas;
    const on = <E extends Event>(target: EventTarget, type: string, fn: (e: E) => void): void => {
      const listener = fn as unknown as EventListener;
      target.addEventListener(type, listener);
      this.disposers.push(() => target.removeEventListener(type, listener));
    };

    on<KeyboardEvent>(window, "keydown", (e) => {
      if (!TRACKED_KEYS.has(e.code)) return;
      const playing = this.canAct();
      if (playing && (e.code === "Space" || e.code.startsWith("Arrow"))) e.preventDefault();
      this.keys.add(e.code);
      if (e.repeat || !playing) return;
      if (e.code === "Space") this.jumpQueued = true;
      if (e.code === "KeyR") this.reloadQueued = true;
    });
    on<KeyboardEvent>(window, "keyup", (e) => {
      this.keys.delete(e.code);
    });

    // Use pointer events only. Babylon calls preventDefault() on canvas pointerdown,
    // which makes the browser suppress the compatibility mousedown/mousemove/mouseup
    // events while a button is held — so mouse events never reach us.
    // A second button pressed while another is held (RMB during LMB auto-fire)
    // arrives as a pointermove with a new `buttons` mask, so diff the mask on every
    // pointer event instead of relying on `button`.
    const onButtons = (e: PointerEvent): void => this.applyButtons(e);
    on<PointerEvent>(document, "pointerdown", onButtons);
    on<PointerEvent>(window, "pointerup", onButtons);
    on(window, "pointercancel", () => this.releaseButtons());

    on<PointerEvent>(document, "pointermove", (e) => {
      if (e.buttons !== this.prevButtons) this.applyButtons(e);
      if (!this.isLocked() || this.ctx.state.phase !== "playing") return;
      if (performance.now() < this.lookGateUntil) return;
      const mx = e.movementX || 0;
      const my = e.movementY || 0;
      if (Math.abs(mx) > LOOK.spikeFilterPx || Math.abs(my) > LOOK.spikeFilterPx) return;
      this.dx += mx;
      this.dy += my;
    });

    on<MouseEvent>(canvas, "contextmenu", (e) => e.preventDefault());
    on<MouseEvent>(document, "contextmenu", (e) => {
      if (this.isLocked()) e.preventDefault();
    });
    on(window, "blur", () => this.releaseAll());
    on(document, "visibilitychange", () => {
      if (document.hidden) this.releaseAll();
    });
    on(document, "pointerlockchange", () => {
      if (!this.isLocked()) this.releaseButtons();
    });

    this.disposers.push(ctx.events.on("game:pause", () => this.releaseAll()));
    const gate = (): void => {
      // Keep the real button mask: the deploy/resume click may still be held, and forgetting
      // that would let the next pointermove count it as a fresh press once the gate expires.
      const held = this.prevButtons;
      this.releaseAll();
      this.prevButtons = held;
      const now = performance.now();
      this.fireGateUntil = now + LOOK.fireGateMs;
      this.lookGateUntil = now + LOOK.lookGateMs;
    };
    this.disposers.push(ctx.events.on("game:start", gate));
    this.disposers.push(ctx.events.on("game:resume", gate));
  }

  private isLocked(): boolean {
    return document.pointerLockElement === this.ctx.canvas;
  }

  private canAct(): boolean {
    return this.enabled && this.ctx.state.phase === "playing";
  }

  private canFire(e: MouseEvent): boolean {
    if (!this.canAct()) return false;
    if (performance.now() < this.fireGateUntil) return false;
    return this.isLocked() || e.target === this.ctx.canvas;
  }

  /** Bitmask of mouse buttons seen on the last pointer event (1 = left, 2 = right). */
  private prevButtons = 0;

  private applyButtons(e: PointerEvent): void {
    if (e.pointerType === "touch") return;
    const buttons = e.buttons;
    const pressed = buttons & ~this.prevButtons;
    this.prevButtons = buttons;
    if (!(buttons & 1)) this.fire = false;
    if (pressed && this.canFire(e)) {
      // macOS: Ctrl+click is the system right-click (one-button trackpads/mice) → launcher.
      if (pressed & 1 && e.ctrlKey) {
        this.launcherQueued = true;
        return;
      }
      if (pressed & 1) {
        this.fire = true;
        // Latch the press: trackpad tap-to-click sends down+up within one frame.
        this.fireTap = true;
      }
      if (pressed & 2) this.launcherQueued = true;
    }
  }

  private releaseButtons(): void {
    this.prevButtons = 0;
    this.fire = false;
    this.fireTap = false;
    this.launcherQueued = false;
  }

  /** Drop every held key/button and pending edge (pause, blur, death). */
  releaseAll(): void {
    this.keys.clear();
    this.releaseButtons();
    this.jumpQueued = false;
    this.reloadQueued = false;
    this.dx = 0;
    this.dy = 0;
  }

  private down(code: string): boolean {
    return this.keys.has(code);
  }

  /** Forward axis (-1..1), W/S. */
  get forward(): number {
    if (!this.canAct()) return 0;
    return (this.down("KeyW") || this.down("ArrowUp") ? 1 : 0) - (this.down("KeyS") || this.down("ArrowDown") ? 1 : 0);
  }

  /** Strafe axis (-1..1), D/A. */
  get strafe(): number {
    if (!this.canAct()) return 0;
    return (this.down("KeyD") || this.down("ArrowRight") ? 1 : 0) - (this.down("KeyA") || this.down("ArrowLeft") ? 1 : 0);
  }

  get sprint(): boolean {
    return this.canAct() && (this.down("ShiftLeft") || this.down("ShiftRight"));
  }

  get fireHeld(): boolean {
    return this.canAct() && this.fire;
  }

  private fireTap = false;

  /** True once per left-button press, even if it was released before this frame. */
  consumeFireTap(): boolean {
    const v = this.fireTap && this.canAct();
    this.fireTap = false;
    return v;
  }

  /** Pixels of mouse movement since the last call. */
  consumeLook(out: { x: number; y: number }): void {
    out.x = this.canAct() ? this.dx : 0;
    out.y = this.canAct() ? this.dy : 0;
    this.dx = 0;
    this.dy = 0;
  }

  consumeJump(): boolean {
    const v = this.jumpQueued && this.canAct();
    this.jumpQueued = false;
    return v;
  }

  consumeReload(): boolean {
    const v = this.reloadQueued && this.canAct();
    this.reloadQueued = false;
    return v;
  }

  consumeLauncher(): boolean {
    const v = this.launcherQueued && this.canAct();
    this.launcherQueued = false;
    return v;
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers.length = 0;
  }
}
