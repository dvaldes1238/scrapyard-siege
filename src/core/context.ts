import type {
  AbstractEngine,
  AbstractMesh,
  Color3,
  GlowLayer,
  HavokPlugin,
  PhysicsBody,
  Scene,
  UniversalCamera,
  Vector3,
} from "@babylonjs/core";
import type { Damageable } from "./damage";
import type { EventBus, GameEvents, HitKind } from "./events";

export type Phase = "menu" | "playing" | "paused" | "gameover";

export interface GameState {
  phase: Phase;
  score: number;
  kills: number;
  wave: number;
}

/** Owned by src/world. */
export interface WorldApi {
  /** Feet position where the player starts. */
  readonly playerSpawn: Vector3;
  /** Points in the air (y 5-10) near the arena edges where drones appear. */
  readonly enemySpawnPoints: Vector3[];
  /** Walkable area inside the perimeter walls. */
  readonly bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  /** Sun shadow casting. Call for anything created after world init (drones, debris, grenades). */
  addShadowCaster(mesh: AbstractMesh, includeDescendants?: boolean): void;
  removeShadowCaster(mesh: AbstractMesh): void;
  /** Glow layer: emissive materials glow. Use addExcludedMesh / intensity as needed. */
  readonly glowLayer: GlowLayer;
}

/** Owned by src/fx. All effects are fire-and-forget and clean themselves up. */
export interface FxApi {
  /** Fireball + smoke + sparks + brief point light. scale 1 = ~5 m radius blast. */
  explosion(position: Vector3, scale?: number): void;
  /** Bullet impact: sparks on metal/enemies, dust puff on world/props. */
  impact(position: Vector3, normal: Vector3, kind: HitKind): void;
  /** Fast-fading bright line from muzzle to hit point. */
  tracer(from: Vector3, to: Vector3): void;
  /**
   * Physical debris: small dynamic boxes thrown outward that fade and dispose
   * after a few seconds (drone deaths, barrel explosions).
   */
  shatter(position: Vector3, opts?: { color?: Color3; count?: number; size?: number; force?: number }): void;
}

export type SoundId =
  | "rifle"
  | "launcher"
  | "explosion"
  | "reload"
  | "empty"
  | "switch"
  | "hitmarker"
  | "kill"
  | "enemyShot"
  | "enemyHum"
  | "playerHurt"
  | "jump"
  | "land"
  | "footstep"
  | "waveStart"
  | "waveClear"
  | "gameOver";

/** Owned by src/audio. Sounds are synthesized with WebAudio (no audio files). */
export interface AudioApi {
  /** position: world-space source, panned/attenuated relative to ctx.camera. */
  play(sound: SoundId, opts?: { position?: Vector3; volume?: number; pitch?: number }): void;
  /** Must be called from a user gesture (start click) to unlock WebAudio. */
  unlock(): void;
}

/** Owned by src/player. */
export interface PlayerApi {
  readonly health: number;
  readonly maxHealth: number;
  readonly alive: boolean;
  /** Capsule radius and height (metres), for projectile hit checks. */
  readonly radius: number;
  readonly height: number;
  getEyePosition(): Vector3;
  getFeetPosition(): Vector3;
  getVelocity(): Vector3;
  takeDamage(amount: number, from?: Vector3): void;
  /** Velocity change in m/s added to the player (explosion knockback). */
  applyKnockback(deltaVelocity: Vector3): void;
}

export interface GameContext {
  engine: AbstractEngine;
  scene: Scene;
  canvas: HTMLCanvasElement;
  /** Full-screen overlay div (pointer-events: none) for HUD and menus. */
  uiRoot: HTMLElement;
  havok: HavokPlugin;
  /** The one camera. Created in main.ts with no inputs; src/player drives it. */
  camera: UniversalCamera;
  events: EventBus<GameEvents>;
  state: GameState;

  /** Set during boot, in this order: audio, fx, world, player. */
  audio: AudioApi;
  fx: FxApi;
  world: WorldApi;
  player: PlayerApi;

  /** Gameplay tick, called before each render only while phase === "playing". dt in seconds (clamped). */
  onUpdate(fn: (dt: number) => void): () => void;
  /** Called before every render regardless of phase (cosmetic animation). */
  onFrame(fn: (dt: number) => void): () => void;

  /** Everything that can be shot or blown up. Add on create, delete on death/dispose. */
  damageables: Set<Damageable>;
  /** Dynamic physics bodies that explosions should push. Add on create, delete on dispose. */
  dynamicBodies: Set<PhysicsBody>;
}
