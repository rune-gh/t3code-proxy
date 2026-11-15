import { useId, type ReactNode } from 'react';
import { IconNetwork } from '@/components/ui/icons';
import styles from './ModelRules.module.scss';

export type RuleGroupProps = {
  provider: string;
  label: string;
  icon: string | null;
  /** Short count, e.g. "6 mappings". */
  summary: string;
  dirty: boolean;
  dirtyLabel: string;
  actions?: ReactNode;
  children: ReactNode;
};

/** One provider's rules panel; shared by the excluded-model and alias editors. */
export function RuleGroup({
  provider,
  label,
  icon,
  summary,
  dirty,
  dirtyLabel,
  actions,
  children,
}: RuleGroupProps) {
  const headingId = useId();
  return (
    <section className={styles.group} aria-labelledby={headingId} data-provider={provider}>
      <header className={styles.groupHead}>
        <span className={styles.groupIcon} aria-hidden="true">
          {icon ? <img src={icon} alt="" /> : <IconNetwork size={16} />}
        </span>
        <h2 className={styles.groupTitle} id={headingId}>
          {label}
        </h2>
        {dirty ? <span className={styles.groupDirty} role="img" aria-label={dirtyLabel} /> : null}
        <span className={styles.groupSummary}>{summary}</span>
        {actions ? <div className={styles.groupActions}>{actions}</div> : null}
      </header>
      {children}
    </section>
  );
}
