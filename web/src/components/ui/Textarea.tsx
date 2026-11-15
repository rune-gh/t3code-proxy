import { useId, type ReactNode, type TextareaHTMLAttributes } from 'react';

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  hint?: ReactNode;
  error?: string;
  /** Use the monospace face, for keys, JSON or YAML snippets. */
  mono?: boolean;
}

/** Labelled multi-line field with the same anatomy as `Input`. */
export function Textarea({
  label,
  hint,
  error,
  mono = false,
  className = '',
  id,
  rows = 4,
  ...rest
}: TextareaProps) {
  const generatedId = useId();
  const fieldId = id ?? generatedId;
  const hintId = hint ? `${fieldId}-hint` : undefined;
  const errorId = error ? `${fieldId}-error` : undefined;
  const describedBy =
    [rest['aria-describedby'], errorId, hintId].filter(Boolean).join(' ') || undefined;

  return (
    <div className="form-group">
      {label && <label htmlFor={fieldId}>{label}</label>}
      <textarea
        id={fieldId}
        rows={rows}
        className={[mono ? 'mono' : '', className].filter(Boolean).join(' ') || undefined}
        aria-invalid={Boolean(error) || rest['aria-invalid']}
        aria-describedby={describedBy}
        {...rest}
      />
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
