import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { Skeleton } from '@/components/ui/Skeleton';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { pluginsApi } from '@/services/api';
import { useAuthStore } from '@/stores';
import { getErrorMessage, isRecord } from '@/utils/helpers';
import type { PluginListResponse } from '@/types';
import {
  collectPluginResourceEntries,
  PLUGIN_RESOURCES_REFRESH_EVENT,
  resolvePluginAssetURL,
} from './pluginResources';
import styles from './PluginResourcePage.module.scss';

const hasStatus = (error: unknown, status: number) => isRecord(error) && error.status === status;

const safeDecodeURIComponent = (value = '') => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const parseMenuIndex = (value = '') => {
  const index = Number.parseInt(value, 10);
  return Number.isInteger(index) && index >= 0 ? index : -1;
};

export function PluginResourcePage() {
  const { t } = useTranslation();
  const params = useParams<{ pluginId: string; menuIndex: string }>();
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const apiBase = useAuthStore((state) => state.apiBase);

  const [data, setData] = useState<PluginListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const connected = connectionStatus === 'connected';
  const pluginID = useMemo(() => safeDecodeURIComponent(params.pluginId), [params.pluginId]);
  const menuIndex = useMemo(() => parseMenuIndex(params.menuIndex), [params.menuIndex]);

  const loadResource = useCallback(async () => {
    if (!connected) {
      setLoading(false);
      setError(t('notification.connection_required'));
      return;
    }

    setLoading(true);
    setError('');
    try {
      const plugins = await pluginsApi.list();
      setData(plugins);
    } catch (err: unknown) {
      setError(
        hasStatus(err, 404)
          ? t('plugin_management.unsupported_backend')
          : getErrorMessage(err, t('plugin_resource.load_failed'))
      );
    } finally {
      setLoading(false);
    }
  }, [connected, t]);

  useHeaderRefresh(loadResource, connected);

  useEffect(() => {
    void loadResource();
  }, [loadResource]);

  useEffect(() => {
    window.addEventListener(PLUGIN_RESOURCES_REFRESH_EVENT, loadResource);

    return () => {
      window.removeEventListener(PLUGIN_RESOURCES_REFRESH_EVENT, loadResource);
    };
  }, [loadResource]);

  const resource = useMemo(() => {
    const entries = collectPluginResourceEntries(data?.plugins ?? []);
    return entries.find((entry) => entry.pluginID === pluginID && entry.menuIndex === menuIndex);
  }, [data?.plugins, menuIndex, pluginID]);

  const iframeSrc = resource ? resolvePluginAssetURL(resource.menu.path, apiBase) : '';

  const title = resource?.label || pluginID;

  return (
    <div className={styles.page}>
      <PageHeader
        title={title}
        description={
          resource && resource.description && resource.description !== title
            ? resource.description
            : resource && resource.pluginTitle !== title
              ? t('plugin_resource.provided_by', { plugin: resource.pluginTitle })
              : undefined
        }
      />
      {loading ? (
        <div className={styles.stateShell} aria-busy="true">
          <Skeleton height="100%" />
          <span className="sr-only">{t('common.loading')}</span>
        </div>
      ) : error ? (
        <div className={styles.errorRow}>
          <div className="error-box" role="alert">
            {t('plugin_resource.unavailable')}: {error}
          </div>
          <Button variant="secondary" size="sm" onClick={() => void loadResource()}>
            {t('plugin_resource.retry')}
          </Button>
        </div>
      ) : !resource ? (
        <EmptyState
          title={t('plugin_resource.not_found')}
          description={t('plugin_resource.not_found_desc')}
        />
      ) : !iframeSrc ? (
        <EmptyState
          title={t('plugin_resource.empty_src')}
          description={t('plugin_resource.empty_src_desc')}
        />
      ) : (
        <div className={styles.frameShell}>
          <iframe
            className={styles.frame}
            src={iframeSrc}
            title={resource.label}
            referrerPolicy="no-referrer"
            allow="clipboard-read; clipboard-write"
          />
        </div>
      )}
    </div>
  );
}
