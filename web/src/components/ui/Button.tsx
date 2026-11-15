import type { ButtonHTMLAttributes, PropsWithChildren, ReactNode } from 'react';

/**
 * Button variants. `danger` is kept as an alias of `destructive` for older
 * call sites.
 */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'destructive' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  loading?: boolean;
}

const buttonClassName = (
  variant: ButtonVariant,
  size: ButtonSize,
  extra: Array<string | false | undefined>
) =>
  [
    'btn',
    // `btn-danger` stays the emitted class so feature overrides keep matching.
    `btn-${variant === 'destructive' ? 'danger' : variant}`,
    size !== 'md' ? `btn-${size}` : '',
    ...extra,
  ]
    .filter(Boolean)
    .join(' ');

export function Button({
  children,
  variant = 'primary',
  size = 'md',
  fullWidth = false,
  loading = false,
  className = '',
  disabled,
  ...rest
}: PropsWithChildren<ButtonProps>) {
  const hasChildren = children !== null && children !== undefined && children !== false;
  const classes = buttonClassName(variant, size, [fullWidth && 'btn-full', className]);

  return (
    <button
      className={classes}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading && <span className="loading-spinner" aria-hidden="true" />}
      {hasChildren && <span>{children}</span>}
    </button>
  );
}

export interface IconButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'aria-label' | 'children'
> {
  /** Accessible name; also used as the native tooltip unless `title` is set. */
  'aria-label': string;
  icon: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
}

/** Square, icon-only button. An accessible label is required. */
export function IconButton({
  icon,
  variant = 'ghost',
  size = 'md',
  loading = false,
  className = '',
  disabled,
  title,
  type = 'button',
  ...rest
}: IconButtonProps) {
  return (
    <button
      type={type}
      className={buttonClassName(variant, size, ['btn-icon', className])}
      disabled={disabled || loading}
      title={title ?? rest['aria-label']}
      {...rest}
    >
      {loading ? <span className="loading-spinner" aria-hidden="true" /> : icon}
    </button>
  );
}
