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
- Optional account (passwordless email sign-in) that saves coins, trucks, upgrades and missions online, and a verified global leaderboard (all time and this week)
- Sampled engine sound, sound effects for jumps, crashes and every power, and a music track for each scenery

## Controls
- `←` `→` or `A` `D`: change lane
- `↑` `W` `Space`: jump (while Super Jump is active); in the air: barrel roll
- `↓` `S` in the air: backflip
- `P`: pause · `M`: music on/off · `N`: sound effects on/off
- Phone: swipe or tap a side; swipe up or tap JUMP to jump

No build step: `index.html` + `game.js`, built with [three.js](https://threejs.org/) r128 from a CDN.

## Online accounts and leaderboard
Backend: Supabase (Postgres, email auth, Edge Functions). Without configuration the game runs fully offline and saves progress in the browser.

### Security model
- **The browser can't write anything directly.** Game tables live in a private `game` schema that the Data API doesn't expose, with RLS on and no grants to `anon` or `authenticated`. The only database function a browser can call is `get_leaderboard()`, and it returns names and scores only, never emails or ids.
- **Every write goes through an Edge Function** (`supabase/functions/`). Each one:
  - checks an origin allow-list,
  - verifies the user's token,
  - rejects unknown or malformed fields,
  - rate-limits per user,
  - calls a service-role-only SQL function that does the change atomically: wallet row lock plus a coin ledger entry for every change.
- **Scores are checked, not trusted.** The server:
  - records when a run starts,
  - accepts each run exactly once,
  - recomputes the score,
  - rejects runs that are physically impossible (faster than the speed curve allows, more coins than spawn, a bonus that doesn't add up from the stunt counts).

  Rejected runs pay nothing; repeated ones flag the account for review.
- **Coins and unlocks are server-owned** for signed-in players. Guest progress is carried over once, capped at 2,000 coins and 2,500 coins' worth of items, because local storage is editable.
- **Content Security Policy:** no inline scripts, and CDN scripts pinned with Subresource Integrity. Turnstile captcha on sign-in code requests.
- Rules shared by the game and the server (prices, missions, limits) live in one file: `supabase/functions/_shared/rules.js`.

A browser game can't be made fully cheat-proof: someone who studies the checks can submit a run just under every limit. The next step up would be deterministic replays verified on the server.

### Set up
1. Create a Supabase project, then put its URL and publishable (anon) key in `CONFIG` at the top of `online.js`.
2. Install the CLI (`brew install supabase/tap/supabase`), then run `supabase login` and `supabase link --project-ref <ref>`.
3. `supabase db push`. This applies `supabase/migrations/`.
4. `supabase functions deploy`.
5. `TURNSTILE_SECRET=… supabase config push`, and put the Turnstile site key in `online.js`.
6. For more than a handful of sign-ups an hour, set up custom SMTP (for example Resend) in the dashboard. Until then, Supabase's built-in mailer can't use custom templates, so sign-in emails carry a link (the game accepts it). With SMTP set up, uncomment the templates in `supabase/config.toml` and push again, so emails show a 6-digit code instead.

### Tests
- **Database security and logic:**

  ```
  psql -d <scratch db> -f supabase/tests/stub.sql -f supabase/migrations/*.sql -f supabase/tests/security.sql
  ```
- **Run validation and missions:**

  ```
  deno test --allow-read --allow-env=ALLOWED_ORIGINS supabase/functions/_shared/
  ```
- **End to end without Docker:** `supabase/tests/local-server.ts` runs the real function handlers against a local Postgres, with Supabase's auth faked.

All audio is CC0 (public domain). Sources are listed in [audio/CREDITS.md](audio/CREDITS.md).
