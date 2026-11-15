/**
 * DEV-only sample data for the model exclusion and model alias editors, served by the
 * quota-history fixture session. Returns `undefined` for routes it does not own.
 */

const EXCLUDED: Record<string, string[]> = {
  claude: ['claude-3-5-haiku-*', 'claude-opus-4-1'],
  codex: ['gpt-5-codex-mini'],
};

const MODEL_ALIAS: Record<string, Array<Record<string, unknown>>> = {
  claude: [
    { name: 'claude-sonnet-4-5', alias: 'sonnet' },
    { name: 'claude-opus-4-5', alias: 'opus' },
    { name: 'claude-haiku-4-5', alias: 'haiku', fork: true },
  ],
  codex: [
    { name: 'gpt-5-codex', alias: 'codex' },
    { name: 'gpt-5', alias: 'gpt', 'force-mapping': true },
  ],
};

const MODEL_DEFINITIONS: Record<string, string[]> = {
  claude: [
    'claude-sonnet-4-5',
    'claude-opus-4-5',
    'claude-opus-4-1',
    'claude-haiku-4-5',
    'claude-3-5-haiku-20241022',
  ],
  codex: ['gpt-5-codex', 'gpt-5', 'gpt-5-codex-mini', 'gpt-5-mini'],
};

/** Answers the editors' config and model-catalog routes; `undefined` means "not mine". */
export function respondModelRulesFixture(method: string, path: string): unknown {
  if (/\/config\/oauth\/excluded-models$/.test(path)) {
    if (method === 'get') return EXCLUDED;
    if (method === 'put') return { status: 'ok' };
  }
  if (/\/config\/oauth\/model-alias$/.test(path)) {
    if (method === 'get') return MODEL_ALIAS;
    if (method === 'put') return { status: 'ok' };
  }
  const definitions = /\/routing\/model-definitions\/([^/?]+)$/.exec(path);
  if (definitions && method === 'get') {
    const models = MODEL_DEFINITIONS[decodeURIComponent(definitions[1])];
    return models ? { models: models.map((id) => ({ id })) } : undefined;
  }
  return undefined;
}
