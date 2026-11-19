/**
 * Claude plan ids. The panel reads a profile as `plan_max5`, `plan_pro`, ...
 * (also the i18n keys under `claude_quota`); the hub records the same plans as
 * `max_5x`, `pro`, ... (ParseClaudePlan in internal/quotahistory/parse.go).
 */

const PANEL_TO_HUB_PLAN: Record<string, string> = {
  plan_max20: 'max_20x',
  plan_max5: 'max_5x',
  plan_max: 'max',
  plan_pro: 'pro',
  plan_team: 'team',
  plan_free: 'free',
};

/** A Claude plan id as the hub names it; ids it already uses pass through. */
export const claudeHubPlan = (plan: string | null | undefined): string | null => {
  const key = (plan ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (!key) return null;
  return PANEL_TO_HUB_PLAN[key] ?? key;
};

/**
 * Plans that cannot use Fable without usage credits. Mirrors
 * claudePlanExcludesFable in internal/quotahistory/providers.go.
 */
const PLANS_WITHOUT_FABLE = new Set(['pro', 'free']);

/**
 * Whether a Claude account's plan includes Fable. Anthropic still reports a
 * Fable weekly limit for these plans, but requests for the model are refused,
 * so that limit is not capacity. An unknown plan counts as included.
 */
export const claudePlanIncludesFable = (plan: string | null | undefined): boolean => {
  const hub = claudeHubPlan(plan);
  return hub === null || !PLANS_WITHOUT_FABLE.has(hub);
};
