import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '@/i18n';
import { ConfigNavList } from '@/features/config/components/ConfigNav';
import { ADVANCED_SECTION_IDS, PRIMARY_SECTION_IDS } from '@/features/config/constants';

const noop = () => {};

describe('settings navigation accessibility', () => {
  test('announces validation errors and unsaved changes in the link name', () => {
    const markup = renderToStaticMarkup(
      createElement(ConfigNavList, {
        active: 'access',
        errorCounts: { streaming: 2 },
        dirtySections: new Set(['streaming', 'server'] as const),
        onSelect: noop,
      })
    );
    const streaming = [
      i18n.t('config_management.sections.streaming.title'),
      i18n.t('config_management.meta_errors', { count: 2 }),
      i18n.t('config_management.status_dirty_short'),
    ].join(', ');
    expect(markup).toContain(`aria-label="${streaming}"`);
    expect(markup).toContain(
      `aria-label="${i18n.t('config_management.sections.server.title')}, ${i18n.t('config_management.status_dirty_short')}"`
    );
    expect(markup).toContain('aria-current="location"');
  });

  test('lists primary sections first and the advanced ones after the group label', () => {
    const markup = renderToStaticMarkup(
      createElement(ConfigNavList, {
        active: 'access',
        errorCounts: {},
        dirtySections: new Set(),
        onSelect: noop,
      })
    );
    const order = [...markup.matchAll(/href="#config-section-([a-zA-Z]+)"/g)].map((m) => m[1]);
    expect(order).toEqual([...PRIMARY_SECTION_IDS, ...ADVANCED_SECTION_IDS]);
    const advancedLabel = markup.indexOf(i18n.t('config_management.advanced.title'));
    expect(advancedLabel).toBeGreaterThan(markup.indexOf('config-section-logging'));
    expect(advancedLabel).toBeLessThan(markup.indexOf('config-section-network'));
  });
});
