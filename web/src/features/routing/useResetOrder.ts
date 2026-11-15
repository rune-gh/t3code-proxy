import { useCallback, useEffect, useRef, useState } from 'react';
import { quotaHistoryApi } from '@/services/api/quotaHistory';
import { getErrorMessage } from '@/utils/helpers';
import { buildResetOrder, type ResetOrderGroup } from './resetOrder';

/** Recorded samples older than this cannot hold the latest weekly reading. */
const LOOKBACK_MS = 6 * 60 * 60 * 1000;

export type ResetOrderData =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; groups: ResetOrderGroup[]; now: number };

/** Loads recorded quota only while soonest-reset-first is selected. */
export function useResetOrder(enabled: boolean): { data: ResetOrderData; reload: () => void } {
  const [data, setData] = useState<ResetOrderData>({ status: 'loading' });
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestRef.current;
    setData({ status: 'loading' });
    try {
      const now = Date.now();
      const history = await quotaHistoryApi.get(now - LOOKBACK_MS, now);
      if (requestId !== requestRef.current) return;
      setData({
        status: 'ready',
        groups: history.enabled ? buildResetOrder(history, history.now) : [],
        now: history.now,
      });
    } catch (err) {
      if (requestId !== requestRef.current) return;
      setData({ status: 'error', message: getErrorMessage(err) });
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void load();
    return () => {
      requestRef.current += 1;
    };
  }, [enabled, load]);

  return { data, reload: () => void load() };
}
