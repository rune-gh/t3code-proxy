/**
 * One row per account under a pool: plan and its capacity in pool percent
 * (the heaviest plan is 100%, as on the pool headline), remaining in each
 * window, the next reset of the window routing orders by, the
 * soonest-reset-first marker, and (Codex) banked resets. Claude and Codex keep
 * their fixed 5-hour / weekly / Fable columns; other providers get one column
 * per window they report. Rows arrive sorted by soonest reset (accountRows.ts).
 *
 * Each account name opens the account's full detail in a row beneath it (see
 * AccountDetail.tsx); that replaced the old per-account cards.
 */

import { Fragment, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { IconChevronDown } from '@/components/ui/icons';
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
import { creditExpiryMs } from '../providers/codex/resetCredits';
import type { PoolProvider } from '../poolModel';
import {
  formatCapacity,
  formatDuration,
  formatMoney,
  formatMonthDay,
  formatPoolPercent,
  formatResetInstant,
} from '../poolFormat';
import { formatPlanName, formatWeight } from '../poolPrefs';
import styles from './PoolAccountsTable.module.scss';

export interface PoolWindowColumn {
  key: string;
  label: string;
  /** Group heading above a short period name, when the provider's windows split into groups. */
  group?: string;
  period?: string;
}

export interface PoolAccountsTableProps {
  provider: PoolProvider;
  /** Display name for the provider (table caption). */
  providerLabel: string;
  rows: readonly PoolAccountRow[];
  /** Window columns for providers other than Claude and Codex, shortest first. */
  windowColumns?: readonly PoolWindowColumn[];
  /** Label of the window the reset column follows (other providers). */
  primaryLabel?: string;
  now: number;
  locale: string;
  /** Codex only: banked reset credits per auth index. */
  credits?: Record<string, CodexCreditsEntry>;
  /** Auth index whose reset is being redeemed. */
  redeeming?: string | null;
  onUseReset?: (row: PoolAccountRow) => void;
  /** An account's full detail, shown in a row beneath it when its name is opened. */
  renderDetail?: (row: PoolAccountRow) => ReactNode;
}

const meterLevel = (remaining: number) =>
  remaining <= 0 ? 'empty' : remaining < 20 ? 'low' : 'ok';

function Meter({
  reading,
  label,
  locale,
}: {
  reading: WindowReading | null;
  label: string;
  locale: string;
}) {
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
      {reading.budget && (
        <span className={styles.money}>
          {t('quota_accounts.money_spent', {
            spent: formatMoney(
              (reading.budget.amount * (100 - reading.remaining)) / 100,
              reading.budget.currency,
              locale
            ),
            budget: formatMoney(reading.budget.amount, reading.budget.currency, locale),
          })}
        </span>
      )}
    </span>
  );
}

export function PoolAccountsTable({
  provider,
  providerLabel,
  rows,
  windowColumns,
  primaryLabel,
  now,
  locale,
  credits,
  redeeming,
  onUseReset,
  renderDetail,
}: PoolAccountsTableProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (authIndex: string) =>
    setOpen((previous) => {
      const next = new Set(previous);
      if (!next.delete(authIndex)) next.add(authIndex);
      return next;
    });
  const showScoped = provider === 'claude' && rows.some((row) => row.scopedWeekly);
  const showCredits = provider === 'codex' && Boolean(credits);
  const labels = {
    fiveHour: t('quota_accounts.col_five_hour'),
    weekly: t('quota_accounts.col_weekly'),
    scoped: t('quota_accounts.col_scoped_weekly'),
  };
  const generic = windowColumns !== undefined;
  // Capacity in pool percent, against the heaviest enabled account (as the pool headline counts).
  const heaviest = Math.max(0, ...rows.filter((row) => !row.disabled).map((row) => row.weight));
  const capacityOf = (row: PoolAccountRow) => (heaviest > 0 ? (100 * row.weight) / heaviest : 100);
  // "Next" only means something when there is another account to pick instead.
  const showNext = rows.filter((row) => !row.disabled).length > 1;
  const resetLabel =
    generic && primaryLabel
      ? t('quota_accounts.col_window_reset', { window: primaryLabel })
      : t('quota_accounts.col_next_reset');

  const columnCount =
    3 +
    (generic ? windowColumns.length : 2) +
    (!generic && showScoped ? 1 : 0) +
    1 +
    (showCredits ? 1 : 0);

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
    // Credits arrive soonest-expiring first.
    const expiresAt = count > 0 ? creditExpiryMs(entry.credits[0].expiresAt) : null;
    return (
      <span className={styles.credits}>
        <span className={styles.creditCount}>{count}</span>
        {expiresAt !== null && (
          <span className={styles.muted}>
            {t('quota_accounts.credit_expires', { date: formatMonthDay(expiresAt, locale) })}
          </span>
        )}
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
      aria-label={t('quota_accounts.table_label', { provider: providerLabel })}
    >
      <TableHeader>
        <TableRow>
          <TableHead>{t('quota_accounts.col_account')}</TableHead>
          <TableHead>{t('quota_accounts.col_plan')}</TableHead>
          <TableHead alignRight title={t('quota_accounts.col_weight_hint')}>
            {t('quota_accounts.col_weight')}
          </TableHead>
          {generic ? (
            windowColumns.map((column) => (
              <TableHead key={column.key} title={column.label}>
                {column.group && column.period ? (
                  <span className={styles.groupHead}>
                    <span className={styles.groupName}>{column.group}</span>
                    <span>{column.period}</span>
                  </span>
                ) : (
                  column.label
                )}
              </TableHead>
            ))
          ) : (
            <>
              <TableHead>{labels.fiveHour}</TableHead>
              <TableHead>{labels.weekly}</TableHead>
            </>
          )}
          {!generic && showScoped && <TableHead>{labels.scoped}</TableHead>}
          <TableHead>{resetLabel}</TableHead>
          {showCredits && <TableHead>{t('quota_accounts.col_banked')}</TableHead>}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          const reset = row.weekly?.resetsAt ?? null;
          const expanded = open.has(row.authIndex);
          const detailId = `pool-account-${provider}-${row.authIndex}`;
          return (
            <Fragment key={row.authIndex}>
              <TableRow
                className={
                  [row.disabled ? styles.disabledRow : '', expanded ? styles.openRow : '']
                    .filter(Boolean)
                    .join(' ') || undefined
                }
              >
                <TableCell className={styles.accountCell}>
                  <div className={styles.account}>
                    {renderDetail ? (
                      <button
                        type="button"
                        className={styles.disclosure}
                        aria-expanded={expanded}
                        aria-controls={expanded ? detailId : undefined}
                        title={row.label}
                        onClick={() => toggle(row.authIndex)}
                      >
                        <IconChevronDown
                          size={14}
                          aria-hidden="true"
                          className={expanded ? styles.chevronOpen : styles.chevron}
                        />
                        <span className={styles.label} data-sensitive>
                          {row.label}
                        </span>
                      </button>
                    ) : (
                      <span className={styles.label} data-sensitive title={row.label}>
                        {row.label}
                      </span>
                    )}
                    {row.isNext && showNext && (
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
                <TableCell
                  alignRight
                  className={styles.weight}
                  title={t('quota_accounts.capacity_weight', { weight: formatWeight(row.weight) })}
                >
                  {row.disabled ? '—' : formatCapacity(capacityOf(row))}
                </TableCell>
                {generic ? (
                  windowColumns.map((column) => (
                    <TableCell key={column.key}>
                      <Meter
                        reading={row.windows[column.key] ?? null}
                        label={column.label}
                        locale={locale}
                      />
                    </TableCell>
                  ))
                ) : (
                  <>
                    <TableCell>
                      <Meter reading={row.fiveHour} label={labels.fiveHour} locale={locale} />
                    </TableCell>
                    <TableCell>
                      <Meter reading={row.weekly} label={labels.weekly} locale={locale} />
                    </TableCell>
                  </>
                )}
                {!generic && showScoped && (
                  <TableCell>
                    <Meter reading={row.scopedWeekly} label={labels.scoped} locale={locale} />
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
                      <span className={styles.muted}>{formatResetInstant(reset, now, locale)}</span>
                    </>
                  )}
                </TableCell>
                {showCredits && <TableCell>{renderCredits(row)}</TableCell>}
              </TableRow>
              {expanded && renderDetail && (
                <tr className={styles.detailRow} id={detailId}>
                  <td colSpan={columnCount}>{renderDetail(row)}</td>
                </tr>
              )}
            </Fragment>
          );
        })}
      </TableBody>
    </Table>
  );
}
