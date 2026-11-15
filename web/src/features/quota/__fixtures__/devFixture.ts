/**
 * DEV-only fixture session: `/?fixture=quota-history#/quota` renders the app
 * against canned data instead of a live hub. Add `&history=off` to simulate a
 * hub without the quota-history endpoint (404) and check the degraded view. Loaded through a dynamic import
 * guarded by `import.meta.env.DEV`, so production bundles never contain it.
 *
 * The fake session is kept out of persisted login storage, and every
 * Management API call is answered locally (unknown routes return 404).
 */

import { AxiosError, AxiosHeaders, type AxiosAdapter, type AxiosResponse } from 'axios';
import { createJSONStorage } from 'zustand/middleware';
import { apiClient, installDevApiAdapter } from '@/services/api/client';
import { useAuthStore } from '@/stores';
import { buildQuotaHistoryFixture } from './quotaHistory';
import { installHubPagesFixture } from '@/features/connect/__fixtures__/hubPagesFixture';
import { createResetCreditsFixture } from './resetCredits';
import { enrichAccountsFixture } from '@/features/authFiles/__fixtures__/accountsFixture';
import { respondModelRulesFixture } from '@/features/authFiles/modelRules/__fixtures__/modelRulesFixture';
import { respondProvidersFixture } from '@/features/providers/__fixtures__/providersFixture';
import { respondConfigFixture } from '@/features/config/__fixtures__/configFixture';

export const QUOTA_HISTORY_FIXTURE = 'quota-history';

export function isFixtureRequested(search = window.location.search): boolean {
  return new URLSearchParams(search).get('fixture') === QUOTA_HISTORY_FIXTURE;
}

const FIXTURE_BASE = 'http://fixture.invalid';

const parseBody = (data: unknown): Record<string, unknown> => {
  if (typeof data !== 'string') return (data as Record<string, unknown>) ?? {};
  try {
    return JSON.parse(data) as Record<string, unknown>;
  } catch {
    return {};
  }
};
export function installQuotaHistoryFixture(): void {
  if (!import.meta.env.DEV) return;
  const fixture = buildQuotaHistoryFixture();
  enrichAccountsFixture(fixture.credentials.files);
  const historyOff = new URLSearchParams(window.location.search).get('history') === 'off';
  const resetCredits = createResetCreditsFixture(Date.now());

  const adapter: AxiosAdapter = async (config) => {
    const url = `${config.baseURL ?? ''}${config.url ?? ''}`;
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const method = (config.method ?? 'get').toLowerCase();
    const respond = (data: unknown, status = 200): AxiosResponse => ({
      data,
      status,
      statusText: status === 200 ? 'OK' : 'Not Found',
      headers: new AxiosHeaders(),
      config,
    });

    await new Promise((resolve) => setTimeout(resolve, 120));

    if (!historyOff && method === 'get' && /\/quota-history$/.test(path)) {
      const since = Number(config.params?.since ?? 0);
      const until = Number(config.params?.until ?? Number.MAX_SAFE_INTEGER);
      return respond({
        ...fixture.payload,
        samples: fixture.payload.samples.filter((s) => {
          const t = Number(s.t);
          return t >= since && t <= until;
        }),
      });
    }
    if (!historyOff && method === 'post' && /\/quota-history\/refresh$/.test(path)) {
      return respond({ status: 'ok' });
    }
    if (method === 'get' && /\/v8\/management\/credentials$/.test(path)) {
      return respond(fixture.credentials);
    }
    const providers = respondProvidersFixture(method, path, config.data);
    if (providers !== undefined) return respond(providers);
    const configYaml = respondConfigFixture(method, path);
    if (configYaml !== undefined) return respond(configYaml);
    if (method === 'get' && /\/v8\/management\/config$/.test(path)) {
      return respond({});
    }
    if (method === 'post' && /\/requests\/api-call$/.test(path)) {
      const call = parseBody(config.data);
      const upstream = resetCredits.handle(call);
      if (upstream) return respond(upstream);
    }
    if (method === 'post' && /\/routing\/cooldown\/reset$/.test(path)) {
      const call = parseBody(config.data);
      return respond({ status: 'ok', auth_index: String(call.auth_index ?? '') });
    }
    const modelRules = respondModelRulesFixture(method, path);
    if (modelRules !== undefined) return respond(modelRules);
    const response = respond({ error: 'not available in fixture mode' }, 404);
    throw new AxiosError('Not Found (fixture)', AxiosError.ERR_BAD_REQUEST, config, null, response);
  };

  installDevApiAdapter(adapter);
  installHubPagesFixture(adapter);
  // Never let the fake session overwrite a developer's saved login.
  useAuthStore.persist.setOptions({
    storage: createJSONStorage(() => ({
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    })),
  });
  apiClient.setConfig({ apiBase: FIXTURE_BASE, managementKey: 'fixture' });
  useAuthStore.setState({
    isAuthenticated: true,
    apiBase: FIXTURE_BASE,
    managementKey: 'fixture',
    rememberPassword: false,
    connectionStatus: 'connected',
    serverVersion: 'fixture',
  });
}
