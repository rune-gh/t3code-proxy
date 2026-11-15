/**
 * Display formatting for the quota pool cards. Pure and locale-parameterized.
 */

import { DAY_MS, HOUR_MS, MINUTE_MS } from './poolModel';

export const formatPoolPercent = (value: number): string => `${Math.round(value)}%`;

export const formatSignedPercent = (value: number): string => `+${Math.round(value)}%`;

export const formatBurnRate = (perHour: number): string => {
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
