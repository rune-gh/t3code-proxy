import { describe, expect, test } from 'bun:test';
import enLocale from '../src/i18n/locales/en.json';
import { normalizeQuotaHistory, type QuotaHistory } from '../src/services/api/quotaHistory';
import { buildOwnerPoolHistory } from '../src/features/quota/__fixtures__/ownerPool';
import { liveReadFor, stableKey } from '../src/features/quota/liveWindows';
import {
  buildPoolView,
  defaultPoolWindow,
  historyFromLiveSnapshots,
  mergeLiveHistory,
  poolProvidersFromHistory,
  poolWindowChoices,
  providerWindowLabels,
  providerWindows,
} from '../src/features/quota/poolModel';
import { groupWindowChoices, windowColumns } from '../src/features/quota/poolWindowLabels';
import { POOL_UNITS } from '../src/features/quota/poolFormat';

const NOW = Date.UTC(2026, 10, 15, 12, 0, 0);
const H = 3_600_000;

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

const owner = (): QuotaHistory => {
  const fixture = buildOwnerPoolHistory(NOW);
  const weights: Record<string, number> = { max_5x: 5, prolite: 5 };
  return normalizeQuotaHistory({
    enabled: true,
    interval_seconds: 600,
    now: NOW,
    accounts: fixture.accounts.map((account) => ({
      ...account,
      weight: weights[String(account.plan)] ?? 1,
    })),
    samples: fixture.samples,
  });
};

const view = (history: QuotaHistory, provider: string, window: string) =>
  buildPoolView(history, {
    provider,
    window,
    now: NOW,
    spanStart: NOW - 3 * 24 * H,
    spanEnd: NOW + 10 * 24 * H,
    burnWindowHours: 3,
    futureUsage: 'same',
  });

describe('live reads as history windows', () => {
  test('stableKey matches the hub recorder', () => {
    expect(stableKey('Claude and GPT models')).toBe('claude_and_gpt_models');
    expect(stableKey('gemini-5h')).toBe('gemini_5h');
    expect(stableKey('  ')).toBe('');
  });

  test('nothing until a read succeeds', () => {
    expect(liveReadFor('xai', undefined)).toBeNull();
    expect(liveReadFor('xai', { status: 'error', billing: null })).toBeNull();
    expect(liveReadFor('xai', { status: 'loading', billing: null })).toBeNull();
  });

  test('Antigravity groups map to the recorder keys and labels', () => {
    const read = liveReadFor('antigravity', {
      status: 'success',
      subscription: { plan: 'Pro', tierName: null, tierId: null },
      groups: [
        {
          id: 'gemini-models',
          label: 'Gemini Models',
          buckets: [
            {
              id: 'gemini-5h',
              label: '5h',
              window: '5h',
              remainingFraction: 0.6,
              resetAtMs: NOW + H,
              periodHours: 5,
            },
            {
              id: 'gemini-weekly',
              label: 'weekly',
              window: 'weekly',
              remainingFraction: 0.73,
              resetAtMs: NOW + 90 * H,
              periodHours: 168,
            },
          ],
        },
        {
          id: 'claude-and-gpt-models',
          label: 'Claude and GPT models',
          buckets: [
            {
              id: '3p-5h',
              label: '5h',
              window: '5h',
              remainingFraction: 0.2,
              resetAtMs: NOW + 2 * H,
              periodHours: 5,
            },
          ],
        },
      ],
    });
    expect(read?.plan).toBe('pro');
    expect(read?.windows.map((window) => [window.key, window.label])).toEqual([
      ['group_gemini_models_gemini_5h', 'Gemini Models 5h'],
      ['group_gemini_models_gemini_weekly', 'Gemini Models weekly'],
      ['group_claude_and_gpt_models_3p_5h', 'Claude and GPT models 5h'],
    ]);
    expect(read?.windows[1].usedPercent).toBeCloseTo(27);
  });

  test('xAI weekly credit usage maps to `weekly`; a monthly limit adds `monthly`', () => {
    const read = liveReadFor('xai', {
      status: 'success',
      billing: {
        mode: 'billing',
        periodType: 'weekly',
        usagePercent: 35,
        resetAtMs: NOW + 76 * H,
        periodHours: 168,
        productUsage: [],
        monthlyLimitCents: 0,
        usedCents: 0,
        includedUsedCents: null,
        onDemandCapCents: null,
        onDemandUsedCents: null,
        onDemandUsedPercent: null,
        usedPercent: null,
        planLabel: 'SuperGrok',
      },
    });
    expect(read?.plan).toBe('supergrok');
    expect(read?.windows).toEqual([
      { key: 'weekly', usedPercent: 35, resetAtMs: NOW + 76 * H, periodHours: 168 },
    ]);
  });

  test('Devin, Meta and Kimi windows renew with their periods', () => {
    expect(
      liveReadFor('devin', {
        status: 'success',
        plan: 'Pro',
        windows: [{ id: 'weekly', remainingPercent: 70, resetAtMs: NOW + H, periodHours: 168 }],
      })?.windows
    ).toEqual([{ key: 'weekly', usedPercent: 30, resetAtMs: NOW + H, periodHours: 168 }]);
    expect(
      liveReadFor('meta', {
        status: 'success',
        data: {
          windows: [
            { id: 'window', usedPercent: 10, resetAt: NOW / 1000 + 60, durationMinutes: 300 },
            { id: 'weekly', usedPercent: 40, resetAt: NOW / 1000 + 3600 },
          ],
        },
      })?.windows.map((window) => [window.key, window.periodHours])
    ).toEqual([
      ['window', 5],
      ['weekly', 168],
    ]);
    expect(
      liveReadFor('kimi', {
        status: 'success',
        rows: [
          {
            id: 'limit-0',
            label: '5h limit',
            used: 25,
            limit: 100,
            resetAtMs: NOW + H,
            periodHours: 5,
          },
          { id: 'summary', used: 1, limit: 4, resetAtMs: NOW + 9 * H, periodHours: 168 },
          // A one-off balance with no reset and no period does not pool.
          {
            id: 'limit-2',
            label: 'credits',
            used: 3,
            limit: 10,
            resetAtMs: null,
            periodHours: null,
          },
        ],
      })?.windows.map((window) => [window.key, window.usedPercent])
    ).toEqual([
      ['limit_5h_limit', 25],
      ['summary', 25],
    ]);
  });

  test('a single live xAI account pools as a 100% card', () => {
    const live = historyFromLiveSnapshots(
      [
        {
          authIndex: 'g',
          provider: 'xai',
          label: 'g',
          plan: 'supergrok',
          disabled: false,
          windows: [{ key: 'weekly', usedPercent: 35, resetAtMs: NOW + 76 * H, periodHours: 168 }],
        },
      ],
      NOW
    );
    expect(poolProvidersFromHistory(live)).toEqual(['xai']);
    expect(defaultPoolWindow('xai', live)).toBe('weekly');
    const pool = view(live, 'xai', 'weekly');
    expect(POOL_UNITS.value(pool.max)).toBe('100%');
    expect(POOL_UNITS.value(pool.current)).toBe('65%');
  });
});

describe('recorded history with live reads filling the gaps', () => {
  test('a provider the recorder lacks is fed live; recorded providers stay recorded', () => {
    const recorded = owner();
    const withoutXai: QuotaHistory = {
      ...recorded,
      samples: recorded.samples.filter((sample) => sample.authIndex !== 'o-g1'),
    };
    const live = historyFromLiveSnapshots(
      [
        {
          authIndex: 'o-g1',
          provider: 'xai',
          label: 'grok',
          plan: 'supergrok',
          disabled: false,
          windows: [{ key: 'weekly', usedPercent: 50, resetAtMs: NOW + H, periodHours: 168 }],
        },
        {
          authIndex: 'o-c1',
          provider: 'claude',
          label: 'pro',
          plan: 'pro',
          disabled: false,
          windows: [{ key: 'seven_day', usedPercent: 0, resetAtMs: NOW + H, periodHours: 168 }],
        },
      ],
      NOW
    );
    const merged = mergeLiveHistory(withoutXai, live);
    expect(poolProvidersFromHistory(merged)).toContain('xai');
    expect(merged.accounts.filter((account) => account.authIndex === 'o-g1')).toHaveLength(1);
    expect(view(merged, 'xai', 'weekly').current).toBe(50);
    // Claude is recorded, so its live read does not leak in (still 38%, not 58%).
    expect(view(merged, 'claude', 'weekly').current).toBeCloseTo(38);
    expect(mergeLiveHistory(recorded, historyFromLiveSnapshots([], NOW))).toBe(recorded);
  });
});

describe('owner pool fixture', () => {
  test('Claude 38% of 120%, Codex 80% of 120%', () => {
    const history = owner();
    const claude = view(history, 'claude', 'weekly');
    expect(POOL_UNITS.value(claude.current)).toBe('38%');
    expect(POOL_UNITS.value(claude.max)).toBe('120%');
    const codex = view(history, 'codex', 'weekly');
    expect(POOL_UNITS.value(codex.current)).toBe('80%');
    expect(POOL_UNITS.value(codex.max)).toBe('120%');
  });

  test('Antigravity: weekly of the first group by default, a group picker with short tabs', () => {
    const history = owner();
    expect(defaultPoolWindow('antigravity', history)).toBe('group_gemini_models_gemini_weekly');
    const choices = poolWindowChoices('antigravity', history);
    const labels = providerWindowLabels(providerWindows(history, 'antigravity'));
    const groups = groupWindowChoices(t, choices, labels);
    expect(groups?.groups).toEqual(['Gemini Models', 'Claude and GPT models']);
    expect(
      groups?.items.filter((item) => item.group === 'Gemini Models').map((item) => item.period)
    ).toEqual(['Weekly', '5-hour']);
    const columns = windowColumns(t, providerWindows(history, 'antigravity'), labels);
    expect(columns.map((column) => [column.group, column.period])).toEqual([
      ['Gemini Models', '5-hour'],
      ['Gemini Models', 'Weekly'],
      ['Claude and GPT models', '5-hour'],
      ['Claude and GPT models', 'Weekly'],
    ]);
  });

  test('xAI with one unlabelled weekly window offers no switcher', () => {
    const history = owner();
    expect(poolWindowChoices('xai', history)).toEqual(['weekly']);
    expect(groupWindowChoices(t, ['weekly'])).toBeNull();
    expect(groupWindowChoices(t, ['weekly', 'fable'])).toBeNull();
  });

  test('bare keys group by their parsed scope and period', () => {
    const groups = groupWindowChoices(t, [
      'seven_day_gemini_pro',
      'seven_day_claude',
      'five_hour_gemini_pro',
      'five_hour_claude',
    ]);
    expect(groups?.groups).toEqual(['Gemini Pro', 'Claude']);
    expect(groups?.items.map((item) => item.period)).toEqual([
      'Weekly',
      'Weekly',
      '5-hour',
      '5-hour',
    ]);
    // A window with no period anywhere keeps the flat picker.
    expect(groupWindowChoices(t, ['seven_day_gemini_pro', 'image_gen'])).toBeNull();
  });
});
