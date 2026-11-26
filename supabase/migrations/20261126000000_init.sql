-- RC Rampage: accounts, server-owned progress and a verified leaderboard.
--
-- Security model:
--   * All tables live in schema `game`, which the Data API (PostgREST) does not expose.
--     RLS is on everywhere with no policies, and anon/authenticated have no grants at all.
--   * Every write goes through Edge Functions, which call the security-definer functions
--     below with the service role. Those functions are not executable by anon/authenticated.
--   * The only thing a browser can call directly is public.get_leaderboard().

create schema if not exists game;
revoke all on schema game from public, anon, authenticated;
grant usage on schema game to service_role;

-- ---------------------------------------------------------------- tables
create table game.profiles (
  id              uuid primary key references auth.users(id) on delete cascade,
  display_name    text check (display_name is null or (char_length(display_name) between 3 and 16
                                                      and display_name ~ '^[A-Za-z0-9_ -]+$'
                                                      and display_name = btrim(display_name))),
  name_changed_at timestamptz,
  banned          boolean not null default false,
  flagged         boolean not null default false,
  created_at      timestamptz not null default now()
);
create unique index profiles_name_key on game.profiles (lower(display_name));

create table game.wallets (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  coins      bigint not null default 0 check (coins >= 0),
  updated_at timestamptz not null default now()
);

create table game.coin_ledger (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  delta      bigint not null,
  reason     text not null check (reason in ('run','mission','buy','import','grant','purchase')),
  ref        text,
  created_at timestamptz not null default now()
);
create index coin_ledger_user on game.coin_ledger (user_id, created_at desc);

create table game.catalog (
  item_id     text primary key,
  kind        text not null check (kind in ('truck','upgrade','skin','world','coins')),
  price_coins integer check (price_coins is null or price_coins >= 0),
  price_cents integer check (price_cents is null or price_cents > 0),   -- for real-money purchases later
  requires    text references game.catalog(item_id),
  active      boolean not null default true
);

create table game.owned_items (
  user_id     uuid not null references auth.users(id) on delete cascade,
  item_id     text not null references game.catalog(item_id),
  source      text not null check (source in ('coins','purchase','grant','import')),
  acquired_at timestamptz not null default now(),
  primary key (user_id, item_id)
);

create table game.player_state (
  user_id        uuid primary key references auth.users(id) on delete cascade,
  missions       jsonb not null default '[]'::jsonb,
  missions_done  integer not null default 0 check (missions_done >= 0),
  missions_rev   integer not null default 0,          -- optimistic lock for mission updates
  crashes        text[] not null default '{}',
  selected_truck text not null default 'blaze',
  guest_imported boolean not null default false
);

create table game.runs (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  status         text not null default 'open' check (status in ('open','finishing','accepted','rejected','expired')),
  client_version integer not null,
  truck          text not null,
  upgrades       jsonb not null,
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  score          integer,
  dist           integer,
  coins          integer,
  bonus          integer,
  play_seconds   real,
  stats          jsonb,
  reject_reason  text
);
create index runs_user_status on game.runs (user_id, status);
create index runs_board on game.runs (score desc, finished_at) where status = 'accepted';
create index runs_user_best on game.runs (user_id, score desc) where status = 'accepted';

create table game.rate_limits (
  key          text primary key,
  window_start timestamptz not null,
  count        integer not null
);

-- RLS on, no policies: nobody but the table owner and service role gets rows.
alter table game.profiles     enable row level security;
alter table game.wallets      enable row level security;
alter table game.coin_ledger  enable row level security;
alter table game.catalog      enable row level security;
alter table game.owned_items  enable row level security;
alter table game.player_state enable row level security;
alter table game.runs         enable row level security;
alter table game.rate_limits  enable row level security;
revoke all on all tables in schema game from public, anon, authenticated;
revoke all on all sequences in schema game from public, anon, authenticated;
alter default privileges in schema game revoke all on tables from public, anon, authenticated;
alter default privileges in schema game revoke all on functions from public, anon, authenticated;

-- ---------------------------------------------------------------- catalog (mirrors rules.js)
insert into game.catalog (item_id, kind, price_coins, requires) values
  ('truck:blaze',   'truck',   0,   null),
  ('truck:bulldog', 'truck',   150, null),
  ('truck:shark',   'truck',   300, null),
  ('truck:howler',  'truck',   500, null);
insert into game.catalog (item_id, kind, price_coins, requires)
select format('upg:%s:%s', p, l), 'upgrade', (array[100,250,500])[l],
       case when l > 1 then format('upg:%s:%s', p, l-1) end
from unnest(array['jump','magnet','shield','turbo']) p, generate_series(1,3) l
order by p, l;

-- ---------------------------------------------------------------- new accounts
create function game.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into game.profiles (id) values (new.id);
  insert into game.wallets (user_id) values (new.id);
  insert into game.player_state (user_id) values (new.id);
  insert into game.owned_items (user_id, item_id, source) values (new.id, 'truck:blaze', 'grant');
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function game.handle_new_user();

-- ---------------------------------------------------------------- helpers
create function game.inventory(p_uid uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(item_id order by item_id), '[]'::jsonb) from game.owned_items where user_id = p_uid
$$;

create function game.best(p_uid uuid, p_since timestamptz) returns integer
language sql stable security definer set search_path = '' as $$
  select max(score) from game.runs where user_id = p_uid and status = 'accepted' and finished_at >= p_since
$$;

-- ---------------------------------------------------------------- server API (service role only)

-- Fixed-window rate limit. Returns true when the call is allowed.
create function public.rc_hit_rate_limit(p_key text, p_max integer, p_window_seconds integer) returns boolean
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  insert into game.rate_limits as r (key, window_start, count) values (p_key, now(), 1)
  on conflict (key) do update set
    count        = case when r.window_start < now() - make_interval(secs => p_window_seconds) then 1 else r.count + 1 end,
    window_start = case when r.window_start < now() - make_interval(secs => p_window_seconds) then now() else r.window_start end
  returning count into n;
  return n <= p_max;
end $$;

-- Everything the game needs about a player, in one object.
create function public.rc_get_state(p_uid uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'name',          p.display_name,
    'banned',        p.banned,
    'coins',         w.coins,
    'items',         game.inventory(p_uid),
    'missions',      s.missions,
    'missions_done', s.missions_done,
    'missions_rev',  s.missions_rev,
    'crashes',       to_jsonb(s.crashes),
    'truck',         s.selected_truck,
    'imported',      s.guest_imported,
    'best',          coalesce(game.best(p_uid, '-infinity'), 0),
    'best_week',     coalesce(game.best(p_uid, date_trunc('week', now())), 0)
  )
  from game.profiles p
  join game.wallets w on w.user_id = p.id
  join game.player_state s on s.user_id = p.id
  where p.id = p_uid
$$;

create function public.rc_set_name(p_uid uuid, p_name text) returns void
language plpgsql security definer set search_path = '' as $$
declare cur game.profiles;
begin
  select * into cur from game.profiles where id = p_uid for update;
  if cur.display_name is not distinct from p_name then return; end if;
  if cur.display_name is not null and cur.name_changed_at > now() - interval '1 day' then
    raise exception 'rename_cooldown' using errcode = 'P0001';
  end if;
  begin
    update game.profiles set display_name = p_name, name_changed_at = now() where id = p_uid;
  exception
    when unique_violation then raise exception 'name_taken' using errcode = 'P0001';
    when check_violation  then raise exception 'bad_name'   using errcode = 'P0001';
  end;
end $$;

create function public.rc_set_truck(p_uid uuid, p_truck text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from game.owned_items where user_id = p_uid and item_id = 'truck:' || p_truck) then
    raise exception 'not_owned' using errcode = 'P0001';
  end if;
  update game.player_state set selected_truck = p_truck where user_id = p_uid;
end $$;

-- Atomic coin purchase: price, prerequisite, ownership and balance all checked under a wallet lock.
create function public.rc_buy_item(p_uid uuid, p_item text) returns bigint
language plpgsql security definer set search_path = '' as $$
declare c game.catalog; bal bigint;
begin
  select * into c from game.catalog where item_id = p_item and active and price_coins is not null;
  if not found then raise exception 'unknown_item' using errcode = 'P0001'; end if;
  select coins into bal from game.wallets where user_id = p_uid for update;
  if exists (select 1 from game.owned_items where user_id = p_uid and item_id = p_item) then
    raise exception 'already_owned' using errcode = 'P0001';
  end if;
  if c.requires is not null and not exists (select 1 from game.owned_items where user_id = p_uid and item_id = c.requires) then
    raise exception 'needs_previous' using errcode = 'P0001';
  end if;
  if bal < c.price_coins then raise exception 'not_enough_coins' using errcode = 'P0001'; end if;
  update game.wallets set coins = coins - c.price_coins, updated_at = now() where user_id = p_uid returning coins into bal;
  insert into game.owned_items (user_id, item_id, source) values (p_uid, p_item, 'coins');
  insert into game.coin_ledger (user_id, delta, reason, ref) values (p_uid, -c.price_coins, 'buy', p_item);
  return bal;
end $$;

-- Open a run. Older unfinished runs expire; at most one open run per player.
create function public.rc_start_run(p_uid uuid, p_version integer, p_truck text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare rid uuid; inv jsonb; ups jsonb;
begin
  perform 1 from game.player_state where user_id = p_uid for update;   -- serialise per player
  if not exists (select 1 from game.owned_items where user_id = p_uid and item_id = 'truck:' || p_truck) then
    raise exception 'not_owned' using errcode = 'P0001';
  end if;
  update game.runs set status = 'expired' where user_id = p_uid and status in ('open','finishing');
  inv := game.inventory(p_uid);
  select jsonb_object_agg(p, (select count(*) from jsonb_array_elements_text(inv) i where i like 'upg:' || p || ':%'))
    into ups from unnest(array['jump','magnet','shield','turbo']) p;
  insert into game.runs (user_id, client_version, truck, upgrades) values (p_uid, p_version, p_truck, ups)
  returning id into rid;
  update game.player_state set selected_truck = p_truck where user_id = p_uid;
  return rid;
end $$;

-- Claim an open run for scoring, exactly once. Returns the server-measured seconds since it started.
create function public.rc_claim_run(p_uid uuid, p_run uuid) returns double precision
language plpgsql security definer set search_path = '' as $$
declare t timestamptz;
begin
  update game.runs set status = 'finishing', finished_at = now()
   where id = p_run and user_id = p_uid and status = 'open' and started_at > now() - interval '3 hours'
  returning started_at into t;
  if not found then raise exception 'run_not_open' using errcode = 'P0001'; end if;
  return extract(epoch from (now() - t));
end $$;

-- Store a claimed run's outcome. On accept: bank coins and mission rewards and save missions,
-- all in this one transaction. p_rev must match the missions_rev the caller settled against.
create function public.rc_commit_run(
  p_uid uuid, p_run uuid, p_ok boolean, p_reason text,
  p_score integer, p_dist integer, p_coins integer, p_bonus integer, p_play real, p_stats jsonb,
  p_rev integer, p_missions jsonb, p_missions_reward integer, p_missions_done integer, p_crash text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare st game.player_state; rejects integer;
begin
  select * into st from game.player_state where user_id = p_uid for update;
  if p_ok and st.missions_rev <> p_rev then
    raise exception 'missions_changed' using errcode = 'P0001';
  end if;
  update game.runs set status = case when p_ok then 'accepted' else 'rejected' end,
         score = p_score, dist = p_dist, coins = p_coins, bonus = p_bonus, play_seconds = p_play,
         stats = p_stats, reject_reason = p_reason
   where id = p_run and user_id = p_uid and status = 'finishing';
  if not found then raise exception 'run_not_claimed' using errcode = 'P0001'; end if;

  if p_ok then
    if p_coins + p_missions_reward > 0 then
      update game.wallets set coins = coins + p_coins + p_missions_reward, updated_at = now() where user_id = p_uid;
    end if;
    if p_coins > 0 then
      insert into game.coin_ledger (user_id, delta, reason, ref) values (p_uid, p_coins, 'run', p_run::text);
    end if;
    if p_missions_reward > 0 then
      insert into game.coin_ledger (user_id, delta, reason, ref) values (p_uid, p_missions_reward, 'mission', p_run::text);
    end if;
    update game.player_state set
      missions      = p_missions,
      missions_done = missions_done + p_missions_done,
      missions_rev  = missions_rev + 1,
      crashes       = case when p_crash is null or p_crash = any(crashes) then crashes else crashes || p_crash end
     where user_id = p_uid;
  else
    select count(*) into rejects from game.runs
     where user_id = p_uid and status = 'rejected' and finished_at > now() - interval '1 day'
       and reject_reason is distinct from 'old game version';
    if rejects >= 3 then update game.profiles set flagged = true where id = p_uid; end if;
  end if;
  return public.rc_get_state(p_uid);
end $$;

-- Refill missions between runs (first sign-in, or after missions were finished).
create function public.rc_save_missions(p_uid uuid, p_rev integer, p_missions jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  update game.player_state set missions = p_missions, missions_rev = missions_rev + 1
   where user_id = p_uid and missions_rev = p_rev;
  return found;
end $$;

-- One-time carry-over of guest progress, with hard caps (local storage is editable).
create function public.rc_import_guest(p_uid uuid, p_coins integer, p_items text[], p_missions jsonb,
                                       p_missions_done integer, p_crashes text[]) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare st game.player_state; value integer; items text[];
begin
  select * into st from game.player_state where user_id = p_uid for update;
  if st.guest_imported then raise exception 'already_imported' using errcode = 'P0001'; end if;
  -- keep only real catalog items whose prerequisite chain is also being imported
  select coalesce(array_agg(c.item_id), '{}') into items from game.catalog c
   where c.item_id = any(p_items) and c.price_coins is not null
     and (c.requires is null or c.requires = any(p_items));
  select coalesce(sum(price_coins), 0) into value from game.catalog where item_id = any(items);
  if value > 2500 then items := '{}'; end if;
  insert into game.owned_items (user_id, item_id, source)
  select p_uid, i, 'import' from unnest(items) i on conflict do nothing;
  p_coins := least(greatest(p_coins, 0), 2000);
  if p_coins > 0 then
    update game.wallets set coins = coins + p_coins, updated_at = now() where user_id = p_uid;
    insert into game.coin_ledger (user_id, delta, reason, ref) values (p_uid, p_coins, 'import', 'guest');
  end if;
  update game.player_state set
    guest_imported = true,
    missions       = coalesce(p_missions, missions),
    missions_done  = least(greatest(p_missions_done, 0), 300),
    missions_rev   = missions_rev + 1,
    crashes        = (select coalesce(array_agg(distinct c), '{}') from unnest(p_crashes) c
                       where c in ('flip','shatter','orbit','balls','pancake','wheels','kaboom','pixels','ghost','balloon'))
   where user_id = p_uid;
  return public.rc_get_state(p_uid);
end $$;

create function public.rc_mark_imported(p_uid uuid) returns void
language sql security definer set search_path = '' as $$
  update game.player_state set guest_imported = true where user_id = p_uid
$$;

-- ---------------------------------------------------------------- public read
-- Best verified run per named, non-banned player. Never exposes ids or emails.
-- The caller's own row is flagged `me` and appended when outside the top `lim`.
create function public.get_leaderboard(board text default 'all', lim integer default 50)
returns table (rank bigint, name text, score integer, truck text, achieved_at timestamptz, me boolean)
language sql stable security definer set search_path = '' as $$
  with best as (
    select distinct on (r.user_id) r.user_id, r.score, r.truck, r.finished_at
      from game.runs r join game.profiles p on p.id = r.user_id
     where r.status = 'accepted' and not p.banned and p.display_name is not null
       and r.finished_at >= case when board = 'week' then date_trunc('week', now()) else '-infinity'::timestamptz end
     order by r.user_id, r.score desc, r.finished_at asc
  ), ranked as (
    select rank() over (order by b.score desc, b.finished_at asc) as rank, b.*
      from best b
  )
  select k.rank, p.display_name, k.score, k.truck, k.finished_at, (k.user_id = auth.uid())
    from ranked k join game.profiles p on p.id = k.user_id
   where k.rank <= least(greatest(lim, 1), 100) or k.user_id = auth.uid()
   order by k.rank
$$;

-- ---------------------------------------------------------------- privileges
revoke all on function public.rc_hit_rate_limit(text, integer, integer) from public, anon, authenticated;
revoke all on function public.rc_get_state(uuid) from public, anon, authenticated;
revoke all on function public.rc_set_name(uuid, text) from public, anon, authenticated;
revoke all on function public.rc_set_truck(uuid, text) from public, anon, authenticated;
revoke all on function public.rc_buy_item(uuid, text) from public, anon, authenticated;
revoke all on function public.rc_start_run(uuid, integer, text) from public, anon, authenticated;
revoke all on function public.rc_claim_run(uuid, uuid) from public, anon, authenticated;
revoke all on function public.rc_commit_run(uuid, uuid, boolean, text, integer, integer, integer, integer, real, jsonb, integer, jsonb, integer, integer, text) from public, anon, authenticated;
revoke all on function public.rc_save_missions(uuid, integer, jsonb) from public, anon, authenticated;
revoke all on function public.rc_import_guest(uuid, integer, text[], jsonb, integer, text[]) from public, anon, authenticated;
revoke all on function public.rc_mark_imported(uuid) from public, anon, authenticated;
grant execute on function public.rc_hit_rate_limit(text, integer, integer) to service_role;
grant execute on function public.rc_get_state(uuid) to service_role;
grant execute on function public.rc_set_name(uuid, text) to service_role;
grant execute on function public.rc_set_truck(uuid, text) to service_role;
grant execute on function public.rc_buy_item(uuid, text) to service_role;
grant execute on function public.rc_start_run(uuid, integer, text) to service_role;
grant execute on function public.rc_claim_run(uuid, uuid) to service_role;
grant execute on function public.rc_commit_run(uuid, uuid, boolean, text, integer, integer, integer, integer, real, jsonb, integer, jsonb, integer, integer, text) to service_role;
grant execute on function public.rc_save_missions(uuid, integer, jsonb) to service_role;
grant execute on function public.rc_import_guest(uuid, integer, text[], jsonb, integer, text[]) to service_role;
grant execute on function public.rc_mark_imported(uuid) to service_role;

revoke all on function public.get_leaderboard(text, integer) from public;
grant execute on function public.get_leaderboard(text, integer) to anon, authenticated, service_role;

revoke all on all functions in schema game from public, anon, authenticated;
