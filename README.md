# RC Rampage

A 3D endless runner in the browser. Drive a remote-control monster truck through three lanes of traffic, jump off trailer ramps and road-work bumps, ride on car roofs, collect coins and unlock super powers.

**Play:** https://carlosfelipetorres1.github.io/RCRampage/

## Features
- Coins go into a bank you spend in the garage: unlock trucks (Bulldog 150, Shark 300, Night Howler 500), each with its own perk, and upgrade how long each super power lasts
- Three missions at a time (e.g. "Land on 4 car roofs in one run") that pay coins and get harder as you complete them
- Super powers that unlock with score: Super Jump (250), Coin Magnet (600), Shield (1,000), Nitro (1,600)
- Roadside scenery that changes at random: city, farmland, suburbs and a monster truck show
- Each scenery has its own traffic: lane-changing cars with blinkers (city), tractors with hay wagons and crossing cows (farmland), school buses and trash bins to bash (suburbs), junk cars to crush and dirt ramps (truck show)
- Combos: stunts and near misses in a row raise a ×2–×5 score multiplier
- Air tricks: barrel roll and backflip, but land them or you crash
- Day/night cycle, rain, and random events: train crossings to jump and police roadblocks
- 10 random crash styles (Flipped, Shattered, Sent to orbit, Ball pit, Pancaked, Wheels off, Kaboom, Pixelated, Ghosted, Popped), with a counter of the ones you've found
- Sampled engine sound, sound effects for jumps, crashes and every power, and a music track for each scenery

## Controls
- `←` `→` or `A` `D`: change lane
- `↑` `W` `Space`: jump (while Super Jump is active); in the air: barrel roll
- `↓` `S` in the air: backflip
- `P`: pause · `M`: music on/off · `N`: sound effects on/off
- Phone: swipe or tap a side; swipe up or tap JUMP to jump

Single `index.html`, built with [three.js](https://threejs.org/) r128 from a CDN. No build step.

All audio is CC0 (public domain). Sources are listed in [audio/CREDITS.md](audio/CREDITS.md).
