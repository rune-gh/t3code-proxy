import { describe, expect, test } from 'bun:test';
import type { QuotaHistory, QuotaHistorySample } from '@/services/api';
import {
  buildPoolAccountRows,
  isReadingStale,
  latestReadingAt,
} from '@/features/quota/accountRows';

const NOW = Date.UTC(2026, 10, 14, 12);
const HOUR = 3_600_000;

const sample = (
  authIndex: string,
  t: number,
  weeklyUsed: number,
  weeklyResetIn: number,
  fiveHourUsed = 10,
  error = ''
): QuotaHistorySample => ({
  t,
  authIndex,
  error,
  windows: error
    ? {}
    : {
        five_hour: { usedPercent: fiveHourUsed, resetsAt: NOW + 2 * HOUR, periodHours: 5 },
        seven_day: {
          usedPercent: weeklyUsed,
          resetsAt: NOW + weeklyResetIn * HOUR,
          periodHours: 168,
        },
      },
});

const history = (samples: QuotaHistorySample[]): QuotaHistory => ({
  enabled: true,
  intervalSeconds: 300,
  now: NOW,
  accounts: [],
  samples,
});

const account = (authIndex: string, disabled = false) => ({
  authIndex,
  label: `${authIndex}@example.com`,
  plan: 'plus',
  disabled,
});

describe('pool account rows', () => {
  test('sorts by soonest weekly reset and marks the next account', () => {
    const rows = buildPoolAccountRows(
      history([
        sample('a', NOW - HOUR, 40, 90),
        sample('b', NOW - HOUR, 20, 30),
        sample('c', NOW - HOUR, 100, 10),
        sample('d', NOW - HOUR, 0, 5),
      ]),
      'codex',
      [account('a'), account('b'), account('c'), account('d', true)],
      NOW
    );
    expect(rows.map((row) => row.authIndex)).toEqual(['c', 'b', 'a', 'd']);
    // c is exhausted and d disabled, so the next conversation goes to b.
    expect(rows.find((row) => row.isNext)?.authIndex).toBe('b');
    expect(rows.find((row) => row.authIndex === 'c')?.exhausted).toBe(true);
    expect(rows.find((row) => row.authIndex === 'b')?.weekly?.remaining).toBe(80);
  });

  test('keeps the last good reading and surfaces a newer failure', () => {
    const rows = buildPoolAccountRows(
      history([
        sample('a', NOW - 2 * HOUR, 30, 50),
        sample('a', NOW - HOUR, 0, 0, 0, 'upstream 529'),
      ]),
      'claude',
      [account('a')],
      NOW
    );
    expect(rows[0].weekly?.remaining).toBe(70);
    expect(rows[0].lastReadAt).toBe(NOW - 2 * HOUR);
    expect(rows[0].error).toBe('upstream 529');
  });

  test('accounts without readings have no meters and sort last among enabled', () => {
    const rows = buildPoolAccountRows(
      history([sample('a', NOW - HOUR, 30, 50)]),
      'codex',
      [account('z'), account('a')],
      NOW
    );
    expect(rows.map((row) => row.authIndex)).toEqual(['a', 'z']);
    expect(rows[1].weekly).toBeNull();
    expect(latestReadingAt(rows)).toBe(NOW - HOUR);
  });

  test('flags readings older than three intervals, at least 30 minutes', () => {
    expect(isReadingStale(NOW - 20 * 60_000, NOW, 300)).toBe(false);
    expect(isReadingStale(NOW - 31 * 60_000, NOW, 300)).toBe(true);
    expect(isReadingStale(NOW - 31 * 60_000, NOW, 900)).toBe(false);
    expect(isReadingStale(null, NOW, 300)).toBe(false);
  });
});
