/**
 * Pool card: one provider's weekly (or 5-hour) quota pooled across accounts.
 * Header, pooled headline, four projection stats, the chart, and a legend.
 * All numbers come from the pure pool model (poolModel.ts).
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { IconChevronDown, IconSlidersHorizontal } from '@/components/ui/icons';
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
  showEmails: boolean;
  resolvedTheme: ResolvedTheme;
  locale: string;
  /** Stock per-credential cards, shown on demand under the chart. */
  details?: ReactNode;
  detailsCount?: number;
}

const WINDOW_LABELS: Record<PoolWindowChoice, { key: string; fallback: string }> = {
  weekly: { key: 'quota_pool.window_weekly', fallback: 'Weekly' },
  fable: { key: 'quota_pool.window_fable', fallback: 'Fable weekly' },
  five_hour: { key: 'quota_pool.window_five_hour', fallback: '5-hour' },
};

const formatWeight = (weight: number) => `${Number(weight.toFixed(2))}×`;

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
    showEmails,
    resolvedTheme,
    locale,
    details,
    detailsCount = 0,
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
    .join(' · ');

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
  const notBy = t('quota_pool.not_by', {
    defaultValue: 'Not by {{date}}',
    date: formatMonthDay(spanEnd, locale),
  });
  const sensitive = showEmails ? styles.label : `${styles.label} ${styles.blurred}`;

  const firstEmptyValue = view.firstEmpty ? (
    <>
      <span className={sensitive} title={showEmails ? view.firstEmpty.label : undefined}>
        {view.firstEmpty.label}
      </span>{' '}
      {view.firstEmpty.at <= now
        ? t('quota_pool.empty_now', { defaultValue: 'now' })
        : t('quota_pool.in_duration', {
            defaultValue: 'in {{duration}}',
            duration: formatDuration(view.firstEmpty.at - now),
          })}
    </>
  ) : (
    notBy
  );

  const accountCount = view.tracks.length;
  const hasData = accountCount > 0;
  const stats: { key: string; label: string; value: ReactNode }[] = [
    {
      key: 'pool-empty',
      label: t('quota_pool.stat_pool_empty', { defaultValue: 'Pool empty' }),
      value: !hasData
        ? '—'
        : view.poolEmptyAt !== null
          ? formatWeekdayTime(view.poolEmptyAt, locale)
          : notBy,
    },
    {
      key: 'first-empty',
      label: t('quota_pool.stat_first_empty', { defaultValue: 'First empty' }),
      value: hasData ? firstEmptyValue : '—',
    },
    {
      key: 'next-reset',
      label: t('quota_pool.stat_next_reset', { defaultValue: 'Next reset' }),
      value: view.nextReset
        ? `${formatSignedPercent(view.nextReset.amount)} ${formatWeekdayTime(view.nextReset.at, locale)}`
        : '—',
    },
    {
      key: 'burn',
      label: t('quota_pool.stat_burn', {
        defaultValue: 'Burn, last {{hours}}h',
        hours: burnWindowHours,
      }),
      value: hasData ? formatBurnRate(view.burnRate) : '—',
    },
  ];

  return (
    <section
      className={styles.card}
      data-provider={provider}
      aria-label={t('quota_pool.card_label', {
        defaultValue: '{{provider}} quota pool',
        provider: providerLabel,
      })}
    >
      <header className={styles.head}>
        <div className={styles.identity}>
          {icon && <img src={icon} alt="" className={styles.icon} />}
          <h2 className={styles.name}>{providerLabel}</h2>
          <span className={styles.count}>
            {t('quota_pool.accounts_count', {
              defaultValue: '{{count}} accounts',
              // Without readings, still say how many credentials will feed the pool.
              count: hasData ? accountCount : detailsCount,
            })}
          </span>
        </div>
        <div className={styles.headControls}>
          <div
            className={styles.windowSwitch}
            role="group"
            aria-label={t('quota_pool.window_label', { defaultValue: 'Quota window' })}
          >
            {poolWindowChoices(provider).map((choice) => (
              <button
                key={choice}
                type="button"
                className={`${styles.windowOption} ${choice === windowChoice ? styles.windowActive : ''}`}
                aria-pressed={choice === windowChoice}
                onClick={() => onWindowChange(choice)}
              >
                {t(WINDOW_LABELS[choice].key, { defaultValue: WINDOW_LABELS[choice].fallback })}
              </button>
            ))}
          </div>
          <div className={styles.weightsAnchor} ref={weightsRef}>
            <button
              type="button"
              className={styles.iconButton}
              aria-expanded={weightsOpen}
              aria-haspopup="dialog"
              title={t('quota_pool.plan_weights', { defaultValue: 'Plan weights' })}
              aria-label={t('quota_pool.plan_weights', { defaultValue: 'Plan weights' })}
              onClick={() => setWeightsOpen((open) => !open)}
            >
              <IconSlidersHorizontal size={15} />
            </button>
            {weightsOpen && (
              <div
                className={styles.weightsPopover}
                role="dialog"
                aria-label={t('quota_pool.plan_weights', { defaultValue: 'Plan weights' })}
              >
                <div className={styles.weightsTitle}>
                  {t('quota_pool.plan_weights', { defaultValue: 'Plan weights' })}
                </div>
                <p className={styles.weightsHint}>
                  {t('quota_pool.plan_weights_hint', {
                    defaultValue: 'How much one account on each plan counts toward the pool.',
                  })}
                </p>
                {plans.length === 0 ? (
                  <p className={styles.weightsHint}>
                    {t('quota_pool.plan_weights_empty', {
                      defaultValue: 'No plan information reported yet.',
                    })}
                  </p>
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
                          className={styles.weightInput}
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
                  <button
                    type="button"
                    className={styles.weightsReset}
                    onClick={() => plans.forEach((plan) => onWeightChange(plan, null))}
                  >
                    {t('quota_pool.plan_weights_reset', { defaultValue: 'Reset to 1×' })}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </header>

      <div className={styles.summary}>
        <div className={styles.headline}>
          <span className={styles.bigNumber}>
            {hasData ? formatPoolPercent(view.current) : '—'}
          </span>
          {hasData && (
            <span className={styles.ofMax}>
              {t('quota_pool.of_max', {
                defaultValue: 'of {{max}}',
                max: formatPoolPercent(view.max),
              })}
            </span>
          )}
          {weightNote && (
            <button
              type="button"
              className={styles.weightNote}
              onClick={() => setWeightsOpen(true)}
            >
              {weightNote}
            </button>
          )}
        </div>
        <dl className={styles.stats}>
          {stats.map((stat) => (
            <div key={stat.key} className={styles.stat}>
              <dt>{stat.label}</dt>
              <dd>{stat.value}</dd>
            </div>
          ))}
        </dl>
      </div>

      {!hasData ? (
        <div className={styles.noData}>
          {t('quota_pool.no_samples', {
            defaultValue:
              'No quota readings for this window yet. Refresh all credentials to take one.',
          })}
        </div>
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

      <footer className={styles.legend}>
        <span className={styles.legendTitle}>
          {mode === 'drain'
            ? t('quota_pool.legend_drain', { defaultValue: 'Drain rate' })
            : t('quota_pool.legend_pool', { defaultValue: 'Pool' })}
        </span>
        <span className={styles.legendItem}>
          <span className={styles.swatchSolid} aria-hidden="true" />
          {t('quota_pool.legend_recorded', { defaultValue: 'Recorded' })}
        </span>
        <span className={styles.legendItem}>
          <span className={styles.swatchDashed} aria-hidden="true" />
          {t('quota_pool.legend_projected', { defaultValue: 'Projected' })}
        </span>
        {showAccounts && (
          <span className={styles.legendItem}>
            <span className={styles.swatchThin} aria-hidden="true" />
            {t('quota_pool.legend_accounts', { defaultValue: 'Accounts' })}
          </span>
        )}
        {details && detailsCount > 0 && (
          <button
            type="button"
            className={styles.detailsToggle}
            aria-expanded={detailsOpen}
            onClick={() => setDetailsOpen((open) => !open)}
          >
            {t('quota_pool.credential_cards', {
              defaultValue: 'Credential cards ({{count}})',
              count: detailsCount,
            })}
            <IconChevronDown
              size={14}
              className={detailsOpen ? styles.chevronOpen : styles.chevron}
            />
          </button>
        )}
      </footer>

      {detailsOpen && details && <div className={styles.details}>{details}</div>}
    </section>
  );
}
