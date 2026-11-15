/**
 * Pure builders for the Connect page: hub address normalization and the client config
 * snippets. Each snippet is built twice by the page: once for display (placeholder unless
 * the key is revealed) and once for the clipboard (always the real key when one is chosen).
 */

export const KEY_PLACEHOLDER = '<your access key>';
export const HUB_PLACEHOLDER = '<hub address>';
export const CODEX_PROVIDER_ID = 't3code-proxy';
export const TAILSCALE_SERVE_COMMAND = 'tailscale serve --bg --https=8317 http://127.0.0.1:8317';

/**
 * Turn whatever the user typed into a base URL without a trailing slash. Drops paths the
 * panel or clients add (`/v1`, `/v8/management`, `/management.html`). Returns '' when the
 * input is not a usable http(s) URL.
 */
export function normalizeHubAddress(input: string): string {
  let value = input.trim();
  if (!value) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    const host = value.split(/[/:?#]/)[0].toLowerCase();
    value = `${host.endsWith('.ts.net') ? 'https' : 'http'}://${value}`;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return '';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
  if (!url.hostname || url.username || url.password) return '';
  const path = url.pathname
    .replace(/\/management\.html$/i, '')
    .replace(/\/+$/, '')
    .replace(/\/v8\/management$/i, '')
    .replace(/\/v1$/i, '')
    .replace(/\/+$/, '');
  return `${url.protocol}//${url.host}${path}`;
}

/** True when the address only works on this machine (localhost, 127/8, ::1, 0.0.0.0). */
export function isLoopbackAddress(address: string): boolean {
  const normalized = normalizeHubAddress(address);
  if (!normalized) return false;
  const host = new URL(normalized).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '::1' ||
    host === '0.0.0.0' ||
    /^127(?:\.\d{1,3}){3}$/.test(host)
  );
}

/** Dots for all but the last four characters; short keys are fully hidden. */
export function maskKey(key: string): string {
  if (key.length <= 8) return '•'.repeat(Math.max(key.length, 8));
  return `${'•'.repeat(8)}${key.slice(-4)}`;
}

interface SnippetInput {
  /** Normalized hub address, or '' when unknown. */
  hub: string;
  /** The key to embed, or '' to show the placeholder. */
  key: string;
}

const hubOr = (hub: string) => hub || HUB_PLACEHOLDER;
const keyOr = (key: string) => key || KEY_PLACEHOLDER;

/** `~/.claude/settings.json` */
export function buildClaudeSettings({ hub, key }: SnippetInput): string {
  const settings = {
    env: {
      ANTHROPIC_BASE_URL: hubOr(hub),
      ANTHROPIC_AUTH_TOKEN: keyOr(key),
    },
  };
  return JSON.stringify(settings, null, 2);
}

/** TOML basic string with the escapes TOML requires. */
export function tomlString(value: string): string {
  let escaped = '';
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (char === '\\') escaped += '\\\\';
    else if (char === '"') escaped += '\\"';
    else if (char === '\n') escaped += '\\n';
    else if (char === '\r') escaped += '\\r';
    else if (char === '\t') escaped += '\\t';
    else if (code < 0x20 || code === 0x7f) escaped += `\\u${code.toString(16).padStart(4, '0')}`;
    else escaped += char;
  }
  return `"${escaped}"`;
}

/** `~/.codex/config.toml` */
export function buildCodexConfig({ hub, key }: SnippetInput): string {
  const baseUrl = hub ? `${hub}/v1` : `${HUB_PLACEHOLDER}/v1`;
  return [
    `model_provider = ${tomlString(CODEX_PROVIDER_ID)}`,
    '',
    `[model_providers.${CODEX_PROVIDER_ID}]`,
    `name = ${tomlString(CODEX_PROVIDER_ID)}`,
    `base_url = ${tomlString(baseUrl)}`,
    'wire_api = "responses"',
    'requires_openai_auth = false',
    'supports_websockets = true',
    `experimental_bearer_token = ${tomlString(keyOr(key))}`,
  ].join('\n');
}

/** Single-quote for POSIX shells when the value has anything beyond URL-safe characters. */
export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Quick check from a terminal on the client machine. */
export function buildCurlCheck({ hub, key }: SnippetInput): string {
  const url = `${hubOr(hub)}/v1/models`;
  const header = `Authorization: Bearer ${keyOr(key)}`;
  return `curl -s ${shellQuote(url)} -H ${shellQuote(header)} | head -c 300`;
}

export const SEPARATE_INSTALL_COMMANDS = [
  'CLAUDE_CONFIG_DIR=~/.claude-hub claude',
  'CODEX_HOME=~/.codex-hub codex',
].join('\n');
