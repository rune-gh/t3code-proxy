import type { HTMLAttributes, PropsWithChildren } from 'react';
import styles from './Badge.module.scss';

export type BadgeTone = 'neutral' | 'primary' | 'success' | 'warning' | 'destructive' | 'info';

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  /** Leading status dot, for live states such as connected / cooling down. */
  dot?: boolean;
  /** Outline instead of a tinted fill, for low-emphasis metadata. */
  outline?: boolean;
}

/** Small status pill or count. Text stays short: one or two words, or a number. */
export function Badge({
  tone = 'neutral',
  dot = false,
  outline = false,
  className,
  children,
  ...rest
}: PropsWithChildren<BadgeProps>) {
  const cls = [styles.badge, styles[tone], outline ? styles.outline : '', className]
    .filter(Boolean)
    .join(' ');
  return (
    <span className={cls} {...rest}>
      {dot ? <span className={styles.dot} aria-hidden="true" /> : null}
      {children}
    </span>
  );
}

/** Bare status dot (8px) for rows and the sidebar connection indicator. */
export function StatusDot({
  tone = 'neutral',
  className,
  ...rest
}: HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone }) {
  return (
    <span
      className={[styles.statusDot, styles[tone], className].filter(Boolean).join(' ')}
      {...rest}
    />
  );
}
