/**
 * Fixture: the pool on the owner's hub, shaped like
 * `GET /v8/management/quota-history`. Claude Pro (weekly empty) + Max 5x
 * (38% left), Codex Plus (empty) + prolite (80% left, weighs 5× Plus), one
 * Antigravity account with its four group windows, one xAI account with a
 * single unlabelled `weekly` window, and one Mistral EDU API key that exists
 * only in the history (no credential file): two calendar-month windows with a
 * $15 budget each. Deterministic for a given `now`.
 *
 * DEV session: `/?fixture=quota-history&pool=owner#/quota`. Never imported by
 * production code.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const INTERVAL_MS = 10 * MINUTE;

interface WindowSpec {
  key: string;
  label?: string;
  periodHours: number;
  /** Hours from now until this window resets. */
  resetInHours: number;
  /** Used % now; earlier windows follow the same pace. */
  usedNow: number;
  /** Renews on the UTC calendar month; `periodHours` and `resetInHours` are derived. */
  monthly?: boolean;
  /** Spending budget the window allows. */
  budget?: number;
  currency?: string;
}

interface AccountSpec {
  authIndex: string;
  provider: string;
  label: string;
  plan: string;
  windows: WindowSpec[];
  /** Recorded by the hub but not a credential file (API-key upstreams). */
  historyOnly?: boolean;
}

export const OWNER_POOL_ACCOUNTS: AccountSpec[] = [
  {
    authIndex: 'o-c1',
    provider: 'claude',
    label: 'pro@example.com',
    plan: 'pro',
    windows: [
      { key: 'five_hour', periodHours: 5, resetInHours: 2.5, usedNow: 100 },
      { key: 'seven_day', periodHours: 168, resetInHours: 41, usedNow: 100 },
    ],
  },
  {
    authIndex: 'o-c2',
    provider: 'claude',
    label: 'max@example.com',
    plan: 'max_5x',
    windows: [
      { key: 'five_hour', periodHours: 5, resetInHours: 3.2, usedNow: 34 },
      { key: 'seven_day', periodHours: 168, resetInHours: 94, usedNow: 62 },
    ],
  },
  {
    authIndex: 'o-x1',
    provider: 'codex',
    label: 'plus@example.com',
    plan: 'plus',
    windows: [
      { key: 'five_hour', periodHours: 5, resetInHours: 1.4, usedNow: 12 },
      { key: 'seven_day', periodHours: 168, resetInHours: 55, usedNow: 100 },
    ],
  },
  {
    authIndex: 'o-x2',
    provider: 'codex',
    label: 'prolite@example.com',
    plan: 'prolite',
    windows: [
      { key: 'five_hour', periodHours: 5, resetInHours: 4.1, usedNow: 9 },
      { key: 'seven_day', periodHours: 168, resetInHours: 122, usedNow: 20 },
    ],
  },
  {
    authIndex: 'o-a1',
    provider: 'antigravity',
    label: 'gemini@example.com',
    plan: 'pro',
    windows: [
      {
        key: 'group_gemini_models_gemini_5h',
        label: 'Gemini Models 5h',
        periodHours: 5,
        resetInHours: 3.6,
        usedNow: 40,
      },
      {
        key: 'group_gemini_models_gemini_weekly',
        label: 'Gemini Models weekly',
        periodHours: 168,
        resetInHours: 101,
        usedNow: 27,
      },
      {
        key: 'group_claude_and_gpt_models_3p_5h',
        label: 'Claude and GPT models 5h',
        periodHours: 5,
        resetInHours: 1.1,
        usedNow: 80,
      },
      {
        key: 'group_claude_and_gpt_models_3p_weekly',
        label: 'Claude and GPT models weekly',
        periodHours: 168,
        resetInHours: 63,
        usedNow: 55,
      },
    ],
  },
  {
    authIndex: 'o-g1',
    provider: 'xai',
    label: 'grok@example.com',
    plan: 'supergrok',
    windows: [{ key: 'weekly', periodHours: 168, resetInHours: 76, usedNow: 35 }],
  },
  {
    authIndex: 'o-m1',
    provider: 'mistral',
    label: 'Mistral EDU',
    plan: 'EDU',
    historyOnly: true,
    windows: [
      {
        key: 'api_monthly',
        label: 'API usage',
        periodHours: 0,
        resetInHours: 0,
        usedNow: 2.6,
        monthly: true,
        budget: 15,
        currency: 'USD',
      },
      {
        key: 'vibe_monthly',
        label: 'Vibe Code',
        periodHours: 0,
        resetInHours: 0,
        usedNow: 41,
        monthly: true,
        budget: 15,
        currency: 'USD',
      },
    ],
  },
];

/** A monthly spec's period and reset for `now`: the current UTC calendar month. */
const resolveMonthly = (window: WindowSpec, now: number): WindowSpec => {
  if (!window.monthly) return window;
  const date = new Date(now);
  const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
  const end = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
  return { ...window, periodHours: (end - start) / HOUR, resetInHours: (end - now) / HOUR };
};

const round = (value: number) => Math.round(value * 10) / 10;

export interface OwnerPoolFixture {
  accounts: Array<Record<string, unknown>>;
  samples: Array<Record<string, unknown>>;
  files: Array<Record<string, unknown>>;
}

export function buildOwnerPoolHistory(
  nowInput = Date.now(),
  historyMs = 4 * DAY
): OwnerPoolFixture {
  const now = Math.floor(nowInput / INTERVAL_MS) * INTERVAL_MS;
  const start = now - historyMs;

  /** Used % at `t`: windows fill at the pace that reaches `usedNow` by now, capped at 100. */
  const usedAt = (window: WindowSpec, t: number) => {
    const periodMs = window.periodHours * HOUR;
    const currentStart = now + window.resetInHours * HOUR - periodMs;
    const pace = window.usedNow / Math.max(MINUTE, now - currentStart);
    const windowStart = currentStart - Math.ceil((currentStart - t) / periodMs) * periodMs;
    // An empty account ran dry partway through, so its line shows the drop.
    const boost = window.usedNow >= 100 ? 1.6 : 1;
    return {
      used: Math.min(100, (t - windowStart) * pace * boost),
      resetsAt: windowStart + periodMs,
    };
  };

  const samples: Array<Record<string, unknown>> = [];
  for (let t = start; t <= now; t += INTERVAL_MS) {
    OWNER_POOL_ACCOUNTS.forEach((account) => {
      const windows: Record<string, unknown> = {};
      account.windows.forEach((spec) => {
        const window = resolveMonthly(spec, now);
        const { used, resetsAt } = usedAt(window, t);
        windows[window.key] = {
          used_percent: round(t === now ? window.usedNow : used),
          resets_at: resetsAt,
          period_hours: window.periodHours,
          ...(window.label ? { label: window.label } : {}),
          ...(window.budget ? { budget: window.budget, currency: window.currency } : {}),
        };
      });
      samples.push({ t, auth_index: account.authIndex, windows, error: '' });
    });
  }

  return {
    accounts: OWNER_POOL_ACCOUNTS.map((account) => ({
      auth_index: account.authIndex,
      provider: account.provider,
      label: account.label,
      plan: account.plan,
      disabled: false,
    })),
    samples,
    files: [
      ...OWNER_POOL_ACCOUNTS.filter((account) => !account.historyOnly).map((account) => ({
        name: `${account.provider}-${account.label.split('@')[0]}.json`,
        type: account.provider,
        provider: account.provider,
        email: account.label,
        auth_index: account.authIndex,
        status: 'active',
      })),
      // Not recorded and not readable in the fixture: lands in "Other accounts" once read.
      {
        name: 'kimi-hedy.json',
        type: 'kimi',
        provider: 'kimi',
        email: 'hedy@example.com',
        auth_index: 'o-k1',
        status: 'active',
      },
    ],
  };
}
