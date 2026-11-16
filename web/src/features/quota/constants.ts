import type { QuotaProviderType } from './providers/types';

/** Tab order: the vertical order of the old page's sections; the All tab groups in this order too. */
export const QUOTA_TAB_ORDER: readonly QuotaProviderType[] = [
  'claude',
  'antigravity',
  'codex',
  'xai',
  'kimi',
  'devin',
  'meta',
  'plugin',
];

/**
 * Providers the hub records quota for without a credential file (API-key
 * upstreams): they get a pool and calendar lanes from the history alone.
 */
export const HISTORY_ONLY_PROVIDERS = ['mistral'] as const;
export type HistoryOnlyProvider = (typeof HISTORY_ONLY_PROVIDERS)[number];

export type QuotaTabId = 'all' | QuotaProviderType | HistoryOnlyProvider;

/** Overview views: the pools (charts and accounts) and the resets calendar. */
export const QUOTA_VIEWS = ['pools', 'resets'] as const;
export type QuotaView = (typeof QUOTA_VIEWS)[number];

/** Page size is fixed at 20, which also caps the upstream concurrency of "Refresh all" at 20. */
export const QUOTA_PAGE_SIZE = 20;

/** Sort modes: default is provider group order; soonest puts the earliest recovery first. */
export const QUOTA_SORT_MODES = ['default', 'soonest'] as const;

export type QuotaSortMode = (typeof QUOTA_SORT_MODES)[number];

/** Card layout (Even rows / Stacked / Compact), kept in localStorage across sessions. */
export const QUOTA_CARD_LAYOUT_KEY = 'quotaPage.cardLayout';

/** Column minimums and gaps for the Stacked and Compact layouts; Even rows uses `.grid`. */
export const QUOTA_STACKED_COLUMNS = { minColumnWidth: 340, gap: 16 } as const;
export const QUOTA_COMPACT_COLUMNS = { minColumnWidth: 260, gap: 10 } as const;

/** Matches GROUP_MAX_TOTAL in useRevealGroup: the reveal cascade has a 360ms total budget. */
export const CARD_ENTRANCE_BUDGET_MS = 360;
