import { expect, test } from 'bun:test';
import en from '@/i18n/locales/en.json';

test('provider advanced editors have complete English translations', () => {
  for (const section of ['runtimePolicy', 'modelOptions', 'behavior'] as const) {
    const keys = Object.keys(en.providersPage[section]);
    expect(keys.length).toBeGreaterThan(0);
    expect(
      Object.values(en.providersPage[section]).every(
        (value) => typeof value === 'string' && value.trim().length > 0
      )
    ).toBe(true);
  }
});
