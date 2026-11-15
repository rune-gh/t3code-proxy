import { useTranslation } from 'react-i18next';
import type { ConfigSectionProps } from '../../types';
import { SecretSetting, SettingList, TextSetting, ToggleSetting } from '../fields/FieldPrimitives';
import { SettingsSection } from '../SettingsSection';

/** Management: the panel secret, remote access to the panel and panel delivery. */
export function SectionManagement({ values, disabled, onChange }: ConfigSectionProps) {
  const { t } = useTranslation();

  return (
    <SettingsSection id="management">
      <SettingList>
        <SecretSetting
          fieldId="rmSecretKey"
          label={t('config_management.visual.sections.remote.secret_key')}
          description={t('config_management.visual.sections.remote.secret_key_desc')}
          placeholder={t('config_management.visual.sections.remote.secret_key_placeholder')}
          value={values.rmSecretKey}
          onChange={(rmSecretKey) => onChange({ rmSecretKey })}
          disabled={disabled}
        />
        <ToggleSetting
          fieldId="rmAllowRemote"
          label={t('config_management.visual.sections.remote.allow_remote')}
          description={t('config_management.visual.sections.remote.allow_remote_desc')}
          checked={values.rmAllowRemote}
          disabled={disabled}
          onChange={(rmAllowRemote) => onChange({ rmAllowRemote })}
        />
        <ToggleSetting
          fieldId="rmDisableControlPanel"
          label={t('config_management.visual.sections.remote.disable_panel')}
          description={t('config_management.visual.sections.remote.disable_panel_desc')}
          checked={values.rmDisableControlPanel}
          disabled={disabled}
          onChange={(rmDisableControlPanel) => onChange({ rmDisableControlPanel })}
        />
        <ToggleSetting
          fieldId="rmDisableAutoUpdatePanel"
          label={t('config_management.visual.sections.remote.disable_auto_update_panel')}
          description={t('config_management.visual.sections.remote.disable_auto_update_panel_desc')}
          checked={values.rmDisableAutoUpdatePanel}
          disabled={disabled}
          onChange={(rmDisableAutoUpdatePanel) => onChange({ rmDisableAutoUpdatePanel })}
        />
        <TextSetting
          fieldId="rmPanelRepo"
          size="lg"
          label={t('config_management.visual.sections.remote.panel_repo')}
          description={t('config_management.visual.sections.remote.panel_repo_desc')}
          placeholder="https://github.com/rune-oai/t3code-proxy"
          value={values.rmPanelRepo}
          onChange={(rmPanelRepo) => onChange({ rmPanelRepo })}
          disabled={disabled}
        />
        <SecretSetting
          fieldId="githubToken"
          label={t('config_management.visual.sections.server.github_token')}
          description={t('config_management.visual.sections.server.github_token_hint')}
          value={values.githubToken}
          onChange={(githubToken) => onChange({ githubToken })}
          disabled={disabled}
        />
      </SettingList>
    </SettingsSection>
  );
}
