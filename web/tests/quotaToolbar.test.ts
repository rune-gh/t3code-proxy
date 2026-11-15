import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync('src/features/quota/QuotaPage.tsx', 'utf8');
const styles = readFileSync('src/features/quota/QuotaPage.module.scss', 'utf8');

describe('quota toolbar presentation contracts', () => {
  test('uses a named, explicit clear action and restores input focus', () => {
    expect(source).toContain('type="search"');
    expect(source).toContain('ref={searchInputRef}');
    expect(source).toContain('{search && (');
    expect(source).toContain("aria-label={t('quota_management.search_clear')}");
    // The stock toolbar now sits inside the non-pooled section; match regardless of indentation.
    expect(source).toMatch(/handleSearchChange\(''\);\n\s+searchInputRef\.current\?\.focus\(\);/);
    expect(source).toContain('<IconX size={14} aria-hidden="true" />');
    expect(styles).toMatch(/&::-webkit-search-cancel-button,[\s\S]*?appearance: none;/);
  });

  test('groups search and sorting in one toolbar after the provider filter', () => {
    const filterStart = source.indexOf('<Tabs');
    const toolbarStart = source.indexOf('<Toolbar');
    const sortStart = source.indexOf('<div className={styles.sort}>');
    const searchStart = source.indexOf('<div className={styles.search}>');
    expect(filterStart).toBeGreaterThan(-1);
    expect(toolbarStart).toBeGreaterThan(filterStart);
    // The sort control sits in the toolbar's end slot, the search in its body.
    expect(sortStart).toBeGreaterThan(toolbarStart);
    expect(searchStart).toBeGreaterThan(sortStart);
    expect(styles).toContain('&:focus-within');
    expect(styles).toContain('&:focus-visible');
    expect(styles).toContain('@media (prefers-reduced-motion: reduce)');
  });
});
