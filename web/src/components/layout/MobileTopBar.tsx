import { useTranslation } from 'react-i18next';
import { IconButton } from '@/components/ui/Button';
import { IconMenu } from '@/components/ui/icons';
import { BRAND_LOGO_URI, BRAND_NAME } from '@/assets/brandLogo';
import { SIDEBAR_ID } from './Sidebar';

interface MobileTopBarProps {
  drawerOpen: boolean;
  onOpenDrawer: () => void;
}

/** Narrow screens only: menu button and brand, sticky above the page. */
export function MobileTopBar({ drawerOpen, onOpenDrawer }: MobileTopBarProps) {
  const { t } = useTranslation();
  return (
    <header className="mobile-topbar">
      <IconButton
        aria-label={t('sidebar.open_menu')}
        aria-controls={SIDEBAR_ID}
        aria-expanded={drawerOpen}
        icon={<IconMenu size={16} />}
        onClick={onOpenDrawer}
      />
      <img src={BRAND_LOGO_URI} alt="" width={20} height={20} className="mobile-topbar-logo" />
      <span className="mobile-topbar-name">{BRAND_NAME}</span>
    </header>
  );
}
