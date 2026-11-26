// Close a ranked run: claim it once, check it is physically plausible, then bank coins and
// mission rewards in one transaction. Implausible runs are stored as rejected and pay nothing.
import { HttpError, rpc, serveUser } from '../_shared/http.ts';
import { type DbState, forClient, loadState, R } from '../_shared/game.ts';
import { judge, parseReport, scoreOf } from '../_shared/validate.ts';

serveUser('run-finish', { rate: [20, 60] }, async ({ user, body }) => {
  const r = parseReport(body);
  const wall = await rpc<number>('rc_claim_run', { p_uid: user.id, p_run: r.runId });   // once only
  const reason = judge(r, wall);
  const score = scoreOf(r);
  const common = {
    p_uid: user.id, p_run: r.runId, p_score: score, p_dist: Math.floor(r.dist),
    p_coins: r.coins, p_bonus: r.bonus, p_play: r.playTime, p_stats: r.stats,
  };

  if (reason) {
    const st = await rpc<DbState>('rc_commit_run', {
      ...common, p_ok: false, p_reason: reason, p_rev: 0, p_missions: [], p_missions_reward: 0, p_missions_done: 0, p_crash: null,
    });
    return { accepted: false, reason, score, state: forClient(st) };
  }

  // Settle missions against the latest stored state; retry if another request changed them meanwhile.
  for (let i = 0; i < 3; i++) {
    const s = await loadState(user.id);
    const missions = structuredClone(s.missions);
    const live = { ...r.stats, coins: r.coins, dist: r.dist, score, newCrash: !!r.crash && !s.crashes.includes(r.crash) };
    const { reward, done } = R.settleMissions(missions, live);
    const crashes = r.crash && !s.crashes.includes(r.crash) ? [...s.crashes, r.crash] : s.crashes;
    const next = R.fillMissions(missions, s.missions_done + done, crashes.length,
      () => crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32);
    try {
      const st = await rpc<DbState>('rc_commit_run', {
        ...common, p_ok: true, p_reason: null, p_rev: s.missions_rev,
        p_missions: next, p_missions_reward: reward, p_missions_done: done, p_crash: r.crash,
      });
      return {
        accepted: true, score, missionReward: reward, missionsCompleted: done,
        newBest: score >= st.best && score > s.best, state: forClient(st),
      };
    } catch (e) {
      if (e instanceof HttpError && e.code === 'missions_changed') continue;
      throw e;
    }
  }
  throw new HttpError(409, 'busy_try_again');
});
