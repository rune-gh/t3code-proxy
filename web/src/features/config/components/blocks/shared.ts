// Pure helpers shared by the block editors, kept apart from component files because
// react-refresh only allows component exports there.

import type { useTranslation } from 'react-i18next';
import type {
  PayloadModelEntry,
  PayloadParamValidationErrorCode,
  VisualConfigValidationErrorCode,
} from '@/types/visualConfig';
import { VISUAL_CONFIG_PROTOCOL_OPTIONS } from '@/hooks/useVisualConfig';

export function getValidationMessage(
  t: ReturnType<typeof useTranslation>['t'],
  errorCode?: VisualConfigValidationErrorCode | PayloadParamValidationErrorCode
) {
  if (!errorCode) return undefined;
  return t(`config_management.visual.validation.${errorCode}`);
}

export function buildProtocolOptions(
  t: ReturnType<typeof useTranslation>['t'],
  rules: Array<{ models: PayloadModelEntry[] }>
) {
  const options: Array<{ value: string; label: string }> = VISUAL_CONFIG_PROTOCOL_OPTIONS.map(
    (option) => ({
      value: option.value,
      label: t(option.labelKey, { defaultValue: option.defaultLabel }),
    })
  );
  const seen = new Set<string>(options.map((option) => option.value));

  for (const rule of rules) {
    for (const model of rule.models) {
      const protocol = model.protocol;
      if (!protocol || !protocol.trim() || seen.has(protocol)) continue;
      seen.add(protocol);
      options.push({ value: protocol, label: protocol });
    }
  }

  return options;
}

/** Delay between two strength segments lighting up; all four take 135ms plus 160ms, under 300ms. */
export const SEGMENT_STAGGER_MS = 45;

/**
 * Start delay of a segment fill: only newly lit segments queue; lit segments and turning off
 * never wait. Generating a key lights four segments in a wave; typing one more is immediate.
 */
export function segmentFillDelayMs(
  index: number,
  segments: number,
  previousSegments: number
): number {
  const filled = index < segments;
  if (!filled || index < previousSegments) return 0;
  return (index - Math.max(previousSegments, 0)) * SEGMENT_STAGGER_MS;
}
