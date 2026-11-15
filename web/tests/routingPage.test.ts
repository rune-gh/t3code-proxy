import { afterAll, afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '../src/i18n/index';
import { authFilesApi } from '../src/services/api/authFiles';
import { apiClient } from '../src/services/api/client';
import { buildRoutingBoard, routingApi } from '../src/services/api/routing';
import {
  buildRoutingPlan,
  draftFromBoard,
  moveMember,
  resolveRoute,
} from '../src/features/routing/logic';
import { TierLadder } from '../src/features/routing/components/TierLadder';
import { StrategySection } from '../src/features/routing/components/RoutingSettings';
import { ResetOrderPanel } from '../src/features/routing/components/ResetOrderPanel';
import type { AuthFileItem } from '../src/types/authFile';

test('language changes do not trigger board reloads or reset the draft', () => {
  const source = readFileSync('src/features/routing/RoutingPage.tsx', 'utf8');
  const load = source.slice(
    source.indexOf('  const load = useCallback'),
    source.indexOf('  useEffect(() => {')
  );
  expect(load).toContain('[connected, fetchConfig, loadModels]');
  expect(load).not.toContain("t('common.unknown_error')");
  expect(source).toContain("message: error || t('common.unknown_error')");
});

const RAW = {
  routing: { strategy: 'round-robin' },
  'api-keys': {
    codex: [{ name: 'opencode', priority: 20, keys: [{ 'api-key': 'sk-codex-aaaa' }] }],
    claude: [
      { name: 'claude-off', keys: [{ 'api-key': 'sk-claude-bbbb', 'excluded-models': ['*'] }] },
    ],
  },
};
const FILES: AuthFileItem[] = [
  { name: 'main.json', type: 'codex', email: 'main@example.com', priority: 0 },
  { name: 'runtime', type: 'gemini', runtimeOnly: true },
];

/** One card's markup: from its key to the next card. */
const cardMarkup = (html: string, key: string): string => {
  const rest = html.slice(html.indexOf(`data-member-key="${key}"`));
  const next = rest.indexOf('data-member-key=', 1);
  return next < 0 ? rest : rest.slice(0, next);
};

const restores: Array<{ mockRestore: () => void }> = [];
afterEach(() => {
  restores.splice(0).forEach((spy) => spy.mockRestore());
});

// i18n is a process-wide singleton shared with other test files.
const initialLanguage = i18n.language;
afterAll(async () => {
  await i18n.changeLanguage(initialLanguage);
});

describe('routing board rendering', () => {
  test('renders tiers on a rail with drop gaps, states and accessible controls', async () => {
    await i18n.changeLanguage('en');
    const board = buildRoutingBoard(RAW, FILES);
    const draft = draftFromBoard(board);
    const html = renderToStaticMarkup(
      createElement(TierLadder, {
        members: new Map(board.members.map((member) => [member.key, member])),
        draft,
        preview: resolveRoute(board, draft, { channels: {}, credentials: {} }, null, 0),
        priorities: {
          'key:codex:0:0': 20,
          'key:claude:0:0': 0,
          'cred:main.json': 0,
          'cred:runtime': 0,
        },
        model: null,
        nowMs: 0,
        theme: 'light',
        entryControl: null,
        onMove: () => {},
        onStep: () => {},
        onEditWeights: () => {},
      })
    );
    expect(html).toContain('Request in');
    expect(html).toContain('Preferred');
    expect(html).toContain('Fallback 1');
    expect(html).toContain('Serving requests');
    expect(html).toContain('Falls to the next tier when the whole tier is unavailable');
    expect(html).toContain('main@example.com');
    expect(html).toContain('aria-haspopup="menu"');
    // Runtime-only credentials show a lock instead of a drag handle and are not draggable.
    expect(html).toMatch(/draggable="false"[^>]*data-member-key="cred:runtime"/);
    expect(html).not.toContain('sk-codex-aaaa');
  });

  test('API keys show their configured disabled state; only enabled ones note missing cooldowns', async () => {
    await i18n.changeLanguage('en');
    const board = buildRoutingBoard(RAW, FILES);
    const draft = draftFromBoard(board);
    const html = renderToStaticMarkup(
      createElement(TierLadder, {
        members: new Map(board.members.map((member) => [member.key, member])),
        draft,
        preview: resolveRoute(board, draft, { channels: {}, credentials: {} }, null, 0),
        priorities: {},
        model: null,
        nowMs: 0,
        theme: 'light',
        entryControl: null,
        onMove: () => {},
        onStep: () => {},
        onEditWeights: () => {},
      })
    );
    // CSS Modules are not compiled under bun:test; the route state drives the dimmed style.
    const cardState = (key: string) =>
      html.match(new RegExp(`data-member-key="${key}" data-state="([^"]*)"`))?.[1] ?? '';

    // Disabled in configuration: reliable, so marked and dimmed, with no cooldown note.
    const disabledKey = cardMarkup(html, 'key:claude:0:0');
    expect(disabledKey).toContain('Disabled');
    expect(disabledKey).not.toContain('No cooldown info');
    expect(cardState('key:claude:0:0')).toBe('disabled');

    // Enabled API key: normal; the missing-runtime-state note lives in its tooltip, not inline.
    const enabledKey = cardMarkup(html, 'key:codex:0:0');
    const cardTitle = (key: string) =>
      html.match(new RegExp(`title="([^"]*)" data-member-key="${key}"`))?.[1] ?? '';
    expect(cardTitle('key:codex:0:0')).toContain('No cooldown info');
    expect(enabledKey).not.toContain('No cooldown info');
    expect(cardTitle('key:claude:0:0')).not.toContain('No cooldown info');
    expect(enabledKey).not.toContain('Disabled');
    expect(cardState('key:codex:0:0')).toBe('serving');

    // Credentials report real runtime state and never carry the note.
    expect(cardMarkup(html, 'cred:main.json')).not.toContain('No cooldown info');
    const card = readFileSync('src/features/routing/components/MemberCard.tsx', 'utf8');
    expect(card).toContain("const muted = state === 'disabled' || state === 'ineligible';");
  });

  test('the strategy picker is a native radio group with soonest reset first recommended', async () => {
    await i18n.changeLanguage('en');
    const settings = {
      strategy: 'weighted-round-robin' as const,
      sessionAffinity: false,
      sessionAffinityTtl: '',
      requestRetry: 3,
      maxRetryCredentials: 0,
      maxRetryInterval: 0,
    };
    const html = renderToStaticMarkup(
      createElement(StrategySection, {
        settings,
        onChange: () => {},
        soonestResetDetails: createElement('p', null, 'srf-details'),
      })
    );
    expect(html).toContain('role="radiogroup"');
    expect(html).toMatch(/type="radio"[^>]*checked=""[^>]*value="weighted-round-robin"/);
    expect(html).toContain('value="soonest-reset-first"');
    expect(html).toContain('Recommended');
    expect(html).toContain('Requests are split by each account&#x27;s or key&#x27;s weight.');
    // The "how it decides" details only show while soonest reset first is selected.
    expect(html).not.toContain('srf-details');
    const selected = renderToStaticMarkup(
      createElement(StrategySection, {
        settings: { ...settings, strategy: 'soonest-reset-first' },
        onChange: () => {},
        soonestResetDetails: createElement('p', null, 'srf-details'),
      })
    );
    expect(selected).toContain('srf-details');
  });

  test('the reset order panel explains the rules and lists the current order', async () => {
    await i18n.changeLanguage('en');
    const html = renderToStaticMarkup(
      createElement(ResetOrderPanel, {
        data: {
          status: 'ready',
          now: 0,
          groups: [
            {
              provider: 'claude',
              entries: [
                {
                  authIndex: 'a',
                  label: 'new@example.com',
                  plan: null,
                  state: 'probe',
                  rank: 1,
                  resetsAt: null,
                  usedPercent: null,
                },
                {
                  authIndex: 'b',
                  label: 'soon@example.com',
                  plan: 'max',
                  state: 'ranked',
                  rank: 2,
                  resetsAt: 3 * 3_600_000,
                  usedPercent: 40,
                },
              ],
            },
          ],
        },
        onRetry: () => {},
      })
    );
    expect(html).toContain('How it decides');
    expect(html).toContain('at most once an hour');
    expect(html).toContain('Not observed yet');
    expect(html).toContain('in 3h');
    expect(html).toContain('model-specific weekly cap');
    expect(html.indexOf('new@example.com')).toBeLessThan(html.indexOf('soon@example.com'));
  });

  test('styles respect reduced motion and the route is registered behind navigation', () => {
    const page = readFileSync('src/features/routing/RoutingPage.module.scss', 'utf8');
    const card = readFileSync('src/features/routing/components/MemberCard.module.scss', 'utf8');
    const bar = readFileSync('src/features/routing/components/RoutingSaveBar.module.scss', 'utf8');
    expect(page).toContain('@media (prefers-reduced-motion: reduce)');
    expect(card).toContain('@media (prefers-reduced-motion: reduce)');
    expect(bar).toContain('@media (prefers-reduced-motion: reduce)');
    expect(readFileSync('src/router/MainRoutes.tsx', 'utf8')).toContain(
      "{ path: '/routing', element: <RoutingPage /> }"
    );
    expect(readFileSync('src/components/layout/navigation.tsx', 'utf8')).toContain(
      "link('/routing', 'routing'"
    );
  });
});

describe('routing save bar', () => {
  test('is portalled and only shows for the current page layer', () => {
    const bar = readFileSync('src/features/routing/components/RoutingSaveBar.tsx', 'utf8');
    const page = readFileSync('src/features/routing/RoutingPage.tsx', 'utf8');
    // Portalled: sticky/fixed inside the page-transition layer does not track the viewport.
    expect(bar).toContain('createPortal(');
    expect(page).toContain('layoutRef={layoutRef}');
    // A page sliding out must not leave its bar behind.
    expect(page).toContain('visible={isCurrentLayer && dirty}');
  });
});

describe('applying a routing plan', () => {
  const planFor = () => {
    const board = buildRoutingBoard(RAW, FILES);
    const draft = draftFromBoard(board);
    draft.tiers = moveMember(draft.tiers, 'cred:main.json', { kind: 'gap', index: 0 });
    // Joining the runtime-only credential's tier takes its fixed priority.
    draft.tiers = moveMember(draft.tiers, 'key:codex:0:0', { kind: 'tier', tierId: 'p0' });
    draft.settings = { ...draft.settings, sessionAffinity: true };
    return { board, plan: buildRoutingPlan(board, draft) };
  };

  test('writes credentials first, then the configuration once against a fresh read', async () => {
    const calls: string[] = [];
    const patchFields = mock(async (name: string) => {
      calls.push(`fields:${name}`);
      return {};
    });
    restores.push(spyOn(authFilesApi, 'patchFields').mockImplementation(patchFields));
    restores.push(
      spyOn(apiClient, 'get').mockImplementation((async (url: string) => {
        calls.push(`get:${url}`);
        return RAW;
      }) as typeof apiClient.get)
    );
    const patch = mock(async (url: string, body: unknown) => {
      calls.push(`patch:${url}`);
      return body;
    });
    restores.push(spyOn(apiClient, 'patch').mockImplementation(patch as typeof apiClient.patch));

    const { board, plan } = planFor();
    const result = await routingApi.applyPlan(board, plan);

    expect(calls).toEqual(['fields:main.json', 'get:/config', 'patch:/config']);
    expect(result.failed).toBeNull();
    expect(result.applied).toEqual(['cred:main.json', 'key:codex:0:0', 'settings']);
    const body = patch.mock.calls[0][1] as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(body.routing).toEqual({ 'session-affinity': true });
    expect(plan.priorities).toEqual({ 'cred:main.json': 10, 'key:codex:0:0': 0 });
    expect(body['api-keys'].codex[0].keys[0].priority).toBe(0);
  });

  test('stops at the first failed credential and reports what was not attempted', async () => {
    restores.push(
      spyOn(authFilesApi, 'patchFields').mockImplementation(async () => {
        throw new Error('boom');
      })
    );
    const patch = spyOn(apiClient, 'patch');
    restores.push(patch);

    const { board, plan } = planFor();
    const result = await routingApi.applyPlan(board, plan);

    expect(result.failed?.key).toBe('cred:main.json');
    expect(result.applied).toEqual([]);
    expect(result.notAttempted).toEqual(['key:codex:0:0', 'settings']);
    expect(patch).not.toHaveBeenCalled();
  });
});
