/** Tiny DOM helpers for the UI module. */

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  parent?: HTMLElement,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}

/** querySelector that throws if the element is missing (markup is static, so this is a bug guard). */
export function q<T extends HTMLElement = HTMLElement>(root: ParentNode, selector: string): T {
  const e = root.querySelector<T>(selector);
  if (!e) throw new Error(`[ui] missing ${selector}`);
  return e;
}

/** Text node that only touches the DOM when the value actually changes. */
export class Txt {
  private last: string;
  constructor(readonly el: HTMLElement) {
    this.last = el.textContent ?? "";
  }
  set(value: string): boolean {
    if (value === this.last) return false;
    this.last = value;
    this.el.textContent = value;
    return true;
  }
}

/** Toggle a class only when the state changes. */
export class Flag {
  private on = false;
  constructor(
    private readonly el: Element,
    private readonly cls: string,
  ) {
    this.on = el.classList.contains(cls);
  }
  set(on: boolean): void {
    if (on === this.on) return;
    this.on = on;
    this.el.classList.toggle(this.cls, on);
  }
}

export const fmt = (n: number): string => Math.round(n).toLocaleString("en-US");

export const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
