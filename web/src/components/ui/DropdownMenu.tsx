import {
  cloneElement,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PropsWithChildren,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { IconCheck } from './icons';
import styles from './DropdownMenu.module.scss';

const MenuContext = createContext<{ close: () => void } | null>(null);

interface TriggerProps {
  onClick?: (event: MouseEvent<HTMLElement>) => void;
  'aria-haspopup'?: 'menu';
  'aria-expanded'?: boolean;
  'aria-controls'?: string;
}

interface DropdownMenuProps {
  /** A Button or IconButton; it receives click and ARIA props. */
  trigger: ReactElement<TriggerProps>;
  /** Horizontal alignment of the menu relative to the trigger. */
  align?: 'start' | 'end';
  /** Accessible name for the menu. */
  ariaLabel?: string;
  minWidth?: number;
}

/**
 * Menu of actions opened from a trigger button. Compose with
 * DropdownMenuItem and DropdownMenuSeparator.
 */
export function DropdownMenu({
  trigger,
  align = 'end',
  ariaLabel,
  minWidth = 180,
  children,
}: PropsWithChildren<DropdownMenuProps>) {
  const menuId = useId();
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  const close = useCallback(() => {
    setOpen(false);
    setPosition(null);
  }, []);

  const closeAndFocusTrigger = useCallback(() => {
    close();
    anchorRef.current?.querySelector<HTMLElement>('button, [tabindex]')?.focus();
  }, [close]);

  useLayoutEffect(() => {
    if (!open || !anchorRef.current || !menuRef.current) return;
    const anchor = anchorRef.current.getBoundingClientRect();
    const menu = menuRef.current.getBoundingClientRect();
    let left = align === 'end' ? anchor.right - menu.width : anchor.left;
    left = Math.max(8, Math.min(window.innerWidth - menu.width - 8, left));
    let top = anchor.bottom + 4;
    if (top + menu.height > window.innerHeight - 8) top = anchor.top - 4 - menu.height;
    setPosition({ top: Math.max(8, top), left });
  }, [align, open]);

  useEffect(() => {
    if (!open || !position) return;
    menuRef.current?.querySelector<HTMLElement>('[role^="menuitem"]:not(:disabled)')?.focus();
  }, [open, position]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      close();
    };
    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('resize', close);
    };
  }, [close, open]);

  const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not(:disabled)') ?? []
    );
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      closeAndFocusTrigger();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      items[(index + 1) % items.length]?.focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      items[(index - 1 + items.length) % items.length]?.focus();
    } else if (event.key === 'Home') {
      event.preventDefault();
      items[0]?.focus();
    } else if (event.key === 'End') {
      event.preventDefault();
      items[items.length - 1]?.focus();
    } else if (event.key === 'Tab') {
      close();
    }
  };

  const triggerElement = isValidElement(trigger)
    ? cloneElement(trigger, {
        onClick: (event: MouseEvent<HTMLElement>) => {
          trigger.props.onClick?.(event);
          if (open) close();
          else setOpen(true);
        },
        'aria-haspopup': 'menu',
        'aria-expanded': open,
        'aria-controls': open ? menuId : undefined,
      })
    : trigger;

  return (
    <MenuContext.Provider value={{ close: closeAndFocusTrigger }}>
      <span ref={anchorRef} className={styles.anchor}>
        {triggerElement}
      </span>
      {open && typeof document !== 'undefined'
        ? createPortal(
            <div
              ref={menuRef}
              id={menuId}
              role="menu"
              aria-label={ariaLabel}
              className={styles.menu}
              style={{
                minWidth,
                ...(position
                  ? { top: position.top, left: position.left }
                  : { top: -9999, left: -9999, visibility: 'hidden' as const }),
              }}
              onKeyDown={handleMenuKeyDown}
            >
              {children}
            </div>,
            document.body
          )
        : null}
    </MenuContext.Provider>
  );
}

interface DropdownMenuItemProps {
  onSelect: () => void;
  icon?: ReactNode;
  /** Right-aligned hint such as a shortcut. */
  hint?: ReactNode;
  destructive?: boolean;
  disabled?: boolean;
  /** Makes the item a radio option (one of a set) and marks the current one. */
  selected?: boolean;
}

export function DropdownMenuItem({
  onSelect,
  icon,
  hint,
  destructive = false,
  disabled = false,
  selected,
  children,
}: PropsWithChildren<DropdownMenuItemProps>) {
  const menu = useContext(MenuContext);
  const isRadio = typeof selected === 'boolean';
  return (
    <button
      type="button"
      role={isRadio ? 'menuitemradio' : 'menuitem'}
      aria-checked={isRadio ? selected : undefined}
      tabIndex={-1}
      disabled={disabled}
      className={[styles.item, destructive ? styles.destructive : ''].filter(Boolean).join(' ')}
      onClick={() => {
        menu?.close();
        onSelect();
      }}
    >
      {icon ? <span className={styles.icon}>{icon}</span> : null}
      <span className={styles.label}>{children}</span>
      {hint ? <span className={styles.hint}>{hint}</span> : null}
      {selected ? <IconCheck size={16} className={styles.check} /> : null}
    </button>
  );
}

export function DropdownMenuSeparator() {
  return <div role="separator" className={styles.separator} />;
}
