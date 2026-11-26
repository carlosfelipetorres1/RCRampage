// Open a Stripe Checkout page for a real-money item (coin pack or premium skin).
// Nothing is granted here: the stripe-webhook function does that once Stripe confirms payment.
import { ALLOWED_ORIGINS, HttpError, is, rpc, serveUser, shape } from '../_shared/http.ts';
import { loadState, R } from '../_shared/game.ts';
import { stripe } from '../_shared/stripe.ts';

const PAID = R.catalog().filter((c: { cents: number | null }) => c.cents);
const NAMES: Record<string, string> = Object.fromEntries(PAID.map((c: { item_id: string; kind: string; coins?: number }) => {
  const skin = R.SKINS.find((s: { id: string }) => 'skin:' + s.id === c.item_id);
  return [c.item_id, skin ? `${skin.name} skin` : `${c.coins!.toLocaleString('en')} coins`];
}));

serveUser('checkout', { rate: [10, 60] }, async ({ user, body, origin }) => {
  const b = shape<{ item: string; returnPath: string }>(body, {
    item: is.oneOf(PAID.map((c: { item_id: string }) => c.item_id)),
    returnPath: (v) => typeof v === 'string' && /^\/[A-Za-z0-9/_.-]{0,80}$/.test(v) && !v.includes('..') && !v.startsWith('//'),
  });
  await loadState(user.id);                                   // refuses banned accounts
  const cents = await rpc<number>('rc_check_purchasable', { p_uid: user.id, p_item: b.item });
  // Send the player back to the site they came from (only ever an allow-listed origin).
  const base = (origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]) + b.returnPath;

  const session = await stripe('checkout/sessions', {
    mode: 'payment',
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': R.CURRENCY,
    'line_items[0][price_data][unit_amount]': String(cents),
    'line_items[0][price_data][product_data][name]': `RC Rampage: ${NAMES[b.item]}`,
    client_reference_id: user.id,
    'metadata[uid]': user.id,
    'metadata[item]': b.item,
    'payment_intent_data[metadata][uid]': user.id,
    'payment_intent_data[metadata][item]': b.item,
    ...(user.email ? { customer_email: user.email } : {}),
    success_url: `${base}?purchase=success`,
    cancel_url: `${base}?purchase=cancel`,
  });
  if (typeof session.url !== 'string') throw new HttpError(502, 'payments_unavailable');
  return { url: session.url };
});
