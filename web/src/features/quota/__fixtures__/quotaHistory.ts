/**
 * DEV fixture: about four days of 10-minute quota-history samples for six
 * Claude and three Codex accounts (one on the Codex Pro plan), shaped like the
 * hub's `GET /v0/management/quota-history` payload. Deterministic for a given
 * `now`, and drained soonest-reset-first like the hub routes traffic, so the
 * recorded line shows real reset steps. Never imported by production code.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK_HOURS = 168;
const INTERVAL_MS = 10 * MINUTE;
const HISTORY_MS = 4 * DAY;

interface FixtureAccount {
  authIndex: string;
  provider: 'claude' | 'codex';
  label: string;
  plan: string;
  fileName: string;
  /** Hours from now until the weekly window resets. */
  resetInHours: number;
  /** Weekly used % at the start of the record. */
  usedAtStart: number;
  hasFable: boolean;
}

const ACCOUNTS: FixtureAccount[] = [
  ['c1', 'claude', 'ada@example.com', 'max_20x', 16, 34, true],
  ['c2', 'claude', 'grace@example.com', 'max_20x', 40, 22, true],
  ['c3', 'claude', 'linus@example.com', 'max_20x', 66, 18, true],
  ['c4', 'claude', 'margaret@example.com', 'max_5x', 92, 12, true],
  ['c5', 'claude', 'ken@example.com', 'max_5x', 118, 8, false],
  ['c6', 'claude', 'barbara@example.com', 'max_20x', 146, 4, false],
  ['x1', 'codex', 'dennis@example.com', 'plus', 52, 30, false],
  ['x2', 'codex', 'frances@example.com', 'plus', 98, 16, false],
  ['x3', 'codex', 'edsger@example.com', 'pro', 140, 6, false],
].map(([authIndex, provider, label, plan, resetInHours, usedAtStart, hasFable]) => ({
  authIndex: authIndex as string,
  provider: provider as 'claude' | 'codex',
  label: label as string,
  plan: plan as string,
  fileName: `${provider}-${String(label).split('@')[0]}.json`,
  resetInHours: resetInHours as number,
  usedAtStart: usedAtStart as number,
  hasFable: hasFable as boolean,
}));

/** Small seeded PRNG so screenshots are stable. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pooled %/h demand: busier during local working hours. */
function demandPerHour(provider: 'claude' | 'codex', t: number, random: () => number): number {
  const hour = new Date(t).getHours();
  const active = hour >= 8 && hour <= 23;
  const base = provider === 'claude' ? (active ? 3.4 : 0.9) : active ? 1.9 : 0.4;
  return base * (0.55 + random() * 0.9);
}

interface AccountState {
  account: FixtureAccount;
  used: number;
  nextReset: number;
  fiveUsed: number;
  fiveReset: number;
}

export interface QuotaHistoryFixture {
  /** Raw backend payload (snake_case), as the hub would send it. */
  payload: {
    enabled: true;
    interval_seconds: number;
    now: number;
    accounts: Array<Record<string, unknown>>;
    samples: Array<Record<string, unknown>>;
  };
  /** `GET /credentials` payload covering the same accounts plus a few stock providers. */
  credentials: { files: Array<Record<string, unknown>> };
}

export function buildQuotaHistoryFixture(nowInput = Date.now()): QuotaHistoryFixture {
  const now = Math.floor(nowInput / INTERVAL_MS) * INTERVAL_MS;
  const start = now - HISTORY_MS;
  const random = mulberry32(20261114);

  const states: AccountState[] = ACCOUNTS.map((account, index) => {
    let nextReset = now + account.resetInHours * HOUR;
    while (nextReset - WEEK_HOURS * HOUR > start) nextReset -= WEEK_HOURS * HOUR;
    return {
      account,
      used: account.usedAtStart,
      nextReset,
      fiveUsed: 0,
      fiveReset: start + ((index * 47) % 300) * MINUTE,
    };
  });

  const samples: Array<Record<string, unknown>> = [];
  for (let t = start; t <= now; t += INTERVAL_MS) {
    // Refill windows whose reset has passed.
    states.forEach((state) => {
      if (state.nextReset <= t) {
        state.used = 0;
        state.nextReset += WEEK_HOURS * HOUR;
      }
      if (state.fiveReset <= t) {
        state.fiveUsed = 0;
        state.fiveReset += 5 * HOUR;
      }
    });

    // Spend this interval's demand soonest-reset-first, per provider.
    (['claude', 'codex'] as const).forEach((provider) => {
      let demand = (demandPerHour(provider, t, random) * INTERVAL_MS) / HOUR;
      states
        .filter((state) => state.account.provider === provider)
        .sort((a, b) => a.nextReset - b.nextReset)
        .forEach((state) => {
          if (demand <= 0) return;
          const weight = state.account.plan === 'pro' ? 2.5 : 1;
          const available = (100 - state.used) * weight;
          const take = Math.min(available, demand);
          state.used += take / weight;
          state.fiveUsed = Math.min(100, state.fiveUsed + (take / weight) * 9);
          demand -= take;
        });
    });

    states.forEach((state, index) => {
      const { account } = state;
      // An occasional failed poll, as the hub records them.
      if ((t / INTERVAL_MS + index * 7) % 61 === 0) {
        samples.push({ t, auth_index: account.authIndex, windows: {}, error: 'upstream 529' });
        return;
      }
      const weekly = {
        used_percent: round(account.hasFable ? state.used * 0.62 : state.used),
        resets_at: state.nextReset,
        period_hours: WEEK_HOURS,
      };
      const windows: Record<string, unknown> = {
        five_hour: {
          used_percent: round(state.fiveUsed),
          resets_at: state.fiveReset,
          period_hours: 5,
        },
        seven_day: weekly,
      };
      if (account.hasFable) {
        windows.seven_day_fable = {
          used_percent: round(state.used),
          resets_at: state.nextReset,
          period_hours: WEEK_HOURS,
        };
      }
      samples.push({ t, auth_index: account.authIndex, windows, error: '' });
    });
  }

  const accounts = ACCOUNTS.map((account) => ({
    auth_index: account.authIndex,
    provider: account.provider,
    label: account.label,
    plan: account.plan,
    disabled: false,
  }));

  const files: Array<Record<string, unknown>> = ACCOUNTS.map((account) => ({
    name: account.fileName,
    type: account.provider,
    provider: account.provider,
    email: account.label,
    auth_index: account.authIndex,
    status: 'active',
  }));
  files.push(
    {
      name: 'xai-alan.json',
      type: 'xai',
      provider: 'xai',
      email: 'alan@example.com',
      auth_index: 'g1',
    },
    {
      name: 'kimi-hedy.json',
      type: 'kimi',
      provider: 'kimi',
      email: 'hedy@example.com',
      auth_index: 'k1',
    },
    {
      name: 'meta-joan.json',
      type: 'meta',
      provider: 'meta',
      email: 'joan@example.com',
      auth_index: 'm1',
    }
  );

  return {
    payload: { enabled: true, interval_seconds: 600, now, accounts, samples },
    credentials: { files },
  };
}

const round = (value: number) => Math.round(value * 10) / 10;
