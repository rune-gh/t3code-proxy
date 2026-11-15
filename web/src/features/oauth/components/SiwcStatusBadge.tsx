import { useTranslation } from 'react-i18next';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import type { SiwcBindingStatus } from '../siwcBinding';

const TONE: Record<SiwcBindingStatus, BadgeTone> = {
  active: 'success',
  bound: 'warning',
  unbound: 'neutral',
};

/**
 * SIWC binding status: dot plus a short word. `withLabel` drops the "SIWC" prefix where the
 * context already says it (inside the SIWC dialog).
 */
export function SiwcStatusBadge({
  status,
  withLabel = true,
}: {
  status: SiwcBindingStatus;
  withLabel?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Badge tone={TONE[status]} dot data-status={status}>
      {withLabel ? `SIWC ${t(`siwc.${status}`)}` : t(`siwc.${status}`)}
    </Badge>
  );
}
