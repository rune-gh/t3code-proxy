import { describe, expect, test } from 'bun:test';
import { mergeSettledQuota } from '../src/features/quota/hooks/useSettledQuota';

type State = { status: 'idle' | 'loading' | 'success' | 'error'; value?: number };
const byType = (states: Record<string, State>) => ({ xai: states });

describe('settled quota reads', () => {
  test('a re-read keeps the last settled state until it settles again', () => {
    const settled = byType({ a: { status: 'success', value: 1 }, b: { status: 'error' } });
    const loading = mergeSettledQuota(
      settled,
      byType({ a: { status: 'loading' }, b: { status: 'loading' } })
    );
    expect(loading.xai.a).toEqual({ status: 'success', value: 1 });
    expect(loading.xai.b).toEqual({ status: 'error' });
    const done = mergeSettledQuota(
      loading,
      byType({ a: { status: 'success', value: 2 }, b: { status: 'loading' } })
    );
    expect(done.xai.a).toEqual({ status: 'success', value: 2 });
    expect(done.xai.b).toEqual({ status: 'error' });
  });

  test('an account that never settled passes through, and removed accounts are dropped', () => {
    const next = mergeSettledQuota(
      byType({ gone: { status: 'success', value: 9 } }),
      byType({ fresh: { status: 'loading' } })
    );
    expect(next.xai).toEqual({ fresh: { status: 'loading' } });
  });
});
