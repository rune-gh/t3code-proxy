import { useTranslation } from 'react-i18next';
import type { ConfigSectionProps } from '../../types';
import { getValidationMessage } from '../blocks/shared';
import { SettingList, TextSetting, ToggleSetting } from '../fields/FieldPrimitives';
import { SettingsSection } from '../SettingsSection';

/** Logging and usage: debug output, log files, request logs and usage statistics. */
export function SectionLogging({
  values,
  validationErrors,
  disabled,
  onChange,
}: ConfigSectionProps) {
  const { t } = useTranslation();
  const key = (name: string) => `config_management.visual.sections.system.${name}`;

  return (
    <SettingsSection id="logging">
      <SettingList>
        <ToggleSetting
          fieldId="debug"
          label={t(key('debug'))}
          description={t(key('debug_desc'))}
          checked={values.debug}
          disabled={disabled}
          onChange={(debug) => onChange({ debug })}
        />
        <ToggleSetting
          fieldId="loggingToFile"
          label={t(key('logging_to_file'))}
          description={t(key('logging_to_file_desc'))}
          checked={values.loggingToFile}
          disabled={disabled}
          onChange={(loggingToFile) => onChange({ loggingToFile })}
        />
        <ToggleSetting
          fieldId="requestLog"
          label={t(key('request_log'))}
          description={t(key('request_log_desc'))}
          checked={values.requestLog}
          disabled={disabled}
          onChange={(requestLog) => onChange({ requestLog })}
        />
        <TextSetting
          fieldId="logsMaxTotalSizeMb"
          size="sm"
          label={t(key('logs_max_size'))}
          description={t(key('logs_max_size_desc'))}
          type="number"
          placeholder="0"
          value={values.logsMaxTotalSizeMb}
          onChange={(logsMaxTotalSizeMb) => onChange({ logsMaxTotalSizeMb })}
          disabled={disabled}
          error={getValidationMessage(t, validationErrors?.logsMaxTotalSizeMb)}
        />
        <TextSetting
          fieldId="errorLogsMaxFiles"
          size="sm"
          label={t(key('error_logs_max_files'))}
          type="number"
          placeholder="10"
          value={values.errorLogsMaxFiles}
          onChange={(errorLogsMaxFiles) => onChange({ errorLogsMaxFiles })}
          disabled={disabled}
          error={getValidationMessage(t, validationErrors?.errorLogsMaxFiles)}
        />
      </SettingList>

      <SettingList title={t('config_management.sections.logging.usage')}>
        <ToggleSetting
          fieldId="usageStatisticsEnabled"
          label={t(key('usage_statistics_enabled'))}
          description={t(key('usage_statistics_enabled_desc'))}
          checked={values.usageStatisticsEnabled}
          disabled={disabled}
          onChange={(usageStatisticsEnabled) => onChange({ usageStatisticsEnabled })}
        />
        <TextSetting
          fieldId="redisUsageQueueRetentionSeconds"
          size="sm"
          label={t(key('redis_usage_retention'))}
          description={t(key('redis_usage_retention_hint'))}
          type="number"
          min={1}
          max={3600}
          placeholder="60"
          value={values.redisUsageQueueRetentionSeconds}
          onChange={(redisUsageQueueRetentionSeconds) =>
            onChange({ redisUsageQueueRetentionSeconds })
          }
          disabled={disabled}
          error={getValidationMessage(t, validationErrors?.redisUsageQueueRetentionSeconds)}
        />
      </SettingList>
    </SettingsSection>
  );
}
