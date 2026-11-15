/**
 * Last connectivity-test result per provider row, kept for this browser session only. The hub
 * does not store test results, so the list shows only tests run in this tab.
 */

import { useSyncExternalStore } from 'react';

export interface ConnectivityRecord {
  ok: boolean;
  /** Error text for a failed test; empty on success. */
  message: string;
  at: number;
}

let records: ReadonlyMap<string, ConnectivityRecord> = new Map();
const listeners = new Set<() => void>();

export function recordConnectivity(resourceId: string, record: ConnectivityRecord): void {
  const next = new Map(records);
  next.set(resourceId, record);
  records = next;
  listeners.forEach((listener) => listener());
}

export function clearConnectivityLog(): void {
  records = new Map();
  listeners.forEach((listener) => listener());
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const snapshot = () => records;

export function useConnectivityLog(): ReadonlyMap<string, ConnectivityRecord> {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
