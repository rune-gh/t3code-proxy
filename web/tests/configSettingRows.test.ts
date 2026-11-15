// Setting row primitives: toggles, inputs, selects and block editors share one skeleton;
// each row type labels its control and associates help, errors and markers.

import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  BlockSetting,
  SecretSetting,
  SelectSetting,
  TextSetting,
  ToggleSetting,
} from '@/features/config/components/fields/FieldPrimitives';

const noop = () => {};
const render = (element: ReturnType<typeof createElement>) => renderToStaticMarkup(element);
const attr = (tag: string, name: string) => tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];

describe('setting row accessibility', () => {
  test('toggle rows label the switch and describe it with the hint', () => {
    const markup = render(
      createElement(ToggleSetting, {
        fieldId: 'debug',
        label: 'Debug',
        description: 'Verbose logs',
        checked: true,
        onChange: noop,
      })
    );
    expect(markup).toContain('id="cfg-field-debug"');
    const input = markup.match(/<input\b[^>]*type="checkbox"[^>]*>/)?.[0] ?? '';
    expect(input).toContain('checked=""');
    const id = attr(input, 'id');
    expect(id).toBeTruthy();
    expect(markup).toContain(`for="${id}"`);
    expect(attr(input, 'aria-describedby')).toBe(`${id}-hint`);
    expect(markup).toContain(`id="${id}-hint"`);
  });

  test('text rows put the error before the hint and flag the input invalid', () => {
    const markup = render(
      createElement(TextSetting, {
        fieldId: 'port',
        label: 'Port',
        description: 'Listen port',
        error: 'Invalid port',
        type: 'number',
        value: '',
        onChange: noop,
        disabled: true,
      })
    );
    const input = markup.match(/<input\b[^>]*>/)?.[0] ?? '';
    const id = attr(input, 'id');
    expect(markup).toContain(`for="${id}"`);
    expect(attr(input, 'aria-describedby')).toBe(`${id}-error ${id}-hint`);
    expect(input).toContain('aria-invalid="true"');
    expect(input).toContain('type="number"');
    expect(input).toContain('disabled=""');
    expect(input).not.toContain('min=');
    expect(markup).toContain('Invalid port');
  });

  test('adornments render inside the control without replacing the value', () => {
    const markup = render(
      createElement(TextSetting, {
        fieldId: 'streamingKeepaliveSeconds',
        label: 'Keepalive',
        value: '0',
        adornment: 'Disabled',
        onChange: noop,
      })
    );
    expect(markup).toContain('value="0"');
    expect(markup).toContain('Disabled');
    expect(markup).not.toContain('aria-describedby');
  });

  test('select rows label the trigger button by id and by aria-labelledby', () => {
    const markup = render(
      createElement(SelectSetting, {
        fieldId: 'routingStrategy',
        label: 'Strategy',
        value: 'a',
        options: [
          { value: 'a', label: 'Alpha' },
          { value: 'b', label: 'Beta' },
        ],
        onChange: noop,
      })
    );
    const button = markup.match(/<button\b[^>]*aria-haspopup="listbox"[^>]*>/)?.[0] ?? '';
    const id = attr(button, 'id');
    expect(markup).toContain(`for="${id}"`);
    const labelId = attr(button, 'aria-labelledby');
    expect(labelId).toContain('routingStrategy-label');
    expect(markup).toContain(`id="${labelId}"`);
    expect(markup).toContain('Alpha');
  });

  test('block rows wrap the editor in a named group and hand describedBy to it', () => {
    let received: { describedBy?: string; invalid: boolean } | undefined;
    const markup = render(
      createElement(BlockSetting, {
        fieldId: 'trustedProxies',
        label: 'Trusted proxies',
        description: 'CIDR list',
        error: 'Bad CIDR',
        children: (a11y: { describedBy?: string; invalid: boolean }) => {
          received = a11y;
          return createElement('textarea', { 'aria-describedby': a11y.describedBy });
        },
      })
    );
    const group = markup.match(/<div\b[^>]*role="group"[^>]*>/)?.[0] ?? '';
    const labelId = attr(group, 'aria-labelledby') ?? '';
    expect(labelId).toContain('trustedProxies-label');
    expect(markup).toContain(`id="${labelId}"`);
    expect(group).toContain('aria-invalid="true"');
    expect(received?.invalid).toBe(true);
    const ids = received?.describedBy?.split(' ') ?? [];
    expect(ids).toHaveLength(2);
    for (const id of ids) expect(markup).toContain(`id="${id}"`);
    expect(attr(group, 'aria-describedby')).toBe(received?.describedBy);
  });

  test('restart-required settings carry a marker next to the control', () => {
    const markup = render(
      createElement(TextSetting, { fieldId: 'port', label: 'Port', value: '', onChange: noop })
    );
    expect(markup).toContain('Restart required');
    const plain = render(
      createElement(TextSetting, { fieldId: 'proxyUrl', label: 'Proxy', value: '', onChange: noop })
    );
    expect(plain).not.toContain('Restart required');
  });

  test('secret rows mask the value and keep it out of titles and labels', () => {
    const secret = 'sk-fixture-secret-value';
    const markup = render(
      createElement(SecretSetting, {
        fieldId: 'rmSecretKey',
        label: 'Management key',
        value: secret,
        onChange: noop,
      })
    );
    const input = markup.match(/<input\b[^>]*>/)?.[0] ?? '';
    expect(input).toContain('type="password"');
    expect(input).toContain('autoComplete="new-password"');
    expect(markup.split(secret)).toHaveLength(2); // only the input value
    expect(markup).not.toMatch(new RegExp(`(?:title|aria-label)="[^"]*${secret}`));
    expect(markup).toContain('aria-label="Show value"');
    expect(markup).toContain('aria-label="Copy value"');
  });

  test('notices render as a warning under the help text', () => {
    const markup = render(
      createElement(TextSetting, {
        fieldId: 'host',
        label: 'Bind address',
        description: 'Address',
        notice: 'Exposed without TLS',
        value: '0.0.0.0',
        onChange: noop,
      })
    );
    expect(markup.indexOf('Exposed without TLS')).toBeGreaterThan(markup.indexOf('Address'));
  });
});
