/**
 * Overview: pooled Claude and Codex quota (chart, stats, per-account table),
 * then cards for the other providers.
 *
 * Behaviour contracts kept from the previous page:
 * - stock providers load on click; Devin queries once when first visible, never polls;
 * - cacheGeneration session isolation and request-id dedupe (see useQuotaBatchLoader);
 * - after the account list changes, quota caches are pruned per provider;
 * - useHeaderRefresh has one slot: this page registers it, and a global refresh reloads accounts.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { authFilesApi, quotaHistoryApi, type QuotaHistory } from '@/services/api';
import { Button } from '@/components/ui/Button';
import { CardLayoutSwitch } from '@/components/ui/CardLayoutSwitch';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconEye, IconEyeOff, IconRefreshCw, IconSearch, IconX } from '@/components/ui/icons';
import { PageHeader } from '@/components/ui/PageHeader';
import { Section } from '@/components/ui/Section';
import { Tabs } from '@/components/ui/Tabs';
import { Toolbar } from '@/components/ui/Toolbar';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { StackedColumns } from '@/components/ui/StackedColumns';
import { readCardLayout, writeCardLayout, type CardLayout } from '@/components/ui/cardLayout';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { useNow } from '@/hooks/useNow';
import { useAuthStore, useNotificationStore, useQuotaStore, useThemeStore } from '@/stores';
import type { AuthFileItem, ClaudeQuotaState, CodexQuotaState, ResolvedTheme } from '@/types';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import { getAuthFileIcon, getTypeLabel } from '@/features/authFiles/constants';
import { QuotaCard } from './components/QuotaCard';
import { PoolAccountsTable } from './components/PoolAccountsTable';
import { UseResetDialog, type UseResetTarget } from './components/UseResetDialog';
import { QuotaTimeline } from './components/QuotaTimeline';
import { QuotaPoolCard } from './components/QuotaPoolCard';
import { QuotaPoolToolbar, type BurnWindowHours } from './components/QuotaPoolToolbar';
import type { PoolChartMode } from './components/PoolChart';
import {
  POOL_PROVIDERS,
  defaultPoolSpan,
  defaultPoolWindow,
  historyFromLiveSnapshots,
  shiftPoolSpan,
  type FutureUsage,
  type LiveAccountInput,
  type PoolProvider,
  type PoolSpan,
  type PoolWindowChoice,
} from './poolModel';
import { readPlanWeights, writePlanWeights, type PlanWeightsByProvider } from './poolPrefs';
import { useQuotaHistory } from './hooks/useQuotaHistory';
import { totalBankedCredits, useCodexResetCredits } from './hooks/useCodexResetCredits';
import {
  buildPoolAccountRows,
  isReadingStale,
  latestReadingAt,
  type PoolAccountRow,
} from './accountRows';
import { redeemCodexResetCredit, redeemConsumedCredit } from './providers/codex/resetCredits';
import { startOfDay } from './quotaTimelineModel';
import {
  QUOTA_CARD_LAYOUT_KEY,
  QUOTA_COMPACT_COLUMNS,
  QUOTA_PAGE_SIZE,
  QUOTA_STACKED_COLUMNS,
  QUOTA_SORT_MODES,
  QUOTA_TAB_ORDER,
  type QuotaSortMode,
  type QuotaTabId,
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
import { readQuotaUiState, writeQuotaUiState } from './uiState';
import styles from './QuotaPage.module.scss';

const SKELETON_CARD_COUNT = 3;
/** Provider filter order: the pooled providers first, then the rest as before. */
const FILTER_ORDER: readonly QuotaProviderType[] = [
  ...POOL_PROVIDERS,
  ...QUOTA_TAB_ORDER.filter((type) => !(POOL_PROVIDERS as readonly string[]).includes(type)),
];

/**
 * Existing providers display filenames; Devin's card and timeline share an
 * identity-aware display label. Keep the filename fallback stable for memoization.
 */
const displayNameFor = (name: string) => name;

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
  const [layout, setLayout] = useState<CardLayout>(() => readCardLayout(QUOTA_CARD_LAYOUT_KEY));
  // Compact cards the user opened to full size; not persisted.
  const [expandedCards, setExpandedCards] = useState<ReadonlySet<string>>(() => new Set());
  const searchInputRef = useRef<HTMLInputElement>(null);
  // Account labels stay blurred on this page until the user asks to see them.
  const [showEmails, setShowEmails] = useState(false);
  const navigate = useNavigate();
  const showNotification = useNotificationStore((state) => state.showNotification);

  const disableControls = connectionStatus !== 'connected';

  /* ---------- 文件列表 ---------- */

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

  /* ---------- 额度缓存 ----------
   * 排在归类/排序之前：「最快恢复优先」要读它算排序键。 */

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

  /* ---------- 归类 / 过滤 / 排序 / 分页 ---------- */

  // 只在「最快恢复优先」下订阅分钟时钟。默认序下不门控的话，pageItems 每分钟
  // 换一次身份，会反复空转下面那个「刷新全部」的 loading 下降沿 effect。
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
  // Only providers with accounts are offered; a remembered filter for an emptied provider falls back.
  const filterTypes = useMemo(
    () => FILTER_ORDER.filter((type) => (tabCounts[type] ?? 0) > 0),
    [tabCounts]
  );
  const activeTab: QuotaTabId = tab === 'all' || filterTypes.includes(tab) ? tab : 'all';
  const tabEntries = useMemo(() => filterEntriesByTab(entries, activeTab), [entries, activeTab]);
  // Claude and Codex render as pooled charts; their per-credential cards live inside them.
  const pooledProviders = useMemo<PoolProvider[]>(
    () => POOL_PROVIDERS.filter((provider) => tabEntries.some((entry) => entry.type === provider)),
    [tabEntries]
  );
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
  // 排序在分页之前：否则「最快恢复」只在当前页内成立。
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

  const handleLayoutChange = useCallback((next: CardLayout) => {
    setLayout(next);
    writeCardLayout(QUOTA_CARD_LAYOUT_KEY, next);
  }, []);

  const toggleExpandedCard = useCallback((key: string) => {
    setExpandedCards((previous) => {
      const next = new Set(previous);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }, []);

  const sortOptions = useMemo(
    () =>
      QUOTA_SORT_MODES.map((mode) => ({ value: mode, label: t(`quota_management.sort_${mode}`) })),
    [t]
  );

  /* ---------- 额度池（历史 + 投影） ---------- */

  const now = useNow();
  // null = follow today (Now a quarter into a 14-day span).
  const [pinnedSpan, setPinnedSpan] = useState<PoolSpan | null>(null);
  const span = pinnedSpan ?? defaultPoolSpan(now);
  const [chartMode, setChartMode] = useState<PoolChartMode>('remaining');
  const [burnWindow, setBurnWindow] = useState<BurnWindowHours>(3);
  const [futureUsage, setFutureUsage] = useState<FutureUsage>('same');
  const [showAccounts, setShowAccounts] = useState(false);
  const [poolWindows, setPoolWindows] = useState<Record<PoolProvider, PoolWindowChoice>>({
    claude: defaultPoolWindow('claude'),
    codex: defaultPoolWindow('codex'),
  });
  const [planWeights, setPlanWeights] = useState<PlanWeightsByProvider>(() => readPlanWeights());

  const handlePlanWeightChange = useCallback(
    (provider: PoolProvider, plan: string, weight: number | null) => {
      setPlanWeights((previous) => {
        const forProvider = { ...(previous[provider] ?? {}) };
        if (weight === null || weight === 1) delete forProvider[plan];
        else forProvider[plan] = weight;
        const next = { ...previous, [provider]: forProvider };
        writePlanWeights(next);
        return next;
      });
    },
    []
  );

  const historyActive = !disableControls && pooledProviders.length > 0;
  // Keyed by day so the minute clock doesn't refetch on its own; the hook polls every 60 s.
  const quotaHistory = useQuotaHistory(startOfDay(span.start), historyActive);
  const refetchHistory = quotaHistory.refetch;
  const historyReady = quotaHistory.status === 'ready' && quotaHistory.history !== null;

  // Without recorded history, the live per-credential reads still give a current point.
  const liveHistory = useMemo<QuotaHistory>(() => {
    const inputs: LiveAccountInput[] = entries
      .filter((entry) => entry.type === 'claude' || entry.type === 'codex')
      .map((entry) => {
        const quota = quotaByType[entry.type][getQuotaCacheKey(entry.file)] as
          ClaudeQuotaState | CodexQuotaState | undefined;
        return {
          authIndex: historyAuthIndex(entry.file),
          provider: entry.type as PoolProvider,
          label: entry.file.email || entry.file.name,
          plan: quota?.planType ?? null,
          disabled: Boolean(entry.file.disabled),
          windows: quota?.windows?.length ? quota.windows : null,
        };
      });
    return historyFromLiveSnapshots(inputs, now);
  }, [entries, now, quotaByType]);

  const poolHistory: QuotaHistory = historyReady ? quotaHistory.history! : liveHistory;
  const showHistoryHint =
    pooledProviders.length > 0 &&
    !historyReady &&
    (quotaHistory.status === 'unavailable' || quotaHistory.status === 'error');

  const attentionCount = useMemo(
    () =>
      entries.filter(
        (entry) => quotaByType[entry.type][getQuotaCacheKey(entry.file)]?.status === 'error'
      ).length,
    [entries, quotaByType]
  );

  // 剪枝：文件列表落定后，各 provider 缓存只保留仍存在的凭证
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

  /* ---------- 加载与操作 ---------- */

  const { batchLoading, loadQuota } = useQuotaBatchLoader();
  const { resettingQuotaName, refreshQuota, resetQuota } = useQuotaActions(disableControls);

  const pendingRefreshRef = useRef<number | null>(null);
  const prevLoadingRef = useRef(loading);

  // 刷新全部：先让 hub 立即采样一次，再重取文件列表，待其落定（loading 下降沿）
  // 批量拉池内凭证 + 当前页额度，最后重取历史。
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

  useDevinQuotaAutoLoad(
    pageItems,
    disableControls ||
      loading ||
      batchLoading ||
      Boolean(error) ||
      filesGeneration !== sessionGeneration,
    loadQuota
  );

  const canUseActions = !disableControls && !loading && filesGeneration === sessionGeneration;

  /* ---------- Per-account rows and Codex banked resets ---------- */

  const rowsByProvider = useMemo(() => {
    const out = {} as Record<PoolProvider, PoolAccountRow[]>;
    POOL_PROVIDERS.forEach((provider) => {
      const inputs = entries
        .filter((entry) => entry.type === provider)
        .map((entry) => {
          const quota = quotaByType[entry.type][getQuotaCacheKey(entry.file)] as
            ClaudeQuotaState | CodexQuotaState | undefined;
          return {
            authIndex: historyAuthIndex(entry.file),
            label: entry.file.email || entry.file.name,
            plan: quota?.planType ?? null,
            disabled: Boolean(entry.file.disabled),
            liveError: quota?.status === 'error' ? (quota.error ?? '') : '',
          };
        });
      out[provider] = buildPoolAccountRows(poolHistory, provider, inputs, now);
    });
    return out;
  }, [entries, now, poolHistory, quotaByType]);

  const [resetTarget, setResetTarget] = useState<UseResetTarget | null>(null);
  const [redeeming, setRedeeming] = useState<string | null>(null);

  const openUseReset = useCallback(
    (row: PoolAccountRow) => {
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

  const cardKey = (entry: QuotaFileEntry) => `${entry.type}:${getQuotaCacheKey(entry.file)}`;
  const renderCard = (entry: QuotaFileEntry) => {
    const key = cardKey(entry);
    return (
      <QuotaCard
        key={key}
        entry={entry}
        quota={getQuota(entry)}
        resolvedTheme={resolvedTheme}
        canRefresh={canUseActions && !entry.file.disabled}
        resetting={resettingQuotaName === getQuotaCacheKey(entry.file)}
        entranceDelayMs={null}
        creditOverageSharedCount={
          entry.type === 'codex'
            ? codexCreditOverageCounts.get(codexCreditOverageKey(entry.file) ?? '')
            : undefined
        }
        glance={layout === 'compact' ? !expandedCards.has(key) : undefined}
        onToggleGlance={() => toggleExpandedCard(key)}
        onRefresh={() => void refreshQuota(entry.file, QUOTA_ADAPTERS[entry.type])}
        onReset={() => resetQuota(entry.file, QUOTA_ADAPTERS[entry.type])}
      />
    );
  };

  const providerSummary = FILTER_ORDER.filter((type) => (tabCounts[type] ?? 0) > 0)
    .map((type) => `${tabCounts[type]} ${getTypeLabel(t, type)}`)
    .join(', ');
  const description =
    entries.length === 0
      ? loading
        ? t('quota_overview.summary_loading')
        : t('quota_overview.summary_none')
      : [
          t('quota_overview.summary', { count: entries.length, providers: providerSummary }),
          attentionCount > 0
            ? t('quota_overview.summary_attention', { count: attentionCount })
            : '',
        ]
          .filter(Boolean)
          .join(' · ');

  const filterItems = [
    { value: 'all' as QuotaTabId, label: t('quota_overview.filter_all'), count: entries.length },
    ...filterTypes.map((type) => {
      const icon = getAuthFileIcon(type, resolvedTheme);
      return {
        value: type as QuotaTabId,
        label: getTypeLabel(t, type),
        count: tabCounts[type] ?? 0,
        icon: icon ? <img src={icon} alt="" className={styles.tabIcon} /> : undefined,
      };
    }),
  ];

  const firstLoad = loading && entries.length === 0;
  const noAccounts = !loading && !error && entries.length === 0;
  const isSearchEmpty = !loading && stockTabEntries.length > 0 && filteredEntries.length === 0;
  const showStockSection = stockTabEntries.length > 0;
  const poolLoading = quotaHistory.status === 'loading' && !historyReady;
  const historyIntervalSeconds = poolHistory.intervalSeconds;

  return (
    <div className={`${styles.page} ${showEmails ? '' : styles.hideEmails}`}>
      <PageHeader
        title={t('quota_overview.title')}
        description={description}
        actions={
          <>
            <Button
              variant="ghost"
              size="sm"
              aria-pressed={showEmails}
              onClick={() => setShowEmails((value) => !value)}
            >
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
          filterTypes.length > 1 ? (
            <Tabs
              ariaLabel={t('quota_overview.filter_label')}
              items={filterItems}
              value={activeTab}
              onChange={handleTabChange}
            />
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

      {pooledProviders.length > 0 && (
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
            onShift={(direction) => setPinnedSpan(shiftPoolSpan(span, direction))}
            onToday={() => setPinnedSpan(null)}
            locale={locale}
          />

          {showHistoryHint && (
            <p className={styles.historyHint}>
              {quotaHistory.status === 'error' ? (
                t('quota_pool.history_error', { message: quotaHistory.error })
              ) : (
                <Trans i18nKey="quota_pool.history_hint" components={{ code: <code /> }} />
              )}
            </p>
          )}

          {pooledProviders.map((provider) => {
            const providerEntries = pooledEntries.filter((entry) => entry.type === provider);
            const rows = rowsByProvider[provider];
            const lastReadAt = historyReady ? latestReadingAt(rows) : null;
            return (
              <QuotaPoolCard
                key={provider}
                provider={provider}
                history={poolHistory}
                window={poolWindows[provider]}
                onWindowChange={(choice) =>
                  setPoolWindows((previous) => ({ ...previous, [provider]: choice }))
                }
                weights={planWeights[provider] ?? {}}
                onWeightChange={(plan, weight) => handlePlanWeightChange(provider, plan, weight)}
                mode={chartMode}
                showAccounts={showAccounts}
                spanStart={span.start}
                spanEnd={span.end}
                now={now}
                burnWindowHours={burnWindow}
                futureUsage={futureUsage}
                resolvedTheme={resolvedTheme}
                locale={locale}
                accountCount={providerEntries.length}
                loading={poolLoading}
                lastReadAt={lastReadAt}
                stale={isReadingStale(lastReadAt, now, historyIntervalSeconds)}
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
                      rows={rows}
                      now={now}
                      locale={locale}
                      credits={provider === 'codex' ? codexCredits.byAccount : undefined}
                      redeeming={redeeming}
                      onUseReset={provider === 'codex' && canUseActions ? openUseReset : undefined}
                    />
                  )
                }
                details={
                  <div className={styles.grid}>
                    {providerEntries.map((entry) => renderCard(entry))}
                  </div>
                }
              />
            );
          })}
        </>
      )}

      {showStockSection && (
        <Section
          title={t('quota_overview.other_title')}
          description={t('quota_overview.other_desc')}
        >
          <Toolbar
            ariaLabel={t('quota_overview.other_toolbar')}
            end={
              <>
                <div className={styles.sort}>
                  <Select
                    value={sortMode}
                    options={sortOptions}
                    onChange={handleSortModeChange}
                    ariaLabel={t('quota_management.sort_label')}
                    size="sm"
                  />
                </div>
                <CardLayoutSwitch value={layout} onChange={handleLayoutChange} />
              </>
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

          {loading ? (
            <div className={styles.grid} aria-hidden="true">
              {Array.from({ length: SKELETON_CARD_COUNT }, (_, index) => (
                <Skeleton key={index} height={168} rounded={8} />
              ))}
            </div>
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
            // One container for every layout, so switching layouts never remounts the cards.
            <StackedColumns
              stacked={layout !== 'even'}
              className={layout === 'even' ? styles.grid : undefined}
              {...(layout === 'compact' ? QUOTA_COMPACT_COLUMNS : QUOTA_STACKED_COLUMNS)}
              items={pageItems.map((entry) => ({
                key: cardKey(entry),
                node: renderCard(entry),
                settled: getQuota(entry)?.status !== 'loading',
              }))}
            />
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

          {/* The timeline compares the current page only, so lanes stay bounded. */}
          <QuotaTimeline
            entries={pageItems}
            quotaFor={getQuota}
            displayNameFor={displayNameFor}
            resolvedTheme={resolvedTheme}
          />
        </Section>
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
