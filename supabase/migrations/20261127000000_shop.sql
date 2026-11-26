-- RC Rampage shop: skins (coins or real money) and coin packs paid through Stripe.
-- Real-money items are only ever granted by rc_grant_purchase(), which only the stripe-webhook
-- function (service role) can call, after it has verified Stripe's signature.

alter table game.catalog add column coins_granted integer check (coins_granted is null or coins_granted > 0);
alter table game.catalog add column name text;

insert into game.catalog (item_id, kind, price_coins, price_cents, coins_granted, name) values
  ('skin:cherry', 'skin',  200,  null, null, 'Cherry Red skin'),
  ('skin:mint',   'skin',  200,  null, null, 'Mint & Cream skin'),
  ('skin:camo',   'skin',  400,  null, null, 'Desert Camo skin'),
  ('skin:zebra',  'skin',  400,  null, null, 'Zebra skin'),
  ('skin:gold',   'skin',  null, 199,  null, 'Gold Rush skin'),
  ('skin:flames', 'skin',  null, 199,  null, 'Hot Flames skin'),
  ('skin:galaxy', 'skin',  null, 299,  null, 'Galaxy skin'),
  ('coins:500',   'coins', null, 99,   500,  '500 coins'),
  ('coins:1500',  'coins', null, 249,  1500, '1,500 coins'),
  ('coins:4000',  'coins', null, 499,  4000, '4,000 coins');

alter table game.player_state add column selected_skin text not null default 'stock';

-- One row per paid Stripe Checkout session. Kept when an account is deleted (financial record),
-- with the user detached.
create table game.purchases (
  id             bigint generated always as identity primary key,
  user_id        uuid references auth.users(id) on delete set null,
  stripe_session text not null unique,
  payment_intent text unique,
  item_id        text not null references game.catalog(item_id),
  amount_cents   integer not null,
  currency       text not null,
  status         text not null default 'paid' check (status in ('paid','refunded')),
  created_at     timestamptz not null default now(),
  refunded_at    timestamptz
);
create index purchases_user on game.purchases (user_id);
alter table game.purchases enable row level security;
revoke all on game.purchases from public, anon, authenticated;

-- ---------------------------------------------------------------- state now includes the skin
create or replace function public.rc_get_state(p_uid uuid) returns jsonb
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
    'skin',          s.selected_skin,
    'imported',      s.guest_imported,
    'best',          coalesce(game.best(p_uid, '-infinity'), 0),
    'best_week',     coalesce(game.best(p_uid, date_trunc('week', now())), 0)
  )
  from game.profiles p
  join game.wallets w on w.user_id = p.id
  join game.player_state s on s.user_id = p.id
  where p.id = p_uid
$$;

create function public.rc_set_skin(p_uid uuid, p_skin text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_skin <> 'stock' and not exists (select 1 from game.owned_items where user_id = p_uid and item_id = 'skin:' || p_skin) then
    raise exception 'not_owned' using errcode = 'P0001';
  end if;
  update game.player_state set selected_skin = p_skin where user_id = p_uid;
end $$;

-- Is this real-money item something the player can buy right now? (used before opening Checkout)
create function public.rc_check_purchasable(p_uid uuid, p_item text) returns integer
language plpgsql stable security definer set search_path = '' as $$
declare c game.catalog;
begin
  select * into c from game.catalog where item_id = p_item and active and price_cents is not null;
  if not found then raise exception 'unknown_item' using errcode = 'P0001'; end if;
  if c.kind <> 'coins' and exists (select 1 from game.owned_items where user_id = p_uid and item_id = p_item) then
    raise exception 'already_owned' using errcode = 'P0001';
  end if;
  return c.price_cents;
end $$;

-- Grant a paid Checkout session, exactly once. Returns 'granted', 'duplicate' or 'no_user'.
-- The amount and currency must match the catalog, so a tampered or misconfigured session pays nothing.
create function public.rc_grant_purchase(p_uid uuid, p_session text, p_payment_intent text, p_item text,
                                         p_amount integer, p_currency text) returns text
language plpgsql security definer set search_path = '' as $$
declare c game.catalog; uid uuid;
begin
  select * into c from game.catalog where item_id = p_item and price_cents is not null;
  if not found then raise exception 'unknown_item' using errcode = 'P0001'; end if;
  if p_amount <> c.price_cents or lower(p_currency) <> 'eur' then
    raise exception 'amount_mismatch' using errcode = 'P0001';
  end if;
  select id into uid from auth.users where id = p_uid;           -- null if the account was deleted meanwhile
  insert into game.purchases (user_id, stripe_session, payment_intent, item_id, amount_cents, currency)
  values (uid, p_session, p_payment_intent, p_item, p_amount, lower(p_currency))
  on conflict (stripe_session) do nothing;
  if not found then return 'duplicate'; end if;
  if uid is null then return 'no_user'; end if;
  if c.kind = 'coins' then
    update game.wallets set coins = coins + c.coins_granted, updated_at = now() where user_id = uid;
    insert into game.coin_ledger (user_id, delta, reason, ref) values (uid, c.coins_granted, 'purchase', p_session);
  else
    insert into game.owned_items (user_id, item_id, source) values (uid, p_item, 'purchase')
    on conflict (user_id, item_id) do update set source = 'purchase', acquired_at = now();
  end if;
  return 'granted';
end $$;

-- Undo a purchase after a refund or a chargeback. Coins already spent can't go below zero.
create function public.rc_revoke_purchase(p_payment_intent text) returns text
language plpgsql security definer set search_path = '' as $$
declare pu game.purchases; c game.catalog; taken bigint;
begin
  select * into pu from game.purchases where payment_intent = p_payment_intent for update;
  if not found then return 'unknown'; end if;
  if pu.status = 'refunded' then return 'already'; end if;
  update game.purchases set status = 'refunded', refunded_at = now() where id = pu.id;
  if pu.user_id is null then return 'revoked'; end if;
  select * into c from game.catalog where item_id = pu.item_id;
  if c.kind = 'coins' then
    select least(coins, c.coins_granted) into taken from game.wallets where user_id = pu.user_id for update;
    update game.wallets set coins = coins - taken, updated_at = now() where user_id = pu.user_id;
    insert into game.coin_ledger (user_id, delta, reason, ref) values (pu.user_id, -taken, 'purchase', 'refund:' || pu.stripe_session);
  else
    delete from game.owned_items where user_id = pu.user_id and item_id = pu.item_id and source = 'purchase';
    update game.player_state set selected_skin = 'stock'
     where user_id = pu.user_id and 'skin:' || selected_skin = pu.item_id;
  end if;
  return 'revoked';
end $$;

revoke all on function public.rc_set_skin(uuid, text) from public, anon, authenticated;
revoke all on function public.rc_check_purchasable(uuid, text) from public, anon, authenticated;
revoke all on function public.rc_grant_purchase(uuid, text, text, text, integer, text) from public, anon, authenticated;
revoke all on function public.rc_revoke_purchase(text) from public, anon, authenticated;
grant execute on function public.rc_set_skin(uuid, text) to service_role;
grant execute on function public.rc_check_purchasable(uuid, text) to service_role;
grant execute on function public.rc_grant_purchase(uuid, text, text, text, integer, text) to service_role;
grant execute on function public.rc_revoke_purchase(text) to service_role;
