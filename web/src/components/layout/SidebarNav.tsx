import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Tooltip } from '@/components/ui/Tooltip';
import { IconChevronDown } from '@/components/ui/icons';
import {
  isNavLinkActive,
  type NavDrawerItem,
  type NavGroup,
  type NavItem,
  type NavLinkItem,
} from './navigation';

interface SidebarNavProps {
  groups: NavGroup[];
  /** Icon rail: labels hidden, names move to tooltips and aria-labels. */
  collapsed: boolean;
  onNavigate: () => void;
}

/** Tooltip text for rail items: the label, plus the one-line description when present. */
function RailTooltip({ label, meta }: { label: string; meta?: string }) {
  return (
    <span className="nav-tooltip">
      <span className="nav-tooltip-label">{label}</span>
      {meta ? <span className="nav-tooltip-meta">{meta}</span> : null}
    </span>
  );
}

export function SidebarNav({ groups, collapsed, onNavigate }: SidebarNavProps) {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const [openDrawers, setOpenDrawers] = useState<Set<string>>(() => new Set());

  const toggleDrawer = (id: string) =>
    setOpenDrawers((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const renderLink = (item: NavLinkItem, sub = false) => {
    const active = isNavLinkActive(item, pathname);
    const accessibleName = item.badgeLabel ? `${item.label}, ${item.badgeLabel}` : item.label;
    const link = (
      <Link
        to={item.path}
        className={`nav-item${sub ? ' nav-sub-item' : ''}${active ? ' active' : ''}`}
        aria-current={active ? 'page' : undefined}
        aria-label={collapsed ? accessibleName : undefined}
        onClick={onNavigate}
      >
        <span className="nav-icon">{item.icon}</span>
        <span className="nav-label">{item.label}</span>
        {typeof item.badge === 'number' && item.badge > 0 ? (
          <span className="nav-badge" aria-hidden="true">
            {item.badge}
          </span>
        ) : null}
        {!collapsed && item.badgeLabel ? <span className="sr-only">{item.badgeLabel}</span> : null}
      </Link>
    );
    return (
      <li key={item.path}>
        <Tooltip
          className="nav-tooltip-anchor"
          side="right"
          delay={150}
          disabled={!collapsed}
          content={<RailTooltip label={item.label} meta={item.meta} />}
        >
          {link}
        </Tooltip>
      </li>
    );
  };

  const renderDrawer = (item: NavDrawerItem) => {
    const active = item.children.some((child) => isNavLinkActive(child, pathname));
    const open = active || openDrawers.has(item.id);
    const listId = `${item.id}-list`;
    return (
      <li key={item.id}>
        <Tooltip
          className="nav-tooltip-anchor"
          side="right"
          delay={150}
          disabled={!collapsed}
          content={<RailTooltip label={item.label} meta={item.meta} />}
        >
          <button
            type="button"
            className={`nav-item nav-drawer-toggle${active ? ' active' : ''}`}
            aria-expanded={open}
            aria-controls={listId}
            aria-label={collapsed ? item.label : undefined}
            onClick={() => toggleDrawer(item.id)}
          >
            <span className="nav-icon">{item.icon}</span>
            <span className="nav-label">{item.label}</span>
            <span className={`nav-drawer-caret${open ? ' open' : ''}`} aria-hidden="true">
              <IconChevronDown size={14} />
            </span>
          </button>
        </Tooltip>
        {open ? (
          <ul id={listId} className="nav-sub-list">
            {item.children.map((child) => renderLink(child, true))}
          </ul>
        ) : null}
      </li>
    );
  };

  const renderItem = (item: NavItem) =>
    item.kind === 'drawer' ? renderDrawer(item) : renderLink(item);

  return (
    <nav className="sidebar-nav" aria-label={t('sidebar.navigation_label')}>
      {groups.map((group) => (
        <ul key={group.id} className="nav-group">
          {group.items.map(renderItem)}
        </ul>
      ))}
    </nav>
  );
}
