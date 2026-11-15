/**
 * Confirmation before redeeming a banked Codex reset. Names the account,
 * says it cannot be undone and when the credit would otherwise expire. A
 * failure stays in the dialog in plain words; success closes it.
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import type { CodexRateLimitResetCredit } from '@/types';
import { creditExpiryMs } from '../providers/codex/resetCredits';
import { formatDuration, formatMonthDay, formatWeekdayTime } from '../poolFormat';
import styles from './UseResetDialog.module.scss';

export interface UseResetTarget {
  authIndex: string;
  label: string;
  credit: CodexRateLimitResetCredit;
  /** Credits on the account, including this one. */
  available: number;
}

interface UseResetDialogProps {
  target: UseResetTarget | null;
  now: number;
  locale: string;
  /** False blurs the account label, matching the page's "Show emails" state. */
  showLabel: boolean;
  onClose: () => void;
  /** Resolves to null on success, or a plain error message to show. */
  onConfirm: (target: UseResetTarget) => Promise<string | null>;
}

export function UseResetDialog({
  target,
  now,
  locale,
  showLabel,
  onClose,
  onConfirm,
}: UseResetDialogProps) {
  const { t } = useTranslation();
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');

  const close = () => {
    if (working) return;
    setError('');
    onClose();
  };

  const confirm = async () => {
    if (!target || working) return;
    setWorking(true);
    setError('');
    const message = await onConfirm(target);
    setWorking(false);
    if (message) setError(message);
    else onClose();
  };

  const expiry = target ? creditExpiryMs(target.credit.expiresAt) : null;

  return (
    <Modal
      open={target !== null}
      title={t('quota_accounts.dialog_title')}
      onClose={close}
      closeDisabled={working}
      width={440}
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={working}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={() => void confirm()} loading={working}>
            {t('quota_accounts.use_reset')}
          </Button>
        </>
      }
    >
      {target && (
        <div className={styles.body}>
          <dl className={styles.facts}>
            <dt>{t('quota_accounts.dialog_account')}</dt>
            <dd className={showLabel ? styles.account : `${styles.account} ${styles.blurred}`}>
              {target.label}
            </dd>
            <dt>{t('quota_accounts.dialog_expires')}</dt>
            <dd>
              {expiry === null
                ? '—'
                : t('quota_accounts.dialog_expires_value', {
                    date: `${formatMonthDay(expiry, locale)}, ${formatWeekdayTime(expiry, locale)}`,
                    duration: formatDuration(expiry - now),
                  })}
            </dd>
            <dt>{t('quota_accounts.dialog_banked')}</dt>
            <dd>{t('quota_accounts.dialog_banked_value', { count: target.available })}</dd>
          </dl>
          <p className={styles.note}>{t('quota_accounts.dialog_body')}</p>
          {error && (
            <div className="error-box" role="alert">
              {error}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
