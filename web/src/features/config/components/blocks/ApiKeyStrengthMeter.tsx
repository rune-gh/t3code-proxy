import { memo, useEffect, useMemo, useRef, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import {
  API_KEY_STRENGTH_SEGMENTS,
  evaluateApiKeyStrength,
  type ApiKeyStrengthTier,
} from '@/utils/apiKeyStrength';
import { segmentFillDelayMs } from './shared';
import styles from './Blocks.module.scss';

// Three status colours; the segment count tells the fourth tier apart.
const TIER_COLORS: Record<ApiKeyStrengthTier, string> = {
  weak: 'var(--destructive-foreground)',
  fair: 'var(--warning)',
  good: 'var(--success)',
  strong: 'var(--success)',
};

const SEGMENT_INDEXES = Array.from({ length: API_KEY_STRENGTH_SEGMENTS }, (_, index) => index);

/**
 * Strength hint for a hand-written API key: four segments light in turn. It only labels the tier and never blocks saving.
 */
export const ApiKeyStrengthMeter = memo(function ApiKeyStrengthMeter({ value }: { value: string }) {
  const { t } = useTranslation();
  const { tier, segments } = useMemo(() => evaluateApiKeyStrength(value), [value]);

  // The previous segment count decides which segments queue; read during render, advanced after commit
  const previousSegments = useRef(segments);
  const cascadeFrom = previousSegments.current;
  useEffect(() => {
    previousSegments.current = segments;
  }, [segments]);

  const empty = segments === 0;
  const tierLabel = empty
    ? t('config_management.visual.api_keys.strength.empty')
    : t(`config_management.visual.api_keys.strength.${tier}`);

  return (
    <div
      className={styles.strengthMeter}
      style={
        {
          '--strength-color': empty ? 'var(--faint-foreground)' : TIER_COLORS[tier],
        } as CSSProperties
      }
    >
      <div
        className={styles.strengthTrack}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={API_KEY_STRENGTH_SEGMENTS}
        aria-valuenow={segments}
        aria-valuetext={tierLabel}
        aria-label={t('config_management.visual.api_keys.strength.label')}
      >
        {SEGMENT_INDEXES.map((index) => (
          <span key={index} className={styles.strengthSegment}>
            <span
              className={styles.strengthSegmentFill}
              data-filled={index < segments}
              style={
                {
                  '--segment-delay': `${segmentFillDelayMs(index, segments, cascadeFrom)}ms`,
                } as CSSProperties
              }
            />
          </span>
        ))}
      </div>
      <span className={styles.strengthLabel} aria-hidden="true">
        {empty ? '—' : tierLabel}
      </span>
    </div>
  );
});
