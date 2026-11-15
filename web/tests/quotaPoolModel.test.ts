import { describe, expect, test } from 'bun:test';
import type { QuotaHistory, QuotaHistorySample } from '../src/services/api/quotaHistory';
import { normalizeQuotaHistory } from '../src/services/api/quotaHistory';
import {
  HOUR_MS,
  buildAccountTracks,
  buildPoolView,
  computeBurnRate,
  defaultPoolSpan,
  detectJumps,
  historyFromLiveSnapshots,
  nextResetAfter,
  pooledAt,
  poolMax,
  remainingAt,
  shiftPoolSpan,
  simulateDrain,
  type SimAccount,
} from '../src/features/quota/poolModel';

const NOW = Date.UTC(2026, 10, 14, 12, 0, 0);
const H = HOUR_MS;

type Win = { used: number; resetsAt?: number | null; period?: number };

const sample = (
  t: number,
  authIndex: string,
  windows: Record<string, Win>
): QuotaHistorySample => ({
  t,
  authIndex,
  error: '',
  windows: Object.fromEntries(
    Object.entries(windows).map(([key, w]) => [
      key,
      { usedPercent: w.used, resetsAt: w.resetsAt ?? null, periodHours: w.period ?? 168 },
    ])
  ),
});

const history = (
  accounts: Array<{ id: string; provider?: string; plan?: string; disabled?: boolean }>,
  samples: QuotaHistorySample[]
): QuotaHistory => ({
  enabled: true,
  intervalSeconds: 600,
  now: NOW,
  accounts: accounts.map((a) => ({
    authIndex: a.id,
    provider: a.provider ?? 'claude',
    label: `${a.id}@example.com`,
    plan: a.plan ?? null,
    disabled: a.disabled ?? false,
  })),
  samples,
});

const sim = (id: string, remaining: number, nextReset: number | null, weight = 1): SimAccount => ({
  authIndex: id,
  label: id,
  weight,
  remaining,
  nextReset,
  periodMs: 168 * H,
});

describe('pooling and weights', () => {
  test('sums remaining × plan weight and scales the pool maximum', () => {
    const h = history(
      [
        { id: 'a', provider: 'codex', plan: 'plus' },
        { id: 'b', provider: 'codex', plan: 'pro' },
        { id: 'c', provider: 'codex', plan: 'plus', disabled: true },
      ],
      [
        sample(NOW - H, 'a', { seven_day: { used: 40 } }),
        sample(NOW - H, 'b', { seven_day: { used: 10 } }),
        sample(NOW - H, 'c', { seven_day: { used: 0 } }),
      ]
    );
    const tracks = buildAccountTracks(h, 'codex', 'weekly', { pro: 2.5 });
    expect(tracks.map((t) => t.authIndex)).toEqual(['a', 'b']);
    expect(poolMax(tracks)).toBe(350);
    expect(pooledAt(tracks, NOW)).toBeCloseTo(60 + 90 * 2.5);
  });

  test('defaults every plan to weight 1 and ignores other providers', () => {
    const h = history(
      [
        { id: 'a', plan: 'max_20x' },
        { id: 'x', provider: 'codex' },
      ],
      [sample(NOW, 'a', { seven_day: { used: 25 } }), sample(NOW, 'x', { seven_day: { used: 0 } })]
    );
    const tracks = buildAccountTracks(h, 'claude', 'weekly');
    expect(tracks).toHaveLength(1);
    expect(tracks[0].weight).toBe(1);
    expect(pooledAt(tracks, NOW)).toBe(75);
  });

  test('carries the last sample forward and refills once its reset has passed', () => {
    const h = history(
      [{ id: 'a' }],
      [sample(NOW - 2 * H, 'a', { seven_day: { used: 80, resetsAt: NOW - H } })]
    );
    const [track] = buildAccountTracks(h, 'claude', 'weekly');
    expect(remainingAt(track, NOW - 1.5 * H)).toBe(20);
    expect(remainingAt(track, NOW)).toBe(100);
    // Before the first sample the first value is held (no fake jump).
    expect(remainingAt(track, NOW - 10 * H)).toBe(20);
  });

  test('skips failed samples', () => {
    const h = history(
      [{ id: 'a' }],
      [
        sample(NOW - 2 * H, 'a', { seven_day: { used: 30 } }),
        { t: NOW - H, authIndex: 'a', windows: {}, error: 'HTTP 500' },
      ]
    );
    const [track] = buildAccountTracks(h, 'claude', 'weekly');
    expect(track.points).toHaveLength(1);
    expect(remainingAt(track, NOW)).toBe(70);
  });
});

describe('Fable window preference', () => {
  const h = history(
    [{ id: 'fable' }, { id: 'plain' }],
    [
      sample(NOW, 'fable', { seven_day: { used: 10 }, seven_day_fable: { used: 60 } }),
      sample(NOW, 'plain', { seven_day: { used: 30 } }),
    ]
  );

  test('uses seven_day_fable when an account has it, else seven_day', () => {
    const tracks = buildAccountTracks(h, 'claude', 'fable');
    expect(tracks.map((t) => [t.authIndex, t.windowKey])).toEqual([
      ['fable', 'seven_day_fable'],
      ['plain', 'seven_day'],
    ]);
    expect(pooledAt(tracks, NOW)).toBe(40 + 70);
  });

  test('the Weekly choice pins seven_day for every account', () => {
    const tracks = buildAccountTracks(h, 'claude', 'weekly');
    expect(tracks.every((t) => t.windowKey === 'seven_day')).toBe(true);
    expect(pooledAt(tracks, NOW)).toBe(90 + 70);
  });

  test('the 5-hour choice drops accounts without a five_hour window', () => {
    expect(buildAccountTracks(h, 'claude', 'five_hour')).toHaveLength(0);
  });
});

describe('burn rate', () => {
  test('measures pooled drop per hour over the window', () => {
    const h = history(
      [{ id: 'a' }, { id: 'b' }],
      [
        sample(NOW - 3 * H, 'a', { seven_day: { used: 10 } }),
        sample(NOW, 'a', { seven_day: { used: 16 } }),
        sample(NOW - 3 * H, 'b', { seven_day: { used: 50 } }),
        sample(NOW, 'b', { seven_day: { used: 53 } }),
      ]
    );
    expect(computeBurnRate(buildAccountTracks(h, 'claude', 'weekly'), NOW, 3)).toBeCloseTo(3);
  });

  test('ignores upward reset jumps', () => {
    const h = history(
      [{ id: 'a' }],
      [
        sample(NOW - 3 * H, 'a', { seven_day: { used: 94, resetsAt: NOW - 2 * H } }),
        sample(NOW - 2.5 * H, 'a', { seven_day: { used: 97, resetsAt: NOW - 2 * H } }),
        // Reset at NOW-2h refills to 100; afterwards usage continues.
        sample(NOW - H, 'a', { seven_day: { used: 3, resetsAt: NOW + 160 * H } }),
        sample(NOW, 'a', { seven_day: { used: 6, resetsAt: NOW + 160 * H } }),
      ]
    );
    // Drops: 3 (94→97) + 3 (100→97 after refill) + 3 (97→94) = 9 over 3h.
    expect(computeBurnRate(buildAccountTracks(h, 'claude', 'weekly'), NOW, 3)).toBeCloseTo(3);
  });

  test('uses only covered time and clamps at zero', () => {
    const h = history(
      [{ id: 'a' }],
      [
        sample(NOW - H, 'a', { seven_day: { used: 10 } }),
        sample(NOW, 'a', { seven_day: { used: 12 } }),
      ]
    );
    const tracks = buildAccountTracks(h, 'claude', 'weekly');
    expect(computeBurnRate(tracks, NOW, 6)).toBeCloseTo(2);
    const single = buildAccountTracks(
      history([{ id: 'a' }], [sample(NOW, 'a', { seven_day: { used: 50 } })]),
      'claude',
      'weekly'
    );
    expect(computeBurnRate(single, NOW, 3)).toBe(0);
  });
});

describe('soonest-reset-first drain', () => {
  test('drains the account that resets soonest before any other', () => {
    const result = simulateDrain(
      [sim('late', 100, NOW + 100 * H), sim('soon', 100, NOW + 50 * H)],
      {
        start: NOW,
        end: NOW + 10 * H,
        ratePerHour: 5,
        stepMs: H,
      }
    );
    const last = (id: string) => result.accountPoints.get(id)!.at(-1)!.value;
    expect(last('soon')).toBeCloseTo(50);
    expect(last('late')).toBeCloseTo(100);
    expect(result.points.at(-1)!.value).toBeCloseTo(150);
  });

  test('spills to the next account once the first runs dry and reports first empty', () => {
    const result = simulateDrain([sim('a', 10, NOW + 100 * H), sim('b', 100, NOW + 120 * H)], {
      start: NOW,
      end: NOW + 4 * H,
      ratePerHour: 5,
      stepMs: H,
    });
    expect(result.firstEmpty?.authIndex).toBe('a');
    expect(result.firstEmpty?.at).toBe(NOW + 2 * H);
    expect(result.accountPoints.get('b')!.at(-1)!.value).toBeCloseTo(90);
  });

  test('an empty account waits for its reset, then refills to 100 × weight', () => {
    const result = simulateDrain([sim('a', 0, NOW + 2.5 * H, 2)], {
      start: NOW,
      end: NOW + 4 * H,
      ratePerHour: 0,
      stepMs: H,
    });
    expect(result.resets).toHaveLength(1);
    expect(result.resets[0].t).toBe(NOW + 2.5 * H);
    expect(result.resets[0].amount).toBeCloseTo(200);
    expect(result.points.at(-1)!.value).toBeCloseTo(200);
    // The jump is a vertical step: two points at the reset instant.
    expect(result.points.filter((p) => p.t === NOW + 2.5 * H).map((p) => p.value)).toEqual([
      0, 200,
    ]);
  });

  test('refills every period after the first reset', () => {
    const result = simulateDrain([{ ...sim('a', 50, NOW + H), periodMs: 5 * H }], {
      start: NOW,
      end: NOW + 12 * H,
      ratePerHour: 10,
      stepMs: H,
    });
    expect(result.resets.map((r) => (r.t - NOW) / H)).toEqual([1, 6, 11]);
  });

  test('detects the pool hitting zero at the exact instant', () => {
    const result = simulateDrain([sim('a', 20, NOW + 100 * H), sim('b', 10, NOW + 90 * H)], {
      start: NOW,
      end: NOW + 10 * H,
      ratePerHour: 4,
      stepMs: H,
    });
    expect(result.poolEmptyAt).toBe(NOW + 7.5 * H);
    expect(result.firstEmpty?.authIndex).toBe('b');
    expect(result.firstEmpty?.at).toBe(NOW + 2.5 * H);
    expect(result.points.some((p) => p.t === NOW + 7.5 * H && p.value === 0)).toBe(true);
  });

  test('never empties with no future usage', () => {
    const result = simulateDrain([sim('a', 30, null)], {
      start: NOW,
      end: NOW + 48 * H,
      ratePerHour: 0,
    });
    expect(result.poolEmptyAt).toBeNull();
    expect(result.firstEmpty).toBeNull();
  });
});

describe('pool view', () => {
  const span = defaultPoolSpan(NOW);
  const h = history(
    [{ id: 'a' }, { id: 'b' }],
    [
      sample(NOW - 2 * H, 'a', { seven_day: { used: 90, resetsAt: NOW - H } }),
      sample(NOW, 'a', { seven_day: { used: 0, resetsAt: NOW + 167 * H } }),
      sample(NOW - 2 * H, 'b', { seven_day: { used: 20, resetsAt: NOW + 10 * H } }),
      sample(NOW, 'b', { seven_day: { used: 26, resetsAt: NOW + 10 * H } }),
    ]
  );

  test('puts now a quarter into a 14-day span and pans by half a span', () => {
    expect((NOW - span.start) / (span.end - span.start)).toBeCloseTo(0.25);
    const next = shiftPoolSpan(span, 1);
    expect(next.start - span.start).toBe(7 * 24 * H);
  });

  test('annotates the recorded reset and projects the next reset', () => {
    const view = buildPoolView(h, {
      provider: 'claude',
      window: 'weekly',
      now: NOW,
      spanStart: span.start,
      spanEnd: span.end,
      burnWindowHours: 3,
      futureUsage: 'same',
    });
    expect(view.max).toBe(200);
    expect(view.current).toBe(100 + 74);
    // b dropped 6 points over the 2 covered hours; a's reset is not consumption.
    expect(view.burnRate).toBeCloseTo(3);
    const recordedJump = view.jumps.find((j) => !j.projected);
    expect(recordedJump?.amount).toBeCloseTo(90);
    expect(view.nextReset?.at).toBe(NOW + 10 * H);
    // b resets first so it is drained first: 74 − 3×10 = 44 left before it refills.
    expect(view.nextReset?.amount).toBeCloseTo(56);
    expect(view.projected[0]).toEqual({ t: NOW, value: 174 });
  });

  test('future usage None keeps the pool flat apart from refills', () => {
    const view = buildPoolView(h, {
      provider: 'claude',
      window: 'weekly',
      now: NOW,
      spanStart: span.start,
      spanEnd: span.end,
      burnWindowHours: 3,
      futureUsage: 'none',
    });
    expect(view.projectedRate.every((p) => p.value === 0)).toBe(true);
    expect(view.poolEmptyAt).toBeNull();
  });
});

describe('helpers', () => {
  test('nextResetAfter rolls a past reset forward by whole periods', () => {
    expect(nextResetAfter(NOW + H, 5, NOW)).toBe(NOW + H);
    expect(nextResetAfter(NOW - H, 5, NOW)).toBe(NOW + 4 * H);
    expect(nextResetAfter(NOW - H, null, NOW)).toBeNull();
  });

  test('detectJumps merges consecutive rises and drops small noise', () => {
    const jumps = detectJumps([
      { t: 0, value: 100 },
      { t: 1, value: 160 },
      { t: 2, value: 200 },
      { t: 3, value: 199 },
      { t: 4, value: 202 },
    ]);
    expect(jumps).toHaveLength(1);
    expect(jumps[0]).toMatchObject({ t: 2, amount: 100, value: 200 });
  });

  test('live snapshots become one sample per account with mapped window keys', () => {
    const h = historyFromLiveSnapshots(
      [
        {
          authIndex: '1',
          provider: 'codex',
          label: 'x',
          plan: 'pro',
          disabled: false,
          windows: [
            { id: 'weekly', usedPercent: 30, resetAtMs: NOW + H, periodHours: 168 },
            { id: 'code-review-weekly', usedPercent: 99 },
          ],
        },
        {
          authIndex: '2',
          provider: 'codex',
          label: 'y',
          plan: null,
          disabled: false,
          windows: null,
        },
      ],
      NOW
    );
    expect(h.enabled).toBe(false);
    expect(h.samples).toHaveLength(1);
    expect(Object.keys(h.samples[0].windows)).toEqual(['seven_day']);
    const tracks = buildAccountTracks(h, 'codex', 'weekly', { pro: 2 });
    expect(pooledAt(tracks, NOW)).toBe(140);
  });

  test('normalizes the backend payload', () => {
    const h = normalizeQuotaHistory({
      enabled: true,
      interval_seconds: 300,
      now: 1731600000000,
      accounts: [{ auth_index: 'abc', provider: 'Claude', label: 'u@x', plan: 'max_20x' }],
      samples: [
        {
          t: 1731600000000,
          auth_index: 'abc',
          windows: { seven_day: { used_percent: 40, resets_at: null, period_hours: 168 } },
          error: '',
        },
        { t: 1731590000000, auth_index: 'abc', windows: {}, error: 'boom' },
      ],
    });
    expect(h.intervalSeconds).toBe(300);
    expect(h.accounts[0]).toEqual({
      authIndex: 'abc',
      provider: 'claude',
      label: 'u@x',
      plan: 'max_20x',
      disabled: false,
    });
    expect(h.samples.map((s) => s.error)).toEqual(['boom', '']);
    expect(h.samples[1].windows.seven_day).toEqual({
      usedPercent: 40,
      resetsAt: null,
      periodHours: 168,
    });
  });
});
