import type { ReactNode } from 'react';
import styles from './PageLayout.module.scss';

interface PageHeaderProps {
  title: ReactNode;
  /** One plain sentence about what the page is for. Optional. */
  description?: ReactNode;
  /** Inline context after the title, e.g. a count Badge. */
  meta?: ReactNode;
  /** Right-aligned actions; at most one `variant="primary"` button. */
  actions?: ReactNode;
  /** A `<Tabs variant="underline">` row for page-level views. */
  tabs?: ReactNode;
  className?: string;
}

/** Top of every page: title, optional description, actions and tabs. */
export function PageHeader({
  title,
  description,
  meta,
  actions,
  tabs,
  className,
}: PageHeaderProps) {
  return (
    <header className={[styles.header, className].filter(Boolean).join(' ')}>
      <div className={styles.headerRow}>
        <div className={styles.headerText}>
          <div className={styles.titleRow}>
            <h1 className={styles.title}>{title}</h1>
            {meta ? <div className={styles.meta}>{meta}</div> : null}
          </div>
          {description ? <p className={styles.description}>{description}</p> : null}
        </div>
        {actions ? <div className={styles.actions}>{actions}</div> : null}
      </div>
      {tabs ? <div className={styles.tabs}>{tabs}</div> : null}
    </header>
  );
}
