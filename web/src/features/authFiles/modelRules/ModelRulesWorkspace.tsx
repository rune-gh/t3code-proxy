import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { Skeleton } from '@/components/ui/Skeleton';
import { Tabs } from '@/components/ui/Tabs';
import { IconChevronLeft, IconFilterAll, IconNetwork, IconPlus } from '@/components/ui/icons';
import { FloatingSaveBar } from '@/features/config/components/FloatingSaveBar';
import { useEdgeSwipeBack } from '@/hooks/useEdgeSwipeBack';
import type { ModelRulesKind, ModelRulesStatus } from './useModelRulesData';
import styles from './ModelRules.module.scss';

export type ProviderRailItem = {
  key: string;
  label: string;
  icon: string | null;
  /** Rules or mappings for this provider; 0 means not configured yet. */
  count: number;
  dirty: boolean;
};

type ProviderRailProps = {
  items: readonly ProviderRailItem[];
  selected: string;
  total: number;
  disabled: boolean;
  onSelect: (provider: string) => void;
};

/**
 * Provider rail: both the filter and the "add" entry point. Unconfigured providers are
 * listed too; selecting one starts editing it, so there is no separate add page.
 */
export function ProviderRail({ items, selected, total, disabled, onSelect }: ProviderRailProps) {
  const { t } = useTranslation();
  const [custom, setCustom] = useState('');
  const railRef = useRef<HTMLElement | null>(null);

  // On narrow screens the rail scrolls sideways: bring the current item into view by
  // adjusting the rail's own scrollLeft only, never the page scroll.
  useEffect(() => {
    const rail = railRef.current;
    if (!rail || rail.scrollWidth <= rail.clientWidth) return;
    const active = rail.querySelector<HTMLElement>('[aria-current="true"]');
    if (!active) return;
    const railBox = rail.getBoundingClientRect();
    const box = active.getBoundingClientRect();
    if (box.left >= railBox.left && box.right <= railBox.right) return;
    rail.scrollLeft += box.left - railBox.left - (railBox.width - box.width) / 2;
  }, [selected]);

  const submitCustom = (event: FormEvent) => {
    event.preventDefault();
    const value = custom.trim();
    if (!value) return;
    onSelect(value);
    setCustom('');
  };

  return (
    <nav className={styles.rail} aria-label={t('model_rules.rail_label')} ref={railRef}>
      <div className={styles.railList}>
        <button
          type="button"
          className={`${styles.railItem} ${selected === '' ? styles.railItemActive : ''}`}
          aria-current={selected === '' ? 'true' : undefined}
          onClick={() => onSelect('')}
        >
          <span className={styles.railIcon} aria-hidden="true">
            <IconFilterAll size={15} />
          </span>
          <span className={styles.railLabel}>{t('model_rules.scope_all')}</span>
          <span className={styles.railCount}>{total}</span>
        </button>
        {items.map((item) => {
          const active = item.key === selected;
          return (
            <button
              key={item.key}
              type="button"
              className={[
                styles.railItem,
                active ? styles.railItemActive : '',
                item.count === 0 && !item.dirty ? styles.railItemIdle : '',
              ]
                .filter(Boolean)
                .join(' ')}
              aria-current={active ? 'true' : undefined}
              onClick={() => onSelect(item.key)}
            >
              <span className={styles.railIcon} aria-hidden="true">
                {item.icon ? <img src={item.icon} alt="" /> : <IconNetwork size={15} />}
              </span>
              <span className={styles.railLabel}>{item.label}</span>
              {item.dirty ? (
                <span
                  className={styles.railDirty}
                  role="img"
                  aria-label={t('model_rules.unsaved_mark')}
                />
              ) : null}
              <span className={styles.railCount}>{item.count > 0 ? item.count : '+'}</span>
            </button>
          );
        })}
      </div>
      <form className={styles.railCustom} onSubmit={submitCustom}>
        <IconPlus size={14} aria-hidden="true" />
        <input
          value={custom}
          onChange={(event) => setCustom(event.target.value)}
          placeholder={t('model_rules.custom_provider_placeholder')}
          aria-label={t('model_rules.custom_provider_label')}
          disabled={disabled}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          enterKeyHint="go"
        />
      </form>
    </nav>
  );
}

export type ModelRulesWorkspaceProps = {
  kind: ModelRulesKind;
  title: string;
  description: string;
  /** Counts shown after the title, e.g. ['3 providers', '14 mappings']. */
  meta: readonly string[];
  status: ModelRulesStatus;
  errorMessage: string;
  unsupportedTitle: string;
  unsupportedDescription: string;
  onRetry: () => void;
  onBack: () => void;
  onSwitchKind: (kind: ModelRulesKind) => void;
  headerExtra?: ReactNode;
  rail?: ReactNode;
  dirtyCount: number;
  saving: boolean;
  canSave: boolean;
  onSave: () => void;
  onDiscard: () => void;
  children?: ReactNode;
};

export function ModelRulesWorkspace({
  kind,
  title,
  description,
  meta,
  status,
  errorMessage,
  unsupportedTitle,
  unsupportedDescription,
  onRetry,
  onBack,
  onSwitchKind,
  headerExtra,
  rail,
  dirtyCount,
  saving,
  canSave,
  onSave,
  onDiscard,
  children,
}: ModelRulesWorkspaceProps) {
  const { t } = useTranslation();
  const swipeRef = useEdgeSwipeBack({ onBack });
  const dirty = dirtyCount > 0;
  // Keep the last non-zero count while the save bar exits, so it never flashes "0 providers".
  const [shownCount, setShownCount] = useState(dirtyCount);
  if (dirty && shownCount !== dirtyCount) setShownCount(dirtyCount);

  // Cmd/Ctrl+S saves when there are unsaved changes.
  useEffect(() => {
    if (!dirty || !canSave) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        onSave();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [canSave, dirty, onSave]);

  const kindTabs = [
    { value: 'excluded' as const, label: t('model_rules.kind_excluded') },
    { value: 'alias' as const, label: t('model_rules.kind_alias') },
  ];

  return (
    <div className={styles.page} ref={swipeRef}>
      <div className={styles.headerBlock}>
        <button type="button" className={styles.back} onClick={onBack}>
          <IconChevronLeft size={16} aria-hidden="true" />
          {t('nav.auth_files')}
        </button>
        <PageHeader
          title={title}
          description={description}
          meta={
            meta.length > 0 ? <span className={styles.meta}>{meta.join(' · ')}</span> : undefined
          }
          actions={status === 'ready' ? headerExtra : undefined}
          tabs={
            <Tabs<ModelRulesKind>
              ariaLabel={t('model_rules.section_label')}
              items={kindTabs}
              value={kind}
              onChange={(next) => {
                if (next !== kind) onSwitchKind(next);
              }}
            />
          }
        />
      </div>

      {status === 'loading' ? (
        <div className={styles.workspace} aria-busy="true" aria-label={t('common.loading')}>
          <div className={styles.railSkeleton} aria-hidden="true">
            <Skeleton height={220} rounded={8} />
          </div>
          <div className={styles.stage} aria-hidden="true">
            <Skeleton height={120} rounded={8} />
            <Skeleton height={120} rounded={8} />
          </div>
        </div>
      ) : status === 'unsupported' ? (
        <EmptyState title={unsupportedTitle} description={unsupportedDescription} />
      ) : status === 'error' ? (
        <EmptyState
          title={t('notification.refresh_failed')}
          description={errorMessage || undefined}
          action={
            <Button variant="secondary" size="sm" onClick={onRetry}>
              {t('common.refresh')}
            </Button>
          }
        />
      ) : (
        <div className={`${styles.workspace} ${rail ? '' : styles.workspaceWide}`}>
          {rail}
          <div className={styles.stage}>{children}</div>
        </div>
      )}

      {/* Same save bar as Settings: it appears only while there are unsaved changes. */}
      <FloatingSaveBar
        visible={dirty}
        statusText={t('model_rules.unsaved_count', { count: shownCount })}
        statusTone={saving ? 'busy' : 'warning'}
        saving={saving}
        saveDisabled={!canSave}
        discardDisabled={saving}
        onSave={onSave}
        onDiscard={onDiscard}
      />
    </div>
  );
}
