import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import '../src/i18n/index';
import { claudeToResource, openaiToResource } from '../src/features/providers/adapters';
import { ProviderList } from '../src/features/providers/components/ProviderList';
import { clearConnectivityLog } from '../src/features/providers/connectivityLog';
import type { ProviderGroup } from '../src/features/providers/types';

const noop = () => {};

const groups = (): ProviderGroup[] => [
  {
    id: 'claude',
    resources: [claudeToResource({ apiKey: 'sk-ant-api-test-0001', models: [] }, 0)],
  },
  {
    id: 'openaiCompatibility',
    resources: [
      openaiToResource(
        {
          name: 'openrouter',
          baseUrl: 'https://openrouter.ai/api/v1',
          apiKeyEntries: [{ apiKey: 'sk-or-1' }, { apiKey: 'sk-or-2' }],
          models: [{ name: 'a' }, { name: 'b' }, { name: 'c' }],
        },
        0
      ),
    ],
  },
];

const render = (tests = new Map()) =>
  renderToStaticMarkup(
    createElement(ProviderList, {
      groups: groups(),
      tests,
      theme: 'dark',
      onView: noop,
      onEdit: noop,
      onTest: noop,
      onDelete: noop,
      onToggleEnabled: noop,
    })
  );

afterEach(() => clearConnectivityLog());

describe('provider list', () => {
  test('groups rows by kind with base URL, key and model counts', () => {
    const html = render();
    expect(html).toContain('Claude');
    expect(html).toContain('OpenAI Compatible');
    expect(html).toContain('https://openrouter.ai/api/v1');
    expect(html).toContain('Default');
    expect(html).toContain('2 keys');
    expect(html).toContain('3 models');
    expect(html).toContain('Not tested');
    expect(html).toContain('aria-label="Enable openrouter"');
    expect(html).toContain('aria-label="Actions for openrouter"');
    // Keys are only shown masked.
    expect(html).not.toContain('sk-or-1');
    expect(html).not.toContain('sk-ant-api-test-0001');
  });

  test('shows the last connectivity test result for a row', () => {
    const [claude] = groups()[0].resources;
    const html = render(new Map([[claude.id, { ok: false, message: 'HTTP 401', at: 1 }]]));
    expect(html).toContain('Failed');
    expect(html).toContain('title="HTTP 401"');
  });

  test('the page uses the shared page anatomy and has no sponsor leftovers', () => {
    const page = readFileSync('src/features/providers/ProvidersWorkbenchPage.tsx', 'utf8');
    expect(page).toContain('<PageHeader');
    expect(page).toContain("t('providersPage.empty.description')");
    const en = JSON.parse(readFileSync('src/i18n/locales/en.json', 'utf8'));
    expect(en.providersPage.title).toBe('Providers');
    expect(en.providersPage.sponsor).toBeUndefined();
    expect(en.providersPage.providerNames.kimi).toBeUndefined();
  });
});
