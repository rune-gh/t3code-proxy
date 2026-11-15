import type { PropsWithChildren, ReactNode } from 'react';
import styles from './PageLayout.module.scss';

interface ToolbarProps {
  /** Right-aligned controls (view switches, secondary actions). */
  end?: ReactNode;
  /** Names the group for screen readers, e.g. "Filters". */
  ariaLabel?: string;
  className?: string;
}

/**
 * One row of filters and view controls above content. Children sit on the
 * left (search first), `end` on the right; wraps on narrow screens.
 */
export function Toolbar({ end, ariaLabel, className, children }: PropsWithChildren<ToolbarProps>) {
  return (
    <div
      className={[styles.toolbar, className].filter(Boolean).join(' ')}
      role="toolbar"
      aria-label={ariaLabel}
    >
      <div className={styles.toolbarStart}>{children}</div>
      {end ? <div className={styles.toolbarEnd}>{end}</div> : null}
    </div>
  );
}
