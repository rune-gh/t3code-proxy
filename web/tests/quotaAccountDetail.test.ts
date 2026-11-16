/**
 * What replaced the per-account cards: accounts-table rows that open the
 * account's full read, budgets (Mistral) as money beside percent, and the
 * history client reading budgets defensively.
 */

import { afterAll, describe, expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import '../src/i18n/index';
import { normalizeQuotaHistory } from '../src/services/api/quotaHistory';
import {
  AccountDetail,
  HistoryAccountDetail,
} from '../src/features/quota/components/AccountDetail';
import { PoolAccountsTable } from '../src/features/quota/components/PoolAccountsTable';
import { OtherAccountsTable } from '../src/features/quota/components/OtherAccountsTable';
import { buildPoolAccountRows } from '../src/features/quota/accountRows';
import { readShowEmails, writeShowEmails } from '../src/features/quota/uiState';
import { QUOTA_CLASS_KEYS } from '../src/features/quota/types';
import type { XaiQuotaState } from '../src/types';

// Under bun a .module.scss import is the raw stylesheet, so the class binding
// AccountDetail does at import time gets a stand-in module with every key.
mock.module(
  new URL('../src/features/quota/components/AccountDetail.module.scss', import.meta.url).pathname,
  () => ({
    default: Object.fromEntries(QUOTA_CLASS_KEYS.map((key) => [key, key])),
  })
);
const { AccountDetail, HistoryAccountDetail } =
  await import('../src/features/quota/components/AccountDetail');

const NOW = Date.UTC(2026, 10, 15, 12);

describe('history budgets', () => {
  const window = (extra: Record<string, unknown>) =>
    normalizeQuotaHistory({
      samples: [
        {
          t: NOW,
          auth_index: 'm',
          windows: { api_monthly: { used_percent: 2.6, period_hours: 720, ...extra } },
        },
      ],
    }).samples[0].windows.api_monthly;

  test('reads budget and currency', () => {
    expect(window({ budget: 15, currency: 'usd' }).budget).toEqual({ amount: 15, currency: 'USD' });
    expect(window({ budget: '15', budget_currency: 'EUR' }).budget).toEqual({
      amount: 15,
      currency: 'EUR',
    });
    expect(window({ budget: { amount: 20, currency: 'GBP' } }).budget).toEqual({
      amount: 20,
      currency: 'GBP',
    });
    expect(window({ budget_amount: 10 }).budget).toEqual({ amount: 10, currency: 'USD' });
  });

  test('drops missing, zero and unreadable budgets', () => {
    expect(window({}).budget).toBeUndefined();
    expect(window({ budget: 0 }).budget).toBeUndefined();
    expect(window({ budget: 'lots' }).budget).toBeUndefined();
    expect(window({ budget: 5, currency: 'dollars' }).budget).toEqual({
      amount: 5,
      currency: 'USD',
    });
  });
});

const mistralHistory = normalizeQuotaHistory({
  accounts: [{ auth_index: 'm1', provider: 'mistral', label: 'Mistral EDU', plan: 'EDU' }],
  samples: [
    {
      t: NOW - 60_000,
      auth_index: 'm1',
      windows: {
        api_monthly: {
          used_percent: 2.6,
          resets_at: Date.UTC(2026, 11, 1),
          period_hours: 720,
          label: 'API usage',
          budget: 15,
          currency: 'USD',
        },
      },
    },
  ],
});

describe('accounts table rows', () => {
  const rows = buildPoolAccountRows(
    mistralHistory,
    'mistral',
    [{ authIndex: 'm1', label: 'Mistral EDU', plan: 'EDU', disabled: false }],
    NOW,
    { windowKeys: ['api_monthly'], primary: 'api_monthly' }
  );

  test('budget windows show money spent beside the percent', () => {
    expect(rows[0].windows.api_monthly?.budget).toEqual({ amount: 15, currency: 'USD' });
    const markup = renderToStaticMarkup(
      createElement(PoolAccountsTable, {
        provider: 'mistral',
        providerLabel: 'Mistral',
        rows,
        windowColumns: [{ key: 'api_monthly', label: 'API usage' }],
        now: NOW,
        locale: 'en',
        renderDetail: () => 'detail',
      })
    );
    expect(markup).toContain('97%');
    expect(markup).toContain('$0.39 of $15 spent');
    // Each account opens its detail from a disclosure button, closed at first.
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain('>detail<');
  });

  test('a history-only account lists its recorded windows', () => {
    const markup = renderToStaticMarkup(
      createElement(HistoryAccountDetail, {
        windows: [{ key: 'api_monthly', label: 'API usage', reading: rows[0].windows.api_monthly }],
        lastReadAt: rows[0].lastReadAt,
        error: '',
        now: NOW,
        locale: 'en',
      })
    );
    expect(markup).toContain('API usage');
    expect(markup).toContain('$0.39 of $15 spent');
    expect(markup).toContain('Resets ');
  });

  test('accounts without a pool get the same disclosure rows', () => {
    const markup = renderToStaticMarkup(
      createElement(OtherAccountsTable, {
        providerLabel: 'Kimi',
        rows: [
          { key: 'k1', label: 'hedy@example.com', status: 'error', disabled: false },
          { key: 'k2', label: 'ada@example.com', status: 'idle', disabled: false },
        ],
        renderDetail: () => null,
      })
    );
    expect(markup).toContain('Read failed');
    expect(markup).toContain('Not read yet');
    expect(markup.match(/aria-expanded="false"/g)).toHaveLength(2);
  });
});

describe('account detail keeps what the cards showed', () => {
  test('xAI usage breakdown, pay-as-you-go state and refresh', () => {
    const quota = {
      status: 'success',
      billing: {
        mode: 'billing',
        periodType: 'weekly',
        usagePercent: 10,
        periodEnd: new Date(NOW + 5 * 86_400_000).toISOString(),
        resetAtMs: NOW + 5 * 86_400_000,
        periodHours: 168,
        productUsage: [
          { product: 'GrokBot', usagePercent: 7 },
          { product: 'GrokBuild', usagePercent: 3 },
        ],
        monthlyLimitCents: 0,
        usedCents: 0,
        includedUsedCents: 0,
        onDemandCapCents: 0,
        onDemandUsedCents: null,
        onDemandUsedPercent: null,
        usedPercent: null,
        planLabel: 'SuperGrok',
        planTier: 'premium',
        billingPeriodEnd: null,
      },
    } as unknown as XaiQuotaState;
    const markup = renderToStaticMarkup(
      createElement(AccountDetail, {
        entry: { type: 'xai', file: { name: 'grok.json', type: 'xai' } },
        quota,
        canRefresh: true,
        resetting: false,
        onRefresh: () => undefined,
        onReset: () => undefined,
      })
    );
    expect(markup).toContain('GrokBot');
    expect(markup).toContain('GrokBuild');
    expect(markup).toContain('Disabled');
    expect(markup).toContain('SuperGrok');
    expect(markup).toContain('Refresh');
  });

  test('a failed read shows its error', () => {
    const markup = renderToStaticMarkup(
      createElement(AccountDetail, {
        entry: { type: 'codex', file: { name: 'codex.json', type: 'codex' } },
        quota: { status: 'error', error: 'HTTP 401' },
        canRefresh: true,
        resetting: false,
        onRefresh: () => undefined,
        onReset: () => undefined,
      })
    );
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('HTTP 401');
  });

  test('AccountDetail.module.scss defines every QuotaClassMap key', async () => {
    const css = await Bun.file('src/features/quota/components/AccountDetail.module.scss').text();
    const missing = QUOTA_CLASS_KEYS.filter(
      (key) => !new RegExp(`^\\s*\\.${key}\\b`, 'm').test(css)
    );
    expect(missing).toEqual([]);
  });
});

describe('emails preference', () => {
  const originalWindow = (globalThis as { window?: unknown }).window;
  const store = new Map<string, string>();
  (globalThis as unknown as { window: unknown }).window = {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    },
  };
  afterAll(() => {
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = originalWindow;
  });

  test('shown by default; a stored choice of either value is kept', () => {
    expect(readShowEmails()).toBe(true);
    writeShowEmails(false);
    expect(readShowEmails()).toBe(false);
    writeShowEmails(true);
    expect(readShowEmails()).toBe(true);
  });
});
