/**
 * Overview, in two views over the same data:
 * - Pools: a pooled quota card (chart, stats, per-account table) for every
 *   provider whose windows renew, fed by the hub's recorded history when it
 *   has the provider and by each account's latest live read otherwise. Each
 *   account row opens its full detail (AccountDetail). A provider whose every
 *   account read back without a renewing window (API keys, failed reads) is
 *   listed in a plain accounts table below the pools.
 * - Resets: the calendar of every account window (ResetsView).
 * Providers the hub records without credential files (Mistral) appear from
 * the history alone.
 *
 * Behaviour contracts kept from the previous page:
 * - quota reads run on click (Refresh, Read now, a card's refresh); Devin queries once
 *   when first visible, never polls;
 * - cacheGeneration session isolation and request-id dedupe (see useQuotaBatchLoader);
 * - after the account list changes, quota caches are pruned per provider;
 * - useHeaderRefresh has one slot: this page registers it, and a global refresh reloads accounts.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { authFilesApi, quotaHistoryApi, type QuotaHistory } from '@/services/api';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconEye, IconEyeOff, IconRefreshCw, IconSearch, IconX } from '@/components/ui/icons';
import { PageHeader } from '@/components/ui/PageHeader';
import { Section } from '@/components/ui/Section';
import { SegmentedControl, Tabs } from '@/components/ui/Tabs';
import { Toolbar } from '@/components/ui/Toolbar';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { useNow } from '@/hooks/useNow';
import { useAuthStore, useNotificationStore, useQuotaStore, useThemeStore } from '@/stores';
import type { AuthFileItem, ResolvedTheme } from '@/types';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import { getAuthFileIcon, getTypeLabel } from '@/features/authFiles/constants';
import {
  AccountDetail,
  HistoryAccountDetail,
  type HistoryAccountDetailProps,
} from './components/AccountDetail';
import { OtherAccountsTable } from './components/OtherAccountsTable';
import { PoolAccountsTable } from './components/PoolAccountsTable';
import { ResetsView } from './components/ResetsView';
import { RESETS_FILTER_ALL } from './resetCalendarModel';
import { UseResetDialog, type UseResetTarget } from './components/UseResetDialog';
import { QuotaPoolCard } from './components/QuotaPoolCard';
import { QuotaPoolToolbar, type BurnWindowHours } from './components/QuotaPoolToolbar';
import type { PoolChartMode } from './components/PoolChart';
import {
  LIVE_POOL_PROVIDERS,
  defaultPoolSpan,
  historyFromLiveSnapshots,
  isLivePoolProvider,
  mergeLiveHistory,
  poolProvidersFromHistory,
  poolWindowChoices,
  providerWindowLabels,
  providerWindows,
  resolvePoolWindow,
  shiftPoolSpan,
  type FutureUsage,
  type LiveAccountInput,
  type PoolProvider,
  type PoolSpan,
  type PoolWindowChoice,
} from './poolModel';
import { formatPlanName, formatWeight } from './poolPrefs';
import { liveReadFor, type LiveRead } from './liveWindows';
import { windowColumns, windowLabel } from './poolWindowLabels';
import { formatMoney } from './poolFormat';
import { useQuotaHistory } from './hooks/useQuotaHistory';
import { usePlanWeights } from './hooks/usePlanWeights';
import { useSettledQuota } from './hooks/useSettledQuota';
import { totalBankedCredits, useCodexResetCredits } from './hooks/useCodexResetCredits';
import {
  buildPoolAccountRows,
  isReadingStale,
  latestReadingAt,
  type PoolAccountInput,
  type PoolAccountRow,
} from './accountRows';
import { redeemCodexResetCredit, redeemConsumedCredit } from './providers/codex/resetCredits';
import { startOfDay } from './quotaTimelineModel';
import {
  HISTORY_ONLY_PROVIDERS,
  QUOTA_PAGE_SIZE,
  QUOTA_SORT_MODES,
  QUOTA_TAB_ORDER,
  QUOTA_VIEWS,
  type QuotaSortMode,
  type QuotaTabId,
  type QuotaView,
} from './constants';
import {
  buildTabCounts,
  canRefreshQuotaAfterList,
  classifyQuotaFiles,
  filterEntriesByTab,
  filterEntriesBySearch,
  paginate,
  sortQuotaEntries,
  type QuotaFileEntry,
} from './logic';
import { nextRecoveryMs } from './resetSchedule';
import { QUOTA_ADAPTERS, getQuotaSetter, type QuotaCardState } from './providers';
import {
  codexCreditOverageKey,
  countCodexCreditOverageKeys,
} from './providers/codex/creditOverage';
import type { QuotaProviderType } from './providers/types';
import { useDevinQuotaAutoLoad } from './providers/devin/useDevinQuotaAutoLoad';
import { useQuotaActions } from './hooks/useQuotaActions';
import { useQuotaBatchLoader } from './hooks/useQuotaBatchLoader';
import { readQuotaUiState, readShowEmails, writeQuotaUiState, writeShowEmails } from './uiState';
import styles from './QuotaPage.module.scss';

/** Accounts in the non-pooled section before its search/sort toolbar appears. */
const STOCK_TOOLBAR_MIN = 6;
/** Provider filter order: Claude and Codex first, then the rest as before, then history-only providers. */
const FILTER_ORDER: readonly (QuotaProviderType | (typeof HISTORY_ONLY_PROVIDERS)[number])[] = [
  ...LIVE_POOL_PROVIDERS,
  ...QUOTA_TAB_ORDER.filter((type) => !isLivePoolProvider(type)),
  ...HISTORY_ONLY_PROVIDERS,
];
const isHistoryOnlyProvider = (value: string): boolean =>
  (HISTORY_ONLY_PROVIDERS as readonly string[]).includes(value);

/** Pool cards: Claude and Codex, then the filter order, then providers the panel has no tab for. */
const poolOrder = (provider: string): number => {
  const index = (FILTER_ORDER as readonly string[]).indexOf(provider);
  return index < 0 ? FILTER_ORDER.length : index;
};

/**
 * Existing providers display filenames; Devin's card and timeline share an
 * identity-aware display label. Keep the filename fallback stable for memoization.
 */
const historyAuthIndex = (file: AuthFileItem): string =>
  file.authIndex !== undefined && file.authIndex !== null && String(file.authIndex) !== ''
    ? String(file.authIndex)
    : file.name;

export function QuotaPage() {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage || i18n.language || 'en';
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const resolvedTheme: ResolvedTheme = useThemeStore((state) => state.resolvedTheme);

  const [files, setFiles] = useState<AuthFileItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<QuotaTabId>(() => readQuotaUiState()?.tab ?? 'all');
  const [sortMode, setSortMode] = useState<QuotaSortMode>(
    () => readQuotaUiState()?.sortMode ?? 'default'
  );
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [view, setView] = useState<QuotaView>(() => readQuotaUiState()?.view ?? 'pools');
  const [resetsFilter, setResetsFilter] = useState<string>(
    () => readQuotaUiState()?.resetsFilter ?? RESETS_FILTER_ALL
  );
  const searchInputRef = useRef<HTMLInputElement>(null);
  // Account labels show by default; "Hide emails" blurs them (remembered in this browser).
  const [showEmails, setShowEmails] = useState(readShowEmails);
  const toggleShowEmails = useCallback(() => {
    setShowEmails((value) => {
      writeShowEmails(!value);
      return !value;
    });
  }, []);
  const navigate = useNavigate();
  const showNotification = useNotificationStore((state) => state.showNotification);

  const disableControls = connectionStatus !== 'connected';

  /* ---------- File list ---------- */

  const sessionGeneration = useQuotaStore((state) => state.cacheGeneration);
  const [filesGeneration, setFilesGeneration] = useState<number | null>(null);
  const listRequestRef = useRef(0);
  const loadFiles = useCallback(async () => {
    const requestId = ++listRequestRef.current;
    if (connectionStatus !== 'connected') {
      setFiles([]);
      setFilesGeneration(null);
      setLoading(false);
      return;
    }
    const isCurrent = () =>
      requestId === listRequestRef.current &&
      sessionGeneration === useQuotaStore.getState().cacheGeneration;
    setLoading(true);
    setError('');
    try {
      const data = await authFilesApi.list();
      if (!isCurrent()) return;
      setFiles(data?.files || []);
      setFilesGeneration(sessionGeneration);
    } catch (err: unknown) {
      if (!isCurrent()) return;
      const message = err instanceof Error ? err.message : t('notification.refresh_failed');
      setError(message);
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [connectionStatus, sessionGeneration, t]);

  useHeaderRefresh(loadFiles);

  useEffect(() => {
    void loadFiles();
    return () => {
      listRequestRef.current += 1;
    };
  }, [loadFiles]);

  /* ---------- Quota cache ----------
   * Comes before grouping and sorting: the soonest-reset order reads it for its sort key. */

  const antigravityQuota = useQuotaStore((state) => state.antigravityQuota);
  const claudeQuota = useQuotaStore((state) => state.claudeQuota);
  const codexQuota = useQuotaStore((state) => state.codexQuota);
  const devinQuota = useQuotaStore((state) => state.devinQuota);
  const kimiQuota = useQuotaStore((state) => state.kimiQuota);
  const metaQuota = useQuotaStore((state) => state.metaQuota);
  const pluginQuota = useQuotaStore((state) => state.pluginQuota);
  const xaiQuota = useQuotaStore((state) => state.xaiQuota);

  const quotaByType = useMemo<Record<QuotaProviderType, Record<string, QuotaCardState>>>(
    () =>
      ({
        antigravity: antigravityQuota,
        claude: claudeQuota,
        codex: codexQuota,
        devin: devinQuota,
        kimi: kimiQuota,
        meta: metaQuota,
        plugin: pluginQuota,
        xai: xaiQuota,
      }) as unknown as Record<QuotaProviderType, Record<string, QuotaCardState>>,
    [
      antigravityQuota,
      claudeQuota,
      codexQuota,
      devinQuota,
      kimiQuota,
      metaQuota,
      pluginQuota,
      xaiQuota,
    ]
  );

  const getQuota = useCallback(
    (entry: QuotaFileEntry): QuotaCardState | undefined =>
      quotaByType[entry.type][getQuotaCacheKey(entry.file)],
    [quotaByType]
  );

  /* ---------- Grouping / filtering / sorting / paging ---------- */

  // Subscribe to the minute clock only in soonest-reset order. Ungated in the default
  // order, pageItems would change identity every minute and keep re-running the
  // "refresh all" loading falling-edge effect below for nothing.
  const tick = useNow(sortMode !== 'default');
  const sortNow = sortMode === 'default' ? 0 : tick;

  const entries = useMemo(() => classifyQuotaFiles(files), [files]);
  const tabCounts = useMemo(() => buildTabCounts(entries), [entries]);
  // Account-level settings span every page and tab, so count over all entries.
  const codexCreditOverageCounts = useMemo(
    () =>
      countCodexCreditOverageKeys(
        entries.filter((entry) => entry.type === 'codex').map((entry) => entry.file)
      ),
    [entries]
  );
  const now = useNow();
  // null = follow today (Now a quarter into a 14-day span).
  const [pinnedSpan, setPinnedSpan] = useState<PoolSpan | null>(null);
  const span = pinnedSpan ?? defaultPoolSpan(now);
  const [chartMode, setChartMode] = useState<PoolChartMode>('remaining');
  const [burnWindow, setBurnWindow] = useState<BurnWindowHours>(3);
  const [futureUsage, setFutureUsage] = useState<FutureUsage>('same');
  const [showAccounts, setShowAccounts] = useState(false);
  // Only choices the user made; each card falls back to its provider default.
  const [poolWindows, setPoolWindows] = useState<Record<PoolProvider, PoolWindowChoice>>({});
  const planWeights = usePlanWeights(!disableControls);

  // Also without credential files: the hub may record API-key upstreams (Mistral) only.
  const historyActive = !disableControls && (entries.length > 0 || !loading);
  // Keyed by day so the minute clock doesn't refetch on its own; the hook polls every 60 s.
  const quotaHistory = useQuotaHistory(startOfDay(span.start), historyActive);
  const refetchHistory = quotaHistory.refetch;
  const historyReady = quotaHistory.status === 'ready' && quotaHistory.history !== null;

  // Accounts per provider the hub records without a credential file (Mistral).
  const historyOnlyCounts = useMemo(() => {
    const out: Record<string, number> = {};
    if (!historyReady) return out;
    quotaHistory.history!.accounts.forEach((account) => {
      if (isHistoryOnlyProvider(account.provider) && !account.disabled) {
        out[account.provider] = (out[account.provider] ?? 0) + 1;
      }
    });
    return out;
  }, [historyReady, quotaHistory.history]);
  const providerCount = useCallback(
    (type: string) => (tabCounts as Record<string, number>)[type] ?? historyOnlyCounts[type] ?? 0,
    [historyOnlyCounts, tabCounts]
  );
  const historyOnlyTotal = Object.values(historyOnlyCounts).reduce((sum, n) => sum + n, 0);
  // Only providers with accounts are offered; a remembered filter for an emptied provider falls back.
  const filterTypes = useMemo(
    () => FILTER_ORDER.filter((type) => providerCount(type) > 0),
    [providerCount]
  );
  const activeTab: QuotaTabId = tab === 'all' || filterTypes.includes(tab) ? tab : 'all';
  const tabEntries = useMemo(
    () =>
      isHistoryOnlyProvider(activeTab) ? [] : filterEntriesByTab(entries, activeTab as QuotaTabId),
    [entries, activeTab]
  );
  /* ---------- Quota pools (history + projection) ---------- */

  // A refresh keeps each account's last settled read until the new one arrives, so cards do not
  // blank and providers do not change section while loading.
  const settledQuota = useSettledQuota(quotaByType);
  // Every account's latest live read, as history windows (any provider).
  const liveReads = useMemo(() => {
    const out = new Map<string, LiveRead | null>();
    entries.forEach((entry) => {
      out.set(
        historyAuthIndex(entry.file),
        liveReadFor(entry.type, settledQuota[entry.type][getQuotaCacheKey(entry.file)])
      );
    });
    return out;
  }, [entries, settledQuota]);

  // Without recorded history for a provider, the live reads still give a current point.
  const liveHistory = useMemo<QuotaHistory>(() => {
    const inputs: LiveAccountInput[] = entries.map((entry) => {
      const read = liveReads.get(historyAuthIndex(entry.file)) ?? null;
      return {
        authIndex: historyAuthIndex(entry.file),
        provider: entry.type,
        label: entry.file.email || entry.file.name,
        plan: read?.plan ?? null,
        disabled: Boolean(entry.file.disabled),
        windows: read?.windows.length ? read.windows : null,
      };
    });
    return historyFromLiveSnapshots(inputs, now);
  }, [entries, liveReads, now]);

  const recordedProviders = useMemo(
    () => (historyReady ? poolProvidersFromHistory(quotaHistory.history!) : []),
    [historyReady, quotaHistory.history]
  );
  const poolHistory: QuotaHistory = useMemo(
    () => (historyReady ? mergeLiveHistory(quotaHistory.history!, liveHistory) : liveHistory),
    [historyReady, liveHistory, quotaHistory.history]
  );

  // Every provider pools unless none of its accounts can: each one read back
  // (or failed) without a renewing window and the recorder has nothing for it.
  // Accounts not read yet count as poolable, so a card waits for its first read.
  const pooledProviders = useMemo<PoolProvider[]>(() => {
    const canPool = (entry: QuotaFileEntry) => {
      const status = settledQuota[entry.type][getQuotaCacheKey(entry.file)]?.status;
      if (status !== 'success' && status !== 'error') return true;
      return Boolean(liveReads.get(historyAuthIndex(entry.file))?.windows.length);
    };
    const providers = new Set<PoolProvider>(
      recordedProviders.filter((provider) => activeTab === 'all' || activeTab === provider)
    );
    tabEntries.forEach((entry) => {
      if (!providers.has(entry.type) && canPool(entry)) providers.add(entry.type);
    });
    return [...providers].sort((a, b) => poolOrder(a) - poolOrder(b));
  }, [activeTab, liveReads, recordedProviders, settledQuota, tabEntries]);
  const pooledEntries = useMemo(
    () => tabEntries.filter((entry) => (pooledProviders as string[]).includes(entry.type)),
    [pooledProviders, tabEntries]
  );
  const codexFiles = useMemo(
    () => entries.filter((entry) => entry.type === 'codex').map((entry) => entry.file),
    [entries]
  );
  const codexCredits = useCodexResetCredits(
    codexFiles,
    !disableControls && filesGeneration === sessionGeneration && pooledProviders.includes('codex')
  );
  const refreshCodexCredits = codexCredits.refresh;

  const stockTabEntries = useMemo(
    () => tabEntries.filter((entry) => !(pooledProviders as string[]).includes(entry.type)),
    [pooledProviders, tabEntries]
  );
  const filteredEntries = useMemo(
    () => filterEntriesBySearch(stockTabEntries, search),
    [stockTabEntries, search]
  );
  const handleSearchChange = useCallback((value: string) => {
    setSearch(value);
    setPage(1);
  }, []);

  const resolveNextRecovery = useCallback(
    (entry: QuotaFileEntry) => nextRecoveryMs(entry.type, getQuota(entry), sortNow),
    [getQuota, sortNow]
  );
  // Sort before paging: otherwise soonest-reset would only hold within the current page.
  const sortedEntries = useMemo(
    () => sortQuotaEntries(filteredEntries, sortMode, resolveNextRecovery),
    [filteredEntries, sortMode, resolveNextRecovery]
  );

  const { pageItems, currentPage, totalPages } = useMemo(
    () => paginate(sortedEntries, page, QUOTA_PAGE_SIZE),
    [sortedEntries, page]
  );

  const handleTabChange = useCallback((next: string) => {
    setTab(next as QuotaTabId);
    setPage(1);
    writeQuotaUiState({ tab: next as QuotaTabId });
  }, []);

  const handleSortModeChange = useCallback((next: string) => {
    setSortMode(next as QuotaSortMode);
    setPage(1);
    writeQuotaUiState({ sortMode: next as QuotaSortMode });
  }, []);

  const handleViewChange = useCallback((next: string) => {
    const value = (QUOTA_VIEWS as readonly string[]).includes(next) ? (next as QuotaView) : 'pools';
    setView(value);
    writeQuotaUiState({ view: value });
  }, []);

  const handleResetsFilterChange = useCallback((next: string) => {
    setResetsFilter(next);
    writeQuotaUiState({ resetsFilter: next });
  }, []);

  const sortOptions = useMemo(
    () =>
      QUOTA_SORT_MODES.map((mode) => ({ value: mode, label: t(`quota_management.sort_${mode}`) })),
    [t]
  );

  const showHistoryHint =
    pooledProviders.length > 0 &&
    !historyReady &&
    (quotaHistory.status === 'unavailable' || quotaHistory.status === 'error');

  const handleSaveWeights = useCallback(
    async (provider: PoolProvider, changes: Record<string, number | null>) => {
      await planWeights.save(provider, changes);
      showNotification(t('quota_pool.plan_weights_saved'), 'success');
      void refetchHistory();
    },
    [planWeights, refetchHistory, showNotification, t]
  );

  const [migrating, setMigrating] = useState(false);
  const applyWeightMigration = useCallback(async () => {
    setMigrating(true);
    try {
      await planWeights.applyMigration();
      showNotification(t('quota_pool.migration_done'), 'success');
      void refetchHistory();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t('common.unknown_error');
      showNotification(t('quota_pool.plan_weights_save_failed', { message }), 'error');
    } finally {
      setMigrating(false);
    }
  }, [planWeights, refetchHistory, showNotification, t]);

  const attentionCount = useMemo(
    () =>
      entries.filter(
        (entry) => quotaByType[entry.type][getQuotaCacheKey(entry.file)]?.status === 'error'
      ).length,
    [entries, quotaByType]
  );

  // Prune: once the file list settles, each provider cache keeps only credentials that still exist
  useEffect(() => {
    if (loading || error || filesGeneration !== sessionGeneration) return;
    const survivorsByType = new Map<QuotaProviderType, Set<string>>(
      QUOTA_TAB_ORDER.map((type) => [type, new Set<string>()])
    );
    entries.forEach((entry) => survivorsByType.get(entry.type)?.add(getQuotaCacheKey(entry.file)));

    QUOTA_TAB_ORDER.forEach((type) => {
      const survivors = survivorsByType.get(type) ?? new Set<string>();
      const setQuota = getQuotaSetter(QUOTA_ADAPTERS[type]);
      setQuota((prev) => {
        const staleKeys = Object.keys(prev).filter((name) => !survivors.has(name));
        if (staleKeys.length === 0) return prev;
        const next = { ...prev };
        staleKeys.forEach((name) => delete next[name]);
        return next;
      });
    });
  }, [entries, error, filesGeneration, loading, sessionGeneration]);

  /* ---------- Loading and actions ---------- */

  const { batchLoading, loadQuota } = useQuotaBatchLoader();
  const { resettingQuotaName, refreshQuota, resetQuota } = useQuotaActions(disableControls);

  const pendingRefreshRef = useRef<number | null>(null);
  const prevLoadingRef = useRef(loading);

  // Refresh all: have the hub sample once now, then reload the file list; when it settles
  // (loading falling edge), batch-load the pooled credentials and the current page's quota,
  // and finally reload the history.
  const handleRefreshAll = useCallback(() => {
    if (disableControls) return;
    pendingRefreshRef.current = sessionGeneration;
    void refreshCodexCredits();
    void quotaHistoryApi
      .refresh()
      .catch(() => undefined)
      .then(() => refetchHistory());
    void loadFiles();
  }, [disableControls, loadFiles, refetchHistory, refreshCodexCredits, sessionGeneration]);

  useEffect(() => {
    const wasLoading = prevLoadingRef.current;
    prevLoadingRef.current = loading;

    const requestedSession = pendingRefreshRef.current;
    if (requestedSession === null) return;
    if (requestedSession !== sessionGeneration) {
      pendingRefreshRef.current = null;
      return;
    }
    if (loading || !wasLoading) return;

    pendingRefreshRef.current = null;
    if (
      canRefreshQuotaAfterList(
        requestedSession,
        sessionGeneration,
        filesGeneration,
        Boolean(error),
        disableControls
      )
    ) {
      void loadQuota([...pooledEntries, ...pageItems]).then(() => refetchHistory());
    }
  }, [
    disableControls,
    error,
    filesGeneration,
    loading,
    loadQuota,
    pageItems,
    pooledEntries,
    refetchHistory,
    sessionGeneration,
  ]);

  const devinVisible = useMemo(
    () => [...pooledEntries, ...pageItems].filter((entry) => entry.type === 'devin'),
    [pageItems, pooledEntries]
  );
  useDevinQuotaAutoLoad(
    devinVisible,
    disableControls ||
      loading ||
      batchLoading ||
      Boolean(error) ||
      filesGeneration !== sessionGeneration,
    loadQuota
  );

  const canUseActions = !disableControls && !loading && filesGeneration === sessionGeneration;

  /* ---------- Per-account rows and Codex banked resets ---------- */

  const effectiveWeightsFor = planWeights.effectiveFor;
  const rowsByProvider = useMemo(() => {
    const out: Record<PoolProvider, PoolAccountRow[]> = {};
    pooledProviders.forEach((provider) => {
      const providerEntries = entries.filter((entry) => entry.type === provider);
      // Accounts the panel lists as credentials; a provider only the history knows uses its accounts.
      const inputs: PoolAccountInput[] = providerEntries.length
        ? providerEntries.map((entry) => {
            const quota = quotaByType[entry.type][getQuotaCacheKey(entry.file)] as
              QuotaCardState | undefined;
            return {
              authIndex: historyAuthIndex(entry.file),
              label: entry.file.email || entry.file.name,
              plan: liveReads.get(historyAuthIndex(entry.file))?.plan ?? null,
              disabled: Boolean(entry.file.disabled),
              liveError:
                quota?.status === 'error' ? ((quota as { error?: string }).error ?? '') : '',
            };
          })
        : poolHistory.accounts
            .filter((account) => account.provider === provider)
            .map((account) => ({
              authIndex: account.authIndex,
              label: account.label || account.authIndex,
              plan: account.plan,
              disabled: account.disabled,
            }));
      const windows = isLivePoolProvider(provider) ? [] : providerWindows(poolHistory, provider);
      out[provider] = buildPoolAccountRows(poolHistory, provider, inputs, now, {
        // Columns read shortest first, like 5-hour before weekly.
        windowKeys: [...windows].reverse().map((window) => window.key),
        primary: windows[0]?.key ?? null,
        weights: effectiveWeightsFor(provider),
      });
    });
    return out;
  }, [effectiveWeightsFor, entries, liveReads, now, poolHistory, pooledProviders, quotaByType]);

  const [resetTarget, setResetTarget] = useState<UseResetTarget | null>(null);
  const [redeeming, setRedeeming] = useState<string | null>(null);

  const openUseReset = useCallback(
    (row: Pick<PoolAccountRow, 'authIndex' | 'label' | 'disabled'>) => {
      const entry = codexCredits.byAccount[row.authIndex];
      const credit = entry?.status === 'ready' ? entry.credits[0] : undefined;
      if (!credit || row.disabled) return;
      setResetTarget({
        authIndex: row.authIndex,
        label: row.label,
        credit,
        available: entry!.credits.length,
      });
    },
    [codexCredits.byAccount]
  );

  const confirmUseReset = useCallback(
    async (target: UseResetTarget): Promise<string | null> => {
      const file = codexFiles.find((candidate) => historyAuthIndex(candidate) === target.authIndex);
      if (!file) return t('quota_accounts.outcome_missing');
      setRedeeming(target.authIndex);
      try {
        const result = await redeemCodexResetCredit(file, target.credit.id);
        void refreshCodexCredits(file);
        if (!redeemConsumedCredit(result.outcome)) {
          return t(`quota_accounts.outcome_${result.outcome}`);
        }
        showNotification(t(`quota_accounts.outcome_${result.outcome}`), 'success');
        if (!result.cooldownCleared) {
          showNotification(t('quota_accounts.outcome_cooldown_failed'), 'warning');
        }
        void loadQuota([{ type: 'codex', file }]);
        void quotaHistoryApi
          .refresh()
          .catch(() => undefined)
          .then(() => refetchHistory());
        return null;
      } catch (err: unknown) {
        void refreshCodexCredits(file);
        const message = err instanceof Error ? err.message : t('common.unknown_error');
        return t('quota_accounts.outcome_failed', { message });
      } finally {
        setRedeeming(null);
      }
    },
    [codexFiles, loadQuota, refetchHistory, refreshCodexCredits, showNotification, t]
  );

  /* ---------- Render ---------- */

  const entryKey = (entry: QuotaFileEntry) => `${entry.type}:${getQuotaCacheKey(entry.file)}`;
  const renderAccountDetail = (entry: QuotaFileEntry, recorded?: HistoryAccountDetailProps) => (
    <AccountDetail
      entry={entry}
      recorded={recorded}
      quota={getQuota(entry)}
      canRefresh={canUseActions && !entry.file.disabled}
      resetting={resettingQuotaName === getQuotaCacheKey(entry.file)}
      creditOverageSharedCount={
        entry.type === 'codex'
          ? codexCreditOverageCounts.get(codexCreditOverageKey(entry.file) ?? '')
          : undefined
      }
      onRefresh={() => void refreshQuota(entry.file, QUOTA_ADAPTERS[entry.type])}
      onReset={() => resetQuota(entry.file, QUOTA_ADAPTERS[entry.type])}
    />
  );

  /** A pool row's detail: the live read of a credential once taken, else the recorded windows. */
  const renderPoolDetail = (
    provider: PoolProvider,
    row: PoolAccountRow,
    windowKeys: readonly { key: string; label: string }[]
  ) => {
    const entry = entries.find(
      (candidate) =>
        candidate.type === provider && historyAuthIndex(candidate.file) === row.authIndex
    );
    const recorded: HistoryAccountDetailProps = {
      windows: windowKeys.map(({ key, label }) => ({
        key,
        label,
        reading: row.windows[key] ?? null,
      })),
      lastReadAt: row.lastReadAt,
      error: row.error,
      now,
      locale,
    };
    // A credential shows what the hub recorded until a live read is taken.
    if (entry) return renderAccountDetail(entry, recorded);
    return <HistoryAccountDetail {...recorded} />;
  };

  const providerSummary = filterTypes
    .map((type) => `${providerCount(type)} ${getTypeLabel(t, type)}`)
    .join(', ');
  const accountTotal = entries.length + historyOnlyTotal;
  const description =
    accountTotal === 0
      ? loading
        ? t('quota_overview.summary_loading')
        : t('quota_overview.summary_none')
      : [
          t('quota_overview.summary', { count: accountTotal, providers: providerSummary }),
          attentionCount > 0
            ? t('quota_overview.summary_attention', { count: attentionCount })
            : '',
        ]
          .filter(Boolean)
          .join(' · ');

  const filterItems = [
    { value: 'all' as QuotaTabId, label: t('quota_overview.filter_all'), count: accountTotal },
    ...filterTypes.map((type) => {
      const icon = getAuthFileIcon(type, resolvedTheme);
      return {
        value: type as QuotaTabId,
        label: getTypeLabel(t, type),
        count: providerCount(type),
        icon: icon ? <img src={icon} alt="" className={styles.tabIcon} /> : undefined,
      };
    }),
  ];

  const firstLoad = loading && entries.length === 0;
  const noAccounts = !loading && !error && accountTotal === 0;
  const isSearchEmpty = !loading && stockTabEntries.length > 0 && filteredEntries.length === 0;
  const showViews = pooledProviders.length > 0;
  // Accounts without a renewing window have nothing on the calendar; they list under the pools.
  const showStockSection = stockTabEntries.length > 0 && (view === 'pools' || !showViews);
  // The current page's accounts, grouped by provider in the page's sort order.
  const stockGroups = pageItems.reduce<{ provider: QuotaProviderType; items: QuotaFileEntry[] }[]>(
    (groups, entry) => {
      const group = groups.find((candidate) => candidate.provider === entry.type);
      if (group) group.items.push(entry);
      else groups.push({ provider: entry.type, items: [entry] });
      return groups;
    },
    []
  );
  // Search and sort only earn their space once there are several accounts to sift.
  const showStockToolbar = stockTabEntries.length > STOCK_TOOLBAR_MIN || search !== '';
  const poolLoading = quotaHistory.status === 'loading' && !historyReady;
  const historyIntervalSeconds = poolHistory.intervalSeconds;

  const shiftSpan = (direction: -1 | 1) => setPinnedSpan(shiftPoolSpan(span, direction));
  const viewSwitch = showViews ? (
    <SegmentedControl
      ariaLabel={t('quota_overview.view_label')}
      size="sm"
      items={[
        { value: 'pools' as QuotaView, label: t('quota_overview.view_pools') },
        { value: 'resets' as QuotaView, label: t('quota_overview.view_resets') },
      ]}
      value={view}
      onChange={handleViewChange}
    />
  ) : null;
  const providerTabs =
    filterTypes.length > 1 ? (
      <Tabs
        ariaLabel={t('quota_overview.filter_label')}
        items={filterItems}
        value={activeTab}
        onChange={handleTabChange}
      />
    ) : null;

  /** Money spent in the pool's window, for windows with a budget ("$0.39 of $15 spent"). */
  const budgetHint = (rows: readonly PoolAccountRow[], key: string): string | undefined => {
    let spent = 0;
    let budget = 0;
    let currency: string | null = null;
    for (const row of rows) {
      const reading = row.disabled ? null : row.windows[key];
      if (!reading?.budget) continue;
      if (currency !== null && currency !== reading.budget.currency) return undefined;
      currency = reading.budget.currency;
      budget += reading.budget.amount;
      spent += (reading.budget.amount * (100 - reading.remaining)) / 100;
    }
    if (currency === null) return undefined;
    return t('quota_accounts.money_spent', {
      spent: formatMoney(spent, currency, locale),
      budget: formatMoney(budget, currency, locale),
    });
  };

  return (
    <div className={`${styles.page} ${showEmails ? '' : styles.hideEmails}`}>
      <PageHeader
        title={t('quota_overview.title')}
        description={description}
        actions={
          <>
            <Button variant="ghost" size="sm" aria-pressed={!showEmails} onClick={toggleShowEmails}>
              <span className={styles.buttonInner}>
                {showEmails ? (
                  <IconEyeOff size={16} aria-hidden="true" />
                ) : (
                  <IconEye size={16} aria-hidden="true" />
                )}
                {showEmails ? t('quota_management.hide_emails') : t('quota_management.show_emails')}
              </span>
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={handleRefreshAll}
              disabled={disableControls}
              loading={loading || batchLoading}
            >
              <span className={styles.buttonInner}>
                {!(loading || batchLoading) && <IconRefreshCw size={16} aria-hidden="true" />}
                {t('quota_overview.refresh')}
              </span>
            </Button>
          </>
        }
        tabs={
          providerTabs || viewSwitch ? (
            <div className={styles.tabsRow}>
              <div className={styles.providerTabs}>{providerTabs}</div>
              {viewSwitch && <div className={styles.viewSwitch}>{viewSwitch}</div>}
            </div>
          ) : undefined
        }
      />

      {error && (
        <div className="error-box" role="alert">
          {t('quota_overview.list_failed', { message: error })}
        </div>
      )}

      {firstLoad && (
        <div className={styles.skeletons} aria-busy="true">
          <span className="sr-only">{t('quota_overview.loading')}</span>
          <Skeleton height={32} width={320} rounded={6} />
          <Skeleton height={360} rounded={8} />
          <Skeleton height={180} rounded={8} />
        </div>
      )}

      {noAccounts && (
        <EmptyState
          title={t('quota_overview.empty_title')}
          description={t('quota_overview.empty_desc')}
          action={
            <Button variant="secondary" size="sm" onClick={() => navigate('/oauth')}>
              {t('quota_overview.add_account')}
            </Button>
          }
        />
      )}

      {showViews && showHistoryHint && (
        <p className={styles.historyHint}>
          {quotaHistory.status === 'error' ? (
            t('quota_pool.history_error', { message: quotaHistory.error })
          ) : (
            <Trans i18nKey="quota_pool.history_hint" components={{ code: <code /> }} />
          )}
        </p>
      )}

      {showViews && view === 'resets' && (
        <ResetsView
          history={poolHistory}
          providers={pooledProviders}
          now={now}
          spanStart={span.start}
          spanEnd={span.end}
          isToday={pinnedSpan === null}
          onShift={shiftSpan}
          onToday={() => setPinnedSpan(null)}
          filter={resetsFilter}
          onFilterChange={handleResetsFilterChange}
          resolvedTheme={resolvedTheme}
          locale={locale}
          loading={poolLoading}
          credits={codexCredits.byAccount}
          redeeming={redeeming}
          onUseReset={canUseActions ? openUseReset : undefined}
        />
      )}

      {showViews && view === 'pools' && (
        <>
          <QuotaPoolToolbar
            mode={chartMode}
            onModeChange={setChartMode}
            burnWindow={burnWindow}
            onBurnWindowChange={setBurnWindow}
            futureUsage={futureUsage}
            onFutureUsageChange={setFutureUsage}
            showAccounts={showAccounts}
            onShowAccountsChange={setShowAccounts}
            spanStart={span.start}
            spanEnd={span.end}
            isToday={pinnedSpan === null}
            onShift={shiftSpan}
            onToday={() => setPinnedSpan(null)}
            locale={locale}
          />

          {planWeights.migration.length > 0 && (
            <div
              className={styles.migration}
              role="region"
              aria-label={t('quota_pool.migration_label')}
            >
              <p className={styles.migrationText}>
                {t('quota_pool.migration_body', {
                  weights: planWeights.migration
                    .map(
                      (item) =>
                        `${getTypeLabel(t, item.provider)} ${formatPlanName(item.plan)} = ${formatWeight(item.weight)}`
                    )
                    .join(', '),
                })}
              </p>
              <div className={styles.migrationActions}>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={migrating}
                  onClick={planWeights.dismissMigration}
                >
                  {t('quota_pool.migration_dismiss')}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  loading={migrating}
                  onClick={() => void applyWeightMigration()}
                >
                  {t('quota_pool.migration_apply')}
                </Button>
              </div>
            </div>
          )}

          {pooledProviders.map((provider) => {
            const providerEntries = pooledEntries.filter((entry) => entry.type === provider);
            const rows = rowsByProvider[provider] ?? [];
            const lastReadAt = historyReady ? latestReadingAt(rows) : null;
            const windowChoice = resolvePoolWindow(provider, poolHistory, poolWindows[provider]);
            const windows = isLivePoolProvider(provider)
              ? []
              : providerWindows(poolHistory, provider);
            const providerLabel = getTypeLabel(t, provider);
            const windowLabels = providerWindowLabels(windows);
            const columns = isLivePoolProvider(provider)
              ? undefined
              : windowColumns(t, windows, windowLabels);
            const detailWindows = columns ?? [
              { key: 'five_hour', label: t('quota_accounts.col_five_hour') },
              { key: 'seven_day', label: t('quota_accounts.col_weekly') },
              ...(provider === 'claude'
                ? [{ key: 'seven_day_fable', label: t('quota_accounts.col_scoped_weekly') }]
                : []),
            ];
            return (
              <QuotaPoolCard
                key={provider}
                provider={provider}
                history={poolHistory}
                window={windowChoice ?? ''}
                windowChoices={poolWindowChoices(provider, poolHistory)}
                windowLabels={windowLabels}
                onWindowChange={(choice) =>
                  setPoolWindows((previous) => ({ ...previous, [provider]: choice }))
                }
                weights={planWeights.effectiveFor(provider)}
                defaultWeights={planWeights.defaultsFor(provider)}
                configuredWeights={planWeights.configuredFor(provider)}
                weightsMode={planWeights.mode}
                weightsError={planWeights.error}
                onSaveWeights={(changes) => handleSaveWeights(provider, changes)}
                mode={chartMode}
                showAccounts={showAccounts}
                spanStart={span.start}
                spanEnd={span.end}
                now={now}
                burnWindowHours={burnWindow}
                futureUsage={futureUsage}
                resolvedTheme={resolvedTheme}
                locale={locale}
                accountCount={providerEntries.length || rows.length}
                loading={poolLoading}
                lastReadAt={lastReadAt}
                stale={isReadingStale(lastReadAt, now, historyIntervalSeconds)}
                headlineHint={windowChoice ? budgetHint(rows, windowChoice) : undefined}
                bankedResets={
                  provider === 'codex'
                    ? totalBankedCredits(
                        codexCredits.byAccount,
                        rows.filter((row) => !row.disabled).map((row) => row.authIndex)
                      )
                    : undefined
                }
                table={
                  poolLoading ? (
                    <Skeleton height={44 + 41 * Math.min(rows.length, 6)} rounded={8} />
                  ) : (
                    <PoolAccountsTable
                      provider={provider}
                      providerLabel={providerLabel}
                      rows={rows}
                      windowColumns={columns}
                      primaryLabel={
                        windows[0] ? windowLabel(t, windows[0].key, windowLabels) : undefined
                      }
                      now={now}
                      locale={locale}
                      credits={provider === 'codex' ? codexCredits.byAccount : undefined}
                      redeeming={redeeming}
                      onUseReset={provider === 'codex' && canUseActions ? openUseReset : undefined}
                      renderDetail={(row) => renderPoolDetail(provider, row, detailWindows)}
                    />
                  )
                }
                onReadNow={
                  // Only a live-fed card fills from a live read; a recorded one waits for the recorder.
                  canUseActions &&
                  providerEntries.length > 0 &&
                  !recordedProviders.includes(provider)
                    ? () => void loadQuota(providerEntries).then(() => refetchHistory())
                    : undefined
                }
                reading={batchLoading}
              />
            );
          })}
        </>
      )}

      {showStockSection && (
        <div className={styles.stockArea}>
          {showStockToolbar && (
            <Toolbar
              ariaLabel={t('quota_overview.other_toolbar')}
              end={
                <div className={styles.sort}>
                  <Select
                    value={sortMode}
                    options={sortOptions}
                    onChange={handleSortModeChange}
                    ariaLabel={t('quota_management.sort_label')}
                    size="sm"
                  />
                </div>
              }
            >
              <div className={styles.search}>
                <IconSearch size={16} className={styles.searchIcon} aria-hidden="true" />
                <input
                  ref={searchInputRef}
                  className={styles.searchInput}
                  type="search"
                  value={search}
                  onChange={(event) => handleSearchChange(event.target.value)}
                  placeholder={t('quota_management.search_placeholder')}
                  aria-label={t('quota_management.search_label')}
                />
                {search && (
                  <button
                    type="button"
                    className={styles.clearSearch}
                    aria-label={t('quota_management.search_clear')}
                    title={t('quota_management.search_clear')}
                    onClick={() => {
                      handleSearchChange('');
                      searchInputRef.current?.focus();
                    }}
                  >
                    <IconX size={14} aria-hidden="true" />
                  </button>
                )}
              </div>
            </Toolbar>
          )}

          {loading ? (
            <Skeleton height={44 + 41 * Math.min(stockTabEntries.length, 4)} rounded={8} />
          ) : isSearchEmpty ? (
            <EmptyState
              title={t('quota_management.search_empty_title')}
              description={t('quota_management.search_empty_desc')}
              action={
                <Button variant="secondary" size="sm" onClick={() => handleSearchChange('')}>
                  {t('quota_management.search_clear')}
                </Button>
              }
            />
          ) : (
            // One section per provider, headed like the pool cards: an accounts table whose
            // rows open the same detail as the pool tables.
            stockGroups.map(({ provider, items }) => {
              const icon = getAuthFileIcon(provider, resolvedTheme);
              return (
                <Section
                  key={provider}
                  title={
                    <span className={styles.stockTitle}>
                      {icon && <img src={icon} alt="" className={styles.stockIcon} />}
                      {getTypeLabel(t, provider)}
                    </span>
                  }
                  description={
                    <span className={styles.stockMeta}>
                      <span>
                        {t('quota_pool.accounts_count', {
                          count: stockTabEntries.filter((entry) => entry.type === provider).length,
                        })}
                      </span>
                      <span>{t('quota_overview.other_desc')}</span>
                    </span>
                  }
                >
                  <OtherAccountsTable
                    providerLabel={getTypeLabel(t, provider)}
                    rows={items.map((entry) => ({
                      key: entryKey(entry),
                      label: entry.file.email || entry.file.name,
                      status: getQuota(entry)?.status ?? 'idle',
                      disabled: Boolean(entry.file.disabled),
                    }))}
                    renderDetail={(key) => {
                      const entry = items.find((candidate) => entryKey(candidate) === key);
                      return entry ? renderAccountDetail(entry) : null;
                    }}
                  />
                </Section>
              );
            })
          )}

          {!loading && filteredEntries.length > QUOTA_PAGE_SIZE && (
            <div className={styles.pagination}>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setPage(Math.max(1, currentPage - 1))}
                disabled={currentPage <= 1}
              >
                {t('auth_files.pagination_prev')}
              </Button>
              <div className={styles.pageInfo}>
                {t('auth_files.pagination_info', {
                  current: currentPage,
                  total: totalPages,
                  count: filteredEntries.length,
                })}
              </div>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setPage(Math.min(totalPages, currentPage + 1))}
                disabled={currentPage >= totalPages}
              >
                {t('auth_files.pagination_next')}
              </Button>
            </div>
          )}
        </div>
      )}

      <UseResetDialog
        target={resetTarget}
        now={now}
        locale={locale}
        showLabel={showEmails}
        onClose={() => setResetTarget(null)}
        onConfirm={confirmUseReset}
      />
    </div>
  );
}
