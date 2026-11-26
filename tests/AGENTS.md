# Tests

Headless tests: the real `src/` modules on Babylon's `NullEngine` (no GPU) with real Havok WASM, run
by Node's built-in TypeScript support (no bundler, no test framework). They cover gameplay logic and
physics: waves, AI envelope, kill credit, weapons, input gates, movement, props, barrel chains,
debris caps and leaks. They do not cover rendering, the look, sound, feel or real pointer lock; use the
browser checks in the root guide for those.

## Running

- `npm test` runs every `*.test.ts`, each in its own Node process; `npm test -- player` runs the files
  whose name contains "player". The whole suite takes about 10 s.
- One file directly: `node --experimental-transform-types --import ./tests/support/register.mjs tests/world.test.ts`.
- `LEAD_EXP=1 npm test -- enemies` re-runs the drone aim-lead experiment (see `src/enemies/AGENTS.md`).
- Tests are not type-checked (`tsconfig.json` covers `src/` only). Node strips types without checking.

## Code map

- `run.mjs`: finds the test files, runs them in sequence and prints a PASS/FAIL summary; non-zero exit
  on any failure.
- `support/register.mjs` + `support/resolve-ts.mjs`: a resolve hook so `src/`'s Vite-style
  extensionless imports (`./config`) find `config.ts` or `index.ts`.
- `support/dom.ts`: just enough browser globals (window, document, canvas, 2D context, OffscreenCanvas,
  `location.search` from `QS`) plus `pointer()`, `key()`, `dispatch()` and `setPointerLock()` to drive
  input.
- `support/headless.ts`: `bootHeadless()` (engine, Havok, camera, a `GameContext` with recorded sounds,
  and `step(n)` mirroring `main.ts`'s tick), `check()`, `section()`, `finish()`, `consoleErrors`.
- `world.test.ts` (world + fx), `enemies.test.ts`, `player.test.ts`, `movement.test.ts` (step-up).

## Writing a test

- Import `./support/headless.ts` (or `./support/dom.ts`) **before any `src/` module**: some modules read
  `location.search` while loading, and ES imports evaluate in order.
- Create the real module under test and mock the rest of `ctx` (`fx`, `world`, `player`) with plain
  objects that count calls. The existing files show the shapes.
- Advance time only with `step(n)`: it runs `onFrame`/`onUpdate` at a fixed 1/60 s, steps physics through
  `scene.render()`, and moves the fake `performance.now()` clock that input gates read.
- Take expected values from the module's `config.ts` (for example `waveComposition`, `PLAYER.sprintSpeed`),
  never copied literals, so retuning doesn't break tests for no reason.
- End with `finish()`. Check `consoleErrors` too: `src/` reports errors it catches through `console.error`.
- Prove a new check can fail: break the behaviour on purpose, run, restore (2026-11-26: undoing the
  start-gate fix made 4 player checks fail).

## Pitfalls (2026-11-26)

- `NullEngine.getDeltaTime()` is about 0, so physics would barely move; `bootHeadless` pins it to 1/60 s.
- `src/` uses TypeScript parameter properties, so Node needs `--experimental-transform-types`, not just
  type stripping. Type-only imports must use `import type`, or Node fails at runtime.
- Pointer events must bubble canvas → document → window (`pointer()` does this): the player listens on
  `document` for presses and on `window` for releases.
- Scenario order matters inside one file: a grenade fired early in the player test blew the target
  crate away and broke a later check. Keep destructive steps at the end, or reset what they touch.
- Only `world.test.ts` uses the real arena. The others build small mock scenes, so their positions
  are arbitrary and say nothing about the real layout.
