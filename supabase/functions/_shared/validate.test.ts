// deno test supabase/functions/_shared/validate.test.ts
import { assertEquals, assertNotEquals, assertThrows } from 'jsr:@std/assert@1.0.13';
import { judge, parseReport, scoreOf } from './validate.ts';
import { R } from './game.ts';

// A real run recorded from the test bot (city only, 41 s of play).
const legit = () => ({
  runId: '7c1f3a52-1111-4a8b-9c3d-2b6f0e9d1a00',
  version: R.GAME_VERSION,
  dist: 729.53, coins: 80, bonus: 1830, playTime: 41.2, crash: 'flip',
  stats: {
    roofs: 3, ramps: 3, bumps: 2, powers: 2, superJumps: 0, smashes: 2, bigAir: 0, nearMiss: 2,
    tricks: 5, maxMult: 5, crushed: 0, bins: 0, themes: ['city'], themeCoins: { city: 80 },
  },
});

Deno.test('a real run passes', () => {
  const r = parseReport(legit());
  assertEquals(judge(r, 52), null);
  assertEquals(scoreOf(r), 729 + 800 + 1830);
});

Deno.test('request shape is strict', () => {
  assertThrows(() => parseReport({ ...legit(), score: 999999 }));                 // unknown field
  assertThrows(() => parseReport({ ...legit(), coins: 1.5 }));
  assertThrows(() => parseReport({ ...legit(), runId: 'not-a-uuid' }));
  assertThrows(() => parseReport({ ...legit(), crash: 'teleport' }));
  assertThrows(() => parseReport({ ...legit(), stats: { ...legit().stats, cheat: 1 } }));
  assertThrows(() => parseReport({ ...legit(), stats: { ...legit().stats, themes: ['moon'] } }));
  const { dist: _d, ...noDist } = legit();
  assertThrows(() => parseReport(noDist));
});

const reject = (patch: (r: ReturnType<typeof legit>) => void, wall = 52) => {
  const r = legit(); patch(r);
  return judge(parseReport(r), wall);
};

Deno.test('impossible runs are rejected', () => {
  assertEquals(reject((r) => { r.version = 1; }), 'old game version');
  assertEquals(reject((r) => { r.playTime = 9000; }, 9000), 'play time out of range');
  assertEquals(reject(() => {}, 20), 'played longer than the run existed');
  assertEquals(reject((r) => { r.dist = 5000; }), 'too fast');
  assertEquals(reject((r) => { r.coins = 400; r.stats.themeCoins.city = 400; }), 'too many coins');
  assertEquals(reject((r) => { r.coins = 70; }), 'coin stats mismatch');
  assertEquals(reject((r) => { r.bonus = 99999; }), 'bonus doesn\'t add up');
  assertEquals(reject((r) => { r.bonus = 10; }), 'bonus doesn\'t add up');
  assertEquals(reject((r) => { r.stats.maxMult = 9; }), 'bad combo');
  assertEquals(reject((r) => { r.stats.tricks = 200; r.bonus = 200 * 100 * 5; }), 'too many tricks');
  assertEquals(reject((r) => { r.stats.ramps = 500; }), 'too many stunts');
  assertEquals(reject((r) => { r.stats.smashes = 9; r.bonus += 7 * 100 * 5; }), 'too many smashes');
});

Deno.test('fastest possible time matches the speed curve', () => {
  // with Nitro the whole way the truck tops out at 46.5 m/s
  const t = R.minTimeForDist(10000);
  assertEquals(Math.round(t), Math.round(Math.log(31 / 14) / (0.011 * 1.5) + (10000 - 1545.45) / 46.5));
  assertEquals(R.minTimeForDist(0), 0);
});

Deno.test('missions settle like the game does', () => {
  const missions = [
    { type: 'dist', goal: 500, reward: 50, base: 0, done: false },
    { type: 'coinsTotal', goal: 250, reward: 120, base: 100, done: false },
    { type: 'crash', goal: 1, reward: 75, base: 0, done: false },
  ];
  const live = { ...legit().stats, coins: 80, dist: 729.53, score: 3359, newCrash: false };
  const { reward, done } = R.settleMissions(missions, live);
  assertEquals([reward, done], [50, 1]);
  assertEquals(missions[1].base, 180);                    // total folded in, not done yet
  assertEquals(missions[2].done, false);
  assertEquals(R.settleMissions(missions, { ...live, newCrash: true }).reward, 75 + 120);
});

Deno.test('mission refill only makes valid missions', () => {
  let n = 0;
  const rng = () => ((n = (n * 9301 + 49297) % 233280) / 233280);
  for (let i = 0; i < 200; i++) {
    const ms = R.fillMissions([], i % 40, i % 11, rng);
    assertEquals(ms.length, 3);
    assertEquals(new Set(ms.map((m: { type: string }) => m.type)).size, 3);
    for (const m of ms) assertEquals(R.validMission(m), true);
  }
  assertEquals(R.validMission({ type: 'dist', goal: 500, reward: 9999, base: 0, done: false }), false);
});

Deno.test('catalog prices match the database seed', async () => {
  const sql = await Deno.readTextFile(new URL('../../migrations/20261126000000_init.sql', import.meta.url));
  for (const t of R.TRUCK_IDS) {
    const m = sql.match(new RegExp(`'truck:${t}',\\s*'truck',\\s*(\\d+)`));
    assertEquals(Number(m?.[1]), R.TRUCK_PRICE[t], t);
  }
  assertNotEquals(sql.indexOf(`array[${R.UPG_COST.join(',')}]`), -1);
});
