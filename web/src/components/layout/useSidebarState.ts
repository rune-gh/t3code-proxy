import { useCallback, useEffect, useState } from 'react';
import { isSidebarToggleShortcut } from '@/utils/sidebarShortcut';

const COLLAPSED_STORAGE_KEY = 't3code-proxy.sidebar-collapsed';
const MOBILE_QUERY = '(max-width: 768px)';

const readCollapsed = () => {
  try {
    return window.localStorage.getItem(COLLAPSED_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
};

const matchesMobile = () =>
  typeof window !== 'undefined' && Boolean(window.matchMedia?.(MOBILE_QUERY).matches);

/**
 * Sidebar state: `collapsed` (desktop icon rail, persisted) and `drawerOpen`
 * (off-canvas drawer under 768px). Cmd/Ctrl+B toggles whichever applies.
 */
export function useSidebarState() {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(matchesMobile);

  useEffect(() => {
    try {
      window.localStorage.setItem(COLLAPSED_STORAGE_KEY, collapsed ? '1' : '0');
    } catch {
      // Storage may be unavailable (private mode); the state still works in memory.
    }
  }, [collapsed]);

  useEffect(() => {
    if (!window.matchMedia) return;
    const query = window.matchMedia(MOBILE_QUERY);
    const onChange = () => {
      setIsMobile(query.matches);
      if (!query.matches) setDrawerOpen(false);
    };
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  const toggle = useCallback(() => {
    if (matchesMobile()) setDrawerOpen((open) => !open);
    else setCollapsed((value) => !value);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isSidebarToggleShortcut(event)) {
        event.preventDefault();
        toggle();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [toggle]);

  const closeDrawer = useCallback(() => setDrawerOpen(false), []);
  const openDrawer = useCallback(() => setDrawerOpen(true), []);

  return {
    /** The rail only applies on desktop; the drawer always shows labels. */
    collapsed: collapsed && !isMobile,
    isMobile,
    drawerOpen,
    toggleCollapsed: () => setCollapsed((value) => !value),
    openDrawer,
    closeDrawer,
  };
}
