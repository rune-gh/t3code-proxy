import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import '../src/i18n/index';
import i18n from '../src/i18n/index';
import {
  ModelRulesEntry,
  type ModelRulesEntryProps,
} from '../src/features/authFiles/components/ModelRulesEntry';

const noop = () => {};

const renderEntry = (overrides: Partial<ModelRulesEntryProps> = {}) =>
  renderToStaticMarkup(
    createElement(ModelRulesEntry, {
      excluded: { codex: ['gpt-5', 'o3-*'], claude: ['claude-opus-4'] },
      excludedError: null,
      modelAlias: {
        codex: [
          { name: 'gpt-5-codex', alias: 'gpt-5' },
          { name: 'gpt-5-mini', alias: 'mini', fork: true },
        ],
      },
      modelAliasError: null,
      scope: 'all',
      resolvedTheme: 'light',
      onOpenExcluded: noop,
      onOpenAlias: noop,
      onRetryExcluded: noop,
      onRetryAlias: noop,
      ...overrides,
    })
  );

const doors = (markup: string) => markup.match(/<button[\s\S]*?<\/button>/g) ?? [];

describe('model rules entry', () => {
  test('summarises both rule sets and keeps each door a single enabled button', () => {
    const [excluded, alias] = doors(renderEntry());
    expect(excluded).toContain('data-state="ready"');
    expect(excluded).toContain(i18n.t('model_rules.meta_providers', { count: 2 }));
    expect(excluded).toContain(i18n.t('model_rules.meta_rules', { count: 3 }));
    expect(alias).toContain(i18n.t('model_rules.meta_providers', { count: 1 }));
    expect(alias).toContain(i18n.t('model_rules.meta_mappings', { count: 2 }));
    expect(excluded).not.toContain('disabled=""');
    expect(alias).not.toContain('disabled=""');
  });

  test('follows the active provider filter instead of the global totals', () => {
    const [excluded, alias] = doors(renderEntry({ scope: 'Claude' }));
    expect(excluded).toContain(i18n.t('model_rules.meta_rules', { count: 1 }));
    expect(excluded).not.toContain(i18n.t('model_rules.meta_providers', { count: 2 }));
    expect(alias).toContain(i18n.t('model_rules.meta_empty'));
  });

  test('turns a failed load into a retry action and never shows stale totals', () => {
    const [excluded, alias] = doors(
      renderEntry({ excludedError: 'load', modelAliasError: 'load' })
    );
    for (const door of [excluded, alias]) {
      expect(door).toContain('data-state="load"');
      expect(door).toContain(i18n.t('auth_files.rules_load_failed'));
      expect(door).toContain(i18n.t('auth_files.retry'));
      expect(door).not.toContain('disabled=""');
      expect(door).not.toContain(i18n.t('model_rules.meta_providers', { count: 1 }));
    }
  });

  test('blocks entry while loading and quietly hides a rule set the hub lacks', () => {
    const markup = renderEntry({ excludedError: 'loading', modelAliasError: 'unsupported' });
    const found = doors(markup);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('disabled=""');
    expect(found[0]).toContain('aria-busy="true"');
    expect(markup).not.toContain(i18n.t('model_rules.kind_alias'));
    expect(markup).not.toContain(i18n.t('oauth_model_alias.upgrade_required_title'));
  });

  test('renders nothing when neither rule set is available', () => {
    expect(renderEntry({ excludedError: 'unsupported', modelAliasError: 'unsupported' })).toBe('');
  });
});
