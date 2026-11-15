import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import i18n from '@/i18n';
import { DEFAULT_VISUAL_VALUES } from '@/types/visualConfig';
import { SectionServer } from '@/features/config/components/sections/SectionServer';
import { SectionDiscovery } from '@/features/config/components/sections/SectionDiscovery';
import {
  CONFIG_SECTION_IDS,
  FIELD_VALUE_KEYS,
  SECTION_VALIDATION_FIELDS,
} from '@/features/config/constants';
import { CONFIG_FIELD_SEARCH_INDEX, searchConfigFields } from '@/features/config/searchIndex';

const translations = i18n.cloneInstance({ lng: 'en' });
const props = { values: DEFAULT_VISUAL_VALUES, disabled: false, onChange: () => {} };
const render = (element: ReturnType<typeof createElement>) =>
  renderToStaticMarkup(createElement(I18nextProvider, { i18n: translations }, element));
const escapeText = (value: string) =>
  renderToStaticMarkup(createElement('span', null, value)).slice(6, -7);
const extras = CONFIG_FIELD_SEARCH_INDEX.filter((entry) =>
  entry.labelKey.includes('.serverExtras.')
);
/** Server rows plus the LAN discovery section: together they hold the nine server extras. */
function ServerAndDiscovery(sectionProps: Parameters<typeof SectionServer>[0]) {
  return createElement(
    'div',
    null,
    createElement(SectionServer, sectionProps),
    createElement(SectionDiscovery, sectionProps)
  );
}
const populated = {
  ...DEFAULT_VISUAL_VALUES,
  trustedProxies: ['127.0.0.1', '192.168.0.0/24'],
  discoverySubtypes: ['_responses'],
  discoveryInterfacesInclude: ['en*'],
  discoveryInterfacesExclude: ['docker*'],
};

describe('server configuration UI', () => {
  test('keeps nine searchable anchors across server and LAN discovery', () => {
    expect(CONFIG_SECTION_IDS).toHaveLength(12);
    expect(extras).toHaveLength(9);
    const markup = render(createElement(ServerAndDiscovery, props));
    for (const entry of extras) {
      expect(entry.sectionId).toBe(entry.fieldId === 'trustedProxies' ? 'server' : 'discovery');
      expect(FIELD_VALUE_KEYS[entry.fieldId]).toEqual([entry.fieldId]);
      expect(markup.split(`id="cfg-field-${entry.fieldId}"`)).toHaveLength(2);
      expect(markup).toContain(escapeText(translations.t(entry.labelKey)));
      expect(markup).toContain(escapeText(translations.t(entry.hintKey!)));
      const path = entry.yamlKeys!.join('.');
      expect(path).toMatch(/^server\.(trusted-proxies|discovery\.)/);
      expect(
        searchConfigFields(path, (key) => translations.t(key)).map((e) => e.fieldId)
      ).toContain(entry.fieldId);
    }
    expect(SECTION_VALIDATION_FIELDS.server).toEqual(['port', 'trustedProxies']);
    expect(SECTION_VALIDATION_FIELDS.discovery).toEqual(['discoveryServiceType']);
  });

  test('discovery renders as its own section with every field mounted', () => {
    const markup = render(createElement(SectionDiscovery, props));
    expect(markup).toContain('id="config-section-discovery"');
    expect(markup).toContain(
      escapeText(translations.t('config_management.sections.discovery.title'))
    );
    for (const entry of extras.filter((e) => e.fieldId !== 'trustedProxies')) {
      expect(markup).toContain(`id="cfg-field-${entry.fieldId}"`);
    }
    expect(DEFAULT_VISUAL_VALUES.discoveryEnabled).toBe(false);
    expect(DEFAULT_VISUAL_VALUES.discoveryAuthRequired).toBe(true);
    expect(DEFAULT_VISUAL_VALUES.discoveryAdvertiseManagement).toBe(false);
    const auth = markup
      .split('id="cfg-field-discoveryAuthRequired"')[1]
      .split('id="cfg-field-discoveryAdvertiseManagement"')[0];
    expect(auth).toContain('checked=""');
    for (const input of markup.match(/<input\b[^>]*type="text"[^>]*>/g) ?? []) {
      expect(input).toContain('value=""');
    }
  });

  test('gives inputs and list rows accessible names and associates list hints', () => {
    const markup = render(createElement(ServerAndDiscovery, { ...props, values: populated }));
    for (const field of [
      'trustedProxies',
      'discoverySubtypes',
      'discoveryInterfacesInclude',
      'discoveryInterfacesExclude',
    ]) {
      const label = escapeText(
        translations.t(`config_management.visual.serverExtras.${field}.label`)
      );
      expect(markup).toContain(`aria-label="${label}"`);
      const group = (markup.match(/<div\b[^>]*role="group"[^>]*>/g) ?? []).find((tag) =>
        tag.includes(`${field}-label`)
      );
      expect(group).toBeTruthy();
      for (const attribute of ['aria-labelledby', 'aria-describedby']) {
        const id = group!.match(new RegExp(`${attribute}="([^"]+)"`))?.[1];
        expect(id).toBeTruthy();
        expect(markup).toContain(`id="${id}"`);
      }
    }
    const discovery = render(createElement(SectionDiscovery, props));
    const inputs = discovery.match(/<input\b[^>]*type="text"[^>]*>/g) ?? [];
    expect(inputs).toHaveLength(2);
    for (const input of inputs) {
      const id = input.match(/\bid="([^"]+)"/)?.[1];
      expect(discovery).toContain(`for="${id}"`);
      const hint = input.match(/aria-describedby="([^"]+)"/)?.[1];
      expect(discovery).toContain(`id="${hint}"`);
    }
  });

  test('disables every input and list action in read-only mode', () => {
    const markup = render(
      createElement(ServerAndDiscovery, { ...props, values: populated, disabled: true })
    );
    const controls = markup.match(/<(?:input|textarea|button)\b[^>]*>/g) ?? [];
    expect(controls.length).toBeGreaterThan(10);
    for (const control of controls) expect(control).toContain('disabled=""');
  });

  test('renders and associates both validation errors', () => {
    const markup = render(
      createElement(ServerAndDiscovery, {
        ...props,
        values: populated,
        validationErrors: {
          trustedProxies: 'invalid_trusted_proxies',
          discoveryServiceType: 'invalid_discovery_service_type',
        },
      })
    );
    for (const code of ['invalid_trusted_proxies', 'invalid_discovery_service_type']) {
      expect(markup).toContain(
        escapeText(translations.t(`config_management.visual.validation.${code}`))
      );
    }
    const group = (markup.match(/<div\b[^>]*role="group"[^>]*>/g) ?? []).find((tag) =>
      tag.includes('trustedProxies-label')
    )!;
    expect(group).toContain('aria-invalid="true"');
    const ids = group.match(/aria-describedby="([^"]+)"/)![1].split(' ');
    expect(ids).toHaveLength(2);
    for (const id of ids) expect(markup).toContain(`id="${id}"`);
    const typeInput = markup.match(/<input\b[^>]*placeholder="_ai-gateway\._tcp"[^>]*>/)?.[0];
    expect(typeInput).toContain('aria-invalid="true"');
  });
});
