# Player

The first-person player: Havok character-controller movement, the one camera (`ctx.camera`, which `main.ts` creates with no inputs), the procedural viewmodel, the pulse rifle, the under-barrel kinetic grenade launcher, and health, regen and death. The entry point is `createPlayer(ctx)` in `index.ts`, whose `PlayerApi` becomes `ctx.player`. All tuning numbers are in `config.ts`.

## Code map

- `index.ts`: wires the parts together and owns health, death and the `game:start` reset. It fixes the per-update order: look → move → health → camera → weapons → viewmodel.
- `config.ts`: `PLAYER`, `LOOK`, `RIFLE`, `LAUNCHER`, `CAMERA_FX`, and the `?sens=` scale. Plain values come from DESIGN.md; values marked "feel" are hand-tuned.
- `input.ts`: keys, pointer buttons and pointer-lock look. Edges (jump, reload, launcher, fire tap) are queued and consumed once per update. All queries return nothing unless `canAct()` (alive and phase `playing`).
- `movement.ts`: `Movement` over `SteppingCharacterController`. It adds its own gravity, ground and air acceleration, coyote time, jump buffer, queued knockback, footstep phase and kill-plane respawn. Long frames are split into substeps.
- `cameraRig.ts`: base yaw/pitch plus additive offsets (recoil, bob, landing dip, strafe lean, trauma shake, flinch, sprint FOV, death drop). `finalRot` is the orientation shots use.
- `viewmodel.ts`: the gun is built from primitives merged per material, with one animated `root` under the camera. It also holds the flash cards, the accent strip (ammo and reload feedback) and the launcher charge pips.
- `rifle.ts`: hitscan, spread bloom, recoil, prop impulses, reload and empty handling.
- `launcher.ts`: charges and recharge, pooled grenade visuals and trails, one Havok body per shot, detonation.
- `util.ts`: `Spring` (sub-stepped), `damp`, easing, shake noise.

## Contracts

- **PlayerApi.** `health` and `alive` are live getters, and the position getters return new vectors. `getEyePosition()` is the stable eye (feet plus eye height) without bob, shake or death drop, so enemies should aim at it, not at `ctx.camera.position`. `takeDamage` is ignored unless the player is alive and the phase is `playing`. It is a plain property so `?god=1` can replace it: never damage the player by any other path. `applyKnockback` is queued for the next movement step. An upward component above 0.5 m/s ungrounds the player briefly, so ground friction doesn't cancel the push.
- **Events.** HUD state (`ammo:changed`, `launcher:changed`, `player:healed`) is re-emitted on the first update after every `game:start`, because the UI subscribes after us.
  - `player:died` fires once per life.
  - `player:land` fires only above `PLAYER.landEventMinSpeed`, so walking off curbs stays silent.
  - `launcher:changed` fires at most every `LAUNCHER.eventInterval` while recharging, and immediately when charges change.
  - `hit` fires per rifle hit, and once per grenade blast that touched a live Damageable.
- **Phases.** Gameplay runs in `onUpdate`. `onFrame` drives the camera and viewmodel only outside `playing` (menu idle, death cam during `gameover`) and freezes them while `paused`. Grenades tick in `onFrame` in every phase except `paused`, so they keep flying and exploding during `gameover`. `game:start` resets everything: spawn, health, ammo, charges, flying grenades, camera effects, and the gun-raise animation.
- **Collision bit.** The capsule's only membership is `PLAYER_COLLISION_BIT` (`movement.ts`), and the grenade shape's collide mask excludes it, because grenades spawn inside the capsule on purpose. Havok's default masks are -1/-1 (checked in Node), so every other shape still collides with the player, and raycasts with default filters still hit the capsule.
- **Rendering group 1** holds the viewmodel and muzzle flashes, with depth cleared for the group. Nothing else should render in group 1. Every viewmodel, grenade and trail mesh is `markNoHit`. Only grenade cores cast shadows, added on launch and removed on release.
- **`ctx.dynamicBodies`** contains a grenade body only while it is flying. The body is removed before `explode()` runs, so the blast doesn't push the grenade that caused it.

## Changing it safely

- **Tuning:** change the numbers in `config.ts`. The viewmodel's pose, its kick velocities and its reload keyframes are the exception: they are inline in `viewmodel.ts` (`BASE_POS`, `BASE_ROT`, `fireKick`, `update`).
- **Aiming:** shots start at `ctx.camera.position` along `rig.finalRot`, which already includes recoil and shake. `rig.update` must therefore run before the weapons in each update. `vm.getMuzzleWorldToRef` forces fresh world matrices for the camera, root and muzzle; use it for any projectile or tracer origin.
- **New weapon:** write a class with `update(dt, input)` modelled on `Rifle`. Put its muzzle as a TransformNode under `vm.root`, and route its kick through `rig.kick(pitch, yaw, recoverFraction)` and the vm springs. A new `WeaponId` is a core contract change, so ask the lead first. New input edges become `consume*` queues in `PlayerInput`.
- **Visible detail:** the camera sees the gun's left (−x) side and its top, so put details and emissive parts there.
- **Perf patterns to keep:**
  - Add new gun parts to the `lists` before merging, not as extra meshes.
  - Animate only `root`, `magPivot`, the pips and the flash groups.
  - Grenades reuse pooled nodes, visuals and trails plus one shared `PhysicsShapeSphere`; only the `PhysicsBody` is created per shot.
  - The rifle reuses its `Ray` and temporary vectors.
  - `cc.getPosition()` and `cc.getVelocity()` return the controller's internal vectors: copy them, never mutate them.

## Lessons (2026-11-26)

- **Step-up.** Babylon 9.38's `_tryStepUp` probes forward only speed × dt (about 0.1 m at walk speed). The capsule needs about 0.17 m past the edge before the landing counts as walkable, so steps only worked above roughly 10 m/s. `SteppingCharacterController` widens the probe to `minStepProbe`. Measured headless at walk and sprint: steps up to 0.35 m are climbed and 0.40 m blocks, whatever `maxStepHeight` is between 0.2 and 0.35, because the rounded capsule rides past it. A 0.26 m probe climbed 0.45 m. This overrides a protected method, so retest it whenever Babylon is upgraded.
- **Controller basics.** `integrate()` applies no gravity, so we add it ourselves in the air. On the ground, velocity is projected onto the support plane at full horizontal speed, plus `groundStick`, which keeps ramps grounded in both directions. Pushing props comes from the controller itself; `characterStrength` is a force cap in newtons, which is why heavy props block.
- **Grenade contacts.** The per-body collision observable only sets `contact`. Detonation happens in `scene.onAfterPhysicsObservable`, never inside the callback, because explode() and dispose() during `_notifyCollisions` are unsafe. Zero inertia locks the sphere's rotation, which keeps the visual child's decaying offset from the launcher tube in world space.
- **Glow.** Emissive meshes glow by default. Never call `addIncludedOnlyMesh` just to be safe: it switches the whole layer to include-only. Once per second, `index.ts` reads the private `_thinEffectLayer` to see whether someone else has switched the mode, and registers our meshes only if they have.
- **Pointer events.** Firing never worked with mouse events, because Babylon's preventDefault on canvas pointerdown suppresses them while a button is held. Buttons are now diffed from `e.buttons`; a chorded right click arrives only as a pointermove. Trackpad taps press and release within one frame, so presses are latched (`consumeFireTap`). Ctrl+click queues the launcher. The start/resume gate keeps the real button mask (`prevButtons`): resetting it let a deploy click held past the gate count as a fresh press on the next pointermove and fire.
- **Headless tests.** NullEngine plus Havok (`wasmBinary`) runs `Movement`, `Launcher` and even `createPlayer` in Node with DOM stubs. They live in `tests/`: `npm test -- player` (input gates, taps, Ctrl+click, rifle, launcher, sprint/jump, regen/death/restart) and `npm test -- movement` (step-up guard for the `_tryStepUp` override; rerun after every Babylon upgrade). Two traps: `scene.render()` there steps physics by real elapsed time, so pin `engine.getDeltaTime`; and the fire gate uses `performance.now()`, so fake the clock too.

## Verify

- **`npm test -- player` and `npm test -- movement`:** must pass. They cover the logic above headlessly, but not rendering or real pointer lock.
- **`?selftest=1`:** must report PASS. It dispatches canvas PointerEvents, holding the rifle and then firing two grenades. It does not exercise pointer lock or the start-click gate.
- **`?debug=1`:** press P to see the capsule and grenade shapes, and use the free cam to watch grenades, pushed crates and step-ups from outside. The free cam blocks keys, pointerdown and pointermove, so the player neither moves, turns nor fires while you fly. Add `?god=1` to test weapons without dying.
- **By hand (needs a human):**
  - Feel: acceleration, jump arc, air control, recoil climb and recovery, sway and bob.
  - Pointer lock: the click that starts or resumes the game never shoots; Esc drops held keys; RMB during LMB auto-fire launches a grenade.
  - Trackpad: a tap fires one shot, and Ctrl+click fires the launcher. If clicks drop *only* while
    WASD is held, suspect macOS ignoring the trackpad during typing, not the input code (unconfirmed;
    agents can't reproduce it). `?sens=` raises look speed for trackpads.
  - Visuals: the muzzle flash glows; the gun never clips into walls; curbs step up; crates push.
  - Damage and death: a grenade at your own feet hurts; the death cam plays; restart resets everything.
