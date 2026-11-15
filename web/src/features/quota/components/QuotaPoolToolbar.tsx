/**
 * Pool toolbar: chart mode, burn window, future usage, account overlay, and
 * span navigation (range label, previous/next, Today).
 */

import { useTranslation } from 'react-i18next';
import { IconChevronLeft } from '@/components/ui/icons';
import { Select } from '@/components/ui/Select';
import type { FutureUsage } from '../poolModel';
import { formatMonthDay } from '../poolFormat';
import type { PoolChartMode } from './PoolChart';
import styles from './QuotaPoolToolbar.module.scss';

export const BURN_WINDOWS = [1, 3, 6] as const;
export type BurnWindowHours = (typeof BURN_WINDOWS)[number];

export interface QuotaPoolToolbarProps {
  mode: PoolChartMode;
  onModeChange: (mode: PoolChartMode) => void;
  burnWindow: BurnWindowHours;
  onBurnWindowChange: (hours: BurnWindowHours) => void;
  futureUsage: FutureUsage;
  onFutureUsageChange: (value: FutureUsage) => void;
  showAccounts: boolean;
  onShowAccountsChange: (value: boolean) => void;
  spanStart: number;
  spanEnd: number;
  isToday: boolean;
  onShift: (direction: -1 | 1) => void;
  onToday: () => void;
  locale: string;
}

export function QuotaPoolToolbar(props: QuotaPoolToolbarProps) {
  const {
    mode,
    onModeChange,
    burnWindow,
    onBurnWindowChange,
    futureUsage,
    onFutureUsageChange,
    showAccounts,
    onShowAccountsChange,
    spanStart,
    spanEnd,
    isToday,
    onShift,
    onToday,
    locale,
  } = props;
  const { t } = useTranslation();

  const modes: { value: PoolChartMode; label: string }[] = [
    { value: 'remaining', label: t('quota_pool.mode_remaining', { defaultValue: 'Remaining' }) },
    { value: 'drain', label: t('quota_pool.mode_drain', { defaultValue: 'Drain rate' }) },
  ];
  const futureOptions: { value: FutureUsage; label: string }[] = [
    { value: 'same', label: t('quota_pool.future_same', { defaultValue: 'Same as now' }) },
    { value: 'none', label: t('quota_pool.future_none', { defaultValue: 'None' }) },
    { value: 'double', label: t('quota_pool.future_double', { defaultValue: '2× now' }) },
  ];
  const burnLabelId = 'quota-pool-burn-label';
  const futureLabelId = 'quota-pool-future-label';

  return (
    <div className={styles.toolbar}>
      <div className={styles.controls}>
        <div
          className={styles.segmented}
          role="group"
          aria-label={t('quota_pool.mode_label', { defaultValue: 'Chart value' })}
        >
          {modes.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`${styles.segment} ${mode === option.value ? styles.segmentActive : ''}`}
              aria-pressed={mode === option.value}
              onClick={() => onModeChange(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>

        <div className={styles.labelled}>
          <span id={burnLabelId} className={styles.label}>
            {t('quota_pool.burn_rate', { defaultValue: 'Burn rate' })}
          </span>
          <div className={styles.segmented} role="group" aria-labelledby={burnLabelId}>
            {BURN_WINDOWS.map((hours) => (
              <button
                key={hours}
                type="button"
                className={`${styles.segment} ${burnWindow === hours ? styles.segmentActive : ''}`}
                aria-pressed={burnWindow === hours}
                onClick={() => onBurnWindowChange(hours)}
              >
                {t('quota_pool.hours_short', { defaultValue: '{{count}}h', count: hours })}
              </button>
            ))}
          </div>
        </div>

        <div className={styles.labelled}>
          <span id={futureLabelId} className={styles.label}>
            {t('quota_pool.future_usage', { defaultValue: 'Future usage' })}
          </span>
          <div className={styles.select}>
            <Select
              value={futureUsage}
              options={futureOptions}
              onChange={(value) => onFutureUsageChange(value as FutureUsage)}
              ariaLabelledBy={futureLabelId}
              fullWidth={false}
              size="sm"
            />
          </div>
        </div>

        <button
          type="button"
          className={`${styles.toggle} ${showAccounts ? styles.toggleActive : ''}`}
          aria-pressed={showAccounts}
          onClick={() => onShowAccountsChange(!showAccounts)}
        >
          {t('quota_pool.accounts_toggle', { defaultValue: 'Accounts' })}
        </button>
      </div>

      <div className={styles.nav}>
        <span className={styles.range}>
          {t('quota_pool.range', {
            defaultValue: '{{start}} to {{end}}',
            start: formatMonthDay(spanStart, locale),
            end: formatMonthDay(spanEnd, locale),
          })}
        </span>
        <button
          type="button"
          className={styles.arrow}
          onClick={() => onShift(-1)}
          aria-label={t('quota_pool.previous_span', { defaultValue: 'Earlier' })}
          title={t('quota_pool.previous_span', { defaultValue: 'Earlier' })}
        >
          <IconChevronLeft size={16} />
        </button>
        <button
          type="button"
          className={`${styles.toggle} ${isToday ? styles.toggleActive : ''}`}
          onClick={onToday}
          aria-pressed={isToday}
        >
          {t('quota_pool.today', { defaultValue: 'Today' })}
        </button>
        <button
          type="button"
          className={styles.arrow}
          onClick={() => onShift(1)}
          aria-label={t('quota_pool.next_span', { defaultValue: 'Later' })}
          title={t('quota_pool.next_span', { defaultValue: 'Later' })}
        >
          <IconChevronLeft size={16} className={styles.flip} />
        </button>
      </div>
    </div>
  );
}
