import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageTransition } from '@/components/common/PageTransition';
import { MainRoutes } from '@/router/MainRoutes';
import { useConfigStore, useNotificationStore } from '@/stores';
import { triggerHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { Sidebar } from './Sidebar';
import { MobileTopBar } from './MobileTopBar';
import { useNavigation } from './navigation';
import { useSidebarState } from './useSidebarState';

/** Routes whose page manages its own full-height scrolling (no outer scroll, no max width). */
const isFillRoute = (pathname: string) =>
  pathname.startsWith('/logs') || pathname.startsWith('/plugin-pages');

/**
 * Keeps `--content-center-x` on <html> at the horizontal centre of the main
 * area, for bottom bars that centre over content (config save bar, batch bar).
 */
function useContentCenter(ref: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => {
      const rect = element.getBoundingClientRect();
      document.documentElement.style.setProperty(
        '--content-center-x',
        `${rect.left + rect.width / 2}px`
      );
    };
    update();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    observer?.observe(element);
    window.addEventListener('resize', update);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', update);
      document.documentElement.style.removeProperty('--content-center-x');
    };
  }, [ref]);
}

export function MainLayout() {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const showNotification = useNotificationStore((state) => state.showNotification);
  const fetchConfig = useConfigStore((state) => state.fetchConfig);
  const clearCache = useConfigStore((state) => state.clearCache);
  const sidebar = useSidebarState();
  const navigation = useNavigation();
  const mainRef = useRef<HTMLDivElement | null>(null);
  const fill = isFillRoute(pathname);
  const isPluginPage = pathname.startsWith('/plugin-pages');

  useContentCenter(mainRef);

  useEffect(() => {
    fetchConfig().catch(() => {
      // The login flow surfaces connection errors; nothing to show here.
    });
  }, [fetchConfig]);

  const refreshNavigation = navigation.refresh;
  const handleRefresh = useCallback(async () => {
    clearCache();
    const results = await Promise.allSettled([
      fetchConfig(true),
      refreshNavigation(),
      triggerHeaderRefresh(),
    ]);
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    );
    if (rejected) {
      const reason = rejected.reason;
      const message =
        typeof reason === 'string' ? reason : reason instanceof Error ? reason.message : '';
      showNotification(
        `${t('notification.refresh_failed')}${message ? `: ${message}` : ''}`,
        'error'
      );
      return;
    }
    showNotification(t('notification.data_refreshed'), 'success');
  }, [clearCache, fetchConfig, refreshNavigation, showNotification, t]);

  return (
    <div
      className={`app-shell${sidebar.collapsed ? ' sidebar-collapsed' : ''}${
        sidebar.drawerOpen ? ' drawer-open' : ''
      }`}
    >
      <a className="skip-link" href="#main-content">
        {t('sidebar.skip_to_content')}
      </a>

      <Sidebar
        groups={navigation.groups}
        collapsed={sidebar.collapsed}
        isMobile={sidebar.isMobile}
        drawerOpen={sidebar.drawerOpen}
        onToggleCollapsed={sidebar.toggleCollapsed}
        onCloseDrawer={sidebar.closeDrawer}
        onRefresh={handleRefresh}
      />

      {sidebar.isMobile && sidebar.drawerOpen ? (
        <div className="sidebar-scrim" aria-hidden="true" onClick={sidebar.closeDrawer} />
      ) : null}

      <div
        ref={mainRef}
        className={`app-main${fill ? ' app-main--fill' : ''}`}
        inert={(sidebar.isMobile && sidebar.drawerOpen) || undefined}
      >
        {sidebar.isMobile ? (
          <MobileTopBar drawerOpen={sidebar.drawerOpen} onOpenDrawer={sidebar.openDrawer} />
        ) : null}
        <main
          id="main-content"
          tabIndex={-1}
          className={`app-content${fill ? ' app-content--fill' : ''}${
            isPluginPage ? ' app-content--plugin' : ''
          }`}
        >
          <PageTransition
            render={(location) => <MainRoutes location={location} />}
            scrollContainerRef={mainRef}
          />
        </main>
      </div>
    </div>
  );
}
