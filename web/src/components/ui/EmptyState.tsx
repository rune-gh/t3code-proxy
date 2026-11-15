import type { ReactNode } from 'react';
import { IconInbox } from './icons';

interface EmptyStateProps {
  title: string;
  description?: ReactNode;
  /** One or two buttons; the main one may be `variant="primary"`. */
  action?: ReactNode;
  /** 16px icon; defaults to an inbox. Pass `null` to hide it. */
  icon?: ReactNode;
  className?: string;
}

/** Centred placeholder for an empty list, an unconfigured feature or a filter with no match. */
export function EmptyState({ title, description, action, icon, className }: EmptyStateProps) {
  const resolvedIcon = icon === undefined ? <IconInbox size={16} /> : icon;
  return (
    <div className={className ? `empty-state ${className}` : 'empty-state'}>
      <div className="empty-content">
        {resolvedIcon ? (
          <div className="empty-icon" aria-hidden="true">
            {resolvedIcon}
          </div>
        ) : null}
        <div>
          <div className="empty-title">{title}</div>
          {description && <div className="empty-desc">{description}</div>}
        </div>
      </div>
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}
