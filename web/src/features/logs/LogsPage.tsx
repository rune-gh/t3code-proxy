import { useDeferredValue, useEffect, useMemo, useReducer, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { Link } from 'react-router-dom';
import { Trans, useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/Badge';
import { Button, IconButton } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { Skeleton } from '@/components/ui/Skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/Table';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { Toolbar } from '@/components/ui/Toolbar';
import { lockScroll, unlockScroll } from '@/components/ui/scrollLock';
import {
  IconCopy,
  IconDownload,
  IconMaximize2,
  IconMinimize2,
  IconRefreshCw,
  IconRows3,
  IconSearch,
  IconSidebarLogs,
  IconSlidersHorizontal,
  IconTrash2,
  IconX,
} from '@/components/ui/icons';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { useAuthStore, useConfigStore, useNotificationStore } from '@/stores';
import { logsApi, responseDataToText, type ErrorLogFile } from '@/services/api/logs';
import { INITIAL_VISIBLE_LINES } from './model/logBuffer';
import { useLogStream } from './hooks/useLogStream';
import { copyToClipboard } from '@/utils/clipboard';
import { getErrorMessage } from '@/utils/helpers';
import { downloadBlob } from '@/utils/download';
import {
  createLogParserCache,
  searchLogEntries,
  filterLogEntries,
} from '@/features/logs/model/logSelectors';
import { Select } from '@/components/ui/Select';
import { formatUnixTimestamp } from '@/utils/format';
import { MANAGEMENT_API_PREFIX } from '@/utils/constants';
import { HTTP_METHODS, STATUS_GROUPS, type LogState } from './model/logTypes';
import { createLogRequestGuard } from './model/logRequests';
import { errorLogViewerReducer } from './model/errorLogViewer';
import { shouldExitLogFullscreen } from './model/logFullscreen';
import { useLogFilters } from './hooks/useLogFilters';
import { isNearBottom, useLogScroller } from './hooks/useLogScroller';
import styles from './LogsPage.module.scss';

const INITIAL_DISPLAY_LINES = INITIAL_VISIBLE_LINES;

type TabType = 'logs' | 'errors';

export function LogsPage() {
  const { t } = useTranslation();
  const { showNotification } = useNotificationStore();
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const apiBase = useAuthStore((state) => state.apiBase);
  const managementKey = useAuthStore((state) => state.managementKey);
  const config = useConfigStore((state) => state.config);
  const requestLogEnabled = config?.requestLog ?? false;

  const [activeTab, setActiveTab] = useState<TabType>('logs');
  const [searchQuery, setSearchQuery] = useState('');
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const [hideManagementLogs, setHideManagementLogs] = useLocalStorage(
    'logsPage.hideManagementLogs',
    true
  );
  const [showRawLogs, setShowRawLogs] = useLocalStorage('logsPage.showRawLogs', false);
  const [wrapLogs, setWrapLogs] = useLocalStorage('logsPage.wrapLogs', false);
  const [structuredFiltersExpanded, setStructuredFiltersExpanded] = useState(false);
  const [errorLogs, setErrorLogs] = useState<ErrorLogFile[]>([]);
  const [loadingErrors, setLoadingErrors] = useState(false);
  const [errorLogsError, setErrorLogsError] = useState('');
  const [errorLogViewer, dispatchErrorLogViewer] = useReducer(errorLogViewerReducer, {
    status: 'closed',
  });
  const selectedErrorLog = errorLogViewer.status === 'closed' ? null : errorLogViewer.item;
  const [viewerRequestId, setViewerRequestId] = useState<string | null>(null);
  const [requestLogDownloading, setRequestLogDownloading] = useState(false);
  const [fullscreenLogs, setFullscreenLogs] = useState(false);

  const [requests] = useState(() => ({
    session: createLogRequestGuard(),
    errors: createLogRequestGuard(),
    viewer: createLogRequestGuard(),
  }));

  const {
    logBuffer,
    visibleCount,
    setVisibleCount,
    lastUpdated,
    catchingUp,
    wasReset,
    loading,
    clearingLogs,
    error,
    autoRefresh,
    setAutoRefresh,
    cpaNeedsFileLogging,
    showFileLoggingRequired,
    loadLogs,
    clearLogs,
  } = useLogStream({
    active: activeTab === 'logs',
    isFollowing: () => isNearBottom(logViewerRef.current),
    onFollow: () => requestScrollToBottom(),
  });

  const disableControls = connectionStatus !== 'connected';
  const refreshDisabled = disableControls || loading || clearingLogs || cpaNeedsFileLogging;
  const autoRefreshDisabled = disableControls || showFileLoggingRequired;
  const clearDisabled = disableControls || clearingLogs || showFileLoggingRequired;

  const downloadLogs = () => {
    const text = logBuffer.buffer.join('\n');
    downloadBlob({ filename: 'logs.txt', blob: new Blob([text], { type: 'text/plain' }) });
    showNotification(t('logs.download_success'), 'success');
  };

  const loadErrorLogs = async () => {
    if (useAuthStore.getState().connectionStatus !== 'connected') {
      setLoadingErrors(false);
      return;
    }
    const request = requests.errors.invalidate();
    setLoadingErrors(true);
    setErrorLogsError('');
    try {
      const res = await logsApi.fetchErrorLogs();
      if (!requests.errors.isCurrent(request)) return;
      setErrorLogs(Array.isArray(res.files) ? res.files : []);
    } catch (err: unknown) {
      if (!requests.errors.isCurrent(request)) return;
      console.error('Failed to load error logs:', err);
      setErrorLogs([]);
      const message = getErrorMessage(err);
      setErrorLogsError(
        message ? `${t('logs.error_logs_load_error')}: ${message}` : t('logs.error_logs_load_error')
      );
    } finally {
      if (requests.errors.isCurrent(request)) setLoadingErrors(false);
    }
  };

  useHeaderRefresh(() => (activeTab === 'errors' ? loadErrorLogs() : loadLogs(false)));

  const downloadErrorLog = async (name: string) => {
    const session = requests.session.capture();
    try {
      const response = await logsApi.downloadErrorLog(name);
      if (!requests.session.isCurrent(session)) return;
      downloadBlob({ filename: name, blob: new Blob([response.data], { type: 'text/plain' }) });
      showNotification(t('logs.error_log_download_success'), 'success');
    } catch (err: unknown) {
      if (!requests.session.isCurrent(session)) return;
      const message = getErrorMessage(err);
      showNotification(
        `${t('notification.download_failed')}${message ? `: ${message}` : ''}`,
        'error'
      );
    }
  };

  const openErrorLog = async (item: ErrorLogFile, byRequestId?: string) => {
    setViewerRequestId(byRequestId ?? null);
    const requestId = requests.viewer.invalidate();
    dispatchErrorLogViewer({ type: 'open', item });

    try {
      if (item.size && item.size > 2 * 1024 * 1024) throw new Error(t('logs.preview_too_large'));
      const response = byRequestId
        ? await logsApi.downloadRequestLogById(byRequestId)
        : await logsApi.downloadErrorLog(item.name);
      if (response.data instanceof Blob && response.data.size > 2 * 1024 * 1024) {
        throw new Error(t('logs.preview_too_large'));
      }
      const text = await responseDataToText(response.data);
      if (!requests.viewer.isCurrent(requestId)) return;
      dispatchErrorLogViewer({ type: 'ready', text });
    } catch (err: unknown) {
      if (!requests.viewer.isCurrent(requestId)) return;
      const message =
        byRequestId &&
        typeof err === 'object' &&
        err !== null &&
        'status' in err &&
        err.status === 404
          ? `${t('logs.request_log_missing')} ${getErrorMessage(err)}`
          : getErrorMessage(err);
      dispatchErrorLogViewer({
        type: 'error',
        message: message
          ? `${t('logs.error_log_open_failed')}: ${message}`
          : t('logs.error_log_open_failed'),
      });
    }
  };

  const closeErrorLogViewer = () => {
    requests.viewer.invalidate();
    dispatchErrorLogViewer({ type: 'close' });
  };

  const copySelectedErrorLog = async () => {
    if (errorLogViewer.status !== 'ready' || !errorLogViewer.text) return;
    const session = requests.session.capture();
    const ok = await copyToClipboard(errorLogViewer.text);
    if (!requests.session.isCurrent(session)) return;
    showNotification(
      ok
        ? t('logs.error_log_copy_success')
        : t('logs.copy_failed', { defaultValue: 'Copy failed' }),
      ok ? 'success' : 'error'
    );
  };

  useEffect(() => {
    const resetErrors = () => {
      requests.errors.invalidate();
      setErrorLogs([]);
      setLoadingErrors(false);
      setErrorLogsError('');
    };
    const invalidateSession = () => {
      requests.session.invalidate();
      requests.errors.invalidate();
      requests.viewer.invalidate();
    };

    // Store subscriptions invalidate synchronously, before a response can beat effect cleanup.
    const unsubscribeAuth = useAuthStore.subscribe((next, previous) => {
      if (
        next.apiBase === previous.apiBase &&
        next.managementKey === previous.managementKey &&
        next.connectionStatus === previous.connectionStatus &&
        next.isAuthenticated === previous.isAuthenticated
      )
        return;
      invalidateSession();
      resetErrors();
      dispatchErrorLogViewer({ type: 'close' });
      setViewerRequestId(null);
      setRequestLogDownloading(false);
    });
    const unsubscribeConfig = useConfigStore.subscribe((next, previous) => {
      if ((next.config?.requestLog ?? false) !== (previous.config?.requestLog ?? false))
        resetErrors();
    });
    return () => {
      unsubscribeAuth();
      unsubscribeConfig();
      invalidateSession();
    };
  }, [requests]);

  useEffect(() => {
    if (activeTab !== 'errors') return;
    if (connectionStatus !== 'connected') return;
    void loadErrorLogs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, connectionStatus, apiBase, managementKey, requestLogEnabled]);

  const [parseEntries] = useState(createLogParserCache);
  const entries = useMemo(() => parseEntries(logBuffer), [logBuffer, parseEntries]);
  const [levelFilter, setLevelFilter] = useState('');
  const trimmedSearchQuery = deferredSearchQuery.trim();
  const isSearching = trimmedSearchQuery.length > 0;
  const parsedSearchLines = useMemo(
    () => searchLogEntries(entries, trimmedSearchQuery, hideManagementLogs),
    [entries, trimmedSearchQuery, hideManagementLogs]
  );

  const filters = useLogFilters({ parsedLines: parsedSearchLines });
  const structuredFiltersPanelId = 'logs-structured-filters';
  const structuredFilterCount =
    filters.methodFilters.length + filters.statusFilters.length + filters.pathFilters.length;

  const filteredParsedLines = useMemo(
    () =>
      filterLogEntries(parsedSearchLines, {
        methods: filters.methodFilterSet,
        statuses: filters.statusFilterSet,
        paths: filters.pathFilterSet,
        level: levelFilter,
      }),
    [
      parsedSearchLines,
      filters.methodFilterSet,
      filters.statusFilterSet,
      filters.pathFilterSet,
      levelFilter,
    ]
  );
  const removedCount = logBuffer.buffer.length - filteredParsedLines.length;
  const filteredLines = useMemo(
    () => filteredParsedLines.map((line) => line.raw),
    [filteredParsedLines]
  );
  const logState = useMemo<LogState>(
    () => ({
      buffer: filteredLines,
      visibleFrom: Math.max(0, filteredLines.length - visibleCount),
    }),
    [filteredLines, visibleCount]
  );
  const setLogState: Dispatch<SetStateAction<LogState>> = (update) => {
    const next = typeof update === 'function' ? update(logState) : update;
    setVisibleCount(next.buffer.length - next.visibleFrom);
  };
  useEffect(() => {
    setVisibleCount(INITIAL_DISPLAY_LINES);
  }, [
    setVisibleCount,
    trimmedSearchQuery,
    hideManagementLogs,
    levelFilter,
    filters.methodFilterSet,
    filters.statusFilterSet,
    filters.pathFilterSet,
  ]);
  const parsedVisibleLines = filteredParsedLines.slice(logState.visibleFrom);

  const {
    canLoadMore,
    handleLogScroll,
    logViewerRef,
    requestScrollToBottom,
    isFollowing,
    resumeFollowing,
    pendingLines,
    historyEvicted,
  } = useLogScroller({
    logState,
    setLogState,
    bufferStart: logBuffer.bufferStart,
    loading,
    isSearching,
    filteredLineCount: filteredLines.length,
    hasStructuredFilters: filters.hasStructuredFilters,
    showRawLogs,
    wrapLogs,
  });

  const copyLogLine = async (raw: string) => {
    const ok = await copyToClipboard(raw);
    if (ok) {
      showNotification(t('logs.copy_success', { defaultValue: 'Copied to clipboard' }), 'success');
    } else {
      showNotification(t('logs.copy_failed', { defaultValue: 'Copy failed' }), 'error');
    }
  };

  const downloadRequestLog = async (id: string) => {
    const session = requests.session.capture();
    setRequestLogDownloading(true);
    try {
      const response = await logsApi.downloadRequestLogById(id);
      if (!requests.session.isCurrent(session)) return;
      downloadBlob({
        filename: `request-${id}.log`,
        blob: new Blob([response.data], { type: 'text/plain' }),
      });
      showNotification(t('logs.request_log_download_success'), 'success');
    } catch (err: unknown) {
      if (!requests.session.isCurrent(session)) return;
      const message = getErrorMessage(err);
      showNotification(
        `${t('notification.download_failed')}${message ? `: ${message}` : ''}`,
        'error'
      );
    } finally {
      if (requests.session.isCurrent(session)) setRequestLogDownloading(false);
    }
  };

  useEffect(() => {
    if (!fullscreenLogs) return;

    document.body.classList.add('logs-fullscreen-active');
    lockScroll();

    const handleEscape = (event: KeyboardEvent) => {
      if (!shouldExitLogFullscreen(event, !!document.querySelector('.modal-overlay'))) return;
      setFullscreenLogs(false);
    };

    document.addEventListener('keydown', handleEscape);

    return () => {
      document.removeEventListener('keydown', handleEscape);
      document.body.classList.remove('logs-fullscreen-active');
      unlockScroll();
    };
  }, [fullscreenLogs]);

  const levelClass = (level?: string) =>
    level === 'warn'
      ? styles.levelWarn
      : level === 'error' || level === 'fatal'
        ? styles.levelError
        : level === 'info'
          ? styles.levelInfo
          : styles.levelMuted;

  const statusClass = (code: number) =>
    code < 300
      ? styles.statusOk
      : code < 400
        ? styles.statusInfo
        : code < 500
          ? styles.statusWarn
          : styles.statusError;

  const sourceSelect = (
    <Select
      className={styles.sourceSelect}
      size="sm"
      fullWidth={false}
      value={activeTab}
      ariaLabel={t('logs.source')}
      onChange={(value) => {
        if (value === 'errors') setFullscreenLogs(false);
        setActiveTab(value as TabType);
      }}
      options={[
        { value: 'logs', label: t('logs.source_live') },
        { value: 'errors', label: t('logs.source_errors') },
      ]}
    />
  );

  const fileLoggingOff = (
    <EmptyState
      icon={<IconSidebarLogs size={16} />}
      title={t('logs.file_logging_off_title')}
      description={
        <Trans
          i18nKey={
            cpaNeedsFileLogging ? 'logs.file_logging_off_desc' : 'logs.file_logging_off_desc_remote'
          }
          components={{ strong: <strong /> }}
        />
      }
      action={
        cpaNeedsFileLogging ? (
          <Link className="btn btn-secondary btn-sm" to="/config?field=loggingToFile">
            {t('logs.open_settings')}
          </Link>
        ) : undefined
      }
    />
  );

  return (
    <div className={styles.container}>
      <PageHeader title={t('logs.title')} description={t('logs.description')} />

      {activeTab === 'logs' && (
        <div
          className={[styles.logCard, fullscreenLogs ? styles.logCardFullscreen : '']
            .filter(Boolean)
            .join(' ')}
        >
          <Toolbar
            ariaLabel={t('logs.toolbar')}
            className={styles.filters}
            end={
              <>
                <Button
                  variant="secondary"
                  size="sm"
                  aria-pressed={isFollowing}
                  onClick={resumeFollowing}
                  disabled={showFileLoggingRequired}
                >
                  {isFollowing || pendingLines === 0
                    ? t('logs.follow')
                    : t('logs.follow_new', { count: pendingLines })}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  aria-pressed={autoRefresh}
                  onClick={() => setAutoRefresh(!autoRefresh)}
                  disabled={autoRefreshDisabled}
                >
                  {autoRefresh ? t('logs.pause') : t('logs.resume')}
                </Button>
                <IconButton
                  variant="ghost"
                  size="sm"
                  aria-label={t('logs.wrap_lines')}
                  aria-pressed={wrapLogs}
                  className={styles.toggle}
                  icon={<IconRows3 size={16} />}
                  onClick={() => setWrapLogs(!wrapLogs)}
                />
                <IconButton
                  variant="ghost"
                  size="sm"
                  aria-label={t('logs.refresh_button')}
                  icon={<IconRefreshCw size={16} />}
                  onClick={() => loadLogs(false)}
                  disabled={refreshDisabled}
                />
                <IconButton
                  variant="ghost"
                  size="sm"
                  aria-label={t('logs.download_cached')}
                  icon={<IconDownload size={16} />}
                  onClick={downloadLogs}
                  disabled={logBuffer.buffer.length === 0}
                />
                <IconButton
                  variant="ghost"
                  size="sm"
                  aria-label={t('logs.clear_button')}
                  icon={<IconTrash2 size={16} />}
                  onClick={clearLogs}
                  disabled={clearDisabled}
                />
                <IconButton
                  variant="ghost"
                  size="sm"
                  aria-pressed={fullscreenLogs}
                  aria-label={
                    fullscreenLogs ? t('logs.exit_fullscreen_button') : t('logs.fullscreen_button')
                  }
                  icon={fullscreenLogs ? <IconMinimize2 size={16} /> : <IconMaximize2 size={16} />}
                  onClick={() => setFullscreenLogs((prev) => !prev)}
                />
              </>
            }
          >
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t('logs.search_placeholder')}
              aria-label={t('logs.search_placeholder')}
              className={styles.searchInput}
              rightElement={
                searchQuery ? (
                  <IconButton
                    size="sm"
                    variant="ghost"
                    aria-label={t('logs.clear_search')}
                    icon={<IconX size={14} />}
                    onClick={() => setSearchQuery('')}
                  />
                ) : (
                  <IconSearch size={14} className={styles.searchIcon} />
                )
              }
            />
            <Select
              className={styles.levelSelect}
              size="sm"
              fullWidth={false}
              value={levelFilter}
              onChange={setLevelFilter}
              ariaLabel={t('logs.level_filter')}
              options={[
                { value: '', label: t('logs.all_levels') },
                ...['trace', 'debug', 'info', 'warn', 'error', 'fatal'].map((level) => ({
                  value: level,
                  label: t(`logs.level_${level}`),
                })),
              ]}
            />
            {sourceSelect}
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setStructuredFiltersExpanded((prev) => !prev)}
              aria-haspopup="dialog"
            >
              <span className={styles.buttonContent}>
                <IconSlidersHorizontal size={14} />
                {t('logs.filter_panel_title')}
                {structuredFilterCount > 0 && <Badge tone="info">{structuredFilterCount}</Badge>}
              </span>
            </Button>
          </Toolbar>

          <Modal
            open={structuredFiltersExpanded}
            onClose={() => setStructuredFiltersExpanded(false)}
            title={t('logs.filter_panel_title')}
            width={640}
            footer={
              <Button variant="secondary" onClick={() => setStructuredFiltersExpanded(false)}>
                {t('common.close')}
              </Button>
            }
          >
            <div id={structuredFiltersPanelId} className={styles.structuredFilters}>
              <div className={styles.filterChipGroup}>
                <span className={styles.filterChipLabel}>{t('logs.filter_method')}</span>
                <div className={styles.filterChipList}>
                  {HTTP_METHODS.map((method) => {
                    const active = filters.methodFilters.includes(method);
                    const count = filters.methodCounts[method] ?? 0;
                    return (
                      <button
                        key={method}
                        type="button"
                        className={`${styles.filterChip} ${active ? styles.filterChipActive : ''}`}
                        onClick={() => filters.toggleMethodFilter(method)}
                        disabled={count === 0 && !active}
                        aria-pressed={active}
                      >
                        {method} <span className={styles.chipCount}>{count}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className={styles.filterChipGroup}>
                <span className={styles.filterChipLabel}>{t('logs.filter_status')}</span>
                <div className={styles.filterChipList}>
                  {STATUS_GROUPS.map((statusGroup) => {
                    const active = filters.statusFilters.includes(statusGroup);
                    const count = filters.statusCounts[statusGroup] ?? 0;
                    return (
                      <button
                        key={statusGroup}
                        type="button"
                        className={`${styles.filterChip} ${active ? styles.filterChipActive : ''}`}
                        onClick={() => filters.toggleStatusFilter(statusGroup)}
                        disabled={count === 0 && !active}
                        aria-pressed={active}
                      >
                        {t(`logs.filter_status_${statusGroup}`)}{' '}
                        <span className={styles.chipCount}>{count}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className={styles.filterChipGroup}>
                <span className={styles.filterChipLabel}>{t('logs.filter_path')}</span>
                <div className={styles.filterChipList}>
                  {filters.pathOptions.length === 0 ? (
                    <span className={styles.filterChipHint}>{t('logs.filter_path_empty')}</span>
                  ) : (
                    filters.pathOptions.map(({ path, count }) => {
                      const active = filters.pathFilters.includes(path);
                      return (
                        <button
                          key={path}
                          type="button"
                          className={`${styles.filterChip} ${active ? styles.filterChipActive : ''}`}
                          onClick={() => filters.togglePathFilter(path)}
                          aria-pressed={active}
                        >
                          {path} <span className={styles.chipCount}>{count}</span>
                        </button>
                      );
                    })
                  )}
                </div>
              </div>

              <div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={filters.clearStructuredFilters}
                  disabled={!filters.hasStructuredFilters}
                >
                  {t('logs.clear_filters')}
                </Button>
              </div>
            </div>

            <div className={styles.displayOptions}>
              <ToggleSwitch
                checked={wrapLogs}
                onChange={setWrapLogs}
                label={t('logs.wrap_lines')}
              />
              <ToggleSwitch
                checked={hideManagementLogs}
                onChange={setHideManagementLogs}
                label={t('logs.hide_management_logs', { prefix: MANAGEMENT_API_PREFIX })}
              />
              <ToggleSwitch
                checked={showRawLogs}
                onChange={setShowRawLogs}
                label={t('logs.show_raw_logs')}
              />
            </div>
          </Modal>

          {error && (
            <div className={`error-box ${styles.banner}`} role="alert">
              {error}
            </div>
          )}
          <div className={styles.notices}>
            {wasReset && (
              <div className="hint" role="status">
                {t('logs.cursor_reset_notice')}
              </div>
            )}
            {historyEvicted && (
              <div className="hint" role="status">
                {t('logs.history_evicted')}
              </div>
            )}
          </div>

          <div className={styles.viewerArea}>
            {loading && logBuffer.buffer.length === 0 ? (
              <div className={styles.skeleton} aria-busy="true">
                {Array.from({ length: 8 }, (_, index) => (
                  <Skeleton key={index} height={14} width={`${90 - ((index * 13) % 40)}%`} />
                ))}
                <span className="sr-only">{t('logs.loading')}</span>
              </div>
            ) : logBuffer.buffer.length > 0 && filteredLines.length > 0 ? (
              <div
                ref={logViewerRef}
                className={[
                  styles.logPanel,
                  wrapLogs ? styles.wrapped : '',
                  fullscreenLogs ? styles.logPanelFullscreen : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                onScroll={handleLogScroll}
                tabIndex={0}
                role="region"
                aria-label={t('logs.log_content')}
                aria-busy={loading}
              >
                {canLoadMore && (
                  <div className={styles.loadMoreBanner}>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() =>
                        setVisibleCount((count) => Math.min(filteredLines.length, count + 200))
                      }
                    >
                      {t('logs.filter_load_more')}
                    </Button>
                    <div className={styles.loadMoreStats}>
                      <span>{t('logs.loaded_lines', { count: parsedVisibleLines.length })}</span>
                      {removedCount > 0 && (
                        <span>{t('logs.filtered_lines', { count: removedCount })}</span>
                      )}
                      <span>{t('logs.hidden_lines', { count: logState.visibleFrom })}</span>
                    </div>
                  </div>
                )}
                {showRawLogs ? (
                  <pre className={styles.rawLog} spellCheck={false}>
                    {parsedVisibleLines.map((line) => (
                      <span key={line.id} data-log-id={line.id} className={styles.rawLine}>
                        {line.raw || ' '}
                      </span>
                    ))}
                  </pre>
                ) : (
                  <div className={styles.logList}>
                    {parsedVisibleLines.map((line) => (
                      <div
                        key={line.id}
                        data-log-id={line.id}
                        className={[
                          styles.logRow,
                          line.level === 'warn' ? styles.rowWarn : '',
                          line.level === 'error' || line.level === 'fatal' ? styles.rowError : '',
                        ]
                          .filter(Boolean)
                          .join(' ')}
                        onDoubleClick={() => {
                          void copyLogLine(line.raw);
                        }}
                      >
                        <span className={styles.timestamp}>{line.timestamp || ''}</span>
                        <span className={styles.rowMain}>
                          <span className={`${styles.level} ${levelClass(line.level)}`}>
                            {line.level ?? ''}
                          </span>
                          {line.source && <span className={styles.source}>{line.source}</span>}
                          {line.requestId && (
                            <button
                              type="button"
                              className={styles.requestId}
                              aria-label={t('logs.view_request', { id: line.requestId })}
                              onClick={() =>
                                void openErrorLog(
                                  { name: `request-${line.requestId}.log` },
                                  line.requestId
                                )
                              }
                            >
                              {line.requestId}
                            </button>
                          )}
                          {typeof line.statusCode === 'number' && (
                            <span className={statusClass(line.statusCode)}>{line.statusCode}</span>
                          )}
                          {line.latency && <span className={styles.muted}>{line.latency}</span>}
                          {line.ip && <span className={styles.muted}>{line.ip}</span>}
                          {line.method && <span className={styles.method}>{line.method}</span>}
                          {line.path && <span className={styles.path}>{line.path}</span>}
                          {line.message && <span className={styles.message}>{line.message}</span>}
                          <Button
                            variant="ghost"
                            size="sm"
                            className={styles.copyButton}
                            onClick={() => void copyLogLine(line.raw)}
                            aria-label={t('logs.copy_line')}
                          >
                            <IconCopy size={14} />
                          </Button>
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : logBuffer.buffer.length > 0 ? (
              <EmptyState
                title={t('logs.search_empty_title')}
                description={t('logs.search_empty_desc')}
              />
            ) : showFileLoggingRequired ? (
              fileLoggingOff
            ) : (
              <EmptyState title={t('logs.empty_title')} description={t('logs.empty_desc')} />
            )}
          </div>

          <footer className={styles.statusBar}>
            <div
              className={styles.readStatus}
              role="status"
              data-live={autoRefresh && !disableControls}
            >
              <span className={styles.statusDot} aria-hidden="true" />
              {t(
                catchingUp && autoRefresh
                  ? 'logs.read_status_catching_up'
                  : autoRefresh
                    ? 'logs.read_status_live'
                    : 'logs.read_status_paused'
              )}
              {lastUpdated && (
                <>
                  {' · '}
                  {t('logs.last_updated', { time: new Date(lastUpdated).toLocaleTimeString() })}
                </>
              )}
            </div>
            <div className={styles.bufferStatus}>
              {t('logs.buffer_scope', {
                count: logBuffer.buffer.length,
                matched: filteredLines.length,
              })}
            </div>
          </footer>
        </div>
      )}

      {activeTab === 'errors' && (
        <div className={styles.errorCard}>
          <Toolbar
            ariaLabel={t('logs.toolbar')}
            className={styles.filters}
            end={
              <Button
                variant="secondary"
                size="sm"
                onClick={loadErrorLogs}
                loading={loadingErrors}
                disabled={disableControls}
              >
                {t('common.refresh')}
              </Button>
            }
          >
            {sourceSelect}
            <span className={styles.toolbarHint}>{t('logs.error_logs_description')}</span>
          </Toolbar>

          <div className={styles.errorBody}>
            {requestLogEnabled && (
              <div className={`hint ${styles.banner}`} role="note">
                {t('logs.error_logs_request_log_enabled')}
              </div>
            )}
            {errorLogsError && (
              <div className={`error-box ${styles.errorRow}`} role="alert">
                <span>{errorLogsError}</span>
                <Button variant="secondary" size="sm" onClick={loadErrorLogs}>
                  {t('logs.retry')}
                </Button>
              </div>
            )}

            <div className={styles.errorPanel}>
              {loadingErrors ? (
                <div className={styles.skeleton} aria-busy="true">
                  <Skeleton height={36} />
                  <Skeleton height={36} />
                  <Skeleton height={36} />
                </div>
              ) : errorLogs.length === 0 ? (
                errorLogsError ? null : (
                  <EmptyState
                    title={t('logs.error_logs_empty')}
                    description={t('logs.error_logs_empty_desc')}
                  />
                )
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('logs.error_logs_file')}</TableHead>
                      <TableHead alignRight>{t('logs.error_logs_size')}</TableHead>
                      <TableHead>{t('logs.error_logs_modified')}</TableHead>
                      <TableHead alignRight>
                        <span className="sr-only">{t('logs.actions')}</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {errorLogs.map((item) => (
                      <TableRow key={item.name}>
                        <TableCell className={`mono ${styles.fileName}`}>{item.name}</TableCell>
                        <TableCell alignRight>
                          {item.size ? `${(item.size / 1024).toFixed(1)} KB` : '—'}
                        </TableCell>
                        <TableCell>
                          {item.modified ? formatUnixTimestamp(item.modified) : '—'}
                        </TableCell>
                        <TableCell alignRight>
                          <span className={styles.rowActions}>
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => {
                                void openErrorLog(item);
                              }}
                              disabled={disableControls}
                            >
                              {t('logs.error_logs_open')}
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => downloadErrorLog(item.name)}
                              disabled={disableControls}
                            >
                              {t('logs.error_logs_download')}
                            </Button>
                          </span>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>
          </div>
        </div>
      )}

      <Modal
        open={errorLogViewer.status !== 'closed'}
        onClose={closeErrorLogViewer}
        title={selectedErrorLog?.name ?? t('logs.error_log_view_title')}
        width={960}
        footer={
          <>
            <Button variant="secondary" onClick={closeErrorLogViewer}>
              {t('common.close')}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                void copySelectedErrorLog();
              }}
              disabled={errorLogViewer.status !== 'ready' || !errorLogViewer.text}
            >
              {t('common.copy')}
            </Button>
            <Button
              onClick={() => {
                if (viewerRequestId) void downloadRequestLog(viewerRequestId);
                else if (selectedErrorLog) void downloadErrorLog(selectedErrorLog.name);
              }}
              loading={requestLogDownloading}
              disabled={errorLogViewer.status === 'closed' || errorLogViewer.status === 'loading'}
            >
              {t('logs.error_logs_download')}
            </Button>
          </>
        }
      >
        <div className={styles.errorLogViewer}>
          {selectedErrorLog && (
            <div className={styles.errorLogViewerMeta}>
              <span>
                {t('logs.error_logs_size')}:{' '}
                {selectedErrorLog.size ? `${(selectedErrorLog.size / 1024).toFixed(1)} KB` : '—'}
              </span>
              <span>
                {t('logs.error_logs_modified')}:{' '}
                {selectedErrorLog.modified ? formatUnixTimestamp(selectedErrorLog.modified) : '—'}
              </span>
            </div>
          )}
          {errorLogViewer.status === 'error' && (
            <div className="error-box">{errorLogViewer.message}</div>
          )}
          {errorLogViewer.status === 'loading' && <Skeleton height={240} />}
          {errorLogViewer.status === 'ready' &&
            (errorLogViewer.text ? (
              <pre className={styles.errorLogContent} spellCheck={false}>
                {errorLogViewer.text}
              </pre>
            ) : (
              <div className="hint">{t('logs.error_log_empty_content')}</div>
            ))}
        </div>
      </Modal>
    </div>
  );
}
