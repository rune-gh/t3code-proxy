/**
 * Recorded quota history for the pool cards.
 *
 * Fetches `[min(spanStart, now − lookback), now]`, refetches every 60 s while
 * the page is visible (and on becoming visible again), and drops responses
 * that belong to an older request or connection.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiClient, quotaHistoryApi, type QuotaHistory } from '@/services/api';
import { HOUR_MS } from '../poolModel';

export const QUOTA_HISTORY_POLL_MS = 60_000;
/** Always cover the longest burn window, even when the span starts later. */
const LOOKBACK_MS = 7 * HOUR_MS;

export type QuotaHistoryStatus = 'loading' | 'ready' | 'unavailable' | 'error';

export interface QuotaHistoryState {
  history: QuotaHistory | null;
  status: QuotaHistoryStatus;
  error: string;
}

export function useQuotaHistory(spanStart: number, active: boolean) {
  const [state, setState] = useState<QuotaHistoryState>({
    history: null,
    status: 'loading',
    error: '',
  });
  const requestRef = useRef(0);

  const refetch = useCallback(async () => {
    if (!active) return;
    const requestId = ++requestRef.current;
    const revision = apiClient.getConnectionRevision();
    const isCurrent = () =>
      requestId === requestRef.current && revision === apiClient.getConnectionRevision();
    const now = Date.now();
    try {
      const history = await quotaHistoryApi.get(Math.min(spanStart, now - LOOKBACK_MS), now);
      if (!isCurrent()) return;
      setState({
        history,
        status: history.enabled ? 'ready' : 'unavailable',
        error: '',
      });
    } catch (error: unknown) {
      if (!isCurrent()) return;
      setState((previous) => ({
        history: previous.history,
        status: previous.history ? previous.status : 'error',
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }, [active, spanStart]);

  // Initial load, and again whenever the span moves.
  useEffect(() => {
    void refetch();
  }, [refetch]);

  useEffect(() => {
    if (!active) return;
    const tick = () => {
      if (document.visibilityState === 'visible') void refetch();
    };
    const timer = window.setInterval(tick, QUOTA_HISTORY_POLL_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
      requestRef.current += 1;
    };
  }, [active, refetch]);

  return { ...state, refetch };
}
