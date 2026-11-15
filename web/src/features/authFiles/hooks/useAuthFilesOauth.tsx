import { useCallback, useEffect, useRef, useState } from 'react';
import { authFilesApi } from '@/services/api';
import type { OAuthModelAliasEntry } from '@/types';
import type { OAuthConfigLoadError } from '@/features/authFiles/constants';

export type UseAuthFilesOauthResult = {
  excluded: Record<string, string[]>;
  excludedError: OAuthConfigLoadError;
  modelAlias: Record<string, OAuthModelAliasEntry[]>;
  modelAliasError: OAuthConfigLoadError;
  loadExcluded: () => Promise<void>;
  loadModelAlias: () => Promise<void>;
};

const readStatus = (err: unknown): unknown =>
  typeof err === 'object' && err !== null && 'status' in err
    ? (err as { status?: unknown }).status
    : undefined;

/**
 * The Accounts page only **reads** the OAuth model rules: summaries for the entry rows
 * and excluded state for the models dialog. Editing lives in features/authFiles/modelRules.
 * A 404 means the hub does not serve that rule set; it is marked 'unsupported' and the
 * page hides the entry quietly instead of showing a toast.
 */
export function useAuthFilesOauth(): UseAuthFilesOauthResult {
  const [excluded, setExcluded] = useState<Record<string, string[]>>({});
  const [excludedError, setExcludedError] = useState<OAuthConfigLoadError>('loading');
  const [modelAlias, setModelAlias] = useState<Record<string, OAuthModelAliasEntry[]>>({});
  const [modelAliasError, setModelAliasError] = useState<OAuthConfigLoadError>('loading');

  const excludedLoadRequestRef = useRef(0);
  const modelAliasLoadRequestRef = useRef(0);

  useEffect(
    () => () => {
      excludedLoadRequestRef.current += 1;
      modelAliasLoadRequestRef.current += 1;
    },
    []
  );

  const loadExcluded = useCallback(async () => {
    const requestId = ++excludedLoadRequestRef.current;
    setExcludedError('loading');
    try {
      const res = await authFilesApi.getOauthExcludedModels();
      if (requestId !== excludedLoadRequestRef.current) return;
      setExcluded(res || {});
      setExcludedError(null);
    } catch (err: unknown) {
      if (requestId !== excludedLoadRequestRef.current) return;
      if (readStatus(err) === 404) {
        setExcluded({});
        setExcludedError('unsupported');
        return;
      }
      setExcludedError('load');
    }
  }, []);

  const loadModelAlias = useCallback(async () => {
    const requestId = ++modelAliasLoadRequestRef.current;
    setModelAliasError('loading');
    try {
      const res = await authFilesApi.getOauthModelAlias();
      if (requestId !== modelAliasLoadRequestRef.current) return;
      setModelAlias(res || {});
      setModelAliasError(null);
    } catch (err: unknown) {
      if (requestId !== modelAliasLoadRequestRef.current) return;
      if (readStatus(err) === 404) {
        setModelAlias({});
        setModelAliasError('unsupported');
        return;
      }
      setModelAliasError('load');
    }
  }, []);

  return { excluded, excludedError, modelAlias, modelAliasError, loadExcluded, loadModelAlias };
}
