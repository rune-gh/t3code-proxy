import { useId, type PropsWithChildren, type ReactNode } from 'react';
import styles from './PageLayout.module.scss';

interface SectionProps {
  title: ReactNode;
  description?: ReactNode;
  /** Right-aligned controls for this section only. */
  actions?: ReactNode;
  className?: string;
  id?: string;
}

/**
 * Titled block of page content. It is flat: a heading row and the content
 * below, separated from the next section by spacing, not by a card border.
 */
export function Section({
  title,
  description,
  actions,
  className,
  id,
  children,
}: PropsWithChildren<SectionProps>) {
  const headingId = useId();
  return (
    <section
      id={id}
      className={[styles.section, className].filter(Boolean).join(' ')}
      aria-labelledby={headingId}
    >
      <div className={styles.sectionHeader}>
        <div className={styles.sectionText}>
          <h2 id={headingId} className={styles.sectionTitle}>
            {title}
          </h2>
          {description ? <p className={styles.sectionDescription}>{description}</p> : null}
        </div>
        {actions ? <div className={styles.actions}>{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}
