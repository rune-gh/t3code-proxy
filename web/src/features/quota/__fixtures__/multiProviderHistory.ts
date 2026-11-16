/**
 * Fixture: quota history for providers beyond Claude and Codex, in the same
 * `GET /v8/management/quota-history` shape the hub uses for them (snake_case,
 * `accounts[]` with `provider`, `plan` and `weight`, `samples[].windows` keyed
 * by window name). Two xAI and three Antigravity accounts, one of them on a key
 * the panel has no name for (`image_gen`). Deterministic for a given `now`.
 *
 * Used by tests/quotaPoolModel.test.ts and merged into the DEV fixture session.
 * Never imported by production code.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const INTERVAL_MS = 10 * MINUTE;

interface WindowSpec {
  key: string;
  periodHours: number;
  /** Hours from now until this window resets. */
  resetInHours: number;
  /** Used % per hour while the account is busy. */
  burnPerHour: number;
}

interface AccountSpec {
  authIndex: string;
  provider: 'xai' | 'antigravity';
  label: string;
  plan: string;
  weight: number;
  fileName: string;
  windows: WindowSpec[];
}

export const MULTI_PROVIDER_ACCOUNTS: AccountSpec[] = [
  {
    authIndex: 'g1',
    provider: 'xai',
    label: 'alan@example.com',
    plan: 'supergrok',
    weight: 1,
    fileName: 'xai-alan.json',
    windows: [
      { key: 'seven_day', periodHours: 168, resetInHours: 30, burnPerHour: 0.9 },
      { key: 'monthly', periodHours: 720, resetInHours: 300, burnPerHour: 0.2 },
    ],
  },
  {
    authIndex: 'g2',
    provider: 'xai',
    label: 'rosalind@example.com',
    plan: 'supergrok_heavy',
    weight: 8,
    fileName: 'xai-rosalind.json',
    windows: [
      { key: 'seven_day', periodHours: 168, resetInHours: 110, burnPerHour: 0.3 },
      { key: 'monthly', periodHours: 720, resetInHours: 520, burnPerHour: 0.06 },
    ],
  },
  {
    authIndex: 'a1',
    provider: 'antigravity',
    label: 'turing@example.com',
    plan: 'pro',
    weight: 1,
    fileName: 'antigravity-turing.json',
    windows: [
      { key: 'seven_day_gemini_pro', periodHours: 168, resetInHours: 60, burnPerHour: 0.5 },
      { key: 'five_hour_gemini_pro', periodHours: 5, resetInHours: 2, burnPerHour: 9 },
      { key: 'five_hour_claude', periodHours: 5, resetInHours: 3.5, burnPerHour: 6 },
      { key: 'image_gen', periodHours: 24, resetInHours: 9, burnPerHour: 2 },
    ],
  },
  {
    authIndex: 'a2',
    provider: 'antigravity',
    label: 'hopper@example.com',
    plan: 'ultra',
    weight: 4,
    fileName: 'antigravity-hopper.json',
    windows: [
      { key: 'seven_day_gemini_pro', periodHours: 168, resetInHours: 130, burnPerHour: 0.2 },
      { key: 'five_hour_gemini_pro', periodHours: 5, resetInHours: 4, burnPerHour: 3 },
      { key: 'five_hour_claude', periodHours: 5, resetInHours: 1, burnPerHour: 2 },
    ],
  },
  {
    authIndex: 'a3',
    provider: 'antigravity',
    label: 'lamarr@example.com',
    plan: 'pro',
    weight: 1,
    fileName: 'antigravity-lamarr.json',
    windows: [
      { key: 'seven_day_gemini_pro', periodHours: 168, resetInHours: 150, burnPerHour: 0.35 },
      { key: 'five_hour_gemini_pro', periodHours: 5, resetInHours: 0.5, burnPerHour: 5 },
    ],
  },
];

/** Busy during local working hours, quiet at night. */
const busy = (t: number) => {
  const hour = new Date(t).getHours();
  return hour >= 8 && hour <= 23 ? 1 : 0.25;
};

const round = (value: number) => Math.round(value * 10) / 10;

export interface MultiProviderHistoryFixture {
  accounts: Array<Record<string, unknown>>;
  samples: Array<Record<string, unknown>>;
  files: Array<Record<string, unknown>>;
}

export function buildMultiProviderHistory(
  nowInput = Date.now(),
  historyMs = 4 * DAY
): MultiProviderHistoryFixture {
  const now = Math.floor(nowInput / INTERVAL_MS) * INTERVAL_MS;
  const start = now - historyMs;

  const state = MULTI_PROVIDER_ACCOUNTS.map((account) => ({
    account,
    windows: account.windows.map((window) => {
      const periodMs = window.periodHours * HOUR;
      let resetsAt = now + window.resetInHours * HOUR;
      while (resetsAt - periodMs > start) resetsAt -= periodMs;
      // Partway through the window at the start of the record.
      const elapsed = (start - (resetsAt - periodMs)) / HOUR;
      return { spec: window, resetsAt, used: Math.min(100, elapsed * window.burnPerHour * 0.6) };
    }),
  }));

  const samples: Array<Record<string, unknown>> = [];
  for (let t = start; t <= now; t += INTERVAL_MS) {
    state.forEach(({ account, windows }) => {
      const out: Record<string, unknown> = {};
      windows.forEach((window) => {
        if (window.resetsAt <= t) {
          window.used = 0;
          window.resetsAt += window.spec.periodHours * HOUR;
        }
        window.used = Math.min(
          100,
          window.used + (window.spec.burnPerHour * busy(t) * INTERVAL_MS) / HOUR
        );
        out[window.spec.key] = {
          used_percent: round(window.used),
          resets_at: window.resetsAt,
          period_hours: window.spec.periodHours,
        };
      });
      samples.push({ t, auth_index: account.authIndex, windows: out, error: '' });
    });
  }

  return {
    accounts: MULTI_PROVIDER_ACCOUNTS.map((account) => ({
      auth_index: account.authIndex,
      provider: account.provider,
      label: account.label,
      plan: account.plan,
      weight: account.weight,
      disabled: false,
    })),
    samples,
    files: MULTI_PROVIDER_ACCOUNTS.map((account) => ({
      name: account.fileName,
      type: account.provider,
      provider: account.provider,
      email: account.label,
      auth_index: account.authIndex,
      status: 'active',
    })),
  };
}

/** `GET /v8/management/routing/plan-weights` as the fixture hub answers it. */
export const PLAN_WEIGHTS_FIXTURE = {
  defaults: {
    claude: { pro: 1, max_5x: 5, max_20x: 20 },
    codex: { plus: 1, team: 1, prolite: 5, pro: 10 },
    xai: { supergrok: 1, supergrok_heavy: 8 },
    antigravity: { pro: 1, ultra: 4 },
  },
  configured: {} as Record<string, Record<string, number>>,
};
