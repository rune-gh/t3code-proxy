/**
 * One row per account under a pool: remaining in each window, the next
 * weekly reset, the soonest-reset-first marker, and (Codex) banked resets.
 * Rows arrive sorted by soonest weekly reset (accountRows.ts).
 */

import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/Table';
import type { PoolAccountRow, WindowReading } from '../accountRows';
import type { CodexCreditsEntry } from '../hooks/useCodexResetCredits';
import type { PoolProvider } from '../poolModel';
import { formatDuration, formatPoolPercent, formatWeekdayTime } from '../poolFormat';
import { formatPlanName } from '../poolPrefs';
import styles from './PoolAccountsTable.module.scss';

export interface PoolAccountsTableProps {
  provider: PoolProvider;
  rows: readonly PoolAccountRow[];
  now: number;
  locale: string;
  /** Codex only: banked reset credits per auth index. */
  credits?: Record<string, CodexCreditsEntry>;
  /** Auth index whose reset is being redeemed. */
  redeeming?: string | null;
  onUseReset?: (row: PoolAccountRow) => void;
}

const meterLevel = (remaining: number) =>
  remaining <= 0 ? 'empty' : remaining < 20 ? 'low' : 'ok';

function Meter({ reading, label }: { reading: WindowReading | null; label: string }) {
  const { t } = useTranslation();
  if (!reading) {
    return (
      <span className={styles.none}>
        <span aria-hidden="true">—</span>
        <span className="sr-only">{t('quota_accounts.no_reading')}</span>
      </span>
    );
  }
  const value = Math.round(reading.remaining);
  const text = t('quota_accounts.percent_left', { value: formatPoolPercent(value) });
  return (
    <span
      className={styles.meter}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value}
      aria-valuetext={text}
    >
      <span className={styles.track} aria-hidden="true">
        <span
          className={styles.fill}
          data-level={meterLevel(value)}
          style={{ width: `${value}%` }}
        />
      </span>
      <span className={styles.meterValue} aria-hidden="true">
        {formatPoolPercent(value)}
      </span>
    </span>
  );
}

export function PoolAccountsTable({
  provider,
  rows,
  now,
  locale,
  credits,
  redeeming,
  onUseReset,
}: PoolAccountsTableProps) {
  const { t } = useTranslation();
  const showScoped = provider === 'claude' && rows.some((row) => row.scopedWeekly);
  const showCredits = provider === 'codex' && Boolean(credits);
  const labels = {
    fiveHour: t('quota_accounts.col_five_hour'),
    weekly: t('quota_accounts.col_weekly'),
    scoped: t('quota_accounts.col_scoped_weekly'),
  };

  const renderCredits = (row: PoolAccountRow) => {
    const entry = credits?.[row.authIndex];
    if (!entry || (entry.status === 'loading' && entry.credits.length === 0)) {
      return <span className={styles.muted}>{t('quota_accounts.credits_loading')}</span>;
    }
    if (entry.status === 'error') {
      return (
        <span className={styles.muted} title={entry.error}>
          {t('quota_accounts.credits_unavailable')}
        </span>
      );
    }
    const count = entry.credits.length;
    return (
      <span className={styles.credits}>
        <span className={styles.creditCount}>{count}</span>
        {count > 0 && onUseReset && (
          <Button
            variant="secondary"
            size="sm"
            disabled={row.disabled || (redeeming !== null && redeeming !== undefined)}
            loading={redeeming === row.authIndex}
            onClick={() => onUseReset(row)}
          >
            {t('quota_accounts.use_reset')}
          </Button>
        )}
      </span>
    );
  };

  return (
    <Table
      className={styles.table}
      aria-label={t('quota_accounts.table_label', {
        provider: provider === 'claude' ? 'Claude' : 'Codex',
      })}
    >
      <TableHeader>
        <TableRow>
          <TableHead>{t('quota_accounts.col_account')}</TableHead>
          <TableHead>{t('quota_accounts.col_plan')}</TableHead>
          <TableHead>{labels.fiveHour}</TableHead>
          <TableHead>{labels.weekly}</TableHead>
          {showScoped && <TableHead>{labels.scoped}</TableHead>}
          <TableHead>{t('quota_accounts.col_next_reset')}</TableHead>
          {showCredits && <TableHead>{t('quota_accounts.col_banked')}</TableHead>}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          const reset = row.weekly?.resetsAt ?? null;
          return (
            <TableRow key={row.authIndex} className={row.disabled ? styles.disabledRow : undefined}>
              <TableCell className={styles.accountCell}>
                <div className={styles.account}>
                  <span className={styles.label} data-sensitive title={row.label}>
                    {row.label}
                  </span>
                  {row.isNext && (
                    <Badge tone="primary" title={t('quota_accounts.next_hint')}>
                      {t('quota_accounts.badge_next')}
                    </Badge>
                  )}
                  {row.disabled ? (
                    <Badge tone="neutral" outline>
                      {t('quota_accounts.badge_disabled')}
                    </Badge>
                  ) : row.exhausted ? (
                    <Badge tone="warning">{t('quota_accounts.badge_exhausted')}</Badge>
                  ) : null}
                  {row.error && (
                    <Badge tone="destructive" title={row.error}>
                      {t('quota_accounts.badge_read_failed')}
                    </Badge>
                  )}
                </div>
              </TableCell>
              <TableCell className={styles.plan}>{formatPlanName(row.plan)}</TableCell>
              <TableCell>
                <Meter reading={row.fiveHour} label={labels.fiveHour} />
              </TableCell>
              <TableCell>
                <Meter reading={row.weekly} label={labels.weekly} />
              </TableCell>
              {showScoped && (
                <TableCell>
                  <Meter reading={row.scopedWeekly} label={labels.scoped} />
                </TableCell>
              )}
              <TableCell className={styles.reset}>
                {reset === null ? (
                  <span className={styles.muted}>—</span>
                ) : (
                  <>
                    <span>
                      {t('quota_pool.in_duration', { duration: formatDuration(reset - now) })}
                    </span>
                    <span className={styles.muted}>{formatWeekdayTime(reset, locale)}</span>
                  </>
                )}
              </TableCell>
              {showCredits && <TableCell>{renderCredits(row)}</TableCell>}
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
