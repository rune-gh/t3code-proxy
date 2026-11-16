import { describe, expect, test } from 'bun:test';
import { normalizeQuotaHistory } from '../src/services/api/quotaHistory';
import { buildOwnerPoolHistory } from '../src/features/quota/__fixtures__/ownerPool';
import {
  addMonths,
  buildResetLanes,
  calendarDays,
  calendarSpan,
  groupLanesByAccount,
  monthlyWindowsIn,
  observedResets,
  periodClassOf,
  projectResetLane,
  rollMonthly,
  upcomingResets,
  type ResetLane,
} from '../src/features/quota/resetCalendarModel';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 10, 15, 12);

const ownerHistory = () => {
  const fixture = buildOwnerPoolHistory(NOW);
  return normalizeQuotaHistory({
    enabled: true,
    interval_seconds: 600,
    now: NOW,
    accounts: fixture.accounts,
    samples: fixture.samples,
  });
};

const lane = (overrides: Partial<ResetLane> = {}): ResetLane => ({
  id: 'a:seven_day',
  provider: 'codex',
  authIndex: 'a',
  accountLabel: 'a@example.com',
  plan: 'plus',
  disabled: false,
  windowKey: 'seven_day',
  reportedLabel: null,
  periodHours: 168,
  periodClass: 'week:1',
  monthly: false,
  usageTriggered: false,
  remaining: 40,
  resetsAt: NOW + 2 * DAY,
  readAt: NOW,
  budget: null,
  observed: [],
  ...overrides,
});

describe('period classes', () => {
  test('name the filter families', () => {
    expect(periodClassOf(5)).toBe('hour:5');
    expect(periodClassOf(24)).toBe('day:1');
    expect(periodClassOf(168)).toBe('week:1');
    expect(periodClassOf(336)).toBe('week:2');
    expect(periodClassOf(720)).toBe('month:1');
    expect(periodClassOf(744)).toBe('month:1');
  });
});

describe('calendar months', () => {
  test('add whole UTC months, clamping to the month end', () => {
    expect(addMonths(Date.UTC(2026, 11, 1), 1)).toBe(Date.UTC(2027, 0, 1));
    expect(addMonths(Date.UTC(2026, 0, 31), 1)).toBe(Date.UTC(2026, 1, 28));
    expect(addMonths(Date.UTC(2026, 2, 1), -1)).toBe(Date.UTC(2026, 1, 1));
  });

  test('roll a passed monthly reset to the next month', () => {
    expect(rollMonthly(Date.UTC(2026, 10, 1), NOW)).toBe(Date.UTC(2026, 11, 1));
    expect(rollMonthly(null, NOW)).toBeNull();
  });

  test('a 14-day span inside one month shows that month as one window', () => {
    const windows = monthlyWindowsIn(Date.UTC(2026, 11, 1), NOW - 3 * DAY, NOW + 11 * DAY);
    expect(windows).toEqual([{ startMs: Date.UTC(2026, 10, 1), endMs: Date.UTC(2026, 11, 1) }]);
  });

  test('a span across a month end shows both months', () => {
    const windows = monthlyWindowsIn(Date.UTC(2026, 11, 1), NOW + 10 * DAY, NOW + 24 * DAY);
    expect(windows.map((w) => w.endMs)).toEqual([Date.UTC(2026, 11, 1), Date.UTC(2027, 0, 1)]);
  });
});

describe('lanes from history', () => {
  test('one lane per renewing window, including a history-only Mistral key with budgets', () => {
    const lanes = buildResetLanes(ownerHistory(), { now: NOW });
    const mistral = lanes.filter((item) => item.provider === 'mistral');
    expect(mistral.map((item) => item.windowKey).sort()).toEqual(['api_monthly', 'vibe_monthly']);
    const api = mistral.find((item) => item.windowKey === 'api_monthly')!;
    expect(api.monthly).toBe(true);
    expect(api.periodClass).toBe('month:1');
    expect(api.reportedLabel).toBe('API usage');
    expect(api.accountLabel).toBe('Mistral EDU');
    expect(api.plan).toBe('EDU');
    expect(api.budget).toEqual({ amount: 15, currency: 'USD' });
    expect(api.resetsAt).toBe(Date.UTC(2026, 11, 1));
    expect(api.remaining).toBeCloseTo(97.4, 5);
    // Antigravity: four windows, four lanes.
    expect(lanes.filter((item) => item.provider === 'antigravity')).toHaveLength(4);
  });

  test('provider filter limits the lanes', () => {
    const lanes = buildResetLanes(ownerHistory(), { now: NOW, providers: ['codex'] });
    expect(new Set(lanes.map((item) => item.provider))).toEqual(new Set(['codex']));
  });

  test('observed resets carry the unspent share at the last reading before them', () => {
    const samples = [
      {
        t: NOW - 10 * HOUR,
        authIndex: 'a',
        error: '',
        windows: { w: { usedPercent: 20, resetsAt: NOW - 5 * HOUR, periodHours: 168 } },
      },
      {
        t: NOW - 6 * HOUR,
        authIndex: 'a',
        error: '',
        windows: { w: { usedPercent: 60, resetsAt: NOW - 5 * HOUR, periodHours: 168 } },
      },
      {
        t: NOW - 4 * HOUR,
        authIndex: 'a',
        error: '',
        windows: { w: { usedPercent: 1, resetsAt: NOW + 163 * HOUR, periodHours: 168 } },
      },
    ];
    expect(observedResets(samples, 'w', 168, NOW)).toEqual([{ at: NOW - 5 * HOUR, unspent: 40 }]);
  });
});

describe('projection', () => {
  const start = NOW - 3 * DAY;
  const end = NOW + 11 * DAY;

  test('fixed windows: elapsed, current with remaining, upcoming', () => {
    const bars = projectResetLane(
      lane({ resetsAt: NOW + 5 * DAY, observed: [{ at: NOW - 2 * DAY, unspent: 30 }] }),
      start,
      end,
      NOW
    );
    expect(bars.map((bar) => bar.state)).toEqual(['past', 'live', 'next']);
    expect(bars[0].remaining).toBe(30);
    expect(bars[0].clippedStart).toBe(true);
    expect(bars[1].remaining).toBe(40);
    expect(bars[2].remaining).toBeNull();
    expect(bars.at(-1)!.clippedEnd).toBe(true);
  });

  test('usage-triggered windows draw only the current one', () => {
    const bars = projectResetLane(
      lane({
        periodHours: 5,
        periodClass: 'hour:5',
        usageTriggered: true,
        resetsAt: NOW + 2 * HOUR,
      }),
      start,
      end,
      NOW
    );
    expect(bars).toHaveLength(1);
    expect(bars[0].state).toBe('live');
  });

  test('a monthly window fills a 14-day span as one clipped bar', () => {
    const bars = projectResetLane(
      lane({
        periodHours: 720,
        monthly: true,
        periodClass: 'month:1',
        resetsAt: Date.UTC(2026, 11, 1),
      }),
      start,
      end,
      NOW
    );
    expect(bars).toHaveLength(1);
    expect(bars[0]).toMatchObject({ state: 'live', clippedStart: true, leftPercent: 0 });
  });

  test('no reset time, nothing to draw', () => {
    expect(projectResetLane(lane({ resetsAt: null }), start, end, NOW)).toEqual([]);
  });
});

describe('ordering and next resets', () => {
  test('accounts in routing order by their longest window; disabled last', () => {
    const groups = groupLanesByAccount([
      lane({ id: 'b:7', authIndex: 'b', resetsAt: NOW + 3 * DAY }),
      lane({
        id: 'b:5',
        authIndex: 'b',
        periodHours: 5,
        resetsAt: NOW + HOUR,
        usageTriggered: true,
      }),
      lane({ id: 'a:7', authIndex: 'a', resetsAt: NOW + 1 * DAY }),
      lane({ id: 'c:7', authIndex: 'c', resetsAt: NOW + 0.5 * DAY, disabled: true }),
    ]);
    expect(groups.map((group) => group.authIndex)).toEqual(['a', 'b', 'c']);
    expect(groups[1].lanes.map((item) => item.id)).toEqual(['b:7', 'b:5']);
  });

  test('soonest first, short windows left out unless asked, money for budgets', () => {
    const lanes = [
      lane({ id: 'short', periodHours: 5, usageTriggered: true, resetsAt: NOW + HOUR }),
      lane({ id: 'week', resetsAt: NOW + 2 * DAY }),
      lane({
        id: 'month',
        monthly: true,
        periodHours: 720,
        resetsAt: NOW + 10 * DAY,
        remaining: 97.4,
        budget: { amount: 15, currency: 'USD' },
      }),
      lane({ id: 'off', disabled: true, resetsAt: NOW + 3 * HOUR }),
    ];
    const next = upcomingResets(lanes, NOW, 5);
    expect(next.map((item) => item.lane.id)).toEqual(['week', 'month']);
    expect(next[1].unspentMoney).toBeCloseTo(14.61, 2);
    expect(upcomingResets(lanes, NOW, 5, true)[0].lane.id).toBe('short');
  });
});

describe('calendar span', () => {
  test('snaps the pools span to whole local days', () => {
    const span = calendarSpan({ start: NOW - 3.5 * DAY, end: NOW + 10.5 * DAY });
    expect(span.days).toBe(14);
    expect(new Date(span.startMs).getHours()).toBe(0);
    expect(new Date(span.endMs).getHours()).toBe(0);
    const days = calendarDays(span);
    expect(days).toHaveLength(14);
    expect(days.reduce((sum, day) => sum + day.durationMs, 0)).toBe(span.endMs - span.startMs);
  });
});
