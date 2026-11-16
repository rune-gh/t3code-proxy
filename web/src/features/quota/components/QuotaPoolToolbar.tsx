/**
 * Pool chart toolbar: chart value and date range up front; the rarely
 * changed burn window, future usage and per-account lines sit in a menu.
 */

import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/DropdownMenu';
import { IconSlidersHorizontal } from '@/components/ui/icons';
import { SegmentedControl } from '@/components/ui/Tabs';
import { Toolbar } from '@/components/ui/Toolbar';
import type { FutureUsage } from '../poolModel';
import type { PoolChartMode } from './PoolChart';
import { SpanNav } from './SpanNav';
import styles from './QuotaPoolToolbar.module.scss';

export const BURN_WINDOWS = [1, 3, 6] as const;
export type BurnWindowHours = (typeof BURN_WINDOWS)[number];

const FUTURE_OPTIONS: { value: FutureUsage; key: string }[] = [
  { value: 'same', key: 'quota_pool.future_same' },
  { value: 'none', key: 'quota_pool.future_none' },
  { value: 'double', key: 'quota_pool.future_double' },
];

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

  return (
    <Toolbar
      ariaLabel={t('quota_pool.toolbar_label')}
      end={
        <DropdownMenu
          ariaLabel={t('quota_pool.chart_options')}
          minWidth={220}
          trigger={
            <Button variant="secondary" size="sm">
              <span className={styles.triggerInner}>
                <IconSlidersHorizontal size={16} aria-hidden="true" />
                {t('quota_pool.chart_options')}
              </span>
            </Button>
          }
        >
          <div className={styles.menuLabel} role="presentation">
            {t('quota_pool.burn_rate')}
          </div>
          {BURN_WINDOWS.map((hours) => (
            <DropdownMenuItem
              key={hours}
              selected={burnWindow === hours}
              onSelect={() => onBurnWindowChange(hours)}
            >
              {t('quota_pool.burn_window_option', { count: hours })}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <div className={styles.menuLabel} role="presentation">
            {t('quota_pool.future_usage')}
          </div>
          {FUTURE_OPTIONS.map((option) => (
            <DropdownMenuItem
              key={option.value}
              selected={futureUsage === option.value}
              onSelect={() => onFutureUsageChange(option.value)}
            >
              {t(option.key)}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            selected={showAccounts}
            onSelect={() => onShowAccountsChange(!showAccounts)}
          >
            {t('quota_pool.accounts_toggle')}
          </DropdownMenuItem>
        </DropdownMenu>
      }
    >
      <SegmentedControl
        ariaLabel={t('quota_pool.mode_label')}
        size="sm"
        items={[
          { value: 'remaining' as const, label: t('quota_pool.mode_remaining') },
          { value: 'drain' as const, label: t('quota_pool.mode_drain') },
        ]}
        value={mode}
        onChange={onModeChange}
      />
      <SpanNav
        spanStart={spanStart}
        spanEnd={spanEnd}
        isToday={isToday}
        onShift={onShift}
        onToday={onToday}
        locale={locale}
      />
    </Toolbar>
  );
}
