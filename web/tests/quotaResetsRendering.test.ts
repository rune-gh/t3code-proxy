/**
 * Resets view rendering (successor of the deleted QuotaTimeline rendering
 * suite): lanes, bar states, the "now" line, banked-reset markers with "Use
 * reset", the window filter, monthly budgets in "Next resets", empty states.
 */

import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import '../src/i18n/index';
import { ResetsView, type ResetsViewProps } from '../src/features/quota/components/ResetsView';
import { defaultPoolSpan, shiftPoolSpan } from '../src/features/quota/poolModel';
import { normalizeQuotaHistory } from '../src/services/api/quotaHistory';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = new Date(2026, 6, 29, 12).getTime();

const history = normalizeQuotaHistory({
  enabled: true,
  now: NOW,
  accounts: [
    { auth_index: 'c1', provider: 'codex', label: 'plus@example.com', plan: 'plus' },
    { auth_index: 'm1', provider: 'mistral', label: 'Mistral EDU', plan: 'EDU' },
  ],
  samples: [
    {
      t: NOW - HOUR,
      auth_index: 'c1',
      windows: {
        seven_day: { used_percent: 75, resets_at: NOW + 2 * DAY, period_hours: 168 },
        five_hour: { used_percent: 12, resets_at: NOW + 2 * HOUR, period_hours: 5 },
      },
    },
    {
      t: NOW - HOUR,
      auth_index: 'm1',
      windows: {
        api_monthly: {
          used_percent: 2.6,
          resets_at: new Date(Date.UTC(2026, 7, 1)).getTime(),
          period_hours: 744,
          label: 'API usage',
          budget: 15,
          currency: 'USD',
        },
      },
    },
  ],
});

const span = defaultPoolSpan(NOW);
const props = (overrides: Partial<ResetsViewProps> = {}): ResetsViewProps => ({
  history,
  providers: ['codex', 'mistral'],
  now: NOW,
  spanStart: span.start,
  spanEnd: span.end,
  isToday: true,
  onShift: () => undefined,
  onToday: () => undefined,
  filter: 'all',
  onFilterChange: () => undefined,
  resolvedTheme: 'dark',
  locale: 'en',
  credits: {
    c1: {
      status: 'ready',
      error: '',
      credits: [
        {
          id: 'credit-1',
          status: 'available',
          grantedAt: new Date(NOW - DAY).toISOString(),
          expiresAt: new Date(NOW + 5 * DAY).toISOString(),
        },
      ],
    },
  },
  onUseReset: () => undefined,
  ...overrides,
});

const render = (overrides: Partial<ResetsViewProps> = {}) =>
  renderToStaticMarkup(createElement(ResetsView, props(overrides)));

describe('ResetsView rendering', () => {
  test('lanes per account window with current, upcoming and the now line', () => {
    const markup = render();
    expect(markup).toContain('plus@example.com');
    expect(markup).toContain('data-state="live"');
    expect(markup).toContain('data-state="next"');
    expect(markup).toContain('25% · ');
    // 5-hour lane: the current window only, labelled beside the bar.
    expect(markup).toContain('88% · ');
    expect(markup).toContain('data-now=""');
  });

  test('banked Codex resets get an expiry marker and a Use reset action', () => {
    const markup = render();
    expect(markup).toContain('Banked reset expires');
    expect(markup).toContain('>Use reset</button>');
    expect(render({ onUseReset: undefined })).toContain('1 banked reset');
  });

  test('monthly budgets show unspent money in Next resets', () => {
    const markup = render();
    expect(markup).toContain('Mistral EDU');
    expect(markup).toContain('$14.61 of $15');
    expect(markup).toContain('97%');
  });

  test('window filter offers the periods present and filters lanes', () => {
    const markup = render();
    expect(markup).toContain('>5-hour<');
    expect(markup).toContain('>Weekly<');
    expect(markup).toContain('>Monthly<');
    const monthly = render({ filter: 'month:1' });
    expect(monthly).not.toContain('plus@example.com');
    expect(monthly).toContain('Mistral EDU');
  });

  test('a span with no current moment draws no now line but keeps the controls', () => {
    const later = shiftPoolSpan(shiftPoolSpan(span, 1), 1);
    const markup = render({ spanStart: later.start, spanEnd: later.end, isToday: false });
    expect(markup).not.toContain('data-now=""');
    expect(markup).toContain('>Today<');
  });

  test('empty history explains itself instead of drawing an empty grid', () => {
    const markup = render({ history: normalizeQuotaHistory({ accounts: [], samples: [] }) });
    expect(markup).toContain('No reset times yet');
    expect(markup).not.toContain('data-state=');
  });
});
