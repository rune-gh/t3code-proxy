import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import i18n from '@/i18n';
import en from '@/i18n/locales/en.json';

describe('i18n bootstrap', () => {
  test('the entry point initializes i18n before rendering', () => {
    // Nothing else imports '@/i18n' for its side effect, so the entry must.
    expect(readFileSync('src/main.tsx', 'utf8')).toContain("import '@/i18n';");
  });

  test('English is the only, active and fallback language', () => {
    expect(i18n.language).toBe('en');
    expect(i18n.options.fallbackLng).toEqual(['en']);
    expect(Object.keys(i18n.options.resources ?? {})).toEqual(['en']);
    expect(i18n.t('nav.dashboard')).toBe(en.nav.dashboard);
  });
});
