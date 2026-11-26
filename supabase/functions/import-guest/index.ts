// One-time carry-over of a guest's local progress into a new account.
// Local storage is editable, so the SQL side caps coins (2,000) and item value (2,500 coins)
// and keeps only items whose upgrade chain is complete. Best score is never imported.
import { is, rpc, serveUser, shape } from '../_shared/http.ts';
import { type DbState, forClient, loadState, R } from '../_shared/game.ts';

serveUser('import-guest', { rate: [5, 60] }, async ({ user, body }) => {
  const b = shape<{
    coins: number; trucks: string[]; upgrades: Record<string, number>;
    missions: unknown[]; missionsDone: number; crashes: string[];
  }>(body, {
    coins: is.int(0, 1e9),
    trucks: (v) => is.arr(R.TRUCK_IDS.length)(v) && (v as unknown[]).every(is.oneOf(R.TRUCK_IDS)),
    upgrades: (v) => is.obj(v) && Object.entries(v as object).every(([k, n]) => R.POWER_IDS.includes(k) && is.int(0, R.UPG_MAX)(n)),
    missions: is.arr(3),
    missionsDone: is.int(0, 1e6),
    crashes: (v) => is.arr(R.DEATH_IDS.length)(v) && (v as unknown[]).every(is.oneOf(R.DEATH_IDS)),
  });
  const s = await loadState(user.id);
  if (s.imported) return { state: forClient(s), imported: false };

  const items: string[] = b.trucks.filter((t) => t !== 'blaze').map((t) => 'truck:' + t);
  for (const [p, lvl] of Object.entries(b.upgrades)) for (let l = 1; l <= lvl; l++) items.push(`upg:${p}:${l}`);
  const missions = b.missions.filter(R.validMission);
  const st = await rpc<DbState>('rc_import_guest', {
    p_uid: user.id, p_coins: b.coins, p_items: items,
    p_missions: missions.length ? missions : null, p_missions_done: b.missionsDone, p_crashes: b.crashes,
  });
  return { state: forClient(await loadState(user.id)), imported: true, coinsKept: Math.min(b.coins, 2000), itemsKept: st.items.length - 1 };
});
