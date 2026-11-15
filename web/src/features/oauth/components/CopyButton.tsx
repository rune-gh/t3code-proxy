import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, IconButton } from '@/components/ui/Button';
import { IconCheck, IconCopy } from '@/components/ui/icons';
import { useNotificationStore } from '@/stores';
import { copyToClipboard } from '@/utils/clipboard';
import styles from './CopyButton.module.scss';

const COPIED_RESET_MS = 1400;

/**
 * Copy button: on success the icon turns into a check in place (no toast); only a failure uses
 * the global notification. Screen readers hear "Copied" through a status region.
 */
export function CopyButton({
  value,
  label,
  showLabel = false,
}: {
  value: string;
  label: string;
  showLabel?: boolean;
}) {
  const { t } = useTranslation();
  const { showNotification } = useNotificationStore();
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    []
  );

  const handleCopy = async () => {
    const ok = await copyToClipboard(value);
    if (!ok) {
      showNotification(t('notification.copy_failed'), 'error');
      return;
    }
    setCopied(true);
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setCopied(false), COPIED_RESET_MS);
  };

  const glyph = copied ? (
    <IconCheck size={16} aria-hidden="true" />
  ) : (
    <IconCopy size={16} aria-hidden="true" />
  );
  const status = (
    <span className="sr-only" role="status">
      {copied ? t('auth_login.copied') : ''}
    </span>
  );

  if (showLabel) {
    return (
      <>
        <Button type="button" variant="secondary" size="sm" onClick={handleCopy}>
          <span className={styles.inline}>
            {glyph}
            {label}
          </span>
        </Button>
        {status}
      </>
    );
  }

  return (
    <>
      <IconButton aria-label={label} icon={glyph} size="sm" onClick={handleCopy} />
      {status}
    </>
  );
}
