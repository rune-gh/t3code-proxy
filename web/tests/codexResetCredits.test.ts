import { describe, expect, test } from 'bun:test';
import {
  availableResetCredits,
  codexRedeemAccountKey,
  codexRedeemRequestId,
  creditExpiryMs,
  parseRedeemOutcome,
  parseResetCreditsListing,
  redeemConsumedCredit,
} from '@/features/quota/providers/codex/resetCredits';
import { totalBankedCredits } from '@/features/quota/hooks/useCodexResetCredits';
import { createResetCreditsFixture } from '@/features/quota/__fixtures__/resetCredits';
import {
  CODEX_RATE_LIMIT_RESET_CREDITS_CONSUME_URL,
  CODEX_RATE_LIMIT_RESET_CREDITS_URL,
} from '@/utils/quota';

const NOW = Date.UTC(2026, 10, 14, 12);
const HOUR = 3_600_000;
const iso = (offsetHours: number) => new Date(NOW + offsetHours * HOUR).toISOString();

describe('reset credit listing', () => {
  test('keeps only available, unexpired Codex rate-limit credits, soonest expiry first', () => {
    const credits = parseResetCreditsListing(
      {
        credits: [
          { id: 'late', status: 'available', reset_type: 'codex_rate_limits', expires_at: iso(48) },
          { id: 'soon', status: 'available', reset_type: 'codex_rate_limits', expires_at: iso(2) },
          { id: 'gone', status: 'available', reset_type: 'codex_rate_limits', expires_at: iso(-1) },
          { id: 'used', status: 'redeemed', reset_type: 'codex_rate_limits', expires_at: iso(5) },
          { id: 'other', status: 'available', reset_type: 'something_else', expires_at: iso(5) },
          { id: 'noexp', status: 'available', reset_type: 'codex_rate_limits' },
        ],
      },
      NOW
    );
    expect(credits?.map((credit) => credit.id)).toEqual(['soon', 'late']);
  });

  test('drops credits without an id and treats a malformed body as a failure', () => {
    expect(
      availableResetCredits(
        [{ id: '', status: 'available', grantedAt: '', expiresAt: iso(4) }],
        NOW
      )
    ).toEqual([]);
    expect(parseResetCreditsListing('not json', NOW)).toBeNull();
    expect(parseResetCreditsListing({ unrelated: true }, NOW)).toBeNull();
    expect(parseResetCreditsListing({ credits: [] }, NOW)).toEqual([]);
  });

  test('reads ISO and epoch expiries', () => {
    expect(creditExpiryMs(iso(1))).toBe(NOW + HOUR);
    expect(creditExpiryMs(String((NOW + HOUR) / 1000))).toBe(NOW + HOUR);
    expect(creditExpiryMs(String(NOW + HOUR))).toBe(NOW + HOUR);
    expect(creditExpiryMs('soon')).toBeNull();
  });

  test('pool total counts only accounts whose listing succeeded', () => {
    const ready = (count: number) => ({
      status: 'ready' as const,
      credits: Array.from({ length: count }, (_, i) => ({
        id: String(i),
        status: 'available',
        grantedAt: '',
        expiresAt: iso(4),
      })),
      error: '',
    });
    const byAccount = {
      a: ready(2),
      b: ready(1),
      c: { status: 'error' as const, credits: [], error: '503' },
    };
    expect(totalBankedCredits(byAccount, ['a', 'b', 'c'])).toBe(3);
    expect(totalBankedCredits(byAccount, ['c'])).toBeNull();
    expect(totalBankedCredits(byAccount, [])).toBeNull();
  });
});

describe('redeem request id', () => {
  test('is a stable UUIDv5 per account and credit', () => {
    const id = codexRedeemRequestId('acct-1', 'credit-1');
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(codexRedeemRequestId('acct-1', 'credit-1')).toBe(id);
    expect(codexRedeemRequestId('acct-1', 'credit-2')).not.toBe(id);
    expect(codexRedeemRequestId('acct-2', 'credit-1')).not.toBe(id);
  });

  test('matches a reference SHA-1 UUIDv5 derivation', async () => {
    // Same derivation the T3 Code app uses, computed with WebCrypto.
    const namespace = new Uint8Array([
      0x6f, 0x1c, 0x2a, 0x9e, 0x2d, 0x4b, 0x4c, 0x1e, 0x9a, 0x7f, 0x3b, 0x8d, 0x5e, 0x0c, 0x1a,
      0x42,
    ]);
    for (const [account, credit] of [
      ['acct-1', 'credit-1'],
      ['a-much-longer-account-identifier-0123456789', 'cr_' + 'x'.repeat(80)],
    ]) {
      const name = new TextEncoder().encode(`${account}:${credit}`);
      const input = new Uint8Array(namespace.length + name.length);
      input.set(namespace);
      input.set(name, namespace.length);
      const bytes = new Uint8Array(await crypto.subtle.digest('SHA-1', input)).slice(0, 16);
      bytes[6] = (bytes[6] & 0x0f) | 0x50;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
      const expected = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      expect(codexRedeemRequestId(account, credit)).toBe(expected);
    }
  });

  test('keys the account by ChatGPT account id, then auth file id, then file name', () => {
    expect(codexRedeemAccountKey({ name: 'a.json', chatgpt_account_id: 'acct-9', id: 'f' })).toBe(
      'acct-9'
    );
    expect(codexRedeemAccountKey({ name: 'a.json', id: 'file-id' })).toBe('file-id');
    expect(codexRedeemAccountKey({ name: 'a.json' })).toBe('a.json');
  });
});

describe('redeem outcome', () => {
  test('maps known codes and rejects anything else', () => {
    expect(parseRedeemOutcome({ code: 'reset' })).toBe('reset');
    expect(parseRedeemOutcome('{"code":"already_redeemed"}')).toBe('already_redeemed');
    expect(parseRedeemOutcome({ code: 'nothing_to_reset' })).toBe('nothing_to_reset');
    expect(parseRedeemOutcome({ code: 'no_credit' })).toBe('no_credit');
    expect(parseRedeemOutcome({ code: 'ok' })).toBeNull();
    expect(parseRedeemOutcome('<html>')).toBeNull();
    expect(parseRedeemOutcome(null)).toBeNull();
  });

  test('only reset and already_redeemed count as a used credit', () => {
    expect(redeemConsumedCredit('reset')).toBe(true);
    expect(redeemConsumedCredit('already_redeemed')).toBe(true);
    expect(redeemConsumedCredit('nothing_to_reset')).toBe(false);
    expect(redeemConsumedCredit('no_credit')).toBe(false);
  });
});

describe('dev fixture', () => {
  test('lists, fails per account, and redeems once', () => {
    const fixture = createResetCreditsFixture(NOW);
    const list = (authIndex: string) =>
      fixture.handle({ authIndex, method: 'GET', url: CODEX_RATE_LIMIT_RESET_CREDITS_URL });
    const consume = (authIndex: string, creditId: string) =>
      JSON.parse(
        String(
          fixture.handle({
            authIndex,
            method: 'POST',
            url: CODEX_RATE_LIMIT_RESET_CREDITS_CONSUME_URL,
            data: JSON.stringify({ redeem_request_id: 'r', credit_id: creditId }),
          })?.body
        )
      ).code;

    expect(parseResetCreditsListing(list('x1')?.body, NOW)?.map((c) => c.id)).toEqual([
      'cr_x1_a',
      'cr_x1_b',
    ]);
    expect(list('x3')?.status_code).toBe(503);
    expect(consume('x1', 'cr_x1_a')).toBe('reset');
    expect(consume('x1', 'cr_x1_a')).toBe('already_redeemed');
    expect(consume('x1', 'missing')).toBe('no_credit');
    expect(parseResetCreditsListing(list('x1')?.body, NOW)).toHaveLength(1);
    expect(fixture.handle({ url: 'https://example.com/other' })).toBeNull();
  });
});
