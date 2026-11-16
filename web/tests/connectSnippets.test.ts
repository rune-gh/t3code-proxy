import { describe, expect, test } from 'bun:test';
import {
  buildClaudeSettings,
  buildCodexConfig,
  buildCurlCheck,
  buildGeminiCheck,
  buildGeminiEnv,
  buildMuseCodeCheck,
  buildOpenAIEnv,
  buildOpenCodeConfig,
  HUB_PLACEHOLDER,
  isLoopbackAddress,
  KEY_PLACEHOLDER,
  maskKey,
  normalizeHubAddress,
  shellQuote,
  tomlString,
} from '../src/features/connect/snippets';

const HUB = 'https://box.tailnet.ts.net:8317';

describe('normalizeHubAddress', () => {
  test('strips trailing slashes and client/panel paths', () => {
    expect(normalizeHubAddress(`${HUB}/`)).toBe(HUB);
    expect(normalizeHubAddress(`${HUB}///`)).toBe(HUB);
    expect(normalizeHubAddress(`${HUB}/v1/`)).toBe(HUB);
    expect(normalizeHubAddress(`${HUB}/v8/management`)).toBe(HUB);
    expect(normalizeHubAddress(`${HUB}/management.html`)).toBe(HUB);
    expect(normalizeHubAddress(`  ${HUB}  `)).toBe(HUB);
  });

  test('adds a scheme: https for ts.net, http otherwise', () => {
    expect(normalizeHubAddress('box.tailnet.ts.net:8317')).toBe(HUB);
    expect(normalizeHubAddress('192.168.1.4:8317')).toBe('http://192.168.1.4:8317');
  });

  test('keeps a reverse-proxy prefix path', () => {
    expect(normalizeHubAddress('https://example.com/hub/')).toBe('https://example.com/hub');
  });

  test('rejects unusable input', () => {
    expect(normalizeHubAddress('')).toBe('');
    expect(normalizeHubAddress('ftp://example.com')).toBe('');
    expect(normalizeHubAddress('https://user:pw@example.com')).toBe('');
    expect(normalizeHubAddress('http://')).toBe('');
  });
});

describe('isLoopbackAddress', () => {
  test('detects addresses that only work on this machine', () => {
    for (const value of [
      'http://localhost:8317',
      'http://127.0.0.1:8317',
      'http://127.1.2.3',
      'http://[::1]:8317',
      'http://0.0.0.0:8317',
    ]) {
      expect(isLoopbackAddress(value)).toBe(true);
    }
    expect(isLoopbackAddress(HUB)).toBe(false);
    expect(isLoopbackAddress('http://100.101.12.2:8317')).toBe(false);
    expect(isLoopbackAddress('not a url %%')).toBe(false);
  });
});

describe('maskKey', () => {
  test('shows only the last four characters and never short keys', () => {
    expect(maskKey('sk-hub-laptop-7d1e9c42b6')).toBe('••••••••42b6');
    expect(maskKey('short')).toBe('••••••••');
    expect(maskKey('sk-hub-laptop-7d1e9c42b6')).not.toContain('laptop');
  });
});

describe('snippets', () => {
  const key = 'sk-"quoted"\\key';

  test('Claude settings are valid JSON with the hub and key', () => {
    const parsed = JSON.parse(buildClaudeSettings({ hub: HUB, key }));
    expect(parsed).toEqual({ env: { ANTHROPIC_BASE_URL: HUB, ANTHROPIC_AUTH_TOKEN: key } });
  });

  test('placeholders replace a missing key or hub', () => {
    const settings = JSON.parse(buildClaudeSettings({ hub: '', key: '' }));
    expect(settings.env.ANTHROPIC_BASE_URL).toBe(HUB_PLACEHOLDER);
    expect(settings.env.ANTHROPIC_AUTH_TOKEN).toBe(KEY_PLACEHOLDER);
    expect(buildCodexConfig({ hub: HUB, key: '' })).toContain(
      `experimental_bearer_token = "${KEY_PLACEHOLDER}"`
    );
    expect(buildCurlCheck({ hub: HUB, key: '' })).toContain(KEY_PLACEHOLDER);
  });

  test('Codex config declares the provider with /v1 and websockets', () => {
    const toml = buildCodexConfig({ hub: HUB, key: 'sk-abc' });
    expect(toml).toBe(
      [
        'model_provider = "t3code-proxy"',
        '',
        '[model_providers.t3code-proxy]',
        'name = "t3code-proxy"',
        `base_url = "${HUB}/v1"`,
        'wire_api = "responses"',
        'requires_openai_auth = false',
        'supports_websockets = true',
        'experimental_bearer_token = "sk-abc"',
      ].join('\n')
    );
  });

  test('TOML strings escape quotes, backslashes and control characters', () => {
    expect(tomlString(key)).toBe('"sk-\\"quoted\\"\\\\key"');
    expect(tomlString('a\nb\u0001')).toBe('"a\\nb\\u0001"');
    expect(buildCodexConfig({ hub: HUB, key })).toContain(
      'experimental_bearer_token = "sk-\\"quoted\\"\\\\key"'
    );
  });

  test('curl check quotes values for the shell', () => {
    expect(buildCurlCheck({ hub: HUB, key: 'sk-abc' })).toBe(
      `curl -s ${HUB}/v1/models -H 'Authorization: Bearer sk-abc' | head -c 300`
    );
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(buildCurlCheck({ hub: HUB, key: "a'b" })).toContain(
      `-H 'Authorization: Bearer a'\\''b'`
    );
  });
});

describe('other clients', () => {
  const KEY = 'sk-test-123';

  test('OpenAI variables point at /v1', () => {
    expect(buildOpenAIEnv({ hub: HUB, key: KEY })).toBe(
      `export OPENAI_BASE_URL=${HUB}/v1\nexport OPENAI_API_KEY=${KEY}`
    );
    expect(buildOpenAIEnv({ hub: '', key: '' })).toBe(
      `export OPENAI_BASE_URL='${HUB_PLACEHOLDER}/v1'\nexport OPENAI_API_KEY='${KEY_PLACEHOLDER}'`
    );
  });

  test('OpenCode config is valid JSON with an OpenAI-compatible provider', () => {
    const config = JSON.parse(buildOpenCodeConfig({ hub: HUB, key: KEY }));
    const provider = config.provider['t3code-proxy'];
    expect(provider.npm).toBe('@ai-sdk/openai-compatible');
    expect(provider.options).toEqual({ baseURL: `${HUB}/v1`, apiKey: KEY });
    expect(Object.keys(provider.models)).toEqual(['<model id>']);
  });

  test('Gemini clients get the hub root; the check uses the Gemini key header', () => {
    expect(buildGeminiEnv({ hub: HUB, key: KEY })).toBe(
      `export GOOGLE_GEMINI_BASE_URL=${HUB}\nexport GEMINI_API_KEY=${KEY}`
    );
    expect(buildGeminiCheck({ hub: HUB, key: KEY })).toBe(
      `curl -s ${HUB}/v1beta/models -H 'x-goog-api-key: ${KEY}' | head -c 300`
    );
  });

  test('a key with quotes stays one shell word', () => {
    expect(buildOpenAIEnv({ hub: HUB, key: "a'b" })).toContain(`OPENAI_API_KEY='a'\\''b'`);
  });

  test('Muse Code check reads the generated model list', () => {
    expect(buildMuseCodeCheck({ hub: HUB, key: KEY })).toBe(
      `curl -s ${HUB}/muse-code/models -H 'Authorization: Bearer ${KEY}' | head -c 300`
    );
  });
});

describe('every snippet targets a route the hub serves', () => {
  // Paths registered in internal/api/server_routes.go.
  const SERVED = ['/v1', '/v1/models', '/v1beta/models', '/muse-code/models'];
  test('URLs in the snippets', () => {
    const input = { hub: HUB, key: 'k' };
    const text = [
      buildOpenAIEnv(input),
      buildOpenCodeConfig(input),
      buildGeminiCheck(input),
      buildMuseCodeCheck(input),
      buildCurlCheck(input),
    ].join('\n');
    const paths = [...text.matchAll(/https:\/\/box\.tailnet\.ts\.net:8317(\/[\w/-]*)/g)].map(
      (match) => match[1]
    );
    expect(paths.length).toBeGreaterThan(0);
    paths.forEach((path) => expect(SERVED).toContain(path));
  });
});
