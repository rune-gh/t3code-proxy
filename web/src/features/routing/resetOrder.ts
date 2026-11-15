/**
 * The order soonest-reset-first would choose accounts in, read from recorded quota history.
 *
 * Mirrors the hub's selector (sdk/cliproxy/auth/selector_reset.go) as far as the panel can see:
 * accounts without a recent weekly observation are probed first, then accounts by weekly reset
 * time, earliest first; accounts with ties share a rank and rotate. Accounts whose weekly
 * allowance is spent are listed last because they wait for their reset. Priority tiers, model
 * scoped caps and cooldowns are not visible here.
 */

import type { QuotaHistory } from '@/services/api/quotaHistory';

/** Providers whose weekly windows the selector reads. */
export const RESET_ORDER_PROVIDERS = ['claude', 'codex'] as const;
export type ResetOrderProvider = (typeof RESET_ORDER_PROVIDERS)[number];

/** The selector re-probes an account without a usable reset at most this often. */
export const PROBE_INTERVAL_MS = 60 * 60 * 1000;

const WEEKLY_WINDOW = 'seven_day';

export type ResetOrderState = 'probe' | 'ranked' | 'spent';

export interface ResetOrderEntry {
  authIndex: string;
  label: string;
  plan: string | null;
  state: ResetOrderState;
  /** 1-based; entries that tie share a rank. Null for spent accounts. */
  rank: number | null;
  resetsAt: number | null;
  usedPercent: number | null;
}

export interface ResetOrderGroup {
  provider: ResetOrderProvider;
  entries: ResetOrderEntry[];
}

export function buildResetOrder(history: QuotaHistory, now: number): ResetOrderGroup[] {
  const latest = new Map<string, { t: number; resetsAt: number | null; used: number | null }>();
  for (const sample of history.samples) {
    const weekly = sample.windows[WEEKLY_WINDOW];
    if (!weekly) continue;
    const previous = latest.get(sample.authIndex);
    if (previous && previous.t > sample.t) continue;
    latest.set(sample.authIndex, {
      t: sample.t,
      resetsAt: weekly.resetsAt,
      used: weekly.usedPercent,
    });
  }

  return RESET_ORDER_PROVIDERS.flatMap((provider) => {
    const entries: ResetOrderEntry[] = history.accounts
      .filter((account) => account.provider === provider && !account.disabled)
      .map((account) => {
        const reading = latest.get(account.authIndex);
        const resetsAt =
          reading && reading.resetsAt !== null && reading.resetsAt > now ? reading.resetsAt : null;
        let state: ResetOrderState = 'ranked';
        if (resetsAt === null) state = 'probe';
        else if ((reading?.used ?? 0) >= 100) state = 'spent';
        return {
          authIndex: account.authIndex,
          label: account.label || account.authIndex,
          plan: account.plan,
          state,
          rank: null,
          resetsAt,
          usedPercent: reading?.used ?? null,
        };
      });
    if (entries.length === 0) return [];

    const byLabel = (a: ResetOrderEntry, b: ResetOrderEntry) => a.label.localeCompare(b.label);
    const probes = entries.filter((entry) => entry.state === 'probe').sort(byLabel);
    const ranked = entries
      .filter((entry) => entry.state === 'ranked')
      .sort((a, b) => (a.resetsAt ?? 0) - (b.resetsAt ?? 0) || byLabel(a, b));
    const spent = entries
      .filter((entry) => entry.state === 'spent')
      .sort((a, b) => (a.resetsAt ?? 0) - (b.resetsAt ?? 0) || byLabel(a, b));

    // Probes share the first rank; ranked accounts tie only on the exact same reset.
    let rank = 0;
    if (probes.length) {
      rank = 1;
      probes.forEach((entry) => (entry.rank = 1));
    }
    let lastReset: number | null = null;
    for (const entry of ranked) {
      if (entry.resetsAt !== lastReset) rank += 1;
      entry.rank = rank;
      lastReset = entry.resetsAt;
    }
    return [{ provider, entries: [...probes, ...ranked, ...spent] }];
  });
}
