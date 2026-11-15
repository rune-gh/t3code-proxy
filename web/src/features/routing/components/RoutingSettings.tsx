import { useId, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/Badge';
import { Input } from '@/components/ui/Input';
import { Section } from '@/components/ui/Section';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { ROUTING_STRATEGIES, type RoutingSettings } from '@/types/routing';
import { strategyKey } from '../format';
import { isValidAffinityTtl } from '../logic';
import styles from '../RoutingPage.module.scss';

const RETRY_MAX = 100;
const CREDENTIALS_MAX = 1000;
const INTERVAL_MAX = 3600;

const readCount = (value: string, max: number): number => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(max, Math.max(0, parsed));
};

interface SettingsSectionProps {
  settings: RoutingSettings;
  disabled?: boolean;
  onChange: (next: RoutingSettings) => void;
}

interface StrategySectionProps extends SettingsSectionProps {
  /** Shown under the options while soonest-reset-first is selected. */
  soonestResetDetails?: ReactNode;
}

export function StrategySection({
  settings,
  disabled = false,
  onChange,
  soonestResetDetails,
}: StrategySectionProps) {
  const { t } = useTranslation();
  const name = useId();
  return (
    <Section title={t('routing.strategy_section')} description={t('routing.strategy_section_desc')}>
      <div
        role="radiogroup"
        aria-label={t('routing.strategy_label')}
        className={styles.strategyList}
      >
        {ROUTING_STRATEGIES.map((strategy) => {
          const checked = settings.strategy === strategy;
          const key = strategyKey(strategy);
          return (
            <label
              key={strategy}
              className={checked ? styles.strategyOptionActive : styles.strategyOption}
              data-disabled={disabled || undefined}
            >
              <input
                type="radio"
                name={name}
                value={strategy}
                checked={checked}
                disabled={disabled}
                className={styles.strategyRadio}
                onChange={() => onChange({ ...settings, strategy })}
              />
              <span className={styles.strategyText}>
                <span className={styles.strategyName}>
                  {t(`routing.strategy_${key}`)}
                  {strategy === 'soonest-reset-first' ? (
                    <Badge tone="neutral" outline>
                      {t('routing.strategy_recommended')}
                    </Badge>
                  ) : null}
                </span>
                <span className={styles.strategyDesc}>{t(`routing.strategy_${key}_desc`)}</span>
              </span>
            </label>
          );
        })}
      </div>
      {settings.strategy === 'soonest-reset-first' ? soonestResetDetails : null}
    </Section>
  );
}

export function AffinitySection({ settings, disabled = false, onChange }: SettingsSectionProps) {
  const { t } = useTranslation();
  const id = useId();
  const ttlValid = isValidAffinityTtl(settings.sessionAffinityTtl);
  return (
    <Section title={t('routing.affinity_section')} description={t('routing.affinity_section_desc')}>
      <div className={styles.fieldStack}>
        <div className={styles.switchRow}>
          <label htmlFor={`${id}-affinity`} className={styles.switchLabel}>
            {t('routing.affinity_toggle')}
          </label>
          <ToggleSwitch
            id={`${id}-affinity`}
            checked={settings.sessionAffinity}
            disabled={disabled}
            onChange={(sessionAffinity) => onChange({ ...settings, sessionAffinity })}
          />
        </div>
        <div className={styles.narrowField}>
          <Input
            label={t('routing.affinity_ttl')}
            value={settings.sessionAffinityTtl}
            placeholder="1h"
            spellCheck={false}
            autoComplete="off"
            className="mono"
            disabled={disabled || !settings.sessionAffinity}
            hint={t('routing.affinity_ttl_hint')}
            error={ttlValid ? undefined : t('routing.affinity_ttl_invalid')}
            onChange={(event) => onChange({ ...settings, sessionAffinityTtl: event.target.value })}
          />
        </div>
      </div>
    </Section>
  );
}

export function RetrySection({ settings, disabled = false, onChange }: SettingsSectionProps) {
  const { t } = useTranslation();
  const numberProps = {
    type: 'number',
    inputMode: 'numeric' as const,
    min: 0,
    step: 1,
    disabled,
    className: 'tabular',
  };
  return (
    <Section title={t('routing.retry_section')} description={t('routing.retry_section_desc')}>
      <div className={styles.fieldGrid}>
        <Input
          {...numberProps}
          label={t('routing.request_retry')}
          max={RETRY_MAX}
          value={settings.requestRetry}
          hint={t('routing.request_retry_desc')}
          onChange={(event) =>
            onChange({ ...settings, requestRetry: readCount(event.target.value, RETRY_MAX) })
          }
        />
        <Input
          {...numberProps}
          label={t('routing.max_retry_interval')}
          max={INTERVAL_MAX}
          value={settings.maxRetryInterval}
          hint={t('routing.max_retry_interval_desc')}
          onChange={(event) =>
            onChange({
              ...settings,
              maxRetryInterval: readCount(event.target.value, INTERVAL_MAX),
            })
          }
        />
        <Input
          {...numberProps}
          label={t('routing.max_retry_credentials')}
          max={CREDENTIALS_MAX}
          value={settings.maxRetryCredentials}
          hint={t('routing.max_retry_credentials_desc')}
          onChange={(event) =>
            onChange({
              ...settings,
              maxRetryCredentials: readCount(event.target.value, CREDENTIALS_MAX),
            })
          }
        />
      </div>
    </Section>
  );
}
