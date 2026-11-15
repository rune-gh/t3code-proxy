import { useSyncExternalStore, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Button, IconButton } from '@/components/ui/Button';
import { DropdownMenu, DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/DropdownMenu';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { SelectionCheckbox } from '@/components/ui/SelectionCheckbox';
import { TableCell, TableRow } from '@/components/ui/Table/Table';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { Tooltip } from '@/components/ui/Tooltip';
import {
  IconChevronDown,
  IconDownload,
  IconEllipsis,
  IconModelCluster,
  IconRefreshCw,
  IconSettings,
  IconTimer,
  IconTrash2,
} from '@/components/ui/icons';
import type { AuthFileItem } from '@/types';
import { createSharedClock } from '@/utils/time/sharedClock';
import { formatDateTimeValue, formatFileSize } from '@/utils/format';
import {
  formatModified,
  getAuthFileIcon,
  getThemeSurfaceIconBackground,
  getTypeLabel,
  isRuntimeOnlyAuthFile,
  isThemeSurfaceIconProvider,
  normalizeProviderKey,
  supportsAuthFileManualRefresh,
  type QuotaProviderType,
  type ResolvedTheme,
} from '@/features/authFiles/constants';
import { deriveAuthFileIdentity } from '@/features/authFiles/identity';
import { getAuthFileRefreshKey } from '@/features/authFiles/manualRefresh';
import {
  formatShortDuration,
  resolveAccountPlan,
  resolveAccountStatus,
  summarizeAccountQuota,
  type AccountStatus,
  type AccountStatusKind,
} from '@/features/authFiles/accountRow';
import { getSiwcBindingStatus, supportsSiwcBinding } from '@/features/oauth/siwcBinding';
import { SiwcStatusBadge } from '@/features/oauth/components/SiwcStatusBadge';
import { AuthFileCooldownSection } from './AuthFileCooldownSection';
import { AuthFileQuotaSection, useAccountQuota } from './AuthFileQuotaSection';
import { RequestSparkline } from './RequestSparkline';
import styles from './AccountsTable.module.scss';

// One timer shared by every row that is cooling down; idle rows never subscribe.
const clock = createSharedClock({ intervalMs: 1000 });

const ACCOUNT_TABLE_COLUMNS = 7;

export type AccountRowProps = {
  file: AuthFileItem;
  expanded: boolean;
  selected: boolean;
  resolvedTheme: ResolvedTheme;
  disableControls: boolean;
  deleting: string | null;
  statusUpdating: Record<string, boolean>;
  manualRefreshing: Record<string, boolean>;
  cooldownResetting: Record<string, boolean>;
  quotaType: QuotaProviderType | null;
  /** False when the hub does not serve per-account model lists. */
  modelsAvailable: boolean;
  onToggleExpanded: (key: string) => void;
  onShowModels: (file: AuthFileItem) => void;
  onDownload: (name: string) => void;
  onManualRefresh: (file: AuthFileItem) => void;
  onCooldownReset: (file: AuthFileItem) => void;
  onOpenPrefixProxyEditor: (file: AuthFileItem) => void;
  onDelete: (name: string) => void;
  onToggleStatus: (file: AuthFileItem, enabled: boolean) => void;
  onToggleSelect: (name: string) => void;
  rowKey: string;
};

const STATUS_TONE: Record<AccountStatusKind, BadgeTone> = {
  active: 'success',
  cooling: 'warning',
  disabled: 'neutral',
  error: 'destructive',
  warning: 'warning',
};

/** Provider logo in a 20px tile; first letter when no logo is bundled. */
function ProviderMark({
  provider,
  resolvedTheme,
  label,
}: {
  provider: string;
  resolvedTheme: ResolvedTheme;
  label: string;
}) {
  const src = getAuthFileIcon(provider, resolvedTheme);
  return (
    <span
      className={styles.mark}
      style={
        isThemeSurfaceIconProvider(provider)
          ? { background: getThemeSurfaceIconBackground(resolvedTheme) }
          : undefined
      }
      aria-hidden="true"
    >
      {src ? <img src={src} alt="" /> : label.charAt(0).toUpperCase()}
    </span>
  );
}

const noopSubscribe = () => () => {};
const frozenNow = () => 0;

/**
 * Current time for rows with cooldown records (ticks every second). Other rows read a
 * constant, because their status never depends on the clock.
 */
function useCooldownNow(file: AuthFileItem): number {
  const ticking = Boolean(file.cooldownSnapshot?.records?.length);
  const getSnapshot = ticking ? clock.getSnapshot : frozenNow;
  return useSyncExternalStore(ticking ? clock.subscribe : noopSubscribe, getSnapshot, getSnapshot);
}

function StatusCell({ status }: { status: AccountStatus }) {
  const { t } = useTranslation();
  const label =
    status.kind === 'cooling'
      ? t('auth_files.status_cooling', { time: formatShortDuration(status.cooldownSeconds) })
      : t(`auth_files.status_${status.kind}`);
  const badge = (
    <Badge tone={STATUS_TONE[status.kind]} dot>
      {label}
    </Badge>
  );
  return (
    <div className={styles.status}>
      {status.reason ? (
        <Tooltip content={<span className={styles.reasonTip}>{status.reason}</span>}>
          <span tabIndex={0} className={styles.statusTrigger}>
            {badge}
          </span>
        </Tooltip>
      ) : (
        badge
      )}
      {status.coolingModels > 0 && status.kind !== 'disabled' ? (
        <span className={styles.subtle}>
          {t('auth_files.status_models_cooling', { count: status.coolingModels })}
        </span>
      ) : null}
    </div>
  );
}

function RequestsCell({ file }: { file: AuthFileItem }) {
  const { t } = useTranslation();
  const buckets = file.recentRequests ?? [];
  const success = buckets.reduce((sum, bucket) => sum + bucket.success, 0);
  const failed = buckets.reduce((sum, bucket) => sum + bucket.failed, 0);
  const title = t('auth_files.requests_tooltip', {
    success: file.successCount ?? 0,
    failed: file.failureCount ?? 0,
  });
  return (
    <div className={styles.requests} title={title}>
      <RequestSparkline buckets={buckets} />
      <span className={styles.requestCounts}>
        <span>{success.toLocaleString()}</span>
        {failed > 0 ? (
          <span className={styles.failed}>
            {t('auth_files.requests_failed', { count: failed })}
          </span>
        ) : null}
      </span>
    </div>
  );
}

function QuotaCell({
  file,
  quotaType,
  disableControls,
}: {
  file: AuthFileItem;
  quotaType: QuotaProviderType;
  disableControls: boolean;
}) {
  const { t } = useTranslation();
  const { quota, quotaStatus, canRefreshQuota, refreshQuotaForFile } = useAccountQuota(
    file,
    quotaType,
    disableControls
  );
  const summary = summarizeAccountQuota(quota as Parameters<typeof summarizeAccountQuota>[0]);

  if (quotaStatus === 'loading') {
    return <LoadingSpinner size={14} />;
  }
  if (summary) {
    const tone =
      summary.remaining <= 10 ? styles.meterLow : summary.remaining <= 30 ? styles.meterMid : '';
    return (
      <div className={styles.quota} title={summary.label}>
        <span className={styles.meter} aria-hidden="true">
          <span className={`${styles.meterFill} ${tone}`} style={{ width: `${summary.remaining}%` }} />
        </span>
        <span>{t('auth_files.quota_left', { percent: Math.round(summary.remaining) })}</span>
      </div>
    );
  }
  if (quotaStatus === 'error') {
    return (
      <Tooltip content={quota?.error || t('common.unknown_error')}>
        <span tabIndex={0} className={styles.quotaError}>
          {t('auth_files.quota_unavailable')}
        </span>
      </Tooltip>
    );
  }
  if (quotaStatus === 'success') {
    return <span className={styles.subtle}>{t('auth_files.quota_loaded')}</span>;
  }
  return (
    <Button
      variant="ghost"
      size="sm"
      className={styles.inlineAction}
      onClick={() => void refreshQuotaForFile()}
      disabled={!canRefreshQuota}
    >
      {t('auth_files.quota_load')}
    </Button>
  );
}

/** One account: a dense table row plus, when expanded, a full-width details row. */
export function AccountRow(props: AccountRowProps) {
  const { t, i18n } = useTranslation();
  const {
    file,
    expanded,
    selected,
    resolvedTheme,
    disableControls,
    deleting,
    statusUpdating,
    manualRefreshing,
    cooldownResetting,
    quotaType,
    modelsAvailable,
    onToggleExpanded,
    onShowModels,
    onDownload,
    onManualRefresh,
    onCooldownReset,
    onOpenPrefixProxyEditor,
    onDelete,
    onToggleStatus,
    onToggleSelect,
    rowKey,
  } = props;

  const isRuntimeOnly = isRuntimeOnlyAuthFile(file);
  const providerKey = normalizeProviderKey(String(file.type ?? file.provider ?? 'unknown'));
  const typeLabel = getTypeLabel(t, providerKey);
  const identity = deriveAuthFileIdentity(file);
  const refreshKey = getAuthFileRefreshKey(file);
  const isStatusUpdating = statusUpdating[refreshKey] === true;
  const isManualRefreshing = manualRefreshing[refreshKey] === true;
  const authIndexKey = typeof file.authIndex === 'string' ? file.authIndex : null;
  const isCooldownResetting = Boolean(authIndexKey && cooldownResetting[authIndexKey]);
  const showModels = modelsAvailable && (!isRuntimeOnly || providerKey === 'aistudio');
  const showManualRefresh = !isRuntimeOnly && supportsAuthFileManualRefresh(providerKey);
  const plan = resolveAccountPlan(file);
  const detailsId = `account-details-${rowKey.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  const hasCooldown = Boolean(file.cooldownSnapshot?.records?.length);
  const noteValue = typeof file.note === 'string' ? file.note.trim() : '';
  const status = resolveAccountStatus(file, useCooldownNow(file));
  const statusMessage = status.reason;

  const handleRowClick = (event: MouseEvent<HTMLTableRowElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest('button, a, input, label, [role="menu"], [tabindex]')) return;
    if (window.getSelection()?.toString()) return;
    onToggleExpanded(rowKey);
  };

  const rowClasses = [
    styles.row,
    expanded ? styles.rowExpanded : '',
    file.disabled === true ? styles.rowDisabled : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <>
      <TableRow className={rowClasses} selected={selected} onClick={handleRowClick}>
        <TableCell className={styles.cellSelect}>
          {!isRuntimeOnly && (
            <SelectionCheckbox
              checked={selected}
              onChange={() => onToggleSelect(file.name)}
              ariaLabel={t('auth_files.card_select', { name: identity.primary || file.name })}
            />
          )}
        </TableCell>
        <TableCell className={styles.cellAccount}>
          <div className={styles.account}>
            <ProviderMark provider={providerKey} resolvedTheme={resolvedTheme} label={typeLabel} />
            <div className={styles.identity}>
              <button
                type="button"
                className={styles.name}
                aria-expanded={expanded}
                aria-controls={expanded ? detailsId : undefined}
                onClick={() => onToggleExpanded(rowKey)}
                title={identity.primary}
              >
                <span className={identity.kind === 'fileName' ? 'mono' : undefined}>
                  {identity.primary}
                </span>
                <IconChevronDown size={14} className={styles.chevron} aria-hidden="true" />
              </button>
              <span className={styles.secondary}>
                <span>{typeLabel}</span>
                {plan ? <span>{plan}</span> : null}
                {isRuntimeOnly ? <span>{t('auth_files.type_virtual')}</span> : null}
                {identity.secondary ? (
                  <span className={`mono ${styles.fileName}`} title={identity.fullName}>
                    {identity.secondary}
                  </span>
                ) : null}
              </span>
            </div>
          </div>
        </TableCell>
        <TableCell className={styles.cellStatus}>
          <StatusCell status={status} />
        </TableCell>
        <TableCell className={styles.cellRequests}>
          <RequestsCell file={file} />
        </TableCell>
        <TableCell className={styles.cellQuota}>
          {quotaType && !isRuntimeOnly ? (
            <QuotaCell file={file} quotaType={quotaType} disableControls={disableControls} />
          ) : (
            <span className={styles.subtle} aria-label={t('auth_files.quota_none')}>
              —
            </span>
          )}
        </TableCell>
        <TableCell className={styles.cellSwitch}>
          {!isRuntimeOnly && (
            <ToggleSwitch
              ariaLabel={t('auth_files.card_toggle', { name: identity.primary || file.name })}
              checked={!file.disabled}
              disabled={disableControls || isStatusUpdating || isManualRefreshing}
              onChange={(value) => onToggleStatus(file, value)}
            />
          )}
        </TableCell>
        <TableCell className={styles.cellMenu}>
          <DropdownMenu
            ariaLabel={t('auth_files.row_menu', { name: identity.primary || file.name })}
            minWidth={200}
            trigger={
              <IconButton
                size="sm"
                aria-label={t('auth_files.row_menu', { name: identity.primary || file.name })}
                icon={<IconEllipsis size={16} />}
              />
            }
          >
            {showModels && (
              <DropdownMenuItem
                icon={<IconModelCluster size={16} />}
                onSelect={() => onShowModels(file)}
                disabled={disableControls}
              >
                {t('auth_files.models_button')}
              </DropdownMenuItem>
            )}
            {!isRuntimeOnly && (
              <DropdownMenuItem
                icon={<IconSettings size={16} />}
                onSelect={() => onOpenPrefixProxyEditor(file)}
                disabled={disableControls || isManualRefreshing}
              >
                {t('auth_files.prefix_proxy_button')}
              </DropdownMenuItem>
            )}
            {showManualRefresh && (
              <DropdownMenuItem
                icon={<IconRefreshCw size={16} />}
                onSelect={() => onManualRefresh(file)}
                disabled={
                  disableControls || file.disabled === true || isStatusUpdating || isManualRefreshing
                }
              >
                {t('auth_files.manual_refresh_button')}
              </DropdownMenuItem>
            )}
            {hasCooldown && authIndexKey && (
              <DropdownMenuItem
                icon={<IconTimer size={16} />}
                onSelect={() => onCooldownReset(file)}
                disabled={
                  disableControls || isStatusUpdating || isManualRefreshing || isCooldownResetting
                }
              >
                {t('auth_files.cooldown_reset_button')}
              </DropdownMenuItem>
            )}
            {!isRuntimeOnly && (
              <DropdownMenuItem
                icon={<IconDownload size={16} />}
                onSelect={() => onDownload(file.name)}
                disabled={disableControls}
              >
                {t('auth_files.download_button')}
              </DropdownMenuItem>
            )}
            {!isRuntimeOnly && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  icon={<IconTrash2 size={16} />}
                  destructive
                  onSelect={() => onDelete(file.name)}
                  disabled={disableControls || deleting === file.name || isManualRefreshing}
                >
                  {t('auth_files.delete_button')}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenu>
        </TableCell>
      </TableRow>
      {expanded && (
        <tr className={styles.detailsRow} id={detailsId}>
          <td colSpan={ACCOUNT_TABLE_COLUMNS}>
            <div className={styles.details}>
              <dl className={styles.facts}>
                <div>
                  <dt>{t('auth_files.detail_file')}</dt>
                  <dd className="mono" title={identity.fullName}>
                    {identity.fullName || '—'}
                  </dd>
                </div>
                <div>
                  <dt>{t('auth_files.detail_provider')}</dt>
                  <dd>
                    {typeLabel}
                    {plan ? ` · ${plan}` : ''}
                  </dd>
                </div>
                <div>
                  <dt>{t('auth_files.file_modified')}</dt>
                  <dd>{formatModified(file)}</dd>
                </div>
                <div>
                  <dt>{t('auth_files.file_size')}</dt>
                  <dd>{file.size ? formatFileSize(file.size) : '—'}</dd>
                </div>
                <div>
                  <dt>{t('auth_files.detail_requests')}</dt>
                  <dd>
                    {t('auth_files.requests_tooltip', {
                      success: file.successCount ?? 0,
                      failed: file.failureCount ?? 0,
                    })}
                  </dd>
                </div>
                {Number.isSafeInteger(file.priority) && (
                  <div>
                    <dt>{t('auth_files.priority_display')}</dt>
                    <dd title={t('auth_files.priority_hint')}>{file.priority}</dd>
                  </div>
                )}
                {Number.isSafeInteger(file.weight) && (
                  <div>
                    <dt>{t('auth_files.weight_display')}</dt>
                    <dd title={t('auth_files.weight_tooltip')}>{file.weight}</dd>
                  </div>
                )}
                {noteValue && (
                  <div>
                    <dt>{t('auth_files.note_label')}</dt>
                    <dd>{noteValue}</dd>
                  </div>
                )}
                {supportsSiwcBinding(file) && (
                  <div>
                    <dt>SIWC</dt>
                    <dd className={styles.siwc}>
                      <SiwcStatusBadge status={getSiwcBindingStatus(file)} withLabel={false} />
                      {file.siwcExpiresAt ? (
                        <span className={styles.subtle}>
                          {t('siwc.expires', {
                            date: formatDateTimeValue(file.siwcExpiresAt, i18n.language),
                          })}
                        </span>
                      ) : null}
                    </dd>
                  </div>
                )}
              </dl>

              {statusMessage && (
                <div className={styles.detailBlock}>
                  <h3 className={styles.detailTitle}>{t('auth_files.detail_message')}</h3>
                  <p className={styles.message}>{statusMessage}</p>
                </div>
              )}

              {file.cooldownSnapshot && file.cooldownSnapshot.records?.length !== 0 && (
                <div className={styles.detailBlock}>
                  <AuthFileCooldownSection
                    snapshot={file.cooldownSnapshot}
                    resetting={isCooldownResetting}
                    resetDisabled={disableControls || isStatusUpdating || isManualRefreshing}
                    onReset={authIndexKey ? () => onCooldownReset(file) : undefined}
                  />
                </div>
              )}

              {quotaType && !isRuntimeOnly && (
                <div className={styles.detailBlock}>
                  <h3 className={styles.detailTitle}>{t('auth_files.detail_quota')}</h3>
                  <AuthFileQuotaSection
                    file={file}
                    quotaType={quotaType}
                    disableControls={disableControls}
                  />
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
