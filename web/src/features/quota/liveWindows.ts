/**
 * Live quota reads as quota-history windows.
 *
 * Each provider's cached quota state (what its account card shows) is mapped
 * onto the window keys, labels and plan the hub's quota-history recorder uses
 * for the same provider (internal/quotahistory/parse_providers.go), so a pool
 * card reads the same whether it is fed by recorded history or by the latest
 * live read. Pure; no React.
 */

import type {
  AntigravityQuotaState,
  ClaudeQuotaState,
  CodexQuotaState,
  DevinQuotaState,
  KimiQuotaState,
  MetaQuotaState,
  XaiQuotaState,
} from '@/types';

export interface LiveWindow {
  /** Quota-history window key (`seven_day`, `weekly`, `group_gemini_models_gemini_5h`, ...). */
  key: string;
  usedPercent: number;
  resetAtMs: number | null;
  periodHours: number | null;
  /** The provider's own name for the window, when it has one. */
  label?: string;
}

export interface LiveRead {
  windows: LiveWindow[];
  /** Plan id as the hub names it (`max_5x`, `prolite`, `supergrok`), when the read reports one. */
  plan: string | null;
}

const clamp = (value: number) => Math.min(100, Math.max(0, value));
const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/** Same rule as the hub's `stableKey`: lower-case alphanumeric words joined by `_`. */
export const stableKey = (value: string | null | undefined): string =>
  (value ?? '')
    .trim()
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .join('_');

const indexedKey = (value: string | null | undefined, index: number): string =>
  stableKey(value) || String(index);

/** A window renews when its period or its next reset is known. */
export const isRenewingLiveWindow = (window: LiveWindow): boolean =>
  (window.periodHours !== null && window.periodHours > 0) || window.resetAtMs !== null;

const CLAUDE_KEYS: Record<string, string> = {
  'five-hour': 'five_hour',
  'seven-day': 'seven_day',
  'seven-day-fable': 'seven_day_fable',
};

const CODEX_KEYS: Record<string, string> = {
  'five-hour': 'five_hour',
  weekly: 'seven_day',
};

function percentWindows(
  windows: readonly {
    id: string;
    usedPercent: number | null;
    resetAtMs?: number | null;
    periodHours?: number | null;
  }[],
  keys: Record<string, string>
): LiveWindow[] {
  const out: LiveWindow[] = [];
  windows.forEach((window) => {
    const key = keys[window.id];
    if (!key || !finite(window.usedPercent)) return;
    out.push({
      key,
      usedPercent: clamp(window.usedPercent),
      resetAtMs: window.resetAtMs ?? null,
      periodHours: window.periodHours ?? null,
    });
  });
  return out;
}

/** Antigravity and plugin quota groups: `group_<group>_<bucket>`, used = 1 − remaining. */
function groupWindows(state: Pick<AntigravityQuotaState, 'groups'>): LiveWindow[] {
  const out: LiveWindow[] = [];
  (state.groups ?? []).forEach((group, groupIndex) => {
    const groupId = indexedKey(group.label, groupIndex);
    group.buckets.forEach((bucket, bucketIndex) => {
      if (!finite(bucket.remainingFraction)) return;
      let key = `group_${groupId}_${indexedKey(bucket.id, bucketIndex)}`;
      while (out.some((window) => window.key === key)) key = `${key}_${bucketIndex}`;
      const label = `${group.label} ${(bucket.window ?? '').trim().toLowerCase()}`.trim();
      out.push({
        key,
        usedPercent: clamp((1 - Math.min(1, Math.max(0, bucket.remainingFraction))) * 100),
        resetAtMs: bucket.resetAtMs ?? null,
        periodHours: bucket.periodHours ?? null,
        ...(label ? { label } : {}),
      });
    });
  });
  return out;
}

/** Epoch ms of an ISO instant, or null. */
const isoMs = (value: string | undefined): number | null => {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};

/**
 * xAI: the credit usage of the current period (`weekly` or `monthly`), plus the
 * monthly spend against the plan's monthly limit when there is one, as the
 * recorder reads them.
 */
function xaiWindows(state: XaiQuotaState): LiveWindow[] {
  const billing = state.billing;
  if (!billing || billing.mode !== 'billing') return [];
  const windows = new Map<string, LiveWindow>();
  if (finite(billing.usagePercent) && billing.periodType !== 'unknown') {
    windows.set(billing.periodType, {
      key: billing.periodType,
      usedPercent: clamp(billing.usagePercent),
      resetAtMs: billing.resetAtMs ?? null,
      periodHours: billing.periodHours ?? (billing.periodType === 'weekly' ? 168 : null),
    });
  }
  const cap = billing.monthlyLimitCents;
  const spent = billing.usedCents;
  if (finite(cap) && cap > 0 && finite(spent) && spent >= 0) {
    const start = isoMs(billing.billingPeriodStart);
    const end = isoMs(billing.billingPeriodEnd);
    windows.set('monthly', {
      key: 'monthly',
      usedPercent: clamp((spent / cap) * 100),
      resetAtMs: end,
      periodHours: start !== null && end !== null && end > start ? (end - start) / 3_600_000 : null,
    });
  }
  return [...windows.values()];
}

function kimiWindows(state: KimiQuotaState): LiveWindow[] {
  const out: LiveWindow[] = [];
  (state.rows ?? []).forEach((row, index) => {
    if (!(row.limit > 0)) return;
    const key =
      row.id === 'summary' || row.id === 'monthly'
        ? row.id
        : `limit_${indexedKey(row.label, index)}`;
    if (out.some((window) => window.key === key)) return;
    out.push({
      key,
      usedPercent: clamp((row.used / row.limit) * 100),
      resetAtMs: row.resetAtMs ?? null,
      periodHours: row.periodHours ?? null,
      ...(row.label ? { label: row.label } : {}),
    });
  });
  return out;
}

function devinWindows(state: DevinQuotaState): LiveWindow[] {
  return (state.windows ?? [])
    .filter((window) => finite(window.remainingPercent))
    .map((window) => ({
      key: window.id,
      usedPercent: clamp(100 - (window.remainingPercent as number)),
      resetAtMs: window.resetAtMs,
      periodHours: window.periodHours,
    }));
}

function metaWindows(state: MetaQuotaState): LiveWindow[] {
  return (state.data?.windows ?? [])
    .filter((window) => finite(window.usedPercent))
    .map((window) => ({
      key: window.id,
      usedPercent: clamp(window.usedPercent as number),
      resetAtMs: finite(window.resetAt) ? window.resetAt * 1000 : null,
      periodHours:
        window.id === 'weekly'
          ? 168
          : finite(window.durationMinutes) && window.durationMinutes > 0
            ? window.durationMinutes / 60
            : null,
    }));
}

/**
 * The renewing windows and plan of one account's latest successful live read;
 * null while the account has no successful read.
 */
export function liveReadFor(provider: string, quota: unknown): LiveRead | null {
  const state = quota as { status?: string } | undefined;
  if (!state || state.status !== 'success') return null;
  let windows: LiveWindow[];
  let plan: string | null;
  switch (provider) {
    case 'claude': {
      const claude = quota as ClaudeQuotaState;
      windows = percentWindows(claude.windows ?? [], CLAUDE_KEYS);
      plan = claude.planType ?? null;
      break;
    }
    case 'codex': {
      const codex = quota as CodexQuotaState;
      windows = percentWindows(codex.windows ?? [], CODEX_KEYS);
      plan = codex.planType ?? null;
      break;
    }
    case 'antigravity':
    case 'plugin': {
      const groups = quota as AntigravityQuotaState;
      windows = groupWindows(groups);
      plan = groups.subscription?.plan ? stableKey(groups.subscription.plan) : null;
      break;
    }
    case 'xai': {
      const xai = quota as XaiQuotaState;
      windows = xaiWindows(xai);
      plan = xai.billing?.planLabel ? stableKey(xai.billing.planLabel) : null;
      break;
    }
    case 'kimi': {
      const kimi = quota as KimiQuotaState;
      windows = kimiWindows(kimi);
      plan = kimi.planName ? stableKey(kimi.planName) : null;
      break;
    }
    case 'devin': {
      const devin = quota as DevinQuotaState;
      windows = devinWindows(devin);
      plan = devin.plan ? stableKey(devin.plan) : null;
      break;
    }
    case 'meta': {
      const meta = quota as MetaQuotaState;
      windows = metaWindows(meta);
      plan = meta.data?.planName ? stableKey(meta.data.planName) : null;
      break;
    }
    default:
      return null;
  }
  return { windows: windows.filter(isRenewingLiveWindow), plan: plan || null };
}
