// Spend coins on a catalog item. Price, prerequisites and balance are checked in SQL under a lock.
import { is, rpc, serveUser, shape } from '../_shared/http.ts';
import { forClient, loadState, R } from '../_shared/game.ts';

const ITEMS = R.catalog().map((c: { item_id: string }) => c.item_id);

serveUser('shop-buy', { rate: [30, 60] }, async ({ user, body }) => {
  const b = shape<{ item: string }>(body, { item: is.oneOf(ITEMS) });
  await loadState(user.id);                       // refuses banned accounts
  await rpc('rc_buy_item', { p_uid: user.id, p_item: b.item });
  return { state: forClient(await loadState(user.id)) };
});
