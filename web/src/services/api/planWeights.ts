/**
 * Server-side plan weights: how much one account on each subscription plan
 * counts toward a provider's pooled capacity. The hub routes with the same
 * numbers, so every device shows the same pooled figures.
 *
 * Contract:
 * - `GET /routing/plan-weights` →
 *   `{ defaults, configured, effective }`, each `{ provider: { plan: weight } }`.
 * - Overrides live in the v8 config at `routing.plan-weights.<provider>.<plan>`:
 *   set with `PATCH /config` (deep merge), cleared with `DELETE /config/<path>`,
 *   the same calls the Routing page uses for its settings.
 *
 * A hub without the endpoint (404/405) resolves to `null`, never throws, so the
 * panel can fall back to per-browser weights.
 */

import type { ApiError } from '@/types';
import { isRecord } from '@/utils/helpers';
import { apiClient } from './client';
import { applyConfigPatch } from './configPatch';

/** Plan → weight. */
export type PlanWeightMap = Record<string, number>;
/** Provider → plan → weight. */
export type ProviderPlanWeights = Record<string, PlanWeightMap>;

export interface PlanWeightsSnapshot {
  defaults: ProviderPlanWeights;
  configured: ProviderPlanWeights;
  effective: ProviderPlanWeights;
}

export const PLAN_WEIGHT_MIN = 0.1;
export const PLAN_WEIGHT_MAX = 1000;

export const isValidPlanWeight = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value >= PLAN_WEIGHT_MIN &&
  value <= PLAN_WEIGHT_MAX;

/** Any weight the hub accepts; the editor's own minimum is stricter. */
const isHubPlanWeight = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= PLAN_WEIGHT_MAX;

const normalizeLayer = (value: unknown): ProviderPlanWeights => {
  const out: ProviderPlanWeights = {};
  if (!isRecord(value)) return out;
  Object.entries(value).forEach(([provider, plans]) => {
    if (!isRecord(plans)) return;
    const key = provider.trim().toLowerCase();
    if (!key) return;
    const map: PlanWeightMap = {};
    Object.entries(plans).forEach(([plan, weight]) => {
      const numeric = typeof weight === 'string' ? Number(weight) : weight;
      if (plan && isHubPlanWeight(numeric)) map[plan] = numeric;
    });
    out[key] = { ...(out[key] ?? {}), ...map };
  });
  return out;
};

export const normalizePlanWeights = (payload: unknown): PlanWeightsSnapshot => {
  const root = isRecord(payload) ? payload : {};
  const defaults = normalizeLayer(root.defaults);
  const configured = normalizeLayer(root.configured);
  const effective = normalizeLayer(root.effective);
  // A hub that only reports defaults and overrides still yields usable effective weights.
  const providers = new Set([
    ...Object.keys(defaults),
    ...Object.keys(configured),
    ...Object.keys(effective),
  ]);
  providers.forEach((provider) => {
    effective[provider] = {
      ...(defaults[provider] ?? {}),
      ...(configured[provider] ?? {}),
      ...(effective[provider] ?? {}),
    };
  });
  return { defaults, configured, effective };
};

/** One plan's change: a weight to store, or null to drop the override (back to default). */
export type PlanWeightChange = { provider: string; plan: string; weight: number | null };

/**
 * The config patch plan for a set of changes. Overrides that equal the default
 * are removed instead of stored, so later default changes still apply.
 */
export function buildPlanWeightsPatch(
  snapshot: PlanWeightsSnapshot,
  changes: readonly PlanWeightChange[]
): { patch: Record<string, unknown>; deletions: string[][] } {
  const set: ProviderPlanWeights = {};
  const deletions: string[][] = [];
  changes.forEach(({ provider, plan, weight }) => {
    const fallback = snapshot.defaults[provider]?.[plan];
    const configured = snapshot.configured[provider]?.[plan];
    const clear = weight === null || (fallback !== undefined && weight === fallback);
    if (clear) {
      if (configured !== undefined) deletions.push(['routing', 'plan-weights', provider, plan]);
      return;
    }
    if (!isValidPlanWeight(weight) || weight === configured) return;
    set[provider] = { ...(set[provider] ?? {}), [plan]: weight };
  });
  const patch = Object.keys(set).length ? { routing: { 'plan-weights': set } } : {};
  return { patch, deletions };
}

const isNotFound = (error: unknown): boolean =>
  (error as ApiError | undefined)?.status === 404 ||
  (error as ApiError | undefined)?.status === 405;

export const planWeightsApi = {
  /** `null` when the hub predates server-side plan weights. */
  async get(): Promise<PlanWeightsSnapshot | null> {
    try {
      return normalizePlanWeights(await apiClient.get<unknown>('/routing/plan-weights'));
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  },

  async save(snapshot: PlanWeightsSnapshot, changes: readonly PlanWeightChange[]): Promise<void> {
    const plan = buildPlanWeightsPatch(snapshot, changes);
    if (!Object.keys(plan.patch).length && !plan.deletions.length) return;
    await applyConfigPatch(plan, apiClient.getConnectionRevision());
  },
};
