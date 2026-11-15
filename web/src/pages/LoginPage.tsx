import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { useAuthStore } from '@/stores';
import {
  getLoginTransitionTimings,
  useLoginTransitionStore,
} from '@/stores/useLoginTransitionStore';
import { prefersReducedMotion } from '@/hooks/motion';
import { detectApiBaseFromLocation, normalizeApiBase } from '@/utils/connection';
import { BRAND_FOX_URI, BRAND_NAME } from '@/assets/brandLogo';
import type { ApiError } from '@/types';
import { LegacyBackendError } from '@/services/api/legacyBackendProbe';
import { LoginForm } from './login/LoginForm';
import { resolveLoginRedirect } from '@/router/loginRedirect';
import styles from './LoginPage.module.scss';

export type LoginPhase = 'idle' | 'connecting' | 'success' | 'exiting';

/** Product name shown above the form; English in every language. */
export const LOGIN_BRAND_NAME = BRAND_NAME;

/** Turns an API error into a short, specific message for the form. */
function getLocalizedErrorMessage(error: unknown, t: (key: string) => string): string {
  if (error instanceof LegacyBackendError) return t('login.error_legacy_backend');
  const apiError = error as Partial<ApiError>;
  const status = typeof apiError.status === 'number' ? apiError.status : undefined;
  const code = typeof apiError.code === 'string' ? apiError.code : undefined;
  const message =
    error instanceof Error
      ? error.message
      : typeof apiError.message === 'string'
        ? apiError.message
        : typeof error === 'string'
          ? error
          : '';

  const withHttpStatus = (summary: string) => {
    if (!status) return summary;
    const genericAxiosMessage = `Request failed with status code ${status}`;
    const detail = message.trim();
    const backendDetail =
      detail && detail !== genericAxiosMessage
        ? ` (${t('login.error_backend_detail')}: ${detail})`
        : '';
    return `HTTP ${status}: ${summary}${backendDetail}`;
  };

  // HTTP status first
  if (status === 401) return withHttpStatus(t('login.error_unauthorized'));
  if (status === 403) return withHttpStatus(t('login.error_forbidden'));
  if (status === 404) return withHttpStatus(t('login.error_not_found'));
  if (status && status >= 500) return withHttpStatus(t('login.error_server'));

  // Then axios error codes
  const lower = message.toLowerCase();
  if (code === 'ECONNABORTED' || lower.includes('timeout')) return t('login.error_timeout');
  if (code === 'ERR_NETWORK' || lower.includes('network error')) return t('login.error_network');
  if (code === 'ERR_CERT_AUTHORITY_INVALID' || lower.includes('certificate')) {
    return t('login.error_ssl');
  }
  if (lower.includes('cors') || lower.includes('cross-origin')) return t('login.error_cors');

  return withHttpStatus(t('login.error_invalid'));
}

export function LoginPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const login = useAuthStore((state) => state.login);
  const restoreSession = useAuthStore((state) => state.restoreSession);

  const detectedBase = useMemo(() => detectApiBaseFromLocation(), []);
  // Prefill from the saved session on the first frame so the form never flashes empty.
  const [apiBase, setApiBase] = useState(() => useAuthStore.getState().apiBase || detectedBase);
  const [managementKey, setManagementKey] = useState(
    () => useAuthStore.getState().managementKey || ''
  );
  const [showCustomBase, setShowCustomBase] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [rememberPassword, setRememberPassword] = useState(() => {
    const { rememberPassword: remembered, managementKey: key } = useAuthStore.getState();
    return remembered || Boolean(key);
  });
  const [phase, setPhase] = useState<LoginPhase>('idle');
  // Only show the restoring state when an automatic sign-in will actually be attempted.
  const [autoLoading, setAutoLoading] = useState(() =>
    useAuthStore.getState().hasRestorableSession()
  );
  const [autoLoginSuccess, setAutoLoginSuccess] = useState(false);
  const [error, setError] = useState('');

  const startReveal = useLoginTransitionStore((state) => state.startReveal);
  const exitTimersRef = useRef<number[]>([]);
  const loading = phase === 'connecting';
  const redirectTarget = resolveLoginRedirect(location.state);

  useEffect(
    () => () => {
      exitTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    },
    []
  );

  const leaveTo = useCallback(
    (redirect: string, hold: number) => {
      const timings = getLoginTransitionTimings(prefersReducedMotion());
      const schedule = (callback: () => void, delay: number) => {
        exitTimersRef.current.push(window.setTimeout(callback, delay));
      };
      schedule(() => setPhase('exiting'), hold);
      schedule(() => {
        startReveal();
        navigate(redirect, { replace: true });
      }, hold + timings.exit);
    },
    [navigate, startReveal]
  );

  useEffect(() => {
    const startedAt = performance.now();
    const init = async () => {
      try {
        const autoLoggedIn = await restoreSession();
        if (autoLoggedIn) {
          setAutoLoginSuccess(true);
          const { splashMin } = getLoginTransitionTimings(prefersReducedMotion());
          leaveTo(redirectTarget, Math.max(0, splashMin - (performance.now() - startedAt)));
        } else {
          // Refill from the latest stored values (restoreSession may have migrated old
          // storage). After a 401 the store is cleared; keep what the first frame showed
          // so the user can correct it and retry without losing a custom address.
          const stored = useAuthStore.getState();
          setApiBase((previous) => stored.apiBase || previous || detectedBase);
          setManagementKey((previous) => stored.managementKey || previous);
          setRememberPassword(
            (previous) => stored.rememberPassword || Boolean(stored.managementKey) || previous
          );
        }
      } finally {
        setAutoLoading(false);
      }
    };

    init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSubmit = useCallback(async () => {
    if (phase !== 'idle') return;
    if (!managementKey.trim()) {
      setError(t('login.error_required'));
      return;
    }

    const baseToUse = apiBase ? normalizeApiBase(apiBase) : detectedBase;
    // Enter `connecting` first so the isAuthenticated flip does not redirect mid-flight.
    setPhase('connecting');
    setError('');
    try {
      await login({
        apiBase: baseToUse,
        managementKey: managementKey.trim(),
        rememberPassword,
      });
    } catch (err: unknown) {
      setPhase('idle');
      setError(getLocalizedErrorMessage(err, t));
      return;
    }
    setPhase('success');
    leaveTo(redirectTarget, getLoginTransitionTimings(prefersReducedMotion()).successHold);
  }, [
    apiBase,
    detectedBase,
    leaveTo,
    login,
    managementKey,
    phase,
    redirectTarget,
    rememberPassword,
    t,
  ]);

  if (isAuthenticated && !autoLoading && !autoLoginSuccess && phase === 'idle') {
    return <Navigate to={redirectTarget} replace />;
  }

  const restoring = autoLoading || autoLoginSuccess;

  return (
    <div className={styles.container} data-phase={phase === 'exiting' ? 'exiting' : undefined}>
      <main className={styles.column}>
        <div className={styles.brand}>
          <img src={BRAND_FOX_URI} alt="" className={styles.fox} width={56} height={56} />
          <span className={styles.brandName}>{LOGIN_BRAND_NAME}</span>
        </div>

        {restoring ? (
          <div className={styles.restoring} role="status" aria-live="polite">
            <LoadingSpinner size={16} />
            <span>{t('login.restoring')}</span>
          </div>
        ) : (
          <section className={styles.panel} aria-labelledby="login-title">
            <h1 id="login-title" className={styles.title}>
              {t('login.title')}
            </h1>
            <LoginForm
              apiBase={apiBase}
              detectedBase={detectedBase}
              editingBase={showCustomBase}
              managementKey={managementKey}
              showKey={showKey}
              rememberPassword={rememberPassword}
              loading={loading}
              success={phase === 'success' || phase === 'exiting'}
              error={error}
              onApiBaseChange={setApiBase}
              onEditingBaseChange={setShowCustomBase}
              onManagementKeyChange={setManagementKey}
              onShowKeyChange={setShowKey}
              onRememberPasswordChange={setRememberPassword}
              onSubmit={handleSubmit}
            />
          </section>
        )}
      </main>
    </div>
  );
}
