import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Section } from '@/components/ui/Section';
import { IconChevronLeft, IconEyeOff, IconNetwork, IconRefreshCw } from '@/components/ui/icons';
import type { OAuthModelAliasEntry } from '@/types';
import {
  getTypeLabel,
  normalizeProviderKey,
  type OAuthConfigLoadError,
  type ResolvedTheme,
} from '@/features/authFiles/constants';
import { getAliasStats, getExcludedStats } from '@/features/authFiles/modelRules/draft';
import styles from './ModelRulesEntry.module.scss';

type EntryRowProps = {
  icon: ReactNode;
  title: string;
  state: OAuthConfigLoadError;
  meta: string[];
  onOpen: () => void;
  onRetry: () => void | Promise<void>;
};

/**
 * One rule set as a single row button with a live summary. A failed load turns the
 * row into a retry action, so it never leads into an editor that is bound to fail.
 */
function EntryRow({ icon, title, state, meta, onOpen, onRetry }: EntryRowProps) {
  const { t } = useTranslation();
  const ready = state === null;
  const failed = state === 'load';
  const metaText = ready ? meta : failed ? [t('auth_files.rules_load_failed')] : [t('common.loading')];

  return (
    <button
      type="button"
      className={styles.row}
      data-state={state ?? 'ready'}
      onClick={() => (failed ? void onRetry() : onOpen())}
      disabled={!ready && !failed}
      aria-busy={state === 'loading' ? true : undefined}
    >
      <span className={styles.icon} aria-hidden="true">
        {icon}
      </span>
      <span className={styles.title}>{title}</span>
      <span className={styles.meta}>{metaText.join(' · ')}</span>
      <span className={styles.end} aria-hidden="true">
        {failed ? (
          <>
            <IconRefreshCw size={14} />
            <span>{t('auth_files.retry')}</span>
          </>
        ) : (
          <IconChevronLeft size={16} className={styles.chevron} />
        )}
      </span>
    </button>
  );
}

export type ModelRulesEntryProps = {
  excluded: Record<string, string[]>;
  excludedError: OAuthConfigLoadError;
  modelAlias: Record<string, OAuthModelAliasEntry[]>;
  modelAliasError: OAuthConfigLoadError;
  /** Current provider filter ('all' / empty = every provider); summaries and links follow it. */
  scope: string;
  resolvedTheme: ResolvedTheme;
  onOpenExcluded: (provider?: string) => void;
  onOpenAlias: (provider?: string) => void;
  onRetryExcluded: () => void | Promise<void>;
  onRetryAlias: () => void | Promise<void>;
};

const pickScope = <T,>(source: Record<string, T>, scope: string): Record<string, T> => {
  if (!scope) return source;
  return Object.fromEntries(
    Object.entries(source).filter(([provider]) => normalizeProviderKey(provider) === scope)
  );
};

/**
 * Entry to the per-provider model rules on the Accounts page. Editing happens in the
 * full-width editors; this only says what is configured and leads there. A rule set
 * the hub does not serve is left out instead of nagging about it.
 */
export function ModelRulesEntry({
  excluded,
  excludedError,
  modelAlias,
  modelAliasError,
  scope,
  onOpenExcluded,
  onOpenAlias,
  onRetryExcluded,
  onRetryAlias,
}: ModelRulesEntryProps) {
  const { t } = useTranslation();
  const scopeKey = scope && scope !== 'all' ? normalizeProviderKey(scope) : '';
  const scopeLabel = scopeKey ? getTypeLabel(t, scopeKey) : '';
  const showExcluded = excludedError !== 'unsupported';
  const showAlias = modelAliasError !== 'unsupported';
  if (!showExcluded && !showAlias) return null;

  const excludedStats = getExcludedStats(pickScope(excluded, scopeKey));
  const aliasStats = getAliasStats(pickScope(modelAlias, scopeKey));

  const withScope = (parts: string[], configured: boolean) => {
    const body = configured ? parts : [t('model_rules.meta_empty')];
    return scopeKey ? [scopeLabel, ...body] : body;
  };

  const excludedMeta = withScope(
    scopeKey
      ? [t('model_rules.meta_rules', { count: excludedStats.rules })]
      : [
          t('model_rules.meta_providers', { count: excludedStats.providers }),
          t('model_rules.meta_rules', { count: excludedStats.rules }),
        ],
    excludedStats.rules > 0
  );
  const aliasMeta = withScope(
    scopeKey
      ? [t('model_rules.meta_mappings', { count: aliasStats.mappings })]
      : [
          t('model_rules.meta_providers', { count: aliasStats.providers }),
          t('model_rules.meta_mappings', { count: aliasStats.mappings }),
        ],
    aliasStats.mappings > 0
  );

  return (
    <Section title={t('model_rules.section_label')} description={t('auth_files.rules_description')}>
      <div className={styles.list}>
        {showExcluded && (
          <EntryRow
            icon={<IconEyeOff size={16} />}
            title={t('model_rules.kind_excluded')}
            state={excludedError}
            meta={excludedMeta}
            onOpen={() => onOpenExcluded(scopeKey || undefined)}
            onRetry={onRetryExcluded}
          />
        )}
        {showAlias && (
          <EntryRow
            icon={<IconNetwork size={16} />}
            title={t('model_rules.kind_alias')}
            state={modelAliasError}
            meta={aliasMeta}
            onOpen={() => onOpenAlias(scopeKey || undefined)}
            onRetry={onRetryAlias}
          />
        )}
      </div>
    </Section>
  );
}
