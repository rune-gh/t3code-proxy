import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import type { VisualConfigValues } from '@/types/visualConfig';
import type { ConfigSectionProps } from '../../types';
import { getValidationMessage } from '../blocks/shared';
import { SelectSetting, SettingList, TextSetting, ToggleSetting } from '../fields/FieldPrimitives';
import { SettingsSection } from '../SettingsSection';

type RoutingStrategy = VisualConfigValues['routingStrategy'];

/**
 * Routing: the Routing page owns strategy, order and affinity with a live board; these rows
 * keep the same keys plus retry and cooldown limits editable from one place.
 */
export function SectionRouting({
  values,
  validationErrors,
  disabled,
  onChange,
}: ConfigSectionProps) {
  const { t } = useTranslation();

  const strategyOptions: Array<{ value: RoutingStrategy; label: string }> = [
    {
      value: 'soonest-reset-first',
      label: t('config_management.visual.sections.network.strategy_soonest_reset_first'),
    },
    {
      value: 'round-robin',
      label: t('config_management.visual.sections.network.strategy_round_robin'),
    },
    {
      value: 'weighted-round-robin',
      label: t('config_management.visual.sections.network.strategy_weighted_round_robin'),
    },
    {
      value: 'fill-first',
      label: t('config_management.visual.sections.network.strategy_fill_first'),
    },
  ];

  return (
    <SettingsSection
      id="routing"
      actions={
        <Link to="/routing" className="btn btn-secondary btn-sm">
          {t('config_management.sections.routing.open')}
        </Link>
      }
    >
      <SettingList title={t('config_management.sections.routing.selection')}>
        <SelectSetting
          fieldId="routingStrategy"
          label={t('config_management.visual.sections.network.routing_strategy')}
          description={t('config_management.visual.sections.network.routing_strategy_hint')}
          value={values.routingStrategy}
          options={strategyOptions}
          disabled={disabled}
          onChange={(routingStrategy) => onChange({ routingStrategy })}
        />
        <ToggleSetting
          fieldId="routingSessionAffinity"
          label={t('config_management.visual.sections.network.session_affinity')}
          description={t('config_management.visual.sections.network.session_affinity_desc')}
          checked={values.routingSessionAffinity}
          disabled={disabled}
          onChange={(routingSessionAffinity) => onChange({ routingSessionAffinity })}
        />
        <TextSetting
          fieldId="routingSessionAffinityTTL"
          size="sm"
          label={t('config_management.visual.sections.network.session_affinity_ttl')}
          placeholder="1h"
          value={values.routingSessionAffinityTTL}
          onChange={(routingSessionAffinityTTL) => onChange({ routingSessionAffinityTTL })}
          disabled={disabled}
        />
        <ToggleSetting
          fieldId="routingSessionAffinitySubagents"
          label={t('config_management.visual.additions.routingSessionAffinitySubagents.label')}
          description={t('config_management.visual.additions.routingSessionAffinitySubagents.hint')}
          checked={values.routingSessionAffinitySubagents}
          disabled={disabled}
          onChange={(routingSessionAffinitySubagents) =>
            onChange({ routingSessionAffinitySubagents })
          }
        />
        <ToggleSetting
          fieldId="forceModelPrefix"
          label={t('config_management.visual.sections.network.force_model_prefix')}
          description={t('config_management.visual.sections.network.force_model_prefix_desc')}
          checked={values.forceModelPrefix}
          disabled={disabled}
          onChange={(forceModelPrefix) => onChange({ forceModelPrefix })}
        />
      </SettingList>

      <SettingList title={t('config_management.sections.routing.retries')}>
        <TextSetting
          fieldId="requestRetry"
          size="sm"
          label={t('config_management.visual.sections.network.request_retry')}
          type="number"
          placeholder="3"
          value={values.requestRetry}
          onChange={(requestRetry) => onChange({ requestRetry })}
          disabled={disabled}
          error={getValidationMessage(t, validationErrors?.requestRetry)}
        />
        <TextSetting
          fieldId="maxRetryCredentials"
          size="sm"
          label={t('config_management.visual.sections.network.max_retry_credentials')}
          description={t('config_management.visual.sections.network.max_retry_credentials_hint')}
          type="number"
          placeholder="0"
          value={values.maxRetryCredentials}
          onChange={(maxRetryCredentials) => onChange({ maxRetryCredentials })}
          disabled={disabled}
          error={getValidationMessage(t, validationErrors?.maxRetryCredentials)}
        />
        <TextSetting
          fieldId="maxRetryInterval"
          size="sm"
          label={t('config_management.visual.sections.network.max_retry_interval')}
          description={t('config_management.visual.sections.network.max_retry_interval_hint')}
          type="number"
          placeholder="30"
          value={values.maxRetryInterval}
          onChange={(maxRetryInterval) => onChange({ maxRetryInterval })}
          disabled={disabled}
          error={getValidationMessage(t, validationErrors?.maxRetryInterval)}
        />
        <ToggleSetting
          fieldId="disableCooling"
          label={t('config_management.visual.sections.network.disable_cooling')}
          description={t('config_management.visual.sections.network.disable_cooling_desc')}
          checked={values.disableCooling}
          disabled={disabled}
          onChange={(disableCooling) => onChange({ disableCooling })}
        />
        <ToggleSetting
          fieldId="saveCooldownStatus"
          label={t('config_management.visual.additions.saveCooldownStatus.label')}
          description={t('config_management.visual.additions.saveCooldownStatus.hint')}
          checked={values.saveCooldownStatus}
          disabled={disabled}
          onChange={(saveCooldownStatus) => onChange({ saveCooldownStatus })}
        />
        <TextSetting
          fieldId="transientErrorCooldownSeconds"
          size="sm"
          label={t('config_management.visual.additions.transientErrorCooldownSeconds.label')}
          description={t('config_management.visual.additions.transientErrorCooldownSeconds.hint')}
          type="number"
          value={values.transientErrorCooldownSeconds}
          onChange={(transientErrorCooldownSeconds) => onChange({ transientErrorCooldownSeconds })}
          disabled={disabled}
          error={getValidationMessage(t, validationErrors?.transientErrorCooldownSeconds)}
        />
      </SettingList>
    </SettingsSection>
  );
}
