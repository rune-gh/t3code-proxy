import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/Badge';
import { Input } from '@/components/ui/Input';
import { PageHeader } from '@/components/ui/PageHeader';
import { Tabs } from '@/components/ui/Tabs';
import { Toolbar } from '@/components/ui/Toolbar';
import { IconAlertTriangle, IconSearch } from '@/components/ui/icons';
import { useAuthStore } from '@/stores';
import type { PluginListEntry, PluginStoreEntry } from '@/types';
import { resolvePluginAssetURL } from './pluginResources';
import { getPluginLogo } from './pluginLogo';
import { getPluginStatus, type PluginRowStatus } from './pluginStatus';
import { filterInstalledPlugins, filterStoreEntries } from './pluginSearch';
import { findPluginUpdate, getStoreEntryKey, getStoreEntryTitle } from './pluginStoreEntries';
import { useInstalledPlugins } from './hooks/useInstalledPlugins';
import { usePluginStore } from './hooks/usePluginStore';
import { usePluginsView } from './hooks/usePluginsView';
import { InstalledPluginsView } from './components/InstalledPluginsView';
import { PluginStoreView } from './components/PluginStoreView';
import { PluginConfigSheet } from './components/PluginConfigSheet';
import { PluginInstallGateModal } from './components/PluginInstallGateModal';
import { PluginInstallOptionsModal } from './components/PluginInstallOptionsModal';
import { StoreLayoutSwitch } from './components/StoreLayoutSwitch';
import {
  pluginViewPanelId,
  pluginViewTabId,
  readStoreLayout,
  writeStoreLayout,
  type StoreLayout,
} from './pluginsView';
import type { PluginRowUpdate } from './components/PluginRow';
import type { StoreRowAction } from './components/StorePluginRow';
import styles from './PluginsPage.module.scss';

export function PluginsPage() {
  const { t, i18n } = useTranslation();
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const apiBase = useAuthStore((state) => state.apiBase);
  const connected = connectionStatus === 'connected';

  const [view, setView] = usePluginsView();
  // The store view mounts on first visit and then stays mounted (hidden), so switching back
  // and forth never replays its first-load stagger or loses expanded descriptions.
  const [storeVisited, setStoreVisited] = useState(view === 'store');
  if (view === 'store' && !storeVisited) setStoreVisited(true);
  const [filter, setFilter] = useState('');
  const [storeLayout, setStoreLayout] = useState<StoreLayout>(readStoreLayout);
  const handleStoreLayoutChange = (layout: StoreLayout) => {
    setStoreLayout(layout);
    writeStoreLayout(layout);
  };

  // Each hook refreshes the other's data after a mutation. The hooks are created in sequence,
  // so the cross-calls go through a ref that is filled in once both exist.
  const reloaders = useRef({ installed: () => {}, store: () => {} });
  const installed = useInstalledPlugins({
    connected,
    onMutated: () => reloaders.current.store(),
  });
  const store = usePluginStore({
    connected,
    actionBusy: installed.actionBusy,
    onInstallSettled: () => reloaders.current.installed(),
  });
  const loadInstalled = installed.load;
  const loadStore = store.load;
  useEffect(() => {
    reloaders.current = {
      installed: () => void loadInstalled(),
      store: () => void loadStore(),
    };
  }, [loadInstalled, loadStore]);

  const loadAll = useCallback(async () => {
    await Promise.all([loadInstalled(), loadStore()]);
  }, [loadInstalled, loadStore]);


  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const data = installed.data;
  // Store data feeds the installed view only when the registry answered; a failed request
  // leaves that view exactly as it is without a store.
  const storeEntries = useMemo(
    () => (store.data && !store.error ? store.data.plugins : []),
    [store.data, store.error]
  );

  const updatesByID = useMemo(() => {
    const map = new Map<string, PluginStoreEntry>();
    for (const plugin of data?.plugins ?? []) {
      const entry = findPluginUpdate(plugin, storeEntries);
      if (entry) map.set(plugin.id, entry);
    }
    return map;
  }, [data?.plugins, storeEntries]);

  const query = filter.trim();
  const visiblePlugins = useMemo(
    () => filterInstalledPlugins(data?.plugins ?? [], query),
    [data?.plugins, query]
  );
  const visibleEntries = useMemo(
    () => filterStoreEntries(store.data?.plugins ?? [], query, i18n.language),
    [store.data?.plugins, query, i18n.language]
  );

  const resolveAsset = useCallback(
    (value: string) => resolvePluginAssetURL(value, apiBase),
    [apiBase]
  );

  const installingKey = store.installingKey;
  const installingEntry = installingKey
    ? store.data?.plugins.find((entry) => getStoreEntryKey(entry) === installingKey)
    : undefined;
  const installingID = installingEntry?.id ?? '';

  const rowStatus = (plugin: PluginListEntry, pluginsEnabled: boolean): PluginRowStatus => {
    if (installed.deletingID === plugin.id) return 'removing';
    if (installed.mutatingID === plugin.id || installingID === plugin.id) return 'applying';
    return getPluginStatus(plugin, pluginsEnabled);
  };

  const rowUpdate = (plugin: PluginListEntry): PluginRowUpdate | null => {
    const entry = updatesByID.get(plugin.id);
    if (!entry) return null;
    const entryKey = getStoreEntryKey(entry);
    const missingAuth = entry.authRequired && !entry.authConfigured;
    return {
      from: entry.installedVersion,
      to: entry.version,
      blockedReason: missingAuth ? t('plugin_store.auth_required_hint') : '',
      installing: installingKey === entryKey,
      disabled:
        !connected ||
        missingAuth ||
        installed.actionBusy ||
        (Boolean(installingKey) && installingKey !== entryKey),
      onUpdate: () => store.openInstall(entry),
    };
  };

  const storeAction = (entry: PluginStoreEntry): StoreRowAction => {
    if (!entry.installed) return { kind: 'install' };
    if (entry.updateAvailable) return { kind: 'update' };
    const plugin = data?.plugins.find((item) => item.id === entry.id);
    return {
      kind: 'installed',
      configureDisabled: Boolean(plugin) && (!connected || installed.actionBusy),
      onConfigure: () => {
        if (plugin) {
          void installed.openConfigSheet(plugin);
        } else {
          setView('installed');
        }
      },
    };
  };

  const restartNames = store.restartRequiredKeys.map((key) => {
    const entry = store.data?.plugins.find((plugin) => getStoreEntryKey(plugin) === key);
    return entry ? getStoreEntryTitle(entry, i18n.language) : key;
  });

  const pluginsEnabled = data?.pluginsEnabled ?? store.data?.pluginsEnabled ?? true;
  const effectiveCount = data?.plugins.filter((plugin) => plugin.effectiveEnabled).length ?? 0;
  const pluginsDir = data?.pluginsDir || 'plugins';

  const viewTabs = (
    <Tabs
      ariaLabel={t('plugin_management.views_label')}
      idPrefix="plugins-view"
      value={view}
      onChange={setView}
      items={[
        {
          value: 'installed',
          label: (
            <>
              {t('plugin_management.view_installed')}
              {updatesByID.size > 0 ? (
                <>
                  <span className={styles.updateDot} aria-hidden="true" />
                  <span className="sr-only">{t('plugin_management.updates_available')}</span>
                </>
              ) : null}
            </>
          ),
          count: data ? data.plugins.length : undefined,
        },
        {
          value: 'store',
          label: t('plugin_management.view_store'),
          count: store.data ? store.data.plugins.length : undefined,
        },
      ]}
    />
  );

  return (
    <div className={styles.page}>
      <PageHeader
        title={t('plugin_management.title')}
        description={t('plugin_management.description')}
        meta={
          data ? (
            <Badge tone={data.pluginsEnabled ? 'success' : 'neutral'} dot>
              {data.pluginsEnabled
                ? t('plugin_management.global_on')
                : t('plugin_management.global_off')}
            </Badge>
          ) : undefined
        }
        tabs={viewTabs}
      />

      {!pluginsEnabled ? (
        <p className={styles.notice} role="note">
          <IconAlertTriangle size={14} />
          <span>{t('plugin_management.global_disabled_hint')}</span>
        </p>
      ) : null}
      {restartNames.length > 0 ? (
        <p className={styles.notice} role="status">
          <IconAlertTriangle size={14} />
          <span>
            {t('plugin_store.restart_required_banner', { plugins: restartNames.join(', ') })}
          </span>
        </p>
      ) : null}

      <Toolbar
        ariaLabel={t('plugin_management.toolbar_label')}
        end={
          view === 'store' ? (
            <StoreLayoutSwitch
              value={storeLayout}
              onChange={handleStoreLayoutChange}
              className={styles.layoutSwitch}
            />
          ) : data ? (
            <span className={styles.summary}>
              {t('plugin_management.summary_effective', {
                effective: effectiveCount,
                total: data.plugins.length,
              })}
              <span aria-hidden="true"> · </span>
              <span className="mono">{pluginsDir}</span>
            </span>
          ) : null
        }
      >
        <Input
          type="search"
          className={styles.search}
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder={t('plugin_management.search_placeholder')}
          aria-label={t('plugin_management.search_label')}
          rightElement={<IconSearch size={14} />}
        />
      </Toolbar>

      <section
        id={pluginViewPanelId('installed')}
        role="tabpanel"
        aria-labelledby={pluginViewTabId('installed')}
        className={styles.panel}
        hidden={view !== 'installed'}
      >
        <InstalledPluginsView
          data={data}
          loading={installed.loading}
          error={installed.error}
          plugins={visiblePlugins}
          query={query}
          getLogo={(plugin) => resolveAsset(getPluginLogo(plugin, storeEntries))}
          getStatus={rowStatus}
          getChecked={(plugin) =>
            installed.pendingToggle?.id === plugin.id
              ? installed.pendingToggle.enabled
              : plugin.enabled
          }
          getUpdate={rowUpdate}
          isRowDisabled={(plugin) =>
            !connected || installed.actionBusy || installingID === plugin.id
          }
          onToggle={installed.togglePlugin}
          onConfigure={installed.openConfigSheet}
          onDelete={installed.deletePlugin}
          onClearSearch={() => setFilter('')}
          onBrowseStore={() => setView('store')}
        />
      </section>

      {storeVisited ? (
        <section
          id={pluginViewPanelId('store')}
          role="tabpanel"
          aria-labelledby={pluginViewTabId('store')}
          className={styles.panel}
          hidden={view !== 'store'}
        >
          <PluginStoreView
            data={store.data}
            error={store.error}
            loading={store.loading}
            entries={visibleEntries}
            layout={storeLayout}
            query={query}
            connected={connected}
            actionBusy={installed.actionBusy}
            installingKey={installingKey}
            getLogo={(entry) => resolveAsset(entry.logo)}
            getAction={storeAction}
            onInstall={store.openInstall}
            onRetry={() => void loadStore()}
            onClearSearch={() => setFilter('')}
          />
        </section>
      ) : null}

      <PluginConfigSheet
        plugin={installed.editingPlugin}
        draft={installed.draft}
        saving={installed.savingConfig}
        onClose={installed.closeConfigSheet}
        onSave={installed.saveConfig}
        onDraftChange={installed.updateDraft}
      />
      <PluginInstallGateModal {...store.gateProps} />
      <PluginInstallOptionsModal {...store.installOptionsProps} />
    </div>
  );
}
