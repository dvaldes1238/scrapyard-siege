// Minimal browser globals so src/ modules run under Node: no real DOM, no GPU.
// Import this before any src/ module (headless.ts does it first): some modules read
// `location.search` while they load.

type Listener = (ev: any) => void;
const listeners = new Map<string, Listener[]>();

function eventTarget(name: string) {
  return {
    addEventListener(type: string, fn: Listener) {
      const key = `${name}:${type}`;
      if (!listeners.has(key)) listeners.set(key, []);
      listeners.get(key)!.push(fn);
    },
    removeEventListener(type: string, fn: Listener) {
      const list = listeners.get(`${name}:${type}`);
      const i = list?.indexOf(fn) ?? -1;
      if (list && i >= 0) list.splice(i, 1);
    },
  };
}

/** 2D context stub: every method is a no-op, image data comes back zeroed. */
function context2d(canvas: object): any {
  const known: Record<string, unknown> = {
    canvas,
    getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    putImageData: () => {},
    measureText: () => ({ width: 10 }),
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
  };
  return new Proxy(known, {
    get: (t, k: string) => (k in t ? t[k] : () => {}),
    set: (t, k: string, v) => ((t[k] = v), true),
  });
}

export function fakeCanvas(name = "el"): any {
  const c: any = { width: 1, height: 1, clientWidth: 1024, clientHeight: 768, style: {}, toDataURL: () => "", ...eventTarget(name) };
  c.getContext = () => context2d(c);
  return c;
}

/** The game canvas (`ctx.canvas`). */
export const canvas = fakeCanvas("canvas");

const g = globalThis as any;
Object.assign(g, eventTarget("window"));
g.window = g;
g.document = {
  ...eventTarget("document"),
  createElement: () => fakeCanvas(),
  pointerLockElement: null,
  hidden: false,
};
g.location = { search: process.env.QS ?? "" };
g.OffscreenCanvas = class {
  width: number;
  height: number;
  constructor(w: number, h: number) {
    this.width = w;
    this.height = h;
  }
  getContext() {
    return context2d(this);
  }
};

/** Call the listeners registered on one target, as a browser event would. */
export function dispatch(target: "window" | "document" | "canvas", type: string, init: object = {}): void {
  const ev = { type, target: canvas, repeat: false, preventDefault() {}, stopImmediatePropagation() {}, ...init };
  for (const fn of [...(listeners.get(`${target}:${type}`) ?? [])]) fn(ev);
}

/** A pointer event on the canvas, bubbling canvas → document → window like the real thing. */
export function pointer(type: "pointerdown" | "pointermove" | "pointerup", init: { buttons: number; button?: number; movementX?: number; movementY?: number; ctrlKey?: boolean }): void {
  const ev = { pointerType: "mouse", button: 0, movementX: 0, movementY: 0, ctrlKey: false, ...init };
  for (const target of ["canvas", "document", "window"] as const) dispatch(target, type, ev);
}

/** A key event on the window (where the player listens). */
export function key(type: "keydown" | "keyup", code: string): void {
  dispatch("window", type, { code, key: code });
}

/** Pretend the canvas holds (or lost) pointer lock. */
export function setPointerLock(locked: boolean): void {
  g.document.pointerLockElement = locked ? canvas : null;
}
