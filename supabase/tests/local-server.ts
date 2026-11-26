// Runs the real Edge Function handlers against a local Postgres, with Supabase's auth and API
// gateway replaced by small fakes. Lets the whole game be tested end to end without Docker.
//
//   DATABASE_URL=postgres://postgres@127.0.0.1:55432/rc \
//   deno run --allow-net --allow-env --allow-read supabase/tests/local-server.ts
//
// Fake auth: POST /auth/otp {email} creates (or finds) the user and returns {id}; the "access token"
// is then `test:<id>`. Never deploy this file.
import postgres from 'npm:postgres@3.4.5';

const sql = postgres(Deno.env.get('DATABASE_URL') ?? 'postgres://postgres@127.0.0.1:55432/rc', { max: 4, onnotice: () => {} });
const PORT = Number(Deno.env.get('PORT') ?? 8790);
const ORIGIN = 'http://localhost:8777';

// Argument types of the service functions, so calls can cast their parameters.
const argTypes = new Map<string, Map<string, string>>();
for (const r of await sql`
  select p.proname, unnest(p.proargnames) as arg, unnest(p.proargtypes::regtype[]::text[]) as type
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname like 'rc\\_%'`) {
  if (!argTypes.has(r.proname)) argTypes.set(r.proname, new Map());
  argTypes.get(r.proname)!.set(r.arg, r.type);
}

const tokenUser = async (token: string) => {
  const id = token.startsWith('test:') ? token.slice(5) : '';
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  const [u] = await sql`select id::text, email from auth.users where id = ${id}`;
  return u ?? null;
};

const fakeAdmin = {
  auth: {
    getUser: async (token: string) => {
      const u = await tokenUser(token);
      return u ? { data: { user: u }, error: null } : { data: { user: null }, error: { message: 'bad token' } };
    },
    admin: {
      deleteUser: async (id: string) => { await sql`delete from auth.users where id = ${id}`; return { error: null }; },
    },
  },
  rpc: async (fn: string, args: Record<string, unknown>) => {
    const types = argTypes.get(fn);
    if (!types) return { data: null, error: { code: '42883', message: `no function ${fn}` } };
    const names = Object.keys(args);
    const values = names.map((k) => args[k]);     // postgres.js encodes jsonb parameters itself
    const call = names.map((k, i) => `${k} => $${i + 1}::${types.get(k)}`).join(', ');
    try {
      const [row] = await sql.unsafe(`select public.${fn}(${call}) as r`, values as never[]);
      return { data: row.r, error: null };
    } catch (e) {
      const err = e as { code?: string; message?: string };
      return { data: null, error: { code: err.code, message: err.message } };
    }
  },
};

const handlers = new Map<string, (req: Request) => Promise<Response>>();
// deno-lint-ignore no-explicit-any
(globalThis as any).__rcTest = { admin: fakeAdmin, register: (name: string, h: (req: Request) => Promise<Response>) => handlers.set(name, h) };
for (const fn of ['profile', 'run-start', 'run-finish', 'shop-buy', 'import-guest', 'delete-account']) {
  await import(`../functions/${fn}/index.ts`);
}

const cors = { 'Access-Control-Allow-Origin': ORIGIN, 'Access-Control-Allow-Headers': 'authorization, apikey, content-type', 'Content-Type': 'application/json' };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: cors });

Deno.serve({ port: PORT, hostname: '127.0.0.1' }, async (req) => {
  const path = new URL(req.url).pathname;
  const fn = path.match(/^\/functions\/v1\/([a-z-]+)$/)?.[1];
  if (fn) return handlers.has(fn) ? handlers.get(fn)!(req) : json({ error: 'no_function' }, 404);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (path === '/auth/otp') {
    const { email } = await req.json();
    const [u] = await sql`insert into auth.users (email) values (${email})
                          on conflict (email) do update set email = excluded.email returning id::text`;
    return json({ id: u.id });
  }
  if (path === '/rest/v1/rpc/get_leaderboard') {
    const { board, lim } = await req.json();
    const u = await tokenUser((req.headers.get('Authorization') ?? '').replace(/^Bearer /, ''));
    const rows = await sql.begin(async (tx) => {
      await tx.unsafe(`set local role ${u ? 'authenticated' : 'anon'}`);
      if (u) await tx`select set_config('request.jwt.claim.sub', ${u.id}, true)`;
      return await tx`select * from public.get_leaderboard(${board}, ${lim})`;
    });
    return json(rows.map((r) => ({ ...r, rank: Number(r.rank) })));
  }
  return json({ error: 'not_found' }, 404);
});
console.log(`local RC Rampage backend on http://127.0.0.1:${PORT}`);
