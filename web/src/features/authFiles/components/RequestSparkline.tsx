import type { RecentRequestBucket } from '@/utils/recentRequests';
import styles from './AccountsTable.module.scss';

const BAR_WIDTH = 2;
const BAR_GAP = 1;
const HEIGHT = 16;

/**
 * Twenty 10-minute buckets as tiny bars: height is volume, the red cap is the failed
 * share. Decorative (aria-hidden); the numbers beside it carry the information.
 */
export function RequestSparkline({ buckets }: { buckets: RecentRequestBucket[] }) {
  const slots = Array.from({ length: 20 }, (_, index) => buckets[buckets.length - 20 + index]);
  const max = Math.max(1, ...slots.map((bucket) => (bucket ? bucket.success + bucket.failed : 0)));
  const width = slots.length * (BAR_WIDTH + BAR_GAP) - BAR_GAP;

  return (
    <svg
      className={styles.sparkline}
      width={width}
      height={HEIGHT}
      viewBox={`0 0 ${width} ${HEIGHT}`}
      aria-hidden="true"
      focusable="false"
    >
      {slots.map((bucket, index) => {
        const x = index * (BAR_WIDTH + BAR_GAP);
        const total = bucket ? bucket.success + bucket.failed : 0;
        if (total === 0) {
          return (
            <rect key={index} x={x} y={HEIGHT - 1} width={BAR_WIDTH} height={1} className={styles.sparkIdle} />
          );
        }
        const height = Math.max(2, Math.round((total / max) * HEIGHT));
        const failedHeight = bucket.failed > 0 ? Math.max(1, Math.round((bucket.failed / total) * height)) : 0;
        return (
          <g key={index}>
            <rect
              x={x}
              y={HEIGHT - height + failedHeight}
              width={BAR_WIDTH}
              height={height - failedHeight}
              className={styles.sparkOk}
            />
            {failedHeight > 0 ? (
              <rect
                x={x}
                y={HEIGHT - height}
                width={BAR_WIDTH}
                height={failedHeight}
                className={styles.sparkFail}
              />
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}
