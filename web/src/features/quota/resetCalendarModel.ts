/**
 * Resets calendar: one lane per account window, built from the same history
 * the pools read (recorded samples, with live reads filling providers the
 * recorder does not cover), so a provider that exists only in the history
 * (Mistral, an API key with no credential file) gets lanes too.
 *
 * Pure: no React, no clock of its own. Positions are fractions of a span the
 * caller passes; projection primitives come from quotaTimelineModel.ts.
 */

import type { QuotaBudget, QuotaHistory, QuotaHistorySample } from '@/services/api';
import { readWindow } from './accountRows';
import { samplesByAccount, windowPeriodHours, type PoolProvider } from './poolModel';
import { DAY_MS, HOUR_MS, windowsIn } from './quotaTimelineModel';

/** The resets view's window filter value that shows every window. */
export const RESETS_FILTER_ALL = 'all';
/** How many resets the "Next resets" list shows. */
export const NEXT_RESETS_LIMIT = 5;

/** Windows this long or longer renew on the calendar month, not every N hours. */
export const MONTHLY_MIN_HOURS = 28 * 24;

/** Period family a lane is filtered by: "5-hour", "Weekly", "Monthly", ... */
export type PeriodClass = string;

/**
 * Normalized period of a window: `hour:5`, `day:1`, `week:1`, `month:1`.
 * Used as the window filter's value and, through `periodClassHours`, its order.
 */
export function periodClassOf(periodHours: number): PeriodClass {
  if (periodHours >= MONTHLY_MIN_HOURS) return 'month:1';
  const hours = Math.round(periodHours);
  if (hours > 0 && hours % 168 === 0) return `week:${hours / 168}`;
  if (hours > 0 && hours % 24 === 0) return `day:${hours / 24}`;
  return `hour:${Math.max(1, hours)}`;
}

const UNIT_HOURS: Record<string, number> = { hour: 1, day: 24, week: 168, month: 720 };

/** Approximate length of a period class in hours, for ordering filter options. */
export function periodClassHours(value: PeriodClass): number {
  const [unit, count] = value.split(':');
  return (UNIT_HOURS[unit] ?? 1) * (Number(count) || 1);
}

/** A window reset the history saw happen, with what was left at the last reading before it. */
export interface ObservedReset {
  at: number;
  /** Remaining percent at the last reading before the reset; null when never read. */
  unspent: number | null;
}

export interface ResetLane {
  /** `authIndex` + window key; stable across renders. */
  id: string;
  provider: PoolProvider;
  authIndex: string;
  accountLabel: string;
  plan: string | null;
  disabled: boolean;
  windowKey: string;
  /** The provider's own window name, when the hub reports one. */
  reportedLabel: string | null;
  periodHours: number;
  periodClass: PeriodClass;
  /** Renews on the calendar month (xAI billing month, Mistral budgets). */
  monthly: boolean;
  /** Renews on first use rather than on a fixed cadence (sub-day windows). */
  usageTriggered: boolean;
  /** Remaining percent in the current window; null without a reading. */
  remaining: number | null;
  /** Next reset, rolled forward past resets that already happened. */
  resetsAt: number | null;
  readAt: number | null;
  budget: QuotaBudget | null;
  /** Resets seen in the recorded samples, oldest first. */
  observed: ObservedReset[];
}

export interface ResetLaneOptions {
  now: number;
  /** Providers to include; all when omitted. */
  providers?: readonly PoolProvider[];
}

/** A reset counts as the same instant within this tolerance (hub rounding, clock skew). */
const resetTolerance = (periodHours: number) => Math.max(HOUR_MS, periodHours * HOUR_MS * 0.02);

const isRenewing = (
  window:
    { usedPercent: number | null; periodHours: number | null; resetsAt: number | null } | undefined
) =>
  Boolean(
    window &&
    window.usedPercent != null &&
    ((window.periodHours !== null && window.periodHours > 0) || window.resetsAt !== null)
  );

/** Resets the samples show for one window key, with the unspent share at each. */
export function observedResets(
  samples: readonly QuotaHistorySample[],
  key: string,
  periodHours: number,
  now: number
): ObservedReset[] {
  const tolerance = resetTolerance(periodHours);
  const out: ObservedReset[] = [];
  let current: { resetsAt: number; remaining: number | null } | null = null;
  const close = () => {
    if (current && current.resetsAt <= now) {
      out.push({ at: current.resetsAt, unspent: current.remaining });
    }
  };
  samples.forEach((sample) => {
    if (sample.error || sample.t > now) return;
    const window = sample.windows[key];
    if (!window || window.resetsAt === null) return;
    if (current && sample.t >= current.resetsAt) {
      // The reading after a reset belongs to the next window.
      close();
      current = null;
    }
    if (current && Math.abs(window.resetsAt - current.resetsAt) > tolerance) {
      close();
      current = null;
    }
    const remaining =
      window.usedPercent == null ? null : Math.min(100, Math.max(0, 100 - window.usedPercent));
    current = { resetsAt: window.resetsAt, remaining: remaining ?? current?.remaining ?? null };
  });
  close();
  return out;
}

/** Every renewing window of every account in the history, one lane each. */
export function buildResetLanes(history: QuotaHistory, options: ResetLaneOptions): ResetLane[] {
  const { now, providers } = options;
  const bySamples = samplesByAccount(history);
  const lanes: ResetLane[] = [];
  history.accounts.forEach((account) => {
    if (!account.provider) return;
    if (providers && !providers.includes(account.provider)) return;
    const samples = bySamples.get(account.authIndex) ?? [];
    const keys: string[] = [];
    const recordedPeriod = new Map<string, number>();
    const labels = new Map<string, string>();
    const budgets = new Map<string, QuotaBudget>();
    samples.forEach((sample) => {
      if (sample.error) return;
      Object.entries(sample.windows).forEach(([key, window]) => {
        if (!isRenewing(window)) return;
        if (!keys.includes(key)) keys.push(key);
        if (window.periodHours !== null && window.periodHours > 0) {
          recordedPeriod.set(key, Math.max(recordedPeriod.get(key) ?? 0, window.periodHours));
        }
        if (window.label) labels.set(key, window.label);
        if (window.budget) budgets.set(key, window.budget);
      });
    });
    keys.forEach((key) => {
      const periodHours = windowPeriodHours(key, recordedPeriod.get(key) ?? null);
      if (periodHours === null || !(periodHours > 0)) return;
      const monthly = periodHours >= MONTHLY_MIN_HOURS;
      const reading = readWindow(samples, key, now);
      // A month is not a fixed number of hours: roll a passed monthly reset by calendar months.
      const resetsAt =
        monthly && reading
          ? rollMonthly(latestReset(samples, key), now)
          : (reading?.resetsAt ?? null);
      lanes.push({
        id: `${account.authIndex}:${key}`,
        provider: account.provider,
        authIndex: account.authIndex,
        accountLabel: account.label || account.authIndex,
        plan: account.plan,
        disabled: account.disabled,
        windowKey: key,
        reportedLabel: labels.get(key) ?? null,
        periodHours,
        periodClass: periodClassOf(periodHours),
        monthly,
        usageTriggered: periodHours < 24,
        remaining: reading?.remaining ?? null,
        resetsAt,
        readAt: reading?.readAt ?? null,
        budget: budgets.get(key) ?? null,
        observed: observedResets(samples, key, periodHours, now),
      });
    });
  });
  return lanes;
}

const latestReset = (samples: readonly QuotaHistorySample[], key: string): number | null => {
  for (let i = samples.length - 1; i >= 0; i -= 1) {
    const window = samples[i].windows[key];
    if (!samples[i].error && window && window.resetsAt !== null) return window.resetsAt;
  }
  return null;
};

/** Add whole UTC calendar months (billing months turn over in UTC). */
export function addMonths(ms: number, months: number): number {
  const date = new Date(ms);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return date.getTime();
}

/** First monthly reset strictly after `now`. */
export function rollMonthly(resetsAt: number | null, now: number): number | null {
  if (resetsAt === null) return null;
  let next = resetsAt;
  for (let guard = 0; next <= now && guard < 240; guard += 1) next = addMonths(next, 1);
  return next > now ? next : null;
}

/** Monthly windows ending at `anchor ± k months` that overlap [from, to]. */
export function monthlyWindowsIn(
  anchorMs: number,
  fromMs: number,
  toMs: number
): { startMs: number; endMs: number }[] {
  if (!Number.isFinite(anchorMs) || !(toMs > fromMs)) return [];
  // Walk back to the first window that ends after `from`, then forward to `to`.
  let k = 0;
  while (addMonths(anchorMs, k - 1) > fromMs && k > -240) k -= 1;
  while (addMonths(anchorMs, k) <= fromMs && k < 240) k += 1;
  const out: { startMs: number; endMs: number }[] = [];
  for (let guard = 0; guard < 24; guard += 1, k += 1) {
    const endMs = addMonths(anchorMs, k);
    const startMs = addMonths(anchorMs, k - 1);
    if (startMs >= toMs) break;
    out.push({ startMs, endMs });
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * Projection onto a span
 * ------------------------------------------------------------------------- */

export interface CalendarBar {
  startMs: number;
  endMs: number;
  /** Fractions of the span, 0..100, clipped to it. */
  leftPercent: number;
  widthPercent: number;
  state: 'past' | 'live' | 'next';
  /** Live: remaining now. Past: what was left at the last reading before it reset. */
  remaining: number | null;
  /** The window opens before / ends after the visible span. */
  clippedStart: boolean;
  clippedEnd: boolean;
}

/**
 * Bars for one lane across [spanStart, spanEnd).
 *
 * Fixed-cadence windows (a day or longer) are projected back and forward from
 * the next reset; elapsed ones carry the unspent share the history saw at
 * their reset. Usage-triggered windows (5-hour) start on first use, so only
 * the current window is drawn: projecting them would invent sixty slivers
 * that never happen, and the recorded ones are back-to-back slivers too.
 */
export function projectResetLane(
  lane: ResetLane,
  spanStart: number,
  spanEnd: number,
  now: number
): CalendarBar[] {
  const span = spanEnd - spanStart;
  if (!(span > 0)) return [];
  const periodMs = lane.periodHours * HOUR_MS;
  const tolerance = resetTolerance(lane.periodHours);

  let windows: { startMs: number; endMs: number }[];
  if (lane.usageTriggered) {
    // Only the window running now: past ones are slivers back to back at this scale.
    windows =
      lane.resetsAt !== null && lane.resetsAt > now
        ? [{ startMs: lane.resetsAt - periodMs, endMs: lane.resetsAt }]
        : [];
  } else if (lane.resetsAt === null) {
    windows = [];
  } else if (lane.monthly) {
    windows = monthlyWindowsIn(lane.resetsAt, spanStart, spanEnd);
  } else {
    windows = windowsIn(lane.resetsAt, periodMs, spanStart, spanEnd);
  }

  const toPercent = (ms: number) => ((ms - spanStart) / span) * 100;
  return windows
    .map((window): CalendarBar | null => {
      const left = Math.max(0, toPercent(window.startMs));
      const right = Math.min(100, toPercent(window.endMs));
      if (right <= 0 || left >= 100 || right <= left) return null;
      const state: CalendarBar['state'] =
        window.endMs <= now ? 'past' : window.startMs <= now ? 'live' : 'next';
      let remaining: number | null = null;
      if (state === 'live' && lane.resetsAt !== null && window.endMs === lane.resetsAt) {
        remaining = lane.remaining;
      } else if (state === 'past') {
        const seen = lane.observed.find((reset) => Math.abs(reset.at - window.endMs) <= tolerance);
        remaining = seen?.unspent ?? null;
      }
      return {
        startMs: window.startMs,
        endMs: window.endMs,
        leftPercent: left,
        widthPercent: right - left,
        state,
        remaining,
        clippedStart: window.startMs < spanStart,
        clippedEnd: window.endMs > spanEnd,
      };
    })
    .filter((bar): bar is CalendarBar => bar !== null);
}

/**
 * The calendar's span: the pools' span snapped to local midnight, the same
 * number of whole days. Date arithmetic, so a DST change keeps every column
 * on a local midnight.
 */
export function calendarSpan(
  span: { start: number; end: number },
  days = Math.round((span.end - span.start) / DAY_MS)
): { startMs: number; endMs: number; days: number } {
  const start = new Date(span.start);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + days);
  end.setHours(0, 0, 0, 0);
  return { startMs: start.getTime(), endMs: end.getTime(), days };
}

/** One column per local day, weighted by its real length (23, 24 or 25 hours). */
export function calendarDays(span: {
  startMs: number;
  days: number;
}): { at: number; durationMs: number }[] {
  const boundary = (index: number) => {
    const date = new Date(span.startMs);
    date.setDate(date.getDate() + index);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
  };
  return Array.from({ length: span.days }, (_, index) => {
    const at = boundary(index);
    return { at, durationMs: boundary(index + 1) - at };
  });
}

/* ---------------------------------------------------------------------------
 * Ordering and the "Next resets" list
 * ------------------------------------------------------------------------- */

export interface LaneGroup {
  authIndex: string;
  /** Lanes of one account, longest window first. */
  lanes: ResetLane[];
}

/**
 * Lanes grouped by account, accounts in routing order: soonest reset of the
 * account's longest window first (soonest-reset-first sends the next new
 * conversation there), disabled accounts and unknown resets last.
 */
export function groupLanesByAccount(lanes: readonly ResetLane[]): LaneGroup[] {
  const groups = new Map<string, ResetLane[]>();
  lanes.forEach((lane) => {
    const list = groups.get(lane.authIndex);
    if (list) list.push(lane);
    else groups.set(lane.authIndex, [lane]);
  });
  const ordered = [...groups.entries()].map(([authIndex, list]) => ({
    authIndex,
    lanes: [...list].sort(
      (a, b) =>
        b.periodHours - a.periodHours ||
        (a.resetsAt ?? Infinity) - (b.resetsAt ?? Infinity) ||
        a.windowKey.localeCompare(b.windowKey)
    ),
  }));
  const primaryReset = (group: LaneGroup) => group.lanes[0]?.resetsAt ?? Infinity;
  return ordered.sort((a, b) => {
    const ad = a.lanes[0]?.disabled ? 1 : 0;
    const bd = b.lanes[0]?.disabled ? 1 : 0;
    if (ad !== bd) return ad - bd;
    const byReset = primaryReset(a) - primaryReset(b);
    if (byReset !== 0 && Number.isFinite(byReset)) return byReset;
    if (primaryReset(a) !== primaryReset(b)) return primaryReset(a) === Infinity ? 1 : -1;
    return a.authIndex.localeCompare(b.authIndex);
  });
}

export interface UpcomingReset {
  lane: ResetLane;
  at: number;
  /** Percent of the window still unspent now. */
  unspent: number | null;
  /** Unspent money, when the window has a budget. */
  unspentMoney: number | null;
}

/**
 * The next resets across lanes, soonest first. Usage-triggered windows are
 * left out unless `includeShort`: they reset every few hours and would crowd
 * out the weekly and monthly resets this list is for.
 */
export function upcomingResets(
  lanes: readonly ResetLane[],
  now: number,
  limit: number,
  includeShort = false
): UpcomingReset[] {
  return lanes
    .filter(
      (lane) =>
        !lane.disabled &&
        lane.resetsAt !== null &&
        lane.resetsAt > now &&
        (includeShort || !lane.usageTriggered)
    )
    .sort((a, b) => a.resetsAt! - b.resetsAt! || a.id.localeCompare(b.id))
    .slice(0, limit)
    .map((lane) => ({
      lane,
      at: lane.resetsAt!,
      unspent: lane.remaining,
      unspentMoney:
        lane.budget && lane.remaining !== null ? (lane.budget.amount * lane.remaining) / 100 : null,
    }));
}
