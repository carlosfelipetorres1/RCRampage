-- Database security and logic tests. Run against a scratch database:
--   psql -d <db> -f supabase/tests/stub.sql -f supabase/migrations/*.sql -f supabase/tests/security.sql
-- Any failed expectation raises an exception and stops the script.
\set ON_ERROR_STOP 1
create schema t;
grant usage on schema t to anon, authenticated;
create function t.fails(p_role text, p_sql text, p_like text) returns void language plpgsql as $$
begin
  begin
    execute format('set local role %I', p_role);
    execute p_sql;
  exception when others then
    reset role;
    if sqlerrm not like p_like then raise exception 'FAIL: % as % raised "%" (wanted %)', p_sql, p_role, sqlerrm, p_like; end if;
    raise notice 'ok   % as % -> %', left(p_sql, 60), p_role, sqlerrm;
    return;
  end;
  reset role;
  raise exception 'FAIL: % as % should have failed', p_sql, p_role;
end $$;
create function t.eq(got anyelement, want anyelement, what text) returns void language plpgsql as $$
begin
  if got is distinct from want then raise exception 'FAIL: % = % (wanted %)', what, got, want; end if;
  raise notice 'ok   % = %', what, got;
end $$;

-- 1. The browser roles can't touch tables or server functions.
begin;
select t.fails(r, q, '%permission denied%') from
  unnest(array['anon','authenticated']) r,
  unnest(array[
    'select * from game.profiles', 'select * from game.wallets', 'select * from game.runs',
    'insert into game.wallets values (gen_random_uuid(), 999999)',
    'update game.wallets set coins = 999999', 'delete from game.runs',
    'select public.rc_buy_item(gen_random_uuid(), ''truck:howler'')',
    'select public.rc_get_state(gen_random_uuid())',
    'select public.rc_start_run(gen_random_uuid(), 2, ''blaze'')',
    'select public.rc_commit_run(gen_random_uuid(), gen_random_uuid(), true, null, 1,1,1,1,1,''{}'',0,''[]'',0,0,null)',
    'select public.rc_import_guest(gen_random_uuid(), 2000, ''{}'', null, 0, ''{}'')',
    'select public.rc_hit_rate_limit(''x'', 1, 1)',
    'select game.inventory(gen_random_uuid())',
    'select public.rc_grant_purchase(gen_random_uuid(), ''cs_x'', ''pi_x'', ''coins:4000'', 499, ''eur'')',
    'select public.rc_revoke_purchase(''pi_x'')',
    'select public.rc_set_skin(gen_random_uuid(), ''gold'')',
    'select public.rc_check_purchasable(gen_random_uuid(), ''skin:gold'')',
    'select * from game.purchases'
  ]) q;
commit;
-- nothing in the exposed schema is readable or callable by browser roles except get_leaderboard
select t.eq((select count(*) from information_schema.role_table_grants
              where grantee in ('anon','authenticated','PUBLIC') and table_schema in ('public','game')), 0::bigint, 'table grants to browser roles');
select t.eq((select string_agg(p.proname, ',' order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname in ('public','game') and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))),
            'get_leaderboard', 'functions callable by browser roles');
select t.eq((select bool_and(c.relrowsecurity) from pg_class c join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'game' and c.relkind = 'r'), true, 'RLS on for every game table');

-- 2. New account bootstrap.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'a@test'),
  ('00000000-0000-0000-0000-00000000000b', 'b@test');
\set A '''00000000-0000-0000-0000-00000000000a'''
\set B '''00000000-0000-0000-0000-00000000000b'''
select t.eq((public.rc_get_state(:A)->>'coins')::int, 0, 'new wallet');
select t.eq(public.rc_get_state(:A)->'items', '["truck:blaze"]'::jsonb, 'new items');

-- 3. Names.
select public.rc_set_name(:A, 'Alice');
select t.fails('postgres', 'select public.rc_set_name(''00000000-0000-0000-0000-00000000000b'', ''alice'')', '%name_taken%');
select t.fails('postgres', 'select public.rc_set_name(''00000000-0000-0000-0000-00000000000b'', ''<script>'')', '%bad_name%');
select t.fails('postgres', 'select public.rc_set_name(''00000000-0000-0000-0000-00000000000a'', ''Alicia'')', '%rename_cooldown%');
select public.rc_set_name(:B, 'Bob');

-- 4. Shop.
select t.fails('postgres', 'select public.rc_buy_item(''00000000-0000-0000-0000-00000000000a'', ''truck:bulldog'')', '%not_enough_coins%');
update game.wallets set coins = 400 where user_id = :A;
select t.fails('postgres', 'select public.rc_buy_item(''00000000-0000-0000-0000-00000000000a'', ''upg:jump:2'')', '%needs_previous%');
select t.fails('postgres', 'select public.rc_buy_item(''00000000-0000-0000-0000-00000000000a'', ''truck:blaze'')', '%already_owned%');
select t.fails('postgres', 'select public.rc_buy_item(''00000000-0000-0000-0000-00000000000a'', ''truck:nope'')', '%unknown_item%');
select t.eq(public.rc_buy_item(:A, 'upg:jump:1'), 300::bigint, 'buy jump 1');
select t.eq(public.rc_buy_item(:A, 'truck:bulldog'), 150::bigint, 'buy bulldog');
select t.fails('postgres', 'select public.rc_buy_item(''00000000-0000-0000-0000-00000000000a'', ''upg:jump:2'')', '%not_enough_coins%');
select t.eq((select sum(delta) from game.coin_ledger where user_id = :A), -250::numeric, 'ledger matches spend');

-- 5. Runs: start, claim once, commit; replay and stale runs fail.
select t.fails('postgres', 'select public.rc_start_run(''00000000-0000-0000-0000-00000000000a'', 2, ''howler'')', '%not_owned%');
create temp table r1 as select public.rc_start_run(:A, 2, 'bulldog') id;
select t.eq((select upgrades->>'jump' from game.runs where id = (select id from r1)), '1', 'upgrade snapshot');
select public.rc_claim_run(:A, (select id from r1));
select t.fails('postgres', format('select public.rc_claim_run(%L, %L)', '00000000-0000-0000-0000-00000000000a', (select id from r1)), '%run_not_open%');
select t.fails('postgres', format('select public.rc_claim_run(%L, %L)', '00000000-0000-0000-0000-00000000000b', (select id from r1)), '%run_not_open%');
select t.fails('postgres', format('select public.rc_commit_run(%L,%L,true,null,900,500,20,200,40,''{}'',99,''[]'',0,0,null)', '00000000-0000-0000-0000-00000000000a', (select id from r1)), '%missions_changed%');
select t.eq((public.rc_commit_run(:A, (select id from r1), true, null, 900, 500, 20, 200, 40, '{}', 0, '[{"type":"dist"}]', 60, 1, 'flip')->>'coins')::int, 230, 'coins + mission reward banked');
select t.fails('postgres', format('select public.rc_commit_run(%L,%L,true,null,900,500,20,200,40,''{}'',1,''[]'',0,0,null)', '00000000-0000-0000-0000-00000000000a', (select id from r1)), '%run_not_claimed%');
select t.eq(public.rc_get_state(:A)->'crashes', '["flip"]'::jsonb, 'crash saved');
select t.eq((public.rc_get_state(:A)->>'best')::int, 900, 'best');
-- a new start expires an unfinished run
create temp table r2 as select public.rc_start_run(:B, 2, 'blaze') id;
create temp table r3 as select public.rc_start_run(:B, 2, 'blaze') id;
select t.eq((select status from game.runs where id = (select id from r2)), 'expired', 'old open run expired');
select public.rc_claim_run(:B, (select id from r3));
select public.rc_commit_run(:B, (select id from r3), true, null, 1500, 800, 30, 400, 60, '{}', 0, '[]', 0, 0, null);
-- rejected runs give nothing; three in a day flags the account
do $$ declare i int; rid uuid; begin
  for i in 1..3 loop
    rid := public.rc_start_run('00000000-0000-0000-0000-00000000000b', 2, 'blaze');
    perform public.rc_claim_run('00000000-0000-0000-0000-00000000000b', rid);
    perform public.rc_commit_run('00000000-0000-0000-0000-00000000000b', rid, false, 'too fast', 99999, 9999, 999, 0, 10, '{}', 0, '[]', 0, 0, null);
  end loop; end $$;
select t.eq((public.rc_get_state(:B)->>'coins')::int, 30, 'rejected runs paid nothing (30 is from the accepted run)');
select t.eq((select flagged from game.profiles where id = :B), true, 'flagged after 3 rejects');

-- 6. Leaderboard: anon can read names and scores only; the caller's row is marked.
begin;
set local role anon;
select t.eq((select string_agg(name || ':' || score, ',' order by rank) from public.get_leaderboard('all', 50)), 'Bob:1500,Alice:900', 'public board');
select t.eq((select count(*) from public.get_leaderboard('all', 50) where me), 0::bigint, 'anon is nobody');
commit;
begin;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
select t.eq((select string_agg(name, ',') from public.get_leaderboard('week', 1)), 'Bob,Alice', 'top 1 plus me');
select t.eq((select name from public.get_leaderboard('all', 50) where me), 'Alice', 'my row');
commit;
update game.profiles set banned = true where id = :B;
select t.eq((select string_agg(name, ',') from public.get_leaderboard('all', 50)), 'Alice', 'banned players hidden');

-- 7. Guest import: once, capped.
insert into auth.users (id, email) values ('00000000-0000-0000-0000-00000000000c', 'c@test');
\set C '''00000000-0000-0000-0000-00000000000c'''
select t.eq((public.rc_import_guest(:C, 1000000, array['truck:howler','upg:jump:2','upg:magnet:1','fake'], null, 5, array['flip','nope'])->'items'),
            '["truck:blaze", "truck:howler", "upg:magnet:1"]'::jsonb, 'import keeps valid chain only');
select t.eq((public.rc_get_state(:C)->>'coins')::int, 2000, 'import coins capped');
select t.eq(public.rc_get_state(:C)->'crashes', '["flip"]'::jsonb, 'import crashes filtered');
select t.fails('postgres', 'select public.rc_import_guest(''00000000-0000-0000-0000-00000000000c'', 5, ''{}'', null, 0, ''{}'')', '%already_imported%');
insert into auth.users (id, email) values ('00000000-0000-0000-0000-00000000000d', 'd@test');
select t.eq((public.rc_import_guest('00000000-0000-0000-0000-00000000000d', 0, array['truck:howler','truck:shark','truck:bulldog','upg:jump:1','upg:jump:2','upg:jump:3','upg:magnet:1','upg:magnet:2','upg:magnet:3'], null, 0, '{}')->'items'),
            '["truck:blaze"]'::jsonb, 'import over value cap drops items');

-- 8. Rate limit window.
select t.eq((select array_agg(public.rc_hit_rate_limit('k', 2, 60)) from generate_series(1,3)), array[true,true,false], 'rate limit');

-- 9. Deleting the auth user removes everything.
delete from auth.users where id = :A;
select t.eq((select count(*) from game.runs where user_id = :A) + (select count(*) from game.coin_ledger where user_id = :A)
          + (select count(*) from game.wallets where user_id = :A) + (select count(*) from game.profiles where id = :A), 0::bigint, 'account deletion cascades');

-- 10. Shop: coin skins, real-money skins and coin packs.
insert into auth.users (id, email) values ('00000000-0000-0000-0000-00000000000e', 'e@test');
\set E '''00000000-0000-0000-0000-00000000000e'''
select t.fails('postgres', 'select public.rc_buy_item(''00000000-0000-0000-0000-00000000000e'', ''skin:gold'')', '%unknown_item%');
select t.fails('postgres', 'select public.rc_buy_item(''00000000-0000-0000-0000-00000000000e'', ''coins:4000'')', '%unknown_item%');
select t.fails('postgres', 'select public.rc_check_purchasable(''00000000-0000-0000-0000-00000000000e'', ''skin:cherry'')', '%unknown_item%');
select t.eq(public.rc_check_purchasable(:E, 'skin:gold'), 199, 'gold is purchasable for 199');
select t.fails('postgres', 'select public.rc_grant_purchase(''00000000-0000-0000-0000-00000000000e'', ''cs_1'', ''pi_1'', ''coins:4000'', 99, ''eur'')', '%amount_mismatch%');
select t.fails('postgres', 'select public.rc_grant_purchase(''00000000-0000-0000-0000-00000000000e'', ''cs_1'', ''pi_1'', ''coins:4000'', 499, ''usd'')', '%amount_mismatch%');
select t.eq(public.rc_grant_purchase(:E, 'cs_1', 'pi_1', 'coins:4000', 499, 'eur'), 'granted', 'coin pack granted');
select t.eq(public.rc_grant_purchase(:E, 'cs_1', 'pi_1', 'coins:4000', 499, 'eur'), 'duplicate', 'webhook retry is a no-op');
select t.eq((public.rc_get_state(:E)->>'coins')::int, 4000, 'coins credited once');
select t.eq(public.rc_buy_item(:E, 'skin:cherry'), 3800::bigint, 'buy coin skin');
select t.fails('postgres', 'select public.rc_set_skin(''00000000-0000-0000-0000-00000000000e'', ''gold'')', '%not_owned%');
select t.eq(public.rc_grant_purchase(:E, 'cs_2', 'pi_2', 'skin:gold', 199, 'EUR'), 'granted', 'skin granted');
select t.fails('postgres', 'select public.rc_check_purchasable(''00000000-0000-0000-0000-00000000000e'', ''skin:gold'')', '%already_owned%');
select public.rc_set_skin(:E, 'gold');
select t.eq(public.rc_get_state(:E)->>'skin', 'gold', 'skin equipped');
-- refunds take things back
select public.rc_buy_item(:E, 'truck:howler');
select t.eq(public.rc_revoke_purchase('pi_2'), 'revoked', 'skin refund');
select t.eq(public.rc_revoke_purchase('pi_2'), 'already', 'second refund event is a no-op');
select t.eq(public.rc_get_state(:E)->>'skin', 'stock', 'refunded skin unequipped');
select t.eq((public.rc_get_state(:E)->'items') ? 'skin:gold', false, 'refunded skin removed');
select t.eq(public.rc_revoke_purchase('pi_1'), 'revoked', 'coin refund');
select t.eq((public.rc_get_state(:E)->>'coins')::int, 0, 'refund only takes coins that are left');
select t.eq((select sum(delta) from game.coin_ledger where user_id = :E), 0::numeric, 'ledger matches wallet');
-- purchases survive account deletion as records, detached from the user
delete from auth.users where id = :E;
select t.eq((select count(*) from game.purchases where user_id is null), 2::bigint, 'purchase records kept without the user');
select t.eq(public.rc_grant_purchase('00000000-0000-0000-0000-00000000000e', 'cs_3', 'pi_3', 'coins:500', 99, 'eur'), 'no_user', 'paid after deletion: recorded, nothing granted');

\echo ALL DATABASE TESTS PASSED
