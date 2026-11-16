import { describe, expect, test } from 'bun:test';
import {
  buildPlanWeightsPatch,
  normalizePlanWeights,
  type PlanWeightsSnapshot,
} from '../src/services/api/planWeights';
import { pendingPlanWeightMigration } from '../src/features/quota/poolPrefs';

const snapshot = (): PlanWeightsSnapshot =>
  normalizePlanWeights({
    defaults: { claude: { pro: 1, max_5x: 5, max_20x: 20 }, xai: { supergrok_heavy: 8 } },
    configured: { claude: { max_5x: 6 } },
    effective: { claude: { pro: 1, max_5x: 6, max_20x: 20 }, xai: { supergrok_heavy: 8 } },
  });

describe('plan weights contract', () => {
  test('normalizes the three layers and drops invalid weights', () => {
    const value = normalizePlanWeights({
      defaults: { Claude: { pro: 1, broken: 'x', zero: 0, huge: 5000 } },
      configured: { codex: { pro: '10' } },
      effective: null,
    });
    expect(value.defaults).toEqual({ claude: { pro: 1 } });
    expect(value.configured).toEqual({ codex: { pro: 10 } });
    // Effective is derived when the hub leaves it out.
    expect(value.effective).toEqual({ claude: { pro: 1 }, codex: { pro: 10 } });
  });

  test('non-object payloads read as no weights', () => {
    expect(normalizePlanWeights('nope')).toEqual({ defaults: {}, configured: {}, effective: {} });
  });

  test('sets overrides under routing.plan-weights', () => {
    const plan = buildPlanWeightsPatch(snapshot(), [
      { provider: 'claude', plan: 'max_20x', weight: 18 },
      { provider: 'xai', plan: 'supergrok', weight: 1.5 },
    ]);
    expect(plan).toEqual({
      patch: { routing: { 'plan-weights': { claude: { max_20x: 18 }, xai: { supergrok: 1.5 } } } },
      deletions: [],
    });
  });

  test('a weight equal to the default, or null, deletes the override instead', () => {
    const plan = buildPlanWeightsPatch(snapshot(), [
      { provider: 'claude', plan: 'max_5x', weight: 5 },
      { provider: 'claude', plan: 'pro', weight: null },
    ]);
    expect(plan.patch).toEqual({});
    // `pro` has no override, so nothing to delete for it.
    expect(plan.deletions).toEqual([['routing', 'plan-weights', 'claude', 'max_5x']]);
  });

  test('unchanged and invalid weights are skipped', () => {
    const plan = buildPlanWeightsPatch(snapshot(), [
      { provider: 'claude', plan: 'max_5x', weight: 6 },
      { provider: 'claude', plan: 'max_20x', weight: -1 },
      { provider: 'claude', plan: 'max_20x', weight: Number.NaN },
    ]);
    expect(plan).toEqual({ patch: {}, deletions: [] });
  });
});

describe('browser weight migration', () => {
  test('offers only weights that differ from the hub', () => {
    const items = pendingPlanWeightMigration(
      { claude: { max_20x: 20, max_5x: 4 }, codex: { pro: 2.5 } },
      snapshot().effective
    );
    expect(items).toEqual([
      { provider: 'claude', plan: 'max_5x', weight: 4 },
      { provider: 'codex', plan: 'pro', weight: 2.5 },
    ]);
  });

  test('nothing to offer when the browser agrees with the hub', () => {
    expect(pendingPlanWeightMigration({ claude: { max_5x: 6 } }, snapshot().effective)).toEqual([]);
    expect(pendingPlanWeightMigration({}, snapshot().effective)).toEqual([]);
  });
});

describe('weights below the editor minimum', () => {
  test('are still read from the hub, which accepts any positive weight', () => {
    const snapshot = normalizePlanWeights({
      defaults: { codex: { plus: 1 } },
      configured: { codex: { plus: 0.05 } },
      effective: { codex: { plus: 0.05 } },
    });
    expect(snapshot.effective.codex.plus).toBe(0.05);
    expect(snapshot.configured.codex.plus).toBe(0.05);
  });
});
