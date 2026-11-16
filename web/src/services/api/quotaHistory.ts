/**
 * Recorded quota history (t3code-proxy hub extension).
 *
 * Contract: `GET …/quota-history?since=<ms>&until=<ms>` and
 * `POST …/quota-history/refresh`. The t3code-proxy hub serves both under the
 * v8 management prefix (used first, like every other panel request) and the
 * v0 prefix; the v0 URL, derived from the client's v8 base, is only tried
 * when the v8 route is missing. Requests still go through `apiClient`
 * (bearer auth, error normalization, connection events).
 */

import type { ApiError } from '@/types';
import { isRecord } from '@/utils/helpers';
import { apiClient } from './client';

export interface QuotaHistoryWindow {
  usedPercent: number | null;
  /** Epoch ms of the next reset, when known. */
  resetsAt: number | null;
  periodHours: number | null;
  /** The provider's own name for this window, when the hub reports one. */
  label?: string;
  /**
   * Money the window allows, for API-key providers with a spending budget
   * (Mistral: `budget: 15`, `currency: "USD"`). Absent for subscription windows.
   */
  budget?: QuotaBudget;
}

export interface QuotaBudget {
  amount: number;
  /** ISO 4217 code, upper case; USD when the hub states an amount without one. */
  currency: string;
}

export interface QuotaHistorySample {
  t: number;
  authIndex: string;
  /** Keyed by backend window name: `five_hour`, `seven_day`, `seven_day_fable`, ... */
  windows: Record<string, QuotaHistoryWindow>;
  error: string;
}

export interface QuotaHistoryAccount {
  authIndex: string;
  provider: string;
  label: string;
  plan: string | null;
  disabled: boolean;
  /**
   * The account's effective plan weight as the hub routes with it (1 = one
   * base-plan account). Absent on hubs that predate server-side plan weights.
   */
  weight?: number | null;
}

export interface QuotaHistory {
  enabled: boolean;
  intervalSeconds: number;
  now: number;
  accounts: QuotaHistoryAccount[];
  samples: QuotaHistorySample[];
}

const finiteNumber = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

/** Accepts epoch ms, epoch seconds, or an ISO string. */
const epochMs = (value: unknown): number | null => {
  const numeric = finiteNumber(value);
  if (numeric !== null) return numeric < 1e12 ? numeric * 1000 : numeric;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const text = (value: unknown): string =>
  typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';

/**
 * A window's budget, read defensively: the amount as `budget` (number, numeric
 * string, or `{ amount, currency }`), `budget_amount` or `budget_usd`; the
 * currency as `currency` or `budget_currency`. Non-positive amounts are dropped.
 */
const normalizeBudget = (value: Record<string, unknown>): QuotaBudget | null => {
  const nested = isRecord(value.budget) ? value.budget : null;
  const amount = finiteNumber(
    nested
      ? (nested.amount ?? nested.value)
      : (value.budget ??
          value.budget_amount ??
          value.budgetAmount ??
          value.budget_usd ??
          value.budgetUsd)
  );
  if (amount === null || !(amount > 0)) return null;
  const rawCurrency = text(
    nested?.currency ?? value.currency ?? value.budget_currency ?? value.budgetCurrency
  )
    .trim()
    .toUpperCase();
  return { amount, currency: /^[A-Z]{3}$/.test(rawCurrency) ? rawCurrency : 'USD' };
};

const normalizeWindow = (value: unknown): QuotaHistoryWindow | null => {
  if (!isRecord(value)) return null;
  const budget = normalizeBudget(value);
  return {
    usedPercent: finiteNumber(value.used_percent ?? value.usedPercent),
    resetsAt: epochMs(value.resets_at ?? value.resetsAt),
    periodHours: finiteNumber(value.period_hours ?? value.periodHours),
    ...(typeof value.label === 'string' && value.label.trim() ? { label: value.label.trim() } : {}),
    ...(budget ? { budget } : {}),
  };
};

export const normalizeQuotaHistory = (payload: unknown, receivedAt = Date.now()): QuotaHistory => {
  const root = isRecord(payload) ? payload : {};
  const accounts: QuotaHistoryAccount[] = (Array.isArray(root.accounts) ? root.accounts : [])
    .filter(isRecord)
    .map((account) => {
      const weight = finiteNumber(account.weight);
      return {
        authIndex: text(account.auth_index ?? account.authIndex),
        provider: text(account.provider).toLowerCase(),
        label: text(account.label),
        plan: text(account.plan) || null,
        disabled: account.disabled === true,
        weight: weight !== null && weight > 0 ? weight : null,
      };
    })
    .filter((account) => account.authIndex !== '');

  const samples: QuotaHistorySample[] = [];
  (Array.isArray(root.samples) ? root.samples : []).forEach((sample) => {
    if (!isRecord(sample)) return;
    const t = epochMs(sample.t);
    const authIndex = text(sample.auth_index ?? sample.authIndex);
    if (t === null || !authIndex) return;
    const windows: Record<string, QuotaHistoryWindow> = {};
    if (isRecord(sample.windows)) {
      Object.entries(sample.windows).forEach(([key, value]) => {
        const window = normalizeWindow(value);
        if (window) windows[key] = window;
      });
    }
    samples.push({ t, authIndex, windows, error: text(sample.error) });
  });
  samples.sort((a, b) => a.t - b.t);

  const interval = finiteNumber(root.interval_seconds ?? root.intervalSeconds);
  return {
    enabled: root.enabled === true,
    intervalSeconds: interval !== null && interval > 0 ? interval : 600,
    now: epochMs(root.now) ?? receivedAt,
    accounts,
    samples,
  };
};

const V0_PATH = '/v0/management/quota-history';
const V8_PATH = '/quota-history';

/** Absolute v0 URL derived from the v8 management base. */
const v0Url = (suffix = ''): string => {
  const base = apiClient.getApiBase().replace(/\/v8\/management\/?$/i, '');
  return `${base}${V0_PATH}${suffix}`;
};

const isNotFound = (error: unknown): boolean =>
  (error as ApiError | undefined)?.status === 404 ||
  (error as ApiError | undefined)?.status === 405;

/** Set once the v8 route 404s and v0 answers, so later polls skip the miss. */
let preferV0 = false;

async function withRouteFallback<T>(v8: () => Promise<T>, v0: () => Promise<T>): Promise<T> {
  if (preferV0) return v0();
  try {
    return await v8();
  } catch (error) {
    if (!isNotFound(error)) throw error;
    const result = await v0();
    preferV0 = true;
    return result;
  }
}

/** A disabled/absent history is represented as `enabled: false`, never thrown. */
export const EMPTY_QUOTA_HISTORY = (now = Date.now()): QuotaHistory => ({
  enabled: false,
  intervalSeconds: 600,
  now,
  accounts: [],
  samples: [],
});

export const quotaHistoryApi = {
  /** Resolves `enabled: false` when the hub does not expose the endpoint (404). */
  async get(since: number, until: number): Promise<QuotaHistory> {
    const params = { since: Math.floor(since), until: Math.ceil(until) };
    try {
      const payload = await withRouteFallback(
        () => apiClient.get<unknown>(V8_PATH, { params }),
        () => apiClient.get<unknown>(v0Url(), { params })
      );
      return normalizeQuotaHistory(payload);
    } catch (error) {
      if (isNotFound(error)) return EMPTY_QUOTA_HISTORY();
      throw error;
    }
  },

  /** Ask the hub to poll every credential now. Missing endpoint is not an error. */
  async refresh(): Promise<void> {
    try {
      await withRouteFallback(
        () => apiClient.post(`${V8_PATH}/refresh`),
        () => apiClient.post(v0Url('/refresh'))
      );
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  },
};
