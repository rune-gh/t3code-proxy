/**
 * Per-account rows under each pool: the latest reading of every window an
 * account reports, which account soonest-reset-first sends the next new
 * conversation to, and how fresh the readings are. Pure; reads the same
 * history the pool chart uses.
 */

import type { QuotaHistory, QuotaHistorySample } from '@/services/api';
import { MINUTE_MS, nextResetAfter, samplesByAccount, type PoolProvider } from './poolModel';

export interface WindowReading {
  /** 0–100, % of the window left now. */
  remaining: number;
  /** Next reset instant, rolled forward past resets that already happened. */
  resetsAt: number | null;
  /** When the reading was taken. */
  readAt: number;
}

export interface PoolAccountInput {
  authIndex: string;
  label: string;
  plan: string | null;
  disabled: boolean;
  /** A live read failed for this account (from the quota cache). */
  liveError?: string;
}

export interface PoolAccountRow extends PoolAccountInput {
  fiveHour: WindowReading | null;
  weekly: WindowReading | null;
  /** Model-scoped weekly window (Claude Fable), when the account reports one. */
  scopedWeekly: WindowReading | null;
  /** Latest successful reading of any window. */
  lastReadAt: number | null;
  /** Error of the newest sample when it is newer than the last success, else the live error. */
  error: string;
  /** Out of 5-hour or weekly allowance right now. */
  exhausted: boolean;
  /** The account soonest-reset-first would pick for the next new conversation. */
  isNext: boolean;
}

/** Backend window keys per column. */
export const ROW_WINDOW_KEYS = {
  fiveHour: 'five_hour',
  weekly: 'seven_day',
  scopedWeekly: 'seven_day_fable',
} as const;

const EPSILON = 1e-6;

/** Latest successful reading of one window key at or before `now`. */
export function readWindow(
  samples: readonly QuotaHistorySample[],
  key: string,
  now: number
): WindowReading | null {
  for (let i = samples.length - 1; i >= 0; i -= 1) {
    const sample = samples[i];
    if (sample.t > now || sample.error) continue;
    const window = sample.windows[key];
    if (!window || window.usedPercent == null) continue;
    const passed = window.resetsAt !== null && window.resetsAt <= now;
    return {
      remaining: passed ? 100 : Math.min(100, Math.max(0, 100 - window.usedPercent)),
      resetsAt: nextResetAfter(window.resetsAt, window.periodHours, now),
      readAt: sample.t,
    };
  }
  return null;
}

/**
 * Mirror of the hub's soonest-reset-first pick among accounts it can see:
 * enabled, read, and not out of allowance; earliest weekly reset wins, ties
 * break on auth index. An estimate: the hub also probes unread accounts first.
 */
export function pickNextAccount(rows: readonly PoolAccountRow[]): string | null {
  let best: PoolAccountRow | null = null;
  rows.forEach((row) => {
    if (row.disabled || row.exhausted || !row.weekly?.resetsAt) return;
    if (
      !best ||
      row.weekly.resetsAt < best.weekly!.resetsAt! ||
      (row.weekly.resetsAt === best.weekly!.resetsAt && row.authIndex < best.authIndex)
    ) {
      best = row;
    }
  });
  return (best as PoolAccountRow | null)?.authIndex ?? null;
}

/** Disabled accounts last; then soonest weekly reset; unknown resets after known ones. */
export function compareAccountRows(a: PoolAccountRow, b: PoolAccountRow): number {
  if (a.disabled !== b.disabled) return a.disabled ? 1 : -1;
  const ar = a.weekly?.resetsAt ?? Infinity;
  const br = b.weekly?.resetsAt ?? Infinity;
  if (ar !== br) return ar - br;
  return a.authIndex < b.authIndex ? -1 : a.authIndex > b.authIndex ? 1 : 0;
}

export function buildPoolAccountRows(
  history: QuotaHistory,
  provider: PoolProvider,
  accounts: readonly PoolAccountInput[],
  now: number
): PoolAccountRow[] {
  const byAccount = samplesByAccount(history);
  const planFromHistory = new Map(
    history.accounts
      .filter((account) => account.provider === provider)
      .map((account) => [account.authIndex, account.plan])
  );

  const rows: PoolAccountRow[] = accounts.map((account) => {
    const samples = byAccount.get(account.authIndex) ?? [];
    const fiveHour = readWindow(samples, ROW_WINDOW_KEYS.fiveHour, now);
    const weekly = readWindow(samples, ROW_WINDOW_KEYS.weekly, now);
    const scopedWeekly =
      provider === 'claude' ? readWindow(samples, ROW_WINDOW_KEYS.scopedWeekly, now) : null;
    const readings = [fiveHour, weekly, scopedWeekly].filter(
      (reading): reading is WindowReading => reading !== null
    );
    const lastReadAt = readings.length ? Math.max(...readings.map((r) => r.readAt)) : null;
    const newest = [...samples].reverse().find((sample) => sample.t <= now);
    const sampleError =
      newest?.error && (lastReadAt === null || newest.t > lastReadAt) ? newest.error : '';
    const exhausted =
      (weekly !== null && weekly.remaining <= EPSILON) ||
      (fiveHour !== null && fiveHour.remaining <= EPSILON);
    return {
      ...account,
      plan: account.plan ?? planFromHistory.get(account.authIndex) ?? null,
      fiveHour,
      weekly,
      scopedWeekly,
      lastReadAt,
      error: sampleError || account.liveError || '',
      exhausted,
      isNext: false,
    };
  });

  const next = pickNextAccount(rows);
  rows.forEach((row) => {
    row.isNext = row.authIndex === next;
  });
  return rows.sort(compareAccountRows);
}

/** Newest reading across rows. */
export const latestReadingAt = (rows: readonly PoolAccountRow[]): number | null => {
  const times = rows.map((row) => row.lastReadAt).filter((t): t is number => t !== null);
  return times.length ? Math.max(...times) : null;
};

/** Readings older than three poll intervals (at least 30 minutes) are stale. */
export const isReadingStale = (
  lastReadAt: number | null,
  now: number,
  intervalSeconds: number
): boolean =>
  lastReadAt !== null && now - lastReadAt > Math.max(30 * MINUTE_MS, 3 * intervalSeconds * 1000);
