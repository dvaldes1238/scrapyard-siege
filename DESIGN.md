# Scrapyard Siege — design doc

What the game is. How to work in the code (architecture, rules, commands, deploying, dev options)
is in [AGENTS.md](AGENTS.md) and the folder guides it links.

A small browser FPS demo built with **Babylon.js 9.38 + Havok physics + TypeScript + Vite**.
Goal: show off what a browser game can do — good-looking lighting, physics you can mess with, and a
tight shooting loop — in a single arena you can play for 5–10 minutes.

**Pitch:** golden hour in an abandoned scrapyard. Waves of hover drones pour over the walls. You have a
pulse rifle with an under-barrel kinetic grenade launcher. Everything that isn't bolted down — crates,
drums, explosive barrels, drone wreckage — reacts to bullets and blasts. Chain the barrels.

## Controls
| Input | Action |
|---|---|
| Mouse | Look (pointer lock) |
| WASD | Move |
| Shift | Sprint |
| Space | Jump |
| Left mouse (hold) | Pulse rifle, full auto |
| Right mouse | Under-barrel kinetic grenade |
| Ctrl+click / two-finger click | Grenade (Mac trackpad right-click) |
| R | Reload |
| Esc | Pause (browser releases pointer lock) |

## Enemies and waves
Three hover-drone types: **seekers** orbit you and fire plasma bolts, **bombers** dive in and
detonate, **brutes** are slow armoured bosses that fire bursts. Wave 1 starts 2 s after deploying;
seekers every wave, bombers from wave 3, brutes on every 5th wave (+1 from wave 8); at most 12 drones
alive at once; clearing a wave pays a bonus that grows with the wave. Exact numbers live in
`src/enemies/config.ts`.

Explosive barrels, grenades and dying drones all use the same blast, so they chain into each other.

## Look
Golden-hour sun (low, warm), long soft shadows, hazy fog, bloom on emissives, ACES tone mapping,
subtle grain/vignette/chromatic aberration. Scrapyard palette: rusty containers (oxide red, teal,
mustard), weathered concrete, worn wood crates, red hazard barrels, blue drums; drones are dark
gunmetal with glowing eyes (seeker cyan, bomber orange, brute red). HUD: clean, industrial, off-white
text with amber accent `#ffb547`, tabular numerals.
