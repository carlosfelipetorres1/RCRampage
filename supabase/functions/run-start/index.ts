// Open a ranked run. The server records the start time and the truck/upgrades the player really owns.
import { HttpError, is, rpc, serveUser, shape } from '../_shared/http.ts';
import { loadState, R } from '../_shared/game.ts';

serveUser('run-start', { rate: [20, 60] }, async ({ user, body }) => {
  const b = shape<{ version: number; truck: string }>(body, {
    version: is.int(0, 1000),
    truck: is.oneOf(R.TRUCK_IDS),
  });
  if (!R.SUPPORTED_VERSIONS.includes(b.version)) throw new HttpError(426, 'update_game');
  const s = await loadState(user.id);              // refuses banned accounts
  if (!s.name) throw new HttpError(400, 'needs_name');
  if (!(await rpc<boolean>('rc_hit_rate_limit', { p_key: `run-day:${user.id}`, p_max: 600, p_window_seconds: 86400 }))) {
    throw new HttpError(429, 'daily_limit');
  }
  const runId = await rpc<string>('rc_start_run', { p_uid: user.id, p_version: b.version, p_truck: b.truck });
  return { runId };
});
