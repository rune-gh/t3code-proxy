/**
 * Plan weights for the pool cards.
 *
 * - `hub`: the hub serves `GET /routing/plan-weights`. Its effective weights are
 *   the source of truth and edits are saved to `routing.plan-weights` in the
 *   hub config, so every device and the router agree. Weights this browser kept
 *   from before are offered once (`migration`), then forgotten.
 * - `local`: an older hub without the endpoint. Weights stay in this browser,
 *   default 1, exactly as before.
 *
 * Responses from an older request or connection are dropped.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  apiClient,
  planWeightsApi,
  type PlanWeightChange,
  type PlanWeightsSnapshot,
} from '@/services/api';
import type { PlanWeights } from '../poolModel';
import {
  clearPlanWeights,
  pendingPlanWeightMigration,
  readPlanWeights,
  writePlanWeights,
  type PlanWeightsByProvider,
} from '../poolPrefs';

export type PlanWeightsMode = 'loading' | 'hub' | 'local' | 'error';

export interface PlanWeightMigrationItem {
  provider: string;
  plan: string;
  weight: number;
}

interface State {
  mode: PlanWeightsMode;
  snapshot: PlanWeightsSnapshot | null;
  local: PlanWeightsByProvider;
  migration: PlanWeightMigrationItem[];
  error: string;
}

const EMPTY: PlanWeights = {};

export interface PlanWeightsApi extends State {
  /** Weights the pool uses for a provider (plan → weight). */
  effectiveFor: (provider: string) => PlanWeights;
  /** Built-in defaults for a provider; empty in local mode. */
  defaultsFor: (provider: string) => PlanWeights;
  /** Plans the user has overridden. */
  configuredFor: (provider: string) => PlanWeights;
  /** Save edits for one provider: a weight, or null for the default. */
  save: (provider: string, changes: Record<string, number | null>) => Promise<void>;
  /** Move this browser's old weights to the hub, then forget them. */
  applyMigration: () => Promise<void>;
  dismissMigration: () => void;
  refetch: () => Promise<void>;
}

export function usePlanWeights(active: boolean): PlanWeightsApi {
  const [state, setState] = useState<State>({
    mode: 'loading',
    snapshot: null,
    local: {},
    migration: [],
    error: '',
  });
  const requestRef = useRef(0);

  const refetch = useCallback(async () => {
    if (!active) return;
    const requestId = ++requestRef.current;
    const revision = apiClient.getConnectionRevision();
    const isCurrent = () =>
      requestId === requestRef.current && revision === apiClient.getConnectionRevision();
    try {
      const snapshot = await planWeightsApi.get();
      if (!isCurrent()) return;
      const local = readPlanWeights();
      if (!snapshot) {
        setState({ mode: 'local', snapshot: null, local, migration: [], error: '' });
        return;
      }
      const migration = pendingPlanWeightMigration(local, snapshot.effective);
      // Nothing worth offering: stop reading the browser copy for good.
      if (migration.length === 0) clearPlanWeights();
      setState({ mode: 'hub', snapshot, local: {}, migration, error: '' });
    } catch (error: unknown) {
      if (!isCurrent()) return;
      setState((previous) => ({
        ...previous,
        mode: previous.snapshot ? previous.mode : 'error',
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }, [active]);

  useEffect(() => {
    void refetch();
    return () => {
      requestRef.current += 1;
    };
  }, [refetch]);

  const save = useCallback(
    async (provider: string, changes: Record<string, number | null>) => {
      if (state.mode === 'local') {
        const forProvider = { ...(state.local[provider] ?? {}) };
        Object.entries(changes).forEach(([plan, weight]) => {
          if (weight === null || weight === 1) delete forProvider[plan];
          else forProvider[plan] = weight;
        });
        const local = { ...state.local, [provider]: forProvider };
        writePlanWeights(local);
        setState((previous) => ({ ...previous, local }));
        return;
      }
      if (state.mode !== 'hub' || !state.snapshot) return;
      const list: PlanWeightChange[] = Object.entries(changes).map(([plan, weight]) => ({
        provider,
        plan,
        weight,
      }));
      await planWeightsApi.save(state.snapshot, list);
      await refetch();
    },
    [refetch, state.local, state.mode, state.snapshot]
  );

  const applyMigration = useCallback(async () => {
    if (state.mode !== 'hub' || !state.snapshot || state.migration.length === 0) return;
    await planWeightsApi.save(state.snapshot, state.migration);
    clearPlanWeights();
    setState((previous) => ({ ...previous, migration: [] }));
    await refetch();
  }, [refetch, state.migration, state.mode, state.snapshot]);

  const dismissMigration = useCallback(() => {
    clearPlanWeights();
    setState((previous) => ({ ...previous, migration: [] }));
  }, []);

  const helpers = useMemo(
    () => ({
      effectiveFor: (provider: string): PlanWeights =>
        state.mode === 'hub'
          ? (state.snapshot?.effective[provider] ?? EMPTY)
          : state.mode === 'local'
            ? (state.local[provider] ?? EMPTY)
            : EMPTY,
      defaultsFor: (provider: string): PlanWeights => state.snapshot?.defaults[provider] ?? EMPTY,
      configuredFor: (provider: string): PlanWeights =>
        state.mode === 'hub'
          ? (state.snapshot?.configured[provider] ?? EMPTY)
          : (state.local[provider] ?? EMPTY),
    }),
    [state.local, state.mode, state.snapshot]
  );

  return { ...state, ...helpers, save, applyMigration, dismissMigration, refetch };
}
