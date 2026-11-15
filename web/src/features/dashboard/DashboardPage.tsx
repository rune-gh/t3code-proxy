import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconSidebarActivity } from '@/components/ui/icons';
import { PageHeader } from '@/components/ui/PageHeader';
import { Section } from '@/components/ui/Section';
import { Skeleton } from '@/components/ui/Skeleton';
import { Stat } from '@/components/ui/Stat';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/Table';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { formatPercent } from '@/utils/format';
import { ThroughputChart } from './components/ThroughputChart';
import { useDashboardOverview } from './hooks/useDashboardOverview';
import { providerLabel, splitWindowMinutes } from './utils';
import styles from './dashboard.module.scss';

const DASH = '—';

export function DashboardPage() {
  const { t } = useTranslation();
  const { connected, loading, error, counts, traffic, providers, credentials, refresh } =
    useDashboardOverview();

  useHeaderRefresh(refresh, connected);

  const windowLabel = (() => {
    if (traffic.windowMinutes <= 0) return '';
    const { hours, minutes } = splitWindowMinutes(traffic.windowMinutes);
    if (hours === 0) return t('dashboard.window_m', { minutes });
    if (minutes === 0) return t('dashboard.window_h', { hours });
    return t('dashboard.window_hm', { hours, minutes });
  })();

  const unknownProvider = t('dashboard.provider_unknown');
  const hasTraffic = traffic.total > 0;
  const servedProviders = providers.filter((provider) => provider.total > 0);

  const header = (
    <PageHeader
      title={t('dashboard.title')}
      description={
        windowLabel
          ? t('dashboard.description_window', { window: windowLabel })
          : t('dashboard.description')
      }
    />
  );

  if (error) {
    return (
      <>
        {header}
        <div className={styles.errorRow}>
          <div className="error-box" role="alert">
            {t('dashboard.load_failed', { message: error })}
          </div>
          <Button variant="secondary" size="sm" onClick={() => void refresh()}>
            {t('dashboard.retry')}
          </Button>
        </div>
      </>
    );
  }

  if (loading || !connected) {
    return (
      <>
        {header}
        <div className={styles.stats} aria-busy="true">
          {Array.from({ length: 4 }, (_, index) => (
            <div key={index} className={styles.statSkeleton}>
              <Skeleton height={12} width={96} />
              <Skeleton height={22} width={64} />
            </div>
          ))}
        </div>
        <Skeleton height={262} />
        <Skeleton height={140} />
      </>
    );
  }

  return (
    <>
      {header}

      <div className={styles.stats}>
        <Stat
          label={t('dashboard.stat_requests')}
          value={traffic.total.toLocaleString()}
          hint={
            hasTraffic
              ? t('dashboard.stat_requests_hint', { failed: traffic.totalFailure.toLocaleString() })
              : undefined
          }
        />
        <Stat
          label={t('dashboard.success_rate')}
          value={traffic.successRate === null ? DASH : formatPercent(traffic.successRate)}
        />
        <Stat
          label={t('dashboard.stat_accounts')}
          value={credentials ? credentials.active.toLocaleString() : DASH}
          unit={credentials ? t('dashboard.of_total', { total: credentials.total }) : undefined}
          hint={
            credentials && credentials.unavailable + credentials.disabled > 0
              ? t('dashboard.stat_accounts_hint', {
                  cooling: credentials.unavailable,
                  disabled: credentials.disabled,
                })
              : undefined
          }
        />
        <Stat
          label={t('dashboard.stat_models')}
          value={counts.models === null ? DASH : counts.models.toLocaleString()}
        />
      </div>

      {!hasTraffic ? (
        <EmptyState
          icon={<IconSidebarActivity size={16} />}
          title={t('dashboard.empty_title')}
          description={t('dashboard.empty_description')}
        />
      ) : (
        <>
          <Section
            title={t('dashboard.throughput_title')}
            description={t('dashboard.throughput_description')}
          >
            <ThroughputChart traffic={traffic} />
          </Section>

          <Section title={t('dashboard.providers_title')}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('dashboard.col_provider')}</TableHead>
                  <TableHead alignRight>{t('dashboard.col_accounts')}</TableHead>
                  <TableHead alignRight>{t('dashboard.col_requests')}</TableHead>
                  <TableHead alignRight>{t('dashboard.failed')}</TableHead>
                  <TableHead alignRight>{t('dashboard.success_rate')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {servedProviders.map((provider) => (
                  <TableRow key={provider.id}>
                    <TableCell>{providerLabel(provider.id, unknownProvider)}</TableCell>
                    <TableCell alignRight>{provider.credentials.toLocaleString()}</TableCell>
                    <TableCell alignRight>{provider.total.toLocaleString()}</TableCell>
                    <TableCell alignRight>
                      <span className={provider.failure > 0 ? styles.failed : undefined}>
                        {provider.failure.toLocaleString()}
                      </span>
                    </TableCell>
                    <TableCell alignRight>
                      {provider.successRate === null ? DASH : formatPercent(provider.successRate)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Section>
        </>
      )}
    </>
  );
}
