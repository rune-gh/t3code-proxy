import type { TFunction } from 'i18next';
import type { RoutingSettings, RoutingStrategy } from '@/types/routing';

export function formatRoutingDuration(t: TFunction, seconds: number): string {
  if (seconds < 60) return t('routing.duration_seconds', { count: Math.max(1, seconds) });
  if (seconds < 3600) return t('routing.duration_minutes', { count: Math.ceil(seconds / 60) });
  return t('routing.duration_hours', { count: Math.ceil(seconds / 3600) });
}

/** Time until a weekly reset: minutes, hours, then days and hours. */
export function formatResetIn(t: TFunction, ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return t('routing.duration_minutes', { count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 48) return t('routing.duration_hours', { count: hours });
  return t('routing.duration_days_hours', { days: Math.floor(hours / 24), hours: hours % 24 });
}

export const SETTING_LABEL_KEYS: Record<keyof RoutingSettings, string> = {
  strategy: 'routing.strategy_label',
  sessionAffinity: 'routing.affinity_label',
  sessionAffinityTtl: 'routing.affinity_ttl',
  requestRetry: 'routing.request_retry',
  maxRetryCredentials: 'routing.max_retry_credentials',
  maxRetryInterval: 'routing.max_retry_interval',
};

export function formatSettingValue(
  t: TFunction,
  field: keyof RoutingSettings,
  value: RoutingSettings[keyof RoutingSettings]
): string {
  if (field === 'strategy') return t(`routing.strategy_${String(value).replace(/-/g, '_')}`);
  if (typeof value === 'boolean') return t(value ? 'routing.value_on' : 'routing.value_off');
  if (field === 'maxRetryCredentials' && value === 0) return t('routing.unlimited');
  if (field === 'sessionAffinityTtl' && value === '') return t('routing.value_default_ttl');
  if (field === 'maxRetryInterval') return t('routing.seconds_value', { count: Number(value) });
  return String(value);
}

export function formatWeightValue(t: TFunction, value: number | null): string {
  return value === null ? t('routing.value_default') : String(value);
}

/** i18n key fragment for a strategy: `soonest-reset-first` -> `soonest_reset_first`. */
export const strategyKey = (strategy: RoutingStrategy): string => strategy.replace(/-/g, '_');
