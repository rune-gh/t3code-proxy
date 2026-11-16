/**
 * Earlier / date range / later, plus Today once the span has moved: the one
 * span control the pools and the resets calendar share.
 */

import { useTranslation } from 'react-i18next';
import { Button, IconButton } from '@/components/ui/Button';
import { IconChevronLeft } from '@/components/ui/icons';
import { formatMonthDay } from '../poolFormat';
import styles from './QuotaPoolToolbar.module.scss';

export interface SpanNavProps {
  spanStart: number;
  spanEnd: number;
  isToday: boolean;
  onShift: (direction: -1 | 1) => void;
  onToday: () => void;
  locale: string;
}

export function SpanNav({ spanStart, spanEnd, isToday, onShift, onToday, locale }: SpanNavProps) {
  const { t } = useTranslation();
  return (
    <div className={styles.nav} role="group" aria-label={t('quota_pool.range_label')}>
      <IconButton
        size="sm"
        aria-label={t('quota_pool.previous_span')}
        icon={<IconChevronLeft size={16} />}
        onClick={() => onShift(-1)}
      />
      <span className={styles.range}>
        {t('quota_pool.range', {
          start: formatMonthDay(spanStart, locale),
          end: formatMonthDay(spanEnd, locale),
        })}
      </span>
      <IconButton
        size="sm"
        aria-label={t('quota_pool.next_span')}
        icon={<IconChevronLeft size={16} className={styles.flip} />}
        onClick={() => onShift(1)}
      />
      {!isToday && (
        <Button variant="ghost" size="sm" onClick={onToday}>
          {t('quota_pool.today')}
        </Button>
      )}
    </div>
  );
}
