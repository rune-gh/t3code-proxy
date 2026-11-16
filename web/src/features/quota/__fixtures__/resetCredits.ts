/**
 * DEV-only Codex banked reset credits for the fixture session, answered as the
 * hub's api-call envelope (`{ status_code, body }`). Account x1 has two usable
 * credits plus an expired one and a credit of another type (both filtered out),
 * x2 has one, and x3's listing fails so the per-account error state shows.
 * Redeeming removes the credit, so a second attempt reports `already_redeemed`.
 */

import {
  CODEX_RATE_LIMIT_RESET_CREDITS_CONSUME_URL,
  CODEX_RATE_LIMIT_RESET_CREDITS_URL,
} from '@/utils/quota';

const HOUR = 3_600_000;

interface FixtureCredit {
  id: string;
  status: string;
  reset_type: string;
  expires_at: string;
}

export function createResetCreditsFixture(now: number) {
  const credit = (id: string, expiresInHours: number, resetType = 'codex_rate_limits') => ({
    id,
    status: 'available',
    reset_type: resetType,
    expires_at: new Date(now + expiresInHours * HOUR).toISOString(),
  });
  const byAccount = new Map<string, FixtureCredit[]>([
    [
      'x1',
      [
        credit('cr_x1_b', 24 * 20),
        credit('cr_x1_a', 24 * 6),
        credit('cr_x1_old', -2),
        credit('cr_x1_other', 24 * 3, 'other_reset'),
      ],
    ],
    ['x2', [credit('cr_x2_a', 24 * 12)]],
    // Owner pool (`&pool=owner`): the empty Plus account has one banked reset.
    ['o-x1', [credit('cr_ox1_a', 24 * 9)]],
    ['o-x2', []],
  ]);
  const redeemed = new Set<string>();

  const envelope = (statusCode: number, body: unknown) => ({
    status_code: statusCode,
    header: {},
    body: JSON.stringify(body),
  });

  /** The api-call envelope for a reset-credits call, or null for other upstream URLs. */
  const handle = (call: Record<string, unknown>) => {
    const authIndex = String(call.authIndex ?? call.auth_index ?? '');
    if (call.url === CODEX_RATE_LIMIT_RESET_CREDITS_URL) {
      if (!byAccount.has(authIndex)) {
        return envelope(503, { error: { message: 'Service temporarily unavailable' } });
      }
      return envelope(200, { credits: byAccount.get(authIndex) });
    }
    if (call.url === CODEX_RATE_LIMIT_RESET_CREDITS_CONSUME_URL) {
      const { credit_id: creditId } = JSON.parse(String(call.data ?? '{}')) as {
        credit_id?: string;
      };
      const credits = byAccount.get(authIndex) ?? [];
      const index = credits.findIndex((item) => item.id === creditId);
      if (index === -1) {
        return envelope(200, {
          code: creditId && redeemed.has(creditId) ? 'already_redeemed' : 'no_credit',
        });
      }
      credits.splice(index, 1);
      redeemed.add(String(creditId));
      return envelope(200, { code: 'reset' });
    }
    return null;
  };

  return { handle };
}
