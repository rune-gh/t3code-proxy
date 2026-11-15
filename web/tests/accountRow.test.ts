import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

// The quota host binds CSS-module classes at import time, which Bun cannot render.
// Keep these source contracts small; browser checks cover the actual row interactions.
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const source = read('src/features/authFiles/components/AccountRow.tsx');
const page = read('src/features/authFiles/AuthFilesPage.tsx');

describe('account row presentation contract', () => {
  test('shows identity with the file name as mono secondary text', () => {
    expect(source).toContain('{identity.primary}');
    expect(source).toContain('{identity.secondary}');
    expect(source).toContain('className={`mono ${styles.fileName}`}');
  });

  test('uses one enabled switch and account-specific accessible names', () => {
    expect(source.match(/<ToggleSwitch/g)).toHaveLength(1);
    expect(source).toContain("t('auth_files.card_toggle', { name: identity.primary || file.name })");
    expect(source).toContain("t('auth_files.card_select', { name: identity.primary || file.name })");
    expect(source).toContain('checked={!file.disabled}');
    expect(source).toContain('disabled={disableControls || isStatusUpdating || isManualRefreshing}');
  });

  test('pairs every status colour with a text label', () => {
    expect(source).toContain('<Badge tone={STATUS_TONE[status.kind]} dot>');
    expect(source).toContain("t(`auth_files.status_${status.kind}`)");
  });

  test('uses a plain-text weight tooltip while preserving the details link', () => {
    expect(source).toContain("title={t('auth_files.weight_tooltip')}");
    expect(source).not.toContain("title={t('auth_files.weight_hint')}");
    expect(read('src/features/authFiles/components/AuthFileDetailsSheet.tsx')).toContain(
      'i18nKey="auth_files.weight_hint"'
    );
    const { auth_files: messages } = JSON.parse(read('src/i18n/locales/en.json')) as {
      auth_files: Record<string, string>;
    };
    expect(messages.weight_tooltip).not.toMatch(/<[^>]+>/);
    expect(messages.weight_hint).toContain('<settingsLink>');
    expect(messages.weight_tooltip).toBe(messages.weight_hint.replace(/<\/?settingsLink>/g, ''));
  });

  test('keeps every per-account action in the row menu', () => {
    for (const handler of [
      'onShowModels(file)',
      'onDownload(file.name)',
      'onManualRefresh(file)',
      'onCooldownReset(file)',
      'onOpenPrefixProxyEditor(file)',
      'onDelete(file.name)',
    ]) {
      expect(source).toContain(handler);
    }
    expect(source).toContain('{statusMessage && (');
  });

  test('has no always-visible delete-all; bulk delete lives in the selection bar', () => {
    expect(page).not.toContain('handleDeleteAll');
    expect(page).not.toContain('delete_all_button');
    expect(page).toContain('onDelete={() => batchDelete(selectedNames)}');
    expect(read('src/features/authFiles/components/SelectionBar.tsx')).toContain(
      'if (selectionCount === 0) return null;'
    );
  });
});
