/**
 * One provider's pooled quota: a section with the window picker, a panel
 * holding the headline, projection stats, chart and legend, then the
 * per-account table. All numbers come from the pure pool model (poolModel.ts).
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/Badge';
import { Button, IconButton } from '@/components/ui/Button';
import { IconChevronDown, IconSlidersHorizontal } from '@/components/ui/icons';
import { Section } from '@/components/ui/Section';
import { Skeleton } from '@/components/ui/Skeleton';
import { Stat } from '@/components/ui/Stat';
import { SegmentedControl } from '@/components/ui/Tabs';
import type { QuotaHistory } from '@/services/api';
import type { ResolvedTheme } from '@/types';
import { getAuthFileIcon, getTypeLabel } from '@/features/authFiles/constants';
import {
  buildPoolView,
  poolWindowChoices,
  type FutureUsage,
  type PlanWeights,
  type PoolProvider,
  type PoolWindowChoice,
} from '../poolModel';
import {
  formatBurnRate,
  formatDuration,
  formatMonthDay,
  formatPoolPercent,
  formatSignedPercent,
  formatWeekdayTime,
} from '../poolFormat';
import { formatPlanName } from '../poolPrefs';
import { PoolChart, type PoolChartMode } from './PoolChart';
import styles from './QuotaPoolCard.module.scss';

export interface QuotaPoolCardProps {
  provider: PoolProvider;
  history: QuotaHistory;
  window: PoolWindowChoice;
  onWindowChange: (window: PoolWindowChoice) => void;
  weights: PlanWeights;
  onWeightChange: (plan: string, weight: number | null) => void;
  mode: PoolChartMode;
  showAccounts: boolean;
  spanStart: number;
  spanEnd: number;
  now: number;
  burnWindowHours: number;
  futureUsage: FutureUsage;
  resolvedTheme: ResolvedTheme;
  locale: string;
  /** Number of signed-in accounts for this provider (shown before readings arrive). */
  accountCount: number;
  /** First load: history still on its way and no live reading yet. */
  loading?: boolean;
  /** Newest recorded reading; null hides the line (live-only view). */
  lastReadAt?: number | null;
  stale?: boolean;
  /** Codex: banked resets over all accounts; null while unknown. */
  bankedResets?: number | null;
  /** Per-account table. */
  table?: ReactNode;
  /** Full per-account cards (provider-specific actions), shown on demand. */
  details?: ReactNode;
}

const WINDOW_LABELS: Record<PoolWindowChoice, string> = {
  weekly: 'quota_pool.window_weekly',
  fable: 'quota_pool.window_fable',
  five_hour: 'quota_pool.window_five_hour',
};

const formatWeight = (weight: number) => `${Number(weight.toFixed(2))}×`;

const formatClock = (ms: number, locale: string) =>
  new Date(ms).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });

export function QuotaPoolCard(props: QuotaPoolCardProps) {
  const {
    provider,
    history,
    window: windowChoice,
    onWindowChange,
    weights,
    onWeightChange,
    mode,
    showAccounts,
    spanStart,
    spanEnd,
    now,
    burnWindowHours,
    futureUsage,
    resolvedTheme,
    locale,
    accountCount,
    loading = false,
    lastReadAt = null,
    stale = false,
    bankedResets,
    table,
    details,
  } = props;
  const { t } = useTranslation();
  const [weightsOpen, setWeightsOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const weightsRef = useRef<HTMLDivElement>(null);

  const view = useMemo(
    () =>
      buildPoolView(history, {
        provider,
        window: windowChoice,
        weights,
        now,
        spanStart,
        spanEnd,
        burnWindowHours,
        futureUsage,
      }),
    [
      burnWindowHours,
      futureUsage,
      history,
      now,
      provider,
      spanEnd,
      spanStart,
      weights,
      windowChoice,
    ]
  );

  const plans = useMemo(() => {
    const set = new Set<string>();
    history.accounts
      .filter((account) => account.provider === provider && !account.disabled && account.plan)
      .forEach((account) => set.add(account.plan as string));
    return [...set].sort();
  }, [history.accounts, provider]);

  const weightNote = plans
    .filter((plan) => (weights[plan] ?? 1) !== 1)
    .map((plan) => `${formatPlanName(plan)} = ${formatWeight(weights[plan])}`)
    .join(', ');

  useEffect(() => {
    if (!weightsOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!weightsRef.current?.contains(event.target as Node)) setWeightsOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setWeightsOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [weightsOpen]);

  const icon = getAuthFileIcon(provider, resolvedTheme);
  const providerLabel = getTypeLabel(t, provider);
  const notBy = t('quota_pool.not_by', { date: formatMonthDay(spanEnd, locale) });

  const hasData = view.tracks.length > 0;
  const firstEmptyValue = view.firstEmpty ? (
    <>
      <span className={styles.label} data-sensitive title={view.firstEmpty.label}>
        {view.firstEmpty.label}
      </span>{' '}
      {view.firstEmpty.at <= now
        ? t('quota_pool.empty_now')
        : t('quota_pool.in_duration', { duration: formatDuration(view.firstEmpty.at - now) })}
    </>
  ) : (
    notBy
  );

  const windowLabel = t(WINDOW_LABELS[windowChoice]);
  const stats: { key: string; label: string; value: ReactNode }[] = [
    {
      key: 'pool-empty',
      label: t('quota_pool.stat_pool_empty'),
      value: !hasData
        ? '—'
        : view.poolEmptyAt !== null
          ? formatWeekdayTime(view.poolEmptyAt, locale)
          : notBy,
    },
    {
      key: 'first-empty',
      label: t('quota_pool.stat_first_empty'),
      value: hasData ? firstEmptyValue : '—',
    },
    {
      key: 'next-reset',
      label: t('quota_pool.stat_next_reset'),
      value: view.nextReset
        ? `${formatSignedPercent(view.nextReset.amount)}, ${formatWeekdayTime(view.nextReset.at, locale)}`
        : '—',
    },
    {
      key: 'burn',
      label: t('quota_pool.stat_burn', { hours: burnWindowHours }),
      value: hasData ? formatBurnRate(view.burnRate) : '—',
    },
  ];
  if (bankedResets !== undefined) {
    stats.push({
      key: 'banked',
      label: t('quota_pool.stat_banked'),
      value: bankedResets === null ? '—' : String(bankedResets),
    });
  }

  const description = (
    <span className={styles.meta}>
      <span>{t('quota_pool.accounts_count', { count: accountCount })}</span>
      {lastReadAt !== null && (
        <span>{t('quota_pool.last_reading', { time: formatClock(lastReadAt, locale) })}</span>
      )}
      {stale && lastReadAt !== null && (
        <Badge tone="warning" title={t('quota_pool.stale_hint')}>
          {t('quota_pool.stale', { duration: formatDuration(now - lastReadAt) })}
        </Badge>
      )}
    </span>
  );

  return (
    <Section
      className={styles.pool}
      title={
        <span className={styles.title}>
          {icon && <img src={icon} alt="" className={styles.icon} />}
          {providerLabel}
        </span>
      }
      description={description}
      actions={
        <div className={styles.headControls}>
          <SegmentedControl
            ariaLabel={t('quota_pool.window_label')}
            size="sm"
            items={poolWindowChoices(provider).map((choice) => ({
              value: choice,
              label: t(WINDOW_LABELS[choice]),
            }))}
            value={windowChoice}
            onChange={onWindowChange}
          />
          <div className={styles.weightsAnchor} ref={weightsRef}>
            <IconButton
              size="sm"
              aria-label={t('quota_pool.plan_weights')}
              aria-expanded={weightsOpen}
              aria-haspopup="dialog"
              icon={<IconSlidersHorizontal size={16} />}
              onClick={() => setWeightsOpen((open) => !open)}
            />
            {weightsOpen && (
              <div
                className={styles.weightsPopover}
                role="dialog"
                aria-label={t('quota_pool.plan_weights')}
              >
                <div className={styles.weightsTitle}>{t('quota_pool.plan_weights')}</div>
                <p className={styles.weightsHint}>{t('quota_pool.plan_weights_hint')}</p>
                {plans.length === 0 ? (
                  <p className={styles.weightsHint}>{t('quota_pool.plan_weights_empty')}</p>
                ) : (
                  plans.map((plan) => (
                    <label key={plan} className={styles.weightRow}>
                      <span>{formatPlanName(plan)}</span>
                      <span className={styles.weightInputWrap}>
                        <input
                          type="number"
                          min={0.1}
                          max={100}
                          step={0.5}
                          className={`input ${styles.weightInput}`}
                          value={weights[plan] ?? 1}
                          onChange={(event) => {
                            const value = Number(event.target.value);
                            onWeightChange(
                              plan,
                              Number.isFinite(value) && value > 0 ? value : null
                            );
                          }}
                        />
                        ×
                      </span>
                    </label>
                  ))
                )}
                {plans.some((plan) => weights[plan] !== undefined) && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => plans.forEach((plan) => onWeightChange(plan, null))}
                  >
                    {t('quota_pool.plan_weights_reset')}
                  </Button>
                )}
              </div>
            )}
          </div>
        </div>
      }
    >
      <div
        className={styles.panel}
        data-provider={provider}
        role="group"
        aria-label={t('quota_pool.card_label', { provider: providerLabel })}
      >
        <div className={styles.stats}>
          <Stat
            size="lg"
            className={styles.headline}
            label={t('quota_pool.headline_label', { window: windowLabel })}
            value={
              loading ? (
                <Skeleton width={96} height={32} />
              ) : hasData ? (
                formatPoolPercent(view.current)
              ) : (
                '—'
              )
            }
            unit={
              hasData ? t('quota_pool.of_max', { max: formatPoolPercent(view.max) }) : undefined
            }
            hint={
              weightNote ? (
                <button
                  type="button"
                  className={styles.weightNote}
                  onClick={() => setWeightsOpen(true)}
                >
                  {weightNote}
                </button>
              ) : undefined
            }
          />
          <div className={styles.statRow}>
            {stats.map((stat) => (
              <Stat key={stat.key} label={stat.label} value={stat.value} className={styles.stat} />
            ))}
          </div>
        </div>

        {loading ? (
          <Skeleton height={280} rounded={6} />
        ) : !hasData ? (
          <div className={styles.noData}>{t('quota_pool.no_samples')}</div>
        ) : (
          <PoolChart
            view={view}
            mode={mode}
            showAccounts={showAccounts}
            spanStart={spanStart}
            spanEnd={spanEnd}
            now={now}
            locale={locale}
          />
        )}

        {hasData && !loading && (
          <ul className={styles.legend} aria-label={t('quota_pool.legend_label')}>
            <li className={styles.legendItem}>
              <span className={styles.swatchSolid} aria-hidden="true" />
              {mode === 'drain'
                ? t('quota_pool.legend_recorded_drain')
                : t('quota_pool.legend_recorded')}
            </li>
            <li className={styles.legendItem}>
              <span className={styles.swatchDashed} aria-hidden="true" />
              {mode === 'drain'
                ? t('quota_pool.legend_projected_drain')
                : t('quota_pool.legend_projected')}
            </li>
            {showAccounts && (
              <li className={styles.legendItem}>
                <span className={styles.swatchThin} aria-hidden="true" />
                {t('quota_pool.legend_accounts')}
              </li>
            )}
          </ul>
        )}
      </div>

      {table}

      {details && (
        <div className={styles.detailsBar}>
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={detailsOpen}
            onClick={() => setDetailsOpen((open) => !open)}
          >
            {detailsOpen ? t('quota_pool.hide_account_cards') : t('quota_pool.show_account_cards')}
            <IconChevronDown
              size={16}
              className={detailsOpen ? styles.chevronOpen : styles.chevron}
            />
          </Button>
        </div>
      )}
      {detailsOpen && details}
    </Section>
  );
}
