/**
 * Providers: API-key upstreams (OpenAI-compatible endpoints, Gemini, Claude API keys, ...)
 * grouped by kind. Subscription accounts live under Accounts, not here.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useProviderRecentRequests } from '@/components/providers/hooks/useProviderRecentRequests';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { DropdownMenu, DropdownMenuItem } from '@/components/ui/DropdownMenu';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconChevronDown, IconSearch } from '@/components/ui/icons';
import { Input } from '@/components/ui/Input';
import { PageHeader } from '@/components/ui/PageHeader';
import { Skeleton } from '@/components/ui/Skeleton';
import { Toolbar } from '@/components/ui/Toolbar';
import { useAuthStore, useNotificationStore, useThemeStore } from '@/stores';
import { clearConnectivityLog, useConnectivityLog } from './connectivityLog';
import { PROVIDER_BRAND_ORDER } from './descriptors';
import { ProviderList } from './components/ProviderList';
import {
  ProviderSheet,
  type ProviderSheetHandle,
  type ProviderSheetState,
} from './sheets/ProviderSheet';
import { useProviderWorkbench } from './useProviderWorkbench';
import type { ProviderBrand, ProviderGroup, ProviderResource } from './types';
import styles from './ProvidersWorkbenchPage.module.scss';

const matchesFilter = (r: ProviderResource, normalized: string): boolean => {
  if (!normalized) return true;
  return [r.identifier, r.name, r.authIndex, r.apiKeyPreview, r.baseUrl, r.proxyUrl, r.prefix]
    .concat(r.models)
    .filter(Boolean)
    .some((v) => String(v).toLowerCase().includes(normalized));
};

const CLOSED_SHEET: ProviderSheetState = {
  open: false,
  brand: 'openaiCompatibility',
  mode: 'detail',
  resource: null,
};

export function ProvidersWorkbenchPage() {
  const { t } = useTranslation();
  const connectionStatus = useAuthStore((s) => s.connectionStatus);
  const resolvedTheme = useThemeStore((s) => s.resolvedTheme);
  const { showNotification, showConfirmation } = useNotificationStore();
  const tests = useConnectivityLog();

  const workbench = useProviderWorkbench();
  const [filter, setFilter] = useState('');
  const [sheetState, setSheetState] = useState<ProviderSheetState>(CLOSED_SHEET);
  const sheetRef = useRef<ProviderSheetHandle>(null);

  const connected = connectionStatus === 'connected';
  const { usageByProvider, refreshRecentRequests } = useProviderRecentRequests({
    enabled: connected,
  });

  const handleRefresh = useCallback(async () => {
    await Promise.allSettled([workbench.refetch(), refreshRecentRequests().catch(() => undefined)]);
  }, [refreshRecentRequests, workbench]);

  const disableMutations =
    !connected || workbench.mutating || workbench.isFetching || workbench.isError;

  const configured = useMemo(
    () => (workbench.snapshot?.groups ?? []).filter((g) => g.resources.length > 0),
    [workbench.snapshot]
  );
  const total = configured.reduce((sum, g) => sum + g.resources.length, 0);

  const visibleGroups = useMemo<ProviderGroup[]>(() => {
    const normalized = filter.trim().toLowerCase();
    if (!normalized) return configured;
    return configured
      .map((g) => ({ ...g, resources: g.resources.filter((r) => matchesFilter(r, normalized)) }))
      .filter((g) => g.resources.length > 0);
  }, [configured, filter]);

  const openSheet = useCallback((next: Omit<ProviderSheetState, 'open'>) => {
    const proceed = sheetRef.current?.confirmDiscardIfDirty() ?? Promise.resolve(true);
    void proceed.then((ok) => {
      if (ok) setSheetState({ ...next, open: true });
    });
  }, []);

  const openCreate = (brand: ProviderBrand) => openSheet({ brand, mode: 'create', resource: null });
  const openView = (resource: ProviderResource) =>
    openSheet({ brand: resource.brand, mode: 'detail', resource });
  const openEdit = (resource: ProviderResource) =>
    openSheet({ brand: resource.brand, mode: 'edit', resource });
  const openTest = (resource: ProviderResource) =>
    openSheet({ brand: resource.brand, mode: 'edit', resource, autoTest: true });

  const closeSheet = useCallback(() => {
    setSheetState((s) => ({ ...s, open: false, autoTest: false }));
  }, []);

  const handleDelete = (resource: ProviderResource) => {
    const name = resource.name ?? resource.apiKeyPreview ?? resource.identifier ?? '';
    showConfirmation({
      title: t('providersPage.delete.title'),
      message: t('providersPage.delete.confirm', { name }),
      variant: 'danger',
      confirmText: t('providersPage.actions.delete'),
      onConfirm: async () => {
        try {
          await workbench.deleteProvider(resource);
          // Rows are identified by position; deleting shifts them.
          clearConnectivityLog();
          showNotification(t('providersPage.toast.deleted'), 'success');
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          showNotification(`${t('notification.delete_failed')}: ${msg}`, 'error');
        }
      },
    });
  };

  const handleToggleEnabled = async (resource: ProviderResource, enabled: boolean) => {
    try {
      await workbench.toggleDisabled(resource, !enabled);
      showNotification(
        enabled ? t('providersPage.toast.enabled') : t('providersPage.toast.disabled'),
        'success'
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showNotification(`${t('providersPage.toast.toggleFailed')}: ${msg}`, 'error');
    }
  };

  const addMenu = (variant: 'primary' | 'secondary') => (
    <DropdownMenu
      ariaLabel={t('providersPage.add.menu')}
      minWidth={220}
      trigger={
        <Button variant={variant} size="sm" disabled={disableMutations}>
          {t('providersPage.add.button')}
          <IconChevronDown size={14} />
        </Button>
      }
    >
      {PROVIDER_BRAND_ORDER.map((brand) => (
        <DropdownMenuItem key={brand} onSelect={() => openCreate(brand)}>
          {t(`providersPage.providerNames.${brand}`)}
        </DropdownMenuItem>
      ))}
    </DropdownMenu>
  );

  const errorBox = workbench.errorMessage ? (
    <div className={`error-box ${styles.errorBox}`} role="alert">
      <span>{t('providersPage.loadFailed', { message: workbench.errorMessage })}</span>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => void handleRefresh()}
        loading={workbench.isFetching}
      >
        {t('providersPage.actions.retry')}
      </Button>
    </div>
  ) : null;

  const renderBody = () => {
    if (!workbench.snapshot && workbench.isPending) {
      return (
        <div className={styles.skeletons} aria-busy="true" aria-label={t('providersPage.loading')}>
          <Skeleton height={20} width={140} />
          <Skeleton height={120} />
          <Skeleton height={20} width={140} />
          <Skeleton height={84} />
        </div>
      );
    }
    if (workbench.isError && total === 0) return null;
    if (total === 0) {
      return (
        <EmptyState
          title={t('providersPage.empty.title')}
          description={t('providersPage.empty.description')}
          action={addMenu('secondary')}
        />
      );
    }
    return (
      <>
        <Toolbar ariaLabel={t('providersPage.list.filters')}>
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t('providersPage.list.search')}
            aria-label={t('providersPage.list.search')}
            rightElement={<IconSearch size={14} />}
            className={styles.search}
          />
        </Toolbar>
        {visibleGroups.length === 0 ? (
          <EmptyState
            title={t('providersPage.list.noMatches')}
            action={
              <Button variant="secondary" size="sm" onClick={() => setFilter('')}>
                {t('providersPage.list.clearSearch')}
              </Button>
            }
          />
        ) : (
          <ProviderList
            groups={visibleGroups}
            tests={tests}
            theme={resolvedTheme}
            selectedId={sheetState.open ? (sheetState.resource?.id ?? null) : null}
            disableMutations={disableMutations}
            onView={openView}
            onEdit={openEdit}
            onTest={openTest}
            onDelete={handleDelete}
            onToggleEnabled={(resource, enabled) => void handleToggleEnabled(resource, enabled)}
          />
        )}
      </>
    );
  };

  return (
    <>
      <PageHeader
        title={t('providersPage.title')}
        description={t('providersPage.description')}
        meta={total > 0 ? <Badge>{total}</Badge> : null}
        actions={addMenu('primary')}
      />
      {errorBox}
      {renderBody()}
      <ProviderSheet
        ref={sheetRef}
        state={sheetState}
        onClose={closeSheet}
        onSwitchToEdit={() => {
          setSheetState((s) => (s.resource ? { ...s, mode: 'edit' } : s));
        }}
        workbench={workbench}
        onCreated={() => {
          showNotification(t('providersPage.toast.created'), 'success');
          closeSheet();
        }}
        onUpdated={() => {
          showNotification(t('providersPage.toast.updated'), 'success');
          closeSheet();
        }}
        mutationDisabled={disableMutations}
        usageByProvider={usageByProvider}
      />
    </>
  );
}
