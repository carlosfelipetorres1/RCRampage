// deno test supabase/functions/_shared/stripe.test.ts
import { assertEquals } from 'jsr:@std/assert@1.0.13';
import { signForTests, verifyStripeSignature } from './stripe.ts';
import { R } from './game.ts';

const SECRET = 'whsec_test_secret';
const body = JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: 'cs_1' } } });

Deno.test('a correctly signed webhook passes', async () => {
  assertEquals(await verifyStripeSignature(body, await signForTests(body, SECRET), SECRET), true);
});

Deno.test('forged, tampered, stale or unsigned webhooks fail', async () => {
  const sig = await signForTests(body, SECRET);
  assertEquals(await verifyStripeSignature(body, await signForTests(body, 'whsec_other'), SECRET), false);
  assertEquals(await verifyStripeSignature(body.replace('cs_1', 'cs_2'), sig, SECRET), false);
  assertEquals(await verifyStripeSignature(body, await signForTests(body, SECRET, Math.floor(Date.now() / 1000) - 600), SECRET), false);
  assertEquals(await verifyStripeSignature(body, null, SECRET), false);
  assertEquals(await verifyStripeSignature(body, sig, ''), false);
  assertEquals(await verifyStripeSignature(body, 't=123', SECRET), false);
});

Deno.test('a header with several signatures passes if one matches (secret rotation)', async () => {
  const good = await signForTests(body, SECRET);
  const t = good.split(',')[0];
  assertEquals(await verifyStripeSignature(body, `${t},v1=${'0'.repeat(64)},${good.split(',')[1]}`, SECRET), true);
});

Deno.test('shop prices match the database seed', async () => {
  const sql = await Deno.readTextFile(new URL('../../migrations/20261127000000_shop.sql', import.meta.url));
  for (const c of R.catalog().filter((c: { kind: string }) => c.kind === 'skin' || c.kind === 'coins')) {
    const m = sql.match(new RegExp(`'${c.item_id}',\\s*'\\w+',\\s*(\\w+),\\s*(\\w+),\\s*(\\w+)`));
    const num = (v?: string) => (v === 'null' || v === undefined ? null : Number(v));
    assertEquals([num(m?.[1]), num(m?.[2]), num(m?.[3])], [c.price, c.cents, c.coins ?? null], c.item_id);
  }
});
