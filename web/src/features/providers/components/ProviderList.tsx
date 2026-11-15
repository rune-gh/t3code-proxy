import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/Badge';
import { IconButton } from '@/components/ui/Button';
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/DropdownMenu';
import { IconEllipsis } from '@/components/ui/icons';
import { Section } from '@/components/ui/Section';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/Table';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import type { ResolvedTheme } from '@/types';
import { PROVIDER_LOGOS } from '../brandLogos';
import type { ConnectivityRecord } from '../connectivityLog';
import type { ProviderGroup, ProviderResource } from '../types';
import styles from './ProviderList.module.scss';

export interface ProviderListActions {
  onView: (resource: ProviderResource) => void;
  onEdit: (resource: ProviderResource) => void;
  onTest: (resource: ProviderResource) => void;
  onDelete: (resource: ProviderResource) => void;
  onToggleEnabled: (resource: ProviderResource, enabled: boolean) => void;
}

interface ProviderListProps extends ProviderListActions {
  groups: ProviderGroup[];
  tests: ReadonlyMap<string, ConnectivityRecord>;
  theme: ResolvedTheme;
  selectedId?: string | null;
  disableMutations?: boolean;
}

/** Keys configured on a row: OpenAI-compatible rows hold several, the others one each. */
const keyCount = (resource: ProviderResource): number =>
  resource.brand === 'openaiCompatibility'
    ? resource.apiKeyEntryCount
    : resource.apiKey || resource.authIndex
      ? 1
      : 0;

const resourceLabel = (resource: ProviderResource): string =>
  resource.name ?? resource.apiKeyPreview ?? resource.identifier;

function BrandMark({ brand, theme }: { brand: ProviderGroup['id']; theme: ResolvedTheme }) {
  const logo = PROVIDER_LOGOS[brand];
  if (!logo) return null;
  const src = theme === 'dark' && logo.darkSrc ? logo.darkSrc : logo.src;
  return <img src={src} alt="" aria-hidden="true" className={styles.mark} />;
}

export function ProviderList({
  groups,
  tests,
  theme,
  selectedId,
  disableMutations = false,
  onView,
  onEdit,
  onTest,
  onDelete,
  onToggleEnabled,
}: ProviderListProps) {
  const { t } = useTranslation();

  const baseUrl = (resource: ProviderResource) => {
    if (resource.baseUrl) return <span className={styles.url}>{resource.baseUrl}</span>;
    return <span className={styles.muted}>{t('providersPage.list.defaultUrl')}</span>;
  };

  const testStatus = (resource: ProviderResource) => {
    const record = tests.get(resource.id);
    if (!record) return <span className={styles.muted}>{t('providersPage.list.notTested')}</span>;
    return record.ok ? (
      <Badge tone="success" dot>
        {t('providersPage.list.testPassed')}
      </Badge>
    ) : (
      <span title={record.message}>
        <Badge tone="destructive" dot>
          {t('providersPage.list.testFailed')}
        </Badge>
      </span>
    );
  };

  const toggle = (resource: ProviderResource) => (
    <ToggleSwitch
      checked={!resource.disabled}
      disabled={disableMutations}
      onChange={(enabled) => onToggleEnabled(resource, enabled)}
      ariaLabel={t('providersPage.list.enabledFor', { name: resourceLabel(resource) })}
    />
  );

  const menu = (resource: ProviderResource) => (
    <DropdownMenu
      ariaLabel={t('providersPage.list.actionsFor', { name: resourceLabel(resource) })}
      trigger={
        <IconButton
          size="sm"
          variant="ghost"
          aria-label={t('providersPage.list.actionsFor', { name: resourceLabel(resource) })}
          icon={<IconEllipsis size={16} />}
        />
      }
    >
      <DropdownMenuItem onSelect={() => onView(resource)}>
        {t('providersPage.actions.view')}
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => onEdit(resource)} disabled={disableMutations}>
        {t('providersPage.actions.edit')}
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => onTest(resource)} disabled={disableMutations}>
        {t('providersPage.actions.test')}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem destructive onSelect={() => onDelete(resource)} disabled={disableMutations}>
        {t('providersPage.actions.delete')}
      </DropdownMenuItem>
    </DropdownMenu>
  );

  const name = (resource: ProviderResource) => (
    <button type="button" className={styles.nameButton} onClick={() => onView(resource)}>
      <span className={styles.name}>{resourceLabel(resource)}</span>
      {resource.name && resource.apiKeyPreview ? (
        <span className={styles.keyPreview}>{resource.apiKeyPreview}</span>
      ) : null}
    </button>
  );

  return (
    <div className={styles.groups}>
      {groups.map((group) => (
        <Section
          key={group.id}
          title={
            <span className={styles.groupTitle}>
              <BrandMark brand={group.id} theme={theme} />
              {t(`providersPage.providerNames.${group.id}`)}
              <span className={styles.count}>{group.resources.length}</span>
            </span>
          }
        >
          <div className={styles.desktop}>
            <Table className={styles.table}>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('providersPage.list.name')}</TableHead>
                  <TableHead>{t('providersPage.list.baseUrl')}</TableHead>
                  <TableHead alignRight>{t('providersPage.list.keys')}</TableHead>
                  <TableHead alignRight>{t('providersPage.list.models')}</TableHead>
                  <TableHead>{t('providersPage.list.lastTest')}</TableHead>
                  <TableHead>{t('providersPage.list.enabled')}</TableHead>
                  <TableHead alignRight>
                    <span className="sr-only">{t('providersPage.list.actions')}</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {group.resources.map((resource) => (
                  <TableRow
                    key={resource.id}
                    selected={resource.id === selectedId}
                    data-disabled={resource.disabled || undefined}
                  >
                    <TableCell>{name(resource)}</TableCell>
                    <TableCell>{baseUrl(resource)}</TableCell>
                    <TableCell alignRight className="tabular">
                      {keyCount(resource)}
                    </TableCell>
                    <TableCell alignRight className="tabular">
                      {resource.modelCount}
                    </TableCell>
                    <TableCell>{testStatus(resource)}</TableCell>
                    <TableCell>{toggle(resource)}</TableCell>
                    <TableCell alignRight>{menu(resource)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <ul className={styles.mobile}>
            {group.resources.map((resource) => (
              <li
                key={resource.id}
                className={styles.row}
                data-disabled={resource.disabled || undefined}
              >
                <div className={styles.rowTop}>
                  {name(resource)}
                  <div className={styles.rowControls}>
                    {toggle(resource)}
                    {menu(resource)}
                  </div>
                </div>
                {baseUrl(resource)}
                <div className={styles.rowMeta}>
                  <span className="tabular">
                    {t('providersPage.list.keyCount', { count: keyCount(resource) })}
                  </span>
                  <span className="tabular">
                    {t('providersPage.list.modelCount', { count: resource.modelCount })}
                  </span>
                  {testStatus(resource)}
                </div>
              </li>
            ))}
          </ul>
        </Section>
      ))}
    </div>
  );
}
