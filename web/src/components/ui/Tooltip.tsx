import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type PropsWithChildren,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import styles from './Tooltip.module.scss';

type TooltipSide = 'top' | 'right' | 'bottom' | 'left';

interface TooltipProps {
  /** Short text; a label plus optional hint (e.g. a shortcut). */
  content: ReactNode;
  side?: TooltipSide;
  /** Hover delay in ms; keyboard focus shows immediately. */
  delay?: number;
  /** Disable without unmounting the trigger (e.g. labels already visible). */
  disabled?: boolean;
  /** Class for the wrapper span; use it to make the wrapper `display: block`. */
  className?: string;
}

const GAP = 8;
const MARGIN = 8;

/**
 * Hover and focus tooltip for icon-only controls and truncated text. The
 * trigger must still carry its own accessible name; the tooltip is added as a
 * description.
 */
export function Tooltip({
  content,
  side = 'top',
  delay = 300,
  disabled = false,
  className,
  children,
}: PropsWithChildren<TooltipProps>) {
  const id = useId();
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const timerRef = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const show = useCallback(
    (immediate: boolean) => {
      if (disabled) return;
      clearTimer();
      if (immediate) setOpen(true);
      else timerRef.current = window.setTimeout(() => setOpen(true), delay);
    },
    [delay, disabled]
  );

  const hide = useCallback(() => {
    clearTimer();
    setOpen(false);
    setPosition(null);
  }, []);

  useEffect(() => clearTimer, []);

  useEffect(() => {
    if (disabled) hide();
  }, [disabled, hide]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') hide();
    };
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', hide, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', hide, true);
    };
  }, [hide, open]);

  useLayoutEffect(() => {
    if (!open || !anchorRef.current || !tipRef.current) return;
    const anchor = anchorRef.current.getBoundingClientRect();
    const tip = tipRef.current.getBoundingClientRect();
    const horizontal = side === 'right' || side === 'left';
    const top = horizontal
      ? anchor.top + anchor.height / 2 - tip.height / 2
      : side === 'bottom'
        ? anchor.bottom + GAP
        : anchor.top - GAP - tip.height;
    const left = !horizontal
      ? anchor.left + anchor.width / 2 - tip.width / 2
      : side === 'right'
        ? anchor.right + GAP
        : anchor.left - GAP - tip.width;
    const maxLeft = window.innerWidth - tip.width - MARGIN;
    const maxTop = window.innerHeight - tip.height - MARGIN;
    setPosition({
      top: Math.max(MARGIN, Math.min(maxTop, top)),
      left: Math.max(MARGIN, Math.min(maxLeft, left)),
    });
  }, [open, side, content]);

  return (
    <>
      <span
        ref={anchorRef}
        className={[styles.anchor, className].filter(Boolean).join(' ')}
        aria-describedby={open ? id : undefined}
        onMouseEnter={() => show(false)}
        onMouseLeave={hide}
        onFocus={(event) => {
          if ((event.target as HTMLElement).matches(':focus-visible')) show(true);
        }}
        onBlur={hide}
        onClick={hide}
      >
        {children}
      </span>
      {open && typeof document !== 'undefined'
        ? createPortal(
            <div
              ref={tipRef}
              id={id}
              role="tooltip"
              className={styles.tooltip}
              style={
                position
                  ? { top: position.top, left: position.left }
                  : { top: -9999, left: -9999, visibility: 'hidden' }
              }
            >
              {content}
            </div>,
            document.body
          )
        : null}
    </>
  );
}
