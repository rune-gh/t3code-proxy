// Search jump: reveal the target section (the collapsed Advanced group opens) -> wait for the
// row to mount -> open any enclosing details -> scroll it to the centre -> pulse for 1800ms.

import { useCallback, useEffect, useRef, useState } from 'react';
import { prefersReducedMotion } from '@/hooks/motion';
import type { VisualConfigValues } from '@/types/visualConfig';
import { FIELD_HIGHLIGHT_CLASS } from '../components/fields/FieldPrimitives';
import type { ConfigSectionId } from '../constants';
import {
  configFieldDomId,
  type ConfigFieldSearchEntry,
  type VisualSectionId,
} from '../searchIndex';

export type UseFieldJumpArgs = {
  values: VisualConfigValues;
  /** Makes the section visible (opens Advanced for long-tail sections). */
  revealSection: (id: ConfigSectionId) => void;
};

export function useFieldJump({ values, revealSection }: UseFieldJumpArgs) {
  // A fresh object per jump; the effect handles it once (guarded by handledJumpRef) so it
  // never needs to clear state from inside the effect.
  const [jumpRequest, setJumpRequest] = useState<{
    fieldId: string;
    sectionId: VisualSectionId;
  } | null>(null);
  const handledJumpRef = useRef<{ fieldId: string; sectionId: VisualSectionId } | null>(null);
  const highlightTimerRef = useRef<number | null>(null);
  const highlightedElRef = useRef<HTMLElement | null>(null);

  const jumpToField = useCallback(
    (entry: ConfigFieldSearchEntry) => {
      revealSection(entry.sectionId);
      setJumpRequest({ fieldId: entry.fieldId, sectionId: entry.sectionId });
    },
    [revealSection]
  );

  // Imperatively scroll to and pulse-highlight the jumped-to field once it has mounted.
  useEffect(() => {
    if (!jumpRequest || handledJumpRef.current === jumpRequest) return;
    handledJumpRef.current = jumpRequest; // handle each request once, even if deps re-fire
    const { fieldId } = jumpRequest;
    // TLS cert and key rows are hidden while TLS is off; point at the TLS switch instead.
    const targetFieldId =
      (fieldId === 'tlsCert' || fieldId === 'tlsKey') && !values.tlsEnable ? 'tlsEnable' : fieldId;

    const attempt = (retriesLeft: number) => {
      const el = document.getElementById(configFieldDomId(targetFieldId));
      if (!el) {
        // The Advanced group may not have committed yet; retry on the next frame.
        if (retriesLeft > 0) requestAnimationFrame(() => attempt(retriesLeft - 1));
        return;
      }

      // Open every enclosing <details> (the Advanced group) and, when the anchor wraps a
      // group itself (payload rule groups), the details inside it.
      for (
        let node = el.closest('details');
        node;
        node = node.parentElement?.closest('details') ?? null
      ) {
        if (!node.open) node.open = true;
      }
      const inner = el.querySelector('details');
      if (inner && !inner.open) inner.open = true;

      // Clear any in-flight highlight before starting a new one.
      if (highlightTimerRef.current !== null) {
        clearTimeout(highlightTimerRef.current);
        highlightedElRef.current?.classList.remove(FIELD_HIGHLIGHT_CLASS);
      }

      el.scrollIntoView({
        behavior: prefersReducedMotion() ? 'auto' : 'smooth',
        block: 'center',
        inline: 'nearest',
      });
      el.classList.add(FIELD_HIGHLIGHT_CLASS);
      highlightedElRef.current = el;
      highlightTimerRef.current = window.setTimeout(() => {
        el.classList.remove(FIELD_HIGHLIGHT_CLASS);
        highlightTimerRef.current = null;
        highlightedElRef.current = null;
      }, 1800);
    };

    requestAnimationFrame(() => attempt(1));
  }, [jumpRequest, values.tlsEnable]);

  // Clear the highlight timer on unmount.
  useEffect(
    () => () => {
      if (highlightTimerRef.current !== null) clearTimeout(highlightTimerRef.current);
    },
    []
  );

  return { jumpToField };
}
