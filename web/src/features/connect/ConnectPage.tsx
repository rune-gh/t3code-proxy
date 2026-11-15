import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Trans, useTranslation } from 'react-i18next';
import { Button, IconButton } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { PageHeader } from '@/components/ui/PageHeader';
import { Section } from '@/components/ui/Section';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { IconCopy, IconEye, IconEyeOff } from '@/components/ui/icons';
import { apiKeyNameFingerprint, readApiKeyNames } from '@/features/config/apiKeyNames';
import { modelsApi } from '@/services/api/models';
import { useAuthStore, useConfigStore, useNotificationStore } from '@/stores';
import { copyToClipboard } from '@/utils/clipboard';
import { detectApiBaseFromLocation } from '@/utils/connection';
import { getErrorMessage } from '@/utils/helpers';
import { CodeBlock } from './components/CodeBlock';
import {
  buildClaudeSettings,
  buildCodexConfig,
  buildCurlCheck,
  isLoopbackAddress,
  maskKey,
  normalizeHubAddress,
  SEPARATE_INSTALL_COMMANDS,
  TAILSCALE_SERVE_COMMAND,
} from './snippets';
import styles from './ConnectPage.module.scss';

type TestState = { target: string } & (
  | { status: 'idle' }
  | { status: 'testing' }
  | { status: 'ok'; count: number }
  | { status: 'error'; message: string }
);

const code = <code className="mono" />;

export function ConnectPage() {
  const { t } = useTranslation();
  const showNotification = useNotificationStore((state) => state.showNotification);
  const apiBase = useAuthStore((state) => state.apiBase);
  const connected = useAuthStore((state) => state.connectionStatus === 'connected');
  const config = useConfigStore((state) => state.config);
  const fetchConfig = useConfigStore((state) => state.fetchConfig);

  const [hubInput, setHubInput] = useState(detectApiBaseFromLocation);
  const [configError, setConfigError] = useState('');
  const [keyIndex, setKeyIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [testState, setTest] = useState<TestState>({ target: '', status: 'idle' });
  const testRun = useRef(0);

  const loadConfig = useCallback(
    async (force = false) => {
      setConfigError('');
      try {
        await fetchConfig(force);
      } catch (err: unknown) {
        setConfigError(getErrorMessage(err) || t('connect.keys_load_failed'));
      }
    },
    [fetchConfig, t]
  );

  useEffect(() => {
    if (connected) void loadConfig();
  }, [connected, loadConfig]);

  const keys = useMemo(() => config?.apiKeys ?? [], [config?.apiKeys]);
  const keyNames = useMemo(() => readApiKeyNames(apiBase), [apiBase]);
  const selectedKey = keys[keyIndex] ?? keys[0] ?? '';
  const keyOptions = useMemo(
    () =>
      keys.map((key, index) => {
        const name = keyNames[apiKeyNameFingerprint(apiBase, key)];
        const title = name || t('connect.key_n', { n: index + 1 });
        return { value: String(index), label: `${title} · ${maskKey(key)}` };
      }),
    [apiBase, keyNames, keys, t]
  );

  const hub = normalizeHubAddress(hubInput);
  const hubInvalid = hubInput.trim() !== '' && !hub;
  const loopback = hub !== '' && isLoopbackAddress(hub);

  // The page shows the key only when revealed; Copy always carries the real key.
  const shown = { hub, key: revealed ? selectedKey : '' };
  const real = { hub, key: selectedKey };

  // A result only belongs to the hub and key it was run against.
  const testTarget = `${hub}\n${selectedKey}`;
  const test: TestState =
    testState.target === testTarget ? testState : { target: testTarget, status: 'idle' };

  const runTest = async () => {
    if (!hub || !selectedKey) return;
    const run = (testRun.current += 1);
    const target = testTarget;
    setTest({ target, status: 'testing' });
    try {
      const models = await modelsApi.fetchModels(hub, selectedKey);
      if (run !== testRun.current) return;
      setTest({ target, status: 'ok', count: models.length });
    } catch (err: unknown) {
      if (run !== testRun.current) return;
      setTest({
        target,
        status: 'error',
        message: getErrorMessage(err) || t('connect.test_failed'),
      });
    }
  };

  const copyKey = async () => {
    const ok = await copyToClipboard(selectedKey);
    showNotification(
      t(ok ? 'connect.key_copied' : 'connect.copy_failed'),
      ok ? 'success' : 'error'
    );
  };

  const keysLoading = !config && !configError;

  return (
    <>
      <PageHeader title={t('connect.title')} description={t('connect.description')} />

      <Section title={t('connect.hub_title')} description={t('connect.hub_description')}>
        <div className={styles.field}>
          <Input
            value={hubInput}
            onChange={(event) => setHubInput(event.target.value)}
            aria-label={t('connect.hub_label')}
            placeholder="https://box.tailnet.ts.net:8317"
            className="mono"
            spellCheck={false}
            autoComplete="off"
            error={hubInvalid ? t('connect.hub_invalid') : undefined}
          />
        </div>
        {loopback ? (
          <div className={styles.note} role="note">
            <p>{t('connect.loopback_note')}</p>
            <CodeBlock
              code={TAILSCALE_SERVE_COMMAND}
              label={t('connect.label_shell')}
              copyLabel={t('connect.copy_tailscale')}
            />
          </div>
        ) : null}
      </Section>

      <Section title={t('connect.key_title')} description={t('connect.key_description')}>
        {configError ? (
          <div className={styles.errorRow}>
            <div className="error-box" role="alert">
              {t('connect.keys_load_failed')}: {configError}
            </div>
            <Button variant="secondary" size="sm" onClick={() => void loadConfig(true)}>
              {t('common.retry')}
            </Button>
          </div>
        ) : keysLoading ? (
          <Skeleton height={32} width="min(100%, 420px)" />
        ) : keys.length === 0 ? (
          <p className={styles.prose}>
            {t('connect.no_keys')}{' '}
            <Link className={styles.link} to="/config?field=apiKeys">
              {t('connect.no_keys_link')}
            </Link>
          </p>
        ) : (
          <div className={styles.keyRow}>
            {keys.length > 1 ? (
              <Select
                className={styles.keySelect}
                fullWidth={false}
                value={String(Math.min(keyIndex, keys.length - 1))}
                options={keyOptions}
                onChange={(value) => setKeyIndex(Number(value))}
                ariaLabel={t('connect.key_select')}
              />
            ) : null}
            <div className={styles.keyValue}>
              {revealed ? (
                <span className={`mono ${styles.keyText}`}>{selectedKey}</span>
              ) : (
                <>
                  <span className={`mono ${styles.keyText}`} aria-hidden="true">
                    {maskKey(selectedKey)}
                  </span>
                  <span className="sr-only">{t('connect.key_hidden')}</span>
                </>
              )}
              <IconButton
                size="sm"
                aria-label={revealed ? t('connect.hide_key') : t('connect.reveal_key')}
                aria-pressed={revealed}
                icon={revealed ? <IconEyeOff size={16} /> : <IconEye size={16} />}
                onClick={() => setRevealed((value) => !value)}
              />
            </div>
            <Button variant="secondary" size="sm" onClick={() => void copyKey()}>
              <span className={styles.buttonContent}>
                <IconCopy size={14} />
                {t('connect.copy_key')}
              </span>
            </Button>
          </div>
        )}
        {keys.length > 0 && !revealed ? (
          <p className={styles.hint}>{t('connect.key_placeholder_hint')}</p>
        ) : null}
      </Section>

      <Section title={t('connect.claude_title')} description={t('connect.claude_description')}>
        <CodeBlock
          code={buildClaudeSettings(shown)}
          copyText={buildClaudeSettings(real)}
          label="~/.claude/settings.json"
          path
          copyLabel={t('connect.copy_claude')}
        />
        <p className={styles.hint}>{t('connect.claude_merge_hint')}</p>
      </Section>

      <Section title={t('connect.codex_title')} description={t('connect.codex_description')}>
        <CodeBlock
          code={buildCodexConfig(shown)}
          copyText={buildCodexConfig(real)}
          label="~/.codex/config.toml"
          path
          copyLabel={t('connect.copy_codex')}
        />
        <p className={styles.hint}>
          <Trans i18nKey="connect.codex_websockets_hint" components={{ code }} />
        </p>
      </Section>

      <Section title={t('connect.separate_title')} description={t('connect.separate_description')}>
        <CodeBlock
          code={SEPARATE_INSTALL_COMMANDS}
          label={t('connect.label_shell')}
          copyLabel={t('connect.copy_separate')}
        />
        <p className={styles.hint}>
          <Trans i18nKey="connect.separate_hint" components={{ code }} />
        </p>
      </Section>

      <Section title={t('connect.t3_title')} description={t('connect.t3_description')}>
        <ul className={styles.list}>
          <li>{t('connect.t3_cli')}</li>
          <li>
            <Trans i18nKey="connect.t3_codex" components={{ strong: <strong /> }} />
          </li>
          <li>
            <Trans i18nKey="connect.t3_usage" components={{ strong: <strong /> }} />
          </li>
        </ul>
      </Section>

      <Section title={t('connect.check_title')} description={t('connect.check_description')}>
        <CodeBlock
          code={buildCurlCheck(shown)}
          copyText={buildCurlCheck(real)}
          label={t('connect.label_shell')}
          copyLabel={t('connect.copy_curl')}
        />
        <div className={styles.testRow}>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void runTest()}
            loading={test.status === 'testing'}
            disabled={!hub || !selectedKey}
          >
            {t('connect.test_button')}
          </Button>
          <p
            className={[
              styles.testResult,
              test.status === 'ok' ? styles.testOk : '',
              test.status === 'error' ? styles.testError : '',
            ]
              .filter(Boolean)
              .join(' ')}
            role="status"
          >
            {test.status === 'ok'
              ? t('connect.test_ok', { count: test.count })
              : test.status === 'error'
                ? t('connect.test_error', { message: test.message })
                : test.status === 'testing'
                  ? t('connect.test_running')
                  : !selectedKey
                    ? t('connect.test_needs_key')
                    : t('connect.test_idle')}
          </p>
        </div>
      </Section>

      <Section title={t('connect.rules_title')}>
        <ul className={styles.list}>
          <li>{t('connect.rules_own_traffic')}</li>
          <li>{t('connect.rules_claude_code')}</li>
          <li>{t('connect.rules_terms')}</li>
        </ul>
      </Section>
    </>
  );
}
