/**
 * DEV-only sample hub configuration for the Providers and Routing pages under
 * `?fixture=quota-history`. Keys are obviously fake. Writes are kept in memory so saving,
 * toggling and deleting behave like a real hub until the page reloads.
 */

type Json = Record<string, unknown>;

const initialConfig = (): Json => ({
  routing: {
    strategy: 'soonest-reset-first',
    'session-affinity': true,
    'session-affinity-ttl': '1h',
    retry: { 'request-retry': 2, 'max-retry-interval': 30 },
  },
  'api-keys': {
    'openai-compatibility': [
      {
        name: 'openrouter',
        'base-url': 'https://openrouter.ai/api/v1',
        keys: [{ 'api-key': 'sk-or-fixture-0001' }, { 'api-key': 'sk-or-fixture-0002' }],
        models: [
          { name: 'deepseek/deepseek-chat', alias: 'deepseek' },
          { name: 'qwen/qwen3-coder', alias: 'qwen-coder' },
          { name: 'moonshotai/kimi-k2' },
        ],
      },
      {
        name: 'local-vllm',
        'base-url': 'http://192.168.1.20:8000/v1',
        keys: [{ 'api-key': 'sk-local-fixture' }],
        models: [{ name: 'Qwen/Qwen3-32B', alias: 'qwen3' }],
        disabled: true,
      },
    ],
    gemini: [
      {
        name: 'gemini-1',
        keys: [
          {
            'api-key': 'AIza-fixture-gemini-key',
            models: [{ name: 'gemini-2.5-pro' }, { name: 'gemini-2.5-flash' }],
          },
        ],
      },
    ],
    claude: [
      {
        name: 'claude-1',
        keys: [{ 'api-key': 'sk-ant-api-fixture-0001', models: [{ name: 'claude-sonnet-4-5' }] }],
      },
    ],
  },
});

let config: Json | null = null;

const current = (): Json => (config ??= initialConfig());

/**
 * Answers the config requests these pages make; `undefined` lets the caller fall through to
 * its own handlers.
 */
export function respondProvidersFixture(
  method: string,
  path: string,
  data: unknown
): unknown | undefined {
  if (!/\/v8\/management\/config(\/|$)/.test(path)) return undefined;
  const body = typeof data === 'string' && data ? (JSON.parse(data) as unknown) : data;
  const cfg = current();

  if (method === 'get' && /\/config$/.test(path)) return structuredClone(cfg);

  const family = path.match(/\/config\/api-keys\/([a-z-]+)$/)?.[1];
  if (family && method === 'put' && Array.isArray(body)) {
    cfg['api-keys'] = { ...(cfg['api-keys'] as Json), [family]: body };
    return { status: 'ok' };
  }

  if (method === 'patch' && /\/config$/.test(path) && body && typeof body === 'object') {
    const patch = body as Json;
    for (const [key, value] of Object.entries(patch)) {
      const before = cfg[key];
      cfg[key] =
        value && typeof value === 'object' && !Array.isArray(value) && before
          ? { ...(before as Json), ...(value as Json) }
          : value;
    }
    return structuredClone(cfg);
  }
  return undefined;
}
