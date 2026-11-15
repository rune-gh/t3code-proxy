import { useId, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge, StatusDot } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { IconCheckCircle2, IconExternalLink, IconLoader2 } from '@/components/ui/icons';
import type { ProviderFlowState } from '../hooks/useOAuthFlows';
import { resolveFlowView, splitAuthUrl, type FlowView } from '../flowView';
import { maskProxyUrl } from '../loginProxy';
import type { OAuthFlowKind } from '../providers';
import { BrandGlyph } from './BrandGlyph';
import { CopyButton } from './CopyButton';
import styles from './OAuthFlowDialog.module.scss';

export interface DialogHeading {
  title: string;
  caption: string;
  icon: string;
}

export function DialogTitle({ title, caption, icon }: DialogHeading) {
  return (
    <span className={styles.heading}>
      <span className={styles.headingGlyph}>
        <BrandGlyph src={icon} size={18} className={styles.headingImage} />
      </span>
      <span className={styles.headingText}>
        <span className={styles.headingTitle}>{title}</span>
        <span className={styles.headingCaption}>{caption}</span>
      </span>
    </span>
  );
}

export interface OAuthFlowDialogProps {
  open: boolean;
  providerId: string;
  heading: DialogHeading;
  /** Device-code or browser sign-in; picks the plain explanation shown above the steps. */
  flow?: OAuthFlowKind;
  state: ProviderFlowState;
  /** Provider-specific copy: `auth_login.<id>_<suffix>` or the plugin template. */
  text: (suffix: string) => string;
  supportsCallback: boolean;
  onStart: () => void;
  onCancel: () => void;
  onCallbackChange: (value: string) => void;
  onCallbackSubmit: () => void;
  onViewAuthFiles: () => void;
  onClose: () => void;
}

/** Add account, step two: what happens during sign-in, the link or code, and live status. */
export function OAuthFlowDialog(props: OAuthFlowDialogProps) {
  const { open, heading, state, onClose } = props;
  const view = resolveFlowView(state);

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={520}
      className={styles.dialog}
      title={<DialogTitle {...heading} />}
      footer={view === 'flow' ? <FlowStatusBar {...props} /> : undefined}
    >
      {view === 'success' ? <SuccessView {...props} /> : <FlowBody {...props} view={view} />}
    </Modal>
  );
}

function Explanation({
  text,
  flow,
  supportsCallback,
}: Pick<OAuthFlowDialogProps, 'text' | 'flow' | 'supportsCallback'>) {
  const { t } = useTranslation();
  const how =
    flow === 'device'
      ? t('auth_login.how_device')
      : supportsCallback
        ? t('auth_login.how_browser')
        : null;
  return (
    <div className={styles.explain}>
      <p className={styles.hint}>{text('oauth_hint')}</p>
      {how && <p className={styles.how}>{how}</p>}
    </div>
  );
}

function FlowBody(props: OAuthFlowDialogProps & { view: Exclude<FlowView, 'success'> }) {
  const { t } = useTranslation();
  const { view, providerId, state, text, onStart } = props;
  const isDevin = providerId === 'devin';

  if (view !== 'flow') {
    return (
      <div className={styles.stack}>
        <Explanation {...props} />
        {view === 'failed' && (
          <div className="error-box" role="alert">
            {text('oauth_status_error')} {state.error || ''}
          </div>
        )}
        <div>
          <Button variant="primary" onClick={onStart}>
            {view === 'failed' ? t('auth_login.restart_login') : text('oauth_button')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.stack}>
      <Explanation {...props} />
      {state.proxyUrl && (
        <p className={styles.proxyNote}>
          <span>{t('auth_login.login_proxy_in_use')}</span>
          <code className={styles.proxyValue}>{maskProxyUrl(state.proxyUrl)}</code>
        </p>
      )}
      {isDevin && state.state && state.status === 'error' && (
        <div className="error-box" role="alert">
          {t('auth_login.devin_oauth_retry_hint')}
        </div>
      )}
      {state.cancelError && (
        <div className="error-box" role="alert">
          {t('auth_login.devin_oauth_cancel_error')} {state.cancelError}
        </div>
      )}
      <ol className={styles.steps}>
        <OpenStep {...props} />
        {state.userCode && (
          <Step title={t('auth_login.step_enter_device_code')}>
            <div className={styles.codeRow}>
              <output className={styles.code} aria-label={t('auth_login.device_code_label')}>
                {state.userCode}
              </output>
              <CopyButton
                value={state.userCode}
                label={t('auth_login.device_code_copy')}
                showLabel
              />
            </div>
          </Step>
        )}
        {props.supportsCallback && <CallbackStep {...props} />}
      </ol>
    </div>
  );
}

export function Step({
  title,
  titleFor,
  aside,
  children,
}: {
  title: string;
  titleFor?: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <li className={styles.step}>
      <span className={styles.stepIndex} aria-hidden="true" />
      <div className={styles.stepBody}>
        <div className={styles.stepHead}>
          {titleFor ? (
            <label className={styles.stepTitle} htmlFor={titleFor}>
              {title}
            </label>
          ) : (
            <span className={styles.stepTitle}>{title}</span>
          )}
          {aside}
        </div>
        {children}
      </div>
    </li>
  );
}

function OpenStep({ state, text }: OAuthFlowDialogProps) {
  const { t } = useTranslation();
  const url = state.url;
  const parts = url ? splitAuthUrl(url) : null;

  return (
    <Step title={t('auth_login.step_open_auth_page')}>
      <div className={styles.urlField} aria-busy={!url}>
        {parts ? (
          <span className={styles.urlText} title={url}>
            <span className={styles.urlHost}>{parts.host}</span>
            <span className={styles.urlRest}>{parts.rest}</span>
          </span>
        ) : (
          <span className={styles.urlSkeleton} aria-label={t('auth_login.generating_link')} />
        )}
        {url && <CopyButton value={url} label={text('copy_link')} />}
      </div>
      <div>
        <Button
          variant="primary"
          disabled={!url}
          onClick={() => url && window.open(url, '_blank', 'noopener,noreferrer')}
        >
          <span className={styles.inline}>
            {text('open_link')}
            <IconExternalLink size={16} aria-hidden="true" />
          </span>
        </Button>
      </div>
    </Step>
  );
}

function CallbackStep({
  providerId,
  state,
  onCallbackChange,
  onCallbackSubmit,
}: OAuthFlowDialogProps) {
  const { t } = useTranslation();
  const inputId = useId();
  const hintId = useId();
  const feedbackId = useId();
  const isXai = providerId === 'xai';
  const isDevin = providerId === 'devin';
  const disabled = !state.url || (isDevin && (state.cancelling || state.status !== 'waiting'));
  const hintKey = isXai
    ? 'auth_login.xai_callback_hint'
    : isDevin
      ? 'auth_login.devin_callback_hint'
      : 'auth_login.oauth_callback_hint';
  const placeholderKey = isXai
    ? 'auth_login.xai_callback_placeholder'
    : isDevin
      ? 'auth_login.devin_callback_placeholder'
      : 'auth_login.oauth_callback_placeholder';

  const feedback = state.callbackValidation
    ? { tone: 'error' as const, message: state.callbackValidation }
    : state.callbackStatus === 'error'
      ? {
          tone: 'error' as const,
          message: `${t('auth_login.oauth_callback_status_error')} ${state.callbackError || ''}`,
        }
      : state.callbackStatus === 'success' && state.status === 'waiting'
        ? { tone: 'success' as const, message: t('auth_login.oauth_callback_status_success') }
        : null;

  return (
    <Step
      title={t(isXai ? 'auth_login.xai_callback_label' : 'auth_login.oauth_callback_label')}
      titleFor={inputId}
      aside={<Badge outline>{t('auth_login.optional_step')}</Badge>}
    >
      <p className={styles.stepHint} id={hintId}>
        {t(hintKey)}
      </p>
      <form
        className={styles.callbackRow}
        onSubmit={(event) => {
          event.preventDefault();
          onCallbackSubmit();
        }}
      >
        <input
          id={inputId}
          className={`input ${styles.callbackInput}`}
          value={state.callbackUrl || ''}
          onChange={(event) => onCallbackChange(event.target.value)}
          placeholder={t(placeholderKey)}
          disabled={disabled}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={feedback?.tone === 'error'}
          aria-describedby={feedback ? `${feedbackId} ${hintId}` : hintId}
        />
        <Button
          type="submit"
          variant="secondary"
          disabled={disabled}
          loading={state.callbackSubmitting}
        >
          {t('auth_login.oauth_callback_button')}
        </Button>
      </form>
      {feedback && (
        <p
          id={feedbackId}
          className={feedback.tone === 'error' ? styles.feedbackError : styles.feedbackSuccess}
          role={feedback.tone === 'error' ? 'alert' : 'status'}
        >
          {feedback.message}
        </p>
      )}
    </Step>
  );
}

function FlowStatusBar({ providerId, state, text, onStart, onCancel }: OAuthFlowDialogProps) {
  const { t } = useTranslation();
  const isDevin = providerId === 'devin';
  const failed = state.status === 'error';
  const generating = !failed && !state.url;
  // The Devin session may still be open on the server: it must be cancelled before restarting
  const canCancel = isDevin && Boolean(state.state);

  return (
    <div className={styles.statusBar} data-tone={failed ? 'error' : 'waiting'}>
      <p className={styles.statusText} role="status" aria-live="polite">
        {generating ? (
          <IconLoader2 size={16} className={styles.spinning} aria-hidden="true" />
        ) : (
          <StatusDot
            tone={failed ? 'destructive' : 'info'}
            className={failed ? undefined : styles.pulse}
            aria-hidden="true"
          />
        )}
        <span className={styles.statusLabel}>
          {generating
            ? t('auth_login.generating_link')
            : failed
              ? `${text('oauth_status_error')} ${state.error || ''}`
              : text('oauth_status_waiting')}
        </span>
      </p>
      {canCancel ? (
        <Button variant="ghost" size="sm" onClick={onCancel} loading={state.cancelling}>
          {t('auth_login.devin_oauth_cancel')}
        </Button>
      ) : failed ? (
        <Button variant="secondary" size="sm" onClick={onStart}>
          {t('auth_login.restart_login')}
        </Button>
      ) : (
        <span className={styles.statusAside}>{t('auth_login.waiting_background_hint')}</span>
      )}
    </div>
  );
}

function SuccessView({ text, onStart, onViewAuthFiles }: OAuthFlowDialogProps) {
  const { t } = useTranslation();
  return (
    <div className={styles.result} role="status">
      <IconCheckCircle2 size={24} className={styles.successMark} aria-hidden="true" />
      <div className={styles.resultTitle}>{text('oauth_status_success')}</div>
      <p className={styles.resultHint}>{t('auth_login.success_saved_hint')}</p>
      <div className={styles.resultActions}>
        <Button variant="secondary" onClick={onStart}>
          {t('auth_login.login_another_account')}
        </Button>
        <Button variant="primary" onClick={onViewAuthFiles}>
          {t('auth_login.view_auth_files')}
        </Button>
      </div>
    </div>
  );
}
