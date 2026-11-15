import type { ReactNode } from 'react';
import styles from './PageLayout.module.scss';

interface StatProps {
  label: ReactNode;
  value: ReactNode;
  /** Unit or denominator shown after the value, e.g. "of 600%". */
  unit?: ReactNode;
  /** Muted line under the value. */
  hint?: ReactNode;
  /** Change indicator; tone colours it. */
  delta?: { value: ReactNode; tone?: 'positive' | 'negative' | 'neutral' };
  /** `lg` (32px) is reserved for a page's one headline metric. */
  size?: 'md' | 'lg';
  className?: string;
}

/** Label over a tabular-number value. Use in a row; never nest inside a card in a card. */
export function Stat({ label, value, unit, hint, delta, size = 'md', className }: StatProps) {
  return (
    <div
      className={[styles.stat, size === 'lg' ? styles.statLg : '', className]
        .filter(Boolean)
        .join(' ')}
    >
      <div className={styles.statLabel}>{label}</div>
      <div className={styles.statValueRow}>
        <span className={styles.statValue}>{value}</span>
        {unit ? <span className={styles.statUnit}>{unit}</span> : null}
        {delta ? (
          <span
            className={[styles.statDelta, styles[`delta-${delta.tone ?? 'neutral'}`]].join(' ')}
          >
            {delta.value}
          </span>
        ) : null}
      </div>
      {hint ? <div className={styles.statHint}>{hint}</div> : null}
    </div>
  );
}
