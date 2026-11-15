import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { PluginStoreAuthRule } from '@/types/visualConfig';
import type { ConfigSectionProps } from '../../types';
import { PluginStoreAuthEditor } from '../blocks/PluginStoreAuthEditor';
import { StringListEditor } from '../blocks/StringListEditor';
import {
  BlockSetting,
  FieldHint,
  FieldStack,
  SettingCell,
  SettingList,
  ToggleSetting,
} from '../fields/FieldPrimitives';
import { SettingsSection } from '../SettingsSection';

/** Plugins: the plugin system switch, extra store sources and store auth rules. */
export function SectionPlugins({ values, disabled, onChange }: ConfigSectionProps) {
  const { t } = useTranslation();

  const handlePluginStoreSourcesChange = useCallback(
    (pluginStoreSources: string[]) => onChange({ pluginStoreSources }),
    [onChange]
  );
  const handlePluginStoreAuthChange = useCallback(
    (pluginStoreAuth: PluginStoreAuthRule[]) => onChange({ pluginStoreAuth }),
    [onChange]
  );

  return (
    <SettingsSection id="plugins">
      <SettingList>
        <ToggleSetting
          fieldId="pluginsEnabled"
          label={t('config_management.visual.sections.system.plugins_enabled')}
          description={t('config_management.visual.sections.system.plugins_enabled_desc')}
          checked={values.pluginsEnabled}
          disabled={disabled}
          onChange={(pluginsEnabled) => onChange({ pluginsEnabled })}
        />
      </SettingList>

      <SettingList
        title={t('config_management.visual.sections.system.plugin_store_sources')}
        description={t('config_management.visual.sections.system.plugin_store_sources_desc')}
      >
        <BlockSetting
          fieldId="pluginStoreSources"
          label={t('config_management.visual.sections.system.plugin_store_sources_label')}
          description={t('config_management.visual.sections.system.plugin_store_sources_hint')}
        >
          <StringListEditor
            value={values.pluginStoreSources}
            disabled={disabled}
            placeholder={t(
              'config_management.visual.sections.system.plugin_store_sources_placeholder'
            )}
            inputAriaLabel={t(
              'config_management.visual.sections.system.plugin_store_sources_label'
            )}
            onChange={handlePluginStoreSourcesChange}
          />
        </BlockSetting>
      </SettingList>

      <SettingList
        title={t('config_management.visual.sections.system.plugin_store_auth')}
        description={t('config_management.visual.sections.system.plugin_store_auth_desc')}
      >
        <SettingCell fieldId="pluginStoreAuth">
          <FieldStack>
            <FieldHint>
              {t('config_management.visual.sections.system.plugin_store_auth_hint')}
            </FieldHint>
            <PluginStoreAuthEditor
              value={values.pluginStoreAuth}
              disabled={disabled}
              onChange={handlePluginStoreAuthChange}
            />
          </FieldStack>
        </SettingCell>
      </SettingList>
    </SettingsSection>
  );
}
