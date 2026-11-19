import { describe, expect, test } from 'bun:test';
import type { QuotaHistory, QuotaHistorySample } from '../src/services/api/quotaHistory';
import { normalizeQuotaHistory } from '../src/services/api/quotaHistory';
import enLocale from '../src/i18n/locales/en.json';
import { buildMultiProviderHistory } from '../src/features/quota/__fixtures__/multiProviderHistory';
import { buildPoolAccountRows, pickNextAccount } from '../src/features/quota/accountRows';
import {
  formatBurnRate,
  formatCapacity,
  formatPoolPercent,
  POOL_UNITS,
} from '../src/features/quota/poolFormat';
import { formatPlanName, planKey } from '../src/features/quota/poolPrefs';
import { windowLabel } from '../src/features/quota/poolWindowLabels';
import {
  HOUR_MS,
  JUMP_MIN_POINTS,
  buildAccountTracks,
  buildPoolView,
  computeBurnRate,
  defaultPoolSpan,
  detectJumps,
  historyFromLiveSnapshots,
  jumpThreshold,
  nextResetAfter,
  parseWindowKey,
  defaultPoolWindow,
  poolProvidersFromHistory,
  poolWindowChoices,
  providerWindowLabels,
  providerWindows,
  resolvePoolWindow,
  pooledAt,
  poolMax,
  remainingAt,
  shiftPoolSpan,
  simulateDrain,
  weightForAccount,
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

const sim = (id: string, remaining: number, nextReset: number | null, share = 1): SimAccount => ({
  authIndex: id,
  label: id,
  share,
  remaining,
  nextReset,
  periodMs: 168 * H,
});

describe('pooling and weights', () => {
  test('sums remaining × share of the heaviest plan and scales the pool maximum', () => {
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
    // Pro (2.5×) is the heaviest plan: 100%; Plus counts 1 / 2.5 = 40%.
    expect(tracks.map((t) => t.share)).toEqual([0.4, 1]);
    expect(poolMax(tracks)).toBeCloseTo(140);
    expect(pooledAt(tracks, NOW)).toBeCloseTo(60 * 0.4 + 90);
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
          windows: [{ key: 'seven_day', usedPercent: 30, resetAtMs: NOW + H, periodHours: 168 }],
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
    // One account is the whole pool: 100% whatever its plan weight.
    expect(pooledAt(tracks, NOW)).toBe(70);
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
      weight: null,
    });
    expect(h.samples.map((s) => s.error)).toEqual(['boom', '']);
    expect(h.samples[1].windows.seven_day).toEqual({
      usedPercent: 40,
      resetsAt: null,
      periodHours: 168,
    });
  });
});

/* ---------------------------------------------------------------------------
 * Every provider: data-driven pools, window keys, weights from the hub
 * ------------------------------------------------------------------------- */

/** Minimal i18next stand-in over the real English strings. */
const t = (key: string, options: Record<string, unknown> = {}): string => {
  const value = key
    .split('.')
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined,
      enLocale
    );
  if (typeof value !== 'string') return key;
  return value.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(options[name] ?? ''));
};

const multi = () =>
  normalizeQuotaHistory(
    {
      enabled: true,
      interval_seconds: 600,
      now: NOW,
      ...buildMultiProviderHistory(NOW),
    },
    NOW
  );

describe('pools for every provider', () => {
  test('any provider with renewing windows in the history gets a pool', () => {
    const h = multi();
    expect(poolProvidersFromHistory(h)).toEqual(['xai', 'antigravity']);
  });

  test('Claude and Codex lead, other providers follow in first-seen order', () => {
    const base = multi();
    const h: QuotaHistory = {
      ...base,
      accounts: [
        ...base.accounts,
        { authIndex: 'c', provider: 'codex', label: 'c', plan: 'plus', disabled: false },
        { authIndex: 'k', provider: 'claude', label: 'k', plan: 'pro', disabled: false },
      ],
      samples: [
        ...base.samples,
        sample(NOW - H, 'c', { seven_day: { used: 10 } }),
        sample(NOW - H, 'k', { seven_day: { used: 10 } }),
      ],
    };
    expect(poolProvidersFromHistory(h)).toEqual(['claude', 'codex', 'xai', 'antigravity']);
  });

  test('balances that never renew, disabled accounts and failed samples do not pool', () => {
    const h = history(
      [
        { id: 'k1', provider: 'kimi' },
        { id: 'd1', provider: 'devin', disabled: true },
        { id: 'm1', provider: 'meta' },
      ],
      [
        {
          t: NOW - H,
          authIndex: 'k1',
          error: '',
          windows: { credits: { usedPercent: 40, resetsAt: null, periodHours: null } },
        },
        sample(NOW - H, 'd1', { seven_day: { used: 10 } }),
        { t: NOW - H, authIndex: 'm1', error: 'boom', windows: {} },
      ]
    );
    expect(poolProvidersFromHistory(h)).toEqual([]);
  });

  test('window choices come from the keys present, longest period first', () => {
    const h = multi();
    expect(poolWindowChoices('xai', h)).toEqual(['monthly', 'seven_day']);
    expect(defaultPoolWindow('xai', h)).toBe('monthly');
    expect(poolWindowChoices('antigravity', h)).toEqual([
      'seven_day_gemini_pro',
      'image_gen',
      // Same length: the order the provider reports them in.
      'five_hour_gemini_pro',
      'five_hour_claude',
    ]);
    expect(defaultPoolWindow('antigravity', h)).toBe('seven_day_gemini_pro');
    expect(providerWindows(h, 'xai')).toEqual([
      { key: 'monthly', periodHours: 720, label: null },
      { key: 'seven_day', periodHours: 168, label: null },
    ]);
  });

  test('Gemini defaults to its own weekly models even when the shared group arrives first', () => {
    const h = history(
      [{ id: 'g', provider: 'antigravity' }],
      [sample(NOW, 'g', {
        group_claude_and_gpt_models_3p_weekly: { used: 20, period: 168 },
        group_gemini_models_gemini_5h: { used: 30, period: 5 },
        group_gemini_models_gemini_weekly: { used: 40, period: 168 },
      })]
    );
    expect(defaultPoolWindow('antigravity', h)).toBe('group_gemini_models_gemini_weekly');
    expect(resolvePoolWindow('antigravity', h, 'group_claude_and_gpt_models_3p_weekly'))
      .toBe('group_claude_and_gpt_models_3p_weekly');
  });

  test('Gemini falls back to an available window when its own models are absent', () => {
    const h = history(
      [{ id: 'g', provider: 'antigravity' }],
      [sample(NOW, 'g', { seven_day_claude: { used: 20 } })]
    );
    expect(defaultPoolWindow('antigravity', h)).toBe('seven_day_claude');
    expect(defaultPoolWindow('antigravity')).toBeNull();
  });

  test('Claude and Codex keep their named choices and defaults', () => {
    const h = multi();
    expect(poolWindowChoices('claude', h)).toEqual(['weekly', 'fable', 'five_hour']);
    expect(defaultPoolWindow('claude')).toBe('weekly');
    expect(poolWindowChoices('codex')).toEqual(['weekly', 'five_hour']);
    expect(defaultPoolWindow('codex')).toBe('weekly');
  });

  test('a remembered choice that is no longer offered falls back to the default', () => {
    const h = multi();
    expect(resolvePoolWindow('xai', h, 'seven_day')).toBe('seven_day');
    expect(resolvePoolWindow('xai', h, 'fable')).toBe('monthly');
    expect(resolvePoolWindow('xai', h, undefined)).toBe('monthly');
    expect(resolvePoolWindow('claude', h, undefined)).toBe('weekly');
  });

  test('xAI pools by the weight the hub reports per account', () => {
    const h = multi();
    const view = buildPoolView(h, {
      provider: 'xai',
      window: 'monthly',
      now: NOW,
      spanStart: NOW - 3 * 24 * H,
      spanEnd: NOW + 10 * 24 * H,
      burnWindowHours: 3,
      futureUsage: 'same',
    });
    expect(view.tracks.map((track) => [track.authIndex, track.weight])).toEqual([
      ['g1', 1],
      ['g2', 8],
    ]);
    // SuperGrok Heavy (8×) is 100%, SuperGrok 12.5%.
    expect(view.max).toBeCloseTo(112.5);
    expect(view.current).toBeGreaterThan(0);
    expect(view.current).toBeLessThanOrEqual(112.5);
    expect(view.recorded.length).toBeGreaterThan(10);
    expect(view.burnRate).toBeGreaterThan(0);
  });

  test('the effective plan map wins over a stale per-account weight', () => {
    const h = multi();
    const tracks = buildAccountTracks(h, 'xai', 'monthly', { supergrok_heavy: 2 });
    expect(tracks.map((track) => track.weight)).toEqual([1, 2]);
    expect(poolMax(tracks)).toBe(150);
  });

  test('Antigravity pools a model-scoped 5-hour window, skipping accounts without it', () => {
    const h = multi();
    const tracks = buildAccountTracks(h, 'antigravity', 'five_hour_claude');
    expect(tracks.map((track) => track.authIndex)).toEqual(['a1', 'a2']);
    expect(tracks.map((track) => track.weight)).toEqual([1, 4]);
    expect(tracks.every((track) => track.windowKey === 'five_hour_claude')).toBe(true);
    const unknown = buildAccountTracks(h, 'antigravity', 'image_gen');
    expect(unknown.map((track) => track.authIndex)).toEqual(['a1']);
  });

  test('an unknown provider with an unknown key still pools and gets a label', () => {
    const h = history(
      [{ id: 'z1', provider: 'muse', plan: 'team' }],
      [
        {
          t: NOW - H,
          authIndex: 'z1',
          error: '',
          windows: { zq_bucket: { usedPercent: 25, resetsAt: NOW + 2 * H, periodHours: null } },
        },
      ]
    );
    expect(poolProvidersFromHistory(h)).toEqual(['muse']);
    expect(poolWindowChoices('muse', h)).toEqual(['zq_bucket']);
    const view = buildPoolView(h, {
      provider: 'muse',
      window: 'zq_bucket',
      now: NOW,
      spanStart: NOW - 24 * H,
      spanEnd: NOW + 24 * H,
      burnWindowHours: 3,
      futureUsage: 'same',
    });
    expect(view.current).toBe(75);
    expect(windowLabel(t, 'zq_bucket')).toBe('Zq Bucket');
  });

  test('per-account rows use the provider windows, weights and the longest window for order', () => {
    const h = multi();
    const windows = providerWindows(h, 'antigravity');
    const rows = buildPoolAccountRows(
      h,
      'antigravity',
      ['a1', 'a2', 'a3'].map((id) => ({ authIndex: id, label: id, plan: null, disabled: false })),
      NOW,
      {
        windowKeys: [...windows].reverse().map((window) => window.key),
        primary: windows[0].key,
        weights: { ultra: 4, pro: 1 },
      }
    );
    const a3 = rows.find((row) => row.authIndex === 'a3')!;
    expect(Object.keys(a3.windows)).toEqual([
      'five_hour_claude',
      'five_hour_gemini_pro',
      'image_gen',
      'seven_day_gemini_pro',
    ]);
    expect(a3.windows.five_hour_claude).toBeNull();
    expect(a3.plan).toBe('pro');
    expect(rows.find((row) => row.authIndex === 'a2')!.weight).toBe(4);
    // Ordered by the soonest reset of the longest (weekly) window.
    const resets = rows.map((row) => row.weekly!.resetsAt!);
    expect([...resets].sort((a, b) => a - b)).toEqual(resets);
    expect(rows.filter((row) => row.isNext)).toHaveLength(1);
  });
});

describe('window labels', () => {
  test('Claude and Codex labels are unchanged', () => {
    expect(windowLabel(t, 'weekly')).toBe('Weekly');
    expect(windowLabel(t, 'fable')).toBe('Fable weekly');
    expect(windowLabel(t, 'five_hour')).toBe('5-hour');
  });

  test('backend keys read as plain names', () => {
    expect(windowLabel(t, 'seven_day')).toBe('Weekly');
    expect(windowLabel(t, 'seven_day_opus')).toBe('Opus weekly');
    expect(windowLabel(t, 'seven_day_gemini_pro')).toBe('Gemini Pro weekly');
    expect(windowLabel(t, 'five_hour_claude')).toBe('Claude 5-hour');
    expect(windowLabel(t, 'monthly')).toBe('Monthly');
    expect(windowLabel(t, 'thirty_day')).toBe('Monthly');
    expect(windowLabel(t, 'daily')).toBe('Daily');
    expect(windowLabel(t, '24h')).toBe('Daily');
    expect(windowLabel(t, '12h')).toBe('12-hour');
    expect(windowLabel(t, 'two_week')).toBe('2-week');
    expect(windowLabel(t, 'image_gen')).toBe('Image Gen');
  });

  test('odd keys never come back empty', () => {
    expect(windowLabel(t, '')).toBe('Quota window');
    expect(windowLabel(t, '___')).toBe('Quota window');
    expect(windowLabel(t, 'x-1')).toBe('X 1');
    expect(parseWindowKey('weird key!')).toEqual({ span: null, scope: 'Weird Key!' });
  });
});

describe('pooled units', () => {
  test('every pool reads in percent of its heaviest plan', () => {
    expect(POOL_UNITS.value(471)).toBe('471%');
    expect(POOL_UNITS.value(38.4)).toBe('38%');
    expect(POOL_UNITS.value(0.3)).toBe('<1%');
    expect(POOL_UNITS.value(-5)).toBe('0%');
    expect(POOL_UNITS.signed(20)).toBe('+20%');
    expect(formatBurnRate(34)).toBe('34%/h');
    expect(formatBurnRate(2.34)).toBe('2.3%/h');
    expect(formatBurnRate(0.01)).toBe('<0.1%/h');
    expect(formatBurnRate(0)).toBe('0%/h');
    expect(formatCapacity(12.5)).toBe('12.5%');
    expect(formatPoolPercent(120)).toBe('120%');
  });
});

describe('percent of the heaviest plan (owner pools)', () => {
  const ownerView = (
    provider: string,
    accounts: Array<{ id: string; plan: string; weight: number; used: number }>,
    weights?: Record<string, number>
  ) => {
    const h: QuotaHistory = {
      enabled: true,
      intervalSeconds: 600,
      now: NOW,
      accounts: accounts.map((a) => ({
        authIndex: a.id,
        provider,
        label: a.id,
        plan: a.plan,
        disabled: false,
        weight: a.weight,
      })),
      samples: accounts.map((a) =>
        sample(NOW - H, a.id, { seven_day: { used: a.used, resetsAt: NOW + 24 * H } })
      ),
    };
    return buildPoolView(h, {
      provider,
      window: 'weekly',
      weights,
      now: NOW,
      spanStart: NOW - 24 * H,
      spanEnd: NOW + 3 * 24 * H,
      burnWindowHours: 3,
      futureUsage: 'same',
    });
  };

  test('Claude Pro + Max 5x: 38% of 120%, Max 5x = 100%, Pro = 20%', () => {
    const view = ownerView(
      'claude',
      [
        { id: 'pro', plan: 'pro', weight: 1, used: 100 },
        { id: 'max', plan: 'max_5x', weight: 5, used: 62 },
      ],
      { pro: 1, max_5x: 5 }
    );
    expect(view.tracks.map((t) => [t.authIndex, t.share])).toEqual([
      ['pro', 0.2],
      ['max', 1],
    ]);
    expect(view.max).toBeCloseTo(120);
    expect(view.current).toBeCloseTo(38);
    expect(POOL_UNITS.value(view.current)).toBe('38%');
    expect(POOL_UNITS.value(view.max)).toBe('120%');
    // The projected reset refills both: Pro adds 20%, Max 5x adds 62%.
    const reset = view.jumps.find((jump) => jump.projected);
    expect(reset?.amount).toBeCloseTo(20 + 62);
  });

  test('Codex Plus + prolite at 5×: 80% of 120%', () => {
    const view = ownerView('codex', [
      { id: 'plus', plan: 'plus', weight: 1, used: 100 },
      { id: 'prolite', plan: 'prolite', weight: 5, used: 20 },
    ]);
    expect(view.max).toBeCloseTo(120);
    expect(view.current).toBeCloseTo(80);
  });

  test('a heavier account without a reading still sets the scale', () => {
    const h: QuotaHistory = {
      enabled: true,
      intervalSeconds: 600,
      now: NOW,
      accounts: [
        {
          authIndex: 'pro',
          provider: 'claude',
          label: 'pro',
          plan: 'pro',
          disabled: false,
          weight: 1,
        },
        {
          authIndex: 'max',
          provider: 'claude',
          label: 'max',
          plan: 'max_5x',
          disabled: false,
          weight: 5,
        },
        {
          authIndex: 'off',
          provider: 'claude',
          label: 'off',
          plan: 'max_20x',
          disabled: true,
          weight: 20,
        },
      ],
      // Only Pro has a sample; the Max 5x read failed and the Max 20x account is disabled.
      samples: [sample(NOW - H, 'pro', { seven_day: { used: 50, resetsAt: NOW + 24 * H } })],
    };
    const tracks = buildAccountTracks(h, 'claude', 'weekly');
    expect(tracks.map((t) => [t.authIndex, t.share])).toEqual([['pro', 0.2]]);
    expect(poolMax(tracks)).toBeCloseTo(20);
    expect(pooledAt(tracks, NOW)).toBeCloseTo(10);
  });

  test('a plan sent as a display name finds its weight by plan key', () => {
    expect(planKey('SuperGrok Heavy')).toBe('supergrok_heavy');
    expect(planKey(' Max-20x ')).toBe('max_20x');
    expect(formatPlanName('supergrok')).toBe('SuperGrok');
    expect(formatPlanName('SuperGrok Heavy')).toBe('SuperGrok Heavy');
    expect(formatPlanName('max_5x')).toBe('Max 5x');
    const weights = { supergrok: 1, supergrok_heavy: 10 };
    expect(weightForAccount({ plan: 'SuperGrok Heavy', weight: 1 }, weights)).toBe(10);
    expect(weightForAccount({ plan: 'SuperGrok', weight: 1 }, weights)).toBe(1);
  });

  test('a light plan keeps its reset label: the threshold scales with the lightest share', () => {
    expect(jumpThreshold([{ share: 1 }, { share: 0.2 }])).toBeCloseTo(1);
    expect(jumpThreshold([{ share: 1 }])).toBe(JUMP_MIN_POINTS);
    expect(jumpThreshold([])).toBe(JUMP_MIN_POINTS);
    // Pro refills 15% of its own window, which is 3 pool percent: still labelled.
    const view = ownerView(
      'claude',
      [
        { id: 'pro', plan: 'pro', weight: 1, used: 15 },
        { id: 'max', plan: 'max_5x', weight: 5, used: 0 },
      ],
      { pro: 1, max_5x: 5 }
    );
    const reset = view.jumps.find((jump) => jump.projected);
    expect(reset?.amount).toBeCloseTo(3);
  });

  test('a reset beyond the projected range is still reported as the next reset', () => {
    const h: QuotaHistory = {
      enabled: true,
      intervalSeconds: 600,
      now: NOW,
      accounts: [
        {
          authIndex: 'm',
          provider: 'mistral',
          label: 'm',
          plan: 'EDU',
          disabled: false,
          weight: 1,
        },
      ],
      samples: [
        sample(NOW - H, 'm', {
          api_monthly: { used: 3, resetsAt: NOW + 15 * 24 * H, period: 720 },
        }),
      ],
    };
    const view = buildPoolView(h, {
      provider: 'mistral',
      window: resolvePoolWindow('mistral', h, undefined) as string,
      now: NOW,
      spanStart: NOW - 3 * 24 * H,
      spanEnd: NOW + 11 * 24 * H,
      burnWindowHours: 3,
      futureUsage: 'same',
    });
    expect(view.tracks).toHaveLength(1);
    expect(view.nextReset?.at).toBe(NOW + 15 * 24 * H);
    expect(view.nextReset?.amount).toBeCloseTo(3);
  });

  test('a monthly window steps by calendar month, not by its length in hours', () => {
    const dec1 = Date.UTC(2026, 11, 1);
    // Recorded in November (720 hours); December has 744.
    expect(nextResetAfter(dec1, 720, dec1 + H)).toBe(Date.UTC(2027, 0, 1));
    expect(nextResetAfter(dec1, 720, Date.UTC(2027, 0, 1) + H)).toBe(Date.UTC(2027, 1, 1));
    // A reset on the 31st lands on the last day of a shorter month.
    expect(nextResetAfter(Date.UTC(2027, 0, 31), 744, Date.UTC(2027, 1, 1))).toBe(
      Date.UTC(2027, 1, 28)
    );
    // Weekly windows are untouched.
    expect(nextResetAfter(dec1, 168, dec1 + H)).toBe(dec1 + 168 * H);
    expect(nextResetAfter(dec1, 720, dec1 - H)).toBe(dec1);
  });

  test('an unweighted pool stays N × 100%', () => {
    const view = ownerView('codex', [
      { id: 'a', plan: 'plus', weight: 1, used: 50 },
      { id: 'b', plan: 'plus', weight: 1, used: 0 },
    ]);
    expect(view.max).toBe(200);
    expect(view.current).toBe(150);
  });

  test('a single heavy account is 100%, whatever its weight', () => {
    const view = ownerView('claude', [{ id: 'g', plan: 'max_20x', weight: 20, used: 25 }]);
    expect(view.max).toBe(100);
    expect(view.current).toBe(75);
  });
});

describe('provider-reported window names', () => {
  test('prefers the name the hub reports over one read from the key', () => {
    const history = normalizeQuotaHistory({
      enabled: true,
      accounts: [
        { auth_index: 'agy-1', provider: 'antigravity', label: 'a', plan: '', disabled: false },
      ],
      samples: [
        {
          t: 1_000,
          auth_index: 'agy-1',
          windows: {
            group_0_b1: {
              used_percent: 10,
              resets_at: 9_999_999,
              period_hours: 168,
              label: 'Gemini Pro weekly',
            },
            weekly: { used_percent: 5, resets_at: 9_999_999, period_hours: 168 },
          },
        },
      ],
    });
    const windows = providerWindows(history, 'antigravity');
    const labels = providerWindowLabels(windows);
    const t = (key: string) => key;
    expect(labels).toEqual({ group_0_b1: 'Gemini Pro weekly' });
    expect(windowLabel(t, 'group_0_b1', labels)).toBe('Gemini Pro weekly');
    expect(windowLabel(t, 'weekly', labels)).toBe('quota_pool.window_weekly');
  });
});

describe('a provider-reported `weekly` window', () => {
  test('pools under its own key instead of the Claude and Codex alias', () => {
    const history = normalizeQuotaHistory({
      enabled: true,
      accounts: [{ auth_index: 'meta-1', provider: 'meta', label: 'm', plan: '', disabled: false }],
      samples: [
        {
          t: 1_000,
          auth_index: 'meta-1',
          windows: { weekly: { used_percent: 40, resets_at: 9_999_999, period_hours: 168 } },
        },
      ],
    });
    expect(defaultPoolWindow('meta', history)).toBe('weekly');
    const tracks = buildAccountTracks(history, 'meta', 'weekly');
    expect(tracks).toHaveLength(1);
    expect(tracks[0].windowKey).toBe('weekly');
    expect(tracks[0].points[0].remaining).toBe(60);
  });
});

describe('the Next badge and the 5-hour headroom guard', () => {
  const row = (authIndex: string, weeklyReset: number, fiveHourRemaining: number, weight = 1) =>
    ({
      authIndex,
      disabled: false,
      exhausted: false,
      weight,
      weekly: { remaining: 50, resetsAt: weeklyReset },
      fiveHour: { remaining: fiveHourRemaining, resetsAt: null },
    }) as unknown as Parameters<typeof pickNextAccount>[0][number];

  test('passes over an account with little 5-hour headroom while another has room', () => {
    expect(pickNextAccount([row('soon-but-tight', 1_000, 5), row('later', 2_000, 50)])).toBe(
      'later'
    );
  });
  test('weighs headroom by plan, and falls back when every account is tight', () => {
    expect(pickNextAccount([row('max', 1_000, 5, 20), row('later', 2_000, 50)])).toBe('max');
    expect(pickNextAccount([row('a', 1_000, 5), row('b', 2_000, 4)])).toBe('a');
  });
});
