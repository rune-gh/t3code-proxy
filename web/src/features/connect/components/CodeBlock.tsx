import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { IconCheck, IconCopy } from '@/components/ui/icons';
import { useNotificationStore } from '@/stores';
import { copyToClipboard } from '@/utils/clipboard';
import styles from './CodeBlock.module.scss';

interface CodeBlockProps {
  /** What is shown; may contain placeholders instead of secrets. */
  code: string;
  /** What Copy puts on the clipboard; defaults to `code`. */
  copyText?: string;
  /** Header text: a file path (shown in mono) or a plain label such as "Terminal". */
  label: string;
  /** Show the label in mono because it is a path. */
  path?: boolean;
  /** Accessible name for the copy button, e.g. "Copy Claude Code settings". */
  copyLabel: string;
}

const COPIED_MS = 1600;

/** Read-only code with a header and a Copy button. Feature-local: there is no ui primitive. */
export function CodeBlock({ code, copyText, label, path = false, copyLabel }: CodeBlockProps) {
  const { t } = useTranslation();
  const showNotification = useNotificationStore((state) => state.showNotification);
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    []
  );

  const copy = async () => {
    const ok = await copyToClipboard(copyText ?? code);
    if (!ok) {
      showNotification(t('connect.copy_failed'), 'error');
      return;
    }
    setCopied(true);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), COPIED_MS);
  };

  return (
    <div className={styles.block}>
      <div className={styles.header}>
        <span className={path ? `${styles.label} ${styles.path}` : styles.label}>{label}</span>
        <Button variant="ghost" size="sm" onClick={() => void copy()} aria-label={copyLabel}>
          <span className={styles.copyContent}>
            {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
            {copied ? t('connect.copied') : t('common.copy')}
          </span>
        </Button>
      </div>
      <pre className={styles.code} tabIndex={0} aria-label={label}>
        <code>{code}</code>
      </pre>
      <span className="sr-only" role="status">
        {copied ? t('connect.copied') : ''}
      </span>
    </div>
  );
}
