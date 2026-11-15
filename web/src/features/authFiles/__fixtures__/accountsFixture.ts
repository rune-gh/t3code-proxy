/**
 * DEV-only enrichment of the fixture session's `GET /credentials` payload so the
 * Accounts page shows every row state: traffic, plans, a cooldown, a disabled
 * account and one with an upstream error. Only imported by the quota dev fixture.
 */

type FixtureFile = Record<string, unknown>;

/** Small seeded PRNG so screenshots are stable. */
const seeded = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};

const buildBuckets = (random: () => number, volume: number, failureRate: number) =>
  Array.from({ length: 20 }, (_, index) => {
    const ramp = 0.4 + (index / 19) * 0.6;
    const total = Math.round(volume * ramp * (0.5 + random()));
    const failed = random() < failureRate ? Math.max(1, Math.round(total * 0.2)) : 0;
    return { success: Math.max(0, total - failed), failed };
  });

const PROFILES: Record<string, Partial<FixtureFile> & { volume?: number; failureRate?: number }> =
  {
    c1: { plan_type: 'max_20x', volume: 14, failureRate: 0.05, priority: 10 },
    c2: { plan_type: 'max_20x', volume: 9, failureRate: 0.1 },
    c3: {
      plan_type: 'max_20x',
      volume: 4,
      failureRate: 0.4,
      cooldowns: [
        {
          scope: 'credential',
          reason: 'quota',
          http_status: 429,
          backoff_level: 2,
          remaining_seconds: 1260,
          retry_at: new Date(Date.now() + 1_260_000).toISOString(),
        },
      ],
    },
    c4: {
      plan_type: 'max_5x',
      volume: 6,
      failureRate: 0.1,
      cooldowns: [
        {
          scope: 'model',
          model_key: 'claude-opus-4-1',
          reason: 'quota',
          http_status: 429,
          remaining_seconds: 540,
          retry_at: new Date(Date.now() + 540_000).toISOString(),
        },
      ],
    },
    c5: { plan_type: 'max_5x', disabled: true, volume: 0, note: 'Paused while travelling' },
    c6: { plan_type: 'max_20x', volume: 3, failureRate: 0 },
    x1: { plan_type: 'plus', volume: 8, failureRate: 0.05 },
    x2: {
      plan_type: 'plus',
      volume: 1,
      failureRate: 0.9,
      unavailable: true,
      status: 'error',
      status_message: 'refresh token revoked (401 invalid_grant); sign in again',
    },
    x3: { plan_type: 'pro', volume: 12, failureRate: 0.02, weight: 3 },
  };

export function enrichAccountsFixture(files: FixtureFile[]): void {
  const random = seeded(42);
  const now = Date.now();
  files.forEach((file, index) => {
    const authIndex = String(file.auth_index ?? '');
    const { volume = 2, failureRate = 0.1, ...fields } = PROFILES[authIndex] ?? {};
    const buckets = buildBuckets(random, volume, failureRate);
    Object.assign(file, {
      size: 2_000 + index * 137,
      modtime: Math.round((now - (index + 1) * 36 * 3_600_000) / 1000),
      recent_requests: buckets,
      success: 400 + Math.round(random() * 3_000) * (volume > 0 ? 1 : 0),
      failed: Math.round(random() * 40),
      cooldowns: [],
      ...fields,
    });
  });
}
