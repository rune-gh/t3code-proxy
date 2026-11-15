import { useTranslation } from 'react-i18next';
import { Select } from '@/components/ui/Select';
import { ADVANCED_SECTION_IDS, PRIMARY_SECTION_IDS, type ConfigSectionId } from '../constants';
import styles from './ConfigNav.module.scss';

export type ConfigNavProps = {
  active: ConfigSectionId;
  errorCounts: Partial<Record<ConfigSectionId, number>>;
  dirtySections: ReadonlySet<ConfigSectionId>;
  onSelect: (id: ConfigSectionId) => void;
};

/** Accessible name of a section link: title, then error count and unsaved state. */
export function useSectionLabel() {
  const { t } = useTranslation();
  return (id: ConfigSectionId, errors: number, dirty: boolean) =>
    [
      t(`config_management.sections.${id}.title`),
      errors > 0 ? t('config_management.meta_errors', { count: errors }) : '',
      dirty ? t('config_management.status_dirty_short') : '',
    ]
      .filter(Boolean)
      .join(', ');
}

/** Sticky section list for wide screens. */
export function ConfigNavList({ active, errorCounts, dirtySections, onSelect }: ConfigNavProps) {
  const { t } = useTranslation();
  const sectionLabel = useSectionLabel();

  const renderItem = (id: ConfigSectionId) => {
    const errors = errorCounts[id] ?? 0;
    const dirty = dirtySections.has(id);
    return (
      <li key={id}>
        <a
          href={`#config-section-${id}`}
          className={styles.item}
          aria-current={active === id ? 'location' : undefined}
          aria-label={sectionLabel(id, errors, dirty)}
          onClick={(event) => {
            event.preventDefault();
            onSelect(id);
          }}
        >
          <span className={styles.label}>{t(`config_management.sections.${id}.title`)}</span>
          {errors > 0 ? (
            <span className={styles.errorCount} aria-hidden="true">
              {errors}
            </span>
          ) : dirty ? (
            <span className={styles.dirtyDot} aria-hidden="true" />
          ) : null}
        </a>
      </li>
    );
  };

  return (
    <nav className={styles.nav} aria-label={t('config_management.nav_label')}>
      <ul className={styles.list}>{PRIMARY_SECTION_IDS.map(renderItem)}</ul>
      <div className={styles.groupLabel}>{t('config_management.advanced.title')}</div>
      <ul className={styles.list}>{ADVANCED_SECTION_IDS.map(renderItem)}</ul>
    </nav>
  );
}

/** Section picker for narrow screens. */
export function ConfigNavSelect({ active, errorCounts, dirtySections, onSelect }: ConfigNavProps) {
  const { t } = useTranslation();
  const sectionLabel = useSectionLabel();
  const option = (id: ConfigSectionId) => ({
    value: id,
    label: sectionLabel(id, errorCounts[id] ?? 0, dirtySections.has(id)),
  });
  const advanced = t('config_management.advanced.title');
  return (
    <Select
      value={active}
      fullWidth
      ariaLabel={t('config_management.nav_label')}
      options={[
        ...PRIMARY_SECTION_IDS.map(option),
        ...ADVANCED_SECTION_IDS.map((id) => {
          const item = option(id);
          return { ...item, label: `${advanced}: ${item.label}` };
        }),
      ]}
      onChange={(value) => onSelect(value as ConfigSectionId)}
    />
  );
}
