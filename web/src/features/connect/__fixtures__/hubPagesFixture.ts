/**
 * DEV-only sample data for the Connect, Activity, Logs and Plugins pages. It wraps the
 * quota-history fixture adapter: routes it knows are answered here, everything else falls
 * through. Query switches (all optional):
 * - `activity=empty`: no traffic in the window (Activity empty state)
 * - `logs=off`: file logging switched off (Logs disabled state)
 * - `keys=none`: no client access keys configured (Connect fallback)
 * Never imported by production code: devFixture.ts is behind `import.meta.env.DEV`.
 */

import axios, { AxiosHeaders, type AxiosAdapter, type AxiosResponse } from 'axios';
import { useAuthStore } from '@/stores';
import { installDevApiAdapter } from '@/services/api/client';

const BUCKETS = 20;
const BUCKET_MINUTES = 10;

const pad = (value: number) => String(value).padStart(2, '0');
const clock = (date: Date) => `${pad(date.getHours())}:${pad(date.getMinutes())}`;

/** Twenty 10-minute buckets ending now, with a deterministic load curve. */
function buildBuckets(seed: number, scale: number, empty: boolean) {
  const end = new Date();
  end.setSeconds(0, 0);
  end.setMinutes(end.getMinutes() - (end.getMinutes() % BUCKET_MINUTES));
  return Array.from({ length: BUCKETS }, (_, index) => {
    const start = new Date(end.getTime() - (BUCKETS - index) * BUCKET_MINUTES * 60_000);
    const stop = new Date(start.getTime() + BUCKET_MINUTES * 60_000);
    const wave = Math.sin((index + seed) / 2.6) * 0.5 + 0.6;
    const success = empty ? 0 : Math.max(0, Math.round(scale * wave + ((index * seed) % 5)));
    const failed = empty
      ? 0
      : (index * 7 + seed) % 9 === 0
        ? Math.max(1, Math.round(scale / 12))
        : 0;
    return { time: `${clock(start)}-${clock(stop)}`, success, failed };
  });
}

function withTraffic(files: Array<Record<string, unknown>>, empty: boolean) {
  return files.map((file, index) => {
    const provider = String(file.type ?? file.provider ?? '');
    const scale = provider === 'claude' ? 14 : provider === 'codex' ? 9 : 3;
    const buckets = buildBuckets(index + 1, scale, empty);
    return {
      ...file,
      success: buckets.reduce((sum, bucket) => sum + bucket.success, 0),
      failed: buckets.reduce((sum, bucket) => sum + bucket.failed, 0),
      recent_requests: buckets,
    };
  });
}

const LOG_PATHS = ['/v1/messages', '/v1/responses', '/v1/models', '/v1/messages/count_tokens'];

function buildLogLines(count: number): string[] {
  const base = Date.now() - count * 4_000;
  return Array.from({ length: count }, (_, index) => {
    const at = new Date(base + index * 4_000);
    const stamp = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(
      at.getHours()
    )}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
    const id = (0x1a2b3c00 + index).toString(16).slice(-8);
    if (index % 17 === 5) {
      return `[${stamp}] [${id}] [warn ] [conductor.go:412] claude account grace@example.com hit its 5-hour limit, cooling down for 41m`;
    }
    if (index % 29 === 11) {
      return `[${stamp}] [${id}] [error] [codex_executor.go:233] upstream returned 529 overloaded_error, retrying on another account`;
    }
    if (index % 13 === 3) {
      return `[${stamp}] [--------] [debug] [watcher.go:88] config file unchanged, skipping reload`;
    }
    const path = LOG_PATHS[index % LOG_PATHS.length];
    const status = index % 29 === 12 ? 529 : index % 23 === 7 ? 429 : 200;
    const latency = `${(0.4 + ((index * 37) % 90) / 10).toFixed(3)}s`;
    const method = path === '/v1/models' ? 'GET' : 'POST';
    return `[${stamp}] [${id}] [info ] [gin_logger.go:110] ${status} | ${latency} | 100.101.12.${
      (index % 4) + 2
    } | ${method} "${path}"`;
  });
}

const MODEL_IDS = [
  'claude-opus-4-5',
  'claude-sonnet-4-5',
  'claude-haiku-4-5',
  'gpt-5.1-codex',
  'gpt-5.1-codex-mini',
  'gpt-5.1',
];

const PLUGINS = {
  plugins_enabled: true,
  plugins_dir: 'plugins',
  plugins: [
    {
      id: 'usage-export',
      path: 'plugins/usage-export',
      configured: true,
      registered: true,
      enabled: true,
      effective_enabled: true,
      metadata: {
        name: 'Usage export',
        version: '1.4.0',
        author: 'router-for-me',
        github_repository: 'https://github.com/router-for-me/usage-export',
        config_fields: [
          { name: 'target_url', type: 'string', description: 'Where to POST the hourly summary.' },
          { name: 'interval_minutes', type: 'integer', description: 'How often to export.' },
          { name: 'format', type: 'enum', enum_values: ['json', 'csv'], description: '' },
        ],
      },
      menus: [{ path: '/plugins/usage-export/ui/', menu: 'Usage export', description: '' }],
    },
    {
      id: 'slack-alerts',
      path: 'plugins/slack-alerts',
      configured: true,
      registered: true,
      enabled: false,
      effective_enabled: false,
      metadata: { name: 'Slack alerts', version: '0.3.2', author: 'someone-else' },
    },
  ],
};

const STORE = {
  plugins_enabled: true,
  plugins_dir: 'plugins',
  source_errors: [],
  plugins: [
    {
      id: 'usage-export',
      source_id: 'official',
      source_name: 'CLIProxyAPI',
      name: 'Usage export',
      description: 'Exports an hourly usage summary to a webhook or a CSV file.',
      author: 'router-for-me',
      version: '1.5.0',
      repository: 'https://github.com/router-for-me/usage-export',
      install_type: 'binary',
      license: 'MIT',
      installed: true,
      installed_version: '1.4.0',
      update_available: true,
    },
    {
      id: 'slack-alerts',
      source_id: 'community',
      source_name: 'Community index',
      name: 'Slack alerts',
      description: 'Posts a message when an account is cooling down or a request keeps failing.',
      author: 'someone-else',
      version: '0.3.2',
      repository: 'https://github.com/someone-else/slack-alerts',
      install_type: 'binary',
      installed: true,
      installed_version: '0.3.2',
    },
    {
      id: 'prompt-cache-stats',
      source_id: 'community',
      source_name: 'Community index',
      name: 'Prompt cache stats',
      description:
        'Adds a page with prompt-cache hit rates per model and per account, read from the request log.',
      author: 'cachefan',
      version: '0.9.0',
      repository: 'https://github.com/cachefan/prompt-cache-stats',
      install_type: 'binary',
      license: 'Apache-2.0',
      tags: ['metrics'],
    },
  ],
};

/** Wrap the base fixture adapter with sample data for the Connect/Activity/Logs/Plugins pages. */
export function installHubPagesFixture(base: AxiosAdapter): void {
  const params = new URLSearchParams(window.location.search);
  const emptyActivity = params.get('activity') === 'empty';
  const loggingToFile = params.get('logs') !== 'off';
  const noKeys = params.get('keys') === 'none';
  const logLines = buildLogLines(600);
  let logsCleared = false;

  const adapter: AxiosAdapter = async (config) => {
    const url = `${config.baseURL ?? ''}${config.url ?? ''}`;
    const path = url.replace(/^https?:\/\/[^/]+/, '').replace(/^\/v8\/management/, '');
    const method = (config.method ?? 'get').toLowerCase();
    const headers = new AxiosHeaders({ 'x-cpa-support-plugin': 'true' });
    const respond = (data: unknown): AxiosResponse => ({
      data,
      status: 200,
      statusText: 'OK',
      headers,
      config,
    });

    if (method === 'get' && path === '/config') {
      await new Promise((resolve) => setTimeout(resolve, 80));
      return respond({
        access: {
          'api-keys': noKeys ? [] : ['sk-hub-laptop-7d1e9c42b6', 'sk-hub-desktop-a83f0e5d19'],
        },
        observability: { logs: { 'logging-to-file': loggingToFile, 'request-log': false } },
        routing: { strategy: 'round-robin' },
      });
    }
    if (method === 'get' && path === '/credentials') {
      const response = await base(config);
      const data = response.data as { files?: Array<Record<string, unknown>> };
      return {
        ...response,
        data: { ...data, files: withTraffic(data.files ?? [], emptyActivity) },
      };
    }
    if (method === 'get' && path === '/observability/usage/api-keys') return respond({});
    if (method === 'get' && path === '/observability/logs') {
      return respond({
        lines: logsCleared || config.params?.cursor ? [] : logLines,
        'next-cursor': 'fixture-end',
        'latest-timestamp': Math.floor(Date.now() / 1000),
      });
    }
    if (method === 'delete' && path === '/observability/logs') {
      logsCleared = true;
      return respond({ status: 'ok' });
    }
    if (method === 'get' && path === '/observability/logs/errors') {
      const now = Math.floor(Date.now() / 1000);
      return respond({
        files: [
          { name: 'error-v1-responses-2026-11-14T19-42-07.log', size: 18_204, modified: now - 900 },
          {
            name: 'error-v1-messages-2026-11-14T17-03-51.log',
            size: 6_731,
            modified: now - 10_300,
          },
        ],
      });
    }
    if (method === 'get' && path === '/plugins') return respond(PLUGINS);
    if (method === 'get' && path === '/plugins/store') return respond(STORE);
    if (method === 'get' && path.startsWith('/config/plugins/configs/')) {
      return respond({
        enabled: true,
        priority: 10,
        target_url: 'https://hooks.example.com/usage',
      });
    }
    return base(config);
  };

  installDevApiAdapter(adapter);
  useAuthStore.setState({ supportsPlugin: true });

  // The model list is fetched with plain axios against `<hub>/v1/models` (Activity's model
  // count, Connect's browser test); answer it here and let every other plain request through.
  const network = axios.getAdapter(['xhr', 'fetch']);
  axios.defaults.adapter = async (config) => {
    if (/\/v1\/models(\?|$)/.test(config.url ?? '')) {
      const data = {
        object: 'list',
        data: MODEL_IDS.map((id) => ({ id, object: 'model', owned_by: id.split('-')[0] })),
      };
      return { data, status: 200, statusText: 'OK', headers: new AxiosHeaders(), config };
    }
    return network(config);
  };
}
