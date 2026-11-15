import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { DropdownMenu, DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/DropdownMenu';
import { IconChevronDown } from '@/components/ui/icons';
import styles from './SelectionBar.module.scss';

export type SelectionBarProps = {
  selectionCount: number;
  selectablePageCount: number;
  selectableFilteredCount: number;
  disableControls: boolean;
  batchStatusDisabled: boolean;
  onSelectPage: () => void;
  onSelectFiltered: () => void;
  onInvertPage: () => void;
  onDeselectAll: () => void;
  onDownload: () => void;
  onEnable: () => void;
  onDisable: () => void;
  onDelete: () => void;
};

/**
 * Bulk actions for the selected accounts. Rendered in the page flow above the list
 * only while something is selected; delete asks for confirmation naming the count.
 */
export function SelectionBar(props: SelectionBarProps) {
  const {
    selectionCount,
    selectablePageCount,
    selectableFilteredCount,
    disableControls,
    batchStatusDisabled,
    onSelectPage,
    onSelectFiltered,
    onInvertPage,
    onDeselectAll,
    onDownload,
    onEnable,
    onDisable,
    onDelete,
  } = props;
  const { t } = useTranslation();

  if (selectionCount === 0) return null;

  return (
    <div className={styles.bar} role="toolbar" aria-label={t('auth_files.batch_toolbar_label')}>
      <div className={styles.start}>
        <span className={styles.count} aria-live="polite">
          {t('auth_files.batch_selected', { count: selectionCount })}
        </span>
        <DropdownMenu
          align="start"
          ariaLabel={t('auth_files.batch_select_menu')}
          trigger={
            <Button variant="ghost" size="sm">
              {t('auth_files.batch_select_menu')}
              <IconChevronDown size={14} />
            </Button>
          }
        >
          <DropdownMenuItem onSelect={onSelectPage} disabled={selectablePageCount === 0}>
            {t('auth_files.batch_select_page')}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onSelectFiltered} disabled={selectableFilteredCount === 0}>
            {t('auth_files.batch_select_filtered', { count: selectableFilteredCount })}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onInvertPage} disabled={selectablePageCount === 0}>
            {t('auth_files.batch_invert_page')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onDeselectAll}>
            {t('auth_files.batch_deselect')}
          </DropdownMenuItem>
        </DropdownMenu>
      </div>
      <div className={styles.end}>
        <Button variant="secondary" size="sm" onClick={onEnable} disabled={batchStatusDisabled}>
          {t('auth_files.batch_enable')}
        </Button>
        <Button variant="secondary" size="sm" onClick={onDisable} disabled={batchStatusDisabled}>
          {t('auth_files.batch_disable')}
        </Button>
        <Button variant="secondary" size="sm" onClick={onDownload} disabled={disableControls}>
          {t('auth_files.batch_download')}
        </Button>
        <Button variant="destructive" size="sm" onClick={onDelete} disabled={disableControls}>
          {t('auth_files.batch_delete', { count: selectionCount })}
        </Button>
      </div>
    </div>
  );
}
