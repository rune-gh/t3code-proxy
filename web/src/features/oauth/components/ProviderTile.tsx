import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { IconPlus } from '@/components/ui/icons';
import type { ProviderFlowState } from '../hooks/useOAuthFlows';
import { BrandGlyph } from './BrandGlyph';
import styles from './ProviderTile.module.scss';

export interface ProviderTileProps {
  label: string;
  caption: string;
  icon: string;
  /** One plain line about what to sign in with; primary tiles only. */
  description?: string;
  /** `primary` is the large tile for the main subscriptions; `compact` is a list row. */
  variant?: 'primary' | 'compact';
  status?: ProviderFlowState['status'];
  statusLabel?: string;
  onOpen: () => void;
}

const STATUS_TONE: Record<NonNullable<ProviderFlowState['status']>, BadgeTone> = {
  waiting: 'info',
  success: 'success',
  error: 'destructive',
};

/**
 * Provider choice. The whole tile is one button that opens the sign-in dialog; while a sign-in
 * runs in the background the tile shows its live status, so progress stays visible with the
 * dialog closed.
 */
export function ProviderTile({
  label,
  caption,
  icon,
  description,
  variant = 'compact',
  status,
  statusLabel,
  onOpen,
}: ProviderTileProps) {
  const { t } = useTranslation();
  const captionId = useId();
  const primary = variant === 'primary';
  const statusBadge =
    status && statusLabel ? (
      <Badge tone={STATUS_TONE[status]} dot>
        {statusLabel}
      </Badge>
    ) : null;

  return (
    <div className={primary ? styles.primary : styles.compact} data-status={status ?? 'idle'}>
      <span className={styles.glyph}>
        <BrandGlyph src={icon} size={primary ? 24 : 18} className={styles.glyphImage} />
      </span>
      <span className={styles.text}>
        <button
          type="button"
          className={styles.main}
          onClick={onOpen}
          aria-haspopup="dialog"
          aria-describedby={captionId}
        >
          {label}
        </button>
        <span className={styles.caption} id={captionId}>
          {primary && description ? (
            <span className={styles.description}>{description}</span>
          ) : null}
          {primary ? (
            <span className={styles.captionLine}>{statusBadge ?? caption}</span>
          ) : (
            (statusBadge ?? <span className={styles.captionText}>{caption}</span>)
          )}
        </span>
      </span>
      {primary ? (
        <span className={styles.cta} aria-hidden="true">
          {t('auth_login.sign_in')}
        </span>
      ) : (
        <span className={styles.trail} aria-hidden="true">
          <IconPlus size={16} />
        </span>
      )}
    </div>
  );
}
