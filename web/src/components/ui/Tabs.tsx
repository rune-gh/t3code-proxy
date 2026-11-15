import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import styles from './Tabs.module.scss';

export interface TabItem<T extends string = string> {
  value: T;
  label: ReactNode;
  /** 16px icon shown before the label. */
  icon?: ReactNode;
  /** Optional count shown after the label. */
  count?: number;
  disabled?: boolean;
}

interface TabsProps<T extends string> {
  items: ReadonlyArray<TabItem<T>>;
  value: T;
  onChange: (value: T) => void;
  /** Names the tab list for screen readers. */
  ariaLabel: string;
  /**
   * `underline` switches between views of a page (sits in PageHeader's tabs row).
   * `segmented` picks a mode or filter inside a Toolbar.
   */
  variant?: 'underline' | 'segmented';
  size?: 'sm' | 'md';
  className?: string;
  /** id prefix; tab ids are `${idPrefix}-tab-${value}` for aria-controls wiring. */
  idPrefix?: string;
}

/** Tab list with roving focus; arrow keys, Home and End move between tabs. */
export function Tabs<T extends string>({
  items,
  value,
  onChange,
  ariaLabel,
  variant = 'underline',
  size = 'md',
  className,
  idPrefix,
}: TabsProps<T>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const enabled = items.map((item, index) => (item.disabled ? -1 : index)).filter((i) => i >= 0);

  const focusAt = (index: number) => {
    const item = items[index];
    if (!item) return;
    onChange(item.value);
    refs.current[index]?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = items.findIndex((item) => item.value === value);
    const position = enabled.indexOf(current);
    let next: number | undefined;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      next = enabled[(position + 1) % enabled.length];
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      next = enabled[(position - 1 + enabled.length) % enabled.length];
    } else if (event.key === 'Home') {
      next = enabled[0];
    } else if (event.key === 'End') {
      next = enabled[enabled.length - 1];
    }
    if (next === undefined) return;
    event.preventDefault();
    focusAt(next);
  };

  const cls = [
    styles.list,
    variant === 'segmented' ? styles.segmented : styles.underline,
    size === 'sm' ? styles.sm : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={cls} role="tablist" aria-label={ariaLabel} onKeyDown={handleKeyDown}>
      {items.map((item, index) => {
        const selected = item.value === value;
        return (
          <button
            key={item.value}
            ref={(element) => {
              refs.current[index] = element;
            }}
            type="button"
            role="tab"
            id={idPrefix ? `${idPrefix}-tab-${item.value}` : undefined}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            disabled={item.disabled}
            className={styles.tab}
            onClick={() => onChange(item.value)}
          >
            {item.icon}
            <span>{item.label}</span>
            {typeof item.count === 'number' ? (
              <span className={styles.count}>{item.count}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/** Same control, named for its use as a mode picker inside toolbars. */
export function SegmentedControl<T extends string>(props: Omit<TabsProps<T>, 'variant'>) {
  return <Tabs {...props} variant="segmented" />;
}
