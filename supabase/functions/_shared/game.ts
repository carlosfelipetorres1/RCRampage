import './rules.js';
import { HttpError, rpc } from './http.ts';

// deno-lint-ignore no-explicit-any
export const R: any = (globalThis as any).RCRULES;

export type Mission = { type: string; goal: unknown; reward: number; base: number; done: boolean };
export type DbState = {
  name: string | null; banned: boolean; coins: number; items: string[];
  missions: Mission[]; missions_done: number; missions_rev: number; crashes: string[];
  truck: string; skin: string; imported: boolean; best: number; best_week: number;
};

const rng = () => crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;

// Missions as stored, minus anything malformed, topped up to three.
export function refill(s: DbState): Mission[] {
  const clean = (Array.isArray(s.missions) ? s.missions : []).filter(R.validMission);
  return R.fillMissions(clean, s.missions_done, s.crashes.length, rng);
}

// Player state as the game wants it. Tops missions up when needed.
export async function loadState(uid: string): Promise<DbState> {
  for (let i = 0; i < 3; i++) {
    const s = await rpc<DbState>('rc_get_state', { p_uid: uid });
    if (!s) throw new HttpError(404, 'no_account');
    if (s.banned) throw new HttpError(403, 'banned');
    if (!Array.isArray(s.missions)) s.missions = [];
    const live = s.missions.filter((m) => !m.done);
    if (live.length === 3 && live.every(R.validMission)) return s;
    const filled = refill(s);
    if (await rpc<boolean>('rc_save_missions', { p_uid: uid, p_rev: s.missions_rev, p_missions: filled })) {
      return { ...s, missions: filled, missions_rev: s.missions_rev + 1 };
    }
  }
  throw new HttpError(409, 'busy_try_again');
}

export function forClient(s: DbState) {
  const inv = R.inventory(s.items);
  return {
    name: s.name, coins: s.coins, trucks: inv.trucks, upgrades: inv.upgrades, skins: inv.skins, skin: s.skin,
    missions: s.missions, missionsDone: s.missions_done, crashes: s.crashes,
    truck: s.truck, imported: s.imported, best: s.best, bestWeek: s.best_week,
  };
}
