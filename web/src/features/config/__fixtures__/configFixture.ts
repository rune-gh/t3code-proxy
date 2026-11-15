/**
 * DEV-only sample configuration for the fixture session (`?fixture=quota-history`), so the
 * Settings and System pages render real rows. Keys are obvious placeholders, never secrets.
 */

const SAMPLE_CONFIG_YAML = `server:
  host: 0.0.0.0
  port: 8317
  trusted-proxies:
    - 100.64.0.0/10
management:
  allow-remote: true
  secret-key: fixture-management-key
access:
  api-keys:
    - sk-fixture-laptop-0000000000000000
    - sk-fixture-desktop-111111111111111
oauth:
  auth-dir: ~/.t3code-proxy
routing:
  strategy: soonest-reset-first
  session-affinity: true
  session-affinity-ttl: 1h
  retry:
    request-retry: 3
    max-retry-interval: 30
quota-history:
  enabled: true
  interval: 10m
  retention: 35d
observability:
  logs:
    debug: false
    logging-to-file: true
    logs-max-total-size-mb: 512
  usage:
    usage-statistics-enabled: true
requests:
  proxy-url: ""
`;

/** Answers GET /config.yaml; anything else is left to the other fixtures. */
export function respondConfigFixture(method: string, path: string): string | undefined {
  if (method === 'get' && /\/v8\/management\/config\.yaml$/.test(path)) return SAMPLE_CONFIG_YAML;
  return undefined;
}
