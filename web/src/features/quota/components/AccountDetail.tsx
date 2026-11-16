/**
 * An account's full quota read, opened from its row in an accounts table.
 * Everything the old per-account card showed lives here, in the table's own
 * visual language: the provider body (plan, every window with its reset,
 * xAI usage breakdown and pay-as-you-go, Antigravity groups and their models,
 * Codex banked resets and credit overage, Claude extra usage), the read's
 * error, and the per-account actions (read again, Claude reset grants, Codex
 * reset quota).
 *
 * Accounts the hub records without a credential file (API keys such as
 * Mistral) have no live read; `HistoryAccountDetail` lists their recorded
 * windows instead.
 */

import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { IconRefreshCw } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/Skeleton';
import type { ClaudeQuotaState, CodexQuotaState } from '@/types';
import { resolveQuotaErrorMessage } from '@/utils/quota';
import { getQuotaDisplayName } from '@/utils/quota/identity';
import { bindQuotaClasses } from '../types';
import { QUOTA_ADAPTERS, type QuotaCardState } from '../providers';
import { isQuotaRefreshDisabled, type QuotaFileEntry } from '../logic';
import { useClaudeResetGrants } from '../providers/claude/ClaudeResetGrants';
import { ClaudeResetGrantDialog } from '../providers/claude/ClaudeResetGrantDialog';
import { ClaudeResetGrantDetails } from '../providers/claude/ClaudeResetGrantDetails';
import { hasClaudeUsageData } from '../providers/claude/data';
import { CodexCreditOverageDialog } from '../providers/codex/CodexCreditOverageDialog';
import { CodexCreditOverageRow } from '../providers/codex/CodexCreditOverageRow';
import { useCodexCreditOverage } from '../providers/codex/useCodexCreditOverage';
import type { WindowReading } from '../accountRows';
import {
  formatDuration,
  formatMoney,
  formatPoolPercent,
  formatResetInstant,
  formatWeekdayTime,
} from '../poolFormat';
import detailStyles from './AccountDetail.module.scss';

/** The provider bodies, dressed for a table row rather than a card. */
const quotaClasses = bindQuotaClasses(detailStyles, 'AccountDetail.module.scss');

export interface AccountDetailProps {
  entry: QuotaFileEntry;
  quota?: QuotaCardState;
  canRefresh: boolean;
  resetting: boolean;
  /** Codex only: credentials in the panel sharing this account user's credit setting. */
  creditOverageSharedCount?: number;
  onRefresh: () => void;
  onReset: () => void;
  /** The hub's recorded windows, shown until a live read replaces them. */
  recorded?: HistoryAccountDetailProps;
}

export function AccountDetail(props: AccountDetailProps) {
  const {
    entry,
    quota,
    canRefresh,
    resetting,
    creditOverageSharedCount = 1,
    onRefresh,
    onReset,
    recorded,
  } = props;
  const { t } = useTranslation();
  const adapter = QUOTA_ADAPTERS[entry.type];
  const file = entry.file;
  const displayName = getQuotaDisplayName(file);
  const status = quota?.status ?? 'idle';
  const loading = status === 'loading';
  const retainedClaudeUsage =
    entry.type === 'claude' && hasClaudeUsageData(quota as ClaudeQuotaState | undefined);

  const claudeReset = useClaudeResetGrants(
    file,
    entry.type === 'claude' && status !== 'idle',
    !canRefresh || loading || resetting,
    quota,
    onRefresh
  );
  const creditOverage = useCodexCreditOverage(
    file,
    entry.type === 'codex' ? (quota as CodexQuotaState | undefined) : undefined,
    !canRefresh || loading || resetting
  );

  const showClaudeReset = entry.type === 'claude' && status === 'success';
  const claudePlanItems = showClaudeReset ? (
    <span className={quotaClasses.codexPlanItem}>
      <span className={quotaClasses.codexPlanLabel}>{t('claude_reset.remaining')}</span>
      <span className={quotaClasses.codexPlanValue}>{claudeReset.count ?? '--'}</span>
    </span>
  ) : undefined;
  const claudeAfterPlan = showClaudeReset ? (
    <>
      <ClaudeResetGrantDetails grants={claudeReset.grants} classes={quotaClasses} />
      {claudeReset.message && (
        <div role="status" className={quotaClasses.codexResetCreditsError}>
          {t(`claude_reset.${claudeReset.message}`)}
        </div>
      )}
    </>
  ) : undefined;
  const codexAfterPlan = creditOverage.visible ? (
    <CodexCreditOverageRow
      entry={creditOverage.entry}
      classes={quotaClasses}
      disabled={creditOverage.blocked}
      name={displayName}
      onManage={creditOverage.openDialog}
    />
  ) : undefined;
  const showReset =
    status === 'success' &&
    Boolean(adapter.resetQuota) &&
    quota !== undefined &&
    Boolean(adapter.canResetQuota?.(quota));
  const errorMessage = resolveQuotaErrorMessage(
    t,
    quota?.errorStatus,
    quota?.error || t('common.unknown_error')
  );

  const body =
    status === 'idle' ? (
      recorded && recorded.windows.some((line) => line.reading) ? (
        <RecordedWindows {...recorded} />
      ) : (
        <p className={detailStyles.note}>{t(`${adapter.i18nPrefix}.idle`)}</p>
      )
    ) : loading && !retainedClaudeUsage ? (
      <div className={detailStyles.loading} aria-busy="true">
        <span className="sr-only">{t(`${adapter.i18nPrefix}.loading`)}</span>
        <Skeleton height={12} width="60%" />
        <Skeleton height={12} width="45%" />
      </div>
    ) : status === 'error' && !retainedClaudeUsage ? (
      <p className={detailStyles.error} role="alert">
        {t(`${adapter.i18nPrefix}.load_failed`, { message: errorMessage })}
      </p>
    ) : quota ? (
      <>
        {loading && (
          <p role="status" aria-busy="true" className={detailStyles.note}>
            {t(`${adapter.i18nPrefix}.loading`)}
          </p>
        )}
        <adapter.Body
          quota={quota}
          classes={quotaClasses}
          planItems={claudePlanItems}
          afterPlan={entry.type === 'codex' ? codexAfterPlan : claudeAfterPlan}
        />
      </>
    ) : null;

  return (
    <div className={detailStyles.detail}>
      <div className={detailStyles.body}>{body}</div>
      <div className={detailStyles.actions}>
        {entry.type === 'claude' && status !== 'idle' && (
          <Button
            variant="ghost"
            size="sm"
            disabled={claudeReset.blocked}
            onClick={claudeReset.openDialog}
            aria-haspopup="dialog"
          >
            {t(`claude_reset.${claudeReset.buttonLabel}`)}
          </Button>
        )}
        {showReset && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onReset}
            disabled={!canRefresh || loading || resetting}
            loading={resetting}
          >
            {t('codex_quota.reset_button')}
          </Button>
        )}
        <Button
          variant="secondary"
          size="sm"
          onClick={onRefresh}
          disabled={isQuotaRefreshDisabled(canRefresh, loading, resetting || claudeReset.busy)}
          loading={loading}
          title={t('auth_files.quota_refresh_hint')}
        >
          <span className={detailStyles.buttonInner}>
            {!loading && <IconRefreshCw size={14} aria-hidden="true" />}
            {status === 'idle' ? t('quota_pool.read_now') : t('auth_files.quota_refresh_single')}
          </span>
        </Button>
      </div>
      {entry.type === 'claude' && (
        <ClaudeResetGrantDialog
          open={claudeReset.open}
          grants={claudeReset.grants}
          selected={claudeReset.selected}
          canRedeemGrant={claudeReset.canRedeemGrant}
          onSelect={claudeReset.selectGrant}
          busy={claudeReset.busy}
          loading={claudeReset.loading}
          pendingGrantId={claudeReset.pendingGrantId}
          message={claudeReset.message}
          name={displayName}
          onConfirm={() => void claudeReset.confirm()}
          onClose={claudeReset.closeDialog}
        />
      )}
      {creditOverage.context && (
        <CodexCreditOverageDialog
          open={creditOverage.open}
          context={creditOverage.context}
          entry={creditOverage.entry}
          operation={creditOverage.operation}
          writeDisabled={creditOverage.writeDisabled}
          contextCurrent={creditOverage.contextCurrent}
          sharedCredentialCount={creditOverageSharedCount}
          selection={creditOverage.selection}
          pendingTarget={creditOverage.pendingTarget}
          feedback={creditOverage.feedback}
          onSelect={creditOverage.selectValue}
          onSave={() => void creditOverage.save()}
          onClose={creditOverage.closeDialog}
        />
      )}
    </div>
  );
}

export interface HistoryWindowLine {
  key: string;
  label: string;
  reading: WindowReading | null;
}

export interface HistoryAccountDetailProps {
  windows: readonly HistoryWindowLine[];
  /** Newest successful reading. */
  lastReadAt: number | null;
  error: string;
  now: number;
  locale: string;
}

/** Recorded windows of an account the hub reads without a credential file. */
export function HistoryAccountDetail(props: HistoryAccountDetailProps) {
  return (
    <div className={detailStyles.detail}>
      <div className={detailStyles.body}>
        <RecordedWindows {...props} />
      </div>
    </div>
  );
}

/** The hub's recorded reading of each window: what is known before any live read. */
function RecordedWindows({ windows, lastReadAt, error, now, locale }: HistoryAccountDetailProps) {
  const { t } = useTranslation();
  return (
    <>
      {error && (
        <p className={detailStyles.error} role="alert">
          {t('quota_accounts.read_failed_message', { message: error })}
        </p>
      )}
      {windows.map(({ key, label, reading }) => {
        const remaining = reading ? Math.round(reading.remaining) : null;
        const budget = reading?.budget;
        return (
          <div key={key} className={detailStyles.quotaRow}>
            <div className={detailStyles.quotaRowHeader}>
              <span className={detailStyles.quotaModel}>{label}</span>
              <div className={detailStyles.quotaMeta}>
                <span className={detailStyles.quotaPercent}>
                  {remaining === null ? '—' : formatPoolPercent(remaining)}
                </span>
                {budget && remaining !== null && (
                  <span className={detailStyles.quotaAmount}>
                    {t('quota_accounts.money_spent', {
                      spent: formatMoney(
                        (budget.amount * (100 - reading!.remaining)) / 100,
                        budget.currency,
                        locale
                      ),
                      budget: formatMoney(budget.amount, budget.currency, locale),
                    })}
                  </span>
                )}
                {reading?.resetsAt != null && (
                  <span className={detailStyles.quotaReset}>
                    {t('quota_accounts.resets_at', {
                      time: formatResetInstant(reading.resetsAt, now, locale),
                      duration: formatDuration(reading.resetsAt - now),
                    })}
                  </span>
                )}
              </div>
            </div>
            <div className={detailStyles.quotaBar}>
              <div
                className={`${detailStyles.quotaBarFill} ${
                  remaining !== null && remaining < 30
                    ? detailStyles.quotaBarFillLow
                    : detailStyles.quotaBarFillHigh
                }`}
                style={{ width: `${remaining ?? 0}%` }}
              />
            </div>
          </div>
        );
      })}
      {lastReadAt !== null && (
        <p className={detailStyles.note}>
          {t('quota_pool.last_reading', { time: formatWeekdayTime(lastReadAt, locale) })}
        </p>
      )}
    </>
  );
}
