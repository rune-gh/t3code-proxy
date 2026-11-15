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

export const QUOTA_HISTORY_FIXTURE = 'quota-history';

export function isFixtureRequested(search = window.location.search): boolean {
  return new URLSearchParams(search).get('fixture') === QUOTA_HISTORY_FIXTURE;
}

const FIXTURE_BASE = 'http://fixture.invalid';

export function installQuotaHistoryFixture(): void {
  if (!import.meta.env.DEV) return;
  const fixture = buildQuotaHistoryFixture();
  const historyOff = new URLSearchParams(window.location.search).get('history') === 'off';

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
    if (method === 'get' && /\/v8\/management\/config$/.test(path)) {
      return respond({});
    }
    const response = respond({ error: 'not available in fixture mode' }, 404);
    throw new AxiosError('Not Found (fixture)', AxiosError.ERR_BAD_REQUEST, config, null, response);
  };

  installDevApiAdapter(adapter);
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
