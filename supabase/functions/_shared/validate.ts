// Turn a run-finish request body into a checked run. Pure, so it's unit-tested (validate.test.ts).
import { HttpError, is, shape } from './http.ts';
import { R } from './game.ts';

export type RunStats = Record<string, number> & { themes: string[]; themeCoins: Record<string, number> };
export type RunReport = {
  runId: string; version: number; dist: number; coins: number; bonus: number;
  playTime: number; stats: RunStats; crash: string | null;
};

export function parseReport(body: Record<string, unknown>): RunReport {
  const r = shape<RunReport>(body, {
    runId: is.uuid,
    version: is.int(0, 1000),
    dist: is.num(0, 1e6),
    coins: is.int(0, 1e6),
    bonus: is.int(0, 1e8),
    playTime: is.num(0, 1e5),
    stats: is.obj,
    crash: is.nullOr(is.oneOf(R.DEATH_IDS)),
  });
  const s = r.stats as Record<string, unknown>;
  const statSpec: Record<string, (v: unknown) => boolean> = {
    themes: (v) => is.arr(4)(v) && (v as unknown[]).every(is.oneOf(R.THEME_IDS)),
    themeCoins: (v) => is.obj(v) && Object.entries(v as object).every(([k, n]) => R.THEME_IDS.includes(k) && is.int(0, 1e6)(n)),
  };
  for (const k of R.RUN_STAT_KEYS) statSpec[k] = is.int(0, 1e6);
  shape(s, statSpec);
  return r;
}

// null = accept; otherwise the reason the run is not ranked.
export function judge(r: RunReport, wallSeconds: number): string | null {
  return R.checkRun(r, wallSeconds);
}

export function scoreOf(r: RunReport): number {
  return R.score(r);
}

export { HttpError };
