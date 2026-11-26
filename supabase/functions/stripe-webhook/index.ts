// Stripe calls this when a payment succeeds, is refunded or is disputed. It is the only place that
// grants real-money items. Every call must carry a valid Stripe signature; each Checkout session
// pays out once (Stripe retries are no-ops), and the amount must match the catalog price.
import { HttpError, rpc, serveRaw } from '../_shared/http.ts';
import { verifyStripeSignature } from '../_shared/stripe.ts';

const json = (status: number, data: unknown) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

serveRaw('stripe-webhook', async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
  const payload = await req.text();
  if (payload.length > 256 * 1024) return json(413, { error: 'too_large' });
  const ok = await verifyStripeSignature(payload, req.headers.get('Stripe-Signature'), Deno.env.get('STRIPE_WEBHOOK_SECRET') ?? '');
  if (!ok) return json(400, { error: 'bad_signature' });

  let event;
  try { event = JSON.parse(payload); } catch { return json(400, { error: 'bad_json' }); }
  const obj = event?.data?.object ?? {};
  try {
    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded': {
        if (obj.payment_status !== 'paid') return json(200, { ignored: 'not_paid_yet' });
        const uid = obj.metadata?.uid, item = obj.metadata?.item;
        if (!uid || !item || uid !== obj.client_reference_id) return json(200, { ignored: 'not_ours' });
        const result = await rpc<string>('rc_grant_purchase', {
          p_uid: uid, p_session: obj.id, p_payment_intent: obj.payment_intent ?? null,
          p_item: item, p_amount: obj.amount_total, p_currency: obj.currency,
        });
        console.log('grant', obj.id, item, result);
        return json(200, { result });
      }
      case 'charge.refunded':
      case 'charge.dispute.created': {
        const pi = obj.payment_intent;
        if (!pi) return json(200, { ignored: 'no_payment_intent' });
        const result = await rpc<string>('rc_revoke_purchase', { p_payment_intent: pi });
        console.log('revoke', pi, event.type, result);
        return json(200, { result });
      }
      default:
        return json(200, { ignored: event.type });
    }
  } catch (e) {
    // A business-rule refusal (e.g. amount_mismatch) won't get better on retry: log and accept.
    if (e instanceof HttpError) { console.error('stripe-webhook refused', event.type, obj.id, e.code); return json(200, { refused: e.code }); }
    console.error('stripe-webhook', e);
    return json(500, { error: 'server_error' });                // Stripe retries
  }
});
