import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Section } from '@/components/ui/Section';
import { configSectionDomId, type ConfigSectionId } from '../constants';
import { FIELDS_ROOT_CLASS } from './fields/FieldPrimitives';
import styles from './SettingsSection.module.scss';

/** One settings section: heading from `config_management.sections.<id>`, rows below. */
export function SettingsSection({
  id,
  actions,
  children,
}: {
  id: ConfigSectionId;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <Section
      id={configSectionDomId(id)}
      className={`${styles.section} ${FIELDS_ROOT_CLASS}`}
      title={t(`config_management.sections.${id}.title`)}
      description={t(`config_management.sections.${id}.description`)}
      actions={actions}
    >
      {children}
    </Section>
  );
}
