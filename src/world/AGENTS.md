# World

The golden-hour scrapyard: sun, shadows, sky, image-based lighting and fog, post-processing, procedural PBR materials, the static arena and skyline, dynamic props with explosive barrels, and ambience. `createWorld` runs once at boot after `createFx` (so `ctx.fx` exists and `ctx.player` does not) and returns `WorldApi`. The user approved the look in Chrome and Safari (2026-11-26), so change it on purpose, through `config.ts`.

## Code map

- `config.ts`: every tuning number (`SUN`, `FILL`, `SKY`, `FOG`, `PROBE`, `SHADOWS`, `POST`, `GLOW`, `SSAO`, `TEXTURES`, `BARREL`, `PROPS`, `AMBIENCE`). Layout coordinates stay in `layout.ts` and `props.ts`; the colour and noise values inside texture recipes stay in `textures.ts`.
- `environment.ts`: sun and cascaded shadows, hemispheric fill, SkyMaterial box, fog, sky probe, GlowLayer, DefaultRenderingPipeline, opt-in SSAO2.
- `skyColor.ts`: CPU port of SkyMaterial's tonemapped fragment shader. Pure math with no Babylon imports, so node can run it.
- `textures.ts`: shared tileable noise fields, then one recipe per surface: canvas → DynamicTexture (albedo sRGB, ORM = AO/roughness/metallic linear, normal from height). `createMaterials` builds every PBR material.
- `geometry.ts`: `Geo` merges boxes, beams and convex prisms into one mesh per material, with UV callbacks (`uvWorld`, `uvFace`, `uvContainer`). `Colliders` creates static bodies on bare TransformNodes and shares shapes by size.
- `layout.ts`: arena constants, `PLAYER_SPAWN`, `ENEMY_SPAWNS`, ground, walls and fence, containers, Jersey barriers, platform and ramp, bales, tyres, steam pipe, floodlights, skyline.
- `props.ts`: crate, barrel and drum placements, `ExplosiveBarrel`, fuse ticking. `ambience.ts`: dust, steam, stack smoke, beacon blink. `noise.ts`: seeded RNG, value noise, fBm, Worley.

## Contracts

- **Anything solid has a static Havok body.** Visuals and colliders are separate: `Geo` meshes have no bodies, and `Colliders` puts each body on its own frozen TransformNode, so moving a visual never moves its collider. Each perimeter wall collider is taller than the concrete plus fence on purpose. The ground is a thick slab, not a plane. In the `?debug=1` PhysicsViewer these two are the huge boxes; the wall colliders' faces show as large triangles above the walls.
- **Dynamic props are instances of hidden source meshes.** `isVisible = false` hides only the source. Instance `visibility` is shared with the source, so fade instances by scale. Bodies start asleep, so stacks must be built touching with `PROPS.stackGap` and never interpenetrating, or they pop when woken. Havok never scales a shape: instance scaling is visual only, and shape extents must equal the scaled size. Every prop body goes in `ctx.dynamicBodies` and every instance in the shadow list.
- **Barrels.** `ExplosiveBarrel` is the `Damageable`, tagged on the instance with `setDamageable`. Death only arms the fuse (`BARREL.fuse`). The fuse ticks in `ctx.onFrame` on game time and skips only `"paused"`, so chains still finish in the menu and game-over screens. Detonation unregisters the barrel (damageables, dynamicBodies, shadows), disposes it, then calls `explode` and `ctx.fx.shatter`. Never call `explode` from `takeDamage`: chains must not recurse synchronously.
- **Picking.** Merged world meshes are pickable: floor, walls, containers, barriers, platform, bales. Thin or decorative meshes are `markNoHit`: fence, railings, container corner posts and door bars, floodlights, skyline, sky and the probe ground. A pick tests every triangle of a merged mesh, so keep pickable merges low-poly; that is why the floor is only lightly subdivided.
- **Shadow casters** go through `WorldApi.addShadowCaster` / `removeShadowCaster`. Remove before dispose. Instances are added one by one. The skyline does not cast, because it is beyond `SHADOWS.maxZ`.
- **Rendering groups.** The world is all in group 0. The player's viewmodel is group 1 with a depth clear, and the pipeline and glow layer are fine with that. SSAO2 (`?ssao=1`) reads the geometry buffer and may draw a dark halo around the viewmodel. The pipeline is attached to `ctx.camera` only, so the debug free camera renders without post.
- **Lights.** Sun, hemi and FX's flash light use 3 of PBR's default 4 per material. Use emissive plus the glow layer instead of new lights; a fifth light would silently stop lighting some meshes.
- **Sky probe.** It renders every frame until the sky and the probe-only ground disc are ready for `PROBE.readyFrames` frames, then becomes `scene.environmentTexture` and is frozen with `REFRESHRATE_RENDER_ONCE`. Do not assign it earlier: PBR reads the irradiance back from the texture once and caches it, so an early assignment bakes black ambient light for good. The disc's layer mask hides it from cameras; the probe still renders it because an explicit `renderList` ignores layer masks. `PROBE.timeoutFrames` is the safety net.
- **Fog comes from the sky model.** `skyColor.ts` mirrors the SkyMaterial shader. The fog colour is the per-channel median of horizon samples times `FOG.tint`. A linear average was dominated by the bright arc around the sun. If SkyMaterial is upgraded or switched to `rawHdrOutput`, update `skyColor.ts` or the fog stops matching. The skybox has `applyFog = false`.
- **One sun direction** drives the DirectionalLight, SkyMaterial's `sunPosition`, the fog sampling and the hemi tint. Change it only through `SUN`.

## Changing it safely

- **Adding props.** Add the spot in `props.ts`, listing stacks bottom-up so the `PROPS.max*` caps never leave a top crate floating. Check rotated footprints: a yawed box needs a half-extent of about `s/2 × (cos + sin)`. Keep at least 3 m from `PLAYER_SPAWN`. Remember the shared body budget: props plus up to `DEBRIS.max` debris plus drones and grenades.
- **Changing the layout.** Add a `Geo` box for the visual and a `col.box` with the same centre, size and rotation for the collider. Keep every `ENEMY_SPAWNS` point inside `ARENA`, outside every collider and above the container stacks (three containers high is about 7.8 m). Keep the spawn on open ground. The ramp must stay walkable under the player's `maxSlopeDeg`.
- **Geometry.** `Geo` fixes triangle winding from the intended outward normal, so supply correct normals. `addPrism` accepts convex profiles only.
- **Textures.** Reuse the shared noise fields and stay at 512 px or less. ORM and normal maps must be `gammaSpace = false`. Normal maps use the OpenGL convention; `TEXTURES.normalYSign` flips them all. Every new recipe adds to boot time (all textures take about 0.7 s now).

## Lessons (2026-11-26)

- At a low sun, SkyMaterial is white near the sun and blue-grey everywhere else. The golden warmth comes from the sun colour, `FOG.tint` and `POST.curves`, not from the sky.
- A sun from the west-north-west back-lit every face seen from the spawn. The west-south-west sun gives side light, with long shadows falling right and away from the player.
- Cascaded shadows need WebGL2. `environment.ts` falls back to a single `ShadowGenerator` (this is what NullEngine gets).
- `SHADOWS.bias` and `normalBias` were picked without seeing a frame. The approval was for the overall look, not specifically for shadow acne.
- Havok's `setMassProperties({ mass })` alone is fine, because its inertia is per unit mass.

## Verify

- `?debug=1`: press P for the PhysicsViewer. Colliders should line up with containers, the ramp, railings and barriers, and props should sit still until shot. Use the free camera to check the skyline from outside the walls (shown without post).
- `?fps=1`: about 60 FPS at the default pixel ratio on an M2 Pro was measured. Re-check after adding casters, lights or textures.
- **Needs human eyes:** shadow acne and detached shadows, most likely on the ground at grazing angles in the far cascade; the horizon above the walls; shadowed faces not black once the probe has frozen; container ribs and crate stencils not inverted or mirrored.
- **`npm test -- world`** (`tests/world.test.ts`) runs `createFx` + `createWorld` headless. It checks that props settle and stay inside the arena, that the spawn is clear, that a weapon pick finds a barrel, barrel HP and chain reactions, and that effects leak nothing and debris respects its cap and expiry. The original script could also dump every procedural texture to PNG; that wasn't ported. Harness details: [tests](../../tests/AGENTS.md).
