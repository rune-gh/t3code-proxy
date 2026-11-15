import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useInterval } from '@/hooks/useInterval';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { usePageTransitionLayer } from '@/components/common/PageTransitionLayer';
import { Button, IconButton } from '@/components/ui/Button';
import { DropdownMenu, DropdownMenuItem } from '@/components/ui/DropdownMenu';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { PageHeader } from '@/components/ui/PageHeader';
import { Select } from '@/components/ui/Select';
import { Tabs } from '@/components/ui/Tabs';
import { Toolbar } from '@/components/ui/Toolbar';
import { Tooltip } from '@/components/ui/Tooltip';
import {
  IconEllipsis,
  IconKey,
  IconModelCluster,
  IconPlus,
  IconRefreshCw,
  IconSearch,
  IconUpload,
} from '@/components/ui/icons';
import { copyToClipboard } from '@/utils/clipboard';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import {
  getTypeLabel,
  isProblemAuthFile,
  isRuntimeOnlyAuthFile,
  normalizeProviderKey,
  type ResolvedTheme,
} from '@/features/authFiles/constants';
import { AccountRow } from '@/features/authFiles/components/AccountRow';
import { AccountsTable, AccountsTableSkeleton } from '@/features/authFiles/components/AccountsTable';
import { AuthFileDetailsSheet } from '@/features/authFiles/components/AuthFileDetailsSheet';
import { AuthFileModelsModal } from '@/features/authFiles/components/AuthFileModelsModal';
import { AuthFileRefreshResults } from '@/features/authFiles/components/AuthFileRefreshResults';
import { ModelRulesEntry } from '@/features/authFiles/components/ModelRulesEntry';
import { SelectionBar } from '@/features/authFiles/components/SelectionBar';
import { getAuthFileRefreshKey } from '@/features/authFiles/manualRefresh';
import { invalidateAuthFileDerivedCaches } from '@/features/authFiles/cacheInvalidation';
import {
  buildWildcardSearch,
  matchesAuthFileSearch,
  resolveAuthFileQuotaType,
  sortAuthFiles,
} from '@/features/authFiles/logic';
import { useAuthFilesData } from '@/features/authFiles/hooks/useAuthFilesData';
import { useModelCatalogSync } from '@/features/authFiles/hooks/useModelCatalogSync';
import { useAuthFilesModels } from '@/features/authFiles/hooks/useAuthFilesModels';
import { useAuthFilesOauth } from '@/features/authFiles/hooks/useAuthFilesOauth';
import { buildModelRulesPath } from '@/features/authFiles/modelRules/useModelRulesRoute';
import type { ModelRulesKind } from '@/features/authFiles/modelRules/useModelRulesData';
import { useAuthFilesPrefixProxyEditor } from '@/features/authFiles/hooks/useAuthFilesPrefixProxyEditor';
import {
  isAuthFilesStatusFilterMode,
  isAuthFilesSortMode,
  readAuthFilesUiState,
  writeAuthFilesUiState,
  type AuthFilesStatusFilterMode,
  type AuthFilesSortMode,
} from '@/features/authFiles/uiState';
import { useAuthStore, useNotificationStore, useThemeStore } from '@/stores';
import styles from './AuthFilesPage.module.scss';

const PAGE_SIZES = [25, 50, 100] as const;
const DEFAULT_PAGE_SIZE = PAGE_SIZES[0];

const normalizePersistedStatusFilterMode = (value: unknown): AuthFilesStatusFilterMode | null => {
  if (value === 'disabledProblem') return 'problem';
  return isAuthFilesStatusFilterMode(value) ? value : null;
};

const isPageSize = (value: unknown): value is (typeof PAGE_SIZES)[number] =>
  PAGE_SIZES.includes(value as (typeof PAGE_SIZES)[number]);

const providerOf = (file: { type?: unknown; provider?: unknown }) =>
  normalizeProviderKey(String(file.type ?? file.provider ?? ''));

export function AuthFilesPage() {
  const { t } = useTranslation();
  const showNotification = useNotificationStore((state) => state.showNotification);
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const resolvedTheme: ResolvedTheme = useThemeStore((state) => state.resolvedTheme);
  const pageTransitionLayer = usePageTransitionLayer();
  const isCurrentLayer = pageTransitionLayer ? pageTransitionLayer.status === 'current' : true;
  const navigate = useNavigate();

  const [filter, setFilter] = useState<'all' | string>('all');
  const [statusFilterMode, setStatusFilterMode] = useState<AuthFilesStatusFilterMode>('all');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const [sortMode, setSortMode] = useState<AuthFilesSortMode>('default');
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [uiStateHydrated, setUiStateHydrated] = useState(false);

  const {
    modelsModalOpen,
    modelsLoading,
    modelsList,
    modelsFileName,
    modelsFileType,
    modelsError,
    modelsSupported,
    showModels,
    closeModelsModal,
    invalidateModels,
  } = useAuthFilesModels();

  const { syncingModelCatalog, syncModelCatalog } = useModelCatalogSync(() => {
    invalidateModels();
    if (modelsModalOpen) {
      void showModels({ name: modelsFileName, type: modelsFileType });
    }
  });

  const invalidateDerivedCaches = useCallback(
    (names?: string[]) => invalidateAuthFileDerivedCaches(invalidateModels, names),
    [invalidateModels]
  );

  const {
    files,
    selectedFiles,
    selectionCount,
    loading,
    error,
    uploading,
    deleting,
    statusUpdating,
    manualRefreshing,
    refreshingAllCredentials,
    refreshResults,
    closeRefreshResults,
    handleRefreshAllCredentials,
    cooldownResetting,
    batchStatusUpdating,
    fileInputRef,
    loadFiles,
    handleUploadClick,
    handleFileChange,
    handleDelete,
    handleDownload,
    handleManualRefresh,
    handleCooldownReset,
    handleStatusToggle,
    toggleSelect,
    selectAllVisible,
    invertVisibleSelection,
    deselectAll,
    batchDownload,
    batchSetStatus,
    batchDelete,
  } = useAuthFilesData({ onFilesMutated: invalidateDerivedCaches });

  const { excluded, excludedError, modelAlias, modelAliasError, loadExcluded, loadModelAlias } =
    useAuthFilesOauth();

  const disableControls = connectionStatus !== 'connected' || refreshingAllCredentials;

  const {
    prefixProxyEditor,
    prefixProxyUpdatedText,
    prefixProxyDirty,
    openPrefixProxyEditor,
    closePrefixProxyEditor,
    handlePrefixProxyChange,
    handlePrefixProxySave,
  } = useAuthFilesPrefixProxyEditor({
    disableControls,
    loadFiles,
    onFilesMutated: invalidateDerivedCaches,
  });

  const normalizedFilter = normalizeProviderKey(String(filter));
  const problemOnly = statusFilterMode === 'problem';
  const disabledOnly = statusFilterMode === 'disabled';
  const enabledOnly = statusFilterMode === 'enabled';

  /* ---------- UI state: hydrate once, then persist (same storage key as before) ---------- */

  useEffect(() => {
    const persisted = readAuthFilesUiState();
    if (persisted) {
      if (typeof persisted.filter === 'string' && persisted.filter.trim()) {
        setFilter(normalizeProviderKey(persisted.filter));
      }
      const persistedStatus = normalizePersistedStatusFilterMode(persisted.statusFilterMode);
      if (persistedStatus) {
        setStatusFilterMode(persistedStatus);
      } else if (persisted.problemOnly === true) {
        setStatusFilterMode('problem');
      } else if (persisted.disabledOnly === true) {
        setStatusFilterMode('disabled');
      }
      if (typeof persisted.search === 'string') setSearch(persisted.search);
      if (typeof persisted.page === 'number' && Number.isFinite(persisted.page)) {
        setPage(Math.max(1, Math.round(persisted.page)));
      }
      if (isPageSize(persisted.pageSize)) setPageSize(persisted.pageSize);
      if (isAuthFilesSortMode(persisted.sortMode)) setSortMode(persisted.sortMode);
    }
    setUiStateHydrated(true);
  }, []);

  useEffect(() => {
    if (!uiStateHydrated) return;
    writeAuthFilesUiState({
      filter,
      statusFilterMode,
      problemOnly,
      disabledOnly,
      search,
      page,
      pageSize,
      sortMode,
    });
  }, [
    disabledOnly,
    filter,
    page,
    pageSize,
    problemOnly,
    search,
    sortMode,
    statusFilterMode,
    uiStateHydrated,
  ]);

  /* ---------- Loading: first load shows skeletons, later loads run in the background ---------- */

  const initialLoadDoneRef = useRef(false);

  const handleHeaderRefresh = useCallback(async () => {
    await Promise.all([loadFiles({ background: true }), loadExcluded(), loadModelAlias()]);
  }, [loadFiles, loadExcluded, loadModelAlias]);

  useHeaderRefresh(handleHeaderRefresh);

  useEffect(() => {
    if (!isCurrentLayer) return;
    void loadFiles(initialLoadDoneRef.current ? { background: true } : undefined);
    initialLoadDoneRef.current = true;
    loadExcluded();
    loadModelAlias();
  }, [isCurrentLayer, loadFiles, loadExcluded, loadModelAlias]);

  useInterval(
    () => {
      void loadFiles({ background: true }).catch(() => {});
    },
    isCurrentLayer ? 240_000 : null
  );

  /* ---------- Filter, sort, paginate ---------- */

  const filesMatchingStatus = useMemo(
    () =>
      files.filter((file) => {
        if (enabledOnly && file.disabled === true) return false;
        if (disabledOnly && file.disabled !== true) return false;
        if (problemOnly && !isProblemAuthFile(file)) return false;
        return true;
      }),
    [disabledOnly, enabledOnly, files, problemOnly]
  );

  // Tabs list every provider that has an account, counted under the status filter.
  const providerTabs = useMemo(() => {
    const counts = new Map<string, number>();
    files.forEach((file) => {
      const type = providerOf(file);
      if (type && !counts.has(type)) counts.set(type, 0);
    });
    filesMatchingStatus.forEach((file) => {
      const type = providerOf(file);
      if (type) counts.set(type, (counts.get(type) ?? 0) + 1);
    });
    return [
      { value: 'all', label: t('auth_files.filter_all'), count: filesMatchingStatus.length },
      ...Array.from(counts, ([value, count]) => ({
        value,
        label: getTypeLabel(t, value),
        count,
      })),
    ];
  }, [files, filesMatchingStatus, t]);

  // A persisted provider filter that no longer has accounts falls back to all.
  const activeFilter = providerTabs.some((tab) => tab.value === normalizedFilter)
    ? normalizedFilter
    : 'all';

  const normalizedSearch = search.trim();
  const wildcardSearch = useMemo(() => buildWildcardSearch(normalizedSearch), [normalizedSearch]);

  const filtered = useMemo(
    () =>
      filesMatchingStatus.filter(
        (item) =>
          (activeFilter === 'all' || providerOf(item) === activeFilter) &&
          matchesAuthFileSearch(item, normalizedSearch, wildcardSearch)
      ),
    [filesMatchingStatus, activeFilter, normalizedSearch, wildcardSearch]
  );

  const sorted = useMemo(() => sortAuthFiles(filtered, sortMode), [filtered, sortMode]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const start = (currentPage - 1) * pageSize;
  const pageItems = useMemo(() => sorted.slice(start, start + pageSize), [pageSize, sorted, start]);
  const selectablePageItems = useMemo(
    () => pageItems.filter((file) => !isRuntimeOnlyAuthFile(file)),
    [pageItems]
  );
  const selectableFilteredCount = useMemo(
    () => sorted.filter((file) => !isRuntimeOnlyAuthFile(file)).length,
    [sorted]
  );
  const selectedNames = useMemo(() => Array.from(selectedFiles), [selectedFiles]);
  const pageSelectedCount = selectablePageItems.filter((file) =>
    selectedFiles.has(file.name)
  ).length;
  const pageSelection =
    pageSelectedCount === 0
      ? 'none'
      : pageSelectedCount === selectablePageItems.length
        ? 'all'
        : 'some';
  const selectedHasStatusUpdating = files.some(
    (file) => selectedFiles.has(file.name) && statusUpdating[getAuthFileRefreshKey(file)] === true
  );
  const batchStatusDisabled =
    disableControls || selectedNames.length === 0 || batchStatusUpdating || selectedHasStatusUpdating;

  const activeCount = files.filter((file) => file.disabled !== true).length;
  const problemCount = files.filter(isProblemAuthFile).length;

  /* ---------- Handlers ---------- */

  const resetPage = () => setPage(1);

  const copyTextWithNotification = useCallback(
    async (text: string) => {
      const copied = await copyToClipboard(text);
      showNotification(
        copied ? t('notification.link_copied') : t('notification.copy_failed'),
        copied ? 'success' : 'error'
      );
    },
    [showNotification, t]
  );

  const openModelRules = useCallback(
    (kind: ModelRulesKind, provider?: string) => {
      navigate(buildModelRulesPath(kind, provider), { state: { fromAuthFiles: true } });
    },
    [navigate]
  );

  const toggleExpanded = useCallback((key: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const clearFilters = () => {
    setFilter('all');
    setStatusFilterMode('all');
    setSearch('');
    resetPage();
  };

  const togglePageSelection = () => {
    if (pageSelection === 'all') invertVisibleSelection(selectablePageItems);
    else selectAllVisible(pageItems);
  };

  const statusFilterOptions = [
    { value: 'all', label: t('auth_files.problem_filter_all') },
    { value: 'enabled', label: t('auth_files.problem_filter_enabled') },
    { value: 'disabled', label: t('auth_files.problem_filter_disabled') },
    { value: 'problem', label: t('auth_files.problem_filter_problem') },
  ];

  const sortOptions = [
    { value: 'default', label: t('auth_files.sort_default') },
    { value: 'az', label: t('auth_files.sort_az') },
    { value: 'priority', label: t('auth_files.sort_priority') },
  ];

  const pageSizeOptions = PAGE_SIZES.map((size) => ({
    value: String(size),
    label: t('auth_files.page_size_option', { count: size }),
  }));

  const isFirstRunEmpty = !loading && files.length === 0 && !error;
  const isNoResults = !loading && files.length > 0 && pageItems.length === 0;
  const showTabs = providerTabs.length > 2;

  const description = loading
    ? t('auth_files.description')
    : [
        t('auth_files.meta_total', { count: files.length }),
        t('auth_files.meta_active', { count: activeCount }),
        problemCount > 0 ? t('auth_files.meta_problem', { count: problemCount }) : null,
      ]
        .filter(Boolean)
        .join(' · ');

  const addAccountButton = (
    <Button variant="primary" size="sm" onClick={() => navigate('/oauth')}>
      <IconPlus size={16} />
      {t('auth_files.add_account')}
    </Button>
  );

  return (
    <>
      <PageHeader
        title={t('auth_files.title')}
        description={description}
        actions={
          <>
            <Tooltip content={t('auth_files.reload_list')}>
              <IconButton
                variant="ghost"
                size="sm"
                aria-label={t('auth_files.reload_list')}
                icon={<IconRefreshCw size={16} />}
                onClick={() => void handleHeaderRefresh()}
                disabled={loading}
              />
            </Tooltip>
            <DropdownMenu
              ariaLabel={t('auth_files.more_actions')}
              minWidth={220}
              trigger={
                <IconButton
                  variant="secondary"
                  size="sm"
                  aria-label={t('auth_files.more_actions')}
                  icon={<IconEllipsis size={16} />}
                />
              }
            >
              <DropdownMenuItem
                icon={<IconUpload size={16} />}
                onSelect={handleUploadClick}
                disabled={disableControls || uploading}
              >
                {t('auth_files.upload_button')}
              </DropdownMenuItem>
              <DropdownMenuItem
                icon={<IconKey size={16} />}
                onSelect={handleRefreshAllCredentials}
                disabled={
                  disableControls ||
                  refreshingAllCredentials ||
                  Object.keys(manualRefreshing).length > 0
                }
              >
                {t('auth_files.refresh_all_button')}
              </DropdownMenuItem>
              <DropdownMenuItem
                icon={<IconModelCluster size={16} />}
                onSelect={() => void syncModelCatalog()}
                disabled={connectionStatus !== 'connected' || syncingModelCatalog}
              >
                {t('auth_files.sync_catalog_button')}
              </DropdownMenuItem>
            </DropdownMenu>
            {addAccountButton}
          </>
        }
        tabs={
          showTabs ? (
            <Tabs
              ariaLabel={t('auth_files.provider_tabs_label')}
              items={providerTabs}
              value={activeFilter}
              onChange={(value) => {
                setFilter(value);
                resetPage();
              }}
            />
          ) : undefined
        }
      />

      <input
        ref={fileInputRef}
        type="file"
        accept=".json,application/json"
        multiple
        style={{ display: 'none' }}
        onChange={handleFileChange}
      />
      <AuthFileRefreshResults results={refreshResults} onClose={closeRefreshResults} />

      {!isFirstRunEmpty && (
        <div className={styles.list}>
          <Toolbar
            ariaLabel={t('auth_files.filters_label')}
            end={
              <Select
                fullWidth={false}
                value={sortMode}
                options={sortOptions}
                onChange={(value) => {
                  if (!isAuthFilesSortMode(value)) return;
                  setSortMode(value);
                  resetPage();
                }}
                ariaLabel={t('auth_files.sort_label')}
              />
            }
          >
            <div className={styles.search}>
              <Input
                value={search}
                onChange={(event) => {
                  setSearch(event.currentTarget.value);
                  resetPage();
                }}
                placeholder={t('auth_files.search_placeholder')}
                aria-label={t('auth_files.search_label')}
                rightElement={<IconSearch size={14} aria-hidden="true" />}
              />
            </div>
            <Select
              fullWidth={false}
              value={statusFilterMode}
              options={statusFilterOptions}
              onChange={(value) => {
                if (!isAuthFilesStatusFilterMode(value)) return;
                setStatusFilterMode(value);
                resetPage();
              }}
              ariaLabel={t('auth_files.problem_filter_label')}
            />
          </Toolbar>

          <SelectionBar
            selectionCount={selectionCount}
            selectablePageCount={selectablePageItems.length}
            selectableFilteredCount={selectableFilteredCount}
            disableControls={disableControls}
            batchStatusDisabled={batchStatusDisabled}
            onSelectPage={() => selectAllVisible(pageItems)}
            onSelectFiltered={() => selectAllVisible(sorted)}
            onInvertPage={() => invertVisibleSelection(pageItems)}
            onDeselectAll={deselectAll}
            onDownload={() => void batchDownload(selectedNames)}
            onEnable={() => batchSetStatus(selectedNames, true)}
            onDisable={() => batchSetStatus(selectedNames, false)}
            onDelete={() => batchDelete(selectedNames)}
          />

          {error && (
            <div className="error-box" role="alert">
              {error}
            </div>
          )}

          {loading ? (
            <AccountsTableSkeleton />
          ) : isNoResults ? (
            <EmptyState
              title={t('auth_files.search_empty_title')}
              description={t('auth_files.search_empty_desc')}
              action={
                <Button variant="secondary" size="sm" onClick={clearFilters}>
                  {t('auth_files.no_results_clear')}
                </Button>
              }
            />
          ) : pageItems.length > 0 ? (
            <AccountsTable
              pageSelection={pageSelection}
              selectableCount={selectablePageItems.length}
              onTogglePageSelection={togglePageSelection}
            >
              {pageItems.map((file) => {
                const key = getQuotaCacheKey(file);
                return (
                  <AccountRow
                    key={key}
                    rowKey={key}
                    file={file}
                    expanded={expanded.has(key)}
                    selected={selectedFiles.has(file.name)}
                    resolvedTheme={resolvedTheme}
                    disableControls={disableControls}
                    deleting={deleting}
                    statusUpdating={statusUpdating}
                    manualRefreshing={manualRefreshing}
                    cooldownResetting={cooldownResetting}
                    quotaType={resolveAuthFileQuotaType(file, 'all')}
                    modelsAvailable={modelsSupported}
                    onToggleExpanded={toggleExpanded}
                    onShowModels={showModels}
                    onDownload={handleDownload}
                    onManualRefresh={handleManualRefresh}
                    onCooldownReset={handleCooldownReset}
                    onOpenPrefixProxyEditor={openPrefixProxyEditor}
                    onDelete={handleDelete}
                    onToggleStatus={handleStatusToggle}
                    onToggleSelect={toggleSelect}
                  />
                );
              })}
            </AccountsTable>
          ) : null}

          {!loading && sorted.length > PAGE_SIZES[0] && (
            <div className={styles.pagination}>
              <span className={styles.pageInfo}>
                {t('auth_files.pagination_info', {
                  from: start + 1,
                  to: Math.min(start + pageSize, sorted.length),
                  count: sorted.length,
                })}
              </span>
              <div className={styles.pageControls}>
                <Select
                  size="sm"
                  fullWidth={false}
                  value={String(pageSize)}
                  options={pageSizeOptions}
                  onChange={(value) => {
                    const next = Number(value);
                    if (!isPageSize(next)) return;
                    setPageSize(next);
                    resetPage();
                  }}
                  ariaLabel={t('auth_files.page_size_label')}
                />
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setPage(Math.max(1, currentPage - 1))}
                  disabled={currentPage <= 1}
                >
                  {t('auth_files.pagination_prev')}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setPage(Math.min(totalPages, currentPage + 1))}
                  disabled={currentPage >= totalPages}
                >
                  {t('auth_files.pagination_next')}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {isFirstRunEmpty && (
        <EmptyState
          title={t('auth_files.empty_title')}
          description={t('auth_files.empty_desc')}
          action={addAccountButton}
        />
      )}

      {!isFirstRunEmpty && (
        <ModelRulesEntry
          excluded={excluded}
          excludedError={excludedError}
          modelAlias={modelAlias}
          modelAliasError={modelAliasError}
          scope={activeFilter}
          resolvedTheme={resolvedTheme}
          onOpenExcluded={(provider) => openModelRules('excluded', provider)}
          onOpenAlias={(provider) => openModelRules('alias', provider)}
          onRetryExcluded={loadExcluded}
          onRetryAlias={loadModelAlias}
        />
      )}

      <AuthFileModelsModal
        open={modelsModalOpen}
        fileName={modelsFileName}
        fileType={modelsFileType}
        loading={modelsLoading}
        error={modelsError}
        models={modelsList}
        excluded={excluded}
        onClose={closeModelsModal}
        onCopyText={copyTextWithNotification}
      />

      <AuthFileDetailsSheet
        disableControls={disableControls}
        editor={prefixProxyEditor}
        updatedText={prefixProxyUpdatedText}
        dirty={prefixProxyDirty}
        onClose={closePrefixProxyEditor}
        onCopyText={copyTextWithNotification}
        onSave={handlePrefixProxySave}
        onChange={handlePrefixProxyChange}
      />
    </>
  );
}
