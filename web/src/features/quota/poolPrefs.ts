/**
 * Plan weights the panel kept in localStorage before the hub stored them.
 *
 * On a hub that serves `GET /routing/plan-weights` these are only read once,
 * to offer moving them to the hub; after the offer is taken or dismissed the
 * key is removed and never read again. On an older hub without the endpoint
 * they remain the per-browser weights, as before.
 */

import type { PlanWeights, PoolProvider } from './poolModel';

const PLAN_WEIGHTS_KEY = 'quotaPool.planWeights';

export type PlanWeightsByProvider = Partial<Record<PoolProvider, PlanWeights>>;

const sanitize = (value: unknown): PlanWeights => {
  if (!value || typeof value !== 'object') return {};
  const out: PlanWeights = {};
  Object.entries(value as Record<string, unknown>).forEach(([plan, weight]) => {
    if (typeof weight === 'number' && Number.isFinite(weight) && weight > 0 && weight <= 100) {
      out[plan] = weight;
    }
  });
  return out;
};

export function readPlanWeights(): PlanWeightsByProvider {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(PLAN_WEIGHTS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: PlanWeightsByProvider = {};
    Object.entries(parsed as Record<string, unknown>).forEach(([provider, weights]) => {
      const clean = sanitize(weights);
      if (Object.keys(clean).length) out[provider] = clean;
    });
    return out;
  } catch {
    return {};
  }
}

export function writePlanWeights(weights: PlanWeightsByProvider): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(PLAN_WEIGHTS_KEY, JSON.stringify(weights));
  } catch {
    // ignore quota/storage errors
  }
}

/** Forget the browser's weights once they have been offered to the hub. */
export function clearPlanWeights(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(PLAN_WEIGHTS_KEY);
  } catch {
    // ignore storage errors
  }
}

/**
 * The browser weights worth offering to the hub: entries that differ from the
 * hub's effective weight. Empty when there is nothing to migrate.
 */
export function pendingPlanWeightMigration(
  local: PlanWeightsByProvider,
  effective: Record<string, PlanWeights>
): { provider: string; plan: string; weight: number }[] {
  const out: { provider: string; plan: string; weight: number }[] = [];
  Object.entries(local).forEach(([provider, plans]) => {
    Object.entries(plans ?? {}).forEach(([plan, weight]) => {
      const current = effective[provider]?.[plan] ?? 1;
      if (weight !== current) out.push({ provider, plan, weight });
    });
  });
  return out;
}

/** Human plan label: `max_20x` → `Max 20x`, `pro` → `Pro`. */
/**
 * The hub's key for a plan name: lower case, spaces and hyphens as single underscores.
 * "SuperGrok Heavy" and "supergrok_heavy" are the same plan. Mirrors NormalizePlanKey in Go.
 */
export function planKey(plan: string): string {
  return plan
    .trim()
    .toLowerCase()
    .replace(/[\s-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** Plans whose own spelling is not plain title case. */
const PLAN_DISPLAY_NAMES: Record<string, string> = {
  supergrok: 'SuperGrok',
  supergrok_heavy: 'SuperGrok Heavy',
};

export function formatPlanName(plan: string | null): string {
  if (!plan) return '—';
  const known = PLAN_DISPLAY_NAMES[planKey(plan)];
  if (known) return known;
  return plan
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/** `20×`, `2.5×`. */
export const formatWeight = (weight: number): string => `${Number(weight.toFixed(2))}×`;
