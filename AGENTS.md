# Agent Instructions

Guidance for Claude Code and Codex when working in this repository. Read this file, then the
`AGENTS.md` in the folder you are changing, before editing anything.

> Claude Code loads `AGENTS.md` files only while the repo has no `CLAUDE.md`. Do not add a
> `CLAUDE.md` or `CLAUDE.local.md` (including through `/init`).

## Overview

Scrapyard Siege: a small first-person browser shooter, built as a showcase of browser graphics and
physics. Babylon.js 9.38 (WebGL2) + Havok physics (WASM) + TypeScript + Vite. One arena, waves of
hover drones, a pulse rifle with an under-barrel grenade launcher, and physics props that react to
everything. What the game is (pitch, controls, wave rules, look): [DESIGN.md](DESIGN.md).

Everything is generated in code: meshes, textures (DynamicTexture), sounds (WebAudio synthesis). There
are no asset files and no runtime network requests. Keep it that way unless the maintainer asks otherwise.

## Commands

- `npm run dev`: dev server on **port 5391** (strict, so it never silently moves; 5173 is often taken by
  other Vite apps).
- `npm run typecheck`: `tsc --noEmit` over `src/` (the Vite config is excluded; Vite transpiles it).
- `npm run build`: typecheck + production bundle in `dist/`.
- `npm run preview -- --port 5392`: serve `dist/` (the docs use 5392 for the production preview).
- `npm test`: headless suite (real game modules on Babylon's NullEngine with real Havok, about 10 s);
  `npm test -- <name>` runs only matching files. See [tests/AGENTS.md](tests/AGENTS.md).
- `npm run deploy`: build and deploy to Cloudflare (below).

Verification is typecheck, `npm test` and the in-browser self-test (below).

## Deploying

The game deploys as a Cloudflare Worker serving `dist/` as static files. Account-specific settings
(hostname, Worker name, account ID) live in a git-ignored `.env`; copy [.env.example](.env.example).
`wrangler.jsonc` holds only generic settings. `scripts/deploy.mjs` merges the two into
`.wrangler/deploy/wrangler.json` and runs `wrangler deploy` with it. Cache headers are in `public/_headers`.

- **Deploying publishes to the public internet: do it only when the maintainer asks.**
- `npm run deploy -- --dry-run` builds and checks the config and files without uploading. Shell variables
  override `.env`, e.g. `DEPLOY_DOMAIN= npm run deploy -- --dry-run` for the `workers.dev` variant.
- Without `DEPLOY_DOMAIN`, the Worker gets `https://<WORKER_NAME>.<account>.workers.dev`. With it, the
  Worker is served only on that hostname, which must be in a zone on the same account.
- Keep `wrangler.jsonc` to full-line `//` comments: the deploy script strips only those before parsing.
- `npx wrangler whoami` checks the login. Log in with only the scopes a Workers deploy needs; the default
  `wrangler login` also asks for billing, email and more:
  `npx wrangler login --scopes account:read user:read workers:write workers_scripts:write workers_routes:write zone:read ssl_certs:write`
  (`--browser=false` prints the link instead of opening the default browser). The account owner clicks
  Authorize, not the agent.
- The custom-domain route refuses to take over a hostname that already has a DNS record, so a deploy
  can't clobber other sites on the same zone. Never edit the zone's DNS by hand for this project.
- Account-specific deploy notes, if present, are in `AGENTS.local.md` (git-ignored, never committed).
- `npx wrangler delete --name <WORKER_NAME>`: take it down (removes the Worker and its custom-domain
  record).
- `npx wrangler logout`: revoke this machine's Cloudflare login.
- The build uses relative paths (`base: "./"`), so `dist/` works on any static host. It can't be opened
  from `file://`, because browsers block module scripts and the `.wasm` fetch there.

## Code map

| Path | Owns | Guide |
|---|---|---|
| `src/main.ts` | Boot (engine, Havok, camera, `GameContext`), module order, render loop, capture mode | [core](src/core/AGENTS.md) |
| `src/core/` | Contracts (`context.ts`, `events.ts`, `damage.ts`), the one `explode()`, dev tools (`debug.ts`) | [core](src/core/AGENTS.md) |
| `src/world/` | Arena, lighting, sky, fog, shadows, post-processing, props, explosive barrels | [world](src/world/AGENTS.md) |
| `src/fx/` | Particles, tracers, explosion visuals, physical debris | [fx](src/fx/AGENTS.md) |
| `src/player/` | Movement (character controller), camera, viewmodel, rifle, grenades, health, input | [player](src/player/AGENTS.md) |
| `src/enemies/` | Drones, AI, plasma bolts, waves, score, game over | [enemies](src/enemies/AGENTS.md) |
| `src/ui/` | Start/pause/game-over screens, HUD, pointer lock, phase transitions | [ui](src/ui/AGENTS.md) |
| `src/audio/` | WebAudio synth, all sound playback, event→sound wiring | [audio](src/audio/AGENTS.md) |
| `tests/` | Headless Node tests (NullEngine + Havok, DOM stubs) for enemies, world, player, movement | [tests](tests/AGENTS.md) |
| `scripts/deploy.mjs` | Merges `.env` into `wrangler.jsonc` and runs `wrangler deploy` | this file, [Deploying](#deploying) |

Tuning numbers live only in each module's `config.ts` (`player`, `enemies`, `world`, `fx`). Change
numbers there, and point to them from docs instead of copying values.

## Rules for every change

- **Contracts first.** Modules talk only through `ctx.events` and the APIs on `ctx` defined in
  `src/core/context.ts`. Don't import another module's internals. Changing a contract means updating
  every implementer and `src/core/AGENTS.md` in the same change.
- **Babylon 9.38 is newer than most training data.** Import from the barrel (`"@babylonjs/core"`,
  `"@babylonjs/materials"`; deep imports can silently drop side-effect registrations) and check
  signatures in `node_modules/@babylonjs/core/**/*.d.ts` before using an API.
- **Game time, not wall time.** Gameplay delays (fuses, wave timers, cooldowns) count down in
  `ctx.onUpdate`/`ctx.onFrame` with `dt`, never `setTimeout`/`setInterval`, so they pause with the game
  and survive throttled background tabs. Audio voice cleanup and UI animations may use real time.
- **Frame-rate independent.** Scale everything by `dt`, including smoothing (`1 - exp(-k·dt)`, not a
  fixed lerp factor). Many laptops (MacBook Pros included) run at 120 Hz.
- **Pointer events only.** Babylon cancels canvas `pointerdown`, so browsers suppress
  `mousedown/mousemove/mouseup` while a button is held. Never listen for mouse events.
- **Sound ownership.** Gameplay code never calls `ctx.audio.play` (only `explode()` in core does). Emit an
  event; `src/audio` maps events to sounds.
- **Perf budget:** 60 fps on an M2 Pro in Chrome and Safari at 1.5× pixel ratio. Pool anything created
  per shot, share materials, no per-entity lights (emissive + the glow layer instead). See each
  folder's guide for its specific budget.
- **Earn complexity; simplify before finishing.** Add structure only for a present need. Once a change
  works, re-read the diff, remove scaffolding and dead paths, and re-run the checks.

## Verifying a change

1. `npm run typecheck`.
2. `npm test` (or `npm test -- <name>` for the module you changed). It catches logic regressions, not
   rendering.
3. Run the game in a browser. Claude Code's built-in browser pane works here (no sign-in needed).
4. `http://localhost:5391/?selftest=1` plays a scripted 10-second round (rifle, grenades, wave 3,
   kills) and shows a green PASS / red FAIL box. The same report is in `window.selftestReport` and in
   the dev-server log (`[selftest]`).
5. Exercise the feature you changed with the dev options below, usually `?debug=1&god=1&wave=N`.
6. For changes to boot, physics or bundling: `npm run build`, preview, and self-test the production
   build. Run the self-test in **Safari** too (`open -a Safari "http://localhost:5391/?selftest=1"`,
   keep the window in front); WebKit differs from the Chromium-based pane.
7. Say what you could not verify. Only a human can judge feel, the sound mix, real pointer lock, Mac
   trackpad behaviour and the overall look.

Testing pitfalls (all hit on 2026-11-26):
- A hidden or background browser pane throttles `requestAnimationFrame` and timers: FPS numbers drop
  to 1–12 and `whenReadyAsync` can take a minute. Bring the tab to the front before measuring, and
  don't trust FPS from a hidden pane.
- Vite reloads the page on every save. If another agent is editing, your in-page test gets cut off.
  Test against a production build (`dist/` doesn't change) or wait.
- The browser tool's key presses are instant taps; movement needs a held key. Dispatch
  `keydown`, wait, then `keyup` on `document.body` (not `window`) from `javascript_tool`.
- The pane has no pointer lock; the game runs its unlocked fallback there.
- Screenshot coordinates are in the screenshot's frame, not CSS pixels.
- The tool's `grave` key sends an empty `code`, so it can't toggle the free camera. Dispatch
  ``new KeyboardEvent("keydown", { code: "Backquote", key: "`", bubbles: true })`` on `document.body`.
- The preview server (5392) serves `dist/` as of the last `npm run build`, and reads `vite.config.ts`
  only at startup (the `/__selftest` logger lives there). Rebuild after code changes; restart it after
  config changes.
- **Safari:** open pages with `open -a Safari "<url>"` only. `osascript` "tell application Safari" waits on
  a macOS Automation prompt and times out. Safari stops rendering windows that are behind others, so a
  self-test there never reports unless the window is in front. Read its result from the server log
  (`[selftest]`) or ask the user to read the PASS/FAIL box. The `/__selftest` endpoint exists only
  on the dev and preview servers (404 on Cloudflare, ignored by the page).
- **Physics spot checks:** use the highest crate (largest `y`). Lower ones are pinned under stacks and won't
  move, which looks like broken physics.
- **Leak checks:** compare `scene.meshes`, `materials`, `textures`, `particleSystems`, `ctx.dynamicBodies`,
  `ctx.damageables` and `#ui` node counts at the menu with the counts a few seconds after
  `enemies.killAll()`. A small one-time rise after the first drones is expected (templates and materials
  built on first use); growth from wave to wave is a leak. `killAll()` only kills live drones and queued
  spawns keep arriving, so let the counts settle or skip to a high wave first. Baseline (2026-11-26, at
  the menu): 306 meshes, 59 materials, 77 dynamic bodies, 12 damageables; waves 6–13 showed no growth.
- **Bundle size is expected:** the barrel import makes one ~7.6 MB JS chunk (~1.6 MB gzipped) plus ~110
  small Babylon chunks that load only on demand, and Havok's `.wasm` is ~2 MB (~0.6 MB gzipped).

## Dev options (URL)

| Option | Effect |
|---|---|
| `?fps=1` | FPS counter |
| `?sens=1.5` | Look sensitivity multiplier (0.1–10) |
| `?mute=1` | No audio |
| `?dpr=2` | Render pixel ratio (default max 1.5) |
| `?ssao=1` | Ambient occlusion (may halo the viewmodel) |
| `?god=1` | Player takes no damage |
| `?wave=N` | Start at wave N |
| `?debug=1` | Info panel, drone AI labels, physics shapes (`P`), free camera (`` ` ``, WASD/QE, Shift) |
| `?capture=1` | No render loop; `step(n)` advances n × 16 ms of gameplay + physics and renders |
| `?selftest=1` | Unattended 10 s session with a PASS/FAIL report |

Console handles: `window.game` (the `GameContext`), `window.enemies` (`spawn`, `killAll`, `skipTo`),
`window.gameReady`.

## Where knowledge goes

Durable knowledge about this project belongs in the repository, where every agent can find it, not in
personal or auto memory.

- Put concise operating guidance in the **nearest `AGENTS.md`**: non-obvious invariants, contracts other
  modules rely on, why the code is shaped the way it is, fragile APIs, and lessons that stop someone
  repeating a failed approach. Point to the owning file instead of copying constants.
- Update a folder's `AGENTS.md` **in the same change** that alters its contracts or invalidates a lesson.
  Date lessons (`2026-11-26`) and keep the reason behind deliberate exceptions.
- Longer investigations, measurements and experiments go in `docs/` (create it when first needed) with
  the date, method, results and open questions, linked from the relevant `AGENTS.md`.
- Game design (what the game is, not how the code works) goes in `DESIGN.md`.

## Repository status

Public, MIT-licensed ([LICENSE](LICENSE)), with a headless test suite (`npm test`) that must pass before
every commit. Never commit `.env`, `*.local.md`, `dist/`, `.wrangler/`
or anything naming a person, a private domain or a local path: check `git diff --cached` before each
commit. The project was built on 2026-11-26 by a lead agent (core, boot, integration) and four
parallel module agents. Folder guides were written by the agent that built each module.
