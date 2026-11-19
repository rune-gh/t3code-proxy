/**
 * Quota pool model: pooled remaining capacity per provider, recorded history,
 * burn rate, and a soonest-reset-first drain projection.
 *
 * Pure functions — no React, no clock of its own (`now` is always passed in),
 * so every rule here is covered directly by tests/quotaPoolModel.test.ts.
 *
 * Units: an account's remaining is 0–100 (% of its own window). Pooled values
 * are percent of the heaviest plan in the pool: that plan's account counts as
 * 100%, a lighter plan as `100 × weight / heaviest weight` (Max 5x = 100%,
 * Pro = 20%), and the pool maximum is the sum of those capacities. An
 * unweighted pool therefore reads as `N × 100%`.
 */

import type {
  QuotaHistory,
  QuotaHistoryAccount,
  QuotaHistorySample,
  QuotaHistoryWindow,
} from '@/services/api/quotaHistory';
import { DAY_MS, HOUR_MS, MINUTE_MS } from '@/utils/time/durations';
import type { LiveWindow } from './liveWindows';
import { claudePlanIncludesFable } from '@/utils/quota/claudePlans';
import { planKey } from './poolPrefs';

export { DAY_MS, HOUR_MS, MINUTE_MS };

/* ---------------------------------------------------------------------------
 * Providers, windows, weights
 * ------------------------------------------------------------------------- */

/**
 * Providers pooled even before the hub records history: their live quota reads
 * map onto history window keys (see `historyFromLiveSnapshots`). Every other
 * provider gets a pool card as soon as the quota history carries a renewing
 * window for it.
 */
export const LIVE_POOL_PROVIDERS = ['claude', 'codex'] as const;

/** Any quota-history provider key (`claude`, `codex`, `xai`, `antigravity`, ...). */
export type PoolProvider = string;

export const isLivePoolProvider = (value: string): boolean =>
  (LIVE_POOL_PROVIDERS as readonly string[]).includes(value);

/**
 * Card-level window choice. Claude and Codex keep their named choices
 * (`weekly`, `fable`, `five_hour`); `fable` prefers the Fable weekly window
 * per account. Every other provider chooses a backend window key directly.
 */
export type PoolWindowChoice = string;

/** Backend window keys tried in order for each named choice. */
export const POOL_WINDOW_KEYS: Record<string, readonly string[]> = {
  fable: ['seven_day_fable', 'seven_day'],
  weekly: ['seven_day'],
  five_hour: ['five_hour'],
};

/**
 * Window keys a choice reads, in preference order. The named choices are
 * aliases for Claude and Codex only; for every other provider a choice is the
 * backend key itself, so a provider's own `weekly` window is not read as
 * `seven_day`.
 */
export const windowKeysForChoice = (
  choice: PoolWindowChoice,
  provider: PoolProvider
): readonly string[] =>
  isLivePoolProvider(provider) && Object.prototype.hasOwnProperty.call(POOL_WINDOW_KEYS, choice)
    ? POOL_WINDOW_KEYS[choice]
    : [choice];

const LEGACY_WINDOW_CHOICES: Record<string, PoolWindowChoice[]> = {
  claude: ['weekly', 'fable', 'five_hour'],
  codex: ['weekly', 'five_hour'],
};

const LEGACY_DEFAULT_WINDOW: Record<string, PoolWindowChoice> = {
  claude: 'weekly',
  codex: 'weekly',
};

/* ---------------------------------------------------------------------------
 * Window keys
 * ------------------------------------------------------------------------- */

export type WindowUnit = 'hour' | 'day' | 'week' | 'month';

export interface ParsedWindowKey {
  /** Renewal period named by the key, normalized (`seven_day` → 1 week); null if none. */
  span: { count: number; unit: WindowUnit } | null;
  /** What the window is scoped to (`seven_day_fable` → `Fable`); null for the whole account. */
  scope: string | null;
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  twelve: 12,
  fourteen: 14,
  twenty: 20,
  thirty: 30,
};

const UNIT_WORDS: Record<string, WindowUnit> = {
  h: 'hour',
  hr: 'hour',
  hrs: 'hour',
  hour: 'hour',
  hours: 'hour',
  d: 'day',
  day: 'day',
  days: 'day',
  w: 'week',
  wk: 'week',
  week: 'week',
  weeks: 'week',
  month: 'month',
  months: 'month',
};

const ADVERB_SPANS: Record<string, { count: number; unit: WindowUnit }> = {
  hourly: { count: 1, unit: 'hour' },
  daily: { count: 1, unit: 'day' },
  weekly: { count: 1, unit: 'week' },
  monthly: { count: 1, unit: 'month' },
};

const UNIT_HOURS: Record<WindowUnit, number> = { hour: 1, day: 24, week: 168, month: 720 };

/** 24 hours → 1 day, 7 days → 1 week, 30/31 days → 1 month. */
function normalizeSpan(count: number, unit: WindowUnit): { count: number; unit: WindowUnit } {
  if (unit === 'hour' && count > 0 && count % 168 === 0)
    return { count: count / 168, unit: 'week' };
  if (unit === 'hour' && count > 0 && count % 24 === 0) return { count: count / 24, unit: 'day' };
  if (unit === 'day' && (count === 30 || count === 31)) return { count: 1, unit: 'month' };
  if (unit === 'day' && count > 0 && count % 7 === 0) return { count: count / 7, unit: 'week' };
  return { count, unit };
}

const titleWord = (word: string) =>
  /^\d/.test(word) ? word : word.charAt(0).toUpperCase() + word.slice(1);

/**
 * Read a backend window key such as `five_hour`, `seven_day_fable`, `monthly`,
 * `5h`, `daily_gemini_pro` or `seven_day_opus`. Never throws; a key it cannot
 * read comes back as a scope with no span.
 */
export function parseWindowKey(key: string): ParsedWindowKey {
  const tokens = key
    .trim()
    .toLowerCase()
    .split(/[\s_.:-]+/)
    .filter(Boolean);
  let span: ParsedWindowKey['span'] = null;
  let from = -1;
  let to = -1;
  for (let i = 0; i < tokens.length && !span; i += 1) {
    const token = tokens[i];
    if (ADVERB_SPANS[token]) {
      span = ADVERB_SPANS[token];
      from = i;
      to = i;
      break;
    }
    const compact = /^(\d+)(h|hr|hrs|d|w|wk)$/.exec(token);
    if (compact) {
      span = normalizeSpan(Number(compact[1]), UNIT_WORDS[compact[2]]);
      from = i;
      to = i;
      break;
    }
    const count = /^\d+$/.test(token) ? Number(token) : NUMBER_WORDS[token];
    const unit = UNIT_WORDS[tokens[i + 1] ?? ''];
    if (count && unit) {
      span = normalizeSpan(count, unit);
      from = i;
      to = i + 1;
      break;
    }
    if (token === 'hour' || token === 'day' || token === 'week' || token === 'month') {
      span = { count: 1, unit: token };
      from = i;
      to = i;
      break;
    }
  }
  const rest = tokens.filter((_, index) => index < from || index > to);
  return { span, scope: rest.length ? rest.map(titleWord).join(' ') : null };
}

/** Length of a window in hours: the recorded period first, else what its key names. */
export function windowPeriodHours(key: string, recorded: number | null): number | null {
  if (recorded !== null && recorded > 0) return recorded;
  const { span } = parseWindowKey(key);
  return span ? span.count * UNIT_HOURS[span.unit] : null;
}

export interface ProviderWindow {
  key: string;
  /** Longest recorded period, else the period the key names; null when unknown. */
  periodHours: number | null;
  /** The provider's own name for the window, from the newest sample that has one. */
  label: string | null;
}

/**
 * A window renews when the hub reports its period or its next reset. One-off
 * balances (credits, a monthly spend cap with no reset) do not pool.
 */
const isRenewing = (window: QuotaHistoryWindow | undefined): boolean =>
  Boolean(
    window &&
    window.usedPercent != null &&
    ((window.periodHours !== null && window.periodHours > 0) || window.resetsAt !== null)
  );

/**
 * Renewing window keys any enabled account of a provider reports, longest
 * first; windows of the same length keep the order the provider reports them
 * in, so the default is the weekly window of its first group.
 */
export function providerWindows(history: QuotaHistory, provider: PoolProvider): ProviderWindow[] {
  const accounts = new Set(
    history.accounts
      .filter((account) => account.provider === provider && !account.disabled)
      .map((account) => account.authIndex)
  );
  const periods = new Map<string, number | null>();
  const labels = new Map<string, { t: number; label: string }>();
  history.samples.forEach((sample) => {
    if (sample.error || !accounts.has(sample.authIndex)) return;
    Object.entries(sample.windows).forEach(([key, window]) => {
      if (!isRenewing(window)) return;
      if (window.label && sample.t >= (labels.get(key)?.t ?? -Infinity)) {
        labels.set(key, { t: sample.t, label: window.label });
      }
      const previous = periods.get(key) ?? null;
      const period =
        window.periodHours !== null && window.periodHours > 0 ? window.periodHours : null;
      periods.set(
        key,
        period !== null && (previous === null || period > previous) ? period : previous
      );
    });
  });
  const order = [...periods.keys()];
  return [...periods.entries()]
    .map(([key, recorded]) => ({
      key,
      periodHours: windowPeriodHours(key, recorded),
      label: labels.get(key)?.label ?? null,
    }))
    .sort((a, b) => {
      const ap = a.periodHours ?? -1;
      const bp = b.periodHours ?? -1;
      return ap !== bp ? bp - ap : order.indexOf(a.key) - order.indexOf(b.key);
    });
}

/**
 * Providers that get a pool card from recorded history: any with an enabled
 * account reporting a renewing window. Claude and Codex lead, the rest follow
 * in first-seen order.
 */
export function poolProvidersFromHistory(history: QuotaHistory): PoolProvider[] {
  const providerOf = new Map(
    history.accounts
      .filter((account) => !account.disabled && account.provider)
      .map((account) => [account.authIndex, account.provider])
  );
  const found: string[] = [];
  history.samples.forEach((sample) => {
    const provider = providerOf.get(sample.authIndex);
    if (!provider || found.includes(provider) || sample.error) return;
    if (Object.values(sample.windows).some(isRenewing)) found.push(provider);
  });
  const lead = LIVE_POOL_PROVIDERS.filter((provider) => found.includes(provider));
  return [...lead, ...found.filter((provider) => !isLivePoolProvider(provider))];
}

/**
 * Window choices for a provider's card. Claude and Codex keep their fixed
 * named choices; every other provider offers the window keys it reports,
 * longest first.
 */
export function poolWindowChoices(
  provider: PoolProvider,
  history?: QuotaHistory
): PoolWindowChoice[] {
  const legacy = LEGACY_WINDOW_CHOICES[provider];
  if (legacy) return [...legacy];
  return history ? providerWindows(history, provider).map((window) => window.key) : [];
}

/** Claude/Codex: weekly; Gemini: its own models; others: their longest window. */
export function defaultPoolWindow(
  provider: PoolProvider,
  history?: QuotaHistory
): PoolWindowChoice | null {
  if (LEGACY_DEFAULT_WINDOW[provider]) return LEGACY_DEFAULT_WINDOW[provider];
  const windows = history ? providerWindows(history, provider) : [];
  if (provider === 'antigravity' || provider === 'gemini-cli' || provider === 'gemini') {
    const gemini = windows.find((window) => /(?:^|[\s_.:-])gemini(?:$|[\s_.:-])/i.test(window.key));
    if (gemini) return gemini.key;
  }
  return windows[0]?.key ?? null;
}

/** A remembered choice when it is still offered, else the provider default. */
export function resolvePoolWindow(
  provider: PoolProvider,
  history: QuotaHistory,
  chosen: PoolWindowChoice | undefined
): PoolWindowChoice | null {
  const choices = poolWindowChoices(provider, history);
  if (chosen && choices.includes(chosen)) return chosen;
  return defaultPoolWindow(provider, history);
}

/* ---------------------------------------------------------------------------
 * Weights
 * ------------------------------------------------------------------------- */

/** Plan → weight (1 = one base-plan account). */
export type PlanWeights = Record<string, number>;

const validWeight = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

/** Weight of a plan from a plan map; missing plans weigh 1. */
export const weightForPlan = (weights: PlanWeights | undefined, plan: string | null): number => {
  const value = weights?.[plan ?? ''];
  return validWeight(value) ? value : 1;
};

/**
 * An account's weight: its plan in the effective plan map (what the panel
 * edits), else the weight the hub reported for the account, else 1.
 */
export function weightForAccount(
  account: Pick<QuotaHistoryAccount, 'plan' | 'weight'>,
  weights: PlanWeights | undefined
): number {
  // The hub may send a plan's display name ("SuperGrok"); weight tables are keyed by plan key.
  const byPlan = account.plan ? weights?.[planKey(account.plan)] : undefined;
  if (validWeight(byPlan)) return byPlan;
  if (validWeight(account.weight)) return account.weight;
  return 1;
}

/**
 * Whether an account can draw on a window choice at all. A Claude plan without
 * Fable (Pro, Free) is left out of the Fable pool entirely, rather than falling
 * back to its overall weekly window.
 */
export const accountServesChoice = (
  provider: PoolProvider,
  choice: PoolWindowChoice,
  plan: string | null
): boolean => !(provider === 'claude' && choice === 'fable' && !claudePlanIncludesFable(plan));

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
  /** Plan weight (1 = one base-plan account), as the hub routes with it. */
  weight: number;
  /**
   * Share of a full pool unit this account is worth: `weight / heaviest weight`
   * among the pooled tracks, so the heaviest plan is 1 and a 5× lighter plan 0.2.
   */
  share: number;
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
  choice: PoolWindowChoice,
  provider: PoolProvider
): string | null {
  for (const key of windowKeysForChoice(choice, provider)) {
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

/**
 * Enabled accounts of a provider that have at least one sample for the chosen window.
 * Shares are measured against the heaviest enabled account of the provider, read or not, so
 * an account's capacity does not change when a heavier sibling has no reading yet.
 */
export function buildAccountTracks(
  history: QuotaHistory,
  provider: PoolProvider,
  choice: PoolWindowChoice,
  weights?: PlanWeights
): AccountTrack[] {
  const byAccount = samplesByAccount(history);
  const tracks: AccountTrack[] = [];
  const enabled = history.accounts.filter(
    (account) =>
      account.provider === provider &&
      !account.disabled &&
      accountServesChoice(provider, choice, account.plan)
  );
  enabled.forEach((account) => {
    const samples = byAccount.get(account.authIndex) ?? [];
    const windowKey = selectWindowKey(samples, choice, provider);
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
      weight: weightForAccount(account, weights),
      share: 1,
      windowKey,
      points,
    });
  });
  const heaviest = Math.max(0, ...enabled.map((account) => weightForAccount(account, weights)));
  tracks.forEach((track) => {
    track.share = heaviest > 0 ? track.weight / heaviest : 1;
  });
  return tracks;
}

/** Capacity of one account in pool percent: 100 × its share of the heaviest plan. */
export const accountCapacity = (track: Pick<AccountTrack, 'share'>): number => 100 * track.share;

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

/** Pooled remaining at `t`, in pool percent. */
export const pooledAt = (tracks: readonly AccountTrack[], t: number): number =>
  tracks.reduce((sum, track) => sum + remainingAt(track, t) * track.share, 0);

/** Pool maximum in pool percent (120% for Max 5x + Pro). */
export const poolMax = (tracks: readonly AccountTrack[]): number =>
  tracks.reduce((sum, track) => sum + accountCapacity(track), 0);

/** First reset strictly after `t`, rolling a past reset forward by whole periods. */
export function nextResetAfter(
  resetsAt: number | null,
  periodHours: number | null,
  t: number
): number | null {
  if (resetsAt === null) return null;
  if (resetsAt > t) return resetsAt;
  if (!periodHours || periodHours <= 0) return null;
  if (isCalendarMonth(periodHours)) {
    // A monthly window turns over on the calendar month, not every 720 hours.
    let next = resetsAt;
    while (next <= t) next = addUtcMonth(next);
    return next;
  }
  const periodMs = periodHours * HOUR_MS;
  const periods = Math.floor((t - resetsAt) / periodMs) + 1;
  return resetsAt + periods * periodMs;
}

/** A period the length of a calendar month (28 to 31 days). */
const isCalendarMonth = (periodHours: number): boolean =>
  periodHours >= 28 * 24 && periodHours <= 31 * 24;

/** The same instant one UTC calendar month later, clamped to the last day of a shorter month. */
function addUtcMonth(t: number): number {
  const date = new Date(t);
  const day = date.getUTCDate();
  const next = new Date(t);
  next.setUTCDate(1);
  next.setUTCMonth(next.getUTCMonth() + 1);
  const lastDay = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
  next.setUTCDate(Math.min(day, lastDay));
  return next.getTime();
}

/* ---------------------------------------------------------------------------
 * Burn rate
 * ------------------------------------------------------------------------- */

/** Whole-percent readings leave one point of uncertainty at either end. */
export interface BurnEstimate {
  rate: number;
  sustainedRate: number;
  windowHours: number;
  coverageHours: number;
  ticks: number;
  ready: boolean;
  confidence: 'collecting' | 'limited' | 'established';
}

interface BurnObservation {
  consumed: number;
  coverageHours: number;
  tickRate: number;
}

/** Ignore future observations and split tick timing at refills. */
function observeBurn(track: AccountTrack, now: number, hours: number): BurnObservation {
  const start = now - hours * HOUR_MS;
  const last = lastIndexAtOrBefore(track.points, now);
  const first = Math.max(0, lastIndexAtOrBefore(track.points, start));
  if (last <= first) return { consumed: 0, coverageHours: 0, tickRate: 0 };
  const from = Math.max(start, track.points[first].t);
  const until = track.points[last].t;
  const coverageHours = (until - from) / HOUR_MS;
  let consumed = 0;
  let timedConsumption = 0;
  let timedHours = 0;
  let firstTick: { t: number; observedAt: number; consumed: number } | null = null;
  let lastTick: { t: number; observedAt: number; consumed: number } | null = null;
  const finishTicks = (end: number) => {
    if (firstTick && lastTick && lastTick.t > firstTick.t) {
      const amount = lastTick.consumed - firstTick.consumed;
      // A long unchanged tail is evidence that the burst has ended.
      const interval = (lastTick.t - firstTick.t) / Math.max(1, amount);
      timedConsumption += amount;
      timedHours +=
        (lastTick.t - firstTick.t + Math.max(0, end - lastTick.observedAt - interval)) / HOUR_MS;
    }
    firstTick = null;
    lastTick = null;
  };
  let previous = track.points[first];
  for (let i = first + 1; i <= last; i += 1) {
    const point = track.points[i];
    const reset = previous.resetsAt;
    const refilled = reset !== null && reset > previous.t && reset <= point.t;
    if (refilled || point.remaining > previous.remaining) {
      finishTicks(refilled ? reset : point.t);
    }
    const baseline = refilled ? 100 : previous.remaining;
    const drop = Math.max(0, baseline - point.remaining);
    if (point.t > start && drop > 0) {
      consumed += drop;
      // Midpoint of the polling bracket, bounded by the selected lookback.
      const t = (Math.max(from, refilled ? reset : previous.t) + point.t) / 2;
      lastTick = { t, observedAt: point.t, consumed };
      firstTick ??= lastTick;
    }
    previous = point;
  }
  finishTicks(until);
  return {
    consumed,
    coverageHours,
    tickRate:
      timedHours > 0 ? timedConsumption / Math.max(0.5, timedHours) : consumed / coverageHours,
  };
}

/**
 * Widen sparse windows up to 24h. Tick-to-tick timing removes the arbitrary
 * phase of whole-percent counters. Keep a provisional number for rate charts,
 * but only a ready estimate may drive depletion dates or the headline stat.
 */
export function estimateBurnRate(
  tracks: readonly AccountTrack[],
  now: number,
  windowHours: number
): BurnEstimate {
  let usedHours = Math.min(24, Math.max(0.5, windowHours));
  let observations = tracks.map((track) => observeBurn(track, now, usedHours));
  const ticks = () => observations.reduce((sum, observation) => sum + observation.consumed, 0);
  while (ticks() < 3 && usedHours < 24) {
    usedHours = Math.min(24, usedHours * 2);
    observations = tracks.map((track) => observeBurn(track, now, usedHours));
  }
  const coverageHours = Math.max(0, ...observations.map((o) => o.coverageHours));
  // When the whole record is shorter, label its actual duration.
  const actualHours = Math.min(usedHours, coverageHours);
  const ready = ticks() >= 3 && coverageHours >= Math.max(0.5, usedHours / 3);
  let rate = 0;
  let sustainedRate = 0;
  observations.forEach((observation, index) => {
    if (observation.coverageHours >= 0.5) rate += observation.tickRate * tracks[index].share;
    const sustained = observeBurn(tracks[index], now, 7 * 24);
    if (sustained.coverageHours >= 0.5) {
      sustainedRate += (sustained.consumed / sustained.coverageHours) * tracks[index].share;
    }
  });
  return {
    rate,
    sustainedRate,
    windowHours: actualHours,
    coverageHours,
    ticks: ticks(),
    ready,
    confidence: !ready
      ? 'collecting'
      : coverageHours < 24 || ticks() < 10
        ? 'limited'
        : 'established',
  };
}

/** Numeric compatibility for recorded rate series, including provisional estimates. */
export function computeBurnRate(
  tracks: readonly AccountTrack[],
  now: number,
  windowHours: number
): number {
  return estimateBurnRate(tracks, now, windowHours).rate;
}

/* ---------------------------------------------------------------------------
 * Soonest-reset-first drain simulation
 * ------------------------------------------------------------------------- */

export interface SimAccount {
  authIndex: string;
  label: string;
  /** Share of a full pool unit (see AccountTrack.share); 1 when unweighted. */
  share: number;
  /** 0–100. */
  remaining: number;
  nextReset: number | null;
  periodMs: number | null;
  /** Weekly points per short-window point, learned from paired observations. */
  shortWindow?: { ratio: number; remaining: number; nextReset: number; periodMs: number };
}

export interface SeriesPoint {
  t: number;
  value: number;
}

export interface PoolJump {
  t: number;
  /** Pool percent added. */
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
  /** Pooled drain in pool %/h. */
  ratePerHour: number;
  /** Long-record demand. Its influence grows with the forecast horizon. */
  sustainedRatePerHour?: number;
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
  const recentRate = Math.max(0, options.ratePerHour);
  const sustainedRate = Math.max(0, options.sustainedRatePerHour ?? recentRate);
  const stepMs = Math.max(MINUTE_MS, options.stepMs ?? DEFAULT_PROJECTION_STEP_MS);
  const accounts = input.map((account) => ({
    ...account,
    remaining: clampPercent(account.remaining),
    shortWindow: account.shortWindow ? { ...account.shortWindow } : undefined,
  }));

  const points: SeriesPoint[] = [];
  const ratePoints: SeriesPoint[] = [];
  const accountPoints = new Map<string, SeriesPoint[]>(accounts.map((a) => [a.authIndex, []]));
  const accountRatePoints = new Map<string, SeriesPoint[]>(accounts.map((a) => [a.authIndex, []]));
  const resets: PoolJump[] = [];
  let poolEmptyAt: number | null = null;
  let firstEmpty: FirstEmpty | null = null;

  const pooled = () => accounts.reduce((sum, a) => sum + a.remaining * a.share, 0);
  const emit = (t: number) => {
    points.push({ t, value: pooled() });
    accounts.forEach((a) =>
      accountPoints.get(a.authIndex)!.push({ t, value: a.remaining * a.share })
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
      for (const reset of [a.nextReset, a.shortWindow?.nextReset]) {
        if (reset != null && reset > t && reset < segmentEnd) segmentEnd = reset;
      }
    });
    const hours = (segmentEnd - t) / HOUR_MS;
    // Integrate the blend, so changing chart resolution cannot change demand.
    const recentWeight =
      (24 / hours) *
      (Math.exp(-(t - start) / (24 * HOUR_MS)) - Math.exp(-(segmentEnd - start) / (24 * HOUR_MS)));
    const rate = sustainedRate + (recentRate - sustainedRate) * recentWeight;

    // Drain this segment in soonest-reset-first order, tracking exact crossings.
    let demand = rate * hours;
    let elapsedDemand = 0;
    const consumedBy = new Map<string, number>();
    const poolBefore = pooled();
    for (const account of [...accounts].sort(soonestResetOrder)) {
      if (demand <= EPSILON) break;
      const short = account.shortWindow;
      const shortAvailable = short ? short.remaining * short.ratio * account.share : Infinity;
      const available = Math.min(account.remaining * account.share, shortAvailable);
      if (available <= EPSILON || account.share <= 0) continue;
      const take = Math.min(available, demand);
      account.remaining = Math.max(0, account.remaining - take / account.share);
      if (short)
        short.remaining = Math.max(0, short.remaining - take / account.share / short.ratio);
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
      const short = a.shortWindow;
      if (short && short.nextReset <= t) {
        short.remaining = 100;
        short.nextReset = nextResetAfter(short.nextReset, short.periodMs / HOUR_MS, t)!;
      }
      if (a.nextReset === null || a.nextReset > t) return;
      refill += (100 - a.remaining) * a.share;
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
      share: track.share,
      remaining: remainingAt(track, now),
      nextReset: nextResetAfter(latest.resetsAt, latest.periodHours, now),
      periodMs: latest.periodHours ? latest.periodHours * HOUR_MS : null,
    };
  });
}

/** Learn a conversion from paired observations within each reset epoch. */
function learnShortWindow(
  history: QuotaHistory,
  track: AccountTrack,
  now: number
): SimAccount['shortWindow'] {
  const latest = track.points[lastIndexAtOrBefore(track.points, now)];
  if (!latest || (windowPeriodHours(track.windowKey, latest.periodHours) ?? 0) < 168) return;
  const samples = history.samples
    .filter((sample) => sample.authIndex === track.authIndex && !sample.error && sample.t <= now)
    .sort((a, b) => a.t - b.t);
  const last = samples[samples.length - 1];
  if (!last) return;
  // Match the selected scope, so unrelated model allowances never cap it.
  const scope = parseWindowKey(track.windowKey).scope;
  const key = Object.keys(last.windows).find(
    (key) =>
      windowPeriodHours(key, last.windows[key].periodHours) === 5 &&
      (parseWindowKey(key).scope === scope || parseWindowKey(key).scope === null)
  );
  if (!key) return;
  let weekly = 0;
  let short = 0;
  let pairs = 0;
  for (let i = 1; i < samples.length; i += 1) {
    const previous = samples[i - 1];
    const current = samples[i];
    if (previous.t < now - 7 * DAY_MS) continue;
    const pw = previous.windows[track.windowKey];
    const cw = current.windows[track.windowKey];
    const ps = previous.windows[key];
    const cs = current.windows[key];
    if (
      pw?.usedPercent == null ||
      cw?.usedPercent == null ||
      ps?.usedPercent == null ||
      cs?.usedPercent == null
    )
      continue;
    if (
      [pw, ps].some(
        (window) =>
          window.resetsAt !== null && window.resetsAt > previous.t && window.resetsAt <= current.t
      )
    )
      continue;
    const dw = cw.usedPercent - pw.usedPercent;
    const ds = cs.usedPercent - ps.usedPercent;
    if (dw < 0 || ds < 0) continue;
    // Include plateaus on either counter to avoid selecting only aligned ticks.
    weekly += dw;
    short += ds;
    if (dw > 0 && ds > 0) pairs += 1;
  }
  const window = last.windows[key];
  const nextReset = nextResetAfter(window.resetsAt, 5, now);
  if (pairs < 3 || weekly < 3 || short < 10 || window.usedPercent === null || nextReset === null) {
    return;
  }
  return {
    ratio: weekly / short,
    remaining: window.resetsAt !== null && window.resetsAt <= now ? 100 : 100 - window.usedPercent,
    nextReset,
    periodMs: 5 * HOUR_MS,
  };
}

/* ---------------------------------------------------------------------------
 * Recorded series
 * ------------------------------------------------------------------------- */

/** Smallest step that is annotated as a reset jump, in percent of one account's own window. */
export const JUMP_MIN_POINTS = 5;

/** The jump threshold in pool percent: scaled to the lightest account, whose resets are smallest. */
export const jumpThreshold = (tracks: readonly Pick<AccountTrack, 'share'>[]): number =>
  JUMP_MIN_POINTS * Math.min(1, ...tracks.map((track) => track.share));

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
  burnEstimate: BurnEstimate;
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
    burnEstimate: estimateBurnRate([], now, burnWindowHours),
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
  const burnEstimate = estimateBurnRate(tracks, now, burnWindowHours);
  const burnRate = burnEstimate.rate;

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
  const jumpMin = jumpThreshold(tracks);
  const jumps = detectJumps(recorded, jumpMin);

  // Projection: simulate from now; display only the in-span part.
  const factor = FUTURE_USAGE_FACTOR[options.futureUsage];
  const simEnd = Math.max(spanEnd, now + (options.minProjectionMs ?? 8 * DAY_MS));
  const simAccounts = simAccountsAt(tracks, now);
  simAccounts.forEach((account, index) => {
    account.shortWindow = learnShortWindow(history, tracks[index], now);
  });
  const sim = simulateDrain(simAccounts, {
    start: now,
    end: simEnd,
    ratePerHour: burnEstimate.ready ? burnRate * factor : 0,
    sustainedRatePerHour: burnEstimate.ready ? burnEstimate.sustainedRate * factor : 0,
    stepMs: options.projectionStepMs,
  });
  const projectFrom = Math.max(now, spanStart);
  const visibleProjection = spanEnd > now && (burnEstimate.ready || options.futureUsage === 'none');
  const projected = visibleProjection ? clip(sim.points, projectFrom, spanEnd) : [];
  const projectedRate = visibleProjection ? clip(sim.ratePoints, projectFrom, spanEnd) : [];
  sim.resets
    .filter((jump) => jump.amount >= jumpMin && jump.t >= spanStart && jump.t <= spanEnd)
    .forEach((jump) => jumps.push(jump));

  const accounts: PoolAccountSeries[] = tracks.map((track) => ({
    authIndex: track.authIndex,
    label: track.label,
    recorded: grid.map((t) => ({ t, value: remainingAt(track, t) * track.share })),
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
  // A reset beyond the simulated range, such as a monthly budget, is still the next reset.
  const laterReset = simAccountsAt(tracks, now)
    .filter((account) => account.nextReset !== null)
    .sort((x, y) => (x.nextReset as number) - (y.nextReset as number))[0];
  return {
    provider,
    tracks,
    max,
    current,
    burnRate,
    burnEstimate,
    recorded,
    recordedRate,
    projected,
    projectedRate,
    jumps,
    accounts,
    poolEmptyAt: sim.poolEmptyAt !== null && sim.poolEmptyAt <= spanEnd ? sim.poolEmptyAt : null,
    firstEmpty: sim.firstEmpty && sim.firstEmpty.at <= spanEnd ? sim.firstEmpty : null,
    nextReset: firstReset
      ? { at: firstReset.t, amount: firstReset.amount }
      : laterReset
        ? {
            at: laterReset.nextReset as number,
            amount: (100 - laterReset.remaining) * laterReset.share,
          }
        : null,
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

export interface LiveAccountInput {
  authIndex: string;
  provider: PoolProvider;
  label: string;
  plan: string | null;
  disabled: boolean;
  /** Windows of the latest live read, already keyed like history (see liveWindows.ts). */
  windows: readonly LiveWindow[] | null;
}

/**
 * Without recorded history the page still has each credential's latest live
 * quota read. Express those as a one-sample-per-account history so the same
 * pool model renders a current point (and its projection), for any provider.
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
      windows[window.key] = {
        usedPercent: window.usedPercent,
        resetsAt: window.resetAtMs ?? null,
        periodHours: window.periodHours ?? null,
        ...(window.label ? { label: window.label } : {}),
      };
    });
    if (Object.keys(windows).length > 0) {
      samples.push({ t: now, authIndex: input.authIndex, windows, error: '' });
    }
  });
  return { enabled: false, intervalSeconds: 600, now, accounts, samples };
}

/**
 * Recorded history, with live reads filling in every provider the recorder
 * has no renewing window for (recorder off for it, or not sampled yet). A
 * provider is fed by one source only, so a card never mixes the two.
 */
export function mergeLiveHistory(recorded: QuotaHistory, live: QuotaHistory): QuotaHistory {
  const covered = new Set(poolProvidersFromHistory(recorded));
  const liveAccounts = live.accounts.filter((account) => !covered.has(account.provider));
  if (liveAccounts.length === 0) return recorded;
  const liveIndexes = new Set(liveAccounts.map((account) => account.authIndex));
  return {
    ...recorded,
    accounts: [
      ...recorded.accounts.filter((account) => !liveIndexes.has(account.authIndex)),
      ...liveAccounts,
    ],
    samples: [
      ...recorded.samples,
      ...live.samples.filter((sample) => liveIndexes.has(sample.authIndex)),
    ].sort((a, b) => a.t - b.t),
  };
}

/** Window key → the provider's own name, for the windows that report one. */
export function providerWindowLabels(windows: readonly ProviderWindow[]): Record<string, string> {
  const out: Record<string, string> = {};
  windows.forEach((window) => {
    if (window.label) out[window.key] = window.label;
  });
  return out;
}
