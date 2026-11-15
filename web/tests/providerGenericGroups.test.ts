import { describe, expect, test } from 'bun:test';
import { buildProviderGroups } from '../src/features/providers/useProviderWorkbench';
import type { Config } from '../src/types';

const thirdPartyEndpoints = [
  ['relayOne', 'https://relay-one.example.com'],
  ['relayTwo', 'https://api.relay-two.example.net'],
  ['moonshot', 'https://api.moonshot.ai'],
] as const;

describe('provider groups', () => {
  test('only exposes the generic protocol groups', () => {
    const ids = buildProviderGroups({}).map((group) => group.id);
    expect(ids).toEqual([
      'gemini',
      'interactions',
      'codex',
      'meta',
      'xai',
      'claude',
      'vertex',
      'openaiCompatibility',
    ]);
  });

  for (const [name, baseUrl] of thirdPartyEndpoints) {
    test(`keeps ${baseUrl} configs editable in generic protocol groups`, () => {
      const key = {
        apiKey: 'test-third-party-key',
        baseUrl,
        excludedModels: ['*', 'excluded-model'],
        fingerprintProfile: 'claude-code-cli',
      };
      const openai = {
        name,
        baseUrl: `${baseUrl}/v1`,
        apiKeyEntries: [{ apiKey: 'test-third-party-key' }],
        sourceIndex: 7,
        disabled: true,
      };
      const config: Config = {
        geminiApiKeys: [key],
        codexApiKeys: [key],
        claudeApiKeys: [key],
        openaiCompatibility: [openai],
      };
      const groups = buildProviderGroups(config);
      for (const brand of ['gemini', 'codex', 'claude', 'openaiCompatibility']) {
        const resources = groups.find((group) => group.id === brand)!.resources;
        expect(resources).toHaveLength(1);
        const resource = resources[0];
        expect(resource.brand).toBe(brand);
        expect(resource.disabled).toBe(true);
        expect(resource.raw).toBe(brand === 'openaiCompatibility' ? openai : key);
        expect(resource.selector).toEqual(
          brand === 'openaiCompatibility'
            ? { brand, name, index: 7 }
            : { brand, apiKey: key.apiKey, baseUrl, index: 0 }
        );
        if (brand === 'claude') expect(resource.flags.claudeCodeCliProfile).toBe(true);
      }
      expect(groups.flatMap((group) => group.resources)).toHaveLength(4);
    });
  }
});
