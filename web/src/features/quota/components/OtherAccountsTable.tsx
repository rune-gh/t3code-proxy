/**
 * Accounts with no renewing window to pool (API keys, failed or pending
 * reads): one row each with the state of its last read, opening to the same
 * account detail as the pool tables.
 */

import { Fragment, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { IconChevronDown } from '@/components/ui/icons';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/Table';
import styles from './PoolAccountsTable.module.scss';

export interface OtherAccountRow {
  key: string;
  label: string;
  status: 'idle' | 'loading' | 'success' | 'error';
  disabled: boolean;
}

export interface OtherAccountsTableProps {
  providerLabel: string;
  rows: readonly OtherAccountRow[];
  renderDetail: (key: string) => ReactNode;
}

export function OtherAccountsTable({ providerLabel, rows, renderDetail }: OtherAccountsTableProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (key: string) =>
    setOpen((previous) => {
      const next = new Set(previous);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const statusText = (row: OtherAccountRow) =>
    row.disabled
      ? t('quota_accounts.badge_disabled')
      : t(`quota_accounts.other_status_${row.status}`);

  return (
    <Table
      className={styles.otherTable}
      aria-label={t('quota_accounts.table_label', { provider: providerLabel })}
    >
      <TableHeader>
        <TableRow>
          <TableHead>{t('quota_accounts.col_account')}</TableHead>
          <TableHead>{t('quota_accounts.col_status')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          const expanded = open.has(row.key);
          const detailId = `other-account-${row.key}`;
          return (
            <Fragment key={row.key}>
              <TableRow
                className={
                  [row.disabled ? styles.disabledRow : '', expanded ? styles.openRow : '']
                    .filter(Boolean)
                    .join(' ') || undefined
                }
              >
                <TableCell className={styles.accountCell}>
                  <div className={styles.account}>
                    <button
                      type="button"
                      className={styles.disclosure}
                      aria-expanded={expanded}
                      aria-controls={expanded ? detailId : undefined}
                      title={row.label}
                      onClick={() => toggle(row.key)}
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
                  </div>
                </TableCell>
                <TableCell
                  className={row.status === 'error' && !row.disabled ? styles.failed : styles.plan}
                >
                  {statusText(row)}
                </TableCell>
              </TableRow>
              {expanded && (
                <tr className={styles.detailRow} id={detailId}>
                  <td colSpan={2}>{renderDetail(row.key)}</td>
                </tr>
              )}
            </Fragment>
          );
        })}
      </TableBody>
    </Table>
  );
}
