interface SpinnerProps {
  size?: number;
  className?: string;
  /** Accessible status text; omit when the spinner sits next to visible text. */
  label?: string;
}

/** Indeterminate spinner that inherits `currentColor`. */
export function LoadingSpinner({ size = 16, className = '', label }: SpinnerProps) {
  return (
    <span
      className={`loading-spinner${className ? ` ${className}` : ''}`}
      style={{ width: size, height: size, borderWidth: Math.max(1.5, size / 8) }}
      role="status"
      aria-live="polite"
      aria-label={label}
    />
  );
}

export const Spinner = LoadingSpinner;
