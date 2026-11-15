import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Button, IconButton } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { IconGithub, IconPlug, IconSettings, IconTrash2 } from '@/components/ui/icons';
import type { PluginListEntry } from '@/types';
import { getPluginTitle } from '../pluginResources';
import { formatPluginVersion } from '../pluginStoreEntries';
import {
  PLUGIN_STATUS_LABEL_KEY,
  PLUGIN_STATUS_TONE,
  type PluginRowStatus,
  type PluginStatusTone,
} from '../pluginStatus';
import styles from './PluginRow.module.scss';

const TONE_BADGE: Record<PluginStatusTone, BadgeTone> = {
  success: 'success',
  muted: 'neutral',
  warning: 'warning',
  pending: 'info',
};

export function PluginLogo({ src, size = 18 }: { src: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  const showImage = Boolean(src) && !failed;

  return showImage ? (
    <img src={src} alt="" onError={() => setFailed(true)} />
  ) : (
    <IconPlug size={size} />
  );
}

export function PluginStatusLabel({ status }: { status: PluginRowStatus }) {
  const { t } = useTranslation();
  return (
    <Badge tone={TONE_BADGE[PLUGIN_STATUS_TONE[status]]} dot>
      {t(PLUGIN_STATUS_LABEL_KEY[status])}
    </Badge>
  );
}

/** `current → next`; the arrow is decorative, the accessible text reads both versions. */
export function PluginVersionChange({ from, to }: { from: string; to: string }) {
  return (
    <span className={styles.versionChange}>
      <span className={styles.version}>{formatPluginVersion(from)}</span>
      <span className={styles.versionArrow} aria-hidden="true">
        →
      </span>
      <span className={styles.versionNext}>{formatPluginVersion(to)}</span>
    </span>
  );
}

interface PillButtonProps {
  label: string;
  prominent?: boolean;
  loading?: boolean;
  disabled?: boolean;
  title?: string;
  onClick: () => void;
}

/** The row's one text action (Install / Update), sized so it lines up across rows. */
export function PillButton({
  label,
  prominent,
  loading,
  disabled,
  title,
  onClick,
}: PillButtonProps) {
  return (
    <Button
      variant={prominent ? 'primary' : 'secondary'}
      size="sm"
      className={styles.pill}
      onClick={onClick}
      disabled={disabled}
      loading={loading}
      title={title}
    >
      {label}
    </Button>
  );
}

export interface PluginRowUpdate {
  from: string;
  to: string;
  /** Why the update cannot start (missing store auth), shown as the button's tooltip. */
  blockedReason: string;
  installing: boolean;
  disabled: boolean;
  onUpdate: () => void;
}

interface PluginRowProps {
  plugin: PluginListEntry;
  logo: string;
  status: PluginRowStatus;
  checked: boolean;
  disabled: boolean;
  update: PluginRowUpdate | null;
  onToggle: (enabled: boolean) => void;
  onConfigure: () => void;
  onDelete: () => void;
}

export function PluginRow({
  plugin,
  logo,
  status,
  checked,
  disabled,
  update,
  onToggle,
  onConfigure,
  onDelete,
}: PluginRowProps) {
  const { t } = useTranslation();
  const title = getPluginTitle(plugin);
  const version = plugin.metadata?.version.trim();
  const author = plugin.metadata?.author.trim();
  const github = plugin.metadata?.githubRepository.trim();
  const configureLabel = t('plugin_management.edit_config');
  const repositoryLabel = t('plugin_management.open_repository');
  const deleteLabel = t('plugin_management.delete_plugin');

  return (
    <article className={styles.row}>
      <div className={styles.logo} aria-hidden="true">
        <PluginLogo key={logo} src={logo} />
      </div>

      <div className={styles.text}>
        <div className={styles.titleLine}>
          <h2 className={styles.name}>{title}</h2>
          {update ? (
            <PluginVersionChange from={update.from || version || ''} to={update.to} />
          ) : version ? (
            <span className={styles.version}>{formatPluginVersion(version)}</span>
          ) : null}
          {plugin.supportsOAuth ? <Badge outline>{t('plugin_management.oauth')}</Badge> : null}
        </div>
        <div className={styles.metaLine}>
          <PluginStatusLabel status={status} />
          {title !== plugin.id ? (
            <span className={styles.id} title={plugin.id}>
              {plugin.id}
            </span>
          ) : null}
          {author ? (
            <span className={styles.author} title={author}>
              {author}
            </span>
          ) : null}
        </div>
      </div>

      <div className={styles.actions}>
        {update ? (
          <span className={styles.updateSlot}>
            <PillButton
              label={t('plugin_store.update')}
              prominent
              loading={update.installing}
              disabled={update.disabled}
              title={update.blockedReason || undefined}
              onClick={update.onUpdate}
            />
          </span>
        ) : null}
        <span className={styles.iconGroup}>
          <IconButton
            size="sm"
            onClick={onConfigure}
            disabled={disabled}
            aria-label={configureLabel}
            icon={<IconSettings size={16} />}
          />
          {github ? (
            <a
              className="btn btn-ghost btn-sm btn-icon"
              href={github}
              target="_blank"
              rel="noreferrer"
              aria-label={repositoryLabel}
            >
              <IconGithub size={16} />
            </a>
          ) : null}
          <IconButton
            size="sm"
            className={styles.danger}
            onClick={onDelete}
            disabled={disabled}
            aria-label={deleteLabel}
            icon={<IconTrash2 size={16} />}
          />
        </span>
        <span className={styles.toggle}>
          <ToggleSwitch
            checked={checked}
            onChange={onToggle}
            disabled={disabled}
            ariaLabel={t('plugin_management.enabled')}
          />
        </span>
      </div>
    </article>
  );
}

export function PluginRowSkeleton() {
  return (
    <div className={styles.row} aria-hidden="true">
      <Skeleton width={32} height={32} rounded={6} />
      <div className={styles.text}>
        <Skeleton width="38%" height={14} rounded={4} />
        <Skeleton width="56%" height={12} rounded={4} />
      </div>
      <div className={styles.actions}>
        <Skeleton width={28} height={28} rounded={6} />
        <Skeleton width={28} height={28} rounded={6} />
        <span className={styles.toggle}>
          <Skeleton width={44} height={24} rounded={999} />
        </span>
      </div>
    </div>
  );
}
