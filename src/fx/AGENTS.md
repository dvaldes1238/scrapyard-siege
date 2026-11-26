# FX

Fire-and-forget effects behind the `FxApi` core contract: `explosion`, `impact`, `tracer` and `shatter`. `createFx` runs first at boot, before the world, so `ctx.world` does not exist while it builds. Use `ctx.world` only lazily, inside calls (debris shadows). `getFxTextures(scene)` is cached per scene and is also used by the world's ambience.

## Code map

- `config.ts`: every tuning number (`POOLS`, `IMPACT`, `EXPLOSION`, `TRACER`, `DEBRIS`, `FX_COLORS`). Counts in `EXPLOSION` are `base + perScale × scale`.
- `index.ts`: particle pools, explosion kits, shock rings, tracers, the shared flash light, and the `FxApi` object.
- `debris.ts`: physical debris behind `shatter`.
- `textures.ts`: procedural white particle textures (dot, smoke, fire, ring, chip, flare, streak, scuff), tinted by particle colour.

## Contracts

- **`impact` and `tracer` must never allocate per shot.** They fire about 11 times a second from the rifle, plus drone bolts. Never create ParticleSystems, meshes, materials, textures or lights in a call, and use the shared `FX_COLORS` constants instead of `new Color4`. A few small vector temporaries from `scale()` remain; don't add more.
- **Round-robin pools.** A burst moves a pooled system's emitter vector, sets that burst's parameters and sets `manualEmitCount`. Babylon reads them when it emits on the next `animate`. Up to `POOLS.impact` bursts of one kind per frame stay distinct; any more overwrite the oldest system's settings. Live particles are in world space and are not affected.
- **Units.** `updateSpeed = 1/60` makes lifetimes seconds, emit power m/s and gravity m/s² (scaled by the animation ratio, so `?capture=1` stays consistent).
- **Size gradients are absolute sizes**, and `minSize`/`maxSize` are ignored when they exist. Per-burst scale goes through `min/maxScaleX/Y` (`setScale`).
- **Colours** are gamma-space and converted with pow 2.2, so values above 1 push hard into HDR bloom.
- **Warm-up.** `makePS` emits one particle at y = −1000 so the particle shaders compile during the menu. The ring and tracer materials are force-compiled, and so is the debris PBR material (with instances). Keep this for anything new or the first use hitches.
- **Draw order is creation order.** Smoke is created before fire so the additive fire draws over it.
- **`markNoHit` every FX mesh** (rings, tracers) **except debris.** Debris must stay shootable; the weapon reports it as `"prop"` and pushes it.
- **One shared PointLight for explosions.** It idles at intensity 0 far below the map instead of being disabled, because toggling a light changes every PBR shader's defines. Never add per-effect lights.
- **Shock rings.** A Havok raycast below the blast decides: on a hit the ring lies flat on the surface along its normal, otherwise a camera-facing ring is used. `explosion(scale)` receives `radius / 5` from `core/explode` and is clamped to `EXPLOSION.scaleRange`.
- **Debris.**
  - Each colour gets one hidden source mesh and one PBR material, cached by hex, so keep the set of colours callers pass small.
  - Every piece owns its box shape; dispose the shape after the body.
  - Pieces are registered in `ctx.dynamicBodies` and as shadow casters, and removed oldest first at `DEBRIS.max`.
  - They shrink visually over `DEBRIS.shrinkTime` (the physics shape does not shrink).
  - They age in `onFrame` except while paused, and are dropped below `DEBRIS.killY`.

## Changing it safely

- **Adding an effect.** `FxApi` is a core contract, so new public calls go through the lead. Internally, add a pool built with `makePS` (warm-up included) and put its numbers in `config.ts`.
- **Cost.** There are about 50 pooled particle systems, and each idle one still costs a little CPU per frame. Prefer more particles in an existing pool over a new system.
- **Debris counts.** A full barrel chain asks for more debris than `DEBRIS.max`. Raising the cap or `BARREL.debrisCount` pushes the shared body budget, which is already briefly about 160 during big chains.

## Lessons (2026-11-26)

- **Tracer roll order.** `q.multiplyInPlace(roll)` rolls the tracer about its own axis; the reverse order twists it off the shot line.
- **Unlit materials cap at 1.** `StandardMaterial` with `disableLighting` clamps output at 1, so rings and tracers can't go HDR. Bloom comes from particle colours above 1 and from the glow layer.
- **Bursts only.** `manualEmitCount` resets to 0 after each emission, and with `emitRate` 0 a system only ever emits bursts.

## Verify

- `?fps=1` during a full barrel chain (12 barrels): the frame rate should hold while debris hits the cap and expires.
- `?debug=1` and P: debris boxes appear in the PhysicsViewer and disappear on schedule. No FX mesh should block a shot.
- **Needs human eyes:** tracer thickness and visibility at range, impact readability against concrete and containers, fireball versus smoke balance, shock rings on the platform and ramp, and the flash light on nearby walls.
- **`npm test -- world`** also spams `impact`, `tracer`, `explosion` and `shatter`, and checks for mesh leaks and the debris cap and expiry (`tests/world.test.ts`).
