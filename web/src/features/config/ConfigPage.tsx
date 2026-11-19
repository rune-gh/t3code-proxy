import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import { usePageTransitionLayer } from '@/components/common/PageTransitionLayer';
import { Badge } from '@/components/ui/Badge';
import { Button, IconButton } from '@/components/ui/Button';
import { IconRefreshCw } from '@/components/ui/icons';
import { PageHeader } from '@/components/ui/PageHeader';
import { Skeleton } from '@/components/ui/Skeleton';
import { Tabs } from '@/components/ui/Tabs';
import { Toolbar } from '@/components/ui/Toolbar';
import { prefersReducedMotion } from '@/hooks/motion';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { useUnsavedChangesGuard } from '@/hooks/useUnsavedChangesGuard';
import { useVisualConfig } from '@/hooks/useVisualConfig';
import { useAuthStore, useNotificationStore, useThemeStore } from '@/stores';
import {
  ADVANCED_SECTION_IDS,
  CONFIG_MODE_STORAGE_KEY,
  CONFIG_SECTION_IDS,
  LEGACY_STORAGE_KEYS,
  PRIMARY_SECTION_IDS,
  configSectionDomId,
  isAdvancedSection,
  type ConfigEditorMode,
  type ConfigSectionId,
} from './constants';
import {
  countSectionErrors,
  countTotalErrors,
  readSavedMode,
  resolveDirtyFieldIds,
  resolveDirtySections,
  resolveStatus,
} from './uiState';
import { findConfigFieldById } from './searchIndex';
import { shouldReloadVisualDraft, useConfigDocument } from './hooks/useConfigDocument';
import { useFieldJump } from './hooks/useFieldJump';
import { useSourceSearch } from './hooks/useSourceSearch';
import { ConfigNavList, ConfigNavSelect } from './components/ConfigNav';
import { ConfigSearch } from './components/ConfigSearch';
import { DirtyFieldIdsContext } from './components/fields/dirtyFieldIds';
import { DiffModal } from './components/DiffModal';
import { SourcePanel, SourceSearchBar } from './components/SourcePanel';
import type { ConfigSectionProps } from './types';
import { SectionAccess } from './components/sections/SectionAccess';
import { SectionDiscovery } from './components/sections/SectionDiscovery';
import { SectionLogging } from './components/sections/SectionLogging';
import { SectionManagement } from './components/sections/SectionManagement';
import { SectionNetwork } from './components/sections/SectionNetwork';
import { SectionPayload } from './components/sections/SectionPayload';
import { SectionPlugins } from './components/sections/SectionPlugins';
import { SectionProviders } from './components/sections/SectionProviders';
import { SectionQuotaHistory } from './components/sections/SectionQuotaHistory';
import { SectionRouting } from './components/sections/SectionRouting';
import { SectionServer } from './components/sections/SectionServer';
import { SectionStreaming } from './components/sections/SectionStreaming';
import styles from './ConfigPage.module.scss';

const SECTION_COMPONENTS: Record<
  Exclude<ConfigSectionId, 'payload'>,
  (props: ConfigSectionProps) => React.ReactElement
> = {
  access: SectionAccess,
  management: SectionManagement,
  server: SectionServer,
  routing: SectionRouting,
  quotaHistory: SectionQuotaHistory,
  logging: SectionLogging,
  network: SectionNetwork,
  streaming: SectionStreaming,
  providers: SectionProviders,
  plugins: SectionPlugins,
  discovery: SectionDiscovery,
};

export function ConfigPage() {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const requestedFieldEntry = useMemo(() => {
    const fieldId = new URLSearchParams(location.search).get('field');
    return findConfigFieldById(fieldId);
  }, [location.search]);
  const pageTransitionLayer = usePageTransitionLayer();
  const isCurrentLayer = pageTransitionLayer ? pageTransitionLayer.isCurrentLayer : true;
  const showNotification = useNotificationStore((state) => state.showNotification);
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const resolvedTheme = useThemeStore((state) => state.resolvedTheme);
  const isNarrow = useMediaQuery('(max-width: 960px)');

  const {
    visualValues,
    visualDirty,
    visualDirtyFields,
    visualParseError,
    visualValidationErrors,
    visualHasPayloadValidationErrors,
    loadVisualValuesFromYaml,
    rebaseVisualValuesFromYaml,
    applyVisualChangesToYaml,
    setVisualValues,
  } = useVisualConfig();

  const [mode, setMode] = useState<ConfigEditorMode>(() =>
    requestedFieldEntry ? 'visual' : readSavedMode(localStorage.getItem(CONFIG_MODE_STORAGE_KEY))
  );
  const [activeSection, setActiveSection] = useState<ConfigSectionId>(
    () => requestedFieldEntry?.sectionId ?? 'access'
  );
  const [advancedOpen, setAdvancedOpen] = useState(
    () => requestedFieldEntry !== undefined && isAdvancedSection(requestedFieldEntry.sectionId)
  );
  const handledRequestedFieldRef = useRef<string | null>(null);

  // Retired layouts (simple/full mode, active tab) persisted keys of their own.
  useEffect(() => {
    LEGACY_STORAGE_KEYS.forEach((key) => localStorage.removeItem(key));
  }, []);

  const doc = useConfigDocument({
    mode,
    visualDirty,
    visualParseError,
    loadVisualValuesFromYaml,
    rebaseVisualValuesFromYaml,
    applyVisualChangesToYaml,
  });
  const sourceSearch = useSourceSearch();

  const disableControls = connectionStatus !== 'connected';
  const hasVisualModeError = !!visualParseError;
  const totalErrors = useMemo(
    () => countTotalErrors(visualValidationErrors, visualHasPayloadValidationErrors),
    [visualHasPayloadValidationErrors, visualValidationErrors]
  );
  const hasVisualValidationErrors = mode === 'visual' && totalErrors > 0;
  const errorCounts = useMemo(
    () => countSectionErrors(visualValidationErrors, visualHasPayloadValidationErrors),
    [visualHasPayloadValidationErrors, visualValidationErrors]
  );
  const dirtySections = useMemo(() => resolveDirtySections(visualDirtyFields), [visualDirtyFields]);
  const dirtyFieldIds = useMemo(() => resolveDirtyFieldIds(visualDirtyFields), [visualDirtyFields]);
  const advancedErrors = ADVANCED_SECTION_IDS.some((id) => errorCounts[id] > 0);

  const unsavedChangesDialog = useMemo(
    () => ({
      title: t('common.unsaved_changes_title'),
      message: t('common.unsaved_changes_message'),
      confirmText: t('common.leave'),
      cancelText: t('common.stay'),
    }),
    [t]
  );

  useUnsavedChangesGuard({
    enabled: isCurrentLayer,
    shouldBlock: doc.isDirty,
    dialog: unsavedChangesDialog,
  });

  // A YAML parse failure switches to the YAML editor; once fixed, visual mode can be retried.
  useEffect(() => {
    if (mode !== 'visual' || !visualParseError) return;

    setMode('source');
    localStorage.setItem(CONFIG_MODE_STORAGE_KEY, 'source');
    showNotification(
      t('config_management.visual_mode_unavailable_detail', { message: visualParseError }),
      'error'
    );
  }, [mode, showNotification, t, visualParseError]);

  // Mode hand-off of dirty state:
  // to YAML: materialise visual edits for viewing without recording them as source edits;
  // to visual: a YAML draft must be saved or discarded first; a view-only round trip keeps
  // the field-level dirty state.
  const handleModeChange = useCallback(
    (nextMode: ConfigEditorMode) => {
      if (nextMode === mode) return;
      if (nextMode === 'visual' && doc.sourceDirty) {
        showNotification(t('config_management.source_changes_before_visual'), 'warning');
        return;
      }

      if (nextMode === 'source') {
        if (visualDirty) {
          // content may be an earlier local source preview, not a server readback.
          const nextContent = applyVisualChangesToYaml(doc.content, 'draft');
          if (nextContent !== doc.content) {
            doc.syncContentFromVisual(nextContent);
          }
        }
      } else if (shouldReloadVisualDraft(doc.sourceDirty, visualParseError)) {
        const result = loadVisualValuesFromYaml(doc.content);
        if (!result.ok) {
          showNotification(
            t('config_management.visual_mode_unavailable_detail', { message: result.error }),
            'error'
          );
          return;
        }
      }

      setMode(nextMode);
      localStorage.setItem(CONFIG_MODE_STORAGE_KEY, nextMode);
    },
    [
      applyVisualChangesToYaml,
      doc,
      loadVisualValuesFromYaml,
      mode,
      showNotification,
      t,
      visualDirty,
      visualParseError,
    ]
  );

  const revealSection = useCallback((id: ConfigSectionId) => {
    setActiveSection(id);
    if (isAdvancedSection(id)) setAdvancedOpen(true);
  }, []);

  const scrollToSection = useCallback(
    (id: ConfigSectionId) => {
      revealSection(id);
      requestAnimationFrame(() => {
        document.getElementById(configSectionDomId(id))?.scrollIntoView({
          behavior: prefersReducedMotion() ? 'auto' : 'smooth',
          block: 'start',
        });
      });
    },
    [revealSection]
  );

  const { jumpToField } = useFieldJump({ values: visualValues, revealSection });

  useEffect(() => {
    if (!requestedFieldEntry || handledRequestedFieldRef.current === requestedFieldEntry.fieldId) {
      return;
    }

    handledRequestedFieldRef.current = requestedFieldEntry.fieldId;
    localStorage.setItem(CONFIG_MODE_STORAGE_KEY, 'visual');
    jumpToField(requestedFieldEntry);

    const nextSearchParams = new URLSearchParams(location.search);
    nextSearchParams.delete('field');
    const nextSearch = nextSearchParams.toString();
    void navigate(
      {
        pathname: location.pathname,
        search: nextSearch ? `?${nextSearch}` : '',
        hash: location.hash,
      },
      { replace: true }
    );
  }, [
    jumpToField,
    location.hash,
    location.pathname,
    location.search,
    navigate,
    requestedFieldEntry,
  ]);

  // Highlight the section nearest the top of the viewport while scrolling.
  const showVisual = mode === 'visual' && !doc.loading && !doc.error;
  useEffect(() => {
    if (!showVisual || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        const id = visible?.target.id.replace('config-section-', '') as ConfigSectionId;
        if (id && (CONFIG_SECTION_IDS as readonly string[]).includes(id)) setActiveSection(id);
      },
      { rootMargin: '0px 0px -70% 0px' }
    );
    for (const id of CONFIG_SECTION_IDS) {
      const element = document.getElementById(configSectionDomId(id));
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
  }, [showVisual, advancedOpen]);

  const status = resolveStatus({
    disconnected: disableControls,
    loading: doc.loading,
    loadFailed: Boolean(doc.error),
    yamlError: hasVisualModeError,
    validationBlocked: hasVisualValidationErrors,
    saving: doc.saving,
    dirty: doc.isDirty,
  });

  const saveDisabled =
    disableControls ||
    doc.loading ||
    doc.saving ||
    !doc.isDirty ||
    doc.diffModalOpen ||
    hasVisualModeError ||
    hasVisualValidationErrors;

  const sectionProps: ConfigSectionProps = {
    values: visualValues,
    validationErrors: visualValidationErrors,
    disabled:
      disableControls || doc.loading || doc.saving || doc.diffModalOpen || doc.recoveryRequired,
    onChange: setVisualValues,
  };

  const renderSection = (id: ConfigSectionId) => {
    if (id === 'payload') {
      return (
        <SectionPayload
          key={id}
          {...sectionProps}
          hasPayloadValidationErrors={visualHasPayloadValidationErrors}
        />
      );
    }
    const Section = SECTION_COMPONENTS[id];
    return <Section key={id} {...sectionProps} />;
  };

  const dirtyBadge = doc.sourceDirty ? (
    <Badge tone="warning" dot>
      {t('config_management.meta_dirty_source')}
    </Badge>
  ) : visualDirtyFields.size > 0 ? (
    <Badge tone="warning" dot>
      {t('config_management.meta_dirty', { count: visualDirtyFields.size })}
    </Badge>
  ) : null;

  const statusNote =
    doc.saveError || status.key === 'validation_blocked' || status.key === 'yaml_error' ? (
      <span className={styles.statusError} role="alert">
        {doc.saveError
          ? t('config_management.save_failed_detail', { message: doc.saveError })
          : t(status.labelKey)}
      </span>
    ) : doc.recoveryRequired ? (
      <span className={styles.statusError} role="alert">
        {t('config_management.precise_save_recovery_required')}
      </span>
    ) : null;

  const navProps = { active: activeSection, errorCounts, dirtySections, onSelect: scrollToSection };

  return (
    <div className={styles.page}>
      <PageHeader
        title={t('config_management.title')}
        description={t('config_management.description')}
        meta={
          <>
            {dirtyBadge}
            {mode === 'visual' && totalErrors > 0 ? (
              <Badge tone="destructive">
                {t('config_management.meta_errors', { count: totalErrors })}
              </Badge>
            ) : null}
          </>
        }
        actions={
          <>
            {statusNote}
            <IconButton
              variant="ghost"
              aria-label={t('config_management.reload')}
              icon={<IconRefreshCw size={16} />}
              disabled={doc.loading || doc.saving}
              onClick={doc.handleReload}
            />
            <Button
              variant="secondary"
              disabled={!doc.isDirty || doc.loading || doc.saving}
              onClick={doc.handleDiscard}
            >
              {t('config_management.actions.discard')}
            </Button>
            <Button
              variant="primary"
              loading={doc.saving}
              disabled={saveDisabled}
              onClick={() => void doc.handleSave()}
            >
              {doc.saving
                ? t('config_management.status_saving_short')
                : t('config_management.save')}
            </Button>
          </>
        }
        tabs={
          <Tabs
            ariaLabel={t('config_management.mode.label')}
            items={[
              { value: 'visual', label: t('config_management.mode.visual') },
              { value: 'source', label: t('config_management.mode.source') },
            ]}
            value={mode}
            onChange={(next) => handleModeChange(next as ConfigEditorMode)}
          />
        }
      />

      {doc.error ? (
        <div className={`error-box ${styles.loadError}`} role="alert">
          <span>{t('config_management.load_failed_detail', { message: doc.error })}</span>
          <Button variant="secondary" size="sm" onClick={() => void doc.loadConfig()}>
            {t('config_management.retry')}
          </Button>
        </div>
      ) : null}
      {!doc.error && visualParseError ? (
        <div className="error-box" role="alert">
          {t('config_management.visual_mode_unavailable_detail', { message: visualParseError })}
        </div>
      ) : null}
      {disableControls && !doc.error ? (
        <div className="hint">{t('config_management.status_disconnected')}</div>
      ) : null}

      {mode === 'source' ? (
        <>
          <Toolbar ariaLabel={t('config_management.search_placeholder')}>
            <SourceSearchBar search={sourceSearch} disabled={disableControls || doc.loading} />
          </Toolbar>
          <SourcePanel
            search={sourceSearch}
            value={doc.content}
            onChange={doc.handleChange}
            theme={resolvedTheme}
            editable={!disableControls && !doc.loading && !doc.saving && !doc.diffModalOpen}
          />
        </>
      ) : doc.loading ? (
        <SettingsSkeleton />
      ) : doc.error ? null : (
        <div className={styles.layout}>
          <aside className={styles.aside}>
            <div className={styles.asideInner}>
              <ConfigSearch disabled={disableControls} onJump={jumpToField} />
              {isNarrow ? <ConfigNavSelect {...navProps} /> : <ConfigNavList {...navProps} />}
            </div>
          </aside>

          <DirtyFieldIdsContext.Provider value={dirtyFieldIds}>
            <div className={styles.content}>
              {PRIMARY_SECTION_IDS.map(renderSection)}

              <details
                className={styles.advanced}
                open={advancedOpen || advancedErrors}
                onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
              >
                <summary className={styles.advancedSummary}>
                  <span className={styles.advancedTitle}>
                    {t('config_management.advanced.title')}
                  </span>
                  <span className={styles.advancedHint}>
                    {t('config_management.advanced.hint')}
                  </span>
                </summary>
                <div className={styles.advancedBody}>{ADVANCED_SECTION_IDS.map(renderSection)}</div>
              </details>
            </div>
          </DirtyFieldIdsContext.Provider>
        </div>
      )}

      <DiffModal
        open={doc.diffModalOpen}
        original={doc.serverYaml}
        modified={doc.mergedYaml}
        onConfirm={doc.handleConfirmSave}
        onCancel={doc.closeDiff}
        loading={doc.saving}
      />
    </div>
  );
}

function SettingsSkeleton() {
  const { t } = useTranslation();
  return (
    <div
      className={styles.layout}
      aria-busy="true"
      aria-label={t('config_management.status_loading')}
    >
      <aside className={styles.aside}>
        <div className={styles.asideInner}>
          <Skeleton height={32} />
          {Array.from({ length: 6 }, (_, index) => (
            <Skeleton key={index} height={22} width="70%" />
          ))}
        </div>
      </aside>
      <div className={styles.content}>
        {Array.from({ length: 3 }, (_, section) => (
          <div key={section} className={styles.skeletonSection}>
            <Skeleton height={16} width={140} />
            <Skeleton height={12} width="45%" />
            <Skeleton height={section === 0 ? 120 : 168} rounded={8} />
          </div>
        ))}
      </div>
    </div>
  );
}
