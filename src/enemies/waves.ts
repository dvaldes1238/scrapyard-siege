import { TransformNode, Vector3, type InstancedMesh } from "@babylonjs/core";
import { markNoHit } from "../core/damage";
import { DRONES, WAVES, waveComposition, type DroneType } from "./config";
import type { EnemySystem } from "./system";

interface Warp {
  type: DroneType;
  position: Vector3;
  t: number;
  spawned: boolean;
  root: TransformNode;
  ringA: InstancedMesh;
  ringB: InstancedMesh;
  core: InstancedMesh;
}

/** How long the warp effect lingers after the drone appears. */
const WARP_TAIL = 0.22;

/**
 * Wave schedule from DESIGN.md: countdown → staggered spawns (each preceded by a 0.6 s warp-in
 * telegraph, max 12 alive, rest queued) → cleared bonus → intermission → next wave.
 */
export class WaveDirector {
  private mode: "idle" | "countdown" | "active" = "idle";
  private timer = 0;
  private queue: DroneType[] = [];
  private spawnTimer = 0;
  private warps: Warp[] = [];
  private lastPoint = -1;
  private warpId = 0;

  constructor(private readonly sys: EnemySystem) {}

  get currentMode(): string {
    return this.mode;
  }

  /** game:start — reset the run and schedule wave 1. */
  start(): void {
    const ctx = this.sys.ctx;
    this.sys.clearAll();
    this.clearWarps();
    ctx.state.score = 0;
    ctx.state.kills = 0;
    ctx.state.wave = 0;
    ctx.events.emit("score:changed", { score: 0, kills: 0 });
    this.queue = [];
    this.mode = "countdown";
    this.timer = WAVES.firstDelay;
  }

  /** game over — stop spawning, drop pending telegraphs (live drones stay for the backdrop). */
  stop(): void {
    this.mode = "idle";
    this.queue = [];
    this.clearWarps();
  }

  /** Debug: end the current wave immediately and start wave n next. */
  skipTo(n: number): void {
    this.sys.clearAll();
    this.clearWarps();
    this.queue = [];
    this.sys.ctx.state.wave = Math.max(0, n - 1);
    this.mode = "countdown";
    this.timer = 0.5;
  }

  update(dt: number): void {
    this.updateWarps(dt);
    if (this.mode === "countdown") {
      this.timer -= dt;
      if (this.timer <= 0) this.beginWave(this.sys.ctx.state.wave + 1);
    } else if (this.mode === "active") {
      this.spawnTimer -= dt;
      let pending = 0;
      for (const w of this.warps) if (!w.spawned) pending++;
      if (this.queue.length && this.spawnTimer <= 0 && this.sys.drones.size + pending < WAVES.maxAlive) {
        this.startWarp(this.queue.shift()!);
        this.spawnTimer = WAVES.spawnInterval;
        pending++;
      }
      if (!this.queue.length && pending === 0 && this.sys.drones.size === 0) this.waveCleared();
    }
  }

  private beginWave(n: number): void {
    const ctx = this.sys.ctx;
    ctx.state.wave = n;
    this.queue = buildQueue(n);
    this.spawnTimer = 0;
    this.mode = "active";
    ctx.events.emit("wave:start", { wave: n, enemies: this.queue.length });
  }

  private waveCleared(): void {
    const ctx = this.sys.ctx;
    const n = ctx.state.wave;
    const bonus = WAVES.clearBonusPerWave * n;
    ctx.state.score += bonus;
    ctx.events.emit("wave:cleared", { wave: n, bonus });
    ctx.events.emit("score:changed", { score: ctx.state.score, kills: ctx.state.kills });
    this.mode = "countdown";
    this.timer = WAVES.intermission;
  }

  // -------------------------------------------------------------------------------------------
  // Spawn points
  // -------------------------------------------------------------------------------------------

  private pickSpawn(type: DroneType): Vector3 {
    const ctx = this.sys.ctx;
    const pts = ctx.world.enemySpawnPoints;
    const feet = ctx.player.getFeetPosition();
    const b = ctx.world.bounds;
    const baseY = this.sys.baseY;
    const hdist = (p: Vector3) => Math.hypot(p.x - feet.x, p.z - feet.z);

    const base = new Vector3();
    if (pts.length) {
      let choices: number[] = [];
      for (let i = 0; i < pts.length; i++) if (hdist(pts[i]) >= WAVES.minSpawnDistance) choices.push(i);
      if (!choices.length) {
        let best = 0;
        for (let i = 1; i < pts.length; i++) if (hdist(pts[i]) > hdist(pts[best])) best = i;
        choices = [best];
      }
      if (choices.length > 1) choices = choices.filter((i) => i !== this.lastPoint);
      const idx = choices[Math.floor(Math.random() * choices.length)];
      this.lastPoint = idx;
      base.copyFrom(pts[idx]);
    } else {
      // Fallback: a random point along the arena edge, away from the player.
      const side = Math.floor(Math.random() * 4);
      const u = Math.random();
      base.set(
        side === 0 ? b.minX + 3 : side === 1 ? b.maxX - 3 : b.minX + (b.maxX - b.minX) * u,
        baseY + 7,
        side === 2 ? b.minZ + 3 : side === 3 ? b.maxZ - 3 : b.minZ + (b.maxZ - b.minZ) * u,
      );
    }

    const r = DRONES[type].hitRadius;
    const inset = 2 + r;
    const pos = new Vector3();
    for (let attempt = 0; attempt < 5; attempt++) {
      const j = WAVES.spawnJitter * (1 + attempt * 0.4);
      pos.set(base.x + (Math.random() * 2 - 1) * j, base.y + (Math.random() * 2 - 1), base.z + (Math.random() * 2 - 1) * j);
      pos.x = Math.min(b.maxX - inset, Math.max(b.minX + inset, pos.x));
      pos.z = Math.min(b.maxZ - inset, Math.max(b.minZ + inset, pos.z));
      pos.y = Math.min(baseY + 11, Math.max(baseY + 3 + r, pos.y));
      // Don't stack on another telegraph or drone.
      let clear = true;
      for (const w of this.warps) if (Vector3.DistanceSquared(w.position, pos) < 9) clear = false;
      for (const d of this.sys.drones) if (Vector3.DistanceSquared(d.position, pos) < 9) clear = false;
      if (clear) break;
    }
    return pos;
  }

  // -------------------------------------------------------------------------------------------
  // Warp-in telegraph
  // -------------------------------------------------------------------------------------------

  private startWarp(type: DroneType): void {
    const scene = this.sys.ctx.scene;
    const assets = this.sys.assets;
    const id = ++this.warpId;
    const position = this.pickSpawn(type);
    const root = new TransformNode(`enemy-warp-${id}`, scene);
    root.position.copyFrom(position);
    const ringA = assets.warpRing[type].createInstance(`enemy-warp-ringA-${id}`);
    const ringB = assets.warpRing[type].createInstance(`enemy-warp-ringB-${id}`);
    const core = assets.warpCore[type].createInstance(`enemy-warp-core-${id}`);
    for (const m of [ringA, ringB, core]) {
      m.parent = root;
      markNoHit(m);
      m.scaling.setAll(0.01);
    }
    ringB.rotation.x = Math.PI / 2;
    this.warps.push({ type, position, t: 0, spawned: false, root, ringA, ringB, core });
  }

  private updateWarps(dt: number): void {
    const T = WAVES.telegraphTime;
    for (let i = this.warps.length - 1; i >= 0; i--) {
      const w = this.warps[i];
      w.t += dt;
      const size = DRONES[w.type].scale;
      if (w.t < T) {
        const k = w.t / T;
        const e = 1 - (1 - k) * (1 - k) * (1 - k);
        w.ringA.scaling.setAll((0.3 + 2.4 * e) * size);
        w.ringA.rotation.y += dt * 2;
        w.ringB.scaling.setAll((1.8 - 1.2 * e) * size);
        w.ringB.rotation.y += dt * (6 + 14 * k);
        w.core.scaling.setAll((0.08 + 0.55 * k * k) * size * (0.85 + Math.random() * 0.3));
        continue;
      }
      if (!w.spawned) {
        w.spawned = true;
        this.sys.spawnDrone(w.type, w.position);
      }
      const k = Math.min(1, (w.t - T) / WARP_TAIL);
      const fade = 1 - k;
      w.ringA.scaling.setAll((2.7 + 1.5 * k) * size * fade);
      w.ringB.scaling.setAll(0.6 * size * fade);
      w.core.scaling.setAll((0.63 + 1.4 * k) * size * fade);
      if (k >= 1) {
        w.root.dispose(false, false);
        this.warps.splice(i, 1);
      }
    }
  }

  private clearWarps(): void {
    for (const w of this.warps) w.root.dispose(false, false);
    this.warps = [];
  }
}

/** Spawn order: open with seekers, sprinkle bombers in, brutes a few spawns in. */
function buildQueue(n: number): DroneType[] {
  const c = waveComposition(n);
  const q: DroneType[] = new Array<DroneType>(c.seekers).fill("seeker");
  for (let i = 0; i < c.bombers; i++) {
    const at = 2 + Math.floor(Math.random() * Math.max(1, q.length - 1));
    q.splice(Math.min(at, q.length), 0, "bomber");
  }
  for (let i = 0; i < c.brutes; i++) {
    const at = 3 + i * 4 + Math.floor(Math.random() * 3);
    q.splice(Math.min(at, q.length), 0, "brute");
  }
  return q;
}
