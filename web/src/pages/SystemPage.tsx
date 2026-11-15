import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { parse as parseYaml } from 'yaml';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconExternalLink, IconSearch } from '@/components/ui/icons';
import { Input } from '@/components/ui/Input';
import { PageHeader } from '@/components/ui/PageHeader';
import { Section } from '@/components/ui/Section';
import { Skeleton } from '@/components/ui/Skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/Table';
import { Toolbar } from '@/components/ui/Toolbar';
import { useApiKeysForModels } from '@/hooks/useApiKeysForModels';
import { apiClient, modelsApi } from '@/services/api';
import { useAuthStore, useModelsStore, useNotificationStore } from '@/stores';
import { STORAGE_KEY_AUTH } from '@/utils/constants';
import { formatDateTimeValue } from '@/utils/format';
import { classifyModels } from '@/utils/models';
import styles from './SystemPage.module.scss';

const PROJECT_REPOSITORY_URL = 'https://github.com/rune-oai/t3code-proxy';

type HubFacts = { commit: string; authDir: string };

/** Commit (response header) and auth directory (oauth.auth-dir) from one config read. */
async function fetchHubFacts(): Promise<HubFacts> {
  const response = await apiClient.getRaw('/config.yaml', {
    responseType: 'text',
    headers: { Accept: 'application/yaml, text/yaml, text/plain' },
  });
  const header = (response.headers as Record<string, unknown> | undefined)?.['x-cpa-commit'];
  let authDir = '';
  try {
    const parsed: unknown = parseYaml(typeof response.data === 'string' ? response.data : '');
    const oauth = (parsed as Record<string, unknown> | null)?.oauth;
    const value = (oauth as Record<string, unknown> | undefined)?.['auth-dir'];
    if (typeof value === 'string') authDir = value.trim();
  } catch {
    // An unreadable document only hides the auth directory; Settings reports the YAML error.
  }
  return { commit: typeof header === 'string' ? header.trim() : '', authDir };
}

export function SystemPage() {
  const { t, i18n } = useTranslation();
  const showNotification = useNotificationStore((state) => state.showNotification);
  const showConfirmation = useNotificationStore((state) => state.showConfirmation);
  const auth = useAuthStore();
  const connected = auth.connectionStatus === 'connected';

  const models = useModelsStore((state) => state.models);
  const modelsStoreLoading = useModelsStore((state) => state.loading);
  const fetchModelsFromStore = useModelsStore((state) => state.fetchModels);
  const resolveApiKeysForModels = useApiKeysForModels();

  const [facts, setFacts] = useState<HubFacts | null>(null);
  const [factsError, setFactsError] = useState('');
  const [factsLoading, setFactsLoading] = useState(true);
  const [modelsError, setModelsError] = useState('');
  const [modelsRequestLoading, setModelsRequestLoading] = useState(false);
  const [syncingCatalog, setSyncingCatalog] = useState(false);
  const [query, setQuery] = useState('');
  const modelsRequestId = useRef(0);
  const catalogRequestId = useRef(0);
  const factsRequestId = useRef(0);
  const modelsLoading = modelsStoreLoading || modelsRequestLoading;

  const unknown = t('system_info.version_unknown');
  const buildDate = formatDateTimeValue(auth.serverBuildDate, i18n.language) || unknown;

  const loadFacts = useCallback(async () => {
    const requestId = ++factsRequestId.current;
    setFactsLoading(true);
    setFactsError('');
    try {
      const next = await fetchHubFacts();
      if (requestId !== factsRequestId.current) return;
      setFacts(next);
    } catch (error: unknown) {
      if (requestId !== factsRequestId.current) return;
      setFactsError(error instanceof Error ? error.message : '');
    } finally {
      if (requestId === factsRequestId.current) setFactsLoading(false);
    }
  }, []);

  const fetchModels = async ({ forceRefresh = false, notify = false } = {}) => {
    const requestId = ++modelsRequestId.current;
    const revision = apiClient.getConnectionRevision();
    const isCurrent = () =>
      requestId === modelsRequestId.current && revision === apiClient.getConnectionRevision();
    if (!connected || !auth.apiBase) {
      setModelsError(t('notification.connection_required'));
      return;
    }
    setModelsError('');
    setModelsRequestLoading(true);
    try {
      const apiKeys = await resolveApiKeysForModels({ force: forceRefresh });
      if (!isCurrent()) return;
      const list = await fetchModelsFromStore(auth.apiBase, apiKeys[0], forceRefresh);
      if (!isCurrent()) return;
      if (notify) {
        showNotification(
          t('system_info.models_refresh_success', { count: list.length }),
          'success'
        );
      }
    } catch (error: unknown) {
      if (!isCurrent()) return;
      const message = error instanceof Error ? error.message : '';
      const text = `${t('system_info.models_error')}${message ? `: ${message}` : ''}`;
      setModelsError(text);
      if (notify) showNotification(text, 'error');
    } finally {
      if (isCurrent()) setModelsRequestLoading(false);
    }
  };

  const handleCatalogRefresh = async () => {
    if (syncingCatalog || modelsLoading || !connected) return;
    const requestId = ++catalogRequestId.current;
    const revision = apiClient.getConnectionRevision();
    const isCurrent = () =>
      requestId === catalogRequestId.current && revision === apiClient.getConnectionRevision();
    setSyncingCatalog(true);
    try {
      await modelsApi.refreshCatalog(isCurrent);
      if (!isCurrent()) return;
      await fetchModels({ forceRefresh: true });
      if (!isCurrent()) return;
      showNotification(t('system_info.models_catalog_refresh_success'), 'success');
    } catch (error: unknown) {
      if (!isCurrent()) return;
      const message = error instanceof Error ? error.message : '';
      showNotification(
        `${t('system_info.models_catalog_refresh_failed')}${message ? `: ${message}` : ''}`,
        'error'
      );
    } finally {
      if (isCurrent()) setSyncingCatalog(false);
    }
  };

  const handleClearLoginStorage = () => {
    showConfirmation({
      title: t('system_info.clear_login_confirm_title'),
      message: t('system_info.clear_login_confirm'),
      variant: 'danger',
      confirmText: t('system_info.clear_login_button'),
      cancelText: t('common.cancel'),
      onConfirm: () => {
        auth.logout();
        if (typeof localStorage === 'undefined') return;
        for (const key of [STORAGE_KEY_AUTH, 'isLoggedIn', 'apiBase', 'apiUrl', 'managementKey']) {
          localStorage.removeItem(key);
        }
        showNotification(t('notification.login_storage_cleared'), 'success');
      },
    });
  };

  useEffect(() => {
    if (!connected) return;
    void loadFacts();
  }, [connected, auth.apiBase, loadFacts]);

  useEffect(() => {
    setModelsRequestLoading(false);
    setSyncingCatalog(false);
    void fetchModels();
    return () => {
      modelsRequestId.current += 1;
      catalogRequestId.current += 1;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth.connectionStatus, auth.apiBase, auth.managementKey]);

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return classifyModels(models, { otherLabel: t('system_info.models_group_other') })
      .flatMap((group) => group.items.map((model) => ({ ...model, group: group.label })))
      .filter(
        (model) =>
          !needle ||
          [model.name, model.alias ?? '', model.group].some((value) =>
            value.toLowerCase().includes(needle)
          )
      );
  }, [models, query, t]);

  const factRows: Array<{ key: string; label: string; value: React.ReactNode; mono?: boolean }> = [
    {
      key: 'server',
      label: t('system_info.fact_server_version'),
      value: auth.serverVersion || unknown,
      mono: Boolean(auth.serverVersion),
    },
    {
      key: 'commit',
      label: t('system_info.fact_commit'),
      value: factsLoading ? <Skeleton width={96} height={14} /> : facts?.commit || unknown,
      mono: Boolean(facts?.commit),
    },
    { key: 'build', label: t('system_info.fact_build_date'), value: buildDate },
    {
      key: 'panel',
      label: t('system_info.fact_panel_version'),
      value: __APP_VERSION__ || unknown,
      mono: Boolean(__APP_VERSION__),
    },
    {
      key: 'address',
      label: t('system_info.fact_address'),
      value: auth.apiBase || unknown,
      mono: Boolean(auth.apiBase),
    },
    {
      key: 'connection',
      label: t('system_info.fact_connection'),
      value: (
        <Badge tone={connected ? 'success' : 'neutral'} dot>
          {t(`common.${auth.connectionStatus}_status`)}
        </Badge>
      ),
    },
    {
      key: 'authDir',
      label: t('system_info.fact_auth_dir'),
      value: factsLoading ? (
        <Skeleton width={140} height={14} />
      ) : (
        facts?.authDir || t('system_info.fact_auth_dir_default')
      ),
      mono: Boolean(facts?.authDir),
    },
    {
      key: 'project',
      label: t('system_info.fact_project'),
      value: (
        <a
          className={styles.link}
          href={PROJECT_REPOSITORY_URL}
          target="_blank"
          rel="noopener noreferrer"
        >
          rune-oai/t3code-proxy
          <IconExternalLink size={14} aria-hidden="true" />
        </a>
      ),
    },
  ];

  return (
    <>
      <PageHeader title={t('system_info.title')} description={t('system_info.description')} />

      <Section title={t('system_info.about_title')}>
        {factsError ? (
          <div className={`error-box ${styles.inlineError}`} role="alert">
            <span>{t('system_info.facts_error', { message: factsError })}</span>
            <Button variant="secondary" size="sm" onClick={() => void loadFacts()}>
              {t('system_info.retry')}
            </Button>
          </div>
        ) : null}
        <dl className={styles.facts}>
          {factRows.map((row) => (
            <div key={row.key} className={styles.fact}>
              <dt>{row.label}</dt>
              <dd className={row.mono ? 'mono' : undefined}>{row.value}</dd>
            </div>
          ))}
        </dl>
        <p className={styles.note}>{t('system_info.facts_note')}</p>
      </Section>

      <Section title={t('system_info.maintenance_title')}>
        <div className={styles.actions}>
          <div className={styles.action}>
            <div className={styles.actionCopy}>
              <span className={styles.actionLabel}>
                {t('system_info.models_catalog_refresh_button')}
              </span>
              <span className={styles.actionHint}>
                {t('system_info.models_catalog_refresh_hint')}
              </span>
            </div>
            <Button
              variant="secondary"
              size="sm"
              loading={syncingCatalog}
              disabled={modelsLoading || !connected}
              onClick={() => void handleCatalogRefresh()}
            >
              {t('system_info.models_catalog_refresh_button')}
            </Button>
          </div>
          <div className={styles.action}>
            <div className={styles.actionCopy}>
              <span className={styles.actionLabel}>{t('system_info.clear_login_title')}</span>
              <span className={styles.actionHint}>{t('system_info.clear_login_desc')}</span>
            </div>
            <Button variant="destructive" size="sm" onClick={handleClearLoginStorage}>
              {t('system_info.clear_login_button')}
            </Button>
          </div>
        </div>
      </Section>

      <Section
        title={t('system_info.models_title')}
        description={t('system_info.models_desc')}
        actions={
          <Button
            variant="secondary"
            size="sm"
            loading={modelsLoading}
            disabled={syncingCatalog || !connected}
            onClick={() => void fetchModels({ forceRefresh: true, notify: true })}
          >
            {t('system_info.models_refresh_button')}
          </Button>
        }
      >
        <Toolbar
          ariaLabel={t('system_info.models_search')}
          end={
            models.length > 0 ? (
              <span className={styles.count}>
                {t('system_info.models_count', { count: rows.length })}
              </span>
            ) : null
          }
        >
          <Input
            className={styles.search}
            value={query}
            placeholder={t('system_info.models_search')}
            aria-label={t('system_info.models_search')}
            onChange={(event) => setQuery(event.target.value)}
            rightElement={<IconSearch size={16} aria-hidden="true" />}
          />
        </Toolbar>

        {modelsError && models.length === 0 ? (
          <div className={`error-box ${styles.inlineError}`} role="alert">
            <span>{modelsError}</span>
            {connected ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void fetchModels({ forceRefresh: true })}
              >
                {t('system_info.retry')}
              </Button>
            ) : null}
          </div>
        ) : modelsLoading && models.length === 0 ? (
          <div
            className={styles.skeletonRows}
            aria-busy="true"
            aria-label={t('system_info.models_loading')}
          >
            {Array.from({ length: 5 }, (_, index) => (
              <Skeleton key={index} height={28} />
            ))}
          </div>
        ) : models.length === 0 ? (
          <EmptyState
            title={t('system_info.models_empty')}
            description={t('system_info.models_empty_desc')}
          />
        ) : rows.length === 0 ? (
          <EmptyState title={t('system_info.models_no_match')} />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('system_info.models_col_model')}</TableHead>
                <TableHead>{t('system_info.models_col_alias')}</TableHead>
                <TableHead>{t('system_info.models_col_family')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((model) => (
                <TableRow key={`${model.name}-${model.alias ?? ''}`}>
                  <TableCell className="mono">{model.name}</TableCell>
                  <TableCell className="mono">{model.alias || '—'}</TableCell>
                  <TableCell>{model.group}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>
    </>
  );
}
