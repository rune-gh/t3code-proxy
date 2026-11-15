import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Badge } from '@/components/ui/Badge';
import { PageHeader } from '@/components/ui/PageHeader';
import { Section } from '@/components/ui/Section';
import { useAuthStore, useThemeStore } from '@/stores';
import iconVertex from '@/assets/icons/vertex.svg';
import iconCodex from '@/assets/icons/codex.svg';
import { LoginProxyField } from './components/LoginProxyField';
import { ProviderTile } from './components/ProviderTile';
import { OAuthFlowDialog, type DialogHeading } from './components/OAuthFlowDialog';
import { VertexImportDialog } from './components/VertexImportDialog';
import { SiwcBindDialog } from './components/SiwcBindDialog';
import {
  useOAuthFlows,
  usePluginOAuthProviders,
  type ProviderFlowState,
} from './hooks/useOAuthFlows';
import { useVertexImport } from './hooks/useVertexImport';
import {
  OAUTH_PROVIDERS,
  PRIMARY_PROVIDER_IDS,
  resolveThemedIcon,
  supportsManualCallback,
  type OAuthProviderCard,
} from './providers';
import styles from './OAuthPage.module.scss';

/** Dialog focus id: Vertex is not an OAuth provider, so a reserved id avoids clashing with providers. */
const VERTEX_DIALOG_ID = '__vertex__';
const VERTEX_LABEL = 'Vertex AI';

type DialogTarget = { kind: 'oauth'; id: string } | { kind: 'vertex' };

/**
 * Add account, step one: choose a provider. Claude and Codex lead as large tiles; every other
 * provider sits in a compact list below. Choosing one starts sign-in and opens the sign-in dialog
 * (step two). The dialog can be closed while sign-in continues; the tile shows live status.
 * The last target is kept after the dialog closes so content does not vanish during the exit animation.
 */
export function OAuthPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const apiBase = useAuthStore((state) => state.apiBase);
  const resolvedTheme = useThemeStore((state) => state.resolvedTheme);

  const pluginProviders = usePluginOAuthProviders(apiBase);
  const providerCards = useMemo<OAuthProviderCard[]>(
    () => [...OAUTH_PROVIDERS, ...pluginProviders],
    [pluginProviders]
  );
  const primaryCards = providerCards.filter((card) => PRIMARY_PROVIDER_IDS.has(card.id));
  const moreCards = providerCards.filter((card) => !PRIMARY_PROVIDER_IDS.has(card.id));

  const focusedRef = useRef<string | null>(null);
  const [dialog, setDialog] = useState<DialogTarget | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [siwcOpen, setSiwcOpen] = useState(false);
  // A new key on every open remounts it (fresh selection and session); it stays mounted after
  // closing so the exit animation can finish.
  const [siwcKey, setSiwcKey] = useState(0);
  const openSiwc = () => {
    setSiwcKey((key) => key + 1);
    setSiwcOpen(true);
  };

  const flows = useOAuthFlows({
    providerCards,
    isFocused: (provider) => focusedRef.current === provider,
  });
  const vertexImport = useVertexImport({
    isFocused: () => focusedRef.current === VERTEX_DIALOG_ID,
    onCredentialAdded: flows.recordCredentialAdded,
  });

  const labelOf = (card: OAuthProviderCard) =>
    card.kind === 'plugin'
      ? card.title
      : typeof card.label === 'string'
        ? card.label
        : t(card.label.key);

  const captionOf = (card: OAuthProviderCard) => {
    if (card.kind === 'plugin') return t('auth_login.method_plugin');
    const method = t(
      card.flow === 'device' ? 'auth_login.method_device' : 'auth_login.method_browser'
    );
    return card.domain ? `${card.domain} · ${method}` : method;
  };

  const iconOf = (card: OAuthProviderCard) =>
    card.kind === 'plugin' ? card.icon : resolveThemedIcon(card.icon, resolvedTheme);

  const headingOf = (card: OAuthProviderCard): DialogHeading => ({
    title:
      card.kind === 'plugin'
        ? t('auth_login.plugin_oauth_title', { name: card.title })
        : t(card.titleKey),
    caption: captionOf(card),
    icon: iconOf(card),
  });

  const tileStatusLabel = (status: ProviderFlowState['status']) =>
    status === 'waiting'
      ? t('auth_login.tile_waiting')
      : status === 'success'
        ? t('auth_login.tile_success')
        : status === 'error'
          ? t('auth_login.tile_error')
          : undefined;

  const openProvider = (card: OAuthProviderCard) => {
    focusedRef.current = card.id;
    setDialog({ kind: 'oauth', id: card.id });
    setDialogOpen(true);
    // An existing in-progress/failed/just-succeeded attempt is only reopened; otherwise start login now.
    if (!flows.states[card.id]?.status) void flows.startAuth(card.id);
  };

  const openVertex = () => {
    focusedRef.current = VERTEX_DIALOG_ID;
    setDialog({ kind: 'vertex' });
    setDialogOpen(true);
  };

  const closeDialog = () => {
    if (dialog?.kind === 'oauth') flows.dismissSuccess(dialog.id);
    if (dialog?.kind === 'vertex' && vertexImport.vertex.result) vertexImport.resetForAnother();
    focusedRef.current = null;
    setDialogOpen(false);
  };

  const viewAccounts = () => navigate('/auth-files');

  const dialogCard =
    dialog?.kind === 'oauth' ? providerCards.find((card) => card.id === dialog.id) : undefined;
  const renderTile = (card: OAuthProviderCard, variant: 'primary' | 'compact') => {
    const status = flows.states[card.id]?.status;
    return (
      <ProviderTile
        key={card.id}
        variant={variant}
        label={labelOf(card)}
        caption={captionOf(card)}
        description={
          variant === 'primary' ? t(`auth_login.${card.id}_tile_desc`, '') || undefined : undefined
        }
        icon={iconOf(card)}
        status={status}
        statusLabel={tileStatusLabel(status)}
        onOpen={() => openProvider(card)}
      />
    );
  };
  const waitingCount = Object.values(flows.states).filter(
    (state) => state.status === 'waiting'
  ).length;

  return (
    <>
      <PageHeader
        title={t('auth_login.page_title')}
        description={t('auth_login.page_description')}
        meta={
          waitingCount > 0 || flows.addedCount > 0 ? (
            <>
              {waitingCount > 0 && (
                <Badge tone="info" dot>
                  {t('auth_login.meta_waiting', { count: waitingCount })}
                </Badge>
              )}
              {flows.addedCount > 0 && (
                <Badge tone="success">
                  {t('auth_login.meta_added', { count: flows.addedCount })}
                </Badge>
              )}
            </>
          ) : undefined
        }
      />

      <div className={styles.choose}>
        {/* Optional login proxy: applies to sign-ins started after it is set. */}
        <LoginProxyField
          value={flows.loginProxy}
          rejectedValue={flows.loginProxyRejected}
          onChange={flows.setLoginProxy}
        />
        <div className={styles.primaryGrid}>
          {primaryCards.map((card) => renderTile(card, 'primary'))}
        </div>
      </div>

      <Section title={t('auth_login.more_providers')}>
        <div className={styles.compactGrid}>
          {moreCards.map((card) => renderTile(card, 'compact'))}
        </div>
      </Section>

      <Section title={t('auth_login.other_ways')}>
        <div className={styles.compactGrid}>
          <ProviderTile
            label={VERTEX_LABEL}
            caption={t('auth_login.vertex_tile_caption')}
            icon={iconVertex}
            onOpen={openVertex}
          />
          <ProviderTile
            label={t('siwc.bind')}
            caption={t('siwc.tile_caption')}
            icon={iconCodex}
            onOpen={openSiwc}
          />
        </div>
      </Section>

      {dialogCard && (
        <OAuthFlowDialog
          open={dialogOpen && dialog?.kind === 'oauth'}
          providerId={dialogCard.id}
          heading={headingOf(dialogCard)}
          flow={dialogCard.kind === 'builtin' ? dialogCard.flow : 'browser'}
          state={flows.states[dialogCard.id] ?? {}}
          text={(suffix) => flows.providerText(dialogCard.id, suffix)}
          supportsCallback={supportsManualCallback(dialogCard)}
          onStart={() => void flows.startAuth(dialogCard.id)}
          onCancel={() => void flows.cancelAuth(dialogCard.id)}
          onCallbackChange={(value) => flows.setCallbackInput(dialogCard.id, value)}
          onCallbackSubmit={() => void flows.submitCallback(dialogCard.id)}
          onViewAuthFiles={viewAccounts}
          onClose={closeDialog}
        />
      )}

      <VertexImportDialog
        open={dialogOpen && dialog?.kind === 'vertex'}
        heading={{
          title: t('vertex_import.title'),
          caption: t('vertex_import.file_label'),
          icon: iconVertex,
        }}
        vertex={vertexImport.vertex}
        onPickFile={vertexImport.pickFile}
        onLocationChange={vertexImport.setLocation}
        onImport={() => void vertexImport.importCredential()}
        onImportAnother={vertexImport.resetForAnother}
        onViewAuthFiles={viewAccounts}
        onClose={closeDialog}
      />

      {siwcKey > 0 && (
        <SiwcBindDialog
          key={siwcKey}
          open={siwcOpen}
          onClose={() => setSiwcOpen(false)}
          onViewAuthFiles={viewAccounts}
        />
      )}
    </>
  );
}
