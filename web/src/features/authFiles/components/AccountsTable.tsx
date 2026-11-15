import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { SelectionCheckbox } from '@/components/ui/SelectionCheckbox';
import { Skeleton } from '@/components/ui/Skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/Table/Table';
import styles from './AccountsTable.module.scss';

export type AccountsTableProps = {
  /** Header checkbox state for the selectable rows on this page. */
  pageSelection: 'none' | 'some' | 'all';
  selectableCount: number;
  onTogglePageSelection: () => void;
  children: ReactNode;
};

function AccountsTableHeader({
  pageSelection,
  selectableCount,
  onTogglePageSelection,
}: Omit<AccountsTableProps, 'children'>) {
  const { t } = useTranslation();
  return (
    <TableHeader>
      <tr>
        <TableHead className={styles.cellSelect}>
          {selectableCount > 0 && (
            <SelectionCheckbox
              checked={pageSelection === 'all'}
              onChange={onTogglePageSelection}
              ariaLabel={t('auth_files.select_page')}
            />
          )}
        </TableHead>
        <TableHead>{t('auth_files.column_account')}</TableHead>
        <TableHead className={styles.cellStatus}>{t('auth_files.column_status')}</TableHead>
        <TableHead className={styles.cellRequests} title={t('auth_files.column_requests_hint')}>
          {t('auth_files.column_requests')}
        </TableHead>
        <TableHead className={styles.cellQuota}>{t('auth_files.column_quota')}</TableHead>
        <TableHead className={styles.cellSwitch}>{t('auth_files.column_enabled')}</TableHead>
        <TableHead className={styles.cellMenu}>
          <span className="sr-only">{t('auth_files.column_actions')}</span>
        </TableHead>
      </tr>
    </TableHeader>
  );
}

/** Accounts list: a table on desktop, stacked rows under 768px (CSS only). */
export function AccountsTable({ children, ...header }: AccountsTableProps) {
  return (
    <Table className={styles.table}>
      <AccountsTableHeader {...header} />
      <TableBody>{children}</TableBody>
    </Table>
  );
}

/** Row-shaped placeholders for the first load. */
export function AccountsTableSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <Table className={styles.table} aria-hidden="true">
      <TableBody>
        {Array.from({ length: rows }, (_, index) => (
          <TableRow key={index} className={styles.row}>
            <TableCell className={styles.cellSelect}>
              <Skeleton width={16} height={16} rounded={4} />
            </TableCell>
            <TableCell className={styles.cellAccount}>
              <div className={styles.account}>
                <Skeleton width={20} height={20} rounded={5} />
                <div className={styles.identity}>
                  <Skeleton width={180} height={12} />
                  <Skeleton width={120} height={10} />
                </div>
              </div>
            </TableCell>
            <TableCell className={styles.cellStatus}>
              <Skeleton width={64} height={18} rounded={9} />
            </TableCell>
            <TableCell className={styles.cellRequests}>
              <Skeleton width={96} height={14} />
            </TableCell>
            <TableCell className={styles.cellQuota}>
              <Skeleton width={72} height={14} />
            </TableCell>
            <TableCell className={styles.cellSwitch}>
              <Skeleton width={28} height={16} rounded={8} />
            </TableCell>
            <TableCell className={styles.cellMenu} />
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
