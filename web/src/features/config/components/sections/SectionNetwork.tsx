import { useTranslation } from 'react-i18next';
import type { VisualConfigValues } from '@/types/visualConfig';
import type { ConfigSectionProps } from '../../types';
import { getValidationMessage } from '../blocks/shared';
import { SelectSetting, SettingList, TextSetting, ToggleSetting } from '../fields/FieldPrimitives';
import { SettingsSection } from '../SettingsSection';

type DisableImageGeneration = VisualConfigValues['disableImageGeneration'];

/** Network and requests: outbound proxy, header pass-through, refresh workers, images. */
export function SectionNetwork({
  values,
  validationErrors,
  disabled,
  onChange,
}: ConfigSectionProps) {
  const { t } = useTranslation();
  const key = (name: string) => `config_management.visual.sections.network.${name}`;

  const disableImageGenerationOptions: Array<{ value: DisableImageGeneration; label: string }> = [
    { value: 'false', label: t(key('disable_image_generation_false')) },
    { value: 'true', label: t(key('disable_image_generation_true')) },
    { value: 'chat', label: t(key('disable_image_generation_chat')) },
    { value: 'passthrough', label: t(key('disable_image_generation_passthrough')) },
  ];

  return (
    <SettingsSection id="network">
      <SettingList>
        <TextSetting
          fieldId="proxyUrl"
          size="lg"
          label={t(key('proxy_url'))}
          description={t(key('proxy_url_desc'))}
          placeholder="socks5://user:pass@127.0.0.1:1080/"
          value={values.proxyUrl}
          onChange={(proxyUrl) => onChange({ proxyUrl })}
          disabled={disabled}
        />
        <ToggleSetting
          fieldId="passthroughHeaders"
          label={t(key('passthrough_headers'))}
          description={t(key('passthrough_headers_desc'))}
          checked={values.passthroughHeaders}
          disabled={disabled}
          onChange={(passthroughHeaders) => onChange({ passthroughHeaders })}
        />
        <TextSetting
          fieldId="authAutoRefreshWorkers"
          size="sm"
          label={t(key('auth_auto_refresh_workers'))}
          description={t(key('auth_auto_refresh_workers_hint'))}
          type="number"
          placeholder="16"
          value={values.authAutoRefreshWorkers}
          onChange={(authAutoRefreshWorkers) => onChange({ authAutoRefreshWorkers })}
          disabled={disabled}
          error={getValidationMessage(t, validationErrors?.authAutoRefreshWorkers)}
        />
      </SettingList>

      <SettingList title={t('config_management.sections.network.media')}>
        <SelectSetting
          fieldId="disableImageGeneration"
          label={t(key('disable_image_generation'))}
          description={t(key('disable_image_generation_hint'))}
          value={values.disableImageGeneration}
          options={disableImageGenerationOptions}
          disabled={disabled}
          onChange={(disableImageGeneration) => onChange({ disableImageGeneration })}
        />
        <TextSetting
          fieldId="gptImage2BaseModel"
          label={t(key('gpt_image_2_base_model'))}
          description={t(key('gpt_image_2_base_model_hint'))}
          placeholder="gpt-5.4-mini"
          value={values.gptImage2BaseModel}
          onChange={(gptImage2BaseModel) => onChange({ gptImage2BaseModel })}
          disabled={disabled}
        />
        <TextSetting
          fieldId="videoResultAuthCacheTTL"
          size="sm"
          label={t('config_management.visual.additions.videoResultAuthCacheTTL.label')}
          description={t('config_management.visual.additions.videoResultAuthCacheTTL.hint')}
          value={values.videoResultAuthCacheTTL}
          onChange={(videoResultAuthCacheTTL) => onChange({ videoResultAuthCacheTTL })}
          disabled={disabled}
          error={getValidationMessage(t, validationErrors?.videoResultAuthCacheTTL)}
        />
      </SettingList>
    </SettingsSection>
  );
}
