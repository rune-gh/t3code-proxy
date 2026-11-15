import { useTranslation } from 'react-i18next';
import type { ConfigSectionProps } from '../../types';
import { getValidationMessage } from '../blocks/shared';
import { SettingList, TextSetting, ToggleSetting } from '../fields/FieldPrimitives';
import { SettingsSection } from '../SettingsSection';

/** Quota history: the recorder that samples Claude and Codex quota for the Overview charts. */
export function SectionQuotaHistory({
  values,
  validationErrors,
  disabled,
  onChange,
}: ConfigSectionProps) {
  const { t } = useTranslation();
  const key = (name: string) => `config_management.visual.sections.quotaHistory.${name}`;

  return (
    <SettingsSection id="quotaHistory">
      <SettingList>
        <ToggleSetting
          fieldId="quotaHistoryEnabled"
          label={t(key('enabled'))}
          description={t(key('enabled_hint'))}
          checked={values.quotaHistoryEnabled}
          disabled={disabled}
          onChange={(quotaHistoryEnabled) => onChange({ quotaHistoryEnabled })}
        />
        <TextSetting
          fieldId="quotaHistoryInterval"
          size="sm"
          label={t(key('interval'))}
          description={t(key('interval_hint'))}
          placeholder="10m"
          value={values.quotaHistoryInterval}
          onChange={(quotaHistoryInterval) => onChange({ quotaHistoryInterval })}
          disabled={disabled}
          error={getValidationMessage(t, validationErrors?.quotaHistoryInterval)}
        />
        <TextSetting
          fieldId="quotaHistoryRetention"
          size="sm"
          label={t(key('retention'))}
          description={t(key('retention_hint'))}
          placeholder="35d"
          value={values.quotaHistoryRetention}
          onChange={(quotaHistoryRetention) => onChange({ quotaHistoryRetention })}
          disabled={disabled}
          error={getValidationMessage(t, validationErrors?.quotaHistoryRetention)}
        />
        <TextSetting
          fieldId="quotaHistoryPath"
          size="lg"
          label={t(key('path'))}
          description={t(key('path_hint'))}
          placeholder="quota-history.db"
          value={values.quotaHistoryPath}
          onChange={(quotaHistoryPath) => onChange({ quotaHistoryPath })}
          disabled={disabled}
        />
      </SettingList>
    </SettingsSection>
  );
}
