import { describe, expect, test } from 'bun:test';
import {
  ADVANCED_SECTION_IDS,
  CONFIG_SECTION_IDS,
  FIELD_VALUE_KEYS,
  PRIMARY_SECTION_IDS,
} from '@/features/config/constants';
import {
  CONFIG_FIELD_SEARCH_INDEX,
  findConfigFieldById,
  searchConfigFields,
} from '@/features/config/searchIndex';
import {
  countSectionErrors,
  countTotalErrors,
  isLoopbackHost,
  readSavedMode,
  resolveDirtySections,
  resolveStatus,
  type ConfigStatusInput,
} from '@/features/config/uiState';
import type { VisualConfigValidationErrors } from '@/types/visualConfig';
import { LANGUAGE_ORDER } from '@/utils/constants';

const statusInput = (overrides: Partial<ConfigStatusInput> = {}): ConfigStatusInput => ({
  disconnected: false,
  loading: false,
  loadFailed: false,
  yamlError: false,
  validationBlocked: false,
  saving: false,
  dirty: false,
  ...overrides,
});

describe('resolveStatus', () => {
  test('follows the legacy precedence chain top-down', () => {
    // disconnected > loading > load_failed > yaml_error > validation_blocked > saving > dirty > synced
    expect(resolveStatus(statusInput({ disconnected: true, loading: true })).key).toBe(
      'disconnected'
    );
    expect(resolveStatus(statusInput({ loading: true, loadFailed: true })).key).toBe('loading');
    expect(resolveStatus(statusInput({ loadFailed: true, yamlError: true })).key).toBe(
      'load_failed'
    );
    expect(resolveStatus(statusInput({ yamlError: true, validationBlocked: true })).key).toBe(
      'yaml_error'
    );
    expect(resolveStatus(statusInput({ validationBlocked: true, saving: true })).key).toBe(
      'validation_blocked'
    );
    expect(resolveStatus(statusInput({ saving: true, dirty: true })).key).toBe('saving');
    expect(resolveStatus(statusInput({ dirty: true })).key).toBe('dirty');
    expect(resolveStatus(statusInput()).key).toBe('synced');
  });

  test('validation_blocked short key lives at config_management top level (regression: old .visual. path bug)', () => {
    const status = resolveStatus(statusInput({ validationBlocked: true }));
    expect(status.shortLabelKey).toBe('config_management.validation_blocked_short');
    expect(status.labelKey).toBe('config_management.visual.validation.validation_blocked');
    expect(status.tone).toBe('error');
  });

  test('every status resolves label keys that exist in all supported locales', async () => {
    const locales = LANGUAGE_ORDER;
    const inputs: Partial<ConfigStatusInput>[] = [
      { disconnected: true },
      { loading: true },
      { loadFailed: true },
      { yamlError: true },
      { validationBlocked: true },
      { saving: true },
      { dirty: true },
      {},
    ];
    for (const locale of locales) {
      const json = (await Bun.file(`src/i18n/locales/${locale}.json`).json()) as Record<
        string,
        unknown
      >;
      const resolveKey = (path: string): unknown =>
        path.split('.').reduce<unknown>((node, part) => {
          if (node && typeof node === 'object') return (node as Record<string, unknown>)[part];
          return undefined;
        }, json);
      for (const overrides of inputs) {
        const status = resolveStatus(statusInput(overrides));
        expect(typeof resolveKey(status.labelKey)).toBe('string');
        expect(typeof resolveKey(status.shortLabelKey)).toBe('string');
      }
    }
  });
});

describe('resolveStatus', () => {
  test('follows the legacy precedence chain top-down', () => {
    // disconnected > loading > load_failed > yaml_error > validation_blocked > saving > dirty > synced
    expect(resolveStatus(statusInput({ disconnected: true, loading: true })).key).toBe(
      'disconnected'
    );
    expect(resolveStatus(statusInput({ loading: true, loadFailed: true })).key).toBe('loading');
    expect(resolveStatus(statusInput({ loadFailed: true, yamlError: true })).key).toBe(
      'load_failed'
    );
    expect(resolveStatus(statusInput({ yamlError: true, validationBlocked: true })).key).toBe(
      'yaml_error'
    );
    expect(resolveStatus(statusInput({ validationBlocked: true, saving: true })).key).toBe(
      'validation_blocked'
    );
    expect(resolveStatus(statusInput({ saving: true, dirty: true })).key).toBe('saving');
    expect(resolveStatus(statusInput({ dirty: true })).key).toBe('dirty');
    expect(resolveStatus(statusInput()).key).toBe('synced');
  });

  test('validation_blocked short key lives at config_management top level (regression: old .visual. path bug)', () => {
    const status = resolveStatus(statusInput({ validationBlocked: true }));
    expect(status.shortLabelKey).toBe('config_management.validation_blocked_short');
    expect(status.labelKey).toBe('config_management.visual.validation.validation_blocked');
    expect(status.tone).toBe('error');
  });

  test('every status resolves label keys that exist in all supported locales', async () => {
    const locales = LANGUAGE_ORDER;
    const inputs: Partial<ConfigStatusInput>[] = [
      { disconnected: true },
      { loading: true },
      { loadFailed: true },
      { yamlError: true },
      { validationBlocked: true },
      { saving: true },
      { dirty: true },
      {},
    ];
    for (const locale of locales) {
      const json = (await Bun.file(`src/i18n/locales/${locale}.json`).json()) as Record<
        string,
        unknown
      >;
      const resolveKey = (path: string): unknown =>
        path.split('.').reduce<unknown>((node, part) => {
          if (node && typeof node === 'object') return (node as Record<string, unknown>)[part];
          return undefined;
        }, json);
      for (const overrides of inputs) {
        const status = resolveStatus(statusInput(overrides));
        expect(typeof resolveKey(status.labelKey)).toBe('string');
        expect(typeof resolveKey(status.shortLabelKey)).toBe('string');
      }
    }
  });
});

describe('countSectionErrors', () => {
  test('buckets field errors by section', () => {
    const errors: VisualConfigValidationErrors = {
      port: 'port_range',
      requestRetry: 'non_negative_integer',
      'streaming.keepaliveSeconds': 'non_negative_integer',
      quotaHistoryInterval: 'invalid_quota_duration',
    };
    const counts = countSectionErrors(errors, false);
    expect(counts.server).toBe(1);
    expect(counts.routing).toBe(1);
    expect(counts.streaming).toBe(1);
    expect(counts.quotaHistory).toBe(1);
    expect(counts.logging).toBe(0);
    expect(counts.providers).toBe(0);
    expect(counts.payload).toBe(0);
    expect(Object.keys(counts).sort()).toEqual([...CONFIG_SECTION_IDS].sort());
  });

  test('payload flag adds one to the payload section only', () => {
    const counts = countSectionErrors(undefined, true);
    expect(counts.payload).toBe(1);
    expect(counts.server).toBe(0);
  });

  test('undefined error entries do not count', () => {
    const counts = countSectionErrors({ port: undefined }, false);
    expect(counts.server).toBe(0);
  });
});

describe('countTotalErrors', () => {
  test('sums field errors plus the payload flag', () => {
    const errors: VisualConfigValidationErrors = {
      port: 'port_range',
      maxRetryInterval: 'non_negative_integer',
      logsMaxTotalSizeMb: undefined,
    };
    expect(countTotalErrors(errors, false)).toBe(2);
    expect(countTotalErrors(errors, true)).toBe(3);
    expect(countTotalErrors(undefined, false)).toBe(0);
  });
});

describe('resolveDirtySections', () => {
  test('maps dirty value keys to the sections that render them', () => {
    const sections = resolveDirtySections(
      new Set(['rmSecretKey', 'apiKeysText', 'streaming.bootstrapRetries'])
    );
    expect([...sections].sort()).toEqual(['access', 'management', 'streaming']);
    expect([...resolveDirtySections(new Set(['quotaAntigravityCredits']))]).toEqual(['providers']);
  });

  test('unknown keys are ignored instead of crashing', () => {
    expect(resolveDirtySections(new Set(['not-a-real-key', 'quotaSwitchProject'])).size).toBe(0);
  });
});

describe('section registry', () => {
  test('primary sections come first in page order, the long tail sits under Advanced', () => {
    expect([...PRIMARY_SECTION_IDS]).toEqual([
      'access',
      'management',
      'server',
      'routing',
      'quotaHistory',
      'logging',
    ]);
    expect([...CONFIG_SECTION_IDS]).toEqual([...PRIMARY_SECTION_IDS, ...ADVANCED_SECTION_IDS]);
  });

  test('every section has a title and a description', async () => {
    const json = await Bun.file('src/i18n/locales/en.json').json();
    for (const id of CONFIG_SECTION_IDS) {
      expect(typeof json.config_management.sections[id].title).toBe('string');
      expect(typeof json.config_management.sections[id].description).toBe('string');
    }
  });

  test('retired quota switches stay out of search and values', () => {
    expect(CONFIG_FIELD_SEARCH_INDEX.some((entry) => String(entry.sectionId) === 'quota')).toBe(
      false
    );
    for (const field of ['quotaSwitchProject', 'quotaSwitchPreviewModel']) {
      expect(findConfigFieldById(field)).toBeUndefined();
      expect(FIELD_VALUE_KEYS).not.toHaveProperty(field);
    }
    for (const query of ['switch-project', 'switch-preview-model', 'quota-exceeded']) {
      expect(searchConfigFields(query, (key) => key)).toEqual([]);
    }
  });

  test('Antigravity credits are searchable and live in Providers', async () => {
    const entry = findConfigFieldById('quotaAntigravityCredits');
    expect(entry?.sectionId).toBe('providers');
    for (const locale of LANGUAGE_ORDER) {
      const json = await Bun.file(`src/i18n/locales/${locale}.json`).json();
      const label = json.config_management.visual.sections.advanced.antigravity_credits;
      expect(typeof label).toBe('string');
      const translate = (key: string): string => (key === entry?.labelKey ? label : key);
      for (const query of [label, 'antigravity-credits']) {
        expect(searchConfigFields(query, translate)).toContainEqual(entry);
      }
    }
  });
});

describe('isLoopbackHost', () => {
  test('only loopback addresses count as local', () => {
    for (const host of ['127.0.0.1', '127.1.2.3', 'localhost', '::1', '[::1]', ' LOCALHOST ']) {
      expect(isLoopbackHost(host)).toBe(true);
    }
    for (const host of ['', '0.0.0.0', '100.64.0.1', '::', '192.168.1.10', 'hub.local']) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });
});

describe('localStorage readers', () => {
  test('readSavedMode falls back to visual on unknown values', () => {
    expect(readSavedMode('source')).toBe('source');
    expect(readSavedMode('visual')).toBe('visual');
    expect(readSavedMode('full')).toBe('visual');
    expect(readSavedMode(null)).toBe('visual');
  });
});
