/**
 * Banked reset credits for every Codex account on the page, read once when the
 * account list settles and again on demand. A failed listing marks only that
 * account; responses from an older request or connection are dropped.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiClient } from '@/services/api';
import type { AuthFileItem, CodexRateLimitResetCredit } from '@/types';
import { listCodexResetCredits } from '../providers/codex/resetCredits';

export interface CodexCreditsEntry {
  status: 'loading' | 'ready' | 'error';
  credits: CodexRateLimitResetCredit[];
  error: string;
}

export type CodexCreditsByAccount = Record<string, CodexCreditsEntry>;

const keyFor = (file: AuthFileItem): string => String(file.authIndex ?? file['auth_index'] ?? '');

export function useCodexResetCredits(files: readonly AuthFileItem[], active: boolean) {
  const [byAccount, setByAccount] = useState<CodexCreditsByAccount>({});
  const requestRef = useRef<Record<string, number>>({});
  const filesRef = useRef(files);
  useEffect(() => {
    filesRef.current = files;
  }, [files]);

  const load = useCallback(async (targets: readonly AuthFileItem[]) => {
    const revision = apiClient.getConnectionRevision();
    await Promise.all(
      targets.map(async (file) => {
        const key = keyFor(file);
        if (!key) return;
        const requestId = (requestRef.current[key] ?? 0) + 1;
        requestRef.current[key] = requestId;
        setByAccount((previous) => ({
          ...previous,
          [key]: { status: 'loading', credits: previous[key]?.credits ?? [], error: '' },
        }));
        const listing = await listCodexResetCredits(file);
        if (
          requestRef.current[key] !== requestId ||
          revision !== apiClient.getConnectionRevision()
        ) {
          return;
        }
        setByAccount((previous) => ({
          ...previous,
          [key]: listing.error
            ? { status: 'error', credits: [], error: listing.error }
            : { status: 'ready', credits: listing.credits, error: '' },
        }));
      })
    );
  }, []);

  const signature = files
    .filter((file) => !file.disabled)
    .map(keyFor)
    .join(',');

  useEffect(() => {
    if (!active) return;
    void load(filesRef.current.filter((file) => !file.disabled));
  }, [active, load, signature]);

  // A new connection must not show the old hub's credits.
  useEffect(() => {
    if (!active) setByAccount({});
  }, [active]);

  const refresh = useCallback(
    (file?: AuthFileItem) =>
      load(file ? [file] : filesRef.current.filter((candidate) => !candidate.disabled)),
    [load]
  );

  return { byAccount, refresh };
}

/** Sum of available credits over accounts whose listing succeeded; null when none did. */
export function totalBankedCredits(byAccount: CodexCreditsByAccount, keys: readonly string[]) {
  let total = 0;
  let known = false;
  keys.forEach((key) => {
    const entry = byAccount[key];
    if (entry?.status !== 'ready') return;
    known = true;
    total += entry.credits.length;
  });
  return known ? total : null;
}
