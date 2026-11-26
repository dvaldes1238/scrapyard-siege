# Enemies

The hover drones (seeker, bomber, brute), their plasma bolts, the wave schedule, and the run's score, kills and game over (built 2026-11-26 from DESIGN.md "Drones" and "Waves"). Every tuning number is in `config.ts`; DESIGN.md holds the design intent. `createEnemies(ctx)` returns the `EnemiesApi` that `src/core/debug.ts` drives (`spawn`, `killAll`, `skipTo`, `drones()`). `window.enemies` is that API plus `system` and `director`, for poking from the console.

## Code map

- `index.ts` wires the events (`game:start` → `director.start()`, `player:died` → game over), the `onUpdate`/`onFrame` hooks and `EnemiesApi`.
- `config.ts` holds `DRONES` (per-type spec), `FLIGHT` (envelope, separation, probes), `SEEKER_AI` / `BOMBER_AI` / `BRUTE_AI`, `BOLT`, `DEATH_BLAST` / `BOMBER_BLAST`, `WAVES` and `waveComposition(n)`.
- `assets.ts` is built once: procedural textures, the shared materials, the invisible template meshes per type (hull, plates, flash, eye, thruster, rotors), one `PhysicsShapeSphere` per type, and the bolt and warp templates.
- `drone.ts` is the `Drone` (a `Damageable`): the hierarchy, its kinematic body, steering (`update`), cosmetics (`frame`), damage and death, and `debugInfo()`.
- `bolts.ts` is the `BoltSystem` pool and its swept hit tests. `waves.ts` is the `WaveDirector`: countdown/active modes, spawn queue, spawn-point choice, warp-in telegraphs, clear bonus and `skipTo`.
- `system.ts` is the `EnemySystem`: the live drone set, ray and line-of-sight helpers, `retire()` with deferred disposal, and `clearAll()`. `predicates.ts` is split out so `bolts.ts` and `system.ts` have no value-level import cycle.

## Contracts

- **This folder owns `state.score`, `state.kills` and `state.wave`, and the switch to `phase = "gameover"`.** Nobody else writes them. `game:start` resets all three, emits `score:changed`, and silently clears drones, bolts and telegraphs, so re-emitting `game:start` restarts the run. `?wave=N` depends on its own `game:start` listener running after ours: `skipTo` replaces the countdown `start()` just scheduled.
- **Events.** `enemy:spawned` fires when the drone appears, at the end of its telegraph. `enemy:fired` fires once per bolt, so a brute burst emits several. Each credited kill emits `enemy:killed` and `score:changed`. `wave:start` carries the queue length; `wave:cleared` is followed by `score:changed` for the bonus. Explosion events come from core `explode()`.
- **Game over** happens on `player:died` only and is guarded against repeats. It stops spawning, drops pending telegraphs and releases every bolt (`onUpdate` stops, so a bolt left mid-air would freeze there on the game-over screen). Live drones stay: they coast to a hover and keep animating through `onFrame` as the backdrop until the next `game:start`.
- **Kill credit.** Any death by damage counts (rifle, grenade, barrel chains, other drones' blasts), but only while `phase === "playing"`. A bomber that detonates on the player uses `BOMBER_BLAST` and gives no kill or points. A bomber that is shot down uses `DEATH_BLAST` like the others.
- **Double-death guard.** `die()` sets `_alive = false` and `retire()` unregisters the drone before `explode()` runs, because `explode()` damages every damageable and can re-enter this drone or chain into others. Keep that order.
- **Re-entrant loops.** The drone loop iterates a copy and stops as soon as the phase leaves `"playing"`, because a bomber blast can kill the player mid-loop. The bolt loop releases a bolt before applying its damage and re-checks the slot each iteration, because the player's death calls `bolts.clear()` mid-loop.
- **Hit surfaces.** Every drone sub-mesh is a pickable instance tagged `metadata.enemyPart`. Only the root holds the Damageable, via `setDamageable`. The root is an empty `Mesh` with `isPickable = false` rather than a TransformNode, because `world.addShadowCaster` takes an AbstractMesh. The thruster flame is `markNoHit` and is not a hitbox. Bolts, line-of-sight checks and AI probes all use `worldPredicate`, so they ignore drones.
- **Bolts outside the player.** A bolt that hits a barrel damages it (`source: "enemy"`, so barrel chains can start from enemy fire), and one that hits a dynamic prop pushes it. A pick on the player's own mesh near the capsule counts as a player hit, not a world hit.
- **`debugInfo()`** runs every frame for each drone label under `?debug=1`. Keep it to one cheap line.

## Changing it safely

- **Adding a drone type** means touching `DroneType` and `DRONES`, adding a builder in `assets.ts` that returns a `DroneTemplate`, a `think*` branch in `Drone.update`, and a count in `waveComposition`. The `Record<DroneType, …>` maps make tsc list the places you missed.
- **Tuning happens in `config.ts` only.** `FLIGHT.altMin` and `FLIGHT.altMax` are measured from `world.playerSpawn.y` (`system.baseY`). They act as a hard clamp, plus a soft floor taken from a downward probe, so drones rise over containers. Keep `FLIGHT.altMin` well below `BOMBER_AI.triggerDistance` plus the player's chest height, or bombers can't get close enough to detonate on a grounded player. `WAVES.maxAlive` counts live drones plus telegraphs that haven't spawned yet.
- **Shared materials and instances.** All drones share materials and template meshes, so changing a material changes every drone. Per-drone effects use instance state instead:
  - the hit flash is an inflated white instance of the hull and plates, shown through `isVisible`;
  - the bomber's blink toggles its eye instance's `isVisible`;
  - the shot charge scales the eye.

  Templates use `isVisible = false`; Babylon's `renderSelf` check hides the source while its instances still render. Dispose with `root.dispose(false, false)`: a `true` second argument would dispose the shared materials and textures.
- **Disposal happens in two phases.** `retire()` immediately unregisters the drone (damageables, shadows, drone set), disables its root and disposes its physics body. The meshes are disposed on the next `frame()`, so a weapon still holding the picked mesh after `takeDamage` never touches a disposed one. Don't move mesh disposal into `die()`.
- **Gameplay and cosmetics stay split.** AI, firing and spawning live in `update` (`onUpdate`). Yaw, bank, bob, rotors, flicker, blink, flash and the warp-in pop live in `frame` (`onFrame`, skipped while paused). Muzzle and eye positions come from the pivot that `frame` orients; `main.ts` runs frame functions before update functions.
- **`drone.position` is `root.position` and is authoritative.** Never read the body back into it.

## Lessons (2026-11-26)

- **Kinematic drones use an ANIMATED `PhysicsBody` with `setPrestepType(PhysicsPrestepType.ACTION)` and `disableSync = true`.**
  - **ACTION, not TELEPORT.** ACTION calls `setTargetTransform` from the node every step, so the body has a real velocity and grenades bounce off or detonate correctly. TELEPORT moves the body with zero velocity.
  - **`disableSync` must be set by hand.** Babylon only defaults it to true for STATIC bodies, so without it an ANIMATED body writes its transform back into the node every step.
  - **Recompute the world matrix after moving.** ACTION reads `absolutePosition`, hence `root.computeWorldMatrix(true)` after each move.
  - **Brief overshoot on uneven frames is harmless.** Havok computes the target velocity from the previous step's ideal time, while `main.ts` steps by frame delta, so on uneven frames the body overshoots briefly. It doesn't matter because the node is authoritative.
  - **Shapes are shared.** One `PhysicsShapeSphere` per type is shared by every drone of that type, and `body.dispose()` leaves the shape alone.
- **Disposing a body inside a Havok collision callback is safe.** `_notifyCollisions` in `havokPlugin.js` skips events whose bodies are gone. Grenades kill drones from inside such callbacks, so the body is disposed at death, which leaves no ghost sphere to launch the shatter debris. Only the meshes wait a frame.
- **Aim lead.** At 0.5 ("slight lead"), the headless harness measured about 95% of bolts hitting a standing player but 8–15% hitting one walking at 6 m/s, so moving made the player nearly immune. 0.7 hit about 53% when strafing straight and 29% when circling; 0.85 overshot when circling. `BOLT.lead` now sits between the 0.5 and 0.7 runs. Measure again before changing it or the `spreadDeg` values.
- **Metal and the environment map.** Drone materials use full `metallic`. An earlier check halved it when `scene.environmentTexture` was null, but the world assigns its sky probe a few frames after boot, so that check always fired and every drone looked dull (fixed 2026-11-26). If the world ever stops providing an environment map, metals will render near-black: fix the world, not the drones.

## Verify

- **In the browser,** open `?debug=1&god=1&wave=5`. Labels read `type hp · mode · fire` (bombers have no fire timer); P shows the physics spheres, which must ride with the drones. Check that:
  - seekers orbit and juke;
  - bombers blink faster as they close in, then dive and detonate;
  - the brute fires bursts;
  - hits show a white flash and a small knockback;
  - deaths show a blast and debris in the drone's colour;
  - score and kills advance in the panel.

  The wave sizes should match `waveComposition`.
- **From the console:** `enemies.spawn("brute")` puts one 12 m ahead with no telegraph. `enemies.killAll()` credits kills and so clears the wave. `enemies.skipTo(n)` jumps to wave n.
- **`?selftest=1`** only proves that spawns, kills and explosions happen without errors. It doesn't check AI quality, the flight envelope, bolt hits or the kill-credit rules.
- **`npm test -- enemies`** (`tests/enemies.test.ts`) drives the real module against mocked fx, world and player. It checks wave timing and counts, that each body tracks its root, a grenade hitting a drone's body, kill/score/bonus, a chain death counted once, that a bomber detonation earns no credit, the alive cap, the flight envelope, game over and restart. `LEAD_EXP=1 npm test -- enemies` reruns the aim-lead experiment. Harness details: [tests](../../tests/AGENTS.md).
