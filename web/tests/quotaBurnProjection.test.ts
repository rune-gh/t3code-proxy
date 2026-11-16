import { describe, expect, test } from 'bun:test';
import { normalizeQuotaHistory, type QuotaHistory } from '../src/services/api/quotaHistory';
import {
  buildAccountTracks,
  buildPoolView,
  estimateBurnRate,
  HOUR_MS as H,
  simulateDrain,
  type AccountTrack,
  type SimAccount,
} from '../src/features/quota/poolModel';
import ownerHistory from './fixtures/ownerHistory.json';

const NOW = Date.UTC(2026, 10, 14, 12);
const track = (values: Array<[number, number]>, share = 1): AccountTrack => ({
  authIndex: 'a',
  label: 'a',
  plan: null,
  weight: share,
  share,
  windowKey: 'seven_day',
  points: values.map(([hour, used]) => ({
    t: NOW + hour * H,
    remaining: 100 - used,
    resetsAt: NOW + 168 * H,
    periodHours: 168,
  })),
});
const viewOptions = {
  provider: 'claude',
  window: 'weekly',
  now: NOW,
  spanStart: NOW - 24 * H,
  spanEnd: NOW + 48 * H,
  burnWindowHours: 3,
  futureUsage: 'same' as const,
};
const pairedHistory = (pinned = false): QuotaHistory =>
  normalizeQuotaHistory({
    enabled: true,
    interval_seconds: 600,
    now: NOW,
    accounts: [{ auth_index: 'a', provider: 'claude', weight: 1 }],
    samples: Array.from({ length: 7 }, (_, i) => ({
      t: NOW + ((i - 6) * H) / 6,
      auth_index: 'a',
      windows: {
        seven_day: { used_percent: 50 + i, resets_at: NOW + 100 * H, period_hours: 168 },
        five_hour: {
          used_percent: (pinned ? 40 : 20) + i * 10,
          resets_at: NOW + H,
          period_hours: 5,
        },
      },
    })),
  });
const simAccount = (): SimAccount => ({
  authIndex: 'a',
  label: 'a',
  share: 1,
  remaining: 100,
  nextReset: null,
  periodMs: null,
});

describe('tick-aware burn', () => {
  test('a steady 0.3%/h whole-percent counter widens and stays stable across tick phases', () => {
    const t = track(Array.from({ length: 145 }, (_, i) => [i / 6, Math.floor((i * 0.3) / 6)]));
    const rates: number[] = [];
    for (let hour = 20; hour <= 24; hour += 1 / 6) {
      const estimate = estimateBurnRate([t], NOW + hour * H, 1);
      expect(estimate.ready).toBe(true);
      expect(estimate.windowHours).toBeGreaterThan(1);
      rates.push(estimate.rate);
    }
    expect(Math.min(...rates)).toBeGreaterThan(0.27);
    expect(Math.max(...rates)).toBeLessThan(0.33);
  });

  test('a tickless or one-tick record is collecting, including after widening', () => {
    const t = track([
      [0, 19],
      [1, 19],
      [2, 20],
      [3, 20],
    ]);
    const estimate = estimateBurnRate([t], NOW + 3 * H, 1);
    expect(estimate.windowHours).toBe(3);
    expect(estimate.ready).toBe(false);
    expect(estimate.confidence).toBe('collecting');
    expect(
      estimateBurnRate(
        [
          track([
            [0, 10],
            [0.25, 14],
          ]),
        ],
        NOW + H / 4,
        1
      ).ready
    ).toBe(false);
    expect(
      estimateBurnRate(
        [
          track([
            [0, 10],
            [1, 14],
          ]),
        ],
        NOW + H,
        6
      ).ready
    ).toBe(false);
  });

  test('an eight-hour idle stretch remains in sustained demand after a burst', () => {
    const t = track(Array.from({ length: 61 }, (_, i) => [i / 6, i <= 48 ? 20 : 20 + (i - 48)]));
    const estimate = estimateBurnRate([t], NOW + 10 * H, 3);
    expect(estimate.ready).toBe(true);
    expect(estimate.rate).toBeCloseTo(6);
    expect(estimate.sustainedRate).toBeCloseTo(1.2);
    expect(estimate.confidence).toBe('limited');
  });

  test('a long unchanged tail lowers the tick rate after the burst ends', () => {
    const t = track([
      [0, 10],
      [0.5, 11],
      [1, 12],
      [1.5, 13],
      [6, 13],
    ]);
    const active = estimateBurnRate([t], NOW + 1.5 * H, 6);
    const idle = estimateBurnRate([t], NOW + 6 * H, 6);
    expect(idle.rate).toBeLessThan(active.rate / 2);
    expect(idle.sustainedRate).toBeCloseTo(0.5);
  });

  test('resets count post-refill usage without turning the refill into negative burn', () => {
    const t = track([
      [0, 94],
      [0.5, 97],
      [2, 3],
      [3, 6],
    ]);
    t.points[0].resetsAt = NOW + H;
    t.points[1].resetsAt = NOW + H;
    const estimate = estimateBurnRate([t], NOW + 3 * H, 3);
    expect(estimate.rate).toBeCloseTo(3);
    expect(estimate.sustainedRate).toBeCloseTo(3);
    expect(estimate.ticks).toBe(9);
  });

  test('future observations cannot alter estimates made before them', () => {
    const t = track([
      [0, 10],
      [1, 13],
      [2, 16],
      [3, 19],
      [4, 90],
    ]);
    const prefix = { ...t, points: t.points.slice(0, 4) };
    expect(estimateBurnRate([t], NOW + 3 * H, 3)).toEqual(
      estimateBurnRate([prefix], NOW + 3 * H, 3)
    );
  });

  test('pool rates retain share scaling and confidence grows with coverage', () => {
    const t = track(Array.from({ length: 169 }, (_, i) => [i / 6, Math.floor(i / 6)]));
    const scaled = { ...t, share: 0.2 };
    const full = estimateBurnRate([t], NOW + 28 * H, 24);
    const small = estimateBurnRate([scaled], NOW + 28 * H, 24);
    expect(small.rate).toBeCloseTo(full.rate * 0.2);
    expect(small.sustainedRate).toBeCloseTo(full.sustainedRate * 0.2);
    expect(full.confidence).toBe('established');
  });

  test('the sustained record is capped at seven days', () => {
    const t = track(Array.from({ length: 193 }, (_, hour) => [hour, hour < 24 ? 30 : 40]));
    t.points.forEach((point) => {
      point.resetsAt = null;
    });
    expect(estimateBurnRate([t], NOW + 192 * H, 3).sustainedRate).toBe(0);
  });
});

describe('sustained projection and short-window ceilings', () => {
  test('distant demand approaches the long-record rate, independently of chart resolution', () => {
    const options = { start: NOW, end: NOW + 72 * H, ratePerHour: 0.6, sustainedRatePerHour: 0.1 };
    const fine = simulateDrain([simAccount()], { ...options, stepMs: H / 4 });
    const coarse = simulateDrain([simAccount()], { ...options, stepMs: H });
    const consumed = 100 - fine.points.at(-1)!.value;
    expect(consumed).toBeCloseTo(0.1 * 72 + 0.5 * 24 * (1 - Math.exp(-3)));
    expect(coarse.points.at(-1)!.value).toBeCloseTo(fine.points.at(-1)!.value, 8);
    expect(fine.ratePoints.at(-1)!.value).toBeLessThan(0.13);
  });

  test('a pinned five-hour allowance waits, then permits only its learned weekly equivalent', () => {
    const history = pairedHistory(true);
    const view = buildPoolView(history, { ...viewOptions, spanEnd: NOW + 6 * H });
    expect(view.burnEstimate.ready).toBe(true);
    const at = (hours: number) =>
      view.projected.filter((p) => p.t <= NOW + hours * H).at(-1)!.value;
    expect(at(0.75)).toBeCloseTo(44);
    expect(at(1)).toBeCloseTo(44);
    expect(at(6)).toBeCloseTo(34);
    expect(view.poolEmptyAt).toBeNull();
  });

  test('no history support for a ratio leaves the weekly demand uncapped', () => {
    const history = pairedHistory(true);
    history.samples.forEach((sample) => {
      sample.windows.five_hour.usedPercent = 100;
    });
    const view = buildPoolView(history, { ...viewOptions, spanEnd: NOW + H });
    expect(view.projected.at(-1)!.value).toBeCloseTo(38);
  });

  test('short ceilings scale by share and spill demand to another account', () => {
    const a: SimAccount = {
      ...simAccount(),
      share: 0.2,
      nextReset: NOW + 20 * H,
      shortWindow: { ratio: 0.1, remaining: 10, nextReset: NOW + H, periodMs: 5 * H },
    };
    const b = { ...simAccount(), authIndex: 'b', nextReset: NOW + 30 * H };
    const result = simulateDrain([a, b], { start: NOW, end: NOW + H / 2, ratePerHour: 4 });
    expect(result.accountPoints.get('a')!.at(-1)!.value).toBeCloseTo(19.8);
    expect(result.accountPoints.get('b')!.at(-1)!.value).toBeCloseTo(98.2);
    expect(result.firstEmpty).toBeNull();
  });

  test('future usage factors scale demand while five-hour budgets stay physical', () => {
    const history = pairedHistory();
    history.samples.forEach((sample) => {
      sample.windows.five_hour.usedPercent! -= 20;
    });
    const same = buildPoolView(history, { ...viewOptions, spanEnd: NOW + H / 4 });
    const double = buildPoolView(history, {
      ...viewOptions,
      spanEnd: NOW + H / 4,
      futureUsage: 'double',
    });
    expect(44 - double.projected.at(-1)!.value).toBeCloseTo(
      (44 - same.projected.at(-1)!.value) * 2
    );
    const capped = buildPoolView(history, {
      ...viewOptions,
      spanEnd: NOW + H / 2,
      futureUsage: 'double',
    });
    expect(capped.projected.at(-1)!.value).toBeCloseTo(40);
    const none = buildPoolView(history, { ...viewOptions, futureUsage: 'none' });
    expect(none.projectedRate.every((p) => p.value === 0)).toBe(true);
  });

  test('collecting data hides the demand projection, while explicit no-usage remains usable', () => {
    const history = pairedHistory();
    history.samples = history.samples.slice(-1);
    const view = buildPoolView(history, viewOptions);
    expect(view.burnEstimate.ready).toBe(false);
    expect(view.projected).toEqual([]);
    expect(view.poolEmptyAt).toBeNull();
    expect(
      buildPoolView(history, { ...viewOptions, futureUsage: 'none' }).projected.length
    ).toBeGreaterThan(0);
  });

  test('owner Claude weekly depletion respects the remaining five-hour allowance', () => {
    const history = normalizeQuotaHistory(ownerHistory);
    const now = history.now;
    const view = buildPoolView(history, {
      ...viewOptions,
      now,
      spanStart: now,
      spanEnd: now + H,
      futureUsage: 'double',
    });
    const max = view.accounts.find((a) => a.authIndex === 'acct-claude-3')!;
    // Observed 9 weekly points / 70 five-hour points, with 15 five-hour points left.
    expect(max.projected.at(-1)!.value).toBeGreaterThanOrEqual(32 - (15 * 9) / 70 - 1e-8);
    expect(buildAccountTracks(history, 'claude', 'weekly')[1].share).toBe(1);
  });
});
