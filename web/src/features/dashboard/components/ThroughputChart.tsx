import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Collapsible } from '@/components/ui/Collapsible';
import { formatPercent } from '@/utils/format';
import { TRAFFIC_BUCKET_MINUTES, type TrafficWindow } from '../types';
import { axisMax } from '../utils';
import styles from './ThroughputChart.module.scss';

/** Gridlines including zero, so TICK_COUNT - 1 intervals. */
const TICK_COUNT = 5;
/** Label every n-th bucket on the x-axis. */
const X_LABEL_EVERY = 4;

/**
 * Bucket label. The backend sends server-local strings ("15:04-15:14"); prefer them over
 * the browser clock so a timezone mismatch cannot shift the axis.
 */
function bucketRangeLabel(time: string | undefined, index: number, count: number): string {
  if (time) return time;
  return `-${(count - index) * TRAFFIC_BUCKET_MINUTES}m`;
}

function bucketStartLabel(time: string | undefined, index: number, count: number): string {
  if (!time) return bucketRangeLabel(time, index, count);
  return time.split('-')[0]?.trim() || time;
}

interface ThroughputChartProps {
  traffic: TrafficWindow;
}

/** Stacked success/failure columns per 10-minute bucket with a y-axis and hover values. */
export function ThroughputChart({ traffic }: ThroughputChartProps) {
  const { t } = useTranslation();
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const { buckets, totalSuccess, totalFailure, total, peakTotal } = traffic;
  const scaleMax = useMemo(() => axisMax(peakTotal, TICK_COUNT - 1), [peakTotal]);
  const ticks = useMemo(
    () =>
      Array.from({ length: TICK_COUNT }, (_, index) => {
        const ratio = 1 - index / (TICK_COUNT - 1);
        return { ratio, value: Math.round(scaleMax * ratio) };
      }),
    [scaleMax]
  );

  const summary = t('dashboard.chart_summary', {
    total,
    success: totalSuccess,
    failed: totalFailure,
    minutes: traffic.windowMinutes,
  });

  const active = activeIndex === null ? null : buckets[activeIndex];
  const activeTotal = active ? active.success + active.failed : 0;
  const count = buckets.length;

  return (
    <>
      <figure className={styles.chart}>
        <figcaption className={styles.legend}>
          <span className={styles.legendItem}>
            <span className={`${styles.swatch} ${styles.success}`} aria-hidden="true" />
            {t('dashboard.success')}
            <b>{totalSuccess.toLocaleString()}</b>
          </span>
          <span className={styles.legendItem}>
            <span className={`${styles.swatch} ${styles.failure}`} aria-hidden="true" />
            {t('dashboard.failed')}
            <b>{totalFailure.toLocaleString()}</b>
          </span>
        </figcaption>

        <div className={styles.plot}>
          <div className={styles.yAxis} aria-hidden="true">
            {ticks.map((tick) => (
              <span key={tick.ratio} style={{ top: `${(1 - tick.ratio) * 100}%` }}>
                {tick.value.toLocaleString()}
              </span>
            ))}
          </div>

          <div className={styles.canvas}>
            {ticks.map((tick) => (
              <span
                key={tick.ratio}
                className={
                  tick.ratio === 0 ? `${styles.gridline} ${styles.baseline}` : styles.gridline
                }
                style={{ top: `${(1 - tick.ratio) * 100}%` }}
                aria-hidden="true"
              />
            ))}

            <div
              className={styles.columns}
              role="img"
              aria-label={summary}
              onMouseLeave={() => setActiveIndex(null)}
            >
              {buckets.map((bucket, index) => (
                <div
                  key={bucket.time ?? index}
                  className={
                    index === activeIndex ? `${styles.column} ${styles.active}` : styles.column
                  }
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => setActiveIndex((current) => (current === index ? null : index))}
                >
                  {bucket.failed > 0 ? (
                    <span
                      className={`${styles.bar} ${styles.failure}`}
                      style={{ height: `${(bucket.failed / scaleMax) * 100}%` }}
                    />
                  ) : null}
                  {bucket.success > 0 ? (
                    <span
                      className={`${styles.bar} ${styles.success}`}
                      style={{ height: `${(bucket.success / scaleMax) * 100}%` }}
                    />
                  ) : null}
                </div>
              ))}
            </div>

            {active && activeIndex !== null ? (
              <div
                className={styles.tooltip}
                style={{
                  left: `${((activeIndex + 0.5) / count) * 100}%`,
                  transform:
                    activeIndex < count * 0.2
                      ? 'translateX(-10%)'
                      : activeIndex > count * 0.8
                        ? 'translateX(-90%)'
                        : 'translateX(-50%)',
                }}
                role="status"
              >
                <span className={styles.tooltipTime}>
                  {bucketRangeLabel(active.time, activeIndex, count)}
                </span>
                <span className={styles.tooltipRow}>
                  <span className={`${styles.swatch} ${styles.success}`} aria-hidden="true" />
                  {t('dashboard.success')}
                  <b>{active.success.toLocaleString()}</b>
                </span>
                <span className={styles.tooltipRow}>
                  <span className={`${styles.swatch} ${styles.failure}`} aria-hidden="true" />
                  {t('dashboard.failed')}
                  <b>{active.failed.toLocaleString()}</b>
                </span>
                <span className={styles.tooltipRow}>
                  {t('dashboard.success_rate')}
                  <b>
                    {activeTotal > 0 ? formatPercent((active.success / activeTotal) * 100) : '—'}
                  </b>
                </span>
              </div>
            ) : null}
          </div>
        </div>

        <div className={styles.xAxis} aria-hidden="true">
          {buckets.map((bucket, index) =>
            (count - 1 - index) % X_LABEL_EVERY === 0 ? (
              <span
                key={bucket.time ?? index}
                style={{ left: `${((index + 0.5) / count) * 100}%` }}
              >
                {bucketStartLabel(bucket.time, index, count)}
              </span>
            ) : null
          )}
        </div>
      </figure>

      <Collapsible className={styles.tableToggle} label={t('dashboard.chart_table')}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">{t('dashboard.chart_table_window')}</th>
              <th scope="col">{t('dashboard.success')}</th>
              <th scope="col">{t('dashboard.failed')}</th>
              <th scope="col">{t('dashboard.success_rate')}</th>
            </tr>
          </thead>
          <tbody>
            {buckets.map((bucket, index) => {
              const bucketTotal = bucket.success + bucket.failed;
              return (
                <tr key={bucket.time ?? index}>
                  <th scope="row">{bucketRangeLabel(bucket.time, index, count)}</th>
                  <td>{bucket.success.toLocaleString()}</td>
                  <td>{bucket.failed.toLocaleString()}</td>
                  <td>
                    {bucketTotal > 0 ? formatPercent((bucket.success / bucketTotal) * 100) : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Collapsible>
    </>
  );
}
