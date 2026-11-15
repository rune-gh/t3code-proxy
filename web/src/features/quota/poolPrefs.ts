/**
 * Quota pool preferences persisted in localStorage: plan weights per provider
 * (survive sessions — they describe the user's plans, not a view).
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
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      claude: sanitize(parsed?.claude),
      codex: sanitize(parsed?.codex),
    };
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

/** Human plan label: `max_20x` → `Max 20x`, `pro` → `Pro`. */
export function formatPlanName(plan: string | null): string {
  if (!plan) return '—';
  return plan
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
