import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { authFilesApi, pluginsApi } from '@/services/api';
import { useAuthStore } from '@/stores';
import { AUTH_FILES_CHANGED_EVENT } from '@/features/authFiles/authFilesEvents';
import {
  collectPluginResourceEntries,
  PLUGIN_RESOURCES_REFRESH_EVENT,
  resolvePluginAssetURL,
  type PluginResourceEntry,
} from '@/features/plugins/pluginResources';
import {
  IconSidebarAccounts,
  IconSidebarActivity,
  IconSidebarAddAccount,
  IconSidebarConfig,
  IconSidebarConnect,
  IconSidebarLogs,
  IconSidebarPlugins,
  IconSidebarProviders,
  IconSidebarQuota,
  IconSidebarRouting,
  IconSidebarSystem,
} from '@/components/ui/icons';

export interface NavLinkItem {
  kind: 'link';
  path: string;
  label: string;
  /** One-line description, shown in the collapsed-rail tooltip. */
  meta?: string;
  icon: ReactNode;
  /** Extra pathnames that also mark this item active (e.g. `/` for Overview). */
  aliases?: string[];
  badge?: number;
  badgeLabel?: string;
}

export interface NavDrawerItem {
  kind: 'drawer';
  id: string;
  label: string;
  meta?: string;
  icon: ReactNode;
  children: NavLinkItem[];
}

export type NavItem = NavLinkItem | NavDrawerItem;

export interface NavGroup {
  id: string;
  items: NavItem[];
}

const ICON_SIZE = 16;

function PluginNavIcon({ src }: { src: string }) {
  const [failed, setFailed] = useState(false);
  return src && !failed ? (
    <img src={src} alt="" onError={() => setFailed(true)} />
  ) : (
    <IconSidebarPlugins size={ICON_SIZE} />
  );
}

/** Whether `pathname` belongs to a nav link (exact, alias, or nested route). */
export const isNavLinkActive = (item: NavLinkItem, pathname: string) => {
  const trimmed = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  const paths = [item.path, ...(item.aliases ?? [])];
  return paths.some((path) => trimmed === path || (path !== '/' && trimmed.startsWith(`${path}/`)));
};

/** Plugin-contributed pages, reloaded on connection and on the refresh event. */
function usePluginResources() {
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const supportsPlugin = useAuthStore((state) => state.supportsPlugin);
  const [resources, setResources] = useState<PluginResourceEntry[]>([]);

  const load = useCallback(async () => {
    if (connectionStatus !== 'connected' || !supportsPlugin) {
      setResources([]);
      return;
    }
    try {
      const plugins = await pluginsApi.list();
      setResources(collectPluginResourceEntries(plugins.plugins));
    } catch {
      setResources([]);
    }
  }, [connectionStatus, supportsPlugin]);

  return { resources, load };
}

/** Number of auth files, for the Accounts badge. */
function useAuthFilesCount() {
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const [count, setCount] = useState<number | null>(null);
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    const requestID = ++requestRef.current;
    if (connectionStatus !== 'connected') {
      setCount(null);
      return;
    }
    try {
      const response = await authFilesApi.list();
      if (requestID !== requestRef.current) return;
      setCount(Array.isArray(response?.files) ? response.files.length : null);
    } catch {
      if (requestID === requestRef.current) setCount(null);
    }
  }, [connectionStatus]);

  useEffect(
    () => () => {
      requestRef.current += 1;
    },
    []
  );

  return { count, load };
}

/**
 * Sidebar navigation model. Order and labels are fixed here; route paths are
 * unchanged from earlier versions so bookmarks keep working.
 */
export function useNavigation() {
  const { t } = useTranslation();
  const apiBase = useAuthStore((state) => state.apiBase);
  const supportsPlugin = useAuthStore((state) => state.supportsPlugin);
  const plugins = usePluginResources();
  const authFiles = useAuthFilesCount();
  const loadPlugins = plugins.load;
  const loadAuthFilesCount = authFiles.load;

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadPlugins();
      void loadAuthFilesCount();
    }, 0);
    window.addEventListener(PLUGIN_RESOURCES_REFRESH_EVENT, loadPlugins);
    window.addEventListener(AUTH_FILES_CHANGED_EVENT, loadAuthFilesCount);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener(PLUGIN_RESOURCES_REFRESH_EVENT, loadPlugins);
      window.removeEventListener(AUTH_FILES_CHANGED_EVENT, loadAuthFilesCount);
    };
  }, [apiBase, loadPlugins, loadAuthFilesCount]);

  const link = (
    path: string,
    key: string,
    Icon: (props: { size?: number }) => ReactNode,
    extra: Partial<NavLinkItem> = {}
  ): NavLinkItem => ({
    kind: 'link',
    path,
    label: t(`nav.${key}`),
    meta: t(`nav_meta.${key}`),
    icon: <Icon size={ICON_SIZE} />,
    ...extra,
  });

  const authFilesCount = authFiles.count;

  // Plugin pages: a single page becomes a link, several pages become a drawer.
  const pluginGroups = new Map<string, PluginResourceEntry[]>();
  if (supportsPlugin) {
    for (const resource of plugins.resources) {
      const list = pluginGroups.get(resource.pluginID) ?? [];
      list.push(resource);
      pluginGroups.set(resource.pluginID, list);
    }
  }
  const pluginPageItems: NavItem[] = [...pluginGroups.entries()].map(([pluginID, entries]) => {
    const logo = resolvePluginAssetURL(entries[0]?.pluginLogo ?? '', apiBase);
    if (entries.length === 1) {
      const resource = entries[0];
      return {
        kind: 'link',
        path: resource.route,
        label: resource.label,
        meta: resource.description,
        icon: <PluginNavIcon src={logo} />,
      };
    }
    return {
      kind: 'drawer',
      id: `plugin-pages-${pluginID}`,
      label: entries[0]?.pluginTitle ?? pluginID,
      meta: t('plugin_resource.page_count', { count: entries.length }),
      icon: <PluginNavIcon src={logo} />,
      children: entries.map((resource) => ({
        kind: 'link',
        path: resource.route,
        label: resource.label,
        meta: resource.description,
        icon: <span className="nav-sub-dot" aria-hidden="true" />,
      })),
    };
  });

  const groups: NavGroup[] = [
    {
      id: 'pool',
      items: [
        link('/quota', 'quota_management', IconSidebarQuota, { aliases: ['/'] }),
        link('/auth-files', 'auth_files', IconSidebarAccounts, {
          badge: authFilesCount ?? undefined,
          badgeLabel:
            typeof authFilesCount === 'number'
              ? t('sidebar.auth_files_count', { count: authFilesCount })
              : undefined,
        }),
        link('/oauth', 'oauth', IconSidebarAddAccount),
        link('/routing', 'routing', IconSidebarRouting),
        link('/connect', 'connect', IconSidebarConnect),
      ],
    },
    {
      id: 'observe',
      items: [
        link('/dashboard', 'dashboard', IconSidebarActivity),
        link('/ai-providers', 'ai_providers', IconSidebarProviders),
        link('/logs', 'logs', IconSidebarLogs),
      ],
    },
    ...(supportsPlugin
      ? [
          {
            id: 'plugins',
            items: [link('/plugins', 'plugins', IconSidebarPlugins), ...pluginPageItems],
          },
        ]
      : []),
    {
      id: 'settings',
      items: [
        link('/config', 'config_management', IconSidebarConfig),
        link('/system', 'system_info', IconSidebarSystem),
      ],
    },
  ];

  const refresh = useCallback(
    () => Promise.allSettled([loadPlugins(), loadAuthFilesCount()]),
    [loadPlugins, loadAuthFilesCount]
  );

  return { groups, refresh };
}
