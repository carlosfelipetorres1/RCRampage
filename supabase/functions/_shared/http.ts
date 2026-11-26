// Shared request handling for every RC Rampage function:
// CORS allow-list, POST-only, size-capped strict JSON, JWT check, per-user rate limit, error mapping.
import { createClient, type SupabaseClient, type User } from 'npm:@supabase/supabase-js@2.118.0';

export const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') ??
  'https://carlosfelipetorres1.github.io,http://localhost:8777').split(',').map(s => s.trim()).filter(Boolean);
const MAX_BODY = 16 * 1024;

// Set only by supabase/tests/local-server.ts, which runs these handlers against a local Postgres.
// deno-lint-ignore no-explicit-any
const testHooks = (): any => (globalThis as any).__rcTest;

let client: SupabaseClient | null = null;
// Service-role client, created on first use (keeps the pure modules importable in tests).
export function admin(): SupabaseClient {
  client ??= testHooks()?.admin ?? createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false, autoRefreshToken: false } });
  return client!;
}

export class HttpError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}

function corsHeaders(origin: string | null): Record<string, string> {
  const h: Record<string, string> = {
    'Vary': 'Origin',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
    h['Access-Control-Allow-Headers'] = 'authorization, apikey, content-type, x-client-info';
    h['Access-Control-Max-Age'] = '86400';
  }
  return h;
}

export type Ctx = { user: User; body: Record<string, unknown>; origin: string | null };
type Opts = { rate: [max: number, windowSeconds: number] };

// Wrap a handler with all the checks. The handler returns a JSON-able value or throws HttpError.
export function serveUser(name: string, opts: Opts, handler: (ctx: Ctx) => Promise<unknown>) {
  const serve = async (req: Request): Promise<Response> => {
    const origin = req.headers.get('Origin');
    const headers = corsHeaders(origin);
    const reply = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers });
    try {
      // Browsers always send Origin on cross-site POSTs; refuse ones from other sites outright.
      if (origin && !ALLOWED_ORIGINS.includes(origin)) throw new HttpError(403, 'origin_not_allowed');
      if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
      if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed');

      const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
      if (!token) throw new HttpError(401, 'not_signed_in');
      const { data, error } = await admin().auth.getUser(token);
      if (error || !data?.user) throw new HttpError(401, 'not_signed_in');
      const user = data.user;

      const raw = await req.text();
      if (raw.length > MAX_BODY) throw new HttpError(413, 'too_large');
      let body: unknown = {};
      if (raw) { try { body = JSON.parse(raw); } catch { throw new HttpError(400, 'bad_json'); } }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'bad_body');

      const allowed = await rpc<boolean>('rc_hit_rate_limit', {
        p_key: `${name}:${user.id}`, p_max: opts.rate[0], p_window_seconds: opts.rate[1],
      });
      if (!allowed) throw new HttpError(429, 'slow_down');

      return reply(200, await handler({ user, body: body as Record<string, unknown>, origin }));
    } catch (e) {
      if (e instanceof HttpError) return reply(e.status, { error: e.code });
      console.error(name, e);
      return reply(500, { error: 'server_error' });
    }
  };
  if (testHooks()) testHooks().register(name, serve); else Deno.serve(serve);
}

// A server-to-server endpoint with no user (the Stripe webhook). The handler does its own checks.
export function serveRaw(name: string, serve: (req: Request) => Promise<Response>) {
  if (testHooks()) testHooks().register(name, serve); else Deno.serve(serve);
}

// Call one of the service-role SQL functions. Business-rule failures (raised with errcode P0001)
// come back to the client as 400 + their code; anything else is a 500.
export async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await admin().rpc(fn, args);
  if (error) {
    if (error.code === 'P0001') throw new HttpError(400, error.message);
    throw new Error(`${fn}: ${error.code} ${error.message}`);
  }
  return data as T;
}

// Strict body shape check: every key must be listed, every listed key must pass its test.
export function shape<T>(body: Record<string, unknown>, spec: Record<string, (v: unknown) => boolean>, optional: string[] = []): T {
  for (const k of Object.keys(body)) if (!(k in spec)) throw new HttpError(400, 'unexpected_field');
  for (const [k, ok] of Object.entries(spec)) {
    if (!(k in body)) { if (optional.includes(k)) continue; throw new HttpError(400, 'missing_field'); }
    if (!ok(body[k])) throw new HttpError(400, 'bad_field');
  }
  return body as T;
}
export const is = {
  str: (max: number) => (v: unknown) => typeof v === 'string' && v.length <= max,
  int: (min: number, max: number) => (v: unknown) => Number.isInteger(v) && (v as number) >= min && (v as number) <= max,
  num: (min: number, max: number) => (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max,
  uuid: (v: unknown) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v),
  obj: (v: unknown) => !!v && typeof v === 'object' && !Array.isArray(v),
  arr: (max: number) => (v: unknown) => Array.isArray(v) && v.length <= max,
  oneOf: (xs: readonly unknown[]) => (v: unknown) => xs.includes(v),
  nullOr: (f: (v: unknown) => boolean) => (v: unknown) => v === null || f(v),
};
