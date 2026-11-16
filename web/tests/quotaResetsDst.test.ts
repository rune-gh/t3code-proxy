import { expect, test } from 'bun:test';

// Separate processes keep timezone changes out of the other rendering suites.
// Successor of the deleted QuotaTimeline DST suite, for the Resets calendar.
const cases: { zone: string; date: number[]; hours: number; startHour?: number }[] = [
  { zone: 'Europe/Paris', date: [2026, 9, 25], hours: 25 },
  { zone: 'Europe/Paris', date: [2026, 2, 29], hours: 23 },
  { zone: 'America/New_York', date: [2026, 10, 1], hours: 25 },
  { zone: 'America/New_York', date: [2026, 2, 8], hours: 23 },
  { zone: 'Australia/Lord_Howe', date: [2026, 3, 5], hours: 24.5 },
  { zone: 'Australia/Lord_Howe', date: [2026, 9, 4], hours: 23.5 },
  { zone: 'UTC', date: [2026, 9, 25], hours: 24 },
  { zone: 'America/Santiago', date: [2026, 8, 6], hours: 23, startHour: 1 },
];

for (const { zone, date, hours, startHour = 0 } of cases) {
  test(`resets calendar columns and labels across ${zone} ${date.join('-')}`, () => {
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        '--eval',
        `
          import { createElement } from 'react';
          import { renderToStaticMarkup } from 'react-dom/server';
          import './src/i18n/index';
          import { ResetsView } from './src/features/quota/components/ResetsView';
          import { calendarSpan, calendarDays, projectResetLane } from './src/features/quota/resetCalendarModel';
          import { normalizeQuotaHistory } from './src/services/api/quotaHistory';
          const HOUR = 3600000;
          // The transition day opens the span: the pools span starts 3.5 days before now.
          const dayStart = new Date(${date.join(',')}).getTime();
          const now = new Date(${date[0]}, ${date[1]}, ${date[2] + 3}, 12).getTime();
          const spanStart = dayStart + 6 * HOUR;
          const spanEnd = spanStart + 14 * 24 * HOUR;
          const anchor = new Date(${date[0]}, ${date[1]}, ${date[2] + 1}).getTime();
          const history = normalizeQuotaHistory({
            enabled: true, now,
            accounts: [{ auth_index: 'x', provider: 'codex', label: 'fixture', plan: 'plus' }],
            samples: [{ t: now - HOUR, auth_index: 'x', windows: {
              seven_day: { used_percent: 0, resets_at: anchor + 7 * 24 * HOUR * 1, period_hours: 168 },
            } }],
          });
          const span = calendarSpan({ start: spanStart, end: spanEnd });
          const days = calendarDays(span);
          const markup = renderToStaticMarkup(createElement(ResetsView, {
            history, providers: ['codex'], now, spanStart, spanEnd, isToday: true,
            onShift: () => {}, onToday: () => {}, filter: 'all', onFilterChange: () => {},
            resolvedTheme: 'light', locale: 'en',
          }));
          const lane = {
            id: 'x', provider: 'codex', authIndex: 'x', accountLabel: 'fixture', plan: null,
            disabled: false, windowKey: 'seven_day', reportedLabel: null, periodHours: 168,
            periodClass: 'week:1', monthly: false, usageTriggered: false, remaining: 100,
            resetsAt: anchor + 7 * 24 * HOUR, readAt: now, budget: null, observed: [],
          };
          const bars = projectResetLane(lane, span.startMs, span.endMs, now);
          console.log(JSON.stringify({
            markup, days: span.days,
            hours: days.map((day) => day.durationMs / HOUR),
            localHours: days.map((day) => new Date(day.at).getHours()),
            dates: days.map((day) => new Date(day.at).getDate()),
            coveredMs: days.reduce((sum, day) => sum + day.durationMs, 0),
            spanMs: span.endMs - span.startMs,
            endHour: new Date(span.endMs).getHours(),
            midnightPercent: days[0].durationMs / (span.endMs - span.startMs) * 100,
            windowEndPercent: bars.find((bar) => bar.endMs === anchor).leftPercent + bars.find((bar) => bar.endMs === anchor).widthPercent,
          }));
        `,
      ],
      cwd: new URL('..', import.meta.url).pathname,
      env: { ...process.env, TZ: zone },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(result.stderr.toString()).toBe('');
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout.toString());

    expect(output.days).toBe(14);
    expect(output.hours).toHaveLength(14);
    expect(output.hours[0]).toBe(hours);
    expect(output.localHours).toEqual([startHour, ...Array(13).fill(0)]);
    expect(new Set(output.dates).size).toBe(14);
    expect(output.coveredMs).toBe(output.spanMs);
    expect(output.endHour).toBe(0);
    // A window ending at local midnight ends exactly on the first column boundary.
    expect(output.windowEndPercent).toBeCloseTo(output.midnightPercent, 8);
    expect(output.markup).toContain(`--calendar-columns:minmax(0, ${hours}fr)`);
  });
}
