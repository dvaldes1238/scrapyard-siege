# Core

The contracts every module codes against, the single explosion routine, and the dev tools. Boot and the
frame loop live next door in `src/main.ts` and are documented here too. Core imports no module code:
`debug.ts` talks to enemies through the structural `DebugEnemies` interface.

## Code map

- `context.ts`: `GameContext`, `GameState`/`Phase`, and the module APIs (`WorldApi`, `FxApi`, `AudioApi`,
  `PlayerApi`, `SoundId`).
- `events.ts`: `GameEvents` (every cross-module event, with payload docs) and the typed `EventBus`.
- `damage.ts`: `Damageable`, `setDamageable`/`findDamageable`, `markNoHit`/`isHittable`.
- `explosion.ts`: `explode()`, the only explosion routine.
- `debug.ts`: `DEV` URL flags, `installDevTools` (`?god`, `?wave`, `?debug`), `runSelfTest`.
- `../main.ts`: engine, Havok, camera, context, module creation order, `tick()`, capture mode,
  `window.gameReady`.

## Contracts

- **Creation order** is `createAudio → createFx → createWorld → createPlayer → createEnemies → createUi
  → installDevTools`. A module may use earlier APIs while it is being created; later ones
  (`ctx.player` inside `createWorld`, for example) only at runtime.
- **Phase machine:** `menu → playing ⇄ paused`, `playing → gameover`. The UI owns `menu → playing` (deploy
  click) and `playing ⇄ paused` (pointer lock). Enemies own `→ gameover` (on `player:died`). Restart is
  `location.reload()`; `game:start` also resets score, kills and wave.
- **Ticks:** `ctx.onFrame` runs every frame in every phase (cosmetics, things that should finish after
  game over); `ctx.onUpdate` runs only while `playing` (gameplay). `dt` is seconds, clamped to 1/20
  (exactly 0.016 in capture mode). Physics runs in every phase except `paused`.
- **Events:** payload `Vector3`s may be reused by the emitter, so clone what you keep. A throwing handler is
  logged and skipped; it does not stop the others. Every event's emitter is named in `events.ts` or the
  owning folder's guide.
- **Damage:** drones and explosive barrels are `Damageable`; the player is not (use
  `ctx.player.takeDamage`). Tag the root node with `setDamageable`; `findDamageable` walks up from any
  picked child mesh. Weapon picks use `scene.pickWithRay(ray, isHittable)`, so anything that must not stop
  a shot gets `markNoHit`.
- **Registries:** every dynamic body goes in `ctx.dynamicBodies` and every shootable in
  `ctx.damageables`. Add on create, delete on death or dispose; `explode()` iterates both.
- **`explode()`** does visuals, sound, the `explosion` event, mass-scaled impulses, falloff damage, and
  player damage and knockback, in that order. It iterates a copy of `damageables`, but **callers must defer
  chain reactions** (barrels use a short fuse) so explosions never recurse synchronously.
- **`window.gameReady`** turns true after `scene.whenReadyAsync()` resolves *and* a frame renders after
  that. Rendering never waits for it.

## Dev tools (`debug.ts`)

- `?god` replaces `ctx.player.takeDamage` with a no-op. Anything that damages the player through the API
  is blocked, but knockback still applies.
- `?wave=N` calls `skipTo(N)` from a `game:start` listener registered *after* the enemies module's, so it
  runs after the director's own reset.
- `?debug`'s free camera blocks the player by listening on `window` in the capture phase and stopping
  keydown, pointerdown **and pointermove**. Pointermove matters because the player reads presses from its
  button mask and turns its own camera on it. Real events target an element, so they are blocked;
  synthetic events dispatched directly on `window` are not. The free camera has no post-processing,
  because the pipeline is attached to `ctx.camera`.
- `?selftest` starts play without the deploy click (no audio unlock, no pointer lock) and drives the rifle
  and launcher with synthetic `PointerEvent`s on the canvas. PASS needs: no errors, more than 5 shots, an
  explosion, a spawn and a kill. At very low frame rates (a hidden pane) it fails for lack of game time,
  not because of a bug. The report is POSTed to `/__selftest`, a small plugin in `vite.config.ts` that
  logs it on the dev and preview servers.

## Changing it safely

- **New event:** add it to `GameEvents` with a comment saying who emits it. If it should make a sound,
  wire it in `src/audio` (gameplay code never plays sounds).
- **Contract change:** update every implementer and the affected folder guides in the same change, then
  typecheck and self-test.
- Keep core free of module imports. If dev tools need more from a module, widen a structural interface
  in `debug.ts`, as `DebugEnemies` does.

## Lessons (2026-11-26)

- **Pausing physics:** `setTimeStep(0)` does *not* pause Havok, because `new HavokPlugin(true, …)` steps by
  frame delta. Pause with `scene.physicsEnabled = false`. A crate kept flying behind the pause screen
  until this was fixed.
- **Don't wait for readiness before rendering:** holding back `runRenderLoop` until `whenReadyAsync()` took
  over 45 s in a throttled background tab (it polls on timers), which means a black screen. Start
  rendering at once and only gate the ready flag.
- **Pointer events:** Babylon cancels canvas `pointerdown`, which suppresses compatibility mouse events,
  so the first build could not shoot. Use pointer events everywhere.
- **Havok with Vite:** keep `optimizeDeps.exclude: ["@babylonjs/havok"]`, or the `.wasm` path breaks in
  dev. The production build bundles the `.wasm` and serves it as `application/wasm`; it loads in Chrome
  and Safari 27.
- **Software rendering:** boot logs the GPU renderer and warns on SwiftShader or llvmpipe. Screenshots and
  FPS from a software renderer are meaningless.
- **Capture mode's 16 ms:** `scene.useConstantAnimationDeltaTime` feeds a fixed 16 ms (not 1/60 s) to
  animations, particles *and* Havok (which steps by the delta it is given). `CAPTURE_DT` matches it so
  gameplay and physics share the same dt. Verified: a crate launched at 5 m/s rose 0.669 m in 10 steps,
  against 0.674 m from the ballistic formula.
- **Babylon typing quirks:**
  - `scene.getPhysicsEngine()` is typed as the v1/v2 union and lacks `getBodies()`; cast it, as
    `physicsBodies()` in `debug.ts` does.
  - `ctx.engine` is an `AbstractEngine`; `getGlInfo()` and `webGLVersion` need `as Engine`.
  - `engine.getFps()` returns `NaN` for the first frames; guard before averaging, or the average stays
    `NaN` forever.
