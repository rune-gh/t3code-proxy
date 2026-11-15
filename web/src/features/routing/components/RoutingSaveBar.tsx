import { useLayoutEffect, useRef, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { useActionBarHeightVar } from '@/hooks/useActionBarHeightVar';
import styles from './RoutingSaveBar.module.scss';

/** Bar width cap; it centres over the page column. */
const MAX_WIDTH = 560;

export interface RoutingSaveBarProps {
  /** Visible while the draft differs from the board (same condition as the leave guard). */
  visible: boolean;
  count: number;
  saving: boolean;
  saveDisabled: boolean;
  /** Shown instead of the count when saving is blocked by an invalid field. */
  blockedMessage?: string | null;
  onSave: () => void;
  onDiscard: () => void;
  /** The page column the bar centres over. */
  layoutRef: RefObject<HTMLElement | null>;
}

/**
 * Unsaved-changes bar docked to the bottom of the viewport. It is portalled to the body because
 * the page-transition layer clips and is not the scroll container, so sticky positioning inside
 * the page would not follow the viewport.
 */
export function RoutingSaveBar({
  visible,
  count,
  saving,
  saveDisabled,
  blockedMessage,
  onSave,
  onDiscard,
  layoutRef,
}: RoutingSaveBarProps) {
  const { t } = useTranslation();
  const dockRef = useRef<HTMLDivElement | null>(null);

  useActionBarHeightVar(dockRef, '--routing-action-bar-height', visible);

  // Follow the page column through window resizes and sidebar collapse without re-rendering.
  useLayoutEffect(() => {
    const dock = dockRef.current;
    const layout = layoutRef.current;
    if (!visible || !dock || !layout) return;
    const place = () => {
      const area = layout.getBoundingClientRect();
      const width = Math.min(area.width, MAX_WIDTH);
      dock.style.left = `${area.left + (area.width - width) / 2}px`;
      dock.style.width = `${width}px`;
    };
    place();
    window.addEventListener('resize', place);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    observer?.observe(layout);
    return () => {
      window.removeEventListener('resize', place);
      observer?.disconnect();
    };
  }, [visible, layoutRef]);

  if (!visible || typeof document === 'undefined') return null;

  return createPortal(
    <div ref={dockRef} className={styles.dock}>
      <div className={styles.bar} role="region" aria-label={t('routing.dirty_region')}>
        <span className={blockedMessage ? styles.statusBlocked : styles.status} aria-live="polite">
          {blockedMessage ?? t('routing.dirty_count', { count })}
        </span>
        <div className={styles.actions}>
          <Button variant="ghost" size="sm" onClick={onDiscard} disabled={saving}>
            {t('routing.discard')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={onSave}
            loading={saving}
            disabled={saveDisabled}
          >
            {t('routing.save')}
          </Button>
        </div>
      </div>
    </div>,
    document.body
  );
}
