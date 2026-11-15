/**
 * Pure helpers behind one Accounts row: status, plan and quota summary.
 * React-free so tests can consume them directly.
 */

import type { AuthFileItem } from '@/types';
import { resolveCodexPlanType } from '@/utils/quota/resolvers';
import { summarizeCooldowns } from './cooldowns';
import { getAuthFileStatusMessage, hasAuthFileStatusWarning } from './constants';

export type AccountStatusKind = 'active' | 'cooling' | 'disabled' | 'error' | 'warning';

export type AccountStatus = {
  kind: AccountStatusKind;
  /** Upstream message or cooldown reason worth showing on hover / expand. */
  reason: string;
  /** Seconds until the earliest account-wide cooldown ends; 0 when not cooling. */
  cooldownSeconds: number;
  /** Models cooling down while the account itself stays usable. */
  coolingModels: number;
};

/**
 * Order of precedence: disabled (owner's choice) > error (unusable) > account-wide
 * cooldown > warning message > active. Model-only cooldowns keep the account active.
 */
export function resolveAccountStatus(file: AuthFileItem, nowMs: number): AccountStatus {
  const message = getAuthFileStatusMessage(file);
  const status = typeof file.status === 'string' ? file.status.trim().toLowerCase() : '';
  const cooldown =
    file.cooldownSnapshot && file.cooldownSnapshot.records
      ? summarizeCooldowns(file.cooldownSnapshot, nowMs)
      : null;
  const base = {
    reason: hasAuthFileStatusWarning(file) ? message : '',
    cooldownSeconds: 0,
    coolingModels: cooldown?.modelCount ?? 0,
  };

  if (file.disabled === true || status === 'disabled') return { ...base, kind: 'disabled' };
  if (file.unavailable === true || status === 'error') return { ...base, kind: 'error' };
  if (cooldown?.credentialWide) {
    return { ...base, kind: 'cooling', cooldownSeconds: cooldown.earliestSeconds };
  }
  if (base.reason) return { ...base, kind: 'warning' };
  return { ...base, kind: 'active' };
}

/** Compact duration for status text: 45s, 12m, 3h. */
export function formatShortDuration(seconds: number): string {
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))}s`;
  if (seconds < 3600) return `${Math.ceil(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.ceil(seconds / 3600)}h`;
  return `${Math.ceil(seconds / 86_400)}d`;
}

/** Human plan label: `max_20x` → `Max 20x`, `plan_pro` → `Pro`. */
export function formatPlanLabel(plan: string | null | undefined): string {
  if (!plan) return '';
  return plan
    .replace(/^plan_/i, '')
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/** Plan from the account file, falling back to what a loaded quota reported. */
export function resolveAccountPlan(file: AuthFileItem, quotaPlan?: string | null): string {
  return formatPlanLabel(resolveCodexPlanType(file) ?? quotaPlan ?? null);
}

type QuotaWindowLike = {
  id: string;
  label: string;
  usedPercent: number | null;
  periodHours?: number | null;
};

export type AccountQuotaSummary = {
  /** Remaining percent (0-100) of the tightest window. */
  remaining: number;
  /** Window length in hours, when known. */
  periodHours: number | null;
  label: string;
};

/** Tightest window of a loaded quota (Claude, Codex and friends share the window shape). */
export function summarizeAccountQuota(
  quota: { status?: string; windows?: QuotaWindowLike[] } | undefined
): AccountQuotaSummary | null {
  if (!quota || quota.status !== 'success' || !Array.isArray(quota.windows)) return null;
  let tightest: AccountQuotaSummary | null = null;
  for (const window of quota.windows) {
    if (typeof window.usedPercent !== 'number' || !Number.isFinite(window.usedPercent)) continue;
    const remaining = Math.max(0, Math.min(100, 100 - window.usedPercent));
    if (!tightest || remaining < tightest.remaining) {
      tightest = { remaining, periodHours: window.periodHours ?? null, label: window.label };
    }
  }
  return tightest;
}
