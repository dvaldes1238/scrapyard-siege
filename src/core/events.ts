import type { Vector3 } from "@babylonjs/core";

export type WeaponId = "rifle" | "launcher";
/** What a player shot (or explosion) touched. */
export type HitKind = "enemy" | "barrel" | "prop" | "world";

/**
 * Every cross-module event in the game. Payload positions are world-space and
 * may be reused by the emitter afterwards: clone them if you keep them.
 */
export interface GameEvents {
  /** Start screen clicked, pointer locked, gameplay begins (phase -> "playing"). */
  "game:start": {};
  /** Pointer lock lost while playing (phase -> "paused"). */
  "game:pause": {};
  /** Pointer lock regained (phase -> "playing"). */
  "game:resume": {};
  /** Player died (phase -> "gameover"). */
  "game:over": { score: number; wave: number; kills: number };

  "weapon:fire": { weapon: WeaponId };
  "weapon:switch": { weapon: WeaponId };
  "weapon:reload": { weapon: WeaponId };
  /** Trigger pulled with an empty magazine / no launcher charges. */
  "weapon:empty": { weapon: WeaponId };
  "ammo:changed": { ammo: number; magSize: number; reloading: boolean };
  "launcher:changed": { charges: number; maxCharges: number; rechargeProgress: number };

  /** A player shot or grenade landed on something. */
  "hit": { kind: HitKind; point: Vector3; killed: boolean };
  "explosion": { position: Vector3; radius: number };

  "player:damaged": { amount: number; health: number; maxHealth: number; from?: Vector3 };
  "player:healed": { health: number; maxHealth: number };
  "player:died": {};
  "player:jump": {};
  "player:land": { impactSpeed: number };
  "player:footstep": {};

  "enemy:spawned": { position: Vector3 };
  "enemy:fired": { position: Vector3 };
  "enemy:killed": { position: Vector3; points: number };

  "wave:start": { wave: number; enemies: number };
  "wave:cleared": { wave: number; bonus: number };
  "score:changed": { score: number; kills: number };
}

type Handler<T> = (payload: T) => void;

export class EventBus<E extends object = GameEvents> {
  private handlers = new Map<keyof E, Set<Handler<any>>>();

  /** Subscribe. Returns an unsubscribe function. */
  on<K extends keyof E>(name: K, fn: Handler<E[K]>): () => void {
    let set = this.handlers.get(name);
    if (!set) {
      set = new Set();
      this.handlers.set(name, set);
    }
    set.add(fn);
    return () => set!.delete(fn);
  }

  emit<K extends keyof E>(name: K, payload: E[K]): void {
    const set = this.handlers.get(name);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[events] handler for "${String(name)}" threw`, err);
      }
    }
  }
}
