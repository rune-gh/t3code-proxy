/**
 * Quota pool model: pooled remaining capacity per provider, recorded history,
 * burn rate, and a soonest-reset-first drain projection.
 *
 * Pure functions — no React, no clock of its own (`now` is always passed in),
 * so every rule here is covered directly by tests/quotaPoolModel.test.ts.
 *
 * Units: an account's remaining is 0–100 (% of its own window). Pooled values
 * are weighted: an account with plan weight 2.5 contributes up to 250 points,
 * and the pool maximum is `100 × Σ weights`.
 */

import type {
  QuotaHistory,
  QuotaHistoryAccount,
  QuotaHistorySample,
  QuotaHistoryWindow,
} from '@/services/api/quotaHistory';
import { DAY_MS, HOUR_MS, MINUTE_MS } from '@/utils/time/durations';

export { DAY_MS, HOUR_MS, MINUTE_MS };

/* ---------------------------------------------------------------------------
 * Providers, windows, weights
 * ------------------------------------------------------------------------- */

/** Providers whose weekly windows are pooled into a chart card. */
export const POOL_PROVIDERS = ['claude', 'codex'] as const;
export type PoolProvider = (typeof POOL_PROVIDERS)[number];

export const isPoolProvider = (value: string): value is PoolProvider =>
  (POOL_PROVIDERS as readonly string[]).includes(value);

/** Card-level window choice. `fable` prefers the Fable weekly window per account. */
export type PoolWindowChoice = 'weekly' | 'fable' | 'five_hour';

/** Backend window keys tried in order for each choice. */
export const POOL_WINDOW_KEYS: Record<PoolWindowChoice, readonly string[]> = {
  fable: ['seven_day_fable', 'seven_day'],
  weekly: ['seven_day'],
  five_hour: ['five_hour'],
};

export const poolWindowChoices = (provider: PoolProvider): PoolWindowChoice[] =>
  provider === 'claude' ? ['weekly', 'fable', 'five_hour'] : ['weekly', 'five_hour'];

export const defaultPoolWindow = (provider: PoolProvider): PoolWindowChoice =>
  provider === 'claude' ? 'fable' : 'weekly';

/** Plan → weight (1 = one full account). Missing plans weigh 1. */
export type PlanWeights = Record<string, number>;

export const weightForPlan = (weights: PlanWeights | undefined, plan: string | null): number => {
  const value = weights?.[plan ?? ''];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 1;
};

/* ---------------------------------------------------------------------------
 * Account tracks
 * ------------------------------------------------------------------------- */

export interface TrackPoint {
  t: number;
  /** 0–100, % of this account's window left. */
  remaining: number;
  resetsAt: number | null;
  periodHours: number | null;
}

export interface AccountTrack {
  authIndex: string;
  label: string;
  plan: string | null;
  weight: number;
  /** Backend window key this account contributes (e.g. `seven_day_fable`). */
  windowKey: string;
  /** Successful samples, ascending by time. */
  points: TrackPoint[];
}

const clampPercent = (value: number): number => Math.min(100, Math.max(0, value));

/**
 * The window an account contributes for a choice: the first preferred key any
 * of its successful samples carries. Fixed per account so one series never
 * mixes two windows.
 */
export function selectWindowKey(
  samples: readonly QuotaHistorySample[],
  choice: PoolWindowChoice
): string | null {
  for (const key of POOL_WINDOW_KEYS[choice]) {
    if (samples.some((s) => !s.error && s.windows[key]?.usedPercent != null)) return key;
  }
  return null;
}

/** Group samples by account once; the caller filters by provider. */
export function samplesByAccount(history: QuotaHistory): Map<string, QuotaHistorySample[]> {
  const byAccount = new Map<string, QuotaHistorySample[]>();
  history.samples.forEach((sample) => {
    const list = byAccount.get(sample.authIndex);
    if (list) list.push(sample);
    else byAccount.set(sample.authIndex, [sample]);
  });
  byAccount.forEach((list) => list.sort((a, b) => a.t - b.t));
  return byAccount;
}

/** Enabled accounts of a provider that have at least one sample for the chosen window. */
export function buildAccountTracks(
  history: QuotaHistory,
  provider: PoolProvider,
  choice: PoolWindowChoice,
  weights?: PlanWeights
): AccountTrack[] {
  const byAccount = samplesByAccount(history);
  const tracks: AccountTrack[] = [];
  history.accounts
    .filter((account) => account.provider === provider && !account.disabled)
    .forEach((account) => {
      const samples = byAccount.get(account.authIndex) ?? [];
      const windowKey = selectWindowKey(samples, choice);
      if (!windowKey) return;
      const points: TrackPoint[] = [];
      samples.forEach((sample) => {
        if (sample.error) return;
        const window: QuotaHistoryWindow | undefined = sample.windows[windowKey];
        if (!window || window.usedPercent == null) return;
        points.push({
          t: sample.t,
          remaining: clampPercent(100 - window.usedPercent),
          resetsAt: window.resetsAt,
          periodHours: window.periodHours,
        });
      });
      if (points.length === 0) return;
      tracks.push({
        authIndex: account.authIndex,
        label: account.label || account.authIndex,
        plan: account.plan,
        weight: weightForPlan(weights, account.plan),
        windowKey,
        points,
      });
    });
  return tracks;
}

/** Index of the last point at or before `t`, or -1. */
function lastIndexAtOrBefore(points: readonly TrackPoint[], t: number): number {
  let lo = 0;
  let hi = points.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t <= t) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/**
 * Account remaining (0–100) at `t`: the latest sample carried forward, refilled
 * to 100 once its reported reset has passed. Before the first sample the first
 * value is held, so an account entering the record doesn't read as a reset.
 */
export function remainingAt(track: AccountTrack, t: number): number {
  const index = lastIndexAtOrBefore(track.points, t);
  if (index < 0) return track.points[0].remaining;
  const point = track.points[index];
  if (point.resetsAt !== null && point.resetsAt <= t) return 100;
  return point.remaining;
}

export const pooledAt = (tracks: readonly AccountTrack[], t: number): number =>
  tracks.reduce((sum, track) => sum + remainingAt(track, t) * track.weight, 0);

export const poolMax = (tracks: readonly AccountTrack[]): number =>
  tracks.reduce((sum, track) => sum + 100 * track.weight, 0);

/** First reset strictly after `t`, rolling a past reset forward by whole periods. */
export function nextResetAfter(
  resetsAt: number | null,
  periodHours: number | null,
  t: number
): number | null {
  if (resetsAt === null) return null;
  if (resetsAt > t) return resetsAt;
  if (!periodHours || periodHours <= 0) return null;
  const periodMs = periodHours * HOUR_MS;
  const periods = Math.floor((t - resetsAt) / periodMs) + 1;
  return resetsAt + periods * periodMs;
}

/* ---------------------------------------------------------------------------
 * Burn rate
 * ------------------------------------------------------------------------- */

/** Shortest record that yields a burn rate; below this the rate reads as 0. */
const MIN_BURN_COVERAGE_MS = 10 * MINUTE_MS;

/**
 * Pooled drain in weighted %/h over `[now − windowHours, now]`.
 *
 * Sums only drops between consecutive observations of each account, so an
 * upward reset jump never offsets consumption. Duration is the part of the
 * window actually covered by the record. Never negative.
 */
export function computeBurnRate(
  tracks: readonly AccountTrack[],
  now: number,
  windowHours: number
): number {
  const start = now - windowHours * HOUR_MS;
  let earliest = Infinity;
  let consumed = 0;
  tracks.forEach((track) => {
    if (track.points.length === 0 || track.points[0].t > now) return;
    earliest = Math.min(earliest, track.points[0].t);
    const times = [start];
    for (let i = lastIndexAtOrBefore(track.points, start) + 1; i < track.points.length; i += 1) {
      const point = track.points[i];
      if (point.t > now) break;
      times.push(point.t);
    }
    // Evaluate at reset instants too, so post-refill consumption is counted.
    track.points.forEach((point) => {
      if (point.resetsAt !== null && point.resetsAt > start && point.resetsAt < now) {
        times.push(point.resetsAt);
      }
    });
    times.push(now);
    times.sort((a, b) => a - b);
    let previous = remainingAt(track, times[0]);
    for (let i = 1; i < times.length; i += 1) {
      const current = remainingAt(track, times[i]);
      if (current < previous) consumed += (previous - current) * track.weight;
      previous = current;
    }
  });
  if (!Number.isFinite(earliest)) return 0;
  const covered = now - Math.max(start, earliest);
  if (covered < MIN_BURN_COVERAGE_MS) return 0;
  return Math.max(0, consumed / (covered / HOUR_MS));
}

/* ---------------------------------------------------------------------------
 * Soonest-reset-first drain simulation
 * ------------------------------------------------------------------------- */

export interface SimAccount {
  authIndex: string;
  label: string;
  weight: number;
  /** 0–100. */
  remaining: number;
  nextReset: number | null;
  periodMs: number | null;
}

export interface SeriesPoint {
  t: number;
  value: number;
}

export interface PoolJump {
  t: number;
  /** Weighted points added. */
  amount: number;
  /** Pooled value right after the jump (label anchor). */
  value: number;
  projected: boolean;
}

export interface FirstEmpty {
  authIndex: string;
  label: string;
  at: number;
}

export interface DrainSimulation {
  points: SeriesPoint[];
  ratePoints: SeriesPoint[];
  accountPoints: Map<string, SeriesPoint[]>;
  accountRatePoints: Map<string, SeriesPoint[]>;
  resets: PoolJump[];
  poolEmptyAt: number | null;
  firstEmpty: FirstEmpty | null;
}

export interface DrainOptions {
  start: number;
  end: number;
  /** Pooled weighted %/h. */
  ratePerHour: number;
  stepMs?: number;
}

const EPSILON = 1e-6;
/** Resets this close together read as one step. */
const RESET_MERGE_MS = MINUTE_MS;

export const DEFAULT_PROJECTION_STEP_MS = 15 * MINUTE_MS;

const soonestResetOrder = (a: SimAccount, b: SimAccount): number => {
  const ar = a.nextReset ?? Infinity;
  const br = b.nextReset ?? Infinity;
  if (ar !== br) return ar - br;
  return a.authIndex < b.authIndex ? -1 : a.authIndex > b.authIndex ? 1 : 0;
};

/**
 * Project the pool forward. The hub routes soonest-reset-first, so each
 * segment's demand is taken from the account whose window resets soonest and
 * still has quota, spilling to the next one when it runs dry. An account at 0
 * waits for its reset; at `nextReset` (and every period after) it refills.
 */
export function simulateDrain(
  input: readonly SimAccount[],
  options: DrainOptions
): DrainSimulation {
  const { start, end } = options;
  const rate = Math.max(0, options.ratePerHour);
  const stepMs = Math.max(MINUTE_MS, options.stepMs ?? DEFAULT_PROJECTION_STEP_MS);
  const accounts = input.map((account) => ({
    ...account,
    remaining: clampPercent(account.remaining),
  }));

  const points: SeriesPoint[] = [];
  const ratePoints: SeriesPoint[] = [];
  const accountPoints = new Map<string, SeriesPoint[]>(accounts.map((a) => [a.authIndex, []]));
  const accountRatePoints = new Map<string, SeriesPoint[]>(accounts.map((a) => [a.authIndex, []]));
  const resets: PoolJump[] = [];
  let poolEmptyAt: number | null = null;
  let firstEmpty: FirstEmpty | null = null;

  const pooled = () => accounts.reduce((sum, a) => sum + a.remaining * a.weight, 0);
  const emit = (t: number) => {
    points.push({ t, value: pooled() });
    accounts.forEach((a) =>
      accountPoints.get(a.authIndex)!.push({ t, value: a.remaining * a.weight })
    );
  };
  const noteFirstEmpty = (account: SimAccount, at: number) => {
    if (!firstEmpty) firstEmpty = { authIndex: account.authIndex, label: account.label, at };
  };

  // Accounts already dry at the start count as empty "now".
  [...accounts].sort(soonestResetOrder).forEach((account) => {
    if (account.remaining <= EPSILON) noteFirstEmpty(account, start);
  });
  if (accounts.length > 0 && pooled() <= EPSILON) poolEmptyAt = start;

  emit(start);
  let t = start;
  while (t < end) {
    const gridNext = Math.min(t + stepMs, end);
    let segmentEnd = gridNext;
    accounts.forEach((a) => {
      if (a.nextReset !== null && a.nextReset > t && a.nextReset < segmentEnd) {
        segmentEnd = a.nextReset;
      }
    });
    const hours = (segmentEnd - t) / HOUR_MS;

    // Drain this segment in soonest-reset-first order, tracking exact crossings.
    let demand = rate * hours;
    let elapsedDemand = 0;
    const consumedBy = new Map<string, number>();
    const poolBefore = pooled();
    for (const account of [...accounts].sort(soonestResetOrder)) {
      if (demand <= EPSILON) break;
      const available = account.remaining * account.weight;
      if (available <= EPSILON) continue;
      const take = Math.min(available, demand);
      account.remaining = Math.max(0, (available - take) / account.weight);
      demand -= take;
      elapsedDemand += take;
      consumedBy.set(account.authIndex, take);
      if (account.remaining <= EPSILON) {
        account.remaining = 0;
        noteFirstEmpty(account, t + (elapsedDemand / rate) * HOUR_MS);
      }
    }

    const consumed = elapsedDemand;
    const segmentRate = hours > 0 ? consumed / hours : 0;
    if (poolEmptyAt === null && poolBefore > EPSILON && pooled() <= EPSILON && rate > 0) {
      const emptyAt = t + (poolBefore / rate) * HOUR_MS;
      poolEmptyAt = emptyAt;
      // Kink exactly where the pool runs dry, and drop the rate to 0 there.
      if (emptyAt < segmentEnd) {
        points.push({ t: emptyAt, value: 0 });
        ratePoints.push({ t, value: rate }, { t: emptyAt, value: rate });
        ratePoints.push({ t: emptyAt, value: 0 }, { t: segmentEnd, value: 0 });
      } else {
        ratePoints.push({ t, value: rate }, { t: segmentEnd, value: rate });
      }
    } else {
      ratePoints.push({ t, value: segmentRate }, { t: segmentEnd, value: segmentRate });
    }
    accounts.forEach((a) => {
      const perHour = hours > 0 ? (consumedBy.get(a.authIndex) ?? 0) / hours : 0;
      accountRatePoints
        .get(a.authIndex)!
        .push({ t, value: perHour }, { t: segmentEnd, value: perHour });
    });

    t = segmentEnd;
    emit(t);

    // Refill accounts whose window resets now; vertical step in the series.
    let refill = 0;
    accounts.forEach((a) => {
      if (a.nextReset === null || a.nextReset > t) return;
      refill += (100 - a.remaining) * a.weight;
      a.remaining = 100;
      a.nextReset = a.periodMs ? nextResetAfter(a.nextReset, a.periodMs / HOUR_MS, t) : null;
    });
    if (refill > EPSILON) {
      emit(t);
      const value = pooled();
      const last = resets[resets.length - 1];
      if (last && t - last.t <= RESET_MERGE_MS) {
        last.amount += refill;
        last.value = value;
      } else {
        resets.push({ t, amount: refill, value, projected: true });
      }
    }
  }

  return { points, ratePoints, accountPoints, accountRatePoints, resets, poolEmptyAt, firstEmpty };
}

/** Account state at `now`, ready for simulateDrain. */
export function simAccountsAt(tracks: readonly AccountTrack[], now: number): SimAccount[] {
  return tracks.map((track) => {
    const index = lastIndexAtOrBefore(track.points, now);
    const latest = track.points[Math.max(0, index)];
    return {
      authIndex: track.authIndex,
      label: track.label,
      weight: track.weight,
      remaining: remainingAt(track, now),
      nextReset: nextResetAfter(latest.resetsAt, latest.periodHours, now),
      periodMs: latest.periodHours ? latest.periodHours * HOUR_MS : null,
    };
  });
}

/* ---------------------------------------------------------------------------
 * Recorded series
 * ------------------------------------------------------------------------- */

/** Smallest step that is annotated as a reset jump, in weighted points. */
export const JUMP_MIN_POINTS = 5;

/** Regular sample grid over `[from, to]`, always ending exactly at `to`. */
export function sampleGrid(from: number, to: number, stepMs: number): number[] {
  if (to < from) return [];
  const out: number[] = [];
  const step = Math.max(MINUTE_MS, stepMs);
  for (let t = Math.ceil(from / step) * step; t < to; t += step) out.push(t);
  if (out.length === 0 || out[0] > from) out.unshift(from);
  out.push(to);
  return out;
}

/** Merge consecutive rises into single jumps; keep those at least `minPoints` tall. */
export function detectJumps(
  points: readonly SeriesPoint[],
  minPoints = JUMP_MIN_POINTS
): PoolJump[] {
  const jumps: PoolJump[] = [];
  let rise = 0;
  for (let i = 1; i <= points.length; i += 1) {
    const delta = i < points.length ? points[i].value - points[i - 1].value : -1;
    if (delta > EPSILON) {
      rise += delta;
      continue;
    }
    if (rise >= minPoints) {
      const top = points[i - 1];
      jumps.push({ t: top.t, amount: rise, value: top.value, projected: false });
    }
    rise = 0;
  }
  return jumps;
}

/* ---------------------------------------------------------------------------
 * Pool view (everything a card renders)
 * ------------------------------------------------------------------------- */

/** Future usage relative to the measured burn rate. */
export type FutureUsage = 'same' | 'none' | 'double';

export const FUTURE_USAGE_FACTOR: Record<FutureUsage, number> = {
  same: 1,
  none: 0,
  double: 2,
};

export interface PoolViewOptions {
  provider: PoolProvider;
  window: PoolWindowChoice;
  weights?: PlanWeights;
  now: number;
  spanStart: number;
  spanEnd: number;
  burnWindowHours: number;
  futureUsage: FutureUsage;
  projectionStepMs?: number;
  /** Projection keeps running past the span so stats (next reset) stay meaningful. */
  minProjectionMs?: number;
}

export interface PoolAccountSeries {
  authIndex: string;
  label: string;
  recorded: SeriesPoint[];
  recordedRate: SeriesPoint[];
  projected: SeriesPoint[];
  projectedRate: SeriesPoint[];
}

export interface PoolView {
  provider: PoolProvider;
  tracks: AccountTrack[];
  max: number;
  current: number;
  burnRate: number;
  recorded: SeriesPoint[];
  recordedRate: SeriesPoint[];
  projected: SeriesPoint[];
  projectedRate: SeriesPoint[];
  jumps: PoolJump[];
  accounts: PoolAccountSeries[];
  /** Within the span only. */
  poolEmptyAt: number | null;
  firstEmpty: FirstEmpty | null;
  nextReset: { at: number; amount: number } | null;
}

const clip = (points: readonly SeriesPoint[], from: number, to: number): SeriesPoint[] =>
  points.filter((p) => p.t >= from && p.t <= to);

export function buildPoolView(history: QuotaHistory, options: PoolViewOptions): PoolView {
  const { provider, now, spanStart, spanEnd, burnWindowHours } = options;
  const tracks = buildAccountTracks(history, provider, options.window, options.weights);
  const max = poolMax(tracks);
  const empty: PoolView = {
    provider,
    tracks,
    max,
    current: 0,
    burnRate: 0,
    recorded: [],
    recordedRate: [],
    projected: [],
    projectedRate: [],
    jumps: [],
    accounts: [],
    poolEmptyAt: null,
    firstEmpty: null,
    nextReset: null,
  };
  if (tracks.length === 0) return empty;

  const current = pooledAt(tracks, now);
  const burnRate = computeBurnRate(tracks, now, burnWindowHours);

  // Recorded: regular grid from the first sample (or span start) up to now.
  const firstSampleAt = Math.min(...tracks.map((track) => track.points[0].t));
  const recordedFrom = Math.max(spanStart, firstSampleAt);
  const recordedTo = Math.min(now, spanEnd);
  const grid = sampleGrid(recordedFrom, recordedTo, history.intervalSeconds * 1000);
  const recorded = grid.map((t) => ({ t, value: pooledAt(tracks, t) }));
  const recordedRate = grid.map((t) => ({
    t,
    value: computeBurnRate(tracks, t, burnWindowHours),
  }));
  const jumps = detectJumps(recorded);

  // Projection: simulate from now; display only the in-span part.
  const factor = FUTURE_USAGE_FACTOR[options.futureUsage];
  const simEnd = Math.max(spanEnd, now + (options.minProjectionMs ?? 8 * DAY_MS));
  const sim = simulateDrain(simAccountsAt(tracks, now), {
    start: now,
    end: simEnd,
    ratePerHour: burnRate * factor,
    stepMs: options.projectionStepMs,
  });
  const projectFrom = Math.max(now, spanStart);
  const visibleProjection = spanEnd > now;
  const projected = visibleProjection ? clip(sim.points, projectFrom, spanEnd) : [];
  const projectedRate = visibleProjection ? clip(sim.ratePoints, projectFrom, spanEnd) : [];
  sim.resets
    .filter((jump) => jump.amount >= JUMP_MIN_POINTS && jump.t >= spanStart && jump.t <= spanEnd)
    .forEach((jump) => jumps.push(jump));

  const accounts: PoolAccountSeries[] = tracks.map((track) => ({
    authIndex: track.authIndex,
    label: track.label,
    recorded: grid.map((t) => ({ t, value: remainingAt(track, t) * track.weight })),
    recordedRate: grid.map((t) => ({
      t,
      value: computeBurnRate([track], t, burnWindowHours),
    })),
    projected: visibleProjection
      ? clip(sim.accountPoints.get(track.authIndex) ?? [], projectFrom, spanEnd)
      : [],
    projectedRate: visibleProjection
      ? clip(sim.accountRatePoints.get(track.authIndex) ?? [], projectFrom, spanEnd)
      : [],
  }));

  const firstReset = sim.resets[0];
  return {
    provider,
    tracks,
    max,
    current,
    burnRate,
    recorded,
    recordedRate,
    projected,
    projectedRate,
    jumps,
    accounts,
    poolEmptyAt: sim.poolEmptyAt !== null && sim.poolEmptyAt <= spanEnd ? sim.poolEmptyAt : null,
    firstEmpty: sim.firstEmpty && sim.firstEmpty.at <= spanEnd ? sim.firstEmpty : null,
    nextReset: firstReset ? { at: firstReset.t, amount: firstReset.amount } : null,
  };
}

/* ---------------------------------------------------------------------------
 * Span navigation
 * ------------------------------------------------------------------------- */

export const POOL_SPAN_DAYS = 14;
/** "Now" sits a quarter of the way into the default span. */
export const POOL_NOW_FRACTION = 0.25;

export interface PoolSpan {
  start: number;
  end: number;
}

export function defaultPoolSpan(now: number, days = POOL_SPAN_DAYS): PoolSpan {
  const length = days * DAY_MS;
  const start = now - length * POOL_NOW_FRACTION;
  return { start, end: start + length };
}

/** Pan by half a span (a week by default). */
export function shiftPoolSpan(span: PoolSpan, direction: -1 | 1): PoolSpan {
  const delta = ((span.end - span.start) / 2) * direction;
  return { start: span.start + delta, end: span.end + delta };
}

/** Local day starts inside the span (tick boundaries). */
export function dayStarts(start: number, end: number): number[] {
  const out: number[] = [];
  const d = new Date(start);
  d.setHours(0, 0, 0, 0);
  while (d.getTime() <= end) {
    if (d.getTime() >= start) out.push(d.getTime());
    d.setDate(d.getDate() + 1);
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * Live-snapshot fallback
 * ------------------------------------------------------------------------- */

export interface LiveWindowLike {
  id: string;
  usedPercent: number | null;
  resetAtMs?: number | null;
  periodHours?: number | null;
}

export interface LiveAccountInput {
  authIndex: string;
  provider: PoolProvider;
  label: string;
  plan: string | null;
  disabled: boolean;
  windows: readonly LiveWindowLike[] | null;
}

/** Live card window ids → history window keys. */
const LIVE_WINDOW_KEYS: Record<PoolProvider, Record<string, string>> = {
  claude: {
    'five-hour': 'five_hour',
    'seven-day': 'seven_day',
    'seven-day-fable': 'seven_day_fable',
  },
  codex: {
    'five-hour': 'five_hour',
    weekly: 'seven_day',
  },
};

/**
 * Without recorded history the page still has each credential's latest live
 * quota read. Express those as a one-sample-per-account history so the same
 * pool model renders a current point (and its projection).
 */
export function historyFromLiveSnapshots(
  inputs: readonly LiveAccountInput[],
  now: number
): QuotaHistory {
  const accounts: QuotaHistoryAccount[] = [];
  const samples: QuotaHistorySample[] = [];
  inputs.forEach((input) => {
    accounts.push({
      authIndex: input.authIndex,
      provider: input.provider,
      label: input.label,
      plan: input.plan,
      disabled: input.disabled,
    });
    if (!input.windows) return;
    const windows: Record<string, QuotaHistoryWindow> = {};
    input.windows.forEach((window) => {
      const key = LIVE_WINDOW_KEYS[input.provider][window.id];
      if (!key || window.usedPercent == null) return;
      windows[key] = {
        usedPercent: window.usedPercent,
        resetsAt: window.resetAtMs ?? null,
        periodHours: window.periodHours ?? null,
      };
    });
    if (Object.keys(windows).length > 0) {
      samples.push({ t: now, authIndex: input.authIndex, windows, error: '' });
    }
  });
  return { enabled: false, intervalSeconds: 600, now, accounts, samples };
}
