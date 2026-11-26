# UI

The HTML/CSS overlay: the start, pause and game-over screens, the in-game HUD, and the phase and pointer-lock state machine. It is plain DOM inside `ctx.uiRoot` (`#ui`, which is `pointer-events: none`), with no framework and nothing drawn on the canvas. It reads gameplay only through `ctx.events`, `ctx.state`, `ctx.camera` and `ctx.player`. It is the only module that sets the phase to `playing` or `paused`; src/enemies sets `gameover`. The entry point is `createUi(ctx)` in `index.ts`, which `main.ts` creates last. Event payloads and the phase list are core contracts ([core](../core/AGENTS.md)); this guide covers what the UI does with them.

## Code map

- `index.ts`: mounts `.ss-root` and imports `ui.css`. It owns `sync()`, which writes `data-phase` on the root and tells the screens, and runs `sync()` and `hud.frame()` every frame. It also owns the `?fps=1` readout.
- `screens.ts`: the three screens, every phase transition, and the pointer-lock rules below.
- `hud.ts`: every HUD element, one block each, each with its own subscriptions. Constants copied from other modules are at the top.
- `dom.ts`: `Txt` and `Flag`, which write to the DOM only when the value changes, plus `el`, `q`, `fmt` and `clamp`.
- `ui.css`: all styling. The tokens (`--ss-amber`, the font stacks, the text shadow) are on `.ss-root`.

## Contracts

- **Phase transitions** all live in `screens.ts`. Each one checks the current phase (a call from the wrong phase does nothing), sets `state.phase`, calls `hooks.sync()`, then emits its event.
  - **Deploy** (the button, or Enter in `menu`): `audio.unlock()`, request the lock, set `playing`, emit `game:start`. The unlock and the lock request need the user gesture, so they run synchronously inside the handler.
  - **Pause and resume:** losing the lock while `playing` sets `paused` and emits `game:pause`; regaining it while `paused` sets `playing` and emits `game:resume`. Resume follows `pointerlockchange`, not the click: clicking the pause screen (or Enter) only asks for the lock.
  - **Game over:** on `game:over`, exit the lock, set `gameover` if the emitter hasn't already, and show the screen after `GAMEOVER_DELAY_MS`. Play again (or Enter) reloads the page, because the modules aren't written to restart in place.
  - **Changes made elsewhere** are picked up by the per-frame `sync()` poll: the `gameover` set by src/enemies, and `?selftest=1`, which sets `playing` and emits `game:start` itself, with no audio unlock and no lock. Keep the poll.
- **Refused lock.** A refusal is reported twice, by `pointerlockerror` and by the rejected promise, so `onLockError` drops the duplicate.
  - While `paused`: show the hint and wait for another click (browsers refuse a re-lock for about a second after Esc). If refusals keep coming after `RELOCK_COOLDOWN_MS`, resume unlocked rather than trap the player.
  - In `menu` or `playing`: switch to the unlocked fallback.
- **Unlocked fallback** (`lockBroken`: no Pointer Lock API, or the lock was refused). The game runs, but nobody can look around, because the player reads mouse look only under the lock (`player/input.ts`). Esc and window `blur` pause; clicking the pause screen resumes at once; a `pointerdown` on the canvas retries the lock, and getting it leaves the fallback. A toast says so, once per page.
- **Which event drives which HUD element** (`hud.ts`):
  - `weapon:fire`: crosshair bloom for the rifle, a kick for the launcher. The gap is the spread cone projected through `ctx.camera.fov`.
  - `hit` (enemy or barrel): the hitmarker. When `killed`, it is red and bigger, and plain hits don't replace it until its pop ends.
  - `player:damaged`: health, the edge flash, and a direction arc when `from` is set. The arc's angle is recomputed every frame from `ctx.camera`, so it swings as you turn. `player:healed` updates health only. Starting health comes from `ctx.player`.
  - `ammo:changed`: the count and its low/empty state. The reload bar starts on `weapon:reload` or on `ammo:changed` with `reloading: true`, runs a fixed `RELOAD_SECONDS` animation, and hides only when `ammo:changed` reports `reloading: false`.
  - `weapon:empty`: shakes the ammo count or the pips. `launcher:changed`: the pips (rebuilt if `maxCharges` changes).
  - `wave:start`: the wave number and its banner. `wave:cleared`: the banner with the bonus. `score:changed`: the score.
  - `enemy:killed`: a points popup at `position`, projected through `ctx.camera`, or beside the crosshair when that point is off-screen.
- **Scope and layering.** Every class and keyframe name starts with `ss-`, the tokens are `--ss-*`, and nothing styles bare elements or `#ui`. Pointer events come back only on `.ss-screen.is-visible .ss-btn` and `.ss-pause.is-visible`. The HUD shows only under `.ss-root[data-phase="playing"]`. The UI sets no z-index; core's `?debug=1` overlay (z-index 50) and the self-test report sit above it, outside `#ui`.
- **Cheap DOM.**
  - Text goes through `Txt` and classes through `Flag`.
  - Per-frame code writes only transforms, opacity and CSS variables, and only when the rounded value changes. Nothing reads layout per frame; the viewport size is cached on resize.
  - One-shot effects (hitmarker, flash, banners, popups, toast, number bumps) use `el.animate()` on pooled elements. That avoids forcing a reflow to restart a CSS animation and avoids creating an element per event.

## Changing it safely

- **New HUD element:** put its markup in the `hud.ts` template inside `.ss-hud`, so phase visibility comes for free. Give it its own block and subscriptions, and write through `Txt` and `Flag`.
- **Clickable elements:** turn pointer events on only while the element's screen has `.is-visible`. A fading screen that still takes clicks swallows the player's first shot.
- **Pointer input:** never listen for `mousedown`, `mousemove` or `mouseup` on the canvas. Babylon calls preventDefault() on canvas `pointerdown`, so browsers suppress those compatibility events. Use pointer events.
- **User gestures:** keep `audio.unlock()` and `requestLock()` synchronous inside the click or keydown handler, never after an `await` or a timer.
- **Copied numbers:** the crosshair's `SPREAD_*` constants and `RELOAD_SECONDS` copy `RIFLE` in `player/config.ts`; if those change, change these too. The moving penalty is not a copy: the HUD ramps it in from walking speed, while the rifle applies it only above `RIFLE.fastSpeed` or in the air, so the crosshair reads wider than the real spread when walking (found 2026-11-26, not fixed).
- **New phase transition:** follow the pattern (check the phase, set it, `hooks.sync()`, emit), and decide what the transition does with the lock.

## Lessons (2026-11-26)

- **`mousedown` never fired.** The fallback canvas listener first used `mousedown` and got nothing (see Pointer input); the lead switched it to `pointerdown`. The player module hit the same trap with firing.
- **Wall-clock animations.** WAAPI and CSS animations run on real time. Under `?capture=1`, the banners, popups, hitmarker and game-over delay don't follow `step()`. The crosshair and damage arcs do, because they advance in `onFrame`.
- **Self-test toast.** `?selftest=1` dispatches synthetic `pointerdown`s on the canvas, so the fallback listener asks for the lock. With no user gesture behind it, that is presumably refused, which switches to the fallback and shows the toast in the report. This is harmless and has not been observed.

## Verify

- **What an agent can check:**
  - The browser pane has no pointer lock, so it always runs the unlocked fallback. The pause flow worked there on 2026-11-26, and the HUD fit at 960×540.
  - Wait for `window.gameReady` before clicking Deploy: the start screen accepts clicks while shaders are still compiling.
  - `?selftest=1` shows the HUD without the Deploy click; `?fps=1` adds the readout.
- **What needs a human:**
  - Real pointer lock has never been tested by an agent: capture on Deploy, Esc to pause, the refusal hint on a quick re-click, re-locking to resume, and alt-tab. Try it in Chrome, Safari and Firefox.
  - Readability over the bright sky, and the fonts (DIN Alternate on macOS, Bahnschrift on Windows, fallbacks elsewhere).
