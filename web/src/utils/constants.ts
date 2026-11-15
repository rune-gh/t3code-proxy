/**
 * Constant definitions.
 */

import type { Language } from '@/types';

// Cache expiry (milliseconds)
export const CACHE_EXPIRY_MS = 30 * 1000; // Matches the baseline to reduce load on the management API

// Network and version information
export const DEFAULT_API_PORT = 8317;
export const MANAGEMENT_API_PREFIX = '/v8/management';
export const REQUEST_TIMEOUT_MS = 30 * 1000;
export const CPA_VERSION_HEADER_KEYS = ['x-cpa-version'];
export const CPA_BUILD_DATE_HEADER_KEYS = ['x-cpa-build-date'];
export const CPA_SUPPORT_PLUGIN_HEADER_KEYS = ['x-cpa-support-plugin'];
export const VERSION_HEADER_KEYS = [...CPA_VERSION_HEADER_KEYS, 'x-server-version'];
export const BUILD_DATE_HEADER_KEYS = [...CPA_BUILD_DATE_HEADER_KEYS, 'x-server-build-date'];

// Logs
export const LOGS_TIMEOUT_MS = 60 * 1000;

// Auth files
export const MAX_AUTH_FILE_SIZE = 10 * 1024 * 1024;

// Local storage keys
export const STORAGE_KEY_AUTH = 'cli-proxy-auth';
export const STORAGE_KEY_THEME = 'cli-proxy-theme';

// Language configuration (English only). LANGUAGE_ORDER and LANGUAGE_LABEL_KEYS are
// still read by the layout and login language switcher.
export const LANGUAGE_ORDER = ['en'] as const satisfies readonly Language[];
export const LANGUAGE_LABEL_KEYS: Record<Language, string> = {
  en: 'language.english',
};
export const SUPPORTED_LANGUAGES: readonly Language[] = LANGUAGE_ORDER;

// Notification duration
export const NOTIFICATION_DURATION_MS = 3000;
