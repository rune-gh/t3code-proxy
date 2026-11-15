import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { IconButton } from '@/components/ui/Button';
import { StatusDot, type BadgeTone } from '@/components/ui/Badge';
import { DropdownMenu, DropdownMenuItem } from '@/components/ui/DropdownMenu';
import { Tooltip } from '@/components/ui/Tooltip';
import { IconLogOut, IconMonitor, IconMoon, IconRefreshCw, IconSun } from '@/components/ui/icons';
import { useAuthStore, useThemeStore } from '@/stores';
import type { Theme } from '@/types';

const STATUS_TONE: Record<string, BadgeTone> = {
  connected: 'success',
  connecting: 'warning',
  disconnected: 'destructive',
  error: 'destructive',
};

/** Hub address without the scheme, e.g. `hub.tail1234.ts.net:8317`. */
const displayAddress = (apiBase: string) => apiBase.replace(/^https?:\/\//, '').replace(/\/$/, '');

interface SidebarFooterProps {
  collapsed: boolean;
  onRefresh: () => Promise<void>;
}

export function SidebarFooter({ collapsed, onRefresh }: SidebarFooterProps) {
  const { t } = useTranslation();
  const apiBase = useAuthStore((state) => state.apiBase);
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const serverVersion = useAuthStore((state) => state.serverVersion);
  const logout = useAuthStore((state) => state.logout);
  const theme = useThemeStore((state) => state.theme);
  const setTheme = useThemeStore((state) => state.setTheme);
  const [refreshing, setRefreshing] = useState(false);

  const statusLabel = t(`common.${connectionStatus}_status`, { defaultValue: connectionStatus });
  const address = displayAddress(apiBase || window.location.host);
  const version = serverVersion ? `v${serverVersion.replace(/^v/, '')}` : '';

  const themeOptions: Array<{ value: Theme; label: string; icon: ReactNode }> = [
    { value: 'light', label: t('theme.light'), icon: <IconSun size={16} /> },
    { value: 'dark', label: t('theme.dark'), icon: <IconMoon size={16} /> },
    { value: 'auto', label: t('theme.auto'), icon: <IconMonitor size={16} /> },
  ];
  const current = themeOptions.find((option) => option.value === theme) ?? themeOptions[2];

  const handleRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  };

  const status = (
    <div className="sidebar-status" role="status">
      <StatusDot tone={STATUS_TONE[connectionStatus] ?? 'neutral'} aria-hidden="true" />
      <div className="sidebar-status-text">
        <span className="sidebar-status-address" title={apiBase}>
          {address}
        </span>
        <span className="sidebar-status-meta">
          {statusLabel}
          {version ? ` · ${version}` : ''}
        </span>
      </div>
    </div>
  );

  return (
    <div className="sidebar-footer">
      {collapsed ? (
        <Tooltip
          side="right"
          className="nav-tooltip-anchor"
          content={
            <span className="nav-tooltip">
              <span className="nav-tooltip-label">{address}</span>
              <span className="nav-tooltip-meta">
                {statusLabel}
                {version ? ` · ${version}` : ''}
              </span>
            </span>
          }
        >
          <div
            className="sidebar-status sidebar-status-rail"
            tabIndex={0}
            role="status"
            aria-label={`${t('sidebar.hub_label')}: ${address}, ${statusLabel}`}
          >
            <StatusDot tone={STATUS_TONE[connectionStatus] ?? 'neutral'} aria-hidden="true" />
          </div>
        </Tooltip>
      ) : (
        status
      )}
      <div className="sidebar-actions">
        <DropdownMenu
          align="start"
          ariaLabel={t('theme.switch')}
          minWidth={160}
          trigger={
            <IconButton
              size="sm"
              aria-label={`${t('theme.switch')}: ${current.label}`}
              icon={current.icon}
            />
          }
        >
          {themeOptions.map((option) => (
            <DropdownMenuItem
              key={option.value}
              icon={option.icon}
              selected={option.value === current.value}
              onSelect={() => setTheme(option.value)}
            >
              {option.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenu>
        <IconButton
          size="sm"
          aria-label={t('header.refresh_all')}
          icon={<IconRefreshCw size={16} />}
          loading={refreshing}
          onClick={handleRefresh}
        />
        <IconButton
          size="sm"
          aria-label={t('header.logout')}
          icon={<IconLogOut size={16} />}
          onClick={logout}
        />
      </div>
    </div>
  );
}
