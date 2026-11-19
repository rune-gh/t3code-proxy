import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { IconButton } from '@/components/ui/Button';
import { IconPanelLeft, IconX } from '@/components/ui/icons';
import { BRAND_LOGO_URI, BRAND_NAME } from '@/assets/brandLogo';
import { getSidebarShortcutLabel } from '@/utils/sidebarShortcut';
import { SidebarNav } from './SidebarNav';
import { SidebarFooter } from './SidebarFooter';
import type { NavGroup } from './navigation';

export const SIDEBAR_ID = 'app-sidebar';

interface SidebarProps {
  groups: NavGroup[];
  collapsed: boolean;
  isMobile: boolean;
  drawerOpen: boolean;
  onToggleCollapsed: () => void;
  onCloseDrawer: () => void;
}

const isMac = () =>
  typeof navigator !== 'undefined' &&
  /(Mac|iPhone|iPod|iPad)/i.test(navigator.platform || navigator.userAgent || '');

export function Sidebar({
  groups,
  collapsed,
  isMobile,
  drawerOpen,
  onToggleCollapsed,
  onCloseDrawer,
}: SidebarProps) {
  const { t } = useTranslation();
  const asideRef = useRef<HTMLElement | null>(null);
  const shortcut = getSidebarShortcutLabel(isMac());
  const hiddenDrawer = isMobile && !drawerOpen;

  // Drawer: move focus in on open, close on Escape.
  useEffect(() => {
    if (!isMobile || !drawerOpen) return;
    asideRef.current?.querySelector<HTMLElement>('.nav-item')?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCloseDrawer();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [drawerOpen, isMobile, onCloseDrawer]);

  const collapseLabel = `${collapsed ? t('sidebar.expand') : t('sidebar.collapse')} (${shortcut})`;

  return (
    <aside
      ref={asideRef}
      id={SIDEBAR_ID}
      className={`app-sidebar${collapsed ? ' collapsed' : ''}${drawerOpen ? ' open' : ''}`}
      aria-label={t('sidebar.label')}
      inert={hiddenDrawer || undefined}
    >
      <div className="sidebar-brand">
        <img src={BRAND_LOGO_URI} alt="" className="sidebar-brand-logo" width={24} height={24} />
        <span className="sidebar-brand-name">{BRAND_NAME}</span>
        {isMobile ? (
          <IconButton
            size="sm"
            className="sidebar-brand-action"
            aria-label={t('sidebar.close_menu')}
            icon={<IconX size={16} />}
            onClick={onCloseDrawer}
          />
        ) : (
          <IconButton
            size="sm"
            className="sidebar-brand-action sidebar-collapse-toggle"
            aria-label={collapseLabel}
            aria-controls={SIDEBAR_ID}
            aria-expanded={!collapsed}
            icon={<IconPanelLeft size={16} />}
            onClick={onToggleCollapsed}
          />
        )}
      </div>

      <SidebarNav groups={groups} collapsed={collapsed} onNavigate={onCloseDrawer} />

      <SidebarFooter collapsed={collapsed} />
    </aside>
  );
}
