import { useId, type InputHTMLAttributes, type ReactNode } from 'react';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: ReactNode;
  error?: string;
  /** Inline trailing control, e.g. a show/hide IconButton (size="sm"). */
  rightElement?: ReactNode;
}

/** Labelled text field: label above, hint and error below. */
export function Input({
  label,
  hint,
  error,
  rightElement,
  className = '',
  id,
  ...rest
}: InputProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const hintId = hint ? `${inputId}-hint` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  const describedBy =
    [rest['aria-describedby'], errorId, hintId].filter(Boolean).join(' ') || undefined;

  return (
    <div className="form-group">
      {label && <label htmlFor={inputId}>{label}</label>}
      <div className={`input-wrap${rightElement ? ' has-right' : ''}`}>
        <input
          id={inputId}
          className={`input ${className}`.trim()}
          aria-invalid={Boolean(error) || rest['aria-invalid']}
          aria-describedby={describedBy}
          {...rest}
        />
        {rightElement && <div className="input-right">{rightElement}</div>}
      </div>
      {hint && (
        <div id={hintId} className="hint">
          {hint}
        </div>
      )}
      {error && (
        <div id={errorId} className="error-box" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
