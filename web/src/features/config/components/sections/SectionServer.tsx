import { useTranslation } from 'react-i18next';
import type { ConfigSectionProps } from '../../types';
import { isLoopbackHost } from '../../uiState';
import { getValidationMessage } from '../blocks/shared';
import { StringListEditor } from '../blocks/StringListEditor';
import { BlockSetting, SettingList, TextSetting, ToggleSetting } from '../fields/FieldPrimitives';
import { SettingsSection } from '../SettingsSection';

/** Server: listener address and port, TLS, trusted proxies, auth directory. */
export function SectionServer({
  values,
  validationErrors,
  disabled,
  onChange,
}: ConfigSectionProps) {
  const { t } = useTranslation();
  const exposedWithoutTls = !values.tlsEnable && !isLoopbackHost(values.host);

  return (
    <SettingsSection id="server">
      <SettingList>
        <TextSetting
          fieldId="host"
          label={t('config_management.visual.sections.server.host')}
          description={t('config_management.visual.sections.server.host_desc')}
          notice={
            exposedWithoutTls ? t('config_management.visual.sections.server.host_exposed') : null
          }
          placeholder="0.0.0.0"
          value={values.host}
          onChange={(host) => onChange({ host })}
          disabled={disabled}
        />
        <TextSetting
          fieldId="port"
          type="number"
          size="sm"
          label={t('config_management.visual.sections.server.port')}
          placeholder="8317"
          value={values.port}
          onChange={(port) => onChange({ port })}
          disabled={disabled}
          error={getValidationMessage(t, validationErrors?.port)}
        />
        <ToggleSetting
          fieldId="tlsEnable"
          label={t('config_management.visual.sections.tls.enable')}
          description={t('config_management.visual.sections.tls.enable_desc')}
          checked={values.tlsEnable}
          disabled={disabled}
          onChange={(tlsEnable) => onChange({ tlsEnable })}
        />
        {values.tlsEnable ? (
          <>
            <TextSetting
              fieldId="tlsCert"
              size="lg"
              label={t('config_management.visual.sections.tls.cert')}
              placeholder="/path/to/cert.pem"
              value={values.tlsCert}
              onChange={(tlsCert) => onChange({ tlsCert })}
              disabled={disabled}
            />
            <TextSetting
              fieldId="tlsKey"
              size="lg"
              label={t('config_management.visual.sections.tls.key')}
              placeholder="/path/to/key.pem"
              value={values.tlsKey}
              onChange={(tlsKey) => onChange({ tlsKey })}
              disabled={disabled}
            />
          </>
        ) : null}
        <BlockSetting
          fieldId="trustedProxies"
          label={t('config_management.visual.serverExtras.trustedProxies.label')}
          description={t('config_management.visual.serverExtras.trustedProxies.hint')}
          error={getValidationMessage(t, validationErrors?.trustedProxies)}
        >
          <StringListEditor
            value={values.trustedProxies}
            disabled={disabled}
            placeholder="192.168.0.0/24"
            inputAriaLabel={t('config_management.visual.serverExtras.trustedProxies.label')}
            onChange={(trustedProxies) => onChange({ trustedProxies })}
          />
        </BlockSetting>
        <TextSetting
          fieldId="authDir"
          size="lg"
          label={t('config_management.visual.sections.auth.auth_dir')}
          description={t('config_management.visual.sections.auth.auth_dir_hint')}
          placeholder="~/.t3code-proxy"
          value={values.authDir}
          onChange={(authDir) => onChange({ authDir })}
          disabled={disabled}
        />
        <ToggleSetting
          fieldId="commercialMode"
          label={t('config_management.visual.sections.system.commercial_mode')}
          description={t('config_management.visual.sections.system.commercial_mode_desc')}
          checked={values.commercialMode}
          disabled={disabled}
          onChange={(commercialMode) => onChange({ commercialMode })}
        />
      </SettingList>
    </SettingsSection>
  );
}
