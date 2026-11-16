/**
 * Display formatting for the quota pool cards. Pure and locale-parameterized.
 */

import { DAY_MS, HOUR_MS, MINUTE_MS } from './poolModel';

/** Pool percent: whole numbers, with a sliver that is not quite empty kept visible. */
export const formatPoolPercent = (value: number): string => {
  const safe = Math.max(0, value);
  return safe > 0 && safe < 0.5 ? '<1%' : `${Math.round(safe)}%`;
};

export const formatSignedPercent = (value: number): string => `+${Math.round(value)}%`;

/** Pooled drain per hour; a slow but real drain never reads as zero. */
export const formatBurnRate = (perHour: number): string => {
  if (perHour > 0 && perHour < 0.05) return '<0.1%/h';
  const rounded = perHour >= 10 ? Math.round(perHour) : Math.round(perHour * 10) / 10;
  return `${rounded}%/h`;
};

/** "Fri 23" */
export const formatDayTick = (ms: number, locale: string): string => {
  const date = new Date(ms);
  const weekday = date.toLocaleDateString(locale, { weekday: 'short' });
  return `${weekday} ${date.getDate()}`;
};

/** "Tue 10:00 AM" */
export const formatWeekdayTime = (ms: number, locale: string): string => {
  const date = new Date(ms);
  const weekday = date.toLocaleDateString(locale, { weekday: 'short' });
  const time = date.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
  return `${weekday} ${time}`;
};

/** A reset instant: "Tue 10:00 AM" within six days, "Nov 30, 4:00 PM" beyond (a weekday would be ambiguous). */
export const formatResetInstant = (ms: number, now: number, locale: string): string =>
  ms - now < 6 * DAY_MS
    ? formatWeekdayTime(ms, locale)
    : new Date(ms).toLocaleString(locale, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });

/** "Nov 9" */
export const formatMonthDay = (ms: number, locale: string): string =>
  new Date(ms).toLocaleDateString(locale, { month: 'short', day: 'numeric' });

/** Compact duration: "49m", "15h 49m", "2d 18h". */
export const formatDuration = (ms: number): string => {
  const safe = Math.max(0, ms);
  if (safe < HOUR_MS) return `${Math.max(1, Math.round(safe / MINUTE_MS))}m`;
  if (safe < 2 * DAY_MS) {
    const hours = Math.floor(safe / HOUR_MS);
    const minutes = Math.floor((safe % HOUR_MS) / MINUTE_MS);
    return `${hours}h ${minutes}m`;
  }
  const days = Math.floor(safe / DAY_MS);
  const hours = Math.floor((safe % DAY_MS) / HOUR_MS);
  return `${days}d ${hours}h`;
};

/** Round a chart maximum up to a readable value (1, 2, 2.5, 5 × 10^n). */
export const niceCeil = (value: number): number => {
  if (!(value > 0)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5, 10]) {
    if (value <= step * magnitude) return step * magnitude;
  }
  return 10 * magnitude;
};

/**
 * How a pool card prints pooled values. Every pool is in percent of its
 * heaviest plan (see poolModel.ts): one account on that plan is 100%, a
 * lighter plan proportionally less, so the headline, axis, reset steps and
 * burn rate all share one unit.
 */
export interface PoolUnits {
  /** Current or charted pooled value. */
  value: (percent: number) => string;
  /** Step added by a reset. */
  signed: (percent: number) => string;
  /** Pooled drain per hour. */
  rate: (percentPerHour: number) => string;
}

export const POOL_UNITS: PoolUnits = {
  value: formatPoolPercent,
  signed: formatSignedPercent,
  rate: formatBurnRate,
};

/** An account's capacity in pool percent ("100%", "20%", "12.5%"). */
export const formatCapacity = (percent: number): string => {
  const rounded = Math.round(percent * 10) / 10;
  return `${rounded}%`;
};

/** "$0.39", "$15", "€12.50": whole amounts drop the cents. */
export const formatMoney = (amount: number, currency: string, locale: string): string => {
  const whole = Math.abs(amount - Math.round(amount)) < 0.005;
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      minimumFractionDigits: whole ? 0 : 2,
      maximumFractionDigits: whole ? 0 : 2,
    }).format(amount);
  } catch {
    return `${amount.toFixed(whole ? 0 : 2)} ${currency}`;
  }
};
