// Pure helpers for the settings page: status machine, per-section error and dirty buckets,
// localStorage readers. No side effects; covered by tests/configUiState.test.ts.

import type { VisualConfigValidationErrors } from '@/types/visualConfig';
import {
  CONFIG_SECTION_IDS,
  FIELD_VALUE_KEYS,
  SECTION_VALIDATION_FIELDS,
  type ConfigEditorMode,
  type ConfigSectionId,
} from './constants';
import { CONFIG_FIELD_SEARCH_INDEX } from './searchIndex';

/** Leaf value key (useVisualConfig dirtyFields key) to fieldId. */
const VALUE_KEY_TO_FIELD_ID: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  for (const [fieldId, valueKeys] of Object.entries(FIELD_VALUE_KEYS)) {
    for (const valueKey of valueKeys) map.set(valueKey, fieldId);
  }
  return map;
})();

const FIELD_ID_TO_SECTION: ReadonlyMap<string, ConfigSectionId> = new Map(
  CONFIG_FIELD_SEARCH_INDEX.map((entry) => [entry.fieldId, entry.sectionId])
);

/** Dirty value keys to the sections that contain them (navigation dots). */
export function resolveDirtySections(
  dirtyFields: ReadonlySet<string>
): ReadonlySet<ConfigSectionId> {
  const sections = new Set<ConfigSectionId>();
  for (const valueKey of dirtyFields) {
    const fieldId = VALUE_KEY_TO_FIELD_ID.get(valueKey);
    const sectionId = fieldId ? FIELD_ID_TO_SECTION.get(fieldId) : undefined;
    if (sectionId) sections.add(sectionId);
  }
  return sections;
}

/** Validation errors per section (navigation counts). Payload errors count as one. */
export function countSectionErrors(
  validationErrors: VisualConfigValidationErrors | undefined,
  hasPayloadValidationErrors: boolean
): Record<ConfigSectionId, number> {
  const counts = Object.fromEntries(
    CONFIG_SECTION_IDS.map((sectionId) => [
      sectionId,
      SECTION_VALIDATION_FIELDS[sectionId].reduce(
        (total, field) => total + (validationErrors?.[field] ? 1 : 0),
        0
      ),
    ])
  ) as Record<ConfigSectionId, number>;
  if (hasPayloadValidationErrors) counts.payload += 1;
  return counts;
}

/** Total validation errors on the page. */
export function countTotalErrors(
  validationErrors: VisualConfigValidationErrors | undefined,
  hasPayloadValidationErrors: boolean
): number {
  const fieldErrors = Object.values(validationErrors ?? {}).filter(Boolean).length;
  return fieldErrors + (hasPayloadValidationErrors ? 1 : 0);
}

export type ConfigStatusKey =
  | 'disconnected'
  | 'loading'
  | 'load_failed'
  | 'yaml_error'
  | 'validation_blocked'
  | 'saving'
  | 'dirty'
  | 'synced';

export type ConfigStatusTone = 'error' | 'warning' | 'busy' | 'muted' | 'ok';

export type ConfigStatus = {
  key: ConfigStatusKey;
  /** i18n key of the full status text. */
  labelKey: string;
  /** i18n key of the short status text. */
  shortLabelKey: string;
  tone: ConfigStatusTone;
};

export type ConfigStatusInput = {
  disconnected: boolean;
  loading: boolean;
  loadFailed: boolean;
  yamlError: boolean;
  validationBlocked: boolean;
  saving: boolean;
  dirty: boolean;
};

/** Page status machine; earlier branches win. */
export function resolveStatus(input: ConfigStatusInput): ConfigStatus {
  if (input.disconnected) {
    return {
      key: 'disconnected',
      labelKey: 'config_management.status_disconnected',
      shortLabelKey: 'config_management.status_disconnected_short',
      tone: 'muted',
    };
  }
  if (input.loading) {
    return {
      key: 'loading',
      labelKey: 'config_management.status_loading',
      shortLabelKey: 'config_management.status_loading_short',
      tone: 'busy',
    };
  }
  if (input.loadFailed) {
    return {
      key: 'load_failed',
      labelKey: 'config_management.status_load_failed',
      shortLabelKey: 'config_management.status_load_failed_short',
      tone: 'error',
    };
  }
  if (input.yamlError) {
    return {
      key: 'yaml_error',
      labelKey: 'config_management.visual_mode_unavailable',
      shortLabelKey: 'config_management.visual_mode_unavailable_short',
      tone: 'error',
    };
  }
  if (input.validationBlocked) {
    return {
      key: 'validation_blocked',
      labelKey: 'config_management.visual.validation.validation_blocked',
      shortLabelKey: 'config_management.validation_blocked_short',
      tone: 'error',
    };
  }
  if (input.saving) {
    return {
      key: 'saving',
      labelKey: 'config_management.status_saving',
      shortLabelKey: 'config_management.status_saving_short',
      tone: 'busy',
    };
  }
  if (input.dirty) {
    return {
      key: 'dirty',
      labelKey: 'config_management.status_dirty',
      shortLabelKey: 'config_management.status_dirty_short',
      tone: 'warning',
    };
  }
  return {
    key: 'synced',
    labelKey: 'config_management.status_loaded',
    shortLabelKey: 'config_management.status_loaded_short',
    tone: 'ok',
  };
}

/** localStorage reader: unknown or stale values fall back to the visual editor. */
export function readSavedMode(raw: string | null): ConfigEditorMode {
  return raw === 'source' ? 'source' : 'visual';
}

/**
 * True when the bind host only accepts local connections. An empty host binds every
 * interface, so it is not loopback.
 */
export function isLoopbackHost(host: string): boolean {
  const value = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (!value) return false;
  if (value === 'localhost' || value === '::1') return true;
  return /^127(?:\.\d{1,3}){3}$/.test(value);
}
