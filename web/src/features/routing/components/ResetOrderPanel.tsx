import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/Table';
import { formatResetIn } from '../format';
import type { ResetOrderData } from '../useResetOrder';
import styles from '../RoutingPage.module.scss';

const RULES = ['reset', 'probe', 'scoped', 'ties', 'fallback', 'tiers'] as const;

export interface ResetOrderPanelProps {
  data: ResetOrderData;
  onRetry: () => void;
}

/** "How it decides" and the order accounts would be chosen in right now. */
export function ResetOrderPanel({ data, onRetry }: ResetOrderPanelProps) {
  const { t } = useTranslation();

  const renderOrder = () => {
    if (data.status === 'loading') {
      return (
        <div aria-busy="true" aria-label={t('routing.srf_order_loading')}>
          <Skeleton height={96} />
        </div>
      );
    }
    if (data.status === 'error') {
      return (
        <div className={`error-box ${styles.inlineError}`}>
          <span>{t('routing.srf_order_failed', { message: data.message })}</span>
          <Button variant="secondary" size="sm" onClick={onRetry}>
            {t('routing.retry')}
          </Button>
        </div>
      );
    }
    if (data.groups.length === 0) {
      return <p className={styles.mutedText}>{t('routing.srf_order_unavailable')}</p>;
    }
    return data.groups.map((group) => (
      <div key={group.provider} className={styles.orderGroup}>
        <h4 className={styles.orderProvider}>
          {t(`routing.srf_order_provider_${group.provider}`)}
        </h4>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className={styles.orderRankCol}>{t('routing.srf_order_rank')}</TableHead>
              <TableHead>{t('routing.srf_order_account')}</TableHead>
              <TableHead>{t('routing.srf_order_reset')}</TableHead>
              <TableHead alignRight>{t('routing.srf_order_used')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {group.entries.map((entry) => (
              <TableRow key={entry.authIndex}>
                <TableCell className="tabular">{entry.rank ?? '–'}</TableCell>
                <TableCell>
                  <span className={styles.orderAccount}>{entry.label}</span>
                </TableCell>
                <TableCell>
                  {entry.state === 'probe' ? (
                    <Badge tone="info">{t('routing.srf_state_probe')}</Badge>
                  ) : entry.state === 'spent' ? (
                    <Badge tone="warning">{t('routing.srf_state_spent')}</Badge>
                  ) : (
                    <span className="tabular">
                      {t('routing.srf_resets_in', {
                        time: formatResetIn(t, (entry.resetsAt ?? data.now) - data.now),
                      })}
                    </span>
                  )}
                </TableCell>
                <TableCell alignRight className="tabular">
                  {entry.usedPercent === null ? '–' : `${Math.round(entry.usedPercent)}%`}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    ));
  };

  return (
    <div className={styles.srfDetails}>
      <div className={styles.srfBlock}>
        <h3 className={styles.subTitle}>{t('routing.srf_how_title')}</h3>
        <ul className={styles.ruleList}>
          {RULES.map((rule) => (
            <li key={rule}>{t(`routing.srf_rule_${rule}`)}</li>
          ))}
        </ul>
      </div>
      <div className={styles.srfBlock}>
        <h3 className={styles.subTitle}>{t('routing.srf_order_title')}</h3>
        <p className={styles.mutedText}>{t('routing.srf_order_desc')}</p>
        {renderOrder()}
      </div>
    </div>
  );
}
