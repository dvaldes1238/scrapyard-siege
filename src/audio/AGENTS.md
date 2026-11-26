# Audio

Every sound in the game, synthesized with WebAudio at the moment it plays; there are no audio files. The module implements `AudioApi` (`ctx.audio`) and also owns triggering: `wireEvents` in `index.ts` subscribes to gameplay events and plays the matching sound (the ownership rule itself is in [core](../core/AGENTS.md)). The only outside caller is `explode()` in core, so nothing here listens to `explosion`. The entry point is `createAudio(ctx)`, which `main.ts` creates first.

## Code map

- `index.ts`: builds the engine (`?mute=1` zeroes the master) and resumes a suspended context on any `pointerdown` or `keydown`. It holds `wireEvents`, the single table from events to sounds, with its throttles, the kill-streak pitch, and volumes taken from payloads (landing speed, damage amount).
- `engine.ts`: `AudioEngine`. The lazy context, the mix graph, the generated reverb impulse, noise buffers and saturation curve, positional sound, and the voice cap with stealing.
- `voice.ts`: `Voice`, the builder a recipe draws into. Sources (`osc`, `noise`), `filter`, `shaper`, envelopes (`perc`, `ahr`, `grains`), `sweep`, and `route()` into the voice input.
- `sounds.ts`: `RECIPES`, one `Recipe` per `SoundId`: level, priority, reverb send, pitch jitter, distance falloff, and `build(v)`. Shared layers (`metalClick`, `gravel`, `ding`) are at the top.

## Contracts

- **Lazy, and never queued.** No AudioContext exists until `unlock()`, which the UI calls from the Deploy and resume clicks. Until then, and whenever the context isn't `running`, `play()` drops the sound instead of queueing it. `?selftest=1` starts the game without the Deploy click, so it plays nothing.
- **Signal path.**
  - Each voice: input (its level) → optional lowpass → optional stereo panner → dry bus → master gain → compressor → speakers.
  - Each voice also sends (recipe `reverb`) into one shared convolver → band-limit filters → return → master.
  - A voice's nodes are created per play and disconnected by a timer at its `end`. The noise buffers, the impulse and the saturation curve are generated once, at unlock.
- **Positional sounds** only happen when `opts.position` is given: `enemyShot`, and `explosion` from core. Panning, falloff (recipe `refDistance` and `rolloff`) and the lowpass for distant and behind-you sources are computed once, at start, from `ctx.camera`'s world matrix. Moving sources are not tracked, and the `?debug=1` free camera does not move the listener.
- **Voice cap.** With `MAX_VOICES` voices playing, a new sound steals the lowest-priority, oldest voice (with a short fade), or is dropped if every playing voice outranks it. Game-state cues have the highest priorities; footsteps and the hum the lowest.
- **Pitch.** `opts.pitch`, times the recipe's random jitter, scales the oscillators, the noise playback rate and the filter cutoffs together, so a recipe transposes as a whole. The jitter is what keeps full-auto rifle fire from sounding mechanical.
- **Timing tied to other modules.**
  - The `reload` recipe fits its two clicks and charge-up inside the rifle's reload (`RIFLE.reloadTime` in `player/config.ts`). It always plays to the end, so a reload cancelled by death still finishes its clicks.
  - `land` gets louder with `impactSpeed`. The player only emits it above `PLAYER.landEventMinSpeed`, so the floor in `wireEvents` almost never applies.
- **Not triggered:** `enemyHum` has a recipe but nothing plays it. `switch` is wired to `weapon:switch`, which nothing emits yet.

## Changing it safely

- **New sound:**
  1. Add the id to `SoundId` in `core/context.ts`. That is a core contract, so ask the lead.
  2. Add its recipe; TypeScript then requires one for every id.
  3. Trigger it from `wireEvents`, never from a gameplay module. Throttle any event that can arrive in bursts, as `hitGate`, `hurtGate` and the kill de-dupe do.
- **Recipes:** build only through `Voice` helpers.
  - The helpers register every source, so voice stealing can stop it, and they extend `end`, so cleanup waits for the tail.
  - Exponential ramps cannot reach 0, which is why envelopes fade to a floor (`SILENCE`).
  - Keep each recipe to a handful of sources: the rifle starts many voices a second.
- **Levels are unreviewed.** Every recipe `gain`, every layer level, `MASTER_LEVEL` and `REVERB_RETURN` was set on 2026-11-26 by estimate, followed by a rebalance worked out on paper. Nobody has listened to them yet.
  - Tune by ear, not by the numbers. A narrow bandpass keeps only a small slice of the noise's energy, so a filtered layer can be quiet even at a high level.
  - Change a recipe's `gain` before touching the master, and leave the compressor to catch peaks.

## Lessons (2026-11-26)

- **Quiet filtered layers.** The first pass had several band-limited noise layers that were close to inaudible: the rifle crack, the launcher tube, the explosion crackle, gravel, the reload slide and the jump whoosh. A rebalance raised them, again on paper only.
- **Dropping beats queueing.** Sounds are dropped while the context isn't running on purpose: queued sounds from a suspended tab would all play at once when it resumes.
- **Unaffected by Babylon's preventDefault.** The wake listeners are capture-phase listeners on `window`, so Babylon's preventDefault on canvas `pointerdown` doesn't affect them.

## Verify

- **What an agent can check:** that the module typechecks. After a real Deploy click, `game.audio.play("explosion", { position: game.camera.position })` in the console should throw nothing and leave the console clean. An agent cannot hear the output, and cannot unlock the context without a real user gesture.
- **What needs a human** (not done as of 2026-11-26): listen on headphones and on laptop speakers.
  - The overall balance, and whether full-auto rifle fire gets tiring.
  - Explosions should sit above everything else; check the amount of reverb.
  - Footstep and landing loudness, and the reload clicks against the reload animation.
  - Panning: a drone firing on your right is heard on the right, and one behind you sounds duller.
