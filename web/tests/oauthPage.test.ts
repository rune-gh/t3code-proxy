import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';
import { createInstance } from 'i18next';
import en from '@/i18n/locales/en.json';
import { OAuthPage } from '@/features/oauth/OAuthPage';
import { resolveCallbackUrl, XAI_CALLBACK_URL } from '@/features/oauth/callbackUrl';
import { resolveFlowView, splitAuthUrl } from '@/features/oauth/flowView';
import { OAuthFlowDialog } from '@/features/oauth/components/OAuthFlowDialog';
import {
  buildPluginOAuthProviderCards,
  OAUTH_PROVIDERS,
  PRIMARY_PROVIDER_IDS,
} from '@/features/oauth/providers';
import type { PluginListEntry } from '@/types';

describe('OAuth dialog view resolution', () => {
  test('maps every flow state to exactly one view', () => {
    expect(resolveFlowView({})).toBe('idle');
    // Generating the link: already in the step view (skeleton placeholder)
    expect(resolveFlowView({ status: 'waiting' })).toBe('flow');
    expect(resolveFlowView({ status: 'waiting', url: 'https://a.test' })).toBe('flow');
    expect(resolveFlowView({ status: 'success' })).toBe('success');
    // Polling failed but the link is still valid: stay in the step view; manual callback can recover
    expect(resolveFlowView({ status: 'error', url: 'https://a.test' })).toBe('flow');
    // The link is no longer valid (start failed / Devin terminal failure): failed view
    expect(resolveFlowView({ status: 'error', error: 'denied' })).toBe('failed');
  });

  test('highlights the host of the authorization link', () => {
    expect(splitAuthUrl('https://auth.openai.com/oauth/authorize?x=1')).toEqual({
      host: 'auth.openai.com',
      rest: '/oauth/authorize?x=1',
    });
    expect(splitAuthUrl('http://127.0.0.1:8317/cb')).toEqual({
      host: '127.0.0.1:8317',
      rest: '/cb',
    });
    expect(splitAuthUrl('not a url')).toEqual({ host: '', rest: 'not a url' });
  });
});

describe('manual callback input', () => {
  test('submits non-xAI input verbatim (trimmed)', () => {
    expect(resolveCallbackUrl('codex', '  http://localhost:1455/auth/callback?code=c  ')).toBe(
      'http://localhost:1455/auth/callback?code=c'
    );
  });

  test('passes absolute xAI callback URLs through', () => {
    const url = 'http://127.0.0.1:56121/callback?code=c&state=s';
    expect(resolveCallbackUrl('xai', url, 'other')).toBe(url);
  });

  test('builds the xAI loopback URL from a displayed code and the attempt state', () => {
    const built = new URL(resolveCallbackUrl('xai', 'abc123', 'st-1')!);
    expect(`${built.origin}${built.pathname}`).toBe(XAI_CALLBACK_URL);
    expect(built.searchParams.get('code')).toBe('abc123');
    expect(built.searchParams.get('state')).toBe('st-1');
    expect(new URL(resolveCallbackUrl('xai', 'code: xyz', 'st-1')!).searchParams.get('code')).toBe(
      'xyz'
    );
  });

  test('prefers the pasted query state and keeps provider errors', () => {
    const built = new URL(
      resolveCallbackUrl('xai', '?error=access_denied&error_description=no&state=pasted', 'st')!
    );
    expect(built.searchParams.get('state')).toBe('pasted');
    expect(built.searchParams.get('error')).toBe('access_denied');
    expect(built.searchParams.get('error_description')).toBe('no');
  });

  test('refuses to invent a state for xAI', () => {
    expect(resolveCallbackUrl('xai', 'abc123')).toBeNull();
    expect(resolveCallbackUrl('xai', 'code=abc123')).toBeNull();
    expect(resolveCallbackUrl('xai', '   ', 'st')).toBeNull();
  });
});

const plugin = (overrides: Partial<PluginListEntry>): PluginListEntry => ({
  id: 'example',
  path: '/plugins/example',
  configured: true,
  registered: true,
  enabled: true,
  effectiveEnabled: true,
  supportsOAuth: true,
  oauthProvider: 'example',
  supportsQuota: false,
  logo: '',
  configFields: [],
  menus: [],
  metadata: null,
  ...overrides,
});

describe('plugin OAuth tiles', () => {
  test('appends enabled OAuth plugins once and never shadows built-in providers', () => {
    const cards = buildPluginOAuthProviderCards(
      [
        plugin({ id: 'a', oauthProvider: 'acme' }),
        plugin({ id: 'a-dup', oauthProvider: 'acme' }),
        plugin({ id: 'b', oauthProvider: 'codex' }),
        plugin({ id: 'c', oauthProvider: 'off', effectiveEnabled: false }),
        plugin({ id: 'd', oauthProvider: 'nooauth', supportsOAuth: false }),
        plugin({ id: 'e', oauthProvider: undefined }),
      ],
      'http://127.0.0.1:8317'
    );
    expect(cards.map((card) => [card.id, card.title])).toEqual([['acme', 'a']]);
  });
});

describe('OAuth provider gallery', () => {
  const locales = { en } as const;

  for (const [lng, translation] of Object.entries(locales)) {
    test(`renders every provider tile without raw keys (${lng})`, async () => {
      const i18n = createInstance();
      await i18n.init({ lng, resources: { [lng]: { translation } } });
      const markup = renderToStaticMarkup(
        createElement(
          I18nextProvider,
          { i18n },
          createElement(MemoryRouter, null, createElement(OAuthPage))
        )
      );
      for (const provider of OAUTH_PROVIDERS) {
        const label =
          typeof provider.label === 'string' ? provider.label : i18n.t(provider.label.key);
        expect(markup).toContain(label);
      }
      expect(markup).toContain('Vertex AI');
      expect(markup).toContain(i18n.t('siwc.bind'));
      expect(markup).not.toMatch(/auth_login\.|vertex_import\.|siwc\./);
      // Every tile is a button that opens a dialog (providers + Vertex + SIWC binding)
      expect(markup.match(/aria-haspopup="dialog"/g)?.length).toBe(OAUTH_PROVIDERS.length + 2);
    });
  }

  test('leads with Claude and Codex, then groups the rest under more providers', async () => {
    const i18n = createInstance();
    await i18n.init({ lng: 'en', resources: { en: { translation: en } } });
    const markup = renderToStaticMarkup(
      createElement(
        I18nextProvider,
        { i18n },
        createElement(MemoryRouter, null, createElement(OAuthPage))
      )
    );
    expect(markup).toContain(`<h1`);
    expect(markup).toContain(en.auth_login.page_title);
    expect(PRIMARY_PROVIDER_IDS.has('anthropic')).toBe(true);
    expect(PRIMARY_PROVIDER_IDS.has('codex')).toBe(true);
    const claude = markup.indexOf('>Claude</button>');
    const codex = markup.indexOf('>Codex</button>');
    const more = markup.indexOf(en.auth_login.more_providers);
    expect(claude).toBeGreaterThan(-1);
    expect(codex).toBeGreaterThan(claude);
    expect(more).toBeGreaterThan(codex);
    expect(markup.indexOf('>Muse (Meta)</button>')).toBeGreaterThan(more);
    expect(markup).toContain(en.auth_login.anthropic_tile_desc);
    expect(markup).toContain(en.auth_login.codex_tile_desc);
  });

  test('the success view links to accounts', async () => {
    const i18n = createInstance();
    await i18n.init({ lng: 'en', resources: { en: { translation: en } } });
    const markup = renderToStaticMarkup(
      createElement(
        I18nextProvider,
        { i18n },
        createElement(OAuthFlowDialog, {
          open: true,
          providerId: 'anthropic',
          heading: { title: 'Sign in with Claude', caption: 'Browser sign-in', icon: '' },
          state: { status: 'success' },
          text: (suffix: string) => i18n.t(`auth_login.anthropic_${suffix}`),
          supportsCallback: true,
          onStart: () => {},
          onCancel: () => {},
          onCallbackChange: () => {},
          onCallbackSubmit: () => {},
          onViewAuthFiles: () => {},
          onClose: () => {},
        })
      )
    );
    expect(markup).toContain(en.auth_login.view_auth_files);
    expect(markup).toContain(en.auth_login.anthropic_oauth_status_success);
  });

  test('renders Kimi sites as ordinary tiles without external sign-up links', async () => {
    const i18n = createInstance();
    await i18n.init({ lng: 'en', resources: { en: { translation: en } } });
    const markup = renderToStaticMarkup(
      createElement(
        I18nextProvider,
        { i18n },
        createElement(MemoryRouter, null, createElement(OAuthPage))
      )
    );
    expect(markup).not.toContain('role="group"');
    expect(markup).not.toMatch(/href="https?:/);
    for (const id of ['kimi', 'kimi-ai']) {
      expect(OAUTH_PROVIDERS.some((provider) => provider.id === id)).toBe(true);
    }
  });
});
