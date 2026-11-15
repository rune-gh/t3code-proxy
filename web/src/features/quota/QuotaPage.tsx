/**
 * 额度查询页：提供商 tabs + 统一卡网格。
 *
 * 保留的行为契约（重设计不改）：
 * - 现有提供商保持点击加载；Devin 首次可见时主动查询一次，不轮询；
 * - cacheGeneration 会话隔离 + request-id 去重（见 useQuotaBatchLoader）；
 * - 文件列表变化后按 provider 剪枝额度缓存（已删文件不残留）；
 * - useHeaderRefresh 单槽位：本页唯一注册者，全局刷新 = 重取文件列表。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { authFilesApi, quotaHistoryApi, type QuotaHistory } from '@/services/api';
import { Button } from '@/components/ui/Button';
import { CardLayoutSwitch } from '@/components/ui/CardLayoutSwitch';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconSearch, IconX } from '@/components/ui/icons';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { StackedColumns } from '@/components/ui/StackedColumns';
import { readCardLayout, writeCardLayout, type CardLayout } from '@/components/ui/cardLayout';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { useNow } from '@/hooks/useNow';
import { useRevealGroup } from '@/hooks/motion';
import { useAuthStore, useQuotaStore, useThemeStore } from '@/stores';
import type { AuthFileItem, ClaudeQuotaState, CodexQuotaState, ResolvedTheme } from '@/types';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import { ProviderTabs } from '@/features/authFiles/components/ProviderTabs';
import { QuotaHeader } from './components/QuotaHeader';
import { QuotaCard } from './components/QuotaCard';
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
import { startOfDay } from './quotaTimelineModel';
import {
  CARD_ENTRANCE_BUDGET_MS,
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

const TAB_IDS: string[] = ['all', ...QUOTA_TAB_ORDER];
const SKELETON_CARD_COUNT = 6;

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
  // 页头 + tabs 的入场级联（标题 → meta → 动作 → tabs，级差 70ms）
  const revealRef = useRevealGroup<HTMLDivElement>();

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
  const tabEntries = useMemo(() => filterEntriesByTab(entries, tab), [entries, tab]);
  // Claude and Codex render as pooled charts; their per-credential cards live inside them.
  const pooledProviders = useMemo<PoolProvider[]>(
    () => POOL_PROVIDERS.filter((provider) => tabEntries.some((entry) => entry.type === provider)),
    [tabEntries]
  );
  const pooledEntries = useMemo(
    () => tabEntries.filter((entry) => (pooledProviders as string[]).includes(entry.type)),
    [pooledProviders, tabEntries]
  );
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

  const { loadedCount, attentionCount } = useMemo(() => {
    const recorded = new Set<string>();
    if (historyReady) {
      quotaHistory.history!.samples.forEach((sample) => {
        if (!sample.error) recorded.add(sample.authIndex);
      });
    }
    let loaded = 0;
    let attention = 0;
    entries.forEach((entry) => {
      const status = quotaByType[entry.type][getQuotaCacheKey(entry.file)]?.status;
      if (status === 'success' || recorded.has(historyAuthIndex(entry.file))) loaded += 1;
      else if (status === 'error') attention += 1;
    });
    return { loadedCount: loaded, attentionCount: attention };
  }, [entries, historyReady, quotaByType, quotaHistory.history]);

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
    void quotaHistoryApi
      .refresh()
      .catch(() => undefined)
      .then(() => refetchHistory());
    void loadFiles();
  }, [disableControls, loadFiles, refetchHistory, sessionGeneration]);

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

  /* ---------- 首屏卡片一次性级联入场 ----------
   * 首批数据渲染后立即翻转 cardsAnimated；已挂载的卡片在挂载时捕获过自己的
   * 延迟（QuotaCard 内 useState 初始化），后续切 tab/翻页/刷新新挂载的卡片
   * 拿到 null —— 不重播。 */

  const [cardsAnimated, setCardsAnimated] = useState(false);
  const enableCardEntrance = !cardsAnimated && !loading && pageItems.length > 0;
  useEffect(() => {
    if (enableCardEntrance) {
      setCardsAnimated(true);
    }
  }, [enableCardEntrance]);
  const cardEntranceDelay = (index: number): number | null => {
    if (!enableCardEntrance) return null;
    if (pageItems.length <= 1) return 0;
    return Math.round((index / (pageItems.length - 1)) * CARD_ENTRANCE_BUDGET_MS);
  };

  /* ---------- 渲染 ---------- */

  const cardKey = (entry: QuotaFileEntry) => `${entry.type}:${getQuotaCacheKey(entry.file)}`;
  const renderCard = (entry: QuotaFileEntry, index: number) => {
    const key = cardKey(entry);
    return (
      <QuotaCard
        key={key}
        entry={entry}
        quota={getQuota(entry)}
        resolvedTheme={resolvedTheme}
        canRefresh={canUseActions && !entry.file.disabled}
        resetting={resettingQuotaName === getQuotaCacheKey(entry.file)}
        entranceDelayMs={cardEntranceDelay(index)}
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

  const isEmpty = !loading && tabEntries.length === 0;
  const isSearchEmpty =
    !loading && !isEmpty && stockTabEntries.length > 0 && filteredEntries.length === 0;
  const showStockSection = stockTabEntries.length > 0;

  return (
    <div className={`${styles.page} ${showEmails ? '' : styles.hideEmails}`} ref={revealRef}>
      <QuotaHeader
        totalCount={entries.length}
        loadedCount={loadedCount}
        attentionCount={attentionCount}
        refreshing={loading || batchLoading}
        disableControls={disableControls}
        onRefreshAll={handleRefreshAll}
        showEmails={showEmails}
        onToggleEmails={() => setShowEmails((value) => !value)}
      />

      <section className={styles.workbench}>
        {/* 提供商导航与搜索工具栏分层，避免不同控件争夺视觉焦点。 */}
        <div className={styles.tabsRow} data-reveal>
          <ProviderTabs
            types={TAB_IDS}
            counts={tabCounts}
            active={tab}
            resolvedTheme={resolvedTheme}
            onChange={handleTabChange}
            variant="pill"
          />
        </div>

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
                <Trans
                  i18nKey="quota_pool.history_hint"
                  defaults="Enable <code>quota-history</code> in config.yaml to record history"
                  components={{ code: <code /> }}
                />
              </p>
            )}

            {pooledProviders.map((provider) => {
              const providerEntries = pooledEntries.filter((entry) => entry.type === provider);
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
                  showEmails={showEmails}
                  resolvedTheme={resolvedTheme}
                  locale={locale}
                  detailsCount={providerEntries.length}
                  details={
                    <div className={styles.grid}>
                      {providerEntries.map((entry, index) => renderCard(entry, index))}
                    </div>
                  }
                />
              );
            })}
          </>
        )}

        {showStockSection && (
          <div className={styles.toolbar}>
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
            <div className={styles.viewControls}>
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
            </div>
          </div>
        )}

        {error && (
          <div className={styles.errorBanner} role="alert">
            {error}
          </div>
        )}

        {loading && (showStockSection || entries.length === 0) ? (
          <div className={styles.grid} aria-hidden="true">
            {Array.from({ length: SKELETON_CARD_COUNT }, (_, index) => (
              <Skeleton key={index} height={168} rounded={14} />
            ))}
          </div>
        ) : isEmpty || isSearchEmpty ? (
          <EmptyState
            title={
              isSearchEmpty
                ? t('quota_management.search_empty_title')
                : tab === 'all'
                  ? t('quota_management.empty_title')
                  : t(`${QUOTA_ADAPTERS[tab].i18nPrefix}.empty_title`)
            }
            description={
              isSearchEmpty
                ? t('quota_management.search_empty_desc')
                : tab === 'all'
                  ? t('quota_management.empty_desc')
                  : t(`${QUOTA_ADAPTERS[tab].i18nPrefix}.empty_desc`)
            }
            action={
              isSearchEmpty ? (
                <Button variant="secondary" size="sm" onClick={() => handleSearchChange('')}>
                  {t('quota_management.search_clear')}
                </Button>
              ) : tab === 'all' ? undefined : (
                <Button variant="secondary" size="sm" onClick={() => handleTabChange('all')}>
                  {t('auth_files.filter_all')}
                </Button>
              )
            }
          />
        ) : !showStockSection ? null : (
          // One container for every layout, so switching layouts never remounts the cards.
          <StackedColumns
            stacked={layout !== 'even'}
            className={layout === 'even' ? styles.grid : undefined}
            {...(layout === 'compact' ? QUOTA_COMPACT_COLUMNS : QUOTA_STACKED_COLUMNS)}
            items={pageItems.map((entry, index) => ({
              key: cardKey(entry),
              node: renderCard(entry, index),
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

        {/* 时间线只比较当前页凭证，避免大量凭证一次性生成无界泳道。 */}
        <QuotaTimeline
          entries={pageItems}
          quotaFor={getQuota}
          displayNameFor={displayNameFor}
          resolvedTheme={resolvedTheme}
        />
      </section>
    </div>
  );
}
