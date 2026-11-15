/**
 * Codex banked rate-limit reset credits: list, pick, and redeem.
 *
 * Every upstream call goes through the hub's management api-call with exactly
 * the header set the Codex usage read sends (`buildCodexRequestHeader`).
 * React-free so tests can drive it directly.
 */

import type { AxiosRequestConfig } from 'axios';
import type { AuthFileItem, CodexRateLimitResetCredit } from '@/types';
import { apiCallApi, authFilesApi, getApiCallErrorMessage } from '@/services/api';
import { guardConfigConnection } from '@/services/api/configValue';
import { isRecord } from '@/utils/helpers';
import { normalizeAuthIndex } from '@/utils/authIndex';
import {
  CODEX_RATE_LIMIT_RESET_CREDITS_CONSUME_URL,
  CODEX_RATE_LIMIT_RESET_CREDITS_URL,
  CODEX_REQUEST_HEADERS,
  createStatusError,
  normalizeCodexResetCreditsPayload,
  resolveCodexChatgptAccountId,
} from '@/utils/quota';

/** Same headers as the Codex usage read; nothing added. */
export const buildCodexRequestHeader = (file: AuthFileItem): Record<string, string> => {
  const accountId = resolveCodexChatgptAccountId(file);
  const requestHeader: Record<string, string> = { ...CODEX_REQUEST_HEADERS };
  if (accountId) {
    requestHeader['Chatgpt-Account-Id'] = accountId;
  }
  return requestHeader;
};

/* ---------------------------------------------------------------------------
 * Pure helpers
 * ------------------------------------------------------------------------- */

/** Expiry instant in ms (ISO string, or epoch seconds/ms), or null. */
export const creditExpiryMs = (value: string): number | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const numeric = Number(trimmed);
    return numeric < 1e12 ? numeric * 1000 : numeric;
  }
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * Credits the owner can redeem now: Codex rate-limit credits that are
 * available (both already enforced by the payload normalizer), carry an id,
 * and have not expired. Soonest expiry first.
 */
export function availableResetCredits(
  credits: readonly CodexRateLimitResetCredit[],
  now: number
): CodexRateLimitResetCredit[] {
  return credits
    .filter((credit) => {
      const expiry = creditExpiryMs(credit.expiresAt);
      return credit.id !== '' && expiry !== null && expiry > now;
    })
    .sort((a, b) => (creditExpiryMs(a.expiresAt) ?? 0) - (creditExpiryMs(b.expiresAt) ?? 0));
}

/** Parse a credits listing body into the redeemable list, or null when the shape is wrong. */
export function parseResetCreditsListing(
  body: unknown,
  now: number
): CodexRateLimitResetCredit[] | null {
  const summary = normalizeCodexResetCreditsPayload(body);
  if (summary.invalidPayload) return null;
  return availableResetCredits(summary.credits, now);
}

export type CodexRedeemOutcome = 'reset' | 'nothing_to_reset' | 'no_credit' | 'already_redeemed';

const REDEEM_OUTCOMES: readonly CodexRedeemOutcome[] = [
  'reset',
  'nothing_to_reset',
  'no_credit',
  'already_redeemed',
];

/** The consume response code, or null when the response is not one we know. */
export function parseRedeemOutcome(body: unknown): CodexRedeemOutcome | null {
  let value = body;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  const code = isRecord(value) ? value.code : undefined;
  return REDEEM_OUTCOMES.includes(code as CodexRedeemOutcome) ? (code as CodexRedeemOutcome) : null;
}

/** Only these outcomes mean the account's limits were (or already had been) reset. */
export const redeemConsumedCredit = (outcome: CodexRedeemOutcome): boolean =>
  outcome === 'reset' || outcome === 'already_redeemed';

/* SHA-1 in plain JS: crypto.subtle is missing outside secure contexts (http over Tailscale). */
function sha1(bytes: Uint8Array): Uint8Array {
  const length = bytes.length;
  const words = new Uint32Array((((length + 8) >> 6) + 1) * 16);
  for (let i = 0; i < length; i += 1) words[i >> 2] |= bytes[i] << (24 - (i % 4) * 8);
  words[length >> 2] |= 0x80 << (24 - (length % 4) * 8);
  words[words.length - 1] = length * 8;
  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);
  const rotl = (x: number, n: number) => (x << n) | (x >>> (32 - n));
  for (let block = 0; block < words.length; block += 16) {
    for (let i = 0; i < 16; i += 1) w[i] = words[block + i];
    for (let i = 16; i < 80; i += 1) w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let i = 0; i < 80; i += 1) {
      const [f, k] =
        i < 20
          ? [(b & c) | (~b & d), 0x5a827999]
          : i < 40
            ? [b ^ c ^ d, 0x6ed9eba1]
            : i < 60
              ? [(b & c) | (b & d) | (c & d), 0x8f1bbcdc]
              : [b ^ c ^ d, 0xca62c1d6];
      const next = (rotl(a, 5) + f + e + k + w[i]) >>> 0;
      e = d;
      d = c;
      c = rotl(b, 30) >>> 0;
      b = a;
      a = next;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }
  const out = new Uint8Array(20);
  [h0, h1, h2, h3, h4].forEach((h, i) => {
    out[i * 4] = h >>> 24;
    out[i * 4 + 1] = (h >>> 16) & 0xff;
    out[i * 4 + 2] = (h >>> 8) & 0xff;
    out[i * 4 + 3] = h & 0xff;
  });
  return out;
}

/** Shared with the T3 Code app so both derive the same id for the same credit. */
const REDEEM_NAMESPACE = new Uint8Array([
  0x6f, 0x1c, 0x2a, 0x9e, 0x2d, 0x4b, 0x4c, 0x1e, 0x9a, 0x7f, 0x3b, 0x8d, 0x5e, 0x0c, 0x1a, 0x42,
]);

/**
 * UUIDv5 of `${accountKey}:${creditId}`: a retry for the same account and
 * credit sends the same id, so the upstream redeems it at most once.
 */
export function codexRedeemRequestId(accountKey: string, creditId: string): string {
  const name = new TextEncoder().encode(`${accountKey}:${creditId}`);
  const input = new Uint8Array(REDEEM_NAMESPACE.length + name.length);
  input.set(REDEEM_NAMESPACE);
  input.set(name, REDEEM_NAMESPACE.length);
  const bytes = sha1(input).slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Stable per account: the ChatGPT account id when known, else the hub's auth
 * file id (as the T3 Code app does), else the auth file name.
 */
export const codexRedeemAccountKey = (file: AuthFileItem): string => {
  const accountId = resolveCodexChatgptAccountId(file);
  if (accountId) return accountId;
  const id = typeof file.id === 'string' ? file.id.trim() : '';
  return id || file.name;
};

/* ---------------------------------------------------------------------------
 * Hub calls
 * ------------------------------------------------------------------------- */

const requireAuthIndex = (file: AuthFileItem): string => {
  const authIndex = normalizeAuthIndex(file['auth_index'] ?? file.authIndex);
  if (!authIndex) throw new Error('This account has no auth index; reload the account list.');
  return authIndex;
};

export interface CodexResetCreditsListing {
  credits: CodexRateLimitResetCredit[];
  /** Plain reason when the listing could not be read; credits is then empty. */
  error: string;
}

/** Never throws: a failed listing comes back as `error` so the page keeps working. */
export async function listCodexResetCredits(
  file: AuthFileItem,
  options: { now?: number; config?: AxiosRequestConfig } = {}
): Promise<CodexResetCreditsListing> {
  try {
    const result = await apiCallApi.request(
      {
        authIndex: requireAuthIndex(file),
        method: 'GET',
        url: CODEX_RATE_LIMIT_RESET_CREDITS_URL,
        header: buildCodexRequestHeader(file),
      },
      options.config
    );
    if (result.statusCode < 200 || result.statusCode >= 300) {
      return { credits: [], error: getApiCallErrorMessage(result) };
    }
    const credits = parseResetCreditsListing(
      result.body ?? result.bodyText,
      options.now ?? Date.now()
    );
    if (!credits) return { credits: [], error: 'Unexpected reset credits response.' };
    return { credits, error: '' };
  } catch (err: unknown) {
    return { credits: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/** The upstream answered, but not with a known outcome: nothing can be claimed. */
export class CodexRedeemUnconfirmedError extends Error {
  constructor() {
    super('Unexpected reset response; the credit may not have been used.');
    this.name = 'CodexRedeemUnconfirmedError';
  }
}

export interface CodexRedeemResult {
  outcome: CodexRedeemOutcome;
  /** Only meaningful when the credit was consumed: whether the hub cleared the cooldown. */
  cooldownCleared: boolean;
}

/**
 * Redeem one credit. Throws when the upstream answer is missing or unknown,
 * so the caller never reports a spend that did not happen. After `reset` or
 * `already_redeemed` it asks the hub to clear the account's cooldown.
 */
export async function redeemCodexResetCredit(
  file: AuthFileItem,
  creditId: string
): Promise<CodexRedeemResult> {
  const assertConnection = guardConfigConnection();
  const authIndex = requireAuthIndex(file);
  const result = await apiCallApi.request({
    authIndex,
    method: 'POST',
    url: CODEX_RATE_LIMIT_RESET_CREDITS_CONSUME_URL,
    header: buildCodexRequestHeader(file),
    data: JSON.stringify({
      redeem_request_id: codexRedeemRequestId(codexRedeemAccountKey(file), creditId),
      credit_id: creditId,
    }),
  });
  if (result.statusCode < 200 || result.statusCode >= 300) {
    throw createStatusError(getApiCallErrorMessage(result), result.statusCode);
  }
  const outcome = parseRedeemOutcome(result.body ?? result.bodyText);
  if (!outcome) throw new CodexRedeemUnconfirmedError();
  if (!redeemConsumedCredit(outcome)) return { outcome, cooldownCleared: false };

  try {
    // Never clear a different connection's cooldown after awaiting redemption.
    assertConnection();
    const cleared = await authFilesApi.resetCooldown(authIndex);
    assertConnection();
    return {
      outcome,
      cooldownCleared: cleared.status === 'ok' && cleared.auth_index === authIndex,
    };
  } catch {
    return { outcome, cooldownCleared: false };
  }
}
