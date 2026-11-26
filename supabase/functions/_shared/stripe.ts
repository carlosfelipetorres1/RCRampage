// Minimal Stripe REST client and webhook signature check (no SDK, no extra dependencies).
import { HttpError } from './http.ts';


// deno-lint-ignore no-explicit-any
export async function stripe(path: string, form: Record<string, string>): Promise<any> {
  const key = Deno.env.get('STRIPE_SECRET_KEY');
  if (!key) throw new HttpError(503, 'payments_unavailable');
  const api = Deno.env.get('STRIPE_API_BASE') ?? 'https://api.stripe.com/v1/';   // overridable for local tests
  const res = await fetch(api + path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form),
  });
  const json = await res.json();
  if (!res.ok) { console.error('stripe', res.status, json?.error?.message); throw new HttpError(502, 'payments_unavailable'); }
  return json;
}

const enc = new TextEncoder();
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
function sameText(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// Stripe-Signature: t=<unix>,v1=<hex hmac of "t.payload">[,v1=...]. Reject anything older than 5 minutes.
export async function verifyStripeSignature(payload: string, header: string | null, secret: string, now = Date.now() / 1000): Promise<boolean> {
  if (!header || !secret) return false;
  const parts = header.split(',').map((p) => p.trim().split('='));
  const t = Number(parts.find(([k]) => k === 't')?.[1]);
  const sigs = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!Number.isFinite(t) || !sigs.length || Math.abs(now - t) > 300) return false;
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const want = hex(await crypto.subtle.sign('HMAC', key, enc.encode(`${t}.${payload}`)));
  return sigs.some((s) => sameText(s, want));
}

export async function signForTests(payload: string, secret: string, t = Math.floor(Date.now() / 1000)) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return `t=${t},v1=${hex(await crypto.subtle.sign('HMAC', key, enc.encode(`${t}.${payload}`)))}`;
}
