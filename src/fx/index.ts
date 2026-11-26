import {
  Color3,
  Constants,
  Mesh,
  ParticleSystem,
  PhysicsRaycastResult,
  PointLight,
  PointParticleEmitter,
  Quaternion,
  SphereParticleEmitter,
  StandardMaterial,
  TransformNode,
  Vector3,
  VertexData,
  type Texture,
} from "@babylonjs/core";
import type { FxApi, GameContext } from "../core/context";
import { markNoHit } from "../core/damage";
import type { HitKind } from "../core/events";
import { EXPLOSION, FX_COLORS as C, IMPACT, POOLS, TRACER } from "./config";
import { createDebris } from "./debris";
import { getFxTextures } from "./textures";

/**
 * Pooled visual effects (tuning in ./config.ts). Particle systems are created once and reused
 * round-robin: each burst moves a pooled system's emitter, sets its per-burst parameters and
 * uses manualEmitCount. Tracers and shock rings are pooled meshes; explosions share a single
 * PointLight.
 */

const STEP = 1 / 60; // updateSpeed for "seconds" lifetimes and m/s velocities
const FAR = new Vector3(0, -1000, 0);
const GRAVITY = new Vector3(0, -9.81, 0);

type Range = [number, number];

class RoundRobin<T> {
  private i = 0;
  constructor(readonly items: T[]) {}
  next(): T {
    const it = this.items[this.i];
    this.i = (this.i + 1) % this.items.length;
    return it;
  }
}

interface Burst {
  ps: ParticleSystem;
  at: Vector3;
}

function makePS(ctx: GameContext, name: string, capacity: number, texture: Texture, blend: number): Burst {
  const ps = new ParticleSystem(name, capacity, ctx.scene);
  const at = FAR.clone();
  ps.emitter = at;
  ps.particleTexture = texture;
  ps.blendMode = blend;
  ps.emitRate = 0;
  ps.manualEmitCount = 1; // one invisible warm-up particle far below the map compiles the shader
  ps.updateSpeed = STEP;
  ps.minLifeTime = 0.05;
  ps.maxLifeTime = 0.05;
  ps.start();
  return { ps, at };
}

function setPoint(ps: ParticleSystem, n: Vector3, along: number, spread: number): void {
  const e = ps.particleEmitterType as PointParticleEmitter;
  e.direction1.set(n.x * along - spread, n.y * along - spread, n.z * along - spread);
  e.direction2.set(n.x * along + spread, n.y * along + spread, n.z * along + spread);
}

function setScale(ps: ParticleSystem, s: number, jitter = 0.15): void {
  ps.minScaleX = ps.minScaleY = s * (1 - jitter);
  ps.maxScaleX = ps.maxScaleY = s * (1 + jitter);
}

function setLife(ps: ParticleSystem, r: Range): void {
  ps.minLifeTime = r[0];
  ps.maxLifeTime = r[1];
}

function setPower(ps: ParticleSystem, r: Range, k = 1): void {
  ps.minEmitPower = r[0] * k;
  ps.maxEmitPower = r[1] * k;
}

function setSize(ps: ParticleSystem, r: Range): void {
  ps.minSize = r[0];
  ps.maxSize = r[1];
}

const countFor = (c: Range, s: number) => Math.round(c[0] + c[1] * s);

/** Two crossed quads along +Z (0..1), u along the length. Visible from any side. */
function tracerMesh(ctx: GameContext): Mesh {
  const m = new Mesh("tracerSrc", ctx.scene);
  const vd = new VertexData();
  vd.positions = [-0.5, 0, 0, 0.5, 0, 0, 0.5, 0, 1, -0.5, 0, 1, 0, -0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1];
  vd.normals = [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0];
  vd.uvs = [0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 1, 0];
  vd.indices = [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7];
  vd.applyToMesh(m);
  return m;
}

function unlitAdditive(ctx: GameContext, name: string, color: Color3, opacity: Texture): StandardMaterial {
  const m = new StandardMaterial(name, ctx.scene);
  m.disableLighting = true;
  m.diffuseColor = Color3.Black();
  m.specularColor = Color3.Black();
  m.emissiveColor = color.clone();
  m.opacityTexture = opacity;
  m.alphaMode = Constants.ALPHA_ADD;
  m.backFaceCulling = false;
  m.disableDepthWrite = true;
  m.fogEnabled = false;
  return m;
}

export function createFx(ctx: GameContext): FxApi {
  const { scene } = ctx;
  const tex = getFxTextures(scene);
  const debris = createDebris(ctx, tex);
  const tmp = new Vector3();
  const up = new Vector3(0, 1, 0);

  // ---------------------------------------------------------------------------------------------
  // Impact pools.
  const I = IMPACT;
  const sparks = new RoundRobin(
    Array.from({ length: POOLS.impact }, (_, i) => {
      const b = makePS(ctx, `impSparks${i}`, I.sparks.capacity, tex.dot, ParticleSystem.BLENDMODE_ADD);
      const ps = b.ps;
      ps.createPointEmitter(new Vector3(-1, 0, -1), new Vector3(1, 1, 1));
      ps.billboardMode = ParticleSystem.BILLBOARDMODE_STRETCHED;
      setSize(ps, I.sparks.size);
      ps.minScaleX = ps.maxScaleX = 1;
      [ps.minScaleY, ps.maxScaleY] = I.sparks.stretch;
      ps.gravity = GRAVITY.clone();
      return b;
    }),
  );
  const flashes = new RoundRobin(
    Array.from({ length: POOLS.impact }, (_, i) => {
      const b = makePS(ctx, `impFlash${i}`, 4, tex.flare, ParticleSystem.BLENDMODE_ADD);
      b.ps.createPointEmitter(Vector3.Zero(), Vector3.Zero());
      b.ps.minEmitPower = b.ps.maxEmitPower = 0;
      b.ps.minInitialRotation = 0;
      b.ps.maxInitialRotation = Math.PI;
      return b;
    }),
  );
  const dusts = new RoundRobin(
    Array.from({ length: POOLS.impact }, (_, i) => {
      const b = makePS(ctx, `impDust${i}`, I.dust.capacity, tex.smoke, ParticleSystem.BLENDMODE_STANDARD);
      const ps = b.ps;
      ps.createPointEmitter(Vector3.Zero(), Vector3.One());
      for (const [t, f] of I.dust.sizes) ps.addSizeGradient(t, f);
      ps.addDragGradient(0, 0.2);
      ps.addDragGradient(1, 0.9);
      ps.minInitialRotation = 0;
      ps.maxInitialRotation = Math.PI * 2;
      ps.minAngularSpeed = -1.5;
      ps.maxAngularSpeed = 1.5;
      ps.gravity = new Vector3(0, I.dust.gravity, 0);
      ps.applyFog = true;
      return b;
    }),
  );
  const chips = new RoundRobin(
    Array.from({ length: POOLS.impact }, (_, i) => {
      const b = makePS(ctx, `impChips${i}`, I.chips.capacity, tex.chip, ParticleSystem.BLENDMODE_STANDARD);
      const ps = b.ps;
      ps.createPointEmitter(Vector3.Zero(), Vector3.One());
      setSize(ps, I.chips.size);
      ps.minInitialRotation = 0;
      ps.maxInitialRotation = Math.PI * 2;
      ps.minAngularSpeed = -I.chips.spin;
      ps.maxAngularSpeed = I.chips.spin;
      ps.gravity = GRAVITY.clone();
      return b;
    }),
  );

  // ---------------------------------------------------------------------------------------------
  // Explosion kits.
  const E = EXPLOSION;
  interface Kit {
    smoke: Burst;
    fire: Burst;
    sparks: Burst;
    chunks: Burst;
    flash: Burst;
  }
  const kits = new RoundRobin<Kit>(
    Array.from({ length: POOLS.explosionKits }, (_, i) => {
      // Creation order = draw order: smoke first so additive fire draws over it.
      const smoke = makePS(ctx, `exSmoke${i}`, E.smoke.capacity, tex.smoke, ParticleSystem.BLENDMODE_STANDARD);
      smoke.ps.createSphereEmitter(1, 1);
      for (const [t, f] of E.smoke.sizes) smoke.ps.addSizeGradient(t, f);
      for (const [t, c] of C.smoke) smoke.ps.addColorGradient(t, c);
      smoke.ps.addDragGradient(0, 0.3);
      smoke.ps.addDragGradient(1, 0.95);
      smoke.ps.gravity = Vector3.FromArray(E.smoke.drift);
      smoke.ps.minInitialRotation = 0;
      smoke.ps.maxInitialRotation = Math.PI * 2;
      smoke.ps.minAngularSpeed = -0.5;
      smoke.ps.maxAngularSpeed = 0.5;
      smoke.ps.applyFog = true;

      const chunks = makePS(ctx, `exChunks${i}`, E.chunks.capacity, tex.chip, ParticleSystem.BLENDMODE_STANDARD);
      chunks.ps.createSphereEmitter(0.4, 1);
      setSize(chunks.ps, E.chunks.size);
      chunks.ps.gravity = GRAVITY.clone();
      chunks.ps.minAngularSpeed = -10;
      chunks.ps.maxAngularSpeed = 10;
      chunks.ps.color1 = C.chunk1;
      chunks.ps.color2 = C.chunk2;
      chunks.ps.colorDead = C.chunkDead;

      const fire = makePS(ctx, `exFire${i}`, E.fire.capacity, tex.fire, ParticleSystem.BLENDMODE_ADD);
      fire.ps.createSphereEmitter(0.6, 1);
      for (const [t, f] of E.fire.sizes) fire.ps.addSizeGradient(t, f);
      for (const [t, c] of C.fire) fire.ps.addColorGradient(t, c);
      fire.ps.addDragGradient(0, 0.5);
      fire.ps.addDragGradient(1, 0.95);
      fire.ps.gravity = new Vector3(0, E.fire.rise, 0);
      fire.ps.minInitialRotation = 0;
      fire.ps.maxInitialRotation = Math.PI * 2;
      fire.ps.minAngularSpeed = -2;
      fire.ps.maxAngularSpeed = 2;

      const sp = makePS(ctx, `exSparks${i}`, E.sparks.capacity, tex.dot, ParticleSystem.BLENDMODE_ADD);
      sp.ps.createSphereEmitter(0.3, 1);
      sp.ps.billboardMode = ParticleSystem.BILLBOARDMODE_STRETCHED;
      setSize(sp.ps, E.sparks.size);
      sp.ps.minScaleX = sp.ps.maxScaleX = 1;
      [sp.ps.minScaleY, sp.ps.maxScaleY] = E.sparks.stretch;
      sp.ps.gravity = GRAVITY.clone();
      sp.ps.color1 = C.blastSpark1;
      sp.ps.color2 = C.blastSpark2;
      sp.ps.colorDead = C.blastSparkDead;

      const flash = makePS(ctx, `exFlash${i}`, 2, tex.flare, ParticleSystem.BLENDMODE_ADD);
      flash.ps.createPointEmitter(Vector3.Zero(), Vector3.Zero());
      flash.ps.minEmitPower = flash.ps.maxEmitPower = 0;
      setSize(flash.ps, E.flash.size);
      flash.ps.color1 = C.blastFlash1;
      flash.ps.color2 = C.blastFlash2;
      flash.ps.colorDead = C.blastFlashDead;
      flash.ps.minInitialRotation = 0;
      flash.ps.maxInitialRotation = Math.PI;
      return { smoke, fire, sparks: sp, chunks, flash };
    }),
  );

  // ---------------------------------------------------------------------------------------------
  // Shared explosion light (no per-explosion lights).
  const light = new PointLight("fxFlashLight", FAR.clone(), scene);
  light.diffuse = E.light.color.clone();
  light.specular = E.light.specular.clone();
  light.intensity = 0;
  light.range = E.light.range;
  let lightPeak = 0;
  let lightAge = E.light.life;

  // ---------------------------------------------------------------------------------------------
  // Shock rings and tracers: pooled meshes with shared unlit additive materials.
  const ringMat = unlitAdditive(ctx, "fxRingMat", E.ring.color, tex.ring);
  interface Ring {
    mesh: Mesh;
    age: number;
    life: number;
    maxScale: number;
    active: boolean;
  }
  const rings = new RoundRobin<Ring>(
    Array.from({ length: POOLS.rings }, (_, i) => {
      const mesh = new Mesh(`fxRing${i}`, scene);
      const vd = new VertexData();
      vd.positions = [-0.5, 0, -0.5, 0.5, 0, -0.5, 0.5, 0, 0.5, -0.5, 0, 0.5];
      vd.normals = [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0];
      vd.uvs = [0, 0, 1, 0, 1, 1, 0, 1];
      vd.indices = [0, 1, 2, 0, 2, 3];
      vd.applyToMesh(mesh);
      mesh.material = ringMat;
      mesh.rotationQuaternion = Quaternion.Identity();
      markNoHit(mesh);
      mesh.setEnabled(false);
      return { mesh, age: 0, life: E.ring.groundLife, maxScale: 1, active: false };
    }),
  );

  const tracerMat = unlitAdditive(ctx, "fxTracerMat", TRACER.color, tex.streak);
  interface Tracer {
    mesh: Mesh;
    age: number;
    width: number;
    active: boolean;
  }
  const tracerBase = tracerMesh(ctx);
  tracerBase.material = tracerMat;
  tracerBase.rotationQuaternion = Quaternion.Identity();
  const tracers = new RoundRobin<Tracer>(
    Array.from({ length: POOLS.tracers }, (_, i) => {
      const mesh = i === 0 ? tracerBase : tracerBase.clone(`tracer${i}`);
      mesh.rotationQuaternion = Quaternion.Identity();
      markNoHit(mesh);
      mesh.setEnabled(false);
      return { mesh, age: 0, width: TRACER.width, active: false };
    }),
  );
  for (const m of [ringMat, tracerMat]) {
    try {
      m.forceCompilation(m === ringMat ? rings.items[0].mesh : tracerBase);
    } catch {
      /* compiled lazily instead */
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Per-frame animation of pooled meshes and the light.
  ctx.onFrame((dt) => {
    if (lightAge < E.light.life) {
      lightAge += dt;
      const k = Math.max(0, 1 - lightAge / E.light.life);
      light.intensity = lightPeak * k * k;
      if (lightAge >= E.light.life) {
        light.intensity = 0;
        light.position.copyFrom(FAR);
      }
    }
    for (const r of rings.items) {
      if (!r.active) continue;
      r.age += dt;
      const t = Math.min(1, r.age / r.life);
      const ease = 1 - (1 - t) * (1 - t) * (1 - t);
      const s = 0.4 + (r.maxScale - 0.4) * ease;
      r.mesh.scaling.set(s, s, s);
      r.mesh.visibility = (1 - t) * (1 - t);
      if (t >= 1) {
        r.active = false;
        r.mesh.setEnabled(false);
      }
    }
    for (const tr of tracers.items) {
      if (!tr.active) continue;
      tr.age += dt;
      const t = tr.age / TRACER.life;
      if (t >= 1) {
        tr.active = false;
        tr.mesh.setEnabled(false);
        continue;
      }
      tr.mesh.visibility = 1 - t;
      const w = tr.width * (1 - t * 0.5);
      tr.mesh.scaling.x = w;
      tr.mesh.scaling.y = w;
    }
  });

  const rayResult = new PhysicsRaycastResult();
  const rayFrom = new Vector3();
  const rayTo = new Vector3();
  const ringQ = new Quaternion();
  const airRingQ = Quaternion.RotationAxis(new Vector3(1, 0, 0), -Math.PI / 2);
  const rollQ = new Quaternion();
  const fwd = new Vector3(0, 0, 1);
  const camDist = (p: Vector3) => Vector3.Distance(p, ctx.camera.globalPosition);

  // ---------------------------------------------------------------------------------------------
  const fx: FxApi = {
    explosion(position, scale = 1) {
      const s = Math.max(E.scaleRange[0], Math.min(E.scaleRange[1], scale));
      const k = kits.next();
      const rs = Math.sqrt(s);

      k.smoke.at.copyFrom(position);
      (k.smoke.ps.particleEmitterType as SphereParticleEmitter).radius = E.smoke.radius * s;
      setScale(k.smoke.ps, s);
      setPower(k.smoke.ps, E.smoke.power, rs);
      setLife(k.smoke.ps, E.smoke.life);
      k.smoke.ps.manualEmitCount = countFor(E.smoke.count, s);

      k.fire.at.copyFrom(position);
      (k.fire.ps.particleEmitterType as SphereParticleEmitter).radius = E.fire.radius * s;
      setScale(k.fire.ps, s, 0.25);
      setPower(k.fire.ps, E.fire.power, s);
      setLife(k.fire.ps, E.fire.life);
      k.fire.ps.manualEmitCount = countFor(E.fire.count, s);

      k.sparks.at.copyFrom(position);
      setPower(k.sparks.ps, E.sparks.power, rs);
      setLife(k.sparks.ps, E.sparks.life);
      k.sparks.ps.manualEmitCount = countFor(E.sparks.count, s);

      k.chunks.at.copyFrom(position);
      setPower(k.chunks.ps, E.chunks.power, rs);
      setLife(k.chunks.ps, E.chunks.life);
      k.chunks.ps.manualEmitCount = countFor(E.chunks.count, s);

      k.flash.at.copyFrom(position);
      setScale(k.flash.ps, s, 0.05);
      setLife(k.flash.ps, E.flash.life);
      k.flash.ps.manualEmitCount = 1;

      // Light flash (one shared light; a new explosion simply re-triggers it).
      light.position.copyFrom(position).addInPlaceFromFloats(0, E.light.height, 0);
      lightPeak = Math.min(E.light.peakMax, E.light.peakBase + E.light.peakPerScale2 * s * s);
      lightAge = 0;
      light.intensity = lightPeak;

      // Shock ring: on the ground if close to it, otherwise camera-facing in the air.
      const ring = rings.next();
      rayFrom.copyFrom(position).addInPlaceFromFloats(0, 0.2, 0);
      rayTo.copyFrom(position).addInPlaceFromFloats(0, -E.ring.groundProbe * s - 0.5, 0);
      ctx.havok.raycast(rayFrom, rayTo, rayResult);
      ring.mesh.setEnabled(true);
      ring.active = true;
      ring.age = 0;
      if (rayResult.hasHit) {
        const n = rayResult.hitNormalWorld;
        ring.mesh.billboardMode = TransformNode.BILLBOARDMODE_NONE;
        ring.mesh.position.copyFrom(rayResult.hitPointWorld).addInPlace(n.scale(0.05));
        Quaternion.FromUnitVectorsToRef(up, n.lengthSquared() > 0.5 ? n.normalizeToNew() : up, ringQ);
        ring.mesh.rotationQuaternion!.copyFrom(ringQ);
        ring.maxScale = E.ring.groundScale * s;
        ring.life = E.ring.groundLife;
      } else {
        ring.mesh.position.copyFrom(position);
        ring.mesh.rotationQuaternion!.copyFrom(airRingQ);
        ring.mesh.billboardMode = TransformNode.BILLBOARDMODE_ALL;
        ring.maxScale = E.ring.airScale * s;
        ring.life = E.ring.airLife;
      }
      ring.mesh.scaling.setAll(0.4);
      ring.mesh.visibility = 1;
    },

    impact(position, normal, kind: HitKind) {
      const n = tmp.copyFrom(normal);
      if (n.lengthSquared() < 1e-6) n.copyFrom(up);
      else n.normalize();
      const far = camDist(position) > I.farDistance;
      if (kind === "enemy" || kind === "barrel") {
        const enemy = kind === "enemy";
        const b = sparks.next();
        b.at.copyFrom(position).addInPlace(n.scale(0.03));
        setPoint(b.ps, n, I.sparks.along, I.sparks.spread);
        setPower(b.ps, I.sparks.power);
        setLife(b.ps, I.sparks.life);
        b.ps.color1 = enemy ? C.enemySpark1 : C.hotSpark1;
        b.ps.color2 = enemy ? C.enemySpark2 : C.hotSpark2;
        b.ps.colorDead = enemy ? C.enemySparkDead : C.hotSparkDead;
        b.ps.manualEmitCount = far ? I.sparks.countFar : enemy ? I.sparks.countEnemy : I.sparks.countBarrel;
        const f = flashes.next();
        f.at.copyFrom(position).addInPlace(n.scale(0.05));
        setSize(f.ps, I.flash.size);
        setLife(f.ps, I.flash.life);
        f.ps.color1 = enemy ? C.enemyFlash : C.hotFlash;
        f.ps.color2 = f.ps.color1;
        f.ps.colorDead = C.flashDead;
        f.ps.manualEmitCount = 1;
        return;
      }
      // World / prop: dust puff + chips (+ a couple of sparks off metal-ish world surfaces).
      const isProp = kind === "prop";
      const d = dusts.next();
      d.at.copyFrom(position).addInPlace(n.scale(0.05));
      setPoint(d.ps, n, 1, I.dust.spread);
      setPower(d.ps, I.dust.power);
      setLife(d.ps, I.dust.life);
      setScale(d.ps, 1, 0.2);
      d.ps.color1 = isProp ? C.woodDust1 : C.dust1;
      d.ps.color2 = isProp ? C.woodDust2 : C.dust2;
      d.ps.colorDead = isProp ? C.woodDustDead : C.dustDead;
      d.ps.manualEmitCount = far ? I.dust.countFar : I.dust.count;
      if (far) return;
      const c = chips.next();
      c.at.copyFrom(position).addInPlace(n.scale(0.03));
      setPoint(c.ps, n, 1, I.chips.spread);
      setPower(c.ps, I.chips.power);
      setLife(c.ps, I.chips.life);
      c.ps.color1 = isProp ? C.woodChip1 : C.chip1;
      c.ps.color2 = isProp ? C.woodChip2 : C.chip2;
      c.ps.colorDead = C.chipDead;
      c.ps.manualEmitCount = I.chips.count;
      if (!isProp && I.worldSparks.count > 0) {
        const b = sparks.next();
        b.at.copyFrom(position).addInPlace(n.scale(0.03));
        setPoint(b.ps, n, I.worldSparks.along, I.worldSparks.spread);
        setPower(b.ps, I.worldSparks.power);
        setLife(b.ps, I.worldSparks.life);
        b.ps.color1 = C.hotSpark1;
        b.ps.color2 = C.hotSpark2;
        b.ps.colorDead = C.hotSparkDead;
        b.ps.manualEmitCount = I.worldSparks.count;
      }
    },

    tracer(from, to) {
      const dir = to.subtract(from);
      const len = dir.length();
      if (len < TRACER.minLength) return;
      dir.scaleInPlace(1 / len);
      const tr = tracers.next();
      tr.mesh.setEnabled(true);
      tr.active = true;
      tr.age = 0;
      tr.width = TRACER.width + Math.min(TRACER.widthExtraMax, len * TRACER.widthPerMetre);
      tr.mesh.position.copyFrom(from);
      const q = tr.mesh.rotationQuaternion!;
      Quaternion.FromUnitVectorsToRef(fwd, dir, q);
      // Random roll about the tracer's own axis so the crossed quads vary.
      Quaternion.RotationAxisToRef(fwd, Math.random() * Math.PI, rollQ);
      q.multiplyInPlace(rollQ);
      tr.mesh.scaling.set(tr.width, tr.width, len);
      tr.mesh.visibility = 1;
    },

    shatter(position, opts) {
      debris.shatter(position, opts);
    },
  };
  return fx;
}
