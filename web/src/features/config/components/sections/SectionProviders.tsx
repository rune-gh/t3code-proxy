import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { ConfigSectionProps } from '../../types';
import { StringListEditor } from '../blocks/StringListEditor';
import { getValidationMessage } from '../blocks/shared';
import { BlockSetting, SettingList, TextSetting, ToggleSetting } from '../fields/FieldPrimitives';
import { SettingsSection } from '../SettingsSection';
import { SectionOAuthBehavior } from './SectionOAuthBehavior';

/** Providers: per-provider behavior, sensitive-word handling and default request headers. */
export function SectionProviders({
  values,
  validationErrors,
  disabled,
  onChange,
}: ConfigSectionProps) {
  const { t } = useTranslation();

  const handleAntigravitySensitiveWordsChange = useCallback(
    (antigravitySensitiveWords: string[]) => onChange({ antigravitySensitiveWords }),
    [onChange]
  );
  const handleDevinSensitiveWordsChange = useCallback(
    (devinSensitiveWords: string[]) => onChange({ devinSensitiveWords }),
    [onChange]
  );

  return (
    <SettingsSection id="providers">
      <SectionOAuthBehavior
        values={values}
        validationErrors={validationErrors}
        disabled={disabled}
        onChange={onChange}
      />

      <SettingList title={t('config_management.visual.sections.advanced.antigravity_title')}>
        <ToggleSetting
          fieldId="quotaAntigravityCredits"
          label={t('config_management.visual.sections.advanced.antigravity_credits')}
          checked={values.quotaAntigravityCredits}
          disabled={disabled}
          onChange={(quotaAntigravityCredits) => onChange({ quotaAntigravityCredits })}
        />
      </SettingList>
      <SettingList
        title={t('config_management.visual.sections.system.antigravity_sensitive_words')}
        description={t('config_management.visual.sections.system.antigravity_sensitive_words_desc')}
      >
        <BlockSetting
          fieldId="antigravitySensitiveWords"
          label={t('config_management.visual.sections.system.antigravity_sensitive_words_label')}
          description={t(
            'config_management.visual.sections.system.antigravity_sensitive_words_hint'
          )}
        >
          <StringListEditor
            value={values.antigravitySensitiveWords}
            disabled={disabled}
            placeholder={t(
              'config_management.visual.sections.system.antigravity_sensitive_words_placeholder'
            )}
            inputAriaLabel={t(
              'config_management.visual.sections.system.antigravity_sensitive_words_label'
            )}
            onChange={handleAntigravitySensitiveWordsChange}
          />
        </BlockSetting>
      </SettingList>

      <SettingList title={t('config_management.visual.sections.advanced.signature_title')}>
        <ToggleSetting
          fieldId="antigravitySignatureCacheEnabled"
          label={t('config_management.visual.sections.system.antigravity_signature_cache')}
          description={t(
            'config_management.visual.sections.system.antigravity_signature_cache_desc'
          )}
          checked={values.antigravitySignatureCacheEnabled}
          disabled={disabled}
          onChange={(antigravitySignatureCacheEnabled) =>
            onChange({ antigravitySignatureCacheEnabled })
          }
        />
        <ToggleSetting
          fieldId="antigravitySignatureBypassStrict"
          label={t('config_management.visual.sections.system.antigravity_signature_strict')}
          description={t(
            'config_management.visual.sections.system.antigravity_signature_strict_desc'
          )}
          checked={values.antigravitySignatureBypassStrict}
          disabled={disabled}
          onChange={(antigravitySignatureBypassStrict) =>
            onChange({ antigravitySignatureBypassStrict })
          }
        />
      </SettingList>

      <SettingList
        title={t('config_management.visual.sections.system.devin_sensitive_words')}
        description={t('config_management.visual.sections.system.devin_sensitive_words_desc')}
      >
        <BlockSetting
          fieldId="devinSensitiveWords"
          label={t('config_management.visual.sections.system.devin_sensitive_words_label')}
          description={t('config_management.visual.sections.system.devin_sensitive_words_hint')}
        >
          <StringListEditor
            value={values.devinSensitiveWords}
            disabled={disabled}
            placeholder={t(
              'config_management.visual.sections.system.devin_sensitive_words_placeholder'
            )}
            inputAriaLabel={t(
              'config_management.visual.sections.system.devin_sensitive_words_label'
            )}
            onChange={handleDevinSensitiveWordsChange}
          />
        </BlockSetting>
      </SettingList>

      <SettingList title={t('config_management.visual.sections.advanced.aistudio_title')}>
        <ToggleSetting
          fieldId="wsAuth"
          label={t('config_management.visual.sections.network.ws_auth')}
          description={t('config_management.visual.sections.network.ws_auth_desc')}
          checked={values.wsAuth}
          disabled={disabled}
          onChange={(wsAuth) => onChange({ wsAuth })}
        />
      </SettingList>

      <SettingList title={t('config_management.visual.sections.headers.claude_title')}>
        <TextSetting
          fieldId="claudeHeaderUserAgent"
          size="lg"
          label={t('config_management.visual.sections.headers.user_agent')}
          placeholder="claude-cli/2.1.44 (external, sdk-cli)"
          value={values.claudeHeaderUserAgent}
          onChange={(claudeHeaderUserAgent) => onChange({ claudeHeaderUserAgent })}
          disabled={disabled}
        />
        <TextSetting
          fieldId="claudeHeaderPackageVersion"
          size="sm"
          label={t('config_management.visual.sections.headers.package_version')}
          placeholder="0.74.0"
          value={values.claudeHeaderPackageVersion}
          onChange={(claudeHeaderPackageVersion) => onChange({ claudeHeaderPackageVersion })}
          disabled={disabled}
        />
        <TextSetting
          fieldId="claudeHeaderRuntimeVersion"
          size="sm"
          label={t('config_management.visual.sections.headers.runtime_version')}
          placeholder="v24.3.0"
          value={values.claudeHeaderRuntimeVersion}
          onChange={(claudeHeaderRuntimeVersion) => onChange({ claudeHeaderRuntimeVersion })}
          disabled={disabled}
        />
        <TextSetting
          fieldId="claudeHeaderOs"
          size="sm"
          label={t('config_management.visual.sections.headers.os')}
          placeholder="MacOS"
          value={values.claudeHeaderOs}
          onChange={(claudeHeaderOs) => onChange({ claudeHeaderOs })}
          disabled={disabled}
        />
        <TextSetting
          fieldId="claudeHeaderArch"
          size="sm"
          label={t('config_management.visual.sections.headers.arch')}
          placeholder="arm64"
          value={values.claudeHeaderArch}
          onChange={(claudeHeaderArch) => onChange({ claudeHeaderArch })}
          disabled={disabled}
        />
        <TextSetting
          fieldId="claudeHeaderTimezone"
          label={t('config_management.visual.additions.claudeHeaderTimezone.label')}
          description={t('config_management.visual.additions.claudeHeaderTimezone.hint')}
          value={values.claudeHeaderTimezone}
          onChange={(claudeHeaderTimezone) => onChange({ claudeHeaderTimezone })}
          disabled={disabled}
          error={getValidationMessage(t, validationErrors?.claudeHeaderTimezone)}
        />
        <TextSetting
          fieldId="claudeHeaderTimeout"
          size="sm"
          label={t('config_management.visual.sections.headers.timeout')}
          placeholder="600"
          value={values.claudeHeaderTimeout}
          onChange={(claudeHeaderTimeout) => onChange({ claudeHeaderTimeout })}
          disabled={disabled}
        />
        <ToggleSetting
          fieldId="claudeHeaderStabilizeDeviceProfile"
          label={t('config_management.visual.sections.headers.stabilize_device')}
          description={t('config_management.visual.sections.headers.stabilize_device_desc')}
          checked={values.claudeHeaderStabilizeDeviceProfile}
          disabled={disabled}
          onChange={(claudeHeaderStabilizeDeviceProfile) =>
            onChange({ claudeHeaderStabilizeDeviceProfile })
          }
        />
      </SettingList>

      <SettingList title={t('config_management.visual.sections.headers.codex_title')}>
        <TextSetting
          fieldId="codexHeaderUserAgent"
          size="lg"
          label={t('config_management.visual.sections.headers.user_agent')}
          placeholder="codex_cli_rs/0.114.0 (Mac OS 14.2.0; x86_64) vscode/1.111.0"
          value={values.codexHeaderUserAgent}
          onChange={(codexHeaderUserAgent) => onChange({ codexHeaderUserAgent })}
          disabled={disabled}
        />
        <TextSetting
          fieldId="codexHeaderBetaFeatures"
          label={t('config_management.visual.sections.headers.beta_features')}
          placeholder="multi_agent"
          value={values.codexHeaderBetaFeatures}
          onChange={(codexHeaderBetaFeatures) => onChange({ codexHeaderBetaFeatures })}
          disabled={disabled}
        />
      </SettingList>
    </SettingsSection>
  );
}
