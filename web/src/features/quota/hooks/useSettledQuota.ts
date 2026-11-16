import { useState } from 'react';

type Settleable = { status: 'idle' | 'loading' | 'success' | 'error' };
type ByType<S> = Record<string, Record<string, S>>;

const isSettled = (state: Settleable | undefined): boolean =>
  state?.status === 'success' || state?.status === 'error';

/**
 * Carry each account's last settled read (success or error) across a re-read.
 * An account that is loading or idle keeps the read it settled on before; one
 * that never settled passes through unchanged.
 */
export function mergeSettledQuota<S extends Settleable, T extends ByType<S>>(prev: T, next: T): T {
  const out: ByType<S> = {};
  Object.keys(next).forEach((type) => {
    const states: Record<string, S> = {};
    Object.entries(next[type]).forEach(([key, state]) => {
      const before = prev[type]?.[key];
      states[key] = !isSettled(state) && isSettled(before) ? before : state;
    });
    out[type] = states;
  });
  return out as T;
}

/**
 * Quota states for deciding what a page shows: a refresh does not blank a card
 * or move a provider between sections while its accounts are being re-read.
 */
export function useSettledQuota<S extends Settleable, T extends ByType<S>>(byType: T): T {
  const [seen, setSeen] = useState(byType);
  const [settled, setSettled] = useState(byType);
  if (seen !== byType) {
    setSeen(byType);
    setSettled(mergeSettledQuota<S, T>(settled, byType));
  }
  return seen === byType ? settled : mergeSettledQuota<S, T>(settled, byType);
}
